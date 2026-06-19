const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database');
const { encrypt, decryptCheckIns, decryptMessages, decryptAssignments } = require('../utils/encryption');
const { checkTaskReminders } = require('../utils/notifications');
const { authenticatePatient } = require('../middleware/auth');
const { audit, auditAccess, auditChange } = require('../utils/audit');
const logger = require('../config/logger');

const router = express.Router();

// ─── CONEXION (codigo) ───────────────────────────────────────
router.post('/connect', async (req, res) => {
  try {
    const { connection_code } = req.body;
    if (!connection_code) return res.status(400).json({ error: 'Codigo de conexion requerido' });

    const pool = getPool();
    const { rows: codeRows } = await pool.query(
      `SELECT cc.*, t.name as therapist_name, t.specialty, cc.patient_name FROM connection_codes cc
       JOIN therapists t ON cc.therapist_id = t.id
       WHERE cc.code = $1 AND cc.is_active = TRUE AND cc.uses < cc.max_uses AND cc.expires_at > NOW()`,
      [connection_code]
    );

    if (codeRows.length === 0) return res.status(400).json({ error: 'Codigo invalido o expirado' });

    const codeData = codeRows[0];
    const patientId = uuidv4();
    const patientName = codeData.patient_name || null;
    const authToken = uuidv4(); // Token de autenticación para el paciente

    const insertSql = patientName
      ? "INSERT INTO patients (id, name, status, auth_token) VALUES ($1, $2, 'active', $3)"
      : "INSERT INTO patients (id, status, auth_token) VALUES ($1, 'active', $2)";
    const insertParams = patientName ? [patientId, patientName, authToken] : [patientId, authToken];
    await pool.query(insertSql, insertParams);

    const linkId = uuidv4();
    await pool.query(
      'INSERT INTO therapist_patients (id, therapist_id, patient_id, connection_code) VALUES ($1, $2, $3, $4)',
      [linkId, codeData.therapist_id, patientId, connection_code]
    );

    await pool.query('UPDATE connection_codes SET uses = uses + 1 WHERE id = $1', [codeData.id]);

    audit({ who: patientId, role: 'patient', action: 'connect', resource: 'patient', resourceId: patientId, ip: req.ip, metadata: { therapistId: codeData.therapist_id, code: connection_code } });

    res.json({
      success: true,
      patient_id: patientId,
      auth_token: authToken,
      therapist: { id: codeData.therapist_id, name: codeData.therapist_name, specialty: codeData.specialty },
      connection_code,
      connected_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Error conectando paciente', { error: err.message });
    res.status(500).json({ error: 'Error al conectar' });
  }
});

// ─── Middleware de auth para todas las rutas con :patientId ────
router.use('/:patientId', authenticatePatient);

// ─── CHECK-INS ───────────────────────────────────────────────
router.post('/:patientId/check-ins', async (req, res) => {
  try {
    const { patientId } = req.params;
    const { mood, anxiety, energy, thoughts } = req.body;
    if (!mood || !anxiety || !energy) return res.status(400).json({ error: 'Mood, anxiety y energy requeridos' });

    const pool = getPool();
    const id = uuidv4();
    await pool.query(
      'INSERT INTO check_ins (id, patient_id, mood, anxiety, energy, thoughts) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, patientId, mood, anxiety, energy || 5, encrypt(thoughts || '')]
    );
    audit({ who: patientId, role: 'patient', action: 'create_checkin', resource: 'check_in', resourceId: id, ip: req.ip, metadata: { mood, anxiety, energy } });
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

    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*) as total FROM messages WHERE patient_id = $1',
      [patientId]
    );

    res.json({ success: true, messages: decryptMessages(rows), pagination: { limit, offset, total: parseInt(countRows[0].total) } });
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

    const messageId = uuidv4();
    await pool.query(
      'INSERT INTO messages (id, therapist_id, patient_id, message, is_therapist) VALUES ($1, $2, $3, $4, FALSE)',
      [messageId, connRows[0].therapist_id, patientId, encrypt(message)]
    );
    audit({ who: patientId, role: 'patient', action: 'send_message', resource: 'message', resourceId: messageId, ip: req.ip });
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
    const { rows } = await pool.query(
      "SELECT * FROM assignments WHERE patient_id = $1 AND status = 'assigned' ORDER BY created_at DESC",
      [patientId]
    );
    res.json({ success: true, assignments: decryptAssignments(rows) });
  } catch (err) {
    logger.error('Error cargando tareas', { error: err.message });
    res.status(500).json({ error: 'Error al cargar' });
  }
});

router.put('/:patientId/assignments/:assignmentId', async (req, res) => {
  try {
    const { patientId, assignmentId } = req.params;
    await getPool().query(
      "UPDATE assignments SET status = 'completed', completed_at = NOW() WHERE id = $1 AND patient_id = $2",
      [assignmentId, patientId]
    );
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
    const text = latestNoteRows.length > 0 ? (latestNoteRows[0].assessment || latestNoteRows[0].subjective || '') : '';
    const latestNote = latestNoteRows.length > 0 ? {
      excerpt: text.length > 200 ? text.substring(0, 200).replace(/\s+\S*$/, '') + '...' : text,
      date: latestNoteRows[0].created_at,
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

// ─── NOTIFICACIONES ──────────────────────────────────────────
router.get('/:patientId/notifications', async (req, res) => {
  try {
    const { patientId } = req.params;
    const pool = getPool();
    checkTaskReminders(pool, patientId);
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

    const unreadCount = rows.filter(n => !n.is_read).length;
    res.json({ success: true, notifications: rows, unread_count: unreadCount, pagination: { limit, offset, total: parseInt(countRows[0].total) } });
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

module.exports = router;
