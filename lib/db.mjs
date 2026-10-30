import pg from 'pg';
import { getKainoDatabaseConfig } from '@kainostore/sdk/database';
import { getConfig } from './config.mjs';

// One pool per server process, created on first use (never during image build).
let pool;

export function databaseConfig() {
  return getKainoDatabaseConfig({ localDevelopment: getConfig().localDevelopment });
}

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ ...databaseConfig(), max: 5 });
    pool.on('error', (err) => console.error('database pool error:', err.code ?? err.name));
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}
