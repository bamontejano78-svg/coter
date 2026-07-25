// ════════════════════════════════════════════════════════════════════════════
// utils/clinicalAlerts.js
// ════════════════════════════════════════════════════════════════════════════
// Motor de reglas para alertas clínicas inteligentes.
//
// Evalúa datos recientes de pacientes contra reglas predefinidas y genera
// alertas que se entregan al terapeuta via SSE (badge en dashboard + toast).
//
// Reglas implementadas:
//   1. mood_drop      — Ánimo baja ≥3 puntos entre dos check-ins consecutivos
//   2. no_checkin_3d  — 3+ días sin check-in (abandono de registro)
//   3. anxiety_spike  — Ansiedad ≥8/10 en 2 check-ins consecutivos
//   4. assignment_overdue — Tarea pendiente vencida hace ≥1 día
//   5. q09_flagged    — Respuesta positiva en ítem de autolesión (PHQ-9/BDI-II)
//
// Deduplicación: no genera la misma alerta para el mismo paciente si ya
// existe una no leída en las últimas 24h (ventana de supresión).
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../config/logger');
const bus = require('./eventBus');

const DEDUP_WINDOW_HOURS = 24;
const NO_CHECKIN_DAYS = 3;
const MOOD_DROP_THRESHOLD = 3;
const ANXIETY_HIGH = 8;

/**
 * Evalúa todas las reglas para todos los pacientes activos y genera alertas.
 * Diseñado para ejecutarse desde taskScheduler cada 15-30 minutos.
 *
 * @param {Object} pool - PostgreSQL pool
 * @returns {Promise<{scanned:number, alerts:number, errors:number}>}
 */
async function evaluateAllAlerts(pool) {
  let alerts = 0;
  let errors = 0;

  try {
    // ── 1. Obtener todos los pacientes activos con sus terapeutas ──
    const { rows: patients } = await pool.query(
      `SELECT tp.therapist_id, tp.patient_id, p.name as patient_name
       FROM therapist_patients tp
       JOIN patients p ON p.id = tp.patient_id
       WHERE tp.status = 'active'`
    );

    if (!patients.length) return { scanned: 0, alerts: 0, errors: 0 };

    // ── 2. Evaluar cada paciente contra las reglas ──
    for (const pt of patients) {
      try {
        const newAlerts = await evaluatePatientRules(pool, pt);
        alerts += newAlerts;
      } catch (err) {
        errors++;
        logger.warn('Error evaluando alertas para paciente', {
          patientId: pt.patient_id, error: err.message,
        });
      }
    }

    return { scanned: patients.length, alerts, errors };
  } catch (err) {
    logger.error('Error en evaluateAllAlerts', { error: err.message });
    return { scanned: 0, alerts: 0, errors: 1 };
  }
}

async function evaluatePatientRules(pool, pt) {
  let alertsCreated = 0;

  // ── Rule 1: Mood drop ──
  const moodDrop = await checkMoodDrop(pool, pt);
  if (moodDrop) { await createAlert(pool, pt, moodDrop); alertsCreated++; }

  // ── Rule 2: No check-in for 3+ days ──
  const noCheckin = await checkNoCheckin(pool, pt);
  if (noCheckin) { await createAlert(pool, pt, noCheckin); alertsCreated++; }

  // ── Rule 3: Anxiety spike ──
  const anxietySpike = await checkAnxietySpike(pool, pt);
  if (anxietySpike) { await createAlert(pool, pt, anxietySpike); alertsCreated++; }

  // ── Rule 4: Assignment overdue ──
  const overdue = await checkAssignmentOverdue(pool, pt);
  if (overdue) { await createAlert(pool, pt, overdue); alertsCreated++; }

  // ── Rule 5: Q09 flagged ──
  const q09 = await checkQ09Flagged(pool, pt);
  if (q09) { await createAlert(pool, pt, q09); alertsCreated++; }

  return alertsCreated;
}

// ─── Rule implementations ──────────────────────────────────────────────

async function checkMoodDrop(pool, pt) {
  const { rows } = await pool.query(
    `SELECT mood, created_at FROM check_ins
     WHERE patient_id = $1
     ORDER BY created_at DESC LIMIT 2`,
    [pt.patient_id]
  );
  if (rows.length < 2) return null;
  const drop = rows[1].mood - rows[0].mood;
  if (drop >= MOOD_DROP_THRESHOLD) {
    return {
      type: 'mood_drop',
      severity: 'warning',
      message: (pt.patient_name || 'Paciente') + ': ánimo bajó ' + drop + ' puntos (de ' + rows[1].mood + ' a ' + rows[0].mood + '/10)',
      data: { previous: rows[1].mood, current: rows[0].mood, drop, date: rows[0].created_at },
    };
  }
  return null;
}

