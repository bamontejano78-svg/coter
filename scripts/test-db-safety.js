'use strict';

const path = require('path');

const DEFAULT_TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/coter_test';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function assertSafeTestDatabaseUrl(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch (_error) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL for a local test database.');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('Integration tests require a local PostgreSQL test database.');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error('Refusing integration tests: DATABASE_URL must use localhost, 127.0.0.1, or ::1.');
  }

  if (url.search || url.hash) {
    throw new Error('Refusing integration tests: query parameters and fragments are not allowed in DATABASE_URL.');
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch (_error) {
    throw new Error('DATABASE_URL must name a local test database.');
  }
  if (!/(^|[_-])test$/i.test(databaseName)) {
    throw new Error('Refusing integration tests: the local database name must clearly identify a test database (for example, coter_test).');
  }

  return url;
}

function prepareTestDatabase() {
  require('dotenv').config({
    path: path.resolve(__dirname, '..', '.env'),
    override: false,
    quiet: true,
  });

  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Integration tests require NODE_ENV=test.');
  }

  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = DEFAULT_TEST_DATABASE_URL;
  }

  assertSafeTestDatabaseUrl(process.env.DATABASE_URL);
  return process.env.DATABASE_URL;
}

module.exports = { assertSafeTestDatabaseUrl, prepareTestDatabase };
