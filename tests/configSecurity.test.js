const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

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