async function checkNoCheckin(pool, pt) {
  const { rows } = await pool.query(
    `SELECT created_at FROM check_ins
     WHERE patient_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [pt.patient_id]
  );
  if (rows.length === 0) return null;
  const lastDate = new Date(rows[0].created_at);
  const daysSince = (Date.now() - lastDate.getTime()) / 86400000;
  if (daysSince >= NO_CHECKIN_DAYS) {
    return {
      type: 'no_checkin',
      severity: 'warning',
      message: (pt.patient_name || 'Paciente') + ': ' + Math.floor(daysSince) + ' días sin registrar check-in',
      data: { lastCheckin: rows[0].created_at, daysSince: Math.floor(daysSince) },
    };
  }
  return null;
}

async function checkAnxietySpike(pool, pt) {
  const { rows } = await pool.query(
    `SELECT anxiety, created_at FROM check_ins
     WHERE patient_id = $1
     ORDER BY created_at DESC LIMIT 2`,
    [pt.patient_id]
  );
  if (rows.length < 2) return null;
  if (rows[0].anxiety >= ANXIETY_HIGH && rows[1].anxiety >= ANXIETY_HIGH) {
    return {
      type: 'anxiety_spike',
      severity: 'warning',
      message: (pt.patient_name || 'Paciente') + ': ansiedad elevada ≥8/10 en los últimos 2 check-ins (' + rows[0].anxiety + ' y ' + rows[1].anxiety + '/10)',
      data: { latest: rows[0].anxiety, previous: rows[1].anxiety },
    };
  }
  return null;
}

async function checkAssignmentOverdue(pool, pt) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM assignments
     WHERE patient_id = $1
       AND status = 'assigned'
       AND due_date IS NOT NULL
       AND due_date < NOW() - INTERVAL '1 day'`,
    [pt.patient_id]
  );
  if (rows[0].count > 0) {
    return {
      type: 'assignment_overdue',
      severity: 'info',
      message: (pt.patient_name || 'Paciente') + ': ' + rows[0].count + ' tarea(s) vencida(s) sin completar',
      data: { overdueCount: rows[0].count },
    };
  }
  return null;
}

async function checkQ09Flagged(pool, pt) {
  const { rows } = await pool.query(
    `SELECT es.id, es.completed_at, a.exercise_kind
     FROM exercise_sessions es
     JOIN assignments a ON a.id = es.assignment_id
     WHERE a.patient_id = $1
       AND a.exercise_kind IN ('phq9', 'bdiii')
       AND es.is_complete = TRUE
       AND es.responses IS NOT NULL
     ORDER BY es.completed_at DESC LIMIT 1`,
    [pt.patient_id]
  );
  if (rows.length === 0) return null;

  try {
    const responses = typeof rows[0].responses === 'string'
      ? JSON.parse(rows[0].responses) : rows[0].responses;
    const q09 = responses.q09;
    const isFlagged = (rows[0].exercise_kind === 'phq9' && q09 >= 1) ||
                      (rows[0].exercise_kind === 'bdiii' && q09 >= 2);
    if (!isFlagged) return null;

    // Solo alertar una vez por sesión
    const { rows: existing } = await pool.query(
      `SELECT id FROM clinical_alerts
       WHERE patient_id = $1 AND alert_type = 'q09_flagged'
         AND data->>'session_id' = $2`,
      [pt.patient_id, rows[0].id]
    );
    if (existing.length > 0) return null;

    const scaleName = rows[0].exercise_kind === 'phq9' ? 'PHQ-9' : 'BDI-II';
    return {
      type: 'q09_flagged',
      severity: 'critical',
      message: '⚠️ URGENTE: ' + (pt.patient_name || 'Paciente') + ' reportó pensamientos de autolesión en ' + scaleName + ' (puntuación Q09: ' + q09 + ')',
      data: { session_id: rows[0].id, q09_value: q09, scale: rows[0].exercise_kind, completed_at: rows[0].completed_at },
    };
  } catch (e) {
    return null;
  }
}

// ─── Alert creation with dedup ────────────────────────────────────────

async function createAlert(pool, pt, alertDef) {
  // Dedup: misma alerta para el mismo paciente en la ventana de supresión
  const { rows: existing } = await pool.query(
    `SELECT id FROM clinical_alerts
     WHERE patient_id = $1 AND alert_type = $2 AND is_read = FALSE
       AND created_at > NOW() - make_interval(hours => $3)
     LIMIT 1`,
    [pt.patient_id, alertDef.type, DEDUP_WINDOW_HOURS]
  );
  if (existing.length > 0) return null;

  const id = uuidv4();
  try {
    await pool.query(
      `INSERT INTO clinical_alerts (id, therapist_id, patient_id, alert_type, severity, message, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, pt.therapist_id, pt.patient_id, alertDef.type, alertDef.severity,
       alertDef.message, JSON.stringify(alertDef.data || {})]
    );

    // Emitir al terapeuta via SSE
    bus.publish(
      bus.topicFor('therapist', pt.therapist_id),
      'alert:new',
      {
        id, patientId: pt.patient_id, alertType: alertDef.type,
        severity: alertDef.severity, message: alertDef.message,
      }
    );

    return id;
  } catch (err) {
    // 23505 = unique violation (concurrent dedup); ignorar silenciosamente
    if (err.code !== '23505') {
      logger.warn('Error creando alerta clínica', { error: err.message, patientId: pt.patient_id });
    }
    return null;
  }
}

/**
 * Obtiene las alertas no leídas para un terapeuta.
 */
async function getAlerts(pool, therapistId, opts = {}) {
  const status = opts.status || 'active';
  let where = 'ca.therapist_id = $1';
  const params = [therapistId];

  if (status === 'unread') {
    where += ' AND ca.is_read = FALSE';
  } else if (status === 'active') {
    where += " AND ca.status <> 'resolved'";
  } else if (['open', 'acknowledged', 'resolved'].includes(status)) {
    params.push(status);
    where += ' AND ca.status = $' + params.length;
  }

  const { rows } = await pool.query(
    `SELECT ca.id, ca.patient_id, p.name as patient_name, ca.alert_type,
            ca.severity, ca.message, ca.data, ca.status, ca.is_read,
            ca.acknowledged_at, ca.resolved_at, ca.resolution_note, ca.created_at
     FROM clinical_alerts ca
     JOIN patients p ON p.id = ca.patient_id
     WHERE ${where}
     ORDER BY ca.severity = 'critical' DESC, ca.status = 'open' DESC, ca.created_at DESC
     LIMIT 20`,
    params
  );
  return rows;
}

async function getUnreadAlerts(pool, therapistId) {
  return getAlerts(pool, therapistId, { status: 'unread' });
}

/**
 * Marca alertas como leídas.
 */
async function markAlertsRead(pool, therapistId, alertIds) {
  if (!alertIds || !alertIds.length) return;
  await pool.query(
    `UPDATE clinical_alerts
        SET is_read = TRUE,
            status = CASE WHEN status = 'open' THEN 'acknowledged' ELSE status END,
            acknowledged_at = COALESCE(acknowledged_at, NOW())
     WHERE therapist_id = $1 AND id = ANY($2::uuid[])`,
    [therapistId, alertIds]
  );
}

async function updateAlertStatus(pool, therapistId, alertIds, status, note = null) {
  if (!alertIds || !alertIds.length) return;
  if (!['open', 'acknowledged', 'resolved'].includes(status)) {
    throw new Error('Estado de alerta invalido');
  }

  const isResolved = status === 'resolved';
  await pool.query(
    `UPDATE clinical_alerts
        SET status = $3,
            is_read = CASE WHEN $3 IN ('acknowledged', 'resolved') THEN TRUE ELSE is_read END,
            acknowledged_at = CASE
              WHEN $3 IN ('acknowledged', 'resolved') THEN COALESCE(acknowledged_at, NOW())
              ELSE acknowledged_at
            END,
            resolved_at = CASE WHEN $3 = 'resolved' THEN COALESCE(resolved_at, NOW()) ELSE NULL END,
            resolution_note = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE resolution_note END
      WHERE therapist_id = $1 AND id = ANY($2::uuid[])`,
    [therapistId, alertIds, status, isResolved ? note : null]
  );
}

module.exports = {
  evaluateAllAlerts,
  getAlerts,
  getUnreadAlerts,
  markAlertsRead,
  updateAlertStatus,
};
