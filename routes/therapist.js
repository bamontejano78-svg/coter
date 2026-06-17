const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { body, query, param, validationResult } = require('express-validator');
const { getPool } = require('../database');
const { authenticateToken } = require('../middleware/auth');
const config = require('../config/env');
const logger = require('../config/logger');
const { encrypt, decryptCheckIns, decryptMessages, decryptAssignments } = require('../utils/encryption');
const { createNotification } = require('../utils/notifications');

const router = express.Router();

// Generar codigo de conexion
const generateConnectionCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'TH-';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) code += chars.charAt(bytes[i] % chars.length);
  return code;
};

// Helper: validar campos
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  next();
};

// ─── REGISTRO ─────────────────────────────────────────────────
router.post('/register', [
  body('name').trim().notEmpty().withMessage('Nombre requerido'),
  body('email').isEmail().normalizeEmail().withMessage('Email valido requerido'),
  body('specialty').trim().notEmpty().withMessage('Especialidad requerida'),
  body('password').isLength({ min: 6 }).withMessage('Minimo 6 caracteres'),
], validate, async (req, res) => {
  try {
    const { name, email, specialty, password } = req.body;
    const pool = getPool();

    const { rows: existing } = await pool.query('SELECT id FROM therapists WHERE email = $1', [email]);
    if (existing.length > 0) {
      return res.json({ success: false, error: 'Email ya registrado' });
    }

    const hash = await bcrypt.hash(password, 10);
    const id = uuidv4();
    await pool.query(
      'INSERT INTO therapists (id, name, email, password, specialty) VALUES ($1, $2, $3, $4, $5)',
      [id, name, email, hash, specialty]
    );

    const token = jwt.sign({ id }, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN });
    logger.info('Terapeuta registrado', { id, email });
    res.json({ success: true, therapist: { id, name, email, specialty }, token });
  } catch (err) {
    logger.error('Error en registro', { error: err.message });
    res.status(500).json({ success: false, error: 'Error del servidor' });
  }
});

// ─── LOGIN ────────────────────────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], validate, async (req, res) => {
  try {
    const { email, password } = req.body;
    const pool = getPool();
    const { rows } = await pool.query('SELECT * FROM therapists WHERE email = $1', [email]);

    if (rows.length === 0) {
      return res.json({ success: false, error: 'Credenciales invalidas' });
    }

    const therapist = rows[0];
    const valid = await bcrypt.compare(password, therapist.password);
    if (!valid) {
      return res.json({ success: false, error: 'Credenciales invalidas' });
    }

    const token = jwt.sign({ id: therapist.id }, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN });
    res.json({
      success: true,
      therapist: { id: therapist.id, name: therapist.name, email: therapist.email, specialty: therapist.specialty },
      token,
    });
  } catch (err) {
    logger.error('Error en login', { error: err.message });
    res.status(500).json({ success: false, error: 'Error del servidor' });
  }
});

// ─── CODIGOS DE CONEXION ──────────────────────────────────────
router.post('/connection-codes', authenticateToken, [
  body('duration_hours').optional().isInt({ min: 1, max: 8760 }),
  body('max_uses').optional().isInt({ min: 1, max: 100 }),
  body('patient_name').optional().trim(),
], validate, async (req, res) => {
  try {
    const { duration_hours = 168, max_uses = 1, patient_name } = req.body;
    const code = generateConnectionCode();
    const id = uuidv4();
    const pool = getPool();

    await pool.query(
      `INSERT INTO connection_codes (id, therapist_id, code, duration_hours, max_uses, uses, expires_at, patient_name)
       VALUES ($1, $2, $3, $4, $5, 0, NOW() + ($4 || ' hours')::INTERVAL, $6)`,
      [id, req.user.id, code, duration_hours, max_uses, patient_name || null]
    );

    res.json({ success: true, code, expires_in_hours: duration_hours, max_uses, patient_name: patient_name || null });
  } catch (err) {
    logger.error('Error creando codigo', { error: err.message });
    res.json({ success: false, error: 'Error al crear codigo' });
  }
});

