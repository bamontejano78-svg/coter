'use strict';

const { Pool } = require('pg');

if (process.env.NODE_ENV !== 'test') {
  console.error('check-test-db must run with NODE_ENV=test');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/coter_test';
// CI service containers pueden tardar más en estar listos; 10s es razonable.
const timeout = parseInt(process.env.DB_CONNECTION_TIMEOUT_MS, 10) || 10000;

const pool = new Pool({
  connectionString,
  min: 0,
  max: 1,
  connectionTimeoutMillis: timeout,
  idleTimeoutMillis: 2000,
  ssl: connectionString.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
});

// Retry loop: hasta 3 intentos con 2s de espera entre cada uno.
// Cubre el caso en que el service container de Postgres en CI aún
// no acepta conexiones a pesar de que el health check pasó.
async function tryConnect(attempt = 1) {
  try {
    await pool.query('SELECT 1');
    console.log('TEST_DB_OK: reachable (attempt ' + attempt + ')');
    return true;
  } catch (err) {
    if (attempt < 3) {
      console.error('TEST_DB_RETRY: attempt ' + attempt + ' failed — ' + (err && err.message ? err.message : String(err)));
      await new Promise(r => setTimeout(r, 2000));
      return tryConnect(attempt + 1);
    }
    console.error('TEST_DB_FAIL: ' + (err && err.message ? err.message : String(err)));
    console.error('Set DATABASE_URL or start PostgreSQL before running integration tests.');
    return false;
  }
}

tryConnect()
  .then(ok => {
    if (!ok) process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
