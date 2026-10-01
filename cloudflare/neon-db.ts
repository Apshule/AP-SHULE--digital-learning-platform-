import { Client, neon } from "@neondatabase/serverless";

export interface NeonEnvironment {
  NEON_DATABASE_URL?: string;
}

export type NeonClient = InstanceType<typeof Client>;

export interface NeonHealthSnapshot {
  users: number;
  tables: number;
}

export async function connectNeon(env: NeonEnvironment): Promise<NeonClient> {
  if (!env.NEON_DATABASE_URL) {
    throw new Error("Neon database connection is not configured");
  }

  const client = new Client(env.NEON_DATABASE_URL);
  await client.connect();
  return client;
}

export async function inNeonTransaction<T>(
  client: NeonClient,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the operation failure.
    }
    throw error;
  }
}

export async function readNeonHealth(env: NeonEnvironment): Promise<NeonHealthSnapshot> {
  if (!env.NEON_DATABASE_URL) {
    throw new Error("Neon database connection is not configured");
  }

  const sql = neon(env.NEON_DATABASE_URL);
  const rows = await sql`
    SELECT
      (SELECT COUNT(*)::integer FROM users) AS users,
      (
        SELECT COUNT(*)::integer
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ) AS tables
  `;
  const row = rows[0] as { users?: number | string; tables?: number | string } | undefined;
  if (!row || row.users === undefined || row.tables === undefined) {
    throw new Error("Neon database health query returned no counts");
  }

  const users = Number(row.users);
  const tables = Number(row.tables);
  if (!Number.isSafeInteger(users) || !Number.isSafeInteger(tables)) {
    throw new Error("Neon database health query returned invalid counts");
  }

  return { users, tables };
}