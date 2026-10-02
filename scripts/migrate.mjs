#!/usr/bin/env node
// Applies db/schema.sql. The schema is written to be idempotent, so this is
// safe to re-run; --reset drops the public schema first.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, '..', 'db', 'schema.sql');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local first.');
  process.exit(1);
}

const reset = process.argv.includes('--reset');

const client = new pg.Client({
  connectionString,
  ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
});

try {
  await client.connect();

  if (reset) {
    console.log('Dropping public schema...');
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }

  console.log(`Applying ${schemaPath}...`);
  await client.query(readFileSync(schemaPath, 'utf8'));

  // Enum value additions must run as standalone statements — PostgreSQL
  // rejects ALTER TYPE ... ADD VALUE from inside a DO block, so these cannot
  // live in schema.sql alongside the idempotent CREATE TYPE guards.
  const enumAdditions = [
    ["photo_kind", "dish_render"],
    ["photo_kind", "receipt"],
  ];
  for (const [typeName, value] of enumAdditions) {
    try {
      await client.query(`ALTER TYPE ${typeName} ADD VALUE IF NOT EXISTS '${value}'`);
    } catch (err) {
      // Only ignore "type does not exist yet"; anything else is a real problem.
      if (err.code !== '42704') throw err;
    }
  }

  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`
  );
  console.log(`Done. ${rows.length} tables/views:`);
  for (const r of rows) console.log(`  - ${r.table_name}`);
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
