import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from './env';

// Next dev reloads modules on every edit; without this the pool leaks
// connections until the free-tier database refuses new ones.
const globalForPool = globalThis as unknown as { __pantryPool?: Pool };

export function getPool(): Pool {
  if (!globalForPool.__pantryPool) {
    const connectionString = env.databaseUrl;
    globalForPool.__pantryPool = new Pool({
      connectionString,
      // Serverless-friendly: hosted Postgres free tiers cap total connections.
      max: 5,
      idleTimeoutMillis: 10_000,
      ssl: /localhost|127\.0\.0\.1/.test(connectionString)
        ? undefined
        : { rejectUnauthorized: false },
    });
  }
  return globalForPool.__pantryPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

/** Returns the first row, or null. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Runs `fn` inside a transaction, rolling back on any thrown error. */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
