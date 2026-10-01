import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const EXPECTED_USER_COUNT = 132;
const D1_DATABASE = "apshule-skills-db";
const D1_ENVIRONMENT = "production";
const SOURCE_USER_COLUMNS = [
  "uid",
  "email",
  "display_name",
  "role",
  "disabled",
  "email_verified",
  "password_hash",
  "password_salt",
  "hash_algorithm",
  "custom_claims_json",
  "provider_data_json",
  "raw_json",
  "requires_password_reset",
  "created_at",
  "last_login_at",
  "imported_at",
  "password_hash_v2",
  "password_salt_v2",
  "active",
  "session_version",
  "school_id",
  "institution_id",
];
const SOURCE_SCHEMA = {
  uid: "TEXT",
  email: "TEXT",
  display_name: "TEXT",
  role: "TEXT",
  disabled: "INTEGER",
  email_verified: "INTEGER",
  password_hash: "TEXT",
  password_salt: "TEXT",
  hash_algorithm: "TEXT",
  custom_claims_json: "TEXT",
  provider_data_json: "TEXT",
  raw_json: "TEXT",
  requires_password_reset: "INTEGER",
  created_at: "TEXT",
  last_login_at: "TEXT",
  imported_at: "TEXT",
  password_hash_v2: "TEXT",
  password_salt_v2: "TEXT",
  active: "INTEGER",
  session_version: "INTEGER",
  school_id: "TEXT",
  institution_id: "TEXT",
};
const SOURCE_NOT_NULL_COLUMNS = new Set([
  "uid",
  "role",
  "disabled",
  "email_verified",
  "raw_json",
  "requires_password_reset",
  "imported_at",
  "active",
  "session_version",
]);
const TARGET_COLUMNS = [
  "uid",
  "email",
  "display_name",
  "role",
  "disabled",
  "email_verified",
  "password_hash",
  "password_salt",
  "hash_algorithm",
  "custom_claims_json",
  "provider_data_json",
  "raw_json",
  "requires_password_reset",
  "created_at",
  "last_login_at",
  "imported_at",
  "password_hash_v2",
  "password_salt_v2",
  "active",
  "session_version",
  "school_id",
  "institution_id",
];
const EXPECTED_TARGET_COLUMNS = new Set(TARGET_COLUMNS);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(__dirname, "../../..");

class MigrationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new MigrationError(code);
}

function readMode(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply")) {
    fail("INVALID_ARGUMENTS");
  }
  return args[0] === "--apply" ? "apply" : "dry-run";
}

function runWranglerQuery(sql) {
  let output;
  try {
    output = execFileSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "execute",
        D1_DATABASE,
        "--remote",
        "--env",
        D1_ENVIRONMENT,
        "--command",
        sql,
        "--json",
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
  } catch {
    fail("D1_READ_FAILED");
  }

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail("UNSUPPORTED_WRANGLER_OUTPUT");
  }

  const responses = Array.isArray(parsed) ? parsed : [parsed];
  if (
    responses.length !== 1 ||
    !responses[0] ||
    responses[0].success !== true ||
    !Array.isArray(responses[0].results)
  ) {
    fail("UNSUPPORTED_WRANGLER_OUTPUT");
  }
  return responses[0].results;
}

function validateSourceSchema(columns) {
  const byName = new Map(columns.map((column) => [column.name, column]));
  if (byName.size !== columns.length) fail("UNSUPPORTED_D1_SCHEMA");

  for (const [name, expectedType] of Object.entries(SOURCE_SCHEMA)) {
    const column = byName.get(name);
    if (!column || String(column.type ?? "").trim().toUpperCase() !== expectedType) {
      fail("UNSUPPORTED_D1_SCHEMA");
    }
    if (SOURCE_NOT_NULL_COLUMNS.has(name) && Number(column.notnull) !== 1) {
      fail("UNSUPPORTED_D1_SCHEMA");
    }
  }

  if (Number(byName.get("uid")?.pk) !== 1) fail("UNSUPPORTED_D1_SCHEMA");
}

function sourceText(value) {
  if (value === null) return null;
  if (typeof value !== "string") fail("UNSUPPORTED_D1_ROW");
  return value;
}