router.get('/connection-codes', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT code, duration_hours, max_uses, uses, is_active, created_at, expires_at FROM connection_codes WHERE therapist_id = $1 AND is_active = TRUE ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );
    res.json({ success: true, codes: rows });
  } catch (err) {
    logger.error('Error cargando codigos', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── PACIENTES ────────────────────────────────────────────────
router.get('/patients', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.email, p.phone, p.status, p.created_at, tp.connection_code, tp.connected_at,
        (SELECT mood FROM check_ins WHERE patient_id = p.id ORDER BY created_at DESC LIMIT 1) as last_mood,
        (SELECT anxiety FROM check_ins WHERE patient_id = p.id ORDER BY created_at DESC LIMIT 1) as last_anxiety,
        (SELECT created_at FROM check_ins WHERE patient_id = p.id ORDER BY created_at DESC LIMIT 1) as last_checkin
      FROM patients p JOIN therapist_patients tp ON tp.patient_id = p.id
      WHERE tp.therapist_id = $1 AND tp.status = 'active' ORDER BY tp.connected_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, patients: rows });
  } catch (err) {
    logger.error('Error cargando pacientes', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── DASHBOARD ────────────────────────────────────────────────
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const tid = req.user.id;

    // Ejecutar queries independientes en paralelo
    const [activeResult, todayResult, taskResult, riskResult, trendResult, recentResult] = await Promise.all([
      pool.query("SELECT COUNT(*) as count FROM therapist_patients WHERE therapist_id = $1 AND status = 'active'", [tid]),
      pool.query("SELECT COUNT(*) as count FROM check_ins ci JOIN therapist_patients tp ON tp.patient_id = ci.patient_id WHERE tp.therapist_id = $1 AND ci.created_at::date = CURRENT_DATE", [tid]),
      pool.query("SELECT COUNT(*) as count FROM assignments a JOIN therapist_patients tp ON tp.patient_id = a.patient_id WHERE tp.therapist_id = $1 AND a.status = 'assigned'", [tid]),
      pool.query(`SELECT DISTINCT ON (ci.patient_id) ci.mood FROM check_ins ci JOIN therapist_patients tp ON tp.patient_id = ci.patient_id WHERE tp.therapist_id = $1 ORDER BY ci.patient_id, ci.created_at DESC`, [tid]),
      pool.query(`SELECT ci.created_at::date as day, ROUND(AVG(ci.mood),1) as avg_mood, ROUND(AVG(ci.anxiety),1) as avg_anxiety, ROUND(AVG(ci.energy),1) as avg_energy, COUNT(*) as checkins FROM check_ins ci JOIN therapist_patients tp ON tp.patient_id = ci.patient_id WHERE tp.therapist_id = $1 AND ci.created_at >= NOW() - INTERVAL '7 days' GROUP BY ci.created_at::date ORDER BY day ASC`, [tid]),
      pool.query(`SELECT 'checkin' as type, ci.patient_id, p.name as patient_name, ci.mood, ci.created_at FROM check_ins ci JOIN therapist_patients tp ON tp.patient_id = ci.patient_id LEFT JOIN patients p ON p.id = ci.patient_id WHERE tp.therapist_id = $1 ORDER BY ci.created_at DESC LIMIT 5`, [tid]),
    ]);

    const activePatients = parseInt(activeResult.rows[0].count);
    const todayCheckins = parseInt(todayResult.rows[0].count);
    const pendingTasks = parseInt(taskResult.rows[0].count);
    const atRisk = riskResult.rows.filter(r => r.mood <= 3).length;

    res.json({ success: true, dashboard: { activePatients, todayCheckins, pendingTasks, atRisk, weeklyTrend: trendResult.rows, recentActivity: recentResult.rows } });
  } catch (err) {
    logger.error('Error dashboard', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── PERFIL DE PACIENTE ──────────────────────────────────────
router.get('/patients/:patientId', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const { patientId } = req.params;

    const { rows: connRows } = await pool.query(
      "SELECT * FROM therapist_patients WHERE therapist_id = $1 AND patient_id = $2 AND status = 'active'",
      [req.user.id, patientId]
    );
    if (connRows.length === 0) return res.status(404).json({ success: false, error: 'Paciente no encontrado' });

    const { rows: patientRows } = await pool.query('SELECT * FROM patients WHERE id = $1', [patientId]);
    if (patientRows.length === 0) return res.status(404).json({ success: false, error: 'Paciente no encontrado' });

    const { rows: checkIns } = await pool.query('SELECT * FROM check_ins WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 50', [patientId]);
    const { rows: messages } = await pool.query('SELECT * FROM messages WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 100', [patientId]);
    const { rows: assignments } = await pool.query('SELECT * FROM assignments WHERE patient_id = $1 ORDER BY created_at DESC', [patientId]);
    const { rows: goals } = await pool.query('SELECT * FROM goals WHERE patient_id = $1 ORDER BY created_at DESC', [patientId]);

    const patient = patientRows[0];
    const metrics = calculateMetrics(checkIns);

    res.json({
      success: true,
      patient: { ...patient, checkIns: decryptCheckIns(checkIns), messages: decryptMessages(messages), assignments: decryptAssignments(assignments), goals, metrics },
    });
  } catch (err) {
    logger.error('Error perfil paciente', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── MENSAJES DEL TERAPEUTA ───────────────────────────────────
router.post('/patients/:patientId/messages', authenticateToken, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'Mensaje requerido' });

    const pool = getPool();
    const msgId = uuidv4();
    const encryptedMsg = encrypt(message.trim());

    await pool.query(
      'INSERT INTO messages (id, therapist_id, patient_id, message, is_therapist) VALUES ($1, $2, $3, $4, TRUE)',
      [msgId, req.user.id, patientId, encryptedMsg]
    );

    const preview = message.trim().length > 80 ? message.trim().substring(0, 80) + '...' : message.trim();
    createNotification(pool, patientId, 'message', 'Nuevo mensaje de tu terapeuta', preview, msgId);

    res.json({ success: true, message_id: msgId });
  } catch (err) {
    logger.error('Error enviando mensaje', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── ASIGNACIONES ────────────────────────────────────────────
router.post('/patients/:patientId/assignments', authenticateToken, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { type, title, instructions, due_date } = req.body;
    if (!type || !title || !instructions) return res.status(400).json({ success: false, error: 'Tipo, titulo e instrucciones requeridos' });

    const pool = getPool();
    const assignId = uuidv4();
    await pool.query(
      'INSERT INTO assignments (id, therapist_id, patient_id, type, title, instructions, due_date) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [assignId, req.user.id, patientId, type, title, encrypt(instructions), due_date || null]
    );

    const dueMsg = due_date ? ' (vence: ' + new Date(due_date).toLocaleDateString('es-ES') + ')' : '';
    createNotification(pool, patientId, 'assignment', 'Nueva tarea asignada', '"' + title + '"' + dueMsg, assignId);

    res.json({ success: true, assignment_id: assignId });
  } catch (err) {
    logger.error('Error creando tarea', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.put('/patients/:patientId/assignments/:assignmentId', authenticateToken, async (req, res) => {
  try {
    const { patientId, assignmentId } = req.params;
    const { completed } = req.body;
    if (!completed) return res.status(400).json({ success: false, error: 'Faltan datos' });

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

// ─── OBJETIVOS ────────────────────────────────────────────────
router.post('/patients/:patientId/goals', authenticateToken, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { title, metric, target_value, duration_days } = req.body;
    if (!title || !metric || !target_value || !duration_days) return res.status(400).json({ success: false, error: 'Faltan datos' });

    const pool = getPool();
    const goalId = uuidv4();
    await pool.query(
      'INSERT INTO goals (id, patient_id, title, metric, target_value, duration_days) VALUES ($1, $2, $3, $4, $5, $6)',
      [goalId, patientId, title, metric, target_value, duration_days]
    );

    createNotification(pool, patientId, 'goal', 'Nuevo objetivo', '"' + title + '" - Meta: ' + target_value + ' (' + duration_days + ' dias)', goalId);
    res.json({ success: true, goal_id: goalId });
  } catch (err) {
    logger.error('Error creando objetivo', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.put('/patients/:patientId/goals/:goalId', authenticateToken, async (req, res) => {
  try {
    const { patientId, goalId } = req.params;
    const { current_value, status } = req.body;
    const pool = getPool();

    if (current_value !== undefined) {
      await pool.query('UPDATE goals SET current_value = $1 WHERE id = $2 AND patient_id = $3', [current_value, goalId, patientId]);
      const { rows: goalRows } = await pool.query('SELECT title, target_value FROM goals WHERE id = $1', [goalId]);
      if (goalRows.length > 0) {
        const goal = goalRows[0];
        const pct = Math.round((current_value / goal.target_value) * 100);
        const msg = pct >= 100 ? 'Objetivo completado!' : 'Progreso: ' + current_value + '/' + goal.target_value + ' (' + pct + '%)';
        createNotification(pool, patientId, 'goal', 'Actualizacion de objetivo', '"' + goal.title + '" - ' + msg, goalId);
      }
    } else if (status) {
      await pool.query('UPDATE goals SET status = $1 WHERE id = $2 AND patient_id = $3', [status, goalId, patientId]);
      if (status === 'completed') {
        const { rows: goalRows } = await pool.query('SELECT title FROM goals WHERE id = $1', [goalId]);
        if (goalRows.length > 0) {
          createNotification(pool, patientId, 'goal', 'Objetivo completado', 'Felicidades! Alcanzaste "' + goalRows[0].title + '"', goalId);
        }
      }
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('Error actualizando objetivo', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── CALENDARIO ───────────────────────────────────────────────
router.get('/calendar', authenticateToken, async (req, res) => {
  try {
    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, error: 'Parametro month requerido (YYYY-MM)' });
    }

    const pool = getPool();
    const therapistId = req.user.id;
    const startDate = month + '-01';
    const [y, m] = month.split('-').map(Number);
    const nextMonth = m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0');
    const endDate = nextMonth + '-01';

    const { rows: checkins } = await pool.query(
      `SELECT ci.id, ci.patient_id, p.name as patient_name, ci.mood, ci.anxiety, ci.energy, ci.created_at FROM check_ins ci JOIN therapist_patients tp ON tp.patient_id = ci.patient_id LEFT JOIN patients p ON p.id = ci.patient_id WHERE tp.therapist_id = $1 AND tp.status = 'active' AND ci.created_at::date >= $2::date AND ci.created_at::date < $3::date ORDER BY ci.created_at DESC`,
      [therapistId, startDate, endDate]
    );

    const { rows: tasks } = await pool.query(
      `SELECT a.id, a.patient_id, p.name as patient_name, a.title, a.type, a.status, a.due_date, a.created_at FROM assignments a JOIN therapist_patients tp ON tp.patient_id = a.patient_id LEFT JOIN patients p ON p.id = a.patient_id WHERE tp.therapist_id = $1 AND tp.status = 'active' AND ((a.due_date IS NOT NULL AND a.due_date::date >= $2::date AND a.due_date::date < $3::date) OR (a.due_date IS NULL AND a.created_at::date >= $2::date AND a.created_at::date < $3::date)) ORDER BY a.due_date ASC, a.created_at DESC`,
      [therapistId, startDate, endDate]
    );

    const dates = {};
    checkins.forEach(c => {
      const day = c.created_at.toISOString().slice(0, 10);
      if (!dates[day]) dates[day] = { checkins: [], tasks: [] };
      dates[day].checkins.push({ id: c.id, patient_name: c.patient_name || 'Anonimo', patient_id: c.patient_id, mood: c.mood, anxiety: c.anxiety, energy: c.energy, time: c.created_at });
    });
    tasks.forEach(t => {
      const day = (t.due_date || t.created_at.toISOString()).slice(0, 10);
      if (!dates[day]) dates[day] = { checkins: [], tasks: [] };
      dates[day].tasks.push({ id: t.id, patient_name: t.patient_name || 'Anonimo', patient_id: t.patient_id, title: t.title, type: t.type, status: t.status, due_date: t.due_date, time: t.created_at });
    });

    res.json({ success: true, month, dates, checkin_count: checkins.length, task_count: tasks.length });
  } catch (err) {
    logger.error('Error calendario', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── NOTAS CLINICAS ───────────────────────────────────────────
router.get('/patients/:patientId/clinical-notes', authenticateToken, async (req, res) => {
  try {
    const { patientId } = req.params;
    const pool = getPool();
    const { rows: connRows } = await pool.query(
      "SELECT * FROM therapist_patients WHERE therapist_id = $1 AND patient_id = $2 AND status = 'active'",
      [req.user.id, patientId]
    );
    if (connRows.length === 0) return res.status(404).json({ success: false, error: 'Paciente no encontrado' });

    const { rows: notes } = await pool.query(
      'SELECT * FROM clinical_notes WHERE patient_id = $1 AND therapist_id = $2 ORDER BY created_at DESC',
      [patientId, req.user.id]
    );
    res.json({ success: true, notes });
  } catch (err) {
    logger.error('Error cargando notas', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.post('/patients/:patientId/clinical-notes', authenticateToken, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { subjective, objective, assessment, plan } = req.body;
    if (!subjective && !objective && !assessment && !plan) {
      return res.status(400).json({ success: false, error: 'Al menos un campo SOAP requerido' });
    }
    const pool = getPool();
    const { rows: connRows } = await pool.query(
      "SELECT * FROM therapist_patients WHERE therapist_id = $1 AND patient_id = $2 AND status = 'active'",
      [req.user.id, patientId]
    );
    if (connRows.length === 0) return res.status(404).json({ success: false, error: 'Paciente no encontrado' });

    const id = uuidv4();
    await pool.query(
      'INSERT INTO clinical_notes (id, patient_id, therapist_id, subjective, objective, assessment, plan) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, patientId, req.user.id, subjective || null, objective || null, assessment || null, plan || null]
    );
    const { rows: noteRows } = await pool.query('SELECT * FROM clinical_notes WHERE id = $1', [id]);
    res.json({ success: true, note: noteRows[0] });
  } catch (err) {
    logger.error('Error creando nota', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.put('/patients/:patientId/clinical-notes/:noteId', authenticateToken, async (req, res) => {
  try {
    const { patientId, noteId } = req.params;
    const { subjective, objective, assessment, plan } = req.body;
    const pool = getPool();
    const { rows: noteRows } = await pool.query(
      'SELECT * FROM clinical_notes WHERE id = $1 AND patient_id = $2 AND therapist_id = $3',
      [noteId, patientId, req.user.id]
    );
    if (noteRows.length === 0) return res.status(404).json({ success: false, error: 'Nota no encontrada' });

    const note = noteRows[0];
    const fields = {
      subjective: subjective !== undefined ? (subjective || null) : note.subjective,
      objective: objective !== undefined ? (objective || null) : note.objective,
      assessment: assessment !== undefined ? (assessment || null) : note.assessment,
      plan: plan !== undefined ? (plan || null) : note.plan,
    };
    await pool.query(
      "UPDATE clinical_notes SET subjective=$1, objective=$2, assessment=$3, plan=$4, updated_at=NOW() WHERE id=$5 AND therapist_id=$6",
      [fields.subjective, fields.objective, fields.assessment, fields.plan, noteId, req.user.id]
    );
    res.json({ success: true, note: { ...note, ...fields, updated_at: new Date().toISOString() } });
  } catch (err) {
    logger.error('Error actualizando nota', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.delete('/patients/:patientId/clinical-notes/:noteId', authenticateToken, async (req, res) => {
  try {
    const { patientId, noteId } = req.params;
    const pool = getPool();
    const { rows: noteRows } = await pool.query(
      'SELECT * FROM clinical_notes WHERE id = $1 AND patient_id = $2 AND therapist_id = $3',
      [noteId, patientId, req.user.id]
    );
    if (noteRows.length === 0) return res.status(404).json({ success: false, error: 'Nota no encontrada' });

    await pool.query('DELETE FROM clinical_notes WHERE id = $1 AND therapist_id = $2', [noteId, req.user.id]);
    res.json({ success: true, message: 'Nota eliminada' });
  } catch (err) {
    logger.error('Error eliminando nota', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── BIBLIOTECA TCC ───────────────────────────────────────────
router.get('/task-templates', authenticateToken, async (req, res) => {
  try {
    const { category } = req.query;
    const pool = getPool();
    const params = [req.user.id];
    let where = 'WHERE (therapist_id IS NULL OR therapist_id = $1)';
    if (category) { where += ' AND category = $2'; params.push(category); }
    const { rows: templates } = await pool.query(
      'SELECT * FROM task_templates ' + where + ' ORDER BY therapist_id NULLS FIRST, category, difficulty, title',
      params
    );
    const { rows: categories } = await pool.query(
      'SELECT DISTINCT category FROM task_templates WHERE therapist_id IS NULL OR therapist_id = $1 ORDER BY category',
      [req.user.id]
    );
    res.json({ success: true, templates, categories: categories.map(c => c.category) });
  } catch (err) {
    logger.error('Error cargando templates', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.post('/task-templates', authenticateToken, async (req, res) => {
  try {
    const { category, title, instructions, difficulty = 'media', duration_min = 30 } = req.body;
    if (!category || !title || !instructions) return res.status(400).json({ success: false, error: 'Categoria, titulo e instrucciones requeridos' });
    if (!['baja', 'media', 'alta'].includes(difficulty)) return res.status(400).json({ success: false, error: 'Dificultad: baja, media o alta' });

    const pool = getPool();
    const id = uuidv4();
    await pool.query(
      'INSERT INTO task_templates (id, therapist_id, category, title, instructions, difficulty, duration_min) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, req.user.id, category.trim(), title.trim(), instructions.trim(), difficulty, duration_min]
    );
    res.json({ success: true, template: { id, therapist_id: req.user.id, category: category.trim(), title: title.trim(), instructions: instructions.trim(), difficulty, duration_min } });
  } catch (err) {
    logger.error('Error creando template', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.put('/task-templates/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { category, title, instructions, difficulty, duration_min } = req.body;
    const pool = getPool();
    const { rows: tmplRows } = await pool.query('SELECT * FROM task_templates WHERE id = $1 AND therapist_id = $2', [id, req.user.id]);
    if (tmplRows.length === 0) return res.status(404).json({ success: false, error: 'Plantilla no encontrada' });

    if (difficulty && !['baja', 'media', 'alta'].includes(difficulty)) return res.status(400).json({ success: false, error: 'Dificultad: baja, media o alta' });

    const tmpl = tmplRows[0];
    const fields = {
      category: (category || tmpl.category).trim(),
      title: (title || tmpl.title).trim(),
      instructions: (instructions || tmpl.instructions).trim(),
      difficulty: difficulty || tmpl.difficulty,
      duration_min: duration_min !== undefined ? duration_min : tmpl.duration_min,
    };
    await pool.query(
      'UPDATE task_templates SET category=$1, title=$2, instructions=$3, difficulty=$4, duration_min=$5 WHERE id=$6 AND therapist_id=$7',
      [fields.category, fields.title, fields.instructions, fields.difficulty, fields.duration_min, id, req.user.id]
    );
    res.json({ success: true, template: { id, therapist_id: req.user.id, ...fields } });
  } catch (err) {
    logger.error('Error actualizando template', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.delete('/task-templates/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const pool = getPool();
    const { rows: tmplRows } = await pool.query('SELECT * FROM task_templates WHERE id = $1 AND therapist_id = $2', [id, req.user.id]);
    if (tmplRows.length === 0) return res.status(404).json({ success: false, error: 'Plantilla no encontrada' });

    await pool.query('DELETE FROM task_templates WHERE id = $1 AND therapist_id = $2', [id, req.user.id]);
    res.json({ success: true, message: 'Plantilla eliminada' });
  } catch (err) {
    logger.error('Error eliminando template', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── EXPORTACION ──────────────────────────────────────────────
router.get('/export/:patientId', authenticateToken, async (req, res) => {
  try {
    const { patientId } = req.params;
    const pool = getPool();
    const { rows: connRows } = await pool.query(
      'SELECT * FROM therapist_patients WHERE therapist_id = $1 AND patient_id = $2',
      [req.user.id, patientId]
    );
    if (connRows.length === 0) return res.status(404).json({ success: false, error: 'Paciente no encontrado' });

    const { rows: patientRows } = await pool.query('SELECT * FROM patients WHERE id = $1', [patientId]);
    const { rows: checkIns } = await pool.query('SELECT * FROM check_ins WHERE patient_id = $1 ORDER BY created_at ASC', [patientId]);
    const { rows: messages } = await pool.query('SELECT * FROM messages WHERE patient_id = $1 ORDER BY created_at ASC', [patientId]);
    const { rows: assignments } = await pool.query('SELECT * FROM assignments WHERE patient_id = $1 ORDER BY created_at ASC', [patientId]);
    const { rows: goals } = await pool.query('SELECT * FROM goals WHERE patient_id = $1', [patientId]);

    const format = req.query.format || 'json';
    const decryptedCheckIns = decryptCheckIns(checkIns);
    const decryptedMessages = decryptMessages(messages);
    const decryptedAssignments = decryptAssignments(assignments);

    if (format === 'csv') {
      const patient = patientRows[0];
      const csv = generateCSV(patient, decryptedCheckIns, decryptedMessages, decryptedAssignments, goals);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=coter_' + patientId.slice(0, 8) + '.csv');
      return res.send(csv);
    }
    const patient = patientRows[0];
    res.json({ export_date: new Date().toISOString(), patient, check_ins: decryptedCheckIns, messages: decryptedMessages, assignments: decryptedAssignments, goals });
  } catch (err) {
    logger.error('Error exportando', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── RECUPERACION DE CONTRASENA ───────────────────────────────
router.post('/password-recovery', [
  body('email').isEmail().normalizeEmail(),
], validate, async (req, res) => {
  try {
    const { email } = req.body;
    const pool = getPool();
    const { rows } = await pool.query('SELECT id, name FROM therapists WHERE email = $1', [email]);
    if (rows.length === 0) return res.json({ success: true, message: 'Si el email existe, recibiras instrucciones' });

    const therapist = rows[0];
    const resetToken = uuidv4();
    await pool.query(
      'INSERT INTO password_resets (id, therapist_id, token, expires_at) VALUES ($1, $2, $3, $4)',
      [uuidv4(), therapist.id, resetToken, new Date(Date.now() + 3600000).toISOString()]
    );

    // En desarrollo: loguear el token
    if (!config.isProd) {
      logger.info('Password reset token para ' + email + ': ' + resetToken);
    }

    // TODO: Enviar email real con el token
    if (config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS) {
      logger.info('Email de recuperacion enviado a ' + email);
      // Aqui se integraria nodemailer
    }

    res.json({ success: true, message: 'Si el email existe, recibiras instrucciones' });
  } catch (err) {
    logger.error('Error recuperacion', { error: err.message });
    res.json({ success: true, message: 'Si el email existe, recibiras instrucciones' });
  }
});

router.post('/reset-password', [
  body('token').notEmpty(),
  body('new_password').isLength({ min: 6 }),
], validate, async (req, res) => {
  try {
    const { token, new_password } = req.body;
    const pool = getPool();
    const { rows: resetRows } = await pool.query(
      "SELECT * FROM password_resets WHERE token = $1 AND used = FALSE AND expires_at > NOW()",
      [token]
    );
    if (resetRows.length === 0) return res.json({ success: false, error: 'Token invalido o expirado' });

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query("UPDATE therapists SET password = $1, updated_at = NOW() WHERE id = $2", [hash, resetRows[0].therapist_id]);
    await pool.query('UPDATE password_resets SET used = TRUE WHERE id = $1', [resetRows[0].id]);
    res.json({ success: true, message: 'Contrasena actualizada' });
  } catch (err) {
    logger.error('Error reseteando password', { error: err.message });
    res.json({ success: false, error: 'Error al actualizar' });
  }
});

// ─── HELPERS ──────────────────────────────────────────────────
function calculateMetrics(checkIns) {
  if (!checkIns || checkIns.length === 0) return { avg_mood: 0, avg_anxiety: 0, avg_energy: 0, total_checkins: 0, streak_days: 0, last_checkin: null };
  const recent = checkIns.slice(0, 7);
  return {
    avg_mood: +(recent.reduce((s, c) => s + c.mood, 0) / recent.length).toFixed(1),
    avg_anxiety: +(recent.reduce((s, c) => s + c.anxiety, 0) / recent.length).toFixed(1),
    avg_energy: +(recent.reduce((s, c) => s + (c.energy || 5), 0) / recent.length).toFixed(1),
    total_checkins: checkIns.length,
    streak_days: calcStreak(checkIns),
    last_checkin: checkIns[0]?.created_at || null,
  };
}

function calcStreak(checkIns) {
  let streak = 0;
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

function generateCSV(patient, checkIns, messages, assignments, goals) {
  let csv = 'TIPO,FECHA,DATOS\n';
  csv += 'PACIENTE,,' + (patient.name || 'Anonimo') + ',' + (patient.email || '') + '\n';
  csv += 'EXPORTACION,,' + new Date().toISOString() + '\n\n';
  csv += 'CHECK-INS\nFecha,Animo,Ansiedad,Energia,Pensamientos\n';
  checkIns.forEach(c => csv += c.created_at + ',' + c.mood + ',' + c.anxiety + ',' + (c.energy || '-') + ',"' + (c.thoughts || '').replace(/"/g, '""') + '"\n');
  csv += '\nMENSAJES\nFecha,De,Mensaje\n';
  messages.forEach(m => csv += m.created_at + ',' + (m.is_therapist ? 'Terapeuta' : 'Paciente') + ',"' + m.message.replace(/"/g, '""') + '"\n');
  csv += '\nTAREAS\nFecha,Titulo,Tipo,Estado,Instrucciones\n';
  assignments.forEach(a => csv += (a.created_at || '') + ',' + a.title + ',' + a.type + ',' + a.status + ',"' + (a.instructions || '').replace(/"/g, '""') + '"\n');
  csv += '\nOBJETIVOS\nTitulo,Metrica,Valor Actual,Valor Objetivo,Estado\n';
  goals.forEach(g => csv += g.title + ',' + g.metric + ',' + g.current_value + ',' + g.target_value + ',' + g.status + '\n');
  return csv;
}

module.exports = router;
