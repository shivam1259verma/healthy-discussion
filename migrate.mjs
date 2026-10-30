// Migration command declared in kaino.app.json. Safe to rerun: applied
// migrations are tracked, each file runs in one transaction, and an advisory
// lock stops two migrators from racing. Exits nonzero on any failure.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { databaseConfig } from './lib/db.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_ID = 7_300_117; // arbitrary app-specific advisory lock key

export async function migrate(log = console.log) {
  const client = new pg.Client(databaseConfig());
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }
    log('migrations up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate().catch((err) => {
    console.error('migration failed:', err.code ?? err.name, err.message);
    process.exit(1);
  });
}