function sourceBoolean(value) {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  fail("UNSUPPORTED_D1_ROW");
}

function sourceInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail("UNSUPPORTED_D1_ROW");
  return parsed;
}

function requiredSourceText(value) {
  const parsed = sourceText(value);
  if (parsed === null) fail("UNSUPPORTED_D1_ROW");
  return parsed;
}

function validateAndMapSourceRows(rows) {
  if (rows.length !== EXPECTED_USER_COUNT) fail("D1_USER_COUNT_MISMATCH");

  const ids = new Set();
  const mappedRows = rows.map((row) => {
    if (!row || typeof row !== "object") fail("UNSUPPORTED_D1_ROW");
    if (Number(row.__source_count) !== EXPECTED_USER_COUNT) fail("D1_USER_COUNT_MISMATCH");
    if (typeof row.uid !== "string" || row.uid.length === 0) fail("D1_USER_ID_MISSING");
    if (ids.has(row.uid)) fail("DUPLICATE_D1_USER_ID");
    ids.add(row.uid);
    const role = sourceText(row.role);
    if (role === null) fail("UNSUPPORTED_D1_ROW");

    return {
      uid: row.uid,
      email: sourceText(row.email),
      display_name: sourceText(row.display_name),
      role,
      disabled: sourceBoolean(row.disabled),
      email_verified: sourceBoolean(row.email_verified),
      password_hash: sourceText(row.password_hash),
      password_salt: sourceText(row.password_salt),
      hash_algorithm: sourceText(row.hash_algorithm),
      custom_claims_json: sourceText(row.custom_claims_json),
      provider_data_json: sourceText(row.provider_data_json),
      raw_json: requiredSourceText(row.raw_json),
      requires_password_reset: sourceBoolean(row.requires_password_reset),
      created_at: sourceText(row.created_at),
      last_login_at: sourceText(row.last_login_at),
      imported_at: requiredSourceText(row.imported_at),
      password_hash_v2: sourceText(row.password_hash_v2),
      password_salt_v2: sourceText(row.password_salt_v2),
      active: sourceBoolean(row.active),
      session_version: sourceInteger(row.session_version),
      school_id: sourceText(row.school_id),
      institution_id: sourceText(row.institution_id),
    };
  });

  if (ids.size !== EXPECTED_USER_COUNT) fail("DUPLICATE_D1_USER_ID");
  return mappedRows;
}

const BOOLEAN_COLUMNS = new Set([
  "disabled",
  "email_verified",
  "requires_password_reset",
  "active",
]);

function normalizedDigestValue(value, column) {
  if (BOOLEAN_COLUMNS.has(column)) {
    if (value === true || value === 1 || value === "1") return true;
    if (value === false || value === 0 || value === "0") return false;
    fail("NEON_USER_VALUE_MISMATCH");
  }
  if (column === "session_version") {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) fail("NEON_USER_VALUE_MISMATCH");
    return parsed;
  }
  if (value === null || typeof value === "string") return value;
  fail("NEON_USER_VALUE_MISMATCH");
}

function userRowsDigest(rows) {
  if (rows.length !== EXPECTED_USER_COUNT) fail("NEON_USER_COUNT_MISMATCH");
  const orderedRows = [...rows].sort((left, right) =>
    left.uid < right.uid ? -1 : left.uid > right.uid ? 1 : 0,
  );
  const values = orderedRows.map((row) => {
    if (!row || typeof row.uid !== "string") fail("NEON_USER_VALUE_MISMATCH");
    return TARGET_COLUMNS.map((column) => normalizedDigestValue(row[column], column));
  });
  return createHash("sha256").update(JSON.stringify(values), "utf8").digest("hex");
}

