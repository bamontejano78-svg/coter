'use strict';
// Sonda temporal: abre el stream SSE del paciente (raw http), crea una tarea
// por API y vuelca TODOS los eventos que llegan por el cable.
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://localhost:3000';

async function api(p, method = 'GET', body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

function openSse(ticket, onEvent) {
  const url = new URL(BASE + '/events?ticket=' + encodeURIComponent(ticket));
  const req = http.get(url, (res) => {
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (block.trim()) onEvent(block);
      }
    });
  });
  return req;
}

(async () => {
  const email = 'qa-probe-sse-' + Date.now() + '@coter.com';
  const reg = await api('/api/v1/therapists/register', 'POST', {
    name: 'QA Probe SSE', email, specialty: 'Psicología', password: 'qa123456',
  });
  const tToken = reg.body.token;
  const codeRes = await api('/api/v1/therapists/connection-codes', 'POST',
    { duration_hours: 24, max_uses: 1, patient_name: 'QA Probe SSE Paciente' }, tToken);
  const conn = await api('/api/v1/patients/connect', 'POST', { connection_code: codeRes.body.code });
  const pToken = conn.body.auth_token;
  const patientId = conn.body.patient_id;

  // 1) Ticket SSE del paciente
  const ticketRes = await fetch(BASE + '/api/v1/events/ticket/patient/' + patientId, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pToken },
  });
  const ticketBody = await ticketRes.json();
  console.log('ticket:', ticketBody.success, ticketBody.ticket ? 'OK' : 'FALLO');

  // 2) Abrir stream
  const events = [];
  const req = openSse(ticketBody.ticket, (block) => {
    events.push(block.replace(/\n/g, ' | '));
    console.log('SSE <<', block.replace(/\n/g, ' | ').slice(0, 200));
  });
  await new Promise((r) => setTimeout(r, 1500));

  // 3) Crear la tarea
  console.log('→ creando tarea...');
  await api('/api/v1/therapists/patients/' + patientId + '/assignments', 'POST', {
    type: 'ejercicio', title: 'Tarea SSE probe', instructions: 'Hazla',
  }, tToken);
  await new Promise((r) => setTimeout(r, 2000));
  console.log('eventos recibidos:', events.length);

  req.destroy();
  // limpieza
  require('dotenv').config({ path: path.join(ROOT, '.env'), override: false });
  const { getPool, closeDatabase } = require('../database');
  const pool = getPool();
  await pool.query("DELETE FROM therapists WHERE email LIKE 'qa-probe-sse-%'");
  await closeDatabase();
  console.log('limpieza OK');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
