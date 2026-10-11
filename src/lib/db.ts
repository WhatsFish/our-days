import { Pool, type PoolClient, type QueryResultRow } from "pg";

export const pool = new Pool({
  host: process.env.PG_HOST ?? "db",
  port: Number(process.env.PG_PORT ?? 5432),
  user: process.env.PG_USER ?? "our_days",
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DB ?? "our_days",
  max: 4,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});

export async function query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows;
}

export async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