async function getTargetState(client) {
  const relation = await client.query(
    `SELECT c.relkind AS kind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'users'`,
  );
  if (relation.rows.length === 0) {
    return { exists: false, count: 0 };
  }
  if (!["r", "p"].includes(relation.rows[0].kind)) fail("UNSUPPORTED_NEON_TARGET");

  const countResult = await client.query("SELECT COUNT(*)::text AS count FROM public.users");
  const count = Number(countResult.rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) fail("UNSUPPORTED_NEON_TARGET");
  if (count > 0) fail("NEON_TARGET_NOT_EMPTY");

  const columnResult = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
      ORDER BY ordinal_position`,
  );
  const columns = new Set(columnResult.rows.map((row) => row.column_name));
  if (columns.size !== EXPECTED_TARGET_COLUMNS.size ||
      [...EXPECTED_TARGET_COLUMNS].some((column) => !columns.has(column))) {
    fail("UNSUPPORTED_NEON_TARGET");
  }

  const primaryKey = await client.query(
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_catalog = tc.constraint_catalog
        AND kcu.constraint_schema = tc.constraint_schema
        AND kcu.constraint_name = tc.constraint_name
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'users'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position`,
  );
  if (primaryKey.rows.length !== 1 || primaryKey.rows[0].column_name !== "uid") {
    fail("UNSUPPORTED_NEON_TARGET");
  }
  return { exists: true, count };
}

async function applyMigration(pool, rows, schemaSql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(schemaSql);
    await client.query("LOCK TABLE public.users IN ACCESS EXCLUSIVE MODE");

    const target = await getTargetState(client);
    if (!target.exists || target.count !== 0) fail("NEON_TARGET_NOT_EMPTY");

    const placeholders = TARGET_COLUMNS.map((_, index) => `$${index + 1}`).join(", ");
    const insertSql =
      `INSERT INTO public.users (${TARGET_COLUMNS.join(", ")}) VALUES (${placeholders})`;
    for (const row of rows) {
      await client.query(insertSql, TARGET_COLUMNS.map((column) => row[column]));
    }

    const validation = await client.query("SELECT COUNT(*)::text AS count FROM public.users");
    if (Number(validation.rows[0]?.count) !== EXPECTED_USER_COUNT) {
      fail("NEON_USER_COUNT_MISMATCH");
    }
    const inserted = await client.query(
      `SELECT ${TARGET_COLUMNS.join(", ")} FROM public.users ORDER BY uid`,
    );
    if (userRowsDigest(inserted.rows) !== userRowsDigest(rows)) {
      fail("NEON_USER_VALUE_MISMATCH");
    }

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original sanitized failure.
    }
    if (error instanceof MigrationError) throw error;
    fail("NEON_WRITE_FAILED");
  } finally {
    client.release();
  }
}

async function main() {
  const mode = readMode(process.argv.slice(2));
  const databaseUrl = process.env.NEON_DATABASE_URL;
  if (!databaseUrl) fail("NEON_DATABASE_URL_MISSING");

  const sourceSchema = runWranglerQuery("PRAGMA table_info(users);");
  validateSourceSchema(sourceSchema);

  const selectedColumns = SOURCE_USER_COLUMNS.join(", ");
  const sourceRows = runWranglerQuery(
    `SELECT ${selectedColumns}, COUNT(*) OVER () AS __source_count FROM users ORDER BY uid;`,
  );
  const rows = validateAndMapSourceRows(sourceRows);

  const { Pool } = pg;
  const verifiedDatabaseUrl = new URL(databaseUrl);
  verifiedDatabaseUrl.searchParams.set("sslmode", "verify-full");
  const pool = new Pool({
    connectionString: verifiedDatabaseUrl.toString(),
    ssl: { rejectUnauthorized: true },
    max: 1,
  });
  try {
    const target = await getTargetState(pool);
    if (mode === "dry-run") {
      console.log(JSON.stringify({
        status: "dry-run-ready",
        source: "D1",
        target: "Neon",
        sourceCount: rows.length,
        targetCount: target.count,
        writesPerformed: 0,
        applyRequired: true,
      }));
      return;
    }

    const schemaSql = await readFile(resolve(__dirname, "../migrations/0001_users.sql"), "utf8");
    await applyMigration(pool, rows, schemaSql);
    console.log(JSON.stringify({
      status: "applied",
      source: "D1",
      target: "Neon",
      sourceCount: rows.length,
      targetCount: EXPECTED_USER_COUNT,
      writesPerformed: EXPECTED_USER_COUNT,
    }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const code = error instanceof MigrationError ? error.code : "MIGRATION_FAILED";
  console.error(JSON.stringify({ status: "failed", code }));
  process.exitCode = 1;
});