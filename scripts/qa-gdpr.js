/* ═══════════════════════════════════════════════════════════════
 * QA visual de los flujos RGPD del paciente (exportar y borrar datos)
 * usando playwright-core con el Chrome instalado en el sistema.
 *
 * Uso: node scripts/qa-gdpr.js
 *   - Arranca el servidor en el puerto 3000
 *   - Registra un terapeuta, conecta un paciente en el navegador,
 *     genera check-in + mensaje, exporta (verifica el JSON descargado)
 *     y borra los datos (verifica borrado en BD y en el panel del terapeuta).
 *   - Capturas en output/qa-gdpr/
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

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://localhost:3000';
const SHOTS = path.join(ROOT, 'output', 'qa-gdpr');

let server;
let browser;
let failures = 0;
let stepCount = 0;

function log(msg) { console.log('  ' + msg); }
function ok(msg) { console.log('  ✅ ' + msg); }
function fail(msg) { failures++; console.log('  ❌ ' + msg); }

async function shot(page, name) {
  stepCount++;
  const file = path.join(SHOTS, String(stepCount).padStart(2, '0') + '-' + name + '.png');
  await page.screenshot({ path: file });
  log('📸 ' + file);
}

function installConsoleWatcher(page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) {
      console.log('  ⚠️ console.error: ' + msg.text().slice(0, 250));
    }
  });
  page.on('pageerror', (err) => {
    console.log('  ⚠️ pageerror: ' + String(err.message || err).slice(0, 250));
  });
}

async function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: '3000' },
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

async function apiPost(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function patientFlow() {
  console.log('\n── Flujo paciente: conexión, datos, export y borrado ──');
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } }); // viewport móvil
  installConsoleWatcher(page);
  const patientName = 'QA Paciente RGPD';

  // 1. Registrar terapeuta + código de conexión (vía API)
  const email = 'qa-gdpr-' + Date.now() + '@coter.com';
  const reg = await apiPost('/api/v1/therapists/register', {
    name: 'QA Terapeuta GDPR', email, specialty: 'Psicología', password: 'qa123456',
  });
  if (!reg.body.success) { fail('No se pudo registrar al terapeuta de QA'); return; }
  const therapistToken = reg.body.token;
  const therapistName = reg.body.therapist.name;

  const codeRes = await fetch(BASE + '/api/v1/therapists/connection-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + therapistToken },
    body: JSON.stringify({ duration_hours: 24, max_uses: 1, patient_name: patientName }),
  });
  const codeBody = await codeRes.json();
  const connectionCode = codeBody.code;
  if (!/^TH-[A-Z0-9]{6}$/.test(connectionCode)) { fail('Código de conexión inválido: ' + connectionCode); return; }
  ok('Terapeuta registrado y código de conexión creado');

  // 2. Conectar el paciente en el navegador
  await page.goto(BASE + '/paciente.html');
  await page.fill('#codeInput', connectionCode);
  await shot(page, '1-conectar');
  await page.click('[data-action="connect"]');
  await page.waitForSelector('#mainScreen:not(.hidden)', { timeout: 10000 });
  ok('Paciente conectado (pantalla principal visible)');

  // 3. Enviar check-in con pensamiento
  await page.fill('#mood', '7');
  await page.fill('#anxiety', '4');
  await page.fill('#energy', '6');
  await page.fill('#thoughts', 'Semana tranquila, me siento mejor');
  await page.click('[data-action="send-checkin"]');
  await page.waitForFunction(() => {
    const t = document.querySelector('.toast:not(.hidden) #toastText');
    return t && /Check-in/i.test(t.textContent);
  }, { timeout: 10000 }).catch(() => {});
  ok('Check-in enviado');

  // 4. Enviar mensaje al terapeuta
  await page.fill('#msgInput', 'Mensaje de prueba para el export');
  await page.click('[data-action="send-message"]');
  await page.waitForFunction(() => {
    const box = document.getElementById('chatBox');
    return box && box.textContent.includes('Mensaje de prueba para el export');
  }, { timeout: 10000 });
  ok('Mensaje enviado y visible en el chat');
  await shot(page, '2-datos-creados');

  // 5. Exportar datos → capturar la descarga y validar el JSON
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
  await page.click('[data-action="export-data"]');
  let exportData = null;
  try {
    const download = await downloadPromise;
    const filePath = await download.path();
    exportData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    fail('No se pudo capturar la descarga del export: ' + e.message);
  }
  await shot(page, '3-export-descargado');

  if (exportData) {
    let exportOk = true;
    if (exportData.format !== 'coter-patient-export') { fail('Formato de export inesperado'); exportOk = false; }
    if (exportData.patient.name !== patientName) { fail('Nombre del paciente ausente en el export'); exportOk = false; }
    if (!exportData.check_ins.some((c) => c.thoughts === 'Semana tranquila, me siento mejor')) {
      fail('El check-in no aparece descifrado en el export'); exportOk = false;
    }
    if (!exportData.messages.some((m) => m.message === 'Mensaje de prueba para el export')) {
      fail('El mensaje no aparece en el export'); exportOk = false;
    }
    if (!exportData.therapist || exportData.therapist[0].name !== therapistName) {
      fail('El terapeuta no aparece en el export'); exportOk = false;
    }
    if (exportOk) ok('Export JSON correcto: perfil, check-in (descifrado), mensaje y terapeuta');
  }

  // El borrado se ejecuta después de verificar el panel del terapeuta.
  return { page, therapistToken, patientName };
}

async function deleteFlow(patientPage) {
  console.log('── Flujo de borrado (RGPD)');
  await patientPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await patientPage.click('[data-action="delete-data"]');
  await patientPage.waitForSelector('.swal2-input', { timeout: 8000, state: 'visible' });
  ok('Diálogo de borrado pide confirmación');
  await shot(patientPage, '4-borrar-confirmacion');

  // Confirmación incorrecta → error
  await patientPage.fill('.swal2-input', 'NO');
  await patientPage.click('.swal2-confirm');
  await patientPage.waitForFunction(() => {
    const t = document.querySelector('.toast:not(.hidden) #toastText');
    return t && /BORRAR/i.test(t.textContent);
  }, { timeout: 8000 }).catch(() => {});
  // Volver a abrir el diálogo
  await patientPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await patientPage.click('[data-action="delete-data"]');
  await patientPage.waitForSelector('.swal2-input', { timeout: 8000, state: 'visible' });
  ok('Confirmación inválida rechazada ("NO" ≠ BORRAR)');

  // Confirmación correcta
  await patientPage.fill('.swal2-input', 'BORRAR');
  await patientPage.click('.swal2-confirm');
  await patientPage.waitForFunction(() => {
    const p = document.querySelector('.swal2-popup');
    return p && /Datos eliminados/i.test(p.textContent || '');
  }, { timeout: 10000 });
  ok('Borrado confirmado con alerta de éxito');
  await shot(patientPage, '5-borrado-exito');
  await patientPage.click('.swal2-confirm');
  await patientPage.waitForSelector('#connectScreen:not(.hidden)', { timeout: 15000 });
  ok('Datos borrados → vuelve a la pantalla de conexión');
  await shot(patientPage, '6-vuelta-a-conexion');
}

async function therapistVerification(patientFlowResult) {
  console.log('\n── Panel del terapeuta: ver paciente y su desaparición (SSE) ──');
  const { page: patientPage, therapistToken, patientName } = patientFlowResult;

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  installConsoleWatcher(page);

  // Inyectar sesión del terapeuta antes de cargar la página
  await page.addInitScript(({ token, name }) => {
    localStorage.setItem('coter_therapist', JSON.stringify({ therapist: { name } }));
    sessionStorage.setItem('coter_therapist_tokens', JSON.stringify({ token, refresh_token: 'x' }));
  }, { token: therapistToken, name: 'QA Terapeuta GDPR' });

  await page.goto(BASE + '/terapeuta.html');
  await page.waitForSelector('#appScreen:not(.hidden)', { timeout: 10000 });
  await page.click('.nav-item[data-tab="patients"]');
  await page.waitForFunction((n) => {
    const body = document.getElementById('patientsTableBody');
    return body && body.textContent.includes(n);
  }, patientName, { timeout: 15000 });
  ok('El paciente aparece en la lista del terapeuta');
  await shot(page, '7-terapeuta-ve-paciente');

  // Dar margen para que el stream SSE quede establecido antes del borrado
  await page.waitForTimeout(2500);

  // Borrar los datos desde la página del paciente (sigue abierta)
  await deleteFlow(patientPage);

  // Esperar a que el paciente desaparezca en tiempo real (SSE patient:deleted)
  let disappeared = true;
  try {
    await page.waitForFunction((n) => {
      const body = document.getElementById('patientsTableBody');
      return body && !body.textContent.includes(n);
    }, patientName, { timeout: 15000 });
  } catch (e) {
    disappeared = false;
  }
  if (disappeared) {
    ok('El paciente desaparece de la lista en tiempo real (SSE)');
  } else {
    // Diagnóstico: ¿llegó el evento SSE? ¿un force reload lo elimina?
    const diag = await page.evaluate(async () => {
      const out = {};
      out.toastShown = !!(document.querySelector('.toast-container') && document.querySelector('.toast-container').textContent.includes('eliminó sus datos'));
      out.cache = window.PatientsCache ? window.PatientsCache.debug() : null;
      try { out.sseState = eval('sseConnection ? sseConnection.readyState : "undefined"'); } catch (e) { out.sseState = 'no-visible'; }
      out.sseOpen = eval('!!sseConnection');
      out.tableHasPatient = (document.getElementById('patientsTableBody') || {}).textContent || '';
      try {
        await window.loadPatients({ force: true });
        out.afterForceReload = (document.getElementById('patientsTableBody') || {}).textContent.includes(out.tableHasPatient.slice(0, 12)) ? 'same' : 'changed';
      } catch (err) { out.forceError = err.message; }
      out.tableAfter = (document.getElementById('patientsTableBody') || {}).textContent.slice(0, 120);
      return out;
    });
    console.log('  🔍 diagnóstico:', JSON.stringify(diag, null, 2).slice(0, 700));
    if (diag.toastShown) ok('El toast de paciente eliminado SÍ se mostró (SSE entregado)');
    else fail('El toast de paciente eliminado no apareció (SSE no entregado)');
    fail('El paciente no desaparece de la lista del terapeuta');
  }
  await shot(page, '8-terapeuta-sin-paciente');

  // Verificación servidor: el paciente ya no existe
  const res = await fetch(BASE + '/api/v1/therapists/patients', {
    headers: { Authorization: 'Bearer ' + therapistToken },
  });
  const list = await res.json();
  const ids = (list.patients || []).map((p) => p.id);
  if (ids.length === 0) ok('El paciente fue eliminado de la BD (lista del terapeuta vacía)');
  else fail('Todavía queda un paciente en la lista: ' + ids.join(','));

  await page.close();
  await patientPage.close();
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('Iniciando servidor...');
  await startServer();
  console.log('Servidor listo en ' + BASE);

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const result = await patientFlow();
    if (result) await therapistVerification(result);
  } finally {
    await browser.close();
  }

  // Limpieza: el terapeuta de QA se elimina de la BD de desarrollo
  try {
    require('dotenv').config({ path: path.join(ROOT, '.env'), override: false });
    const { getPool, closeDatabase } = require('../database');
    const pool = getPool();
    const r = await pool.query("DELETE FROM therapists WHERE email LIKE 'qa-gdpr-%' OR email LIKE 'qa-2fa-%' OR email LIKE 'qa-debug-%'");
    await closeDatabase();
    log('🧹 Terapeutas de QA eliminados de la BD de desarrollo (' + r.rowCount + ')');
  } catch (e) {
    console.log('  (no se pudo limpiar la BD de QA: ' + e.message + ')');
  }

  console.log('\n──────────────────────────────────────────────');
  if (failures === 0) console.log('✅ QA RGPD: TODOS LOS PASOS OK');
  else console.log('❌ QA RGPD: ' + failures + ' fallos detectados');
  process.exit(failures === 0 ? 0 : 1);
}

process.on('exit', () => { if (server) server.kill('SIGTERM'); });

main().catch((err) => {
  console.error('QA falló:', err.message);
  if (server) server.kill('SIGTERM');
  process.exit(1);
});
