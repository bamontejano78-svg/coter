'use strict';
// Sonda temporal para diagnosticar por qué el paciente no ve las tareas.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://localhost:3000';

async function api(path, method = 'GET', body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  const email = 'qa-probe-' + Date.now() + '@coter.com';
  const reg = await api('/api/v1/therapists/register', 'POST', {
    name: 'QA Probe', email, specialty: 'Psicología', password: 'qa123456',
  });
  console.log('registro:', reg.status, reg.body.success);
  const tToken = reg.body.token;

  const codeRes = await api('/api/v1/therapists/connection-codes', 'POST',
    { duration_hours: 24, max_uses: 1, patient_name: 'QA Probe Paciente' }, tToken);
  console.log('código:', codeRes.body.code);

  const conn = await api('/api/v1/patients/connect', 'POST', { connection_code: codeRes.body.code });
  console.log('conexión:', conn.status, conn.body.success, 'patientId:', conn.body.patient_id);
  const pToken = conn.body.auth_token;
  const patientId = conn.body.patient_id;

  const list = await api('/api/v1/therapists/patients', 'GET', null, tToken);
  console.log('pacientes del terapeuta:', list.body.patients.length, list.body.patients[0].id === patientId);

  const assign = await api('/api/v1/therapists/patients/' + patientId + '/assignments', 'POST', {
    type: 'ejercicio', title: 'Tarea de sonda', instructions: 'Hazla',
  }, tToken);
  console.log('crear tarea:', assign.status, JSON.stringify(assign.body));

  const ptasks = await api('/api/v1/patients/' + patientId + '/assignments', 'GET', null, pToken);
  console.log('tareas del paciente:', ptasks.status, JSON.stringify(ptasks.body).slice(0, 400));

  const ttasks = await api('/api/v1/therapists/patients/' + patientId + '/assignments', 'GET', null, tToken);
  console.log('tareas del terapeuta:', ttasks.status, JSON.stringify(ttasks.body).slice(0, 200));

  // limpieza
  require('dotenv').config({ path: path.join(ROOT, '.env'), override: false });
  const { getPool, closeDatabase } = require('../database');
  const pool = getPool();
  await pool.query("DELETE FROM therapists WHERE email LIKE 'qa-probe-%'");
  await closeDatabase();
  console.log('limpieza OK');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
