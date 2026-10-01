import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");
const EXPECTED_USER_COUNT = 132;

class MigrationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function parseMode(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--dry-run")) return "dry-run";
  if (args.length === 1 && args[0] === "--apply") return "apply";
  throw new MigrationError("INVALID_ARGUMENTS");
}

async function listMigrationFiles() {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  if (files.length === 0) throw new MigrationError("NO_MIGRATIONS_FOUND");
  for (const file of files) {
    const sql = await readFile(resolve(MIGRATIONS_DIR, file), "utf8");
    if (/\bDROP\b|\bTRUNCATE\b/i.test(sql)) {
      throw new MigrationError("DESTRUCTIVE_MIGRATION_BLOCKED");
    }
  }
  return files;
}

async function getAppliedMigrations(client) {
  const relation = await client.query("SELECT to_regclass('public.schema_migrations') AS name");
  if (!relation.rows[0]?.name) return new Set();
  const result = await client.query("SELECT migration_name FROM public.schema_migrations");
  return new Set(result.rows.map((row) => row.migration_name));
}

async function assertUserCount(client) {
  const result = await client.query("SELECT COUNT(*)::integer AS count FROM public.users");
  if (Number(result.rows[0]?.count) !== EXPECTED_USER_COUNT) {
    throw new MigrationError("NEON_USER_COUNT_MISMATCH");
  }
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const databaseUrl = process.env.NEON_DATABASE_URL;
  if (!databaseUrl) throw new MigrationError("NEON_DATABASE_URL_MISSING");

  const files = await listMigrationFiles();
  const url = new URL(databaseUrl);
  url.searchParams.set("sslmode", "verify-full");
  const pool = new pg.Pool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true },
    max: 1,
  });
  const client = await pool.connect();
  try {
    await assertUserCount(client);
    const applied = await getAppliedMigrations(client);
    const pending = files.filter((file) => !applied.has(file));

    if (mode === "dry-run") {
      console.log(JSON.stringify({
        status: "dry-run-ready",
        target: "Neon",
        appliedCount: applied.size,
        pending,
        writesPerformed: 0,
        applyRequired: pending.length > 0,
      }));
      return;
    }

    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["apshule-v10-neon-schema"]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        migration_name TEXT PRIMARY KEY NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const appliedNow = [];
    for (const file of pending) {
      const sql = await readFile(resolve(MIGRATIONS_DIR, file), "utf8");
      await client.query(sql);
      await client.query(
        "INSERT INTO public.schema_migrations (migration_name) VALUES ($1) ON CONFLICT (migration_name) DO NOTHING",
        [file],
      );
      appliedNow.push(file);
    }
    await assertUserCount(client);
    await client.query("COMMIT");

    const tables = await client.query(`
      SELECT COUNT(*)::integer AS count
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    console.log(JSON.stringify({
      status: "applied",
      target: "Neon",
      appliedCount: appliedNow.length,
      applied: appliedNow,
      userCount: EXPECTED_USER_COUNT,
      tableCount: Number(tables.rows[0]?.count),
    }));
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original sanitized failure.
    }
    if (error instanceof MigrationError) throw error;
    throw new MigrationError("NEON_SCHEMA_MIGRATION_FAILED");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  const code = error instanceof MigrationError ? error.code : "NEON_SCHEMA_MIGRATION_FAILED";
  console.error(JSON.stringify({ status: "failed", code }));
  process.exitCode = 1;
});