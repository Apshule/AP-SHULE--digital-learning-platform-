import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import pg from "pg";

const EXPECTED_USER_COUNT = 132;
const D1_DATABASE = "apshule-skills-db";
const D1_ENVIRONMENT = "production";
const EXPECTED_ROLE_CAPABILITY_COUNT = 82;
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(__dirname, "../../..");

const TABLES = [
  {
    source: "firestore_documents",
    target: "firestore_documents",
    expectedCount: 391,
    columns: [
      ["document_path", "TEXT", true],
      ["collection_path", "TEXT", true],
      ["firestore_name", "TEXT", true],
      ["data_json", "TEXT", true],
      ["update_time", "TEXT", false],
      ["create_time", "TEXT", false],
      ["imported_at", "TEXT", true],
    ],
    key: ["document_path"],
  },
  {
    source: "firebase_collection_inventory",
    target: "firebase_collection_inventory",
    expectedCount: 44,
    columns: [
      ["collection_path", "TEXT", true],
      ["source_project", "TEXT", true],
      ["document_count", "INTEGER", true],
      ["source_file", "TEXT", true],
      ["imported_at", "TEXT", true],
    ],
    key: ["collection_path"],
  },
  {
    source: "role_capabilities",
    target: "role_capabilities",
    expectedCount: 82,
    columns: [
      ["id", "INTEGER", false],
      ["role", "TEXT", true],
      ["sector", "TEXT", true],
      ["capability", "TEXT", true],
      ["scope", "TEXT", true],
    ],
    key: ["role", "sector", "capability", "scope"],
    sourceKey: ["id"],
    roleCapabilities: true,
  },
  {
    source: "sector_records",
    target: "sector_records",
    expectedCount: 26,
    columns: [
      ["id", "TEXT", true],
      ["sector", "TEXT", true],
      ["institution_id", "TEXT", false],
      ["school_id", "TEXT", false],
      ["owner_uid", "TEXT", false],
      ["record_type", "TEXT", true],
      ["record_json", "TEXT", true],
      ["created_by", "TEXT", false],
      ["is_deleted", "INTEGER", true],
      ["created_at", "TEXT", true],
      ["updated_at", "TEXT", true],
    ],
    key: ["id"],
  },
  {
    source: "skills_providers",
    target: "skills_providers",
    expectedCount: 3,
    columns: [
      ["id", "TEXT", true],
      ["name", "TEXT", true],
      ["description", "TEXT", true],
      ["logo_url", "TEXT", true],
      ["badge_url", "TEXT", true],
      ["physical_address", "TEXT", true],
      ["contact_email", "TEXT", true],
      ["contact_phone", "TEXT", true],
      ["referral_code", "TEXT", true],
      ["status", "TEXT", true],
      ["owner_id", "TEXT", true],
      ["admission_fee_ugx", "INTEGER", true],
      ["admission_split_apshule", "INTEGER", true],
      ["admission_split_company", "INTEGER", true],
      ["course_split_apshule", "INTEGER", true],
      ["course_split_company", "INTEGER", true],
      ["agreement_note", "TEXT", true],
      ["agreement_doc_url", "TEXT", true],
      ["created_at", "TEXT", true],
      ["updated_at", "TEXT", true],
    ],
    key: ["id"],
  },
  {
    source: "vocational_courses",
    target: "vocational_courses",
    expectedCount: 4,
    columns: [
      ["id", "TEXT", true],
      ["provider_id", "TEXT", true],
      ["title", "TEXT", true],
      ["description", "TEXT", true],
      ["duration", "TEXT", true],
      ["fee_ugx", "INTEGER", true],
      ["category", "TEXT", true],
      ["featured", "INTEGER", true],
      ["active", "INTEGER", true],
    ],
    key: ["provider_id", "id"],
  },
  {
    source: "vocational_enrollments",
    target: "vocational_enrollments",
    expectedCount: 1,
    columns: [
      ["id", "TEXT", true],
      ["provider_id", "TEXT", true],
      ["course_id", "TEXT", true],
      ["referral_code", "TEXT", true],
      ["student_id", "TEXT", true],
      ["full_name", "TEXT", true],
      ["phone", "TEXT", true],
      ["email", "TEXT", true],
      ["education_level", "TEXT", true],
      ["previous_experience", "TEXT", true],
      ["amount_ugx", "INTEGER", true],
      ["payment_reference", "TEXT", true],
      ["payment_status", "TEXT", true],
      ["status", "TEXT", true],
      ["record_json", "TEXT", true],
      ["is_deleted", "INTEGER", true],
      ["created_at", "TEXT", true],
      ["updated_at", "TEXT", true],
    ],
    key: ["id"],
  },
  {
    source: "school_admissions",
    target: "school_admissions",
    expectedCount: 3,
    columns: [
      ["id", "TEXT", true],
      ["student_id", "TEXT", true],
      ["full_name", "TEXT", true],
      ["phone", "TEXT", true],
      ["email", "TEXT", true],
      ["education_level", "TEXT", true],
      ["previous_experience", "TEXT", true],
      ["institution_id", "TEXT", false],
      ["school_id", "TEXT", false],
      ["status", "TEXT", true],
      ["record_json", "TEXT", true],
      ["created_by", "TEXT", true],
      ["is_deleted", "INTEGER", true],
      ["created_at", "TEXT", true],
      ["updated_at", "TEXT", true],
    ],
    key: ["id"],
  },
  {
    source: "legacy_admissions",
    target: "legacy_admissions",
    expectedCount: 4,
    columns: [
      ["id", "TEXT", true],
      ["provider_id", "TEXT", true],
      ["course_id", "TEXT", true],
      ["referral_code", "TEXT", true],
      ["student_id", "TEXT", true],
      ["full_name", "TEXT", true],
      ["phone", "TEXT", true],
      ["email", "TEXT", true],
      ["education_level", "TEXT", true],
      ["previous_experience", "TEXT", true],
      ["amount_ugx", "INTEGER", true],
      ["payment_reference", "TEXT", true],
      ["payment_status", "TEXT", true],
      ["status", "TEXT", true],
      ["created_at", "TEXT", true],
      ["updated_at", "TEXT", true],
      ["type", "TEXT", true],
      ["institution_id", "TEXT", false],
      ["school_id", "TEXT", false],
      ["record_json", "TEXT", true],
      ["is_deleted", "INTEGER", true],
    ],
    key: ["id"],
  },
  {
    source: "education_subscription_plans",
    target: "education_subscription_plans",
    expectedCount: 6,
    columns: [
      ["id", "TEXT", true],
      ["name", "TEXT", true],
      ["amount_ugx", "INTEGER", true],
      ["duration_days", "INTEGER", true],
      ["display_order", "INTEGER", true],
      ["active", "INTEGER", true],
    ],
    key: ["id"],
  },
  {
    source: "storage_migration_manifest",
    target: "storage_migration_manifest",
    expectedCount: 9,
    columns: [
      ["object_key", "TEXT", true],
      ["source_path", "TEXT", true],
      ["content_type", "TEXT", false],
      ["size_bytes", "INTEGER", false],
      ["sha256", "TEXT", false],
      ["status", "TEXT", true],
      ["imported_at", "TEXT", false],
      ["placeholder_bytes", "INTEGER", false],
      ["placeholder_sha256", "TEXT", false],
      ["is_placeholder", "INTEGER", true],
      ["placeholder_content_type", "TEXT", false],
      ["placeholder_created_at", "TEXT", false],
    ],
    key: ["object_key"],
  },
  {
    source: "push_subscriptions",
    target: "push_subscriptions",
    expectedCount: 1,
    columns: [
      ["endpoint", "TEXT", true],
      ["user_id", "TEXT", true],
      ["p256dh", "TEXT", true],
      ["auth", "TEXT", true],
      ["created_at", "TEXT", true],
      ["updated_at", "TEXT", true],
    ],
    key: ["endpoint"],
    timestampColumns: new Set(["created_at", "updated_at"]),
  },
];

const TARGET_TYPE_OVERRIDES = {
  role_capabilities: { id: "bigint" },
  push_subscriptions: {
    created_at: "timestamp with time zone",
    updated_at: "timestamp with time zone",
  },
};

class MigrationError extends Error {
  constructor(code, table = "migration", expectedCount, actualCount) {
    super(code);
    this.code = code;
    this.table = table;
    this.expectedCount = expectedCount;
    this.actualCount = actualCount;
  }
}

function fail(code, table, expectedCount, actualCount) {
  throw new MigrationError(code, table, expectedCount, actualCount);
}

function readMode(args) {
  if (args.length > 1 || (args.length === 1 && !["--apply", "--dry-run"].includes(args[0]))) {
    fail("INVALID_ARGUMENTS");
  }
  if (args[0] === "--apply") return "apply";
  return "dry-run";
}

function runWranglerQuery(sql, table) {
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
    fail("D1_READ_FAILED", table);
  }

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail("UNSUPPORTED_WRANGLER_OUTPUT", table);
  }
  const responses = Array.isArray(parsed) ? parsed : [parsed];
  if (
    responses.length !== 1 ||
    !responses[0] ||
    responses[0].success !== true ||
    !Array.isArray(responses[0].results)
  ) {
    fail("UNSUPPORTED_WRANGLER_OUTPUT", table);
  }
  return responses[0].results;
}

function validateSourceSchema(table, columns) {
  const expectedColumns = new Map(table.columns.map(([name, type]) => [name, type]));
  const actualColumns = new Map(columns.map((column) => [column.name, column]));
  if (actualColumns.size !== columns.length || actualColumns.size !== expectedColumns.size) {
    fail("UNSUPPORTED_D1_SCHEMA", table.source);
  }
  for (const [name, type, required] of table.columns) {
    const column = actualColumns.get(name);
    if (
      !column ||
      String(column.type ?? "").trim().toUpperCase() !== type ||
      (required && Number(column.notnull) !== 1 && Number(column.pk) === 0)
    ) {
      fail("UNSUPPORTED_D1_SCHEMA", table.source);
    }
  }
  const primaryKeyColumns = table.columns
    .filter(([name]) => Number(actualColumns.get(name)?.pk) > 0)
    .sort((left, right) =>
      Number(actualColumns.get(left[0]).pk) - Number(actualColumns.get(right[0]).pk),
    )
    .map(([name]) => name);
  if (JSON.stringify(primaryKeyColumns) !== JSON.stringify(table.sourceKey ?? table.key)) {
    fail("UNSUPPORTED_D1_SCHEMA", table.source);
  }
}

function sourceValue(value, type, required, tableName) {
  if (value === null || value === undefined) {
    if (required) fail("UNSUPPORTED_D1_ROW", tableName);
    return null;
  }
  if (type === "TEXT") {
    if (typeof value !== "string") fail("UNSUPPORTED_D1_ROW", tableName);
    return value;
  }
  if (type === "INTEGER") {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) fail("UNSUPPORTED_D1_ROW", tableName);
    return parsed;
  }
  fail("UNSUPPORTED_D1_SCHEMA", tableName);
}

function validateAndMapRows(table, rows) {
  if (rows.length !== table.expectedCount) {
    fail("D1_SOURCE_COUNT_MISMATCH", table.source, table.expectedCount, rows.length);
  }
  const seen = new Set();
  const mapped = rows.map((row) => {
    if (!row || typeof row !== "object" || Number(row.__source_count) !== table.expectedCount) {
      fail("D1_SOURCE_COUNT_MISMATCH", table.source, table.expectedCount, rows.length);
    }
    const result = {};
    for (const [name, type, required] of table.columns) {
      if (table.roleCapabilities && name === "id") continue;
      result[name] = sourceValue(row[name], type, required, table.source);
    }
    const key = JSON.stringify(table.key.map((column) => result[column]));
    if (seen.has(key)) fail("DUPLICATE_D1_KEY", table.source, table.expectedCount, rows.length);
    seen.add(key);
    if (table.timestampColumns) {
      for (const name of table.timestampColumns) {
        const value = result[name];
        if (
          typeof value !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        ) {
          fail("INVALID_D1_TIMESTAMP", table.source);
        }
        const timestamp = new Date(value);
        if (!Number.isFinite(timestamp.getTime())) fail("INVALID_D1_TIMESTAMP", table.source);
        result[name] = timestamp;
      }
    }
    return result;
  });
  return mapped;
}

function roleKey(row) {
  return JSON.stringify([row.role, row.sector, row.capability, row.scope]);
}

function normalizedTimestamp(value, tableName) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) fail("NEON_VALUE_MISMATCH", tableName);
  return timestamp.toISOString();
}

function canonicalRows(table, rows) {
  const columns = table.columns.filter(([name]) => !table.roleCapabilities || name !== "id");
  const normalized = rows.map((row) => columns.map(([name, type]) => {
    const value = row[name];
    if (value === null || value === undefined) return null;
    if (table.timestampColumns?.has(name)) return normalizedTimestamp(value, table.target);
    if (type === "TEXT") {
      if (typeof value !== "string") fail("NEON_VALUE_MISMATCH", table.target);
      return value;
    }
    if (type === "INTEGER") {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) fail("NEON_VALUE_MISMATCH", table.target);
      return parsed;
    }
    fail("UNSUPPORTED_NEON_TARGET", table.target);
  }));
  const keyIndexes = table.key.map((key) => columns.findIndex(([name]) => name === key));
  normalized.sort((left, right) => {
    const leftKey = JSON.stringify(keyIndexes.map((index) => left[index]));
    const rightKey = JSON.stringify(keyIndexes.map((index) => right[index]));
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return normalized;
}

function rowsDigest(table, rows) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalRows(table, rows)), "utf8")
    .digest("hex");
}

async function verifyTargetRows(client, table, sourceRows) {
  const columns = table.columns
    .filter(([name]) => !table.roleCapabilities || name !== "id")
    .map(([name]) => name);
  const orderBy = table.key.map(sqlIdentifier).join(", ");
  const result = await client.query(
    `SELECT ${columns.map(sqlIdentifier).join(", ")}
       FROM public.${sqlIdentifier(table.target)}
      ORDER BY ${orderBy}`,
  );
  if (result.rows.length !== table.expectedCount) {
    fail("NEON_TARGET_COUNT_MISMATCH", table.target, table.expectedCount, result.rows.length);
  }
  if (rowsDigest(table, result.rows) !== rowsDigest(table, sourceRows)) {
    fail("NEON_CHECKSUM_MISMATCH", table.target, table.expectedCount, result.rows.length);
  }
}

async function readMigrationRoleSeedKeys() {
  let sql;
  try {
    sql = await readFile(resolve(__dirname, "../migrations/013_domain_routes.sql"), "utf8");
  } catch {
    fail("ROLE_SEED_UNAVAILABLE", "role_capabilities");
  }
  const start = sql.indexOf("INSERT INTO public.role_capabilities (role, sector, capability, scope) VALUES");
  const end = sql.indexOf("ON CONFLICT (role, sector, capability, scope)", start);
  if (start < 0 || end < 0) fail("ROLE_SEED_UNSUPPORTED", "role_capabilities");
  const values = sql.slice(start, end);
  const tuplePattern = /\('([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\)/g;
  const keys = new Set();
  for (const match of values.matchAll(tuplePattern)) {
    keys.add(JSON.stringify([match[1], match[2], match[3], match[4]]));
  }
  if (keys.size !== EXPECTED_ROLE_CAPABILITY_COUNT) {
    fail("ROLE_SEED_UNSUPPORTED", "role_capabilities", EXPECTED_ROLE_CAPABILITY_COUNT, keys.size);
  }
  return keys;
}

function assertRoleSeedMatch(rows, seedKeys) {
  const sourceKeys = new Set(rows.map(roleKey));
  if (
    sourceKeys.size !== EXPECTED_ROLE_CAPABILITY_COUNT ||
    sourceKeys.size !== seedKeys.size ||
    [...sourceKeys].some((key) => !seedKeys.has(key))
  ) {
    fail(
      "ROLE_CAPABILITY_SEED_MISMATCH",
      "role_capabilities",
      EXPECTED_ROLE_CAPABILITY_COUNT,
      sourceKeys.size,
    );
  }
}

function normalizePgType(dataType, udtName) {
  if (dataType === "USER-DEFINED") return udtName;
  return dataType;
}

async function assertTargetSchema(client, table) {
  const result = await client.query(
    `SELECT column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table.target],
  );
  const expectedColumns = table.columns
    .filter(([name]) => !table.roleCapabilities || name !== "id")
    .map(([name, sourceType]) => [
      name,
      TARGET_TYPE_OVERRIDES[table.target]?.[name] ??
        (sourceType === "INTEGER" ? "integer" : "text"),
    ]);
  if (table.roleCapabilities) expectedColumns.unshift(["id", "bigint"]);
  const actualColumns = new Map(result.rows.map((row) => [
    row.column_name,
    normalizePgType(row.data_type, row.udt_name),
  ]));
  if (
    actualColumns.size !== expectedColumns.length ||
    expectedColumns.some(([name, type]) => actualColumns.get(name) !== type)
  ) {
    fail("UNSUPPORTED_NEON_TARGET", table.target);
  }
}

async function getCount(client, tableName) {
  const result = await client.query(`SELECT COUNT(*)::text AS count FROM public.${tableName}`);
  const count = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) fail("UNSUPPORTED_NEON_TARGET", tableName);
  return count;
}

async function assertUserCount(client) {
  const count = await getCount(client, "users");
  if (count !== EXPECTED_USER_COUNT) {
    fail("NEON_USER_COUNT_MISMATCH", "users", EXPECTED_USER_COUNT, count);
  }
}

function sqlIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) fail("UNSUPPORTED_TABLE_NAME");
  return `"${value}"`;
}

function makeUpsertSql(table) {
  const columns = table.columns
    .filter(([name]) => !table.roleCapabilities || name !== "id")
    .map(([name]) => name);
  const target = sqlIdentifier(table.target);
  const quotedColumns = columns.map(sqlIdentifier);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  const keyColumns = table.key.map(sqlIdentifier).join(", ");
  if (table.roleCapabilities) {
    return {
      sql: `INSERT INTO public.${target} (${quotedColumns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (${keyColumns}) DO NOTHING`,
      columns,
    };
  }
  const mutableColumns = columns.filter((column) => !table.key.includes(column));
  const conflictAction = mutableColumns.length
    ? `DO UPDATE SET ${mutableColumns.map((column) => `${sqlIdentifier(column)} = EXCLUDED.${sqlIdentifier(column)}`).join(", ")}`
    : "DO NOTHING";
  return {
    sql: `INSERT INTO public.${target} (${quotedColumns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (${keyColumns}) ${conflictAction}`,
    columns,
  };
}

async function assertRoleTargetKeys(client, expectedKeys) {
  const result = await client.query(
    `SELECT role, sector, capability, scope
       FROM public.role_capabilities
      ORDER BY role, sector, capability, scope`,
  );
  const targetKeys = new Set(result.rows.map(roleKey));
  if (
    targetKeys.size !== EXPECTED_ROLE_CAPABILITY_COUNT ||
    [...expectedKeys].some((key) => !targetKeys.has(key))
  ) {
    fail(
      "NEON_TARGET_COUNT_MISMATCH",
      "role_capabilities",
      EXPECTED_ROLE_CAPABILITY_COUNT,
      targetKeys.size,
    );
  }
}

async function collectSourceData(roleSeedKeys) {
  const counts = new Map();
  for (const table of TABLES) {
    const result = runWranglerQuery(
      `SELECT COUNT(*) AS count FROM ${table.source};`,
      table.source,
    );
    const actual = Number(result[0]?.count);
    if (!Number.isSafeInteger(actual) || actual !== table.expectedCount) {
      fail("D1_SOURCE_COUNT_MISMATCH", table.source, table.expectedCount, actual);
    }
    counts.set(table.source, actual);
  }

  const allRows = new Map();
  for (const table of TABLES) {
    validateSourceSchema(
      table,
      runWranglerQuery(`PRAGMA table_info(${table.source});`, table.source),
    );
    const selected = table.columns.map(([name]) => name).join(", ");
    const ordering = (table.sourceKey ?? table.key).join(", ");
    const rawRows = runWranglerQuery(
      `SELECT ${selected}, COUNT(*) OVER () AS __source_count FROM ${table.source} ORDER BY ${ordering};`,
      table.source,
    );
    const rows = validateAndMapRows(table, rawRows);
    if (table.roleCapabilities) assertRoleSeedMatch(rows, roleSeedKeys);
    allRows.set(table.source, rows);
  }
  return allRows;
}

async function validateTargetState(client) {
  await assertUserCount(client);
  const targetCounts = new Map();
  for (const table of TABLES) {
    await assertTargetSchema(client, table);
    targetCounts.set(table.target, await getCount(client, table.target));
  }
  return targetCounts;
}

async function applyMigration(pool, sourceRows, roleSeedKeys) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "apshule-operational-data-migration",
    ]);
    for (const table of TABLES) {
      await client.query(`LOCK TABLE public.${sqlIdentifier(table.target)} IN SHARE ROW EXCLUSIVE MODE`);
    }
    await validateTargetState(client);

    for (const table of TABLES) {
      const rows = sourceRows.get(table.source);
      const { sql, columns } = makeUpsertSql(table);
      for (const row of rows) {
        await client.query(sql, columns.map((column) => row[column]));
      }
    }

    for (const table of TABLES) {
      const actual = await getCount(client, table.target);
      if (actual !== table.expectedCount) {
        fail("NEON_TARGET_COUNT_MISMATCH", table.target, table.expectedCount, actual);
      }
      await verifyTargetRows(client, table, sourceRows.get(table.source));
    }
    await assertRoleTargetKeys(client, roleSeedKeys);
    await assertUserCount(client);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original sanitized failure.
    }
    if (error instanceof MigrationError) throw error;
    fail("NEON_WRITE_FAILED", "migration");
  } finally {
    client.release();
  }
}

async function main() {
  const mode = readMode(process.argv.slice(2));
  const databaseUrl = process.env.NEON_DATABASE_URL;
  if (!databaseUrl) fail("NEON_DATABASE_URL_MISSING");

  const roleSeedKeys = await readMigrationRoleSeedKeys();
  const sourceRows = await collectSourceData(roleSeedKeys);
  const { Pool } = pg;
  const verifiedDatabaseUrl = new URL(databaseUrl);
  verifiedDatabaseUrl.searchParams.set("sslmode", "verify-full");
  const pool = new Pool({
    connectionString: verifiedDatabaseUrl.toString(),
    ssl: { rejectUnauthorized: true },
    max: 1,
  });
  try {
    const client = await pool.connect();
    try {
      await validateTargetState(client);
    } finally {
      client.release();
    }
    if (mode === "dry-run") {
      console.log(JSON.stringify({
        checksumsMatch: null,
        verifiedTableCount: 0,
      }));
      return;
    }

    await applyMigration(pool, sourceRows, roleSeedKeys);
    console.log(JSON.stringify({
      checksumsMatch: true,
      verifiedTableCount: TABLES.length,
    }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const safeError = error instanceof MigrationError
    ? error
    : new MigrationError("MIGRATION_FAILED");
  const details = {
    status: "failed",
    code: safeError.code,
    table: safeError.table,
  };
  if (Number.isSafeInteger(safeError.expectedCount)) details.expectedCount = safeError.expectedCount;
  if (Number.isSafeInteger(safeError.actualCount)) details.actualCount = safeError.actualCount;
  console.error(JSON.stringify(details));
  process.exitCode = 1;
});