const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const { assertSafeTestDatabaseUrl } = require('../scripts/test-db-safety');

function runNode(script, env, cwd = ROOT) {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return result;
}

function probeConfig(env) {
  const script = "try { require('./config/env'); process.exit(0); } catch (error) { console.error(error.message); process.exit(1); }";
  return runNode(script, env);
}

describe('integration test database safety', () => {
  test('allows only loopback PostgreSQL databases with a test name', () => {
    expect(() => assertSafeTestDatabaseUrl('postgresql://coter:secret@localhost:5432/coter_test')).not.toThrow();
    expect(() => assertSafeTestDatabaseUrl('postgresql://coter:secret@127.0.0.1:5432/coter-test')).not.toThrow();
  });

  test('rejects remote hosts and local non-test database names', () => {
    expect(() => assertSafeTestDatabaseUrl('postgresql://coter:secret@db.example.net:5432/coter_test'))
      .toThrow('must use localhost');
    expect(() => assertSafeTestDatabaseUrl('postgresql://coter:secret@localhost:5432/coter'))
      .toThrow('database name must clearly identify a test database');
  });

  test('rejects connection-string parameters and fragments', () => {
    expect(() => assertSafeTestDatabaseUrl('postgresql://coter:secret@localhost:5432/coter_test?host=db.example.net'))
      .toThrow('query parameters and fragments are not allowed');
    expect(() => assertSafeTestDatabaseUrl('postgresql://coter:secret@localhost:5432/coter_test#remote'))
      .toThrow('query parameters and fragments are not allowed');
  });
});

describe('Supertest therapist registration helper', () => {
  test('verifies successful registrations through the app and preserves the response body', async () => {
    const express = require('express');
    const request = require('./helpers/request');
    const verificationToken = 'a'.repeat(64);
    const session = {
      id: 'therapist-test-id',
      email: 'therapist@test.invalid',
      token: 'test-session-token',
      therapist: { id: 'therapist-test-id', email: 'therapist@test.invalid' },
    };
    const receivedTokens = [];
    const app = express();

    app.post('/api/v1/therapists/register', (_req, res) => {
      res.json({
        success: true,
        requires_verification: true,
        verification_url: `https://public.example/verify-email.html?token=${verificationToken}`,
      });
    });
    app.get('/api/v1/therapists/verify-email', (req, res) => {
      receivedTokens.push(req.query.token);
      res.json({ success: true, token: session.token, therapist: session.therapist });
    });

    const response = await request(app)
      .post('/api/v1/therapists/register')
      .send({ email: 'therapist@test.invalid' });

    expect(response.body).toEqual({
      success: true,
      requires_verification: true,
      verification_url: `https://public.example/verify-email.html?token=${verificationToken}`,
    });
    expect(response.testSession).toEqual(session);
    expect(receivedTokens).toEqual([verificationToken]);
  });

  test('leaves unsuccessful registration responses untouched', async () => {
    const express = require('express');
    const request = require('./helpers/request');
    const app = express();
    let verificationRequested = false;
    const failure = { success: false, error: 'Email ya registrado' };

    app.post('/api/v1/therapists/register', (_req, res) => res.json(failure));
    app.get('/api/v1/therapists/verify-email', (_req, res) => {
      verificationRequested = true;
      res.status(500).json({ success: false });
    });

    const response = await request(app)
      .post('/api/v1/therapists/register')
      .send({ email: 'duplicate@test.invalid' });

    expect(response.body).toEqual(failure);
    expect(response.testSession).toBeUndefined();
    expect(verificationRequested).toBe(false);
  });
});

describe('request log path redaction', () => {
  test('removes query strings and sanitizes controls before logging request targets', () => {
    const { requestLogPath } = require('../utils/requestLogPath');

    expect(requestLogPath('/api/v1/therapists/verify-email?token=one-time-secret'))
      .toBe('/api/v1/therapists/verify-email');
    expect(requestLogPath('/api/v1/events?ticket=sse-secret'))
      .toBe('/api/v1/events');
    expect(requestLogPath('/safe-path\nforged-entry'))
      .toBe('/safe-path_forged-entry');
    expect(requestLogPath('/api/v1/therapists/verify-email?token=log-only-placeholder'))
      .not.toContain('log-only-placeholder');
  });
});

describe('secure environment configuration', () => {

  const baseStagingEnv = {
    NODE_ENV: 'staging',
    DATABASE_URL: 'postgresql://coter:password@postgres:5432/coter_staging',
    JWT_SECRET: KEY,
    ENCRYPTION_KEY: KEY,
    CORS_ORIGINS: 'https://staging.coter.test',
    ADMIN_PASSWORD: 'staging-admin-password',
    SMTP_PASS: 'staging-smtp-secret',
    STRIPE_SECRET_KEY: 'sk_test_staging',
    STRIPE_WEBHOOK_SECRET: 'whsec_staging',
    STRIPE_PRICE_ID: 'price_staging',
  };

  test('staging refuses to start without an encryption key', () => {
    const env = { ...baseStagingEnv, ENCRYPTION_KEY: '' };
    const result = probeConfig(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENCRYPTION_KEY');
  });

  test('staging starts when every required security value is present', () => {
    const result = probeConfig(baseStagingEnv);
    expect(result.status).toBe(0);
  });

  test('staging refuses weak or ambiguous PostgreSQL sslmode values', () => {
    const env = {
      ...baseStagingEnv,
      DATABASE_URL: baseStagingEnv.DATABASE_URL + '?sslmode=require',
    };
    const result = probeConfig(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('sslmode=verify-full');
  });

  test('encrypt refuses to persist sensitive content without a key', () => {
    const result = runNode(
      "try { require('../utils/encryption').encrypt('clinical-note'); process.exit(0); } catch (error) { console.error(error.code); process.exit(1); }",
      { NODE_ENV: 'development', ENCRYPTION_KEY: '' },
      path.join(ROOT, 'tests')
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENCRYPTION_KEY_REQUIRED');
  });
});
