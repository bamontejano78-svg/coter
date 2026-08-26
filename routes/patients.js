const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getPool, withTransaction } = require('../database');
const { encrypt, decryptCheckIns, decryptMessages, decryptAssignments, decryptClinicalNotes, decryptClinicalSessions } = require('../utils/encryption');
// checkTaskReminders fue eliminado: los recordatorios ahora los genera el cron
// job utils/taskScheduler.runTick → runAllPendingReminders en background.
// Mantener este GET como endpoint idempotente (REST): solo lee.
const { authenticatePatient } = require('../middleware/auth');
const { audit, auditAccess, auditChange } = require('../utils/audit');
const logger = require('../config/logger');
const bus = require('../utils/eventBus');
const { setPatientCookie, clearPatientCookie } = require('../utils/cookies');
const fcm = require('../utils/fcm');
const { getSchema, validateResponses } = require('../utils/exerciseSchemas');
const { encryptFieldsForKind, decryptFieldsForKind } = require('../utils/exerciseEncryption');
// Helpers compartidos con routes/therapist.js para resolver schema y mergear
// la fila exercise_sessions (responses + encrypted_blob) en respuestas planas.
const { schemaForAssignment, decodeSessionResponses, fetchLatestSessionsForAssignments } = require('../utils/exerciseHelpers');

const router = express.Router();

// ─── CONEXION (codigo) ───────────────────────────────────────
router.post('/connect', async (req, res) => {
  try {
    const { connection_code } = req.body;
    if (!connection_code) return res.status(400).json({ error: 'Codigo de conexion requerido' });

    const patientId = uuidv4();
    const authToken = uuidv4(); // Token de autenticación para el paciente
    let codeData;

    await withTransaction(async (client) => {
      // Bloquear el código durante el canje evita que dos solicitudes
      // concurrentes superen max_uses.
      const { rows: codeRows } = await client.query(
        `SELECT cc.*, t.name as therapist_name, t.specialty, cc.patient_name
           FROM connection_codes cc
           JOIN therapists t ON cc.therapist_id = t.id
          WHERE cc.code = $1 AND cc.is_active = TRUE
            AND cc.uses < cc.max_uses AND cc.expires_at > NOW()
          FOR UPDATE`,
        [connection_code]
      );
      if (codeRows.length === 0) {
        const invalidCode = new Error('Codigo invalido o expirado');
        invalidCode.code = 'CONNECTION_CODE_INVALID';
        throw invalidCode;
      }

      codeData = codeRows[0];
      const resolvedPatientName = codeData.patient_name || null;
      const insertSql = resolvedPatientName
        ? "INSERT INTO patients (id, name, status, auth_token) VALUES ($1, $2, 'active', $3)"
        : "INSERT INTO patients (id, status, auth_token) VALUES ($1, 'active', $2)";
      const insertParams = resolvedPatientName
        ? [patientId, resolvedPatientName, authToken]
        : [patientId, authToken];
      await client.query(insertSql, insertParams);

      await client.query(
        'INSERT INTO therapist_patients (id, therapist_id, patient_id, connection_code) VALUES ($1, $2, $3, $4)',
        [uuidv4(), codeData.therapist_id, patientId, connection_code]
      );
      await client.query('UPDATE connection_codes SET uses = uses + 1 WHERE id = $1', [codeData.id]);
    });

    const resolvedPatientName = codeData.patient_name || null;

    audit({ who: patientId, role: 'patient', action: 'connect', resource: 'patient', resourceId: patientId, ip: req.ip, metadata: { therapistId: codeData.therapist_id, code: connection_code } });

    // Notificar al terapeuta que un paciente nuevo acaba de canjear el código.
    // Si tiene el dashboard abierto, verá aparecer el paciente en su lista
    // sin necesidad de recargar.
    bus.publish(bus.topicFor('therapist', codeData.therapist_id), 'patient:connected', {
      patientId, patientName: resolvedPatientName, at: new Date().toISOString(),
    });

    setPatientCookie(res, authToken);
    res.json({
      success: true,
      patient_id: patientId,
      auth_token: authToken,
      therapist: { id: codeData.therapist_id, name: codeData.therapist_name, specialty: codeData.specialty },
      connection_code,
      connected_at: new Date().toISOString(),
    });
  } catch (err) {
    if (err.code === 'CONNECTION_CODE_INVALID') {
      return res.status(400).json({ error: err.message });
    }
    logger.error('Error conectando paciente', { error: err.message });
    res.status(500).json({ error: 'Error al conectar' });
  }
});

router.post('/:patientId/logout', authenticatePatient, async (_req, res) => {
  clearPatientCookie(res);
  res.json({ success: true });
});

// ─── Middleware de auth para todas las rutas con :patientId ────
router.use('/:patientId', authenticatePatient);

// ─── CHECK-INS ───────────────────────────────────────────────
router.post('/:patientId/check-ins', async (req, res) => {
  try {
    const { patientId } = req.params;
    const { mood, anxiety, energy, thoughts, sleep_hours, sleep_quality, emotions } = req.body;
    if (mood === undefined || mood === null || anxiety === undefined || anxiety === null) {
      return res.status(400).json({ error: 'Mood y anxiety requeridos' });
    }
    const normalizedMood = Number(mood);
    const normalizedAnxiety = Number(anxiety);
    const normalizedEnergy = energy === undefined || energy === null ? 5 : Number(energy);
    const normalizedSleepHours = sleep_hours === undefined || sleep_hours === null || sleep_hours === '' ? null : Number(sleep_hours);
    const normalizedSleepQuality = sleep_quality === undefined || sleep_quality === null || sleep_quality === '' ? null : Number(sleep_quality);
    if (![normalizedMood, normalizedAnxiety, normalizedEnergy].every(v => Number.isInteger(v) && v >= 1 && v <= 10)) {
      return res.status(400).json({ error: 'Los valores deben estar entre 1 y 10' });
    }
    if (normalizedSleepHours !== null && (!Number.isFinite(normalizedSleepHours) || normalizedSleepHours < 0 || normalizedSleepHours > 24)) {
      return res.status(400).json({ error: 'Las horas de sueño no son válidas' });
    }
    if (normalizedSleepQuality !== null && (!Number.isInteger(normalizedSleepQuality) || normalizedSleepQuality < 1 || normalizedSleepQuality > 10)) {
      return res.status(400).json({ error: 'La calidad del sueño debe estar entre 1 y 10' });
    }
    const normalizedEmotions = Array.isArray(emotions) ? emotions.filter(e => typeof e === 'string').slice(0, 8) : [];

    const pool = getPool();
    const { rows: recentRows } = await pool.query(
      `SELECT id FROM check_ins
        WHERE patient_id = $1 AND created_at >= NOW() - INTERVAL '10 minutes'
          AND mood = $2 AND anxiety = $3 AND energy = $4
          AND COALESCE(sleep_hours, -1) = COALESCE($5::numeric, -1)
          AND COALESCE(sleep_quality, -1) = COALESCE($6::integer, -1)
        ORDER BY created_at DESC LIMIT 1`,
      [patientId, normalizedMood, normalizedAnxiety, normalizedEnergy, normalizedSleepHours, normalizedSleepQuality]
    );
    if (recentRows.length > 0) {
      return res.json({ success: true, duplicate: true, check_in_id: recentRows[0].id, message: 'Este check-in ya estaba guardado' });
    }
    const { rows: connRows } = await pool.query(
      "SELECT therapist_id FROM therapist_patients WHERE patient_id = $1 AND status = 'active'",
      [patientId]
    );
    const therapistId = connRows.length > 0 ? connRows[0].therapist_id : null;
    const id = uuidv4();
    await pool.query(
      'INSERT INTO check_ins (id, patient_id, mood, anxiety, energy, thoughts, sleep_hours, sleep_quality, emotions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [id, patientId, normalizedMood, normalizedAnxiety, normalizedEnergy, encrypt(thoughts || ''), normalizedSleepHours, normalizedSleepQuality, encrypt(JSON.stringify(normalizedEmotions))]
    );
    audit({ who: patientId, role: 'patient', action: 'create_checkin', resource: 'check_in', resourceId: id, ip: req.ip, metadata: { mood: normalizedMood, anxiety: normalizedAnxiety, energy: normalizedEnergy, sleep_quality: normalizedSleepQuality } });

    if (therapistId) {
      bus.publish(bus.topicFor('therapist', therapistId), 'checkin:new', {
        patientId, checkInId: id, mood: normalizedMood, anxiety: normalizedAnxiety, energy: normalizedEnergy,
      });
    }

    res.json({ success: true, check_in_id: id, message: 'Check-in guardado' });
  } catch (err) {
    logger.error('Error guardando check-in', { error: err.message });
    res.status(500).json({ error: 'Error al guardar' });
  }
});

router.get('/:patientId/check-ins', async (req, res) => {
  try {
    const { patientId } = req.params;
    const pool = getPool();
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const offset = parseInt(req.query.offset) || 0;

    const { rows } = await pool.query(
      'SELECT * FROM check_ins WHERE patient_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [patientId, limit, offset]
    );

    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*) as total FROM check_ins WHERE patient_id = $1',
      [patientId]
    );

    res.json({ success: true, check_ins: decryptCheckIns(rows), pagination: { limit, offset, total: parseInt(countRows[0].total) } });
  } catch (err) {
    logger.error('Error cargando check-ins', { error: err.message });
    res.status(500).json({ error: 'Error al cargar' });
  }
});

// ─── MENSAJES ────────────────────────────────────────────────
router.get('/:patientId/messages', async (req, res) => {
  try {
    const { patientId } = req.params;
    const pool = getPool();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const { rows } = await pool.query(
      'SELECT * FROM messages WHERE patient_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [patientId, limit, offset]
    );

    const { rows: unreadRows } = await pool.query(
      'SELECT COUNT(*)::int AS unread FROM messages WHERE patient_id = $1 AND is_therapist = TRUE AND COALESCE(read, FALSE) = FALSE',
      [patientId]
    );
    await pool.query(
      'UPDATE messages SET read = TRUE WHERE patient_id = $1 AND is_therapist = TRUE AND COALESCE(read, FALSE) = FALSE',
      [patientId]
    );

    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*) as total FROM messages WHERE patient_id = $1',
      [patientId]
    );

    res.json({ success: true, messages: decryptMessages(rows), unread_count: 0, newly_read_count: unreadRows[0].unread, pagination: { limit, offset, total: parseInt(countRows[0].total) } });
  } catch (err) {
    logger.error('Error cargando mensajes', { error: err.message });
    res.status(500).json({ error: 'Error al cargar' });
  }
});

router.post('/:patientId/messages', async (req, res) => {
  try {
    const { patientId } = req.params;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensaje requerido' });

    const pool = getPool();
    const { rows: connRows } = await pool.query(
      "SELECT therapist_id FROM therapist_patients WHERE patient_id = $1 AND status = 'active'",
      [patientId]
    );
    if (connRows.length === 0) return res.status(400).json({ error: 'Paciente no conectado' });

    const therapistId = connRows[0].therapist_id;
    const messageId = uuidv4();
    await pool.query(
      'INSERT INTO messages (id, therapist_id, patient_id, message, is_therapist) VALUES ($1, $2, $3, $4, FALSE)',
      [messageId, therapistId, patientId, encrypt(message)]
    );
    audit({ who: patientId, role: 'patient', action: 'send_message', resource: 'message', resourceId: messageId, ip: req.ip });

    // Publicar al terapeuta (para el modal abierto o la lista activa) y al
    // propio paciente (multipestaña).
    bus.publish(bus.topicFor('therapist', therapistId), 'message:new', {
      patientId, messageId, from: 'patient',
    });
    bus.publish(bus.topicFor('patient', patientId), 'message:new', {
      patientId, messageId, from: 'patient',
    });

    // Push notification nativa (FCM) al terapeuta — best-effort.
    // No enviar texto clinico al sistema operativo/lock screen.
    fcm.sendToTherapist(therapistId, {
      title: 'Nuevo mensaje de tu paciente',
      body: 'Abre Coter Pro para leerlo de forma segura.',
    }).catch(err => logger.warn('[Push] Error enviando push al terapeuta', { error: err.message, therapistId }));

    res.json({ success: true, message_id: messageId, message: 'Mensaje enviado' });
  } catch (err) {
    logger.error('Error enviando mensaje', { error: err.message });
    res.status(500).json({ error: 'Error al enviar' });
  }
});

// ─── TAREAS ──────────────────────────────────────────────────
router.get('/:patientId/assignments', async (req, res) => {
  try {
    const { patientId } = req.params;
    const pool = getPool();
    const status = String(req.query.status || 'assigned').toLowerCase();
    const statusFilter = status === 'all' ? '' : " AND status = 'assigned'";
    const { rows } = await pool.query(
      `SELECT * FROM assignments WHERE patient_id = $1${statusFilter} ORDER BY CASE WHEN status = 'assigned' THEN 0 ELSE 1 END, due_date ASC NULLS LAST, created_at DESC`,
      [patientId]
    );
    const decrypted = decryptAssignments(rows);

    // Enriquecemos con latest_session para que el frontend pueda pintar
    // el formulario con el último estado guardado sin tener que hacer
    // una segunda request a una ruta específica. classic siempre es null
    // (no se permite /start para esos). Para kind clínico con sesión en
    // curso, devolvemos id + is_complete + responses merged (decrypted).
    //
    // También pre-resolvemos `exercise_schema` server-side, llamando a
    // getSchema(kind, dbSchema, {mode,phobia}) para garantizar que el cliente
    // recibe el schema efectivo (incluye variantes como BA diary vs schedule
    // o GE agoraphobia vs claustrophobia). Si el caller no trae variant info
    // (assignment.exercise_schema NULL y sin discriminante), la BD seed ya
    // trae un schema completo, pero defendemos con fallback al estático.
    const latestByAssignment = await fetchLatestSessionsForAssignments(pool, patientId, decrypted);
    const enriched = decrypted.map(a => {
      const resolvedSchema = schemaForAssignment(a) || a.exercise_schema || null;
      const sess = latestByAssignment.get(a.id);
      if (!sess) return { ...a, exercise_schema: resolvedSchema, latest_session: null };
      return {
        ...a,
        exercise_schema: resolvedSchema,
        latest_session: {
          id: sess.id,
          exercise_kind: sess.exercise_kind,
          is_complete: sess.is_complete,
          started_at: sess.started_at,
          updated_at: sess.updated_at,
          completed_at: sess.completed_at,
          // NO devolvemos encrypted_blob al frontend (es ciphertext opaco);
          // se devuelve responses merged (no sensibles + sensibles descifrados)
          // para que el formulario hidrate sus inputs sin segundo round-trip.
          responses: decodeSessionResponses(sess, a),
        },
      };
    });

    res.json({ success: true, assignments: enriched });
  } catch (err) {
    logger.error('Error cargando tareas', { error: err.message });
    res.status(500).json({ error: 'Error al cargar' });
  }
});

router.put('/:patientId/assignments/:assignmentId', async (req, res) => {
  try {
    const { patientId, assignmentId } = req.params;
    const pool = getPool();
    const { rows: connRows } = await pool.query(
      "SELECT therapist_id FROM therapist_patients WHERE patient_id = $1 AND status = 'active'",
      [patientId]
    );
    const completion = await pool.query(
      "UPDATE assignments SET status = 'completed', completed_at = NOW() WHERE id = $1 AND patient_id = $2 AND status = 'assigned'",
      [assignmentId, patientId]
    );
    if (completion.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Tarea no encontrada o ya completada' });
    }
    if (connRows.length > 0) {
      bus.publish(bus.topicFor('therapist', connRows[0].therapist_id), 'task:completed', {
        patientId, assignmentId,
      });
    }
    res.json({ success: true, message: 'Tarea completada' });
  } catch (err) {
    logger.error('Error completando tarea', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── OBJETIVOS ───────────────────────────────────────────────
router.get('/:patientId/goals', async (req, res) => {
  try {
    const { patientId } = req.params;
    const { rows } = await getPool().query(
      'SELECT * FROM goals WHERE patient_id = $1 ORDER BY created_at DESC',
      [patientId]
    );
    res.json({ success: true, goals: rows });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ─── PROGRESO ────────────────────────────────────────────────
router.get('/:patientId/progress', async (req, res) => {
  try {
    const { patientId } = req.params;
    const pool = getPool();

    const { rows: recentCheckIns } = await pool.query(
      "SELECT * FROM check_ins WHERE patient_id = $1 AND created_at >= NOW() - INTERVAL '28 days' ORDER BY created_at DESC",
      [patientId]
    );
    const decrypted = decryptCheckIns(recentCheckIns);

    const { rows: totalRow } = await pool.query(
      'SELECT COUNT(*) as count FROM check_ins WHERE patient_id = $1',
      [patientId]
    );
    const totalCheckins = parseInt(totalRow[0].count);

    const { rows: allCheckinDates } = await pool.query(
      'SELECT created_at FROM check_ins WHERE patient_id = $1 ORDER BY created_at ASC',
      [patientId]
    );
    const streakDays = calcStreak(allCheckinDates);

    // Tendencias semanales
    const weeklyTrends = [];
    const now = new Date();
    for (let w = 0; w < 4; w++) {
      const weekEnd = new Date(now);
      weekEnd.setDate(weekEnd.getDate() - w * 7);
      const weekStart = new Date(now);
      weekStart.setDate(weekStart.getDate() - (w + 1) * 7);
      const weekCheckins = decrypted.filter(c => {
        const d = new Date(c.created_at);
        return d >= weekStart && d < weekEnd;
      });
      if (weekCheckins.length > 0) {
        weeklyTrends.unshift({
          week: w === 0 ? 'Esta semana' : 'Semana -' + w,
          avg_mood: +(weekCheckins.reduce((s, c) => s + c.mood, 0) / weekCheckins.length).toFixed(1),
          avg_anxiety: +(weekCheckins.reduce((s, c) => s + c.anxiety, 0) / weekCheckins.length).toFixed(1),
          avg_energy: +(weekCheckins.reduce((s, c) => s + (c.energy || 5), 0) / weekCheckins.length).toFixed(1),
          count: weekCheckins.length,
        });
      }
    }

    const { rows: allAssignments } = await pool.query('SELECT * FROM assignments WHERE patient_id = $1', [patientId]);
    const totalTasks = allAssignments.length;
    const completedTasks = allAssignments.filter(a => a.status === 'completed').length;

    const { rows: allGoals } = await pool.query('SELECT * FROM goals WHERE patient_id = $1', [patientId]);
    const totalGoals = allGoals.length;
    const completedGoals = allGoals.filter(g => g.status === 'completed').length;
    const activeGoals = allGoals.filter(g => g.status === 'active');

    const { rows: latestNoteRows } = await pool.query(
      'SELECT subjective, assessment, created_at FROM clinical_notes WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1',
      [patientId]
    );
    const latestNotes = decryptClinicalNotes(latestNoteRows);
    const text = latestNotes.length > 0 ? (latestNotes[0].assessment || latestNotes[0].subjective || '') : '';
    const latestNote = latestNoteRows.length > 0 ? {
      excerpt: text.length > 200 ? text.substring(0, 200).replace(/\s+\S*$/, '') + '...' : text,
      date: latestNotes[0].created_at,
    } : null;

    const { rows: noteCountRow } = await pool.query(
      'SELECT COUNT(*) as count FROM clinical_notes WHERE patient_id = $1',
      [patientId]
    );
    const totalNotes = parseInt(noteCountRow[0].count);

    // Timeline
    const timeline = [];
    decrypted.slice(0, 5).forEach(c => {
      timeline.push({ type: 'checkin', date: c.created_at, summary: 'Animo ' + c.mood + '/10 - Ansiedad ' + c.anxiety + '/10' });
    });
    allAssignments.filter(a => a.status === 'completed' && a.completed_at).slice(0, 3).forEach(a => {
      timeline.push({ type: 'task_done', date: a.completed_at, summary: 'Completaste "' + a.title + '"' });
    });
    allGoals.filter(g => g.status === 'completed').slice(0, 3).forEach(g => {
      timeline.push({ type: 'goal_done', date: g.created_at, summary: 'Objetivo: "' + g.title + '"' });
    });
    timeline.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({
      success: true,
      progress: {
        achievements: { streakDays, totalCheckins, completedTasks, totalTasks, completedGoals, totalGoals },
        weeklyTrends,
        activeGoals,
        latestNote,
        totalNotes,
        timeline: timeline.slice(0, 10),
      },
    });
  } catch (err) {
    logger.error('Error progreso', { error: err.message });
    res.status(500).json({ success: false });
  }
});

function calcStreak(checkIns) {
  let streak = 0;
  if (!checkIns || !checkIns.length) return 0;
  const sorted = [...checkIns].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = 0; i < sorted.length; i++) {
    const d = new Date(sorted[i].created_at); d.setHours(0, 0, 0, 0);
    const exp = new Date(today); exp.setDate(exp.getDate() - streak);
    if (d.getTime() === exp.getTime()) streak++;
    else if (d.getTime() < exp.getTime()) break;
  }
  return streak;
}

// ─── PUSH TOKENS (FCM) ──────────────────────────────────────
// Registra el token FCM del dispositivo para recibir push notifications.
// Llamado por CoterPush.init() en el frontend tras obtener el token de Firebase.
router.post('/:patientId/push-token', async (req, res) => {
  try {
    const { patientId } = req.params;
    const { token, platform } = req.body || {};

    if (!token) return res.status(400).json({ error: 'token requerido' });

    const pool = getPool();
    await pool.query(
      `INSERT INTO push_tokens (patient_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (COALESCE(patient_id::text, therapist_id::text), token)
       DO UPDATE SET platform = $3, updated_at = NOW()`,
      [patientId, token, platform || 'android']
    );

    logger.info('[Push] Token FCM registrado', { patientId, platform: platform || 'android' });
    res.json({ success: true, message: 'Token registrado' });
  } catch (err) {
    logger.error('[Push] Error registrando token FCM', { error: err.message });
    res.status(500).json({ error: 'Error al registrar token' });
  }
});

// ─── NOTIFICACIONES ──────────────────────────────────────────
router.get('/:patientId/notifications', async (req, res) => {
  try {
    const { patientId } = req.params;
    const pool = getPool();
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const offset = parseInt(req.query.offset) || 0;

    const { rows } = await pool.query(
      'SELECT * FROM notifications WHERE patient_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [patientId, limit, offset]
    );

    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*) as total FROM notifications WHERE patient_id = $1',
      [patientId]
    );
    const { rows: unreadRows } = await pool.query(
      'SELECT COUNT(*)::int AS unread FROM notifications WHERE patient_id = $1 AND is_read = FALSE',
      [patientId]
    );

    res.json({ success: true, notifications: rows, unread_count: unreadRows[0].unread, pagination: { limit, offset, total: parseInt(countRows[0].total) } });
  } catch (err) {
    logger.error('Error notificaciones', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.put('/:patientId/notifications/read-all', async (req, res) => {
  try {
    const { patientId } = req.params;
    await getPool().query(
      'UPDATE notifications SET is_read = TRUE WHERE patient_id = $1 AND is_read = FALSE',
      [patientId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

router.put('/:patientId/notifications/:notificationId/read', async (req, res) => {
  try {
    const { patientId, notificationId } = req.params;
    await getPool().query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND patient_id = $2',
      [notificationId, patientId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ══════════════════════════════════════════════════════════════════
// SESIONES DE EJERCICIOS CLÍNICOS EMBEBIDOS (migration 007)
// ══════════════════════════════════════════════════════════════════
//
// Estas rutas SOLO aplican a assignments con exercise_kind clínico
// (thought_record / behavioral_activation / graded_exposure). El flujo
// clásico (solo instrucciones + Marcar completada) sigue usando el
// PUT /:patientId/assignments/:assignmentId legacy de arriba.
//
// Ciclo de vida de una sesión:
//
//   POST /sessions/start
//     Crea fila exercise_sessions (id, assignment_id, patient_id,
//     exercise_kind, responses='{}', is_complete=false). El terapeuta
//     recibe un evento bus 'exercise:progress' con status='started'
//     para que su dashboard pueda flairar "en curso".
//
//   PUT  /sessions/:sid  (autosave)
//
//     Recibe `responses` plano. Valida tipos pero NO required: el
//     paciente va guardando parcial. Encripta campos sensitive (AES-256-
//     GCM via utils/exerciseEncryption), escribe responses={no sensibles}
//     JSONB y encrypted_blob=ciphertext. Emite 'exercise:progress' al
//     terapeuta con status='autosaved'. Idempotente: N PUTs consecutivos
//     solo dejan el último.
//
//   POST /sessions/:sid/complete
//
//     Validación ESTRICTA (required en cada field según el schema).
//     Devuelve 422 con errors[] si falta algo. Si todo OK:
//       - UPDATE exercise_sessions SET is_complete=true, completed_at=NOW()
//       - UPDATE assignments SET status='completed', completed_at=NOW()
//       - bus.publish 'exercise:completed' (terapeuta + paciente)
//     Tras completarlo, el legacy PUT /assignments/:id queda RESUELTO
//     por la fila assignment.status='completed' (no-op si el paciente
//     intenta re-completar).
//
// Decisión sobre el linkage a therapist:
//   El middleware authenticatePatient ya garantiza que el token corresponde
//   al :patientId del path. Para emitir eventos al terapeuta correcto,
//   resolvemos therapist_patients.status='active' (paciente debe estar
//   conectado). Si el paciente se desconectó tras la sesión, el evento
//   se pierde (SSE no durable storage; el terapeuta verá el estado al
//   cargar el dashboard con la próxima SSR/refresh).

router.post('/:patientId/sessions/start', async (req, res) => {
  try {
    const { patientId } = req.params;
    // `assignment_id` o `assignmentId` aceptamos para no romper clientes
    // que envíen el nombre en uno u otro estilo.
    const assignmentId = (req.body && (req.body.assignment_id || req.body.assignmentId)) || null;
    if (!assignmentId) return res.status(400).json({ error: 'assignment_id requerido' });

    const pool = getPool();
    const { rows: aRows } = await pool.query(
      `SELECT id, exercise_kind, exercise_schema, status, title
         FROM assignments
        WHERE id = $1 AND patient_id = $2`,
      [assignmentId, patientId]
    );
    if (aRows.length === 0) return res.status(404).json({ error: 'Tarea no encontrada' });
    const asg = aRows[0];
    // classic NO soporta sesiones interactivas: la ruta legacy PUT
    // /assignments/:id sigue siendo el camino correcto.
    if (!asg.exercise_kind || asg.exercise_kind === 'classic') {
      return res.status(400).json({ error: 'Esta tarea no es interactiva (kind: "classic")' });
    }
    if (asg.status !== 'assigned') {
      return res.status(400).json({ error: 'La tarea ya está finalizada' });
    }

    const sessionId = uuidv4();
    await pool.query(
      `INSERT INTO exercise_sessions (id, assignment_id, patient_id, exercise_kind, responses)
        VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
      [sessionId, assignmentId, patientId, asg.exercise_kind]
    );

    audit({ who: patientId, role: 'patient', action: 'start_exercise_session', resource: 'exercise_session', resourceId: sessionId, ip: req.ip, metadata: { assignmentId, exerciseKind: asg.exercise_kind } });

    // Notificar al terapeuta (no fatal si no hay vínculo activo).
    const { rows: connRows } = await pool.query(
      `SELECT therapist_id FROM therapist_patients WHERE patient_id = $1 AND status = 'active'`,
      [patientId]
    );
    if (connRows.length > 0) {
      bus.publish(bus.topicFor('therapist', connRows[0].therapist_id), 'exercise:progress', {
        patientId,
        assignmentId,
        sessionId,
        exerciseKind: asg.exercise_kind,
        status: 'started',
        at: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      session_id: sessionId,
      assignment_id: assignmentId,
      exercise_kind: asg.exercise_kind,
      exercise_schema: asg.exercise_schema,
      started_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Error iniciando sesión de ejercicio', { error: err.message });
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

router.put('/:patientId/sessions/:sid', async (req, res) => {
  try {
    const { patientId, sid } = req.params;
    const body = req.body || {};
    const responses = body.responses;

    if (!responses || typeof responses !== 'object' || Array.isArray(responses)) {
      return res.status(400).json({ error: 'responses debe ser un objeto plano' });
    }

    const pool = getPool();
    const { rows: sRows } = await pool.query(
      `SELECT s.id, s.assignment_id, s.patient_id, s.exercise_kind, s.is_complete,
              a.exercise_schema, a.id AS asg_id, a.status AS asg_status
         FROM exercise_sessions s
         JOIN assignments a ON a.id = s.assignment_id
        WHERE s.id = $1 AND s.patient_id = $2`,
      [sid, patientId]
    );
    if (sRows.length === 0) return res.status(404).json({ error: 'Sesión no encontrada' });
    const sess = sRows[0];
    if (sess.is_complete) return res.status(400).json({ error: 'La sesión ya está finalizada' });
    if (sess.asg_status !== 'assigned') {
      // Puede haber quedado completed por un /complete race; defensivo.
      return res.status(400).json({ error: 'La tarea ya no se puede modificar' });
    }

    const schema = schemaForAssignment(sess);
    if (!schema) return res.status(500).json({ error: 'schema no encontrado para esta sesión' });

    // encryptFieldsForKind siempre strippea campos sensibles del responses.
    // Si el paciente envia respuestas vacías para los sensitive, igualmente
    // quedan fuera del JSONB. Esto reduce ruido y uniforma el contrato.
    const { responses: cleaned, encrypted_blob } = encryptFieldsForKind(responses, schema);

    await pool.query(
      `UPDATE exercise_sessions
          SET responses = $1::jsonb, encrypted_blob = $2
        WHERE id = $3`,
      [JSON.stringify(cleaned), encrypted_blob, sid]
    );

    audit({ who: patientId, role: 'patient', action: 'autosave_exercise_session', resource: 'exercise_session', resourceId: sid, ip: req.ip, metadata: { assignmentId: sess.assignment_id, exerciseKind: sess.exercise_kind, hasBlob: !!encrypted_blob } });

    // Terapeuta: evento "progreso". No bloqueante si no hay vínculo.
    const { rows: connRows } = await pool.query(
      `SELECT therapist_id FROM therapist_patients WHERE patient_id = $1 AND status = 'active'`,
      [patientId]
    );
    if (connRows.length > 0) {
      bus.publish(bus.topicFor('therapist', connRows[0].therapist_id), 'exercise:progress', {
        patientId,
        assignmentId: sess.assignment_id,
        sessionId: sid,
        exerciseKind: sess.exercise_kind,
        status: 'autosaved',
        at: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      session_id: sid,
      saved_at: new Date().toISOString(),
      has_encrypted_blob: !!encrypted_blob,
    });
  } catch (err) {
    logger.error('Error autosave sesión de ejercicio', { error: err.message });
    res.status(500).json({ error: 'Error al guardar' });
  }
});

router.post('/:patientId/sessions/:sid/complete', async (req, res) => {
  try {
    const { patientId, sid } = req.params;

    const pool = getPool();
    const { rows: sRows } = await pool.query(
      `SELECT s.id, s.assignment_id, s.patient_id, s.exercise_kind, s.is_complete,
              s.responses, s.encrypted_blob,
              a.exercise_schema, a.status AS asg_status
         FROM exercise_sessions s
         JOIN assignments a ON a.id = s.assignment_id
        WHERE s.id = $1 AND s.patient_id = $2`,
      [sid, patientId]
    );
    if (sRows.length === 0) return res.status(404).json({ error: 'Sesión no encontrada' });
    const sess = sRows[0];
    if (sess.is_complete) return res.status(400).json({ error: 'La sesión ya está finalizada' });
    if (sess.asg_status !== 'assigned') {
      return res.status(400).json({ error: 'La tarea ya está finalizada' });
    }

    const schema = schemaForAssignment(sess);
    if (!schema) return res.status(500).json({ error: 'schema no encontrado para esta sesión' });

    // Validación ESTRICTA: cuando va a completar, todos los required:true
    // del schema deben estar presentes y válidos. Desencriptamos el blob
    // para validar la forma merged con sensibles incluidos.
    const merged = decryptFieldsForKind(sess.responses || {}, sess.encrypted_blob, schema);
    const validation = validateResponses(merged, schema);
    if (!validation.valid) {
      return res.status(422).json({
        error: 'Faltan campos requeridos o son inválidos',
        errors: validation.errors,
      });
    }

    const now = new Date();
    // ╭─ PHI invariant ──────────────────────────────────────────────────\n    // CRITICAL: we re-encode the merged form (sensitive + non-sensitive) so
    // the final stored layout respects the PHI contract: sensitives go to
    // encrypted_blob (AES-256-GCM ciphertext), non-sensitives go to the JSONB
    // responses column for queryable aggregation. Writing JSON.stringify(merged)
    // directly into `responses` would store sensitive PHI plaintext at rest,
    // defeating the whole purpose of encryptFieldsForKind. (Audited 2026-06.)
    // ────────────────────────────────────────────────────────────────────
    const reEncoded = encryptFieldsForKind(merged, schema);
    await withTransaction(async (client) => {
      const sessionResult = await client.query(
        `UPDATE exercise_sessions
            SET is_complete = TRUE, completed_at = NOW(),
                responses = $1::jsonb, encrypted_blob = $2
          WHERE id = $3 AND is_complete = FALSE`,
        [JSON.stringify(reEncoded.responses), reEncoded.encrypted_blob, sid]
      );
      if (sessionResult.rowCount !== 1) {
        const conflict = new Error('La sesión ya está finalizada');
        conflict.code = 'EXERCISE_COMPLETION_CONFLICT';
        throw conflict;
      }

      // Mantener session y assignment atómicos: nunca debe quedar una
      // sesión finalizada con la tarea todavía pendiente (o al revés).
      const assignmentResult = await client.query(
        `UPDATE assignments SET status = 'completed', completed_at = NOW()
          WHERE id = $1 AND status = 'assigned'`,
        [sess.assignment_id]
      );
      if (assignmentResult.rowCount !== 1) {
        const conflict = new Error('La tarea ya está finalizada');
        conflict.code = 'EXERCISE_COMPLETION_CONFLICT';
        throw conflict;
      }
    });

    audit({ who: patientId, role: 'patient', action: 'complete_exercise_session', resource: 'exercise_session', resourceId: sid, ip: req.ip, metadata: { assignmentId: sess.assignment_id, exerciseKind: sess.exercise_kind } });

    // Eventos bus:
    //  - 'exercise:completed' al terapeuta: el modal de paciente muestra
    //    el badge "completado" en tiempo real.
    //  - 'exercise:completed' al paciente: multipestaña / cierre de modal.
    //  - Mantenemos la firma task:completed para compatibilidad con handlers
    //    SSE viejos que aún estén escuchando ese canal.
    const completionPayload = {
      patientId,
      assignmentId: sess.assignment_id,
      sessionId: sid,
      exerciseKind: sess.exercise_kind,
      completedAt: now.toISOString(),
    };
    const { rows: connRows } = await pool.query(
      `SELECT therapist_id FROM therapist_patients WHERE patient_id = $1 AND status = 'active'`,
      [patientId]
    );
    if (connRows.length > 0) {
      bus.publish(bus.topicFor('therapist', connRows[0].therapist_id), 'exercise:completed', completionPayload);
      bus.publish(bus.topicFor('therapist', connRows[0].therapist_id), 'task:completed', {
        patientId,
        assignmentId: sess.assignment_id,
        via: 'interactive_exercise',
      });
    }
    bus.publish(bus.topicFor('patient', patientId), 'exercise:completed', completionPayload);

    res.json({
      success: true,
      message: 'Ejercicio completado',
      session_id: sid,
      assignment_id: sess.assignment_id,
      completed_at: now.toISOString(),
    });
  } catch (err) {
    if (err.code === 'EXERCISE_COMPLETION_CONFLICT') {
      return res.status(409).json({ error: err.message });
    }
    logger.error('Error completando sesión de ejercicio', { error: err.message });
    res.status(500).json({ error: 'Error al completar' });
  }
});

// ══════════════════════════════════════════════════════════════════
// WIDGET SESSIONS — Guardado de respuestas de widgets interactivos
// ══════════════════════════════════════════════════════════════════
//
// Flujo para widgets (mini-apps interactivas en templates classic):
//   POST /widget-complete
//     Crea una exercise_sessions con is_complete=true, responses = widget
//     data, y marca el assignment como completado en una sola llamada.
//     A diferencia de las sesiones clínicas (start → autosave → complete),
//     los widgets guardan todo al terminar (sin autosave intermedio).
//
// Body: { assignment_id, exercise_kind, widget_responses }
//   - assignment_id: UUID del assignment
//   - exercise_kind: string descriptivo (ej: 'widget_thought_record_lite')
//   - widget_responses: objeto plano con los datos del widget

router.post('/:patientId/widget-complete', async (req, res) => {
  try {
    const { patientId } = req.params;
    const { assignment_id, exercise_kind, widget_responses } = req.body || {};

    if (!assignment_id) return res.status(400).json({ error: 'assignment_id requerido' });
    if (!exercise_kind) return res.status(400).json({ error: 'exercise_kind requerido' });

    const pool = getPool();

    // Verificar que la tarea existe y pertenece al paciente
    const { rows: aRows } = await pool.query(
      `SELECT id, status, exercise_kind FROM assignments WHERE id = $1 AND patient_id = $2`,
      [assignment_id, patientId]
    );
    if (aRows.length === 0) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (aRows[0].status !== 'assigned') {
      return res.status(400).json({ error: 'La tarea ya está finalizada' });
    }
    // Los widgets son el flujo legacy de assignments classic. Las tareas
    // clínicas/estructuradas deben pasar por start → autosave → complete,
    // donde se valida el schema y los campos required.
    if (aRows[0].exercise_kind !== 'classic') {
      return res.status(400).json({ error: 'Los widgets solo aplican a tareas classic' });
    }

    const allowedWidgetKinds = new Set([
      'widget_thought_record_lite', 'widget_socratic_dialogue', 'widget_distortion_detective',
      'widget_ba_activity_diary', 'widget_ba_weekly_plan', 'widget_ba_pleasant_activities',
      'widget_exposure_hierarchy', 'widget_exposure_log', 'widget_interactive_grounding',
    ]);
    if (!allowedWidgetKinds.has(exercise_kind)) {
      return res.status(400).json({ error: 'exercise_kind de widget inválido' });
    }

    const sessionId = uuidv4();
    const responses = widget_responses && typeof widget_responses === 'object' && !Array.isArray(widget_responses)
      ? widget_responses
      : {};

    // Los widgets pueden contener texto clínico libre. No conocemos el
    // esquema interno de cada widget en esta ruta, así que ciframos el
    // payload completo y dejamos JSONB vacío para no persistir PHI en claro.
    // exerciseHelpers descifra el blob al mostrarlo al terapeuta.
    const encryptedWidgetBlob = encrypt(JSON.stringify(responses));

    // Crear sesión y marcar assignment como completado en una única
    // transacción. El filtro de estado evita completar dos veces por carrera.
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO exercise_sessions (id, assignment_id, patient_id, exercise_kind, responses, encrypted_blob, is_complete, completed_at)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, TRUE, NOW())`,
        [sessionId, assignment_id, patientId, exercise_kind, encryptedWidgetBlob]
      );
      const assignmentResult = await client.query(
        `UPDATE assignments SET status = 'completed', completed_at = NOW()
          WHERE id = $1 AND patient_id = $2 AND status = 'assigned'`,
        [assignment_id, patientId]
      );
      if (assignmentResult.rowCount !== 1) {
        const conflict = new Error('La tarea ya está finalizada');
        conflict.code = 'WIDGET_COMPLETION_CONFLICT';
        throw conflict;
      }
    });

    audit({ who: patientId, role: 'patient', action: 'complete_widget_session', resource: 'exercise_session', resourceId: sessionId, ip: req.ip, metadata: { assignmentId: assignment_id, exerciseKind: exercise_kind } });

    // Notificar al terapeuta
    const { rows: connRows } = await pool.query(
      `SELECT therapist_id FROM therapist_patients WHERE patient_id = $1 AND status = 'active'`,
      [patientId]
    );
    if (connRows.length > 0) {
      bus.publish(bus.topicFor('therapist', connRows[0].therapist_id), 'task:completed', {
        patientId, assignmentId: assignment_id,
      });
    }

    res.json({
      success: true,
      session_id: sessionId,
      assignment_id: assignment_id,
      exercise_kind: exercise_kind,
      completed_at: new Date().toISOString(),
      responses_encrypted: true,
    });
  } catch (err) {
    if (err.code === 'WIDGET_COMPLETION_CONFLICT') {
      return res.status(409).json({ error: err.message });
    }
    logger.error('Error completando widget session', { error: err.message });
    res.status(500).json({ error: 'Error al guardar el ejercicio' });
  }
});

// ─── EXPORTACIÓN DE DATOS (RGPD — derecho de portabilidad) ────
// Devuelve un JSON descargable con todos los datos del paciente.
// Los textos sensibles se descifran antes de entregarlos al titular.
router.get('/:patientId/export', async (req, res) => {
  try {
    const { patientId } = req.params;
    const pool = getPool();

    const [
      patientRes,
      therapistRes,
      checkInsRes,
      messagesRes,
      assignmentsRes,
      goalsRes,
      sessionsRes,
      notesRes,
      clinicalSessionsRes,
      notificationsRes,
    ] = await Promise.all([
      pool.query('SELECT id, name, email, phone, birth_date, status, created_at, updated_at FROM patients WHERE id = $1', [patientId]),
      pool.query(
        `SELECT t.id, t.name, t.specialty, tp.status AS connection_status, tp.connected_at
           FROM therapist_patients tp
           JOIN therapists t ON t.id = tp.therapist_id
          WHERE tp.patient_id = $1`,
        [patientId]
      ),
      pool.query('SELECT * FROM check_ins WHERE patient_id = $1 ORDER BY created_at ASC', [patientId]),
      pool.query('SELECT id, therapist_id, message, created_at FROM messages WHERE patient_id = $1 ORDER BY created_at ASC', [patientId]),
      pool.query('SELECT * FROM assignments WHERE patient_id = $1 ORDER BY created_at ASC', [patientId]),
      pool.query('SELECT * FROM goals WHERE patient_id = $1 ORDER BY created_at ASC', [patientId]),
      pool.query('SELECT * FROM exercise_sessions WHERE patient_id = $1 ORDER BY completed_at ASC, created_at ASC', [patientId]),
      pool.query('SELECT * FROM clinical_notes WHERE patient_id = $1 ORDER BY created_at ASC', [patientId]),
      pool.query('SELECT * FROM clinical_sessions WHERE patient_id = $1 ORDER BY created_at ASC', [patientId]),
      pool.query('SELECT id, type, title, message, is_read, created_at FROM notifications WHERE patient_id = $1 ORDER BY created_at ASC', [patientId]),
    ]);

    if (patientRes.rows.length === 0) {
      return res.status(404).json({ error: 'Paciente no encontrado' });
    }

    // Descifrar textos sensibles antes de entregarlos al titular
    const checkIns = decryptCheckIns(checkInsRes.rows).map(({ patient_id, ...rest }) => rest);
    const messages = decryptMessages(messagesRes.rows).map(({ patient_id, ...rest }) => rest);
    const assignments = decryptAssignments(assignmentsRes.rows).map(({ patient_id, ...rest }) => rest);
    const clinicalNotes = decryptClinicalNotes(notesRes.rows).map(({ patient_id, ...rest }) => rest);
    const clinicalSessions = decryptClinicalSessions(clinicalSessionsRes.rows).map(({ patient_id, ...rest }) => rest);

    // Sesiones de ejercicios: fusionar responses + blob cifrado (igual que en
    // el panel del terapeuta, para que el export sea legible).
    const assignmentById = new Map(assignmentsRes.rows.map(a => [a.id, a]));
    const sessions = sessionsRes.rows.map(s => {
      const asg = assignmentById.get(s.assignment_id) || null;
      const responses = asg ? decodeSessionResponses(s, asg) : (s.responses || {});
      return {
        id: s.id,
        assignment_id: s.assignment_id,
        exercise_kind: s.exercise_kind,
        is_complete: s.is_complete,
        started_at: s.started_at,
        completed_at: s.completed_at,
        created_at: s.created_at,
        responses,
      };
    });

    const exportData = {
      format: 'coter-patient-export',
      version: 1,
      generated_at: new Date().toISOString(),
      patient: patientRes.rows[0],
      therapist: therapistRes.rows,
      check_ins: checkIns,
      messages,
      assignments,
      goals: goalsRes.rows,
      exercise_sessions: sessions,
      clinical_notes: clinicalNotes,
      clinical_sessions: clinicalSessions,
      notifications: notificationsRes.rows,
    };

    auditAccess(req, 'export_patient_data', patientId);

    const body = JSON.stringify(exportData, null, 2);
    const filename = 'coter-datos-' + new Date().toISOString().slice(0, 10) + '.json';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.send(body);
  } catch (err) {
    logger.error('Error exportando datos del paciente', { error: err.message });
    res.status(500).json({ error: 'Error al exportar los datos' });
  }
});

// ─── BORRADO DE DATOS (RGPD — derecho de supresión) ───────────
// Elimina al paciente y todos sus datos (las FK cascada cubren check-ins,
// mensajes, tareas, objetivos, sesiones, notas, alertas y tokens push).
// Exige confirmación explícita para evitar borrados accidentales y notifica
// al terapeuta en tiempo real.
router.post('/:patientId/delete', async (req, res) => {
  try {
    const { patientId } = req.params;
    const confirm = (req.body && req.body.confirm) ? String(req.body.confirm).trim().toUpperCase() : '';
    if (confirm !== 'BORRAR') {
      return res.status(400).json({ error: 'Confirma la eliminación escribiendo BORRAR' });
    }

    const pool = getPool();

    // Capturar el terapeuta antes de borrar (para poder notificarle)
    const { rows: connRows } = await pool.query(
      `SELECT tp.therapist_id, t.name AS therapist_name
         FROM therapist_patients tp
         JOIN therapists t ON t.id = tp.therapist_id
        WHERE tp.patient_id = $1 AND tp.status = 'active'`,
      [patientId]
    );
    const therapistId = connRows.length > 0 ? connRows[0].therapist_id : null;

    await pool.query('DELETE FROM patients WHERE id = $1', [patientId]);

    if (therapistId) {
      bus.publish(bus.topicFor('therapist', therapistId), 'patient:deleted', {
        patientId,
        at: new Date().toISOString(),
      });
    }

    audit({
      who: patientId, role: 'patient', action: 'delete_account', resource: 'patient', resourceId: patientId, ip: req.ip,
      metadata: { therapistId, therapistName: connRows.length > 0 ? connRows[0].therapist_name : null },
    });
    clearPatientCookie(res);
    res.json({ success: true, message: 'Tus datos han sido eliminados' });
  } catch (err) {
    logger.error('Error eliminando datos del paciente', { error: err.message });
    res.status(500).json({ error: 'Error al eliminar los datos' });
  }
});

module.exports = router;
