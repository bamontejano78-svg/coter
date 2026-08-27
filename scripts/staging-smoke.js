'use strict';

const DEFAULT_RETRIES = 8;
const DEFAULT_DELAY_MS = 3000;
const DEFAULT_TIMEOUT_MS = 7000;

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

if (process.env.STAGING_SMOKE_ALLOW_INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const rawBaseUrl = args.get('url') || process.env.STAGING_URL;
if (!rawBaseUrl) {
  console.error('STAGING_URL es requerido. Ej: STAGING_URL=https://staging.example.com node scripts/staging-smoke.js');
  process.exit(1);
}

const baseUrl = rawBaseUrl.replace(/\/+$/, '');
const retries = parseInt(args.get('retries') || process.env.STAGING_SMOKE_RETRIES || DEFAULT_RETRIES, 10);
const delayMs = parseInt(args.get('delay-ms') || process.env.STAGING_SMOKE_DELAY_MS || DEFAULT_DELAY_MS, 10);
const timeoutMs = parseInt(args.get('timeout-ms') || process.env.STAGING_SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const url = baseUrl + path;
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
      ...(options.headers || {}),
    },
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');
  return { response, body, contentType };
}

async function retry(label, fn) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        console.log(`${label}: intento ${attempt}/${retries} fallo (${err.message}); reintentando...`);
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

async function checkHealth() {
  const { response, body } = await request('/api/health');
  if (!response.ok) {
    throw new Error(`health HTTP ${response.status}`);
  }
  if (!body || body.status !== 'ok' || body.database !== 'connected') {
    throw new Error(`health inesperado: ${JSON.stringify(body)}`);
  }
  if (body.environment !== 'staging' && args.get('allow-non-staging') !== 'true') {
    throw new Error(`environment debe ser staging, recibido: ${body.environment}`);
  }
  return body;
}

async function checkHtml(path, expected) {
  const { response, body, contentType } = await request(path);
  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status}`);
  }
  if (!contentType.includes('text/html') && !String(body).includes('<!DOCTYPE html')) {
    throw new Error(`${path} no devolvio HTML`);
  }
  if (!String(body).toLowerCase().includes(expected.toLowerCase())) {
    throw new Error(`${path} no contiene marcador esperado: ${expected}`);
  }
}

(async () => {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error('STAGING_URL debe usar HTTPS para staging publico');
  }

  console.log(`Smoke staging: ${baseUrl}`);
  const health = await retry('health', checkHealth);
  console.log(`OK health: env=${health.environment}, uptime=${Math.round(health.uptime)}s`);

  await retry('home', () => checkHtml('/', 'Coter'));
  console.log('OK home HTML');

  await retry('therapist', () => checkHtml('/terapeuta.html', 'Coter'));
  console.log('OK therapist HTML');

  await retry('patient', () => checkHtml('/paciente.html', 'Coter'));
  console.log('OK patient HTML');

  console.log('OK: smoke staging completado');
})().catch((err) => {
  console.error(`Smoke staging fallido: ${err.message}`);
  process.exit(1);
});
