'use strict';

require('dotenv-flow').config({ silent: true });

const { Pool } = require('pg');

if (process.env.NODE_ENV !== 'test') {
  console.error('check-test-db must run with NODE_ENV=test');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/coter_test';
const timeout = parseInt(process.env.DB_CONNECTION_TIMEOUT_MS, 10) || 2000;

const pool = new Pool({
  connectionString,
  min: 0,
  max: 1,
  connectionTimeoutMillis: timeout,
  idleTimeoutMillis: 1000,
  ssl: connectionString.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
});

pool.query('SELECT 1')
  .then(() => {
    console.log('Test database reachable');
  })
  .catch((err) => {
    console.error('Test database is not reachable.');
    console.error('Set DATABASE_URL or start PostgreSQL before running integration tests.');
    if (err && err.message) console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
