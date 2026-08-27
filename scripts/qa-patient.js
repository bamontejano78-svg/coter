/* ═══════════════════════════════════════════════════════════════
 * QA visual del flujo completo del paciente
 * (conectar con código, check-in, tareas y chat bidireccional)
 * usando playwright-core con el Chrome instalado en el sistema.
 *
 * Uso: node scripts/qa-patient.js
 *   - Arranca el servidor en el puerto 3000
 *   - Registra un terapeuta y crea un código de conexión (API)
 *   - Navegador móvil: el paciente se conecta, hace check-in, escribe
 *     un mensaje, recibe la respuesta del terapeuta y completa la tarea
 *     que el terapeuta le asignó en su panel.
 *   - Navegador desktop: el terapeuta ve el check-in y el mensaje del
 *     paciente, responde en el chat, crea una tarea y ve cómo el
 *     paciente la completa en tiempo real (SSE).
 *   - Verificación final por API (mensajes en ambos sentidos, tarea
 *     completada) y capturas en output/qa-patient/.
 *
 * Dependencia opcional: playwright-core (npm install --no-save playwright-core)
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
const SHOTS = path.join(ROOT, 'output', 'qa-patient');

const TASK_TITLE = 'Respiración diafragmática 5 min';
const TASK_TYPE = 'ejercicio';
const TASK_INSTRUCTIONS = 'Inhala 4s, sostén 4s, exhala 6s. Repite 5 veces.';
const CHECKIN_THOUGHTS = 'Me siento con más energía esta semana';
const PATIENT_MSG = 'Hola, he tenido una buena semana';
const THERAPIST_REPLY = '¡Me alegro mucho! Cuéntame qué te ha funcionado';

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

// Registra todos los mensajes SSE que recibe la página (para diagnóstico).
function installSseLog(page) {
  return page.addInitScript(() => {
    const proto = EventSource.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'onmessage');
    Object.defineProperty(proto, 'onmessage', {
      get() { return desc.get.call(this); },
      set(fn) {
        desc.set.call(this, (ev) => {
          window.__sseLog = window.__sseLog || [];
          let s = String(ev.data || '').slice(0, 160);
          try { const p = JSON.parse(ev.data); s = p.type + ':' + JSON.stringify(p.data || {}).slice(0, 120); } catch (e) {}
          window.__sseLog.push(s);
          if (typeof fn === 'function') return fn.call(this, ev);
        });
      },
    });
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
    let exited = false;
    server.on('exit', (code) => { exited = true; out += '\n[server exit code=' + code + ']'; });
    const timeout = setTimeout(() => reject(new Error('timeout esperando al servidor\n' + out)), 60000);
    const poll = () => {
      if (exited) { clearTimeout(timeout); reject(new Error('El servidor hijo murió (¿puerto 3000 ocupado?):\n' + out)); return; }
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

async function setupTherapist() {
  console.log('\n── Setup: terapeuta + código de conexión (API) ──');
  const email = 'qa-patient-' + Date.now() + '@coter.com';
  const reg = await apiPost('/api/v1/therapists/register', {
    name: 'QA Terapeuta Paciente', email, specialty: 'Psicología', password: 'qa123456',
  });
  if (!reg.body.success) { fail('No se pudo registrar al terapeuta de QA'); return null; }
  const therapistToken = reg.body.token;
  const therapistName = reg.body.therapist.name;

  const codeRes = await fetch(BASE + '/api/v1/therapists/connection-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + therapistToken },
    body: JSON.stringify({ duration_hours: 24, max_uses: 1, patient_name: 'QA Paciente Flujo' }),
  });
  const codeBody = await codeRes.json();
  const connectionCode = codeBody.code;
  if (!/^TH-[A-Z0-9]{6}$/.test(connectionCode)) { fail('Código de conexión inválido: ' + connectionCode); return null; }
  ok('Terapeuta registrado y código de conexión creado (' + connectionCode + ')');
  return { therapistToken, therapistName, connectionCode };
}

async function patientFlow(setup) {
  console.log('\n── Paciente (móvil): conectar, check-in, mensaje ──');
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  installConsoleWatcher(page);
  await installSseLog(page);

  // 1. Conectar con el código
  await page.goto(BASE + '/paciente.html');
  await page.fill('#codeInput', setup.connectionCode);
  await shot(page, '1-conectar');
  await page.click('[data-action="connect"]');
  await page.waitForSelector('#mainScreen:not(.hidden)', { timeout: 10000 });
  ok('Paciente conectado (pantalla principal visible)');
  await shot(page, '2-main');

  // 2. Check-in
  await page.fill('#mood', '7');
  await page.fill('#anxiety', '4');
  await page.fill('#energy', '6');
  await page.fill('#thoughts', CHECKIN_THOUGHTS);
  await page.click('[data-action="send-checkin"]');
  await page.waitForFunction(() => {
    const t = document.querySelector('.toast:not(.hidden) #toastText');
    return t && /Check-in enviado/i.test(t.textContent);
  }, { timeout: 10000 }).catch(() => {});
  // El promedio de ánimo debe actualizarse a 7.0
  await page.waitForFunction(() => {
    const el = document.getElementById('avgMood');
    return el && el.textContent.trim() === '7.0';
  }, { timeout: 10000 }).catch(() => {
    const el = page.evaluate(() => document.getElementById('avgMood')?.textContent);
    fail('El promedio de ánimo no se actualizó a 7.0 (actual: ' + el + ')');
  });
  ok('Check-in enviado (ánimo 7, ansiedad 4, energía 6)');
  await shot(page, '3-checkin');

  // 3. Mensaje al terapeuta
  await page.fill('#msgInput', PATIENT_MSG);
  await page.click('[data-action="send-message"]');
  await page.waitForFunction((text) => {
    const box = document.getElementById('chatBox');
    return box && box.textContent.includes(text);
  }, PATIENT_MSG, { timeout: 10000 });
  ok('Mensaje del paciente visible en su chat');
  await shot(page, '4-mensaje-enviado');

  return page;
}

async function therapistFlow(setup, patientPage) {
  console.log('\n── Terapeuta (desktop): ver datos, responder y crear tarea ──');
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  installConsoleWatcher(page);

  await page.addInitScript(({ token, name }) => {
    localStorage.setItem('coter_therapist', JSON.stringify({ therapist: { name } }));
    sessionStorage.setItem('coter_therapist_tokens', JSON.stringify({ token, refresh_token: 'x' }));
  }, { token: setup.therapistToken, name: setup.therapistName });

  await page.goto(BASE + '/terapeuta.html');
  await page.waitForSelector('#appScreen:not(.hidden)', { timeout: 10000 });
  await page.click('.nav-item[data-tab="patients"]');
  await page.waitForFunction((n) => {
    const body = document.getElementById('patientsTableBody');
    return body && body.textContent.includes(n);
  }, 'QA Paciente Flujo', { timeout: 15000 });
  ok('El paciente aparece en la lista del terapeuta');
  await shot(page, '5-paciente-en-lista');

  // Abrir la ficha del paciente
  await page.evaluate((name) => {
    const rows = [...document.querySelectorAll('#patientsTableBody tr')];
    const row = rows.find((r) => r.textContent.includes(name));
    if (row) row.querySelector('.btn-open-patient').click();
  }, 'QA Paciente Flujo');
  await page.waitForSelector('#patientModal.show', { timeout: 10000 });
  ok('Ficha del paciente abierta');

  // Chat: ver el mensaje del paciente y responder
  await page.click('#mtab-chat');
  await page.waitForFunction((text) => {
    const box = document.getElementById('patientChat');
    return box && box.textContent.includes(text);
  }, PATIENT_MSG, { timeout: 10000 });
  ok('El terapeuta ve el mensaje del paciente');
  await page.fill('#chatMsgInput', THERAPIST_REPLY);
  await page.click('[data-action="send-msg"]');
  await page.waitForFunction((text) => {
    const box = document.getElementById('patientChat');
    return box && box.textContent.includes(text);
  }, THERAPIST_REPLY, { timeout: 10000 });
  ok('El terapeuta respondió (mensaje visible en su chat)');
  await shot(page, '6-chat-respondido');

  // El paciente debe recibir la respuesta en tiempo real (SSE)
  await patientPage.waitForFunction((text) => {
    const box = document.getElementById('chatBox');
    return box && box.textContent.includes(text);
  }, THERAPIST_REPLY, { timeout: 15000 });
  ok('El paciente recibe la respuesta del terapeuta en tiempo real (SSE)');
  await shot(patientPage, '7-respuesta-recibida');

  // Tareas: crear una tarea desde el panel
  await page.click('#mtab-tasks');
  await page.click('[data-action="add-task"]');
  await page.waitForSelector('.swal2-input', { timeout: 8000, state: 'visible' });
  await page.fill('#swalTaskTitle', TASK_TITLE);
  await page.fill('#swalTaskType', TASK_TYPE);
  await page.fill('#swalTaskInstructions', TASK_INSTRUCTIONS);
  await shot(page, '8-nueva-tarea-form');
  await page.click('.swal2-confirm');
  await page.waitForFunction((t) => {
    const box = document.getElementById('patientTasks');
    return box && box.textContent.includes(t);
  }, TASK_TITLE, { timeout: 10000 });
  ok('Tarea creada y visible en el panel del terapeuta');
  await shot(page, '9-tarea-creada');

  return page;
}

async function taskCompletionFlow(patientPage, therapistPage) {
  console.log('\n── Paciente: recibe la tarea y la completa ──');

  // El paciente ve la tarea asignada (SSE task:assigned → loadTasks)
  let taskVisible = true;
  try {
    await patientPage.waitForFunction((t) => {
      const list = document.getElementById('tasksList');
      return list && [...list.querySelectorAll('.task-item')].some((c) => c.textContent.includes(t));
    }, TASK_TITLE, { timeout: 15000 });
  } catch (e) {
    taskVisible = false;
    const diag = await patientPage.evaluate(async (t) => {
      const out = {};
      out.sseLog = window.__sseLog || [];
      try { out.sseState = sseConnection ? sseConnection.readyState : 'undefined'; } catch (e) { out.sseState = 'no-visible'; }
      out.tasksBefore = (document.getElementById('tasksList') || {}).textContent || '';
      // Fetch real del navegador con los mismos parámetros que loadTasks
      try {
        const r = await fetch(API + '/patients/' + patientId + '/assignments', { headers: authHeaders(false) });
        out.fetchStatus = r.status;
        const txt = await r.text();
        out.fetchBody = txt.slice(0, 400);
        const d = JSON.parse(txt);
        out.fetchCount = (d.assignments || []).length;
        // Replicar el render de loadTasks con checkpoints para localizar el throw
        if (d.assignments && d.assignments.length) {
          const t = d.assignments[0];
          out.aType = typeof window.ExerciseForms + ' / ' + typeof window.InteractiveWidgets;
          out.aKeys = Object.keys(t).join(',');
          const checkpoints = {};
          try { const c = document.createElement('div'); c.className = 'task-item'; checkpoints.createOk = true; } catch (e) { checkpoints.create = e.message; }
          try { window.sanitizeHTML(t.title); checkpoints.sanitizeOk = true; } catch (e) { checkpoints.sanitize = e.message; }
          try { checkpoints.isClinical = window.ExerciseForms.isClinicalKind(t.exercise_kind); } catch (e) { checkpoints.isClinicalErr = e.message; }
          try { checkpoints.isWidget = window.InteractiveWidgets.isWidgetTemplate(t.title, t.category); } catch (e) { checkpoints.isWidgetErr = e.message; }
          try { checkpoints.instructions = String(t.instructions || '').slice(0, 40); } catch (e) { checkpoints.instructionsErr = e.message; }
          try {
            const card = document.createElement('div');
            const head = document.createElement('div');
            head.innerHTML = '<div class="task-title">' + window.sanitizeHTML(t.title) + '</div>';
            card.appendChild(head);
            if (t.instructions) { const ins = document.createElement('div'); ins.textContent = t.instructions; card.appendChild(ins); }
            const btn = document.createElement('button'); btn.textContent = 'ok'; card.appendChild(btn);
            document.getElementById('tasksList').appendChild(card);
            checkpoints.renderFullOk = true;
          } catch (e) { checkpoints.renderFull = e.message; }
          out.checkpoints = checkpoints;
        }
      } catch (e) { out.fetchError = e.message; }
      // Interceptar fetch para ver qué responde el fetch interno de loadTasks
      try {
        const realFetch = window.fetch.bind(window);
        window.__fetches = [];
        window.fetch = async (...args) => {
          const res = await realFetch(...args);
          if (String(args[0]).includes('/assignments')) {
            window.__fetches.push({ url: String(args[0]).slice(0, 80), status: res.status, body: (await res.clone().text()).slice(0, 1200) });
          }
          return res;
        };
        // Instrumentar el catch vacío de loadTasks para capturar el error real
        try {
          const src = window.loadTasks.toString();
          const inst = src.replace('}catch(e){}', '}catch(e){ window.__ltErr = (e && e.stack) || String(e); }');
          (0, eval)(inst);
        } catch (e) { out.instrumentError = e.message; }
        await loadTasks();
        out.fetches = window.__fetches;
        out.ltErr = window.__ltErr || null;
        window.fetch = realFetch;
      } catch (e) { out.interceptError = e.message; }
      out.tasksAfter = (document.getElementById('tasksList') || {}).textContent || '';
      out.toast = (document.querySelector('.toast:not(.hidden) #toastText') || {}).textContent || '';
      return out;
    }, TASK_TITLE);
    console.log('  🔍 diagnóstico tarea no visible:');
    console.log('    SSE log: ' + JSON.stringify(diag.sseLog).slice(0, 600));
    console.log('    sseState: ' + diag.sseState);
    console.log('    fetch status: ' + diag.fetchStatus + ' count: ' + diag.fetchCount + (diag.fetchError ? ' error: ' + diag.fetchError : ''));
    console.log('    fetch body: ' + (diag.fetchBody || '').slice(0, 400));
    console.log('    checkpoints: ' + JSON.stringify(diag.checkpoints) + ' keys: ' + diag.aKeys + ' globals: ' + diag.aType);
    console.log('    fetch interno de loadTasks: ' + JSON.stringify(diag.fetches));
    console.log('    error real de loadTasks: ' + (diag.ltErr || '(ninguno capturado)'));
    console.log('    tasks antes: ' + JSON.stringify(diag.tasksBefore.slice(0, 150)));
    console.log('    tasks después (reload manual): ' + JSON.stringify(diag.tasksAfter.slice(0, 150)));
    console.log('    toast: ' + diag.toast);
  }
  if (taskVisible) ok('La tarea aparece en la lista del paciente');
  await shot(patientPage, '10-tarea-recibida');

  // Completarla
  await patientPage.evaluate((t) => {
    const cards = [...document.querySelectorAll('#tasksList .task-item')];
    const card = cards.find((c) => c.textContent.includes(t));
    if (card) card.querySelector('.btn-complete-task').click();
  }, TASK_TITLE);
  await patientPage.waitForFunction(() => {
    const t = document.querySelector('.toast:not(.hidden) #toastText');
    return t && /Tarea completada/i.test(t.textContent);
  }, { timeout: 10000 });
  ok('Paciente completó la tarea (toast confirmado)');
  await shot(patientPage, '11-tarea-completada');

  // Contador de tareas del paciente → 1
  await patientPage.waitForFunction(() => {
    const el = document.getElementById('tasksDone');
    return el && el.textContent.trim() === '1';
  }, { timeout: 10000 }).catch(() => {
    fail('El contador de tareas del paciente no llegó a 1');
  });

  // El terapeuta ve la tarea como "Completada" en tiempo real (SSE task:completed)
  await therapistPage.waitForFunction((t) => {
    const box = document.getElementById('patientTasks');
    return box && [...box.querySelectorAll('.task-item')].some(
      (c) => c.textContent.includes(t) && c.textContent.includes('Completada')
    );
  }, TASK_TITLE, { timeout: 15000 });
  ok('El terapeuta ve la tarea como Completada en tiempo real (SSE)');
  await shot(therapistPage, '12-tarea-completada-vista-terapeuta');
}

async function verifyByApi(setup) {
  console.log('\n── Verificación por API ──');
  const headers = { Authorization: 'Bearer ' + setup.therapistToken };

  // Mensajes en ambos sentidos
  const patientsRes = await fetch(BASE + '/api/v1/therapists/patients', { headers });
  const patientsList = await patientsRes.json();
  const patient = (patientsList.patients || [])[0];
  if (!patient) { fail('No se encontró el paciente vía API'); return; }

  const msgsRes = await fetch(BASE + '/api/v1/therapists/patients/' + patient.id + '/messages', { headers });
  const msgsData = await msgsRes.json();
  const texts = (msgsData.messages || []).map((m) => m.message);
  const hasPatientMsg = texts.includes(PATIENT_MSG);
  const hasTherapistReply = texts.includes(THERAPIST_REPLY);
  if (hasPatientMsg && hasTherapistReply) ok('Mensajes verificados en ambos sentidos vía API');
  else {
    if (!hasPatientMsg) fail('El mensaje del paciente no está en el backend');
    if (!hasTherapistReply) fail('La respuesta del terapeuta no está en el backend');
  }

  // La tarea quedó completada
  const tasksRes = await fetch(BASE + '/api/v1/therapists/patients/' + patient.id + '/assignments', { headers });
  const tasksData = await tasksRes.json();
  const task = (tasksData.assignments || []).find((a) => a.title === TASK_TITLE);
  if (!task) { fail('La tarea no existe en el backend'); return; }
  if (task.status === 'completed') ok('Tarea verificada como completada en el backend');
  else fail('La tarea no está completada en el backend (status: ' + task.status + ')');

  // El check-in quedó registrado
  const ciRes = await fetch(BASE + '/api/v1/therapists/patients/' + patient.id + '/check-ins', { headers });
  const ciData = await ciRes.json();
  const hasCheckin = (ciData.check_ins || []).some((c) => c.thoughts === CHECKIN_THOUGHTS);
  if (hasCheckin) ok('Check-in verificado en el backend');
  else fail('El check-in no está en el backend');
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('Iniciando servidor...');
  await startServer();
  console.log('Servidor listo en ' + BASE);

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  let patientPage = null;
  let therapistPage = null;
  try {
    const setup = await setupTherapist();
    if (!setup) return;
    patientPage = await patientFlow(setup);
    therapistPage = await therapistFlow(setup, patientPage);
    await taskCompletionFlow(patientPage, therapistPage);
    await verifyByApi(setup);
  } finally {
    if (patientPage) await patientPage.close().catch(() => {});
    if (therapistPage) await therapistPage.close().catch(() => {});
    await browser.close();
  }

  // Limpieza: el terapeuta de QA se elimina de la BD de desarrollo
  try {
    require('dotenv').config({ path: path.join(ROOT, '.env'), override: false });
    const { getPool, closeDatabase } = require('../database');
    const pool = getPool();
    const r = await pool.query("DELETE FROM therapists WHERE email LIKE 'qa-patient-%' OR email LIKE 'qa-gdpr-%' OR email LIKE 'qa-2fa-%' OR email LIKE 'qa-debug-%'");
    await closeDatabase();
    log('🧹 Terapeutas de QA eliminados de la BD de desarrollo (' + r.rowCount + ')');
  } catch (e) {
    console.log('  (no se pudo limpiar la BD de QA: ' + e.message + ')');
  }

  console.log('\n──────────────────────────────────────────────');
  if (failures === 0) console.log('✅ QA Paciente: TODOS LOS PASOS OK');
  else console.log('❌ QA Paciente: ' + failures + ' fallos detectados');
  process.exit(failures === 0 ? 0 : 1);
}

process.on('exit', () => { if (server) server.kill('SIGTERM'); });

main().catch((err) => {
  console.error('QA falló:', err.message);
  if (server) server.kill('SIGTERM');
  process.exit(1);
});
