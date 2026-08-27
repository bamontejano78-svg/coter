/* ═══════════════════════════════════════════════════════════════
 * QA visual del flujo 2FA (terapeuta + admin) usando playwright-core
 * con el Chrome instalado en el sistema (no descarga navegadores).
 *
 * Uso: node scripts/qa-2fa.js
 *   - Arranca el servidor (node server.js) en el puerto 3000
 *   - Abre Chrome headless, recorre los flujos y guarda capturas en
 *     output/qa-2fa/
 *   - Reporta errores de consola y fallos de expectativas.
 * ═══════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
let chromium;
try {
  chromium = require('playwright-core').chromium;
} catch (err) {
  console.error('❌ playwright-core no está instalado. Este script es opcional: instálalo solo si quieres ejecutar el QA visual:');
  console.error('   npm install --no-save playwright-core');
  process.exit(1);
}
const { totp, generateSecret } = require('../utils/totp');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://localhost:3000';
const SHOTS = path.join(ROOT, 'output', 'qa-2fa');
const ADMIN_PASSWORD = 'qa-admin-' + Math.random().toString(36).slice(2, 10);

let server;
let browser;
let page;
let failures = 0;
let stepCount = 0;

function log(msg) {
  console.log('  ' + msg);
}
function ok(msg) {
  console.log('  ✅ ' + msg);
}
function fail(msg) {
  failures++;
  console.log('  ❌ ' + msg);
}
function currentCode(secret) {
  return totp(secret, { time: Date.now() });
}

async function shot(name) {
  stepCount++;
  const file = path.join(SHOTS, String(stepCount).padStart(2, '0') + '-' + name + '.png');
  await page.screenshot({ path: file, fullPage: false });
  log('📸 ' + file);
}

function installConsoleWatcher(p) {
  p.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ruido esperado: errores 401/404 de fetch no críticos o favicon
      if (/Failed to load resource|net::ERR/.test(text)) return;
      console.log('  ⚠️ console.error: ' + text.slice(0, 300));
    }
  });
  p.on('pageerror', (err) => {
    console.log('  ⚠️ pageerror: ' + String(err.message || err).slice(0, 300));
  });
}

async function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: '3000', ADMIN_PASSWORD },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    server.stdout.on('data', (d) => { out += d; });
    server.stderr.on('data', (d) => { out += d; });
    const timeout = setTimeout(() => reject(new Error('timeout esperando al servidor\n' + out)), 60000);
    const poll = () => {
      fetch(BASE + '/api/health')
        .then((r) => r.json())
        .then((h) => { if (h.status === 'ok') { clearTimeout(timeout); resolve(); } else setTimeout(poll, 1000); })
        .catch(() => setTimeout(poll, 1000));
    };
    poll();
  });
}

async function waitForSwalVisible() {
  await page.waitForSelector('.swal2-popup:not([style*="display: none"])', { timeout: 8000, state: 'visible' }).catch(() => {});
}

async function fillSwalInput(text) {
  await page.waitForSelector('.swal2-input', { timeout: 8000, state: 'visible' });
  await page.fill('.swal2-input', text);
}

async function clickSwalConfirm() {
  await page.click('.swal2-confirm');
}

async function therapistFlow() {
  console.log('\n── Flujo terapeuta ──────────────────────────────');
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  installConsoleWatcher(page);

  const email = 'qa-2fa-' + Date.now() + '@coter.com';
  const password = 'qa123456';

  // 1. Registro
  await page.goto(BASE + '/terapeuta.html');
  await page.click('[data-action="show-register"]');
  await page.fill('#regName', 'QA Terapeuta 2FA');
  await page.fill('#regEmail', email);
  await page.fill('#regSpecialty', 'Psicología clínica');
  await page.fill('#regPassword', password);
  await page.click('[data-action="register"]');
  await page.waitForSelector('#appScreen:not(.hidden)', { timeout: 10000 });
  ok('Registro y login automático (sin 2FA todavía)');
  await shot('1-registro');

  // 2. Pestaña Seguridad: estado desactivada
  await page.click('.nav-item[data-tab="security"]');
  await page.waitForSelector('#securityContent button[data-action="enable-2fa"]', { timeout: 10000 });
  ok('Pestaña Seguridad muestra estado desactivada');
  await shot('2-seguridad-off');

  // 3. Activar 2FA: setup → QR → confirmar con TOTP
  await page.click('[data-action="enable-2fa"]');
  await waitForSwalVisible();
  // Leer el secreto mostrado en el modal
  const secretEl = await page.$('.swal2-popup code, .swal2-popup p[style*="monospace"]');
  if (!secretEl) { fail('No se encontró el secreto en el modal de activación'); return; }
  const secret = (await secretEl.textContent()).trim();
  if (!/^[A-Z2-7]{32}$/.test(secret)) { fail('Secreto TOTP inválido en el modal: ' + secret); }
  else ok('Modal muestra QR y clave manual (secreto válido)');
  await shot('3-setup-qr');
  const qrVisible = await page.$('.swal2-popup img[src^="data:image/png"]');
  if (!qrVisible) fail('No se renderizó el QR (data URL) en el modal');
  else ok('QR renderizado en el modal');

  await fillSwalInput(currentCode(secret));
  await clickSwalConfirm();

  // 4. Códigos de respaldo
  await waitForSwalVisible();
  await page.waitForSelector('#copyBackupCodes', { timeout: 8000 });
  const backupCodes = await page.$$eval('.swal2-popup code', (els) => els.map((e) => e.textContent.trim()).filter((t) => /^[A-HJ-NP-Z2-9]{16}$/.test(t)));
  if (backupCodes.length !== 10) fail('Se esperaban 10 códigos de respaldo, hay ' + backupCodes.length);
  else ok('10 códigos de respaldo mostrados');
  await shot('4-backup-codes');
  await clickSwalConfirm();

  // 5. Estado activa
  await page.waitForSelector('#securityContent button[data-action="disable-2fa"]', { timeout: 10000 });
  ok('Estado pasa a "activa" con botón desactivar');
  await shot('5-seguridad-on');

  // 6. Logout
  await page.click('[data-action="logout"]');
  await page.waitForSelector('#loginScreen:not(.hidden)', { timeout: 10000 });
  ok('Logout vuelve a login');

  // 7. Login: primer paso → requiere 2FA
  await page.fill('#loginEmail', email);
  await page.fill('#loginPassword', password);
  await page.click('[data-action="login"]');
  await waitForSwalVisible();
  await page.waitForSelector('.swal2-input', { timeout: 8000 });
  ok('Login exige el código 2FA (modal)');
  await shot('6-login-2fa-prompt');  // 8. Código incorrecto → error
  await fillSwalInput('000000');
  await clickSwalConfirm();
  // El backend rechaza y se muestra un alert de error antes de re-pedir el código
  await page.waitForFunction(() => {
    const p = document.querySelector('.swal2-popup');
    return p && /incorrecto|inválido/i.test(p.textContent || '');
  }, { timeout: 8000 });
  ok('Código incorrecto rechazado con alerta de error');
  // Cerrar el error → vuelve a pedir el código
  await clickSwalConfirm();
  await waitForSwalVisible();

  // 9. Código correcto → dashboard
  await waitForSwalVisible();
  await fillSwalInput(currentCode(secret));
  await clickSwalConfirm();
  await page.waitForSelector('#appScreen:not(.hidden)', { timeout: 10000 });
  ok('Login 2 pasos completado → dashboard');
  await shot('7-login-completo');

  // 10. Desactivar 2FA
  await page.click('.nav-item[data-tab="security"]');
  await page.waitForSelector('#securityContent button[data-action="disable-2fa"]', { timeout: 10000 });
  await page.click('[data-action="disable-2fa"]');
  await waitForSwalVisible();
  await fillSwalInput(currentCode(secret));
  await clickSwalConfirm();
  await page.waitForSelector('#securityContent button[data-action="enable-2fa"]', { timeout: 10000 });
  ok('2FA desactivada correctamente');
  await shot('8-seguridad-off');
  // Cerrar el alert de éxito para no bloquear el siguiente click
  await clickSwalConfirm();

  // 11. Login vuelve a ser de 1 paso
  await page.click('[data-action="logout"]');
  await page.waitForSelector('#loginScreen:not(.hidden)', { timeout: 10000 });
  await page.fill('#loginEmail', email);
  await page.fill('#loginPassword', password);
  await page.click('[data-action="login"]');
  await page.waitForSelector('#appScreen:not(.hidden)', { timeout: 10000 });
  ok('Tras desactivar, login directo sin código');
  await page.close();

  return { email, password };
}

async function adminFlow() {
  console.log('\n── Flujo admin ─────────────────────────────────');
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  installConsoleWatcher(page);

  // 1. Login admin con contraseña (2FA aún desactivada)
  await page.goto(BASE + '/admin.html');
  await page.fill('#adminPassword', ADMIN_PASSWORD);
  await page.click('#loginBtn');
  await page.waitForSelector('#dashboardScreen:not(.hidden)', { timeout: 10000 });
  ok('Login admin sin 2FA');
  await shot('a1-admin-login');

  // 2. Activar 2FA desde el panel de seguridad
  await page.waitForSelector('#adminEnable2faBtn', { timeout: 10000 });
  await page.click('#adminEnable2faBtn');
  await page.waitForSelector('#admin2faConfirmCode', { timeout: 10000 });
  const secretCode = await page.textContent('#adminSecurityContent code');
  const secret = secretCode.trim();
  if (!/^[A-Z2-7]{32}$/.test(secret)) fail('Secreto admin inválido: ' + secret);
  else ok('QR + clave manual mostrados en el panel');
  await shot('a2-admin-setup');
  const qr = await page.$('#adminSecurityContent img[src^="data:image/png"]');
  if (!qr) fail('No se renderizó el QR en el panel admin');
  else ok('QR renderizado en el panel admin');

  await page.fill('#admin2faConfirmCode', currentCode(secret));
  await page.click('#admin2faConfirmBtn');
  await page.waitForSelector('#admin2faDoneBtn', { timeout: 10000 });
  const backupCodes = await page.$$eval('#adminSecurityContent code', (els) => els.map((e) => e.textContent.trim()));
  if (backupCodes.length !== 10) fail('Admin: se esperaban 10 respaldos, hay ' + backupCodes.length);
  else ok('Admin: 10 códigos de respaldo');
  await shot('a3-admin-backups');
  await page.click('#admin2faDoneBtn');
  await page.waitForSelector('#adminDisable2faBtn', { timeout: 10000 });
  ok('Admin: 2FA activa');
  await shot('a4-admin-on');

  // 3. Logout y login en 2 pasos
  await page.click('#logoutBtn');
  await page.waitForSelector('#loginScreen:not(.hidden)', { timeout: 10000 });
  await page.fill('#adminPassword', ADMIN_PASSWORD);
  await page.click('#loginBtn');
  await page.waitForSelector('#twoFactorField:not(.hidden)', { timeout: 10000 });
  ok('Admin: login pide el código 2FA');
  await shot('a5-admin-2fa-prompt');

  // 4. Código incorrecto
  await page.fill('#twoFactorCode', '000000');
  await page.click('#loginBtn');
  await page.waitForSelector('#loginError:not(.hidden)', { timeout: 10000 });
  ok('Admin: código incorrecto rechazado');

  // 5. Código correcto
  await page.fill('#twoFactorCode', currentCode(secret));
  await page.click('#loginBtn');
  await page.waitForSelector('#dashboardScreen:not(.hidden)', { timeout: 10000 });
  ok('Admin: login 2 pasos completado → dashboard');
  await shot('a6-admin-2fa-done');

  // 6. Desactivar (el handler del prompt() debe registrarse antes del click)
  await page.waitForSelector('#adminDisable2faBtn', { timeout: 10000 });
  page.once('dialog', async (dialog) => {
    await dialog.accept(currentCode(secret));
  });
  await page.click('#adminDisable2faBtn');
  await page.waitForSelector('#adminEnable2faBtn', { timeout: 10000 });
  ok('Admin: 2FA desactivada');
  await shot('a7-admin-off');
  await page.close();
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('Iniciando servidor...');
  await startServer();
  console.log('Servidor listo en ' + BASE);

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    await therapistFlow();
    await adminFlow();
  } finally {
    await browser.close();
  }

  console.log('\n──────────────────────────────────────────────');
  if (failures === 0) console.log('✅ QA 2FA: TODOS LOS PASOS OK');
  else console.log('❌ QA 2FA: ' + failures + ' fallos detectados');
  process.exit(failures === 0 ? 0 : 1);
}

process.on('exit', () => {
  if (server) server.kill('SIGTERM');
});

main().catch((err) => {
  console.error('QA falló:', err.message);
  if (server) server.kill('SIGTERM');
  process.exit(1);
});
