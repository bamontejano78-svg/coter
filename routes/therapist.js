const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { body, query, param, validationResult } = require('express-validator');
const { getPool } = require('../database');
const { authWithBilling } = require('../middleware/billing');
const config = require('../config/env');
const logger = require('../config/logger');
const { encrypt, decryptCheckIns, decryptMessages, decryptAssignments } = require('../utils/encryption');
// Importamos KINDS (whitelist 100% sincronizada con migration 007 CHECK constraint)
// y getSchema() (resuelve el schema efectivo para cada kind clínico,
// incluyendo las discriminantes mode/phobia para BA y GE). Ver
// /utils/exerciseSchemas.test.js para el contrato que esto mantiene.
const { getSchema, validateSchemaDefinition, KINDS } = require('../utils/exerciseSchemas');
const { createNotification } = require('../utils/notifications');
const { audit, auditAccess, auditChange } = require('../utils/audit');
const bus = require('../utils/eventBus');
// Helpers de ejercicios clínicos compartidos con routes/patients.js. Los
// usamos para enriquecer el GET /patients/:patientId con `latest_session`
// ya mergeada, de modo que el cliente del terapeuta pueda abrir el panel
// "Ver respuestas" sin un round-trip extra.
const { fetchLatestSessionsForAssignments, decodeSessionResponses, schemaForAssignment } = require('../utils/exerciseHelpers');
const { createTrialSubscription } = require('../utils/billing');
const { createStripeCustomer } = require('../utils/stripe');
const { SCALE_KINDS, scoreResponses, getScoreHistory } = require('../utils/clinicalScales');
const { getAlerts, getUnreadAlerts, markAlertsRead, updateAlertStatus } = require('../utils/clinicalAlerts');
const { COOKIE_NAMES, getCookie, setTherapistCookies, clearTherapistCookies } = require('../utils/cookies');
const fcm = require('../utils/fcm');

// ─── Email transporter (lazy init) ──────────────────────────────
let mailTransporter = null;
function getMailTransporter() {
  if (mailTransporter) return mailTransporter;
  if (!config.SMTP_HOST || !config.SMTP_USER || !config.SMTP_PASS) {
    logger.warn('SMTP no configurado — emails no se enviarán');
    return null;
  }
  mailTransporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  });
  logger.info('Transporte de email configurado: ' + config.SMTP_HOST);
  
  // Verificar conexión SMTP (asíncrono, no bloquea el arranque)
  mailTransporter.verify((err) => {
    if (err) logger.error('Error verificando SMTP: ' + err.message);
    else logger.info('SMTP verificado correctamente');
  });
  
  return mailTransporter;
}

async function sendRecoveryEmail(email, therapistName, resetToken, resetUrl) {
  const transporter = getMailTransporter();
  if (!transporter) {
    logger.warn('No se pudo enviar email de recuperación — SMTP no configurado');
    return false;
  }
  try {
    await transporter.sendMail({
      from: '"Coter Pro" <' + config.SMTP_FROM + '>',
      to: email,
      subject: 'Recuperación de contraseña — Coter Pro',
      text: 'Hola ' + therapistName + ',\n\nHas solicitado restablecer tu contraseña en Coter Pro.\n\nUsa el siguiente enlace para crear una nueva contraseña (válido por 1 hora):\n' + resetUrl + '\n\nO copia este código: ' + resetToken + '\n\nSi no solicitaste este cambio, ignora este mensaje.\n\n— El equipo de Coter Pro',
      html: '<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px"><h2 style="color:#6366f1">🧠 Coter Pro</h2><p>Hola <strong>' + therapistName + '</strong>,</p><p>Has solicitado restablecer tu contraseña.</p><p style="text-align:center;margin:30px 0"><a href="' + resetUrl + '" style="background:#6366f1;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px">Restablecer contraseña</a></p><p style="color:#888;font-size:14px">O copia este código: <strong>' + resetToken + '</strong></p><p style="color:#888;font-size:14px">Válido por 1 hora. Si no solicitaste esto, ignora este mensaje.</p></div>',
    });
    logger.info('Email de recuperación enviado a ' + email);
    return true;
  } catch (err) {
    logger.error('Error enviando email de recuperación', { error: err.message, email });
    return false;
  }
}

const router = express.Router();

// Generar codigo de conexion
const generateConnectionCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'TH-';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) code += chars.charAt(bytes[i] % chars.length);
  return code;
};

// ─── Refresh Token Helpers ────────────────────────────────────
const REFRESH_TOKEN_BYTES = 48; // 96 caracteres hex

function generateRefreshToken() {
  return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
}

async function createRefreshToken(pool, therapistId) {
  const token = generateRefreshToken();
  const family = uuidv4(); // agrupa tokens de la misma sesión
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_DAYS * 86400000);
  await pool.query(
    'INSERT INTO refresh_tokens (id, therapist_id, token, family, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [uuidv4(), therapistId, token, family, expiresAt]
  );
  return token;
}

async function rotateRefreshToken(pool, oldToken, therapistId) {
  // Buscar el token sin filtrar por revoked (para distinguir los 3 casos)
  const { rows } = await pool.query(
    'SELECT family, revoked, expires_at FROM refresh_tokens WHERE token = $1 AND therapist_id = $2',
    [oldToken, therapistId]
  );

  // Caso 1: Token nunca existió — rechazar sin revocar nada
  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];

  // Caso 2: Token ya fue revocado (posible replay/robo) — revocar toda la familia
  if (row.revoked) {
    logger.warn('Posible robo de refresh token (replay detectado)', { therapistId });
    await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE family = $1', [row.family]);
    return null;
  }

  // Caso 3: Token expirado — rechazar sin revocar (legítimo)
  if (new Date(row.expires_at) <= new Date()) {
    return null;
  }

  // Caso 4: Token válido — rotación normal
  const family = row.family;

  // Revocar el token usado
  await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE token = $1', [oldToken]);

  // Generar nuevo token en la misma familia
  const newToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_DAYS * 86400000);
  await pool.query(
    'INSERT INTO refresh_tokens (id, therapist_id, token, family, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [uuidv4(), therapistId, newToken, family, expiresAt]
  );

  return newToken;
}

async function revokeAllRefreshTokens(pool, therapistId) {
  await pool.query(
    'UPDATE refresh_tokens SET revoked = TRUE WHERE therapist_id = $1 AND revoked = FALSE',
    [therapistId]
  );
}

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
    const refreshToken = await createRefreshToken(pool, id);

    // Crear suscripción en trial (14 días)
    await createTrialSubscription(pool, id);

    // Crear Stripe customer (async, no bloquea la respuesta)
    createStripeCustomer(pool, id, email, name).catch(err => {
      logger.error('Error creando Stripe customer en registro', { error: err.message, id });
    });

    logger.info('Terapeuta registrado', { id, email });
    audit({ who: id, role: 'therapist', action: 'register', resource: 'therapist', resourceId: id, ip: req.ip, metadata: { email, name, specialty } });
    setTherapistCookies(res, token, refreshToken);
    res.json({ success: true, therapist: { id, name, email, specialty }, token, refresh_token: refreshToken });
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
    const refreshToken = await createRefreshToken(pool, therapist.id);
    audit({ who: therapist.id, role: 'therapist', action: 'login', resource: 'therapist', resourceId: therapist.id, ip: req.ip });
    setTherapistCookies(res, token, refreshToken);
    res.json({
      success: true,
      therapist: { id: therapist.id, name: therapist.name, email: therapist.email, specialty: therapist.specialty },
      token,
      refresh_token: refreshToken,
    });
  } catch (err) {
    logger.error('Error en login', { error: err.message });
    res.status(500).json({ success: false, error: 'Error del servidor' });
  }
});

// ─── REFRESH TOKEN ────────────────────────────────────────────
router.post('/refresh-token', async (req, res) => {
  try {
    const refresh_token = (req.body && req.body.refresh_token) || getCookie(req, COOKIE_NAMES.therapistRefresh);
    if (!refresh_token) {
      return res.status(400).json({ success: false, error: 'Refresh token requerido' });
    }
    const pool = getPool();

    // Buscar el refresh token
    const { rows } = await pool.query(
      'SELECT rt.*, t.id as tid FROM refresh_tokens rt JOIN therapists t ON t.id = rt.therapist_id WHERE rt.token = $1 AND rt.revoked = FALSE AND rt.expires_at > NOW()',
      [refresh_token]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Refresh token invalido o expirado' });
    }

    const therapistId = rows[0].therapist_id;

    // Rotar: invalidar el viejo, generar uno nuevo
    const newRefreshToken = await rotateRefreshToken(pool, refresh_token, therapistId);
    if (!newRefreshToken) {
      return res.status(401).json({ success: false, error: 'Refresh token invalido, expirado o ya utilizado' });
    }

    // Emitir nuevo access token
    const newAccessToken = jwt.sign({ id: therapistId }, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN });

    audit({ who: therapistId, role: 'therapist', action: 'refresh_token', resource: 'refresh_token', resourceId: therapistId, ip: req.ip });

    setTherapistCookies(res, newAccessToken, newRefreshToken);
    res.json({
      success: true,
      token: newAccessToken,
      refresh_token: newRefreshToken,
    });
  } catch (err) {
    logger.error('Error en refresh token', { error: err.message });
    res.status(500).json({ success: false, error: 'Error del servidor' });
  }
});

// ─── LOGOUT (revocar refresh tokens) ──────────────────────────
router.post('/logout', authWithBilling, async (req, res) => {
  try {
    const pool = getPool();
    await revokeAllRefreshTokens(pool, req.user.id);
    clearTherapistCookies(res);
    logger.info('Sesiones cerradas para terapeuta', { id: req.user.id });
    audit({ who: req.user.id, role: 'therapist', action: 'logout', resource: 'therapist', resourceId: req.user.id, ip: req.ip });
    res.json({ success: true, message: 'Sesion cerrada' });
  } catch (err) {
    logger.error('Error en logout', { error: err.message });
    res.status(500).json({ success: false, error: 'Error del servidor' });
  }
});

// ─── CODIGOS DE CONEXION ──────────────────────────────────────
router.post('/connection-codes', authWithBilling, [
  body('duration_hours').optional().isInt({ min: 1, max: 8760 }),
  body('max_uses').optional().isInt({ min: 1, max: 100 }),
  body('patient_name').optional().trim(),
], validate, async (req, res) => {
  try {
    const { duration_hours = 168, max_uses = 1, patient_name } = req.body;
    const code = generateConnectionCode();
    const id = uuidv4();
    const pool = getPool();
    // expiresAt se calcula en JS (consistente con createRefreshToken) para
    // evitar cualquier ambigüedad de tipos en SQL (integer || text no existe
    // como operador en PostgreSQL y casos similares ya nos han mordido).
    const expiresAt = new Date(Date.now() + duration_hours * 3600 * 1000);

    await pool.query(
      `INSERT INTO connection_codes (id, therapist_id, code, duration_hours, max_uses, uses, expires_at, patient_name)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7)`,
      [id, req.user.id, code, duration_hours, max_uses, expiresAt, patient_name || null]
    );

    res.json({ success: true, code, expires_in_hours: duration_hours, expires_at: expiresAt.toISOString(), max_uses, patient_name: patient_name || null });
  } catch (err) {
    logger.error('Error creando codigo', { error: err.message, code: err.code });
    // Distinguimos causas para que el frontend (www/js/therapist.js →
    // showNewPatient / generateCode) muestre un mensaje accionable y no
    // todos los errores de create-code luzcan iguales cuando el usuario
    // reporta "vuelve a dar error al crear el codigo".
    // SQLSTATE 42703 = undefined_column. Si patient_name es el culprit,
    // significa que migrations/004_add_patient_name.sql no se aplicó a
    // la BD actual y la columna nunca llegó a crearse.
    // SQLSTATE 08006 / 08001 / 57P01 = conexion caída.
    // Resto = genérico (no filtramos SQL al cliente).
    let errorMessage = 'Error al crear codigo';
    if (err && err.code === '42703' && err.message && /patient_name/i.test(err.message)) {
      errorMessage = 'La columna patient_name no existe en la BD. Pidele a soporte tecnico que aplique la migration 004_add_patient_name.sql';
    } else if (err && (err.code === '08006' || err.code === '08001' || err.code === '57P01')) {
      errorMessage = 'Error temporal de conexión con la BD. Reintenta en unos segundos.';
    }
    const statusCode = err && err.code === '42703' && err.message && /patient_name/i.test(err.message)
      ? 200
      : 500;
    res.status(statusCode).json({ success: false, error: errorMessage });
  }
});

router.get('/connection-codes', authWithBilling, async (req, res) => {
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
router.get('/patients', authWithBilling, async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.email, p.phone, p.status, p.created_at, tp.connection_code, tp.connected_at,
        (SELECT mood FROM check_ins WHERE patient_id = p.id ORDER BY created_at DESC LIMIT 1) as last_mood,
        (SELECT anxiety FROM check_ins WHERE patient_id = p.id ORDER BY created_at DESC LIMIT 1) as last_anxiety,
        (SELECT created_at FROM check_ins WHERE patient_id = p.id ORDER BY created_at DESC LIMIT 1) as last_checkin
      FROM patients p JOIN therapist_patients tp ON tp.patient_id = p.id
      WHERE tp.therapist_id = $1 AND tp.status = 'active' ORDER BY tp.connected_at DESC
      LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*) as total FROM therapist_patients WHERE therapist_id = $1 AND status = 'active'",
      [req.user.id]
    );

    res.json({
      success: true,
      patients: rows,
      pagination: { limit, offset, total: parseInt(countRows[0].total) },
    });
  } catch (err) {
    logger.error('Error cargando pacientes', { error: err.message });
    // Incluimos `error` en el body para que el frontend (www/js/therapist.js
    // → getPatients) distinga entre "0 pacientes" (`success:true` con array vacío)
    // y "fallo de carga" (`success:false`). Sin este campo, un catch silencioso
    // en el frontend mostraba el falso mensaje "no tienes pacientes".
    res.status(500).json({ success: false, error: 'Error del servidor al cargar pacientes' });
  }
});

// ─── DASHBOARD ────────────────────────────────────────────────
router.get('/dashboard', authWithBilling, async (req, res) => {
  try {
    const pool = getPool();
    const tid = req.user.id;
    const period = parseInt(req.query.period) || 7;
    const days = Math.min(Math.max(period, 7), 90); // clamp 7–90
    const days2 = days * 2;

    // Todas las queries parametrizadas: $1 = therapist_id, $2 = days (cuando aplica)
    const interval = "(INTERVAL '1 day' * $2)";

    // Ejecutar queries independientes en paralelo
    const [
      activeResult, todayResult, taskResult, riskResult, trendResult, recentResult,
      adherenceResult, sessionResult, patientBreakdownResult, prevPeriodResult,
    ] = await Promise.all([
      pool.query("SELECT COUNT(*) as count FROM therapist_patients WHERE therapist_id = $1 AND status = 'active'", [tid]),
      pool.query("SELECT COUNT(*) as count FROM check_ins ci JOIN therapist_patients tp ON tp.patient_id = ci.patient_id WHERE tp.therapist_id = $1 AND ci.created_at::date = CURRENT_DATE", [tid]),
      pool.query("SELECT COUNT(*) as count FROM assignments a JOIN therapist_patients tp ON tp.patient_id = a.patient_id WHERE tp.therapist_id = $1 AND a.status = 'assigned'", [tid]),
      pool.query('SELECT DISTINCT ON (ci.patient_id) ci.mood FROM check_ins ci JOIN therapist_patients tp ON tp.patient_id = ci.patient_id WHERE tp.therapist_id = $1 ORDER BY ci.patient_id, ci.created_at DESC', [tid]),
      pool.query('SELECT ci.created_at::date as day, ROUND(AVG(ci.mood),1) as avg_mood, ROUND(AVG(ci.anxiety),1) as avg_anxiety, ROUND(AVG(ci.energy),1) as avg_energy, COUNT(*) as checkins FROM check_ins ci JOIN therapist_patients tp ON tp.patient_id = ci.patient_id WHERE tp.therapist_id = $1 AND ci.created_at >= NOW() - ' + interval + ' GROUP BY ci.created_at::date ORDER BY day ASC', [tid, days]),
      pool.query("SELECT 'checkin' as type, ci.patient_id, p.name as patient_name, ci.mood, ci.created_at FROM check_ins ci JOIN therapist_patients tp ON tp.patient_id = ci.patient_id LEFT JOIN patients p ON p.id = ci.patient_id WHERE tp.therapist_id = $1 ORDER BY ci.created_at DESC LIMIT 5", [tid]),
      // Adherencia — assignments en el período
      pool.query("SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE a.status = 'completed')::int as completed FROM assignments a JOIN therapist_patients tp ON tp.patient_id = a.patient_id WHERE tp.therapist_id = $1 AND a.created_at >= NOW() - " + interval, [tid, days]),
      // Sesiones clínicas en el período
      pool.query('SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE cs.status = \'completed\')::int as completed, COALESCE(SUM(cs.duration_min),0)::int as total_min FROM clinical_sessions cs WHERE cs.therapist_id = $1 AND cs.session_date >= NOW() - ' + interval, [tid, days]),
      // Desglose por paciente — ánimo medio por paciente
      pool.query('SELECT p.id as patient_id, p.name, ROUND(AVG(ci.mood),1) as avg_mood, ROUND(AVG(ci.anxiety),1) as avg_anxiety, COUNT(*)::int as checkins, MAX(ci.created_at) as last_checkin FROM check_ins ci JOIN therapist_patients tp ON tp.patient_id = ci.patient_id LEFT JOIN patients p ON p.id = ci.patient_id WHERE tp.therapist_id = $1 AND ci.created_at >= NOW() - ' + interval + ' GROUP BY p.id, p.name ORDER BY avg_mood ASC', [tid, days]),
      // KPIs del período anterior — $1=tid, $2=days2 (2x period), $3=days (current period)
      pool.query('SELECT COUNT(*)::int as checkins FROM check_ins ci JOIN therapist_patients tp ON tp.patient_id = ci.patient_id WHERE tp.therapist_id = $1 AND ci.created_at >= NOW() - (INTERVAL \'1 day\' * $2) AND ci.created_at < NOW() - (INTERVAL \'1 day\' * $3)', [tid, days2, days]),
    ]);

    const activePatients = parseInt(activeResult.rows[0].count);
    const todayCheckins = parseInt(todayResult.rows[0].count);
    const pendingTasks = parseInt(taskResult.rows[0].count);
    const atRisk = riskResult.rows.filter(r => r.mood <= 3).length;

    // Adherencia
    const adherence = {
      total: adherenceResult.rows[0].total,
      completed: adherenceResult.rows[0].completed,
      rate: adherenceResult.rows[0].total > 0 ? Math.round((adherenceResult.rows[0].completed / adherenceResult.rows[0].total) * 100) : 0,
    };

    // Sesiones
    const sessionStats = {
      total: sessionResult.rows[0].total,
      completed: sessionResult.rows[0].completed,
      totalMinutes: sessionResult.rows[0].total_min,
    };

    // Comparación con período anterior
    const prevCheckins = prevPeriodResult.rows[0].checkins;
    const currentCheckins = trendResult.rows.reduce((s, r) => s + parseInt(r.checkins), 0);
    const comparison = {
      checkins: { current: currentCheckins, previous: prevCheckins, delta: currentCheckins - prevCheckins },
    };

    res.json({
      success: true,
      dashboard: {
        activePatients, todayCheckins, pendingTasks, atRisk,
        period: days,
        weeklyTrend: trendResult.rows,
        recentActivity: recentResult.rows,
        adherence,
        sessionStats,
        patientBreakdown: patientBreakdownResult.rows,
        comparison,
      },
    });
  } catch (err) {
    logger.error('Error dashboard', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── DESCONECTAR PACIENTE ───────────────────────────────────
// Soft-disconnect: marca el vínculo therapist_patients como 'inactive'
// en vez de borrar la fila. Conserva el historial clínico (check-ins,
// mensajes, tareas, objetivos, notas) para consulta futura y para
// eventuales re-links. El paciente sigue pudiendo usar su app con el
// auth_token existente, pero no podrá enviar mensajes nuevos a este
// terapeuta (porque messages POST requiere status='active').
router.delete('/patients/:patientId/connections', authWithBilling, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { reason } = req.body || {};
    const pool = getPool();

    // Verificar que el terapeuta tiene un vínculo con este paciente
    // (activo o previamente inactivo). No devolvemos 404 si el vínculo
    // existe pero ya está inactivo: la operación es idempotente.
    const { rows: linkRows } = await pool.query(
      'SELECT id, status FROM therapist_patients WHERE therapist_id = $1 AND patient_id = $2',
      [req.user.id, patientId]
    );
    if (linkRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Vínculo con el paciente no encontrado' });
    }
    if (linkRows[0].status !== 'active') {
      return res.json({ success: true, message: 'El paciente ya estaba desconectado', already_inactive: true });
    }

    await pool.query(
      "UPDATE therapist_patients SET status = 'inactive' WHERE id = $1",
      [linkRows[0].id]
    );

    // Notificar al paciente para que sepa por qué sus próximos intentos de
    // enviar mensajes rebotarán con 400. Si el cliente está abierto verá esto
    // en su panel de notificaciones; si no, lo verá cuando vuelva a entrar.
    // La notificación es best-effort: si falla, el disconnect ya quedó hecho
    // en la fila therapist_patients — no queremos revertir ni devolver 500 al
    // terapeuta por un problema de notificaciones.
    try {
      await createNotification(
        pool,
        patientId,
        'system',
        'Tu terapeuta termin\u00f3 la conexi\u00f3n',
        'Ya no podr\u00e1s enviarle mensajes nuevos. El historial cl\u00ednico se conserva.',
        null
      );
    } catch (notifErr) {
      logger.warn('No se pudo notificar al paciente tras disconnect', { error: notifErr.message, patientId });
    }

    // El paciente debe ver "tu terapeuta terminó la conexión" sin reabrir la
    // app. notification:new lo entrega createNotification arriba; aquí emitimos
    // connection:terminated para que el cliente pueda diferenciar este caso
    // (ej: mostrar un modal persistente "coneión finalizada" además del toast).
    bus.publish(bus.topicFor('patient', patientId), 'connection:terminated', { patientId });

    // El propio terapeuta también debe enterarse en sus pestañas abiertas
    // (multipestaña). listener del frontend -> cerrar modal y refrescar lista.
    bus.publish(bus.topicFor('therapist', req.user.id), 'connection:terminated', { patientId, by: 'self' });

    auditChange(req, 'disconnect_patient', 'therapist_patient', linkRows[0].id, {
      patientId,
      reason: reason ? String(reason).slice(0, 500) : null,
    });

    res.json({ success: true, message: 'Paciente desconectado', patient_id: patientId });
  } catch (err) {
    logger.error('Error desconectando paciente', { error: err.message });
    res.status(500).json({ success: false, error: 'Error del servidor al desconectar' });
  }
});

// ─── PERFIL DE PACIENTE ──────────────────────────────────────
router.get('/patients/:patientId', authWithBilling, async (req, res) => {
  try {
    const pool = getPool();
    const { patientId } = req.params;
    const limitCheckins = Math.min(parseInt(req.query.limit_checkins) || 50, 100);
    const limitMessages = Math.min(parseInt(req.query.limit_messages) || 100, 200);

    const { rows: connRows } = await pool.query(
      'SELECT * FROM therapist_patients WHERE therapist_id = $1 AND patient_id = $2',
      [req.user.id, patientId]
    );
    if (connRows.length === 0) return res.status(404).json({ success: false, error: 'Paciente no encontrado' });

    auditAccess(req, 'view_patient', patientId);

    const { rows: patientRows } = await pool.query('SELECT * FROM patients WHERE id = $1', [patientId]);
    if (patientRows.length === 0) return res.status(404).json({ success: false, error: 'Paciente no encontrado' });

    const { rows: checkIns } = await pool.query('SELECT * FROM check_ins WHERE patient_id = $1 ORDER BY created_at DESC LIMIT $2', [patientId, limitCheckins]);
    const { rows: messages } = await pool.query('SELECT * FROM messages WHERE patient_id = $1 ORDER BY created_at DESC LIMIT $2', [patientId, limitMessages]);
    const { rows: assignments } = await pool.query('SELECT * FROM assignments WHERE patient_id = $1 ORDER BY created_at DESC', [patientId]);
    const { rows: goals } = await pool.query('SELECT * FROM goals WHERE patient_id = $1 ORDER BY created_at DESC', [patientId]);

    const patient = patientRows[0];
    const metrics = calculateMetrics(checkIns);

    // Enriquece assignments con la última sesión clínica (mergeada: sensibles
    // descifrados del blob + no sensibles del JSONB), para que el frontend
    // del terapeuta pueda mostrar el panel "Ver respuestas" inline sin pedir
    // un round-trip adicional. Para assignments sin sesión o de kind 'classic'
    // el campo queda explícitamente en null (criterio uniforme del contrato).
    const decryptedAssignments = decryptAssignments(assignments);
    const latestByAssignment = await fetchLatestSessionsForAssignments(pool, patientId, decryptedAssignments);
    const enrichedAssignments = decryptedAssignments.map(a => {
      // Pre-resolver el schema efectivo (incluye variante mode/phobia) para
      // que el frontend del terapeuta pueda pintar respuestas estructuradas
      // sin conocer las discriminantes internas del backend.
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
          responses: decodeSessionResponses(sess, a),
        },
      };
    });

    res.json({
      success: true,
      patient: { ...patient, checkIns: decryptCheckIns(checkIns), messages: decryptMessages(messages), assignments: enrichedAssignments, goals, metrics },
    });
  } catch (err) {
    logger.error('Error perfil paciente', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── MEMORIA TERAPÉUTICA AUMENTADA (Pre-sesión) ──────────────
// Sintetiza cambios emocionales, eventos importantes y adherencia a
// ejercicios desde la última sesión (última nota clínica o últimos 14 días).
// El terapeuta ve esta vista antes de abrir el chat con el paciente.
router.get('/patients/:patientId/pre-session', authWithBilling, async (req, res) => {
  try {
    const pool = getPool();
    const { patientId } = req.params;

    const { rows: connRows } = await pool.query(
      "SELECT * FROM therapist_patients WHERE therapist_id = $1 AND patient_id = $2 AND status = 'active'",
      [req.user.id, patientId]
    );
    if (connRows.length === 0) return res.status(404).json({ success: false, error: 'Paciente no encontrado' });

    // ── 1. Última nota clínica (proxy de "última sesión") ──────
    const { rows: lastNoteRows } = await pool.query(
      'SELECT session_date FROM clinical_sessions WHERE patient_id = $1 AND therapist_id = $2 ORDER BY session_date DESC LIMIT 1',
      [patientId, req.user.id]
    );
    const lastSessionDate = lastNoteRows.length > 0 ? lastNoteRows[0].created_at : null;
    const sinceDate = lastSessionDate
      ? lastSessionDate.toISOString()
      : new Date(Date.now() - 14 * 86400000).toISOString();
    const daysSinceLastSession = lastSessionDate
      ? Math.round((Date.now() - new Date(lastSessionDate).getTime()) / 86400000)
      : null;

    // ── 2. Check-ins emocionales (14 días para tendencia) ─────
    const { rows: checkIns } = await pool.query(
      'SELECT mood, anxiety, energy, created_at FROM check_ins WHERE patient_id = $1 AND created_at >= NOW() - INTERVAL \'14 days\' ORDER BY created_at ASC',
      [patientId]
    );

    // Tendencia: comparar primera mitad vs segunda mitad
    let emotionalTrend = { direction: 'no_data', current: null, previous: null, weeklyBreakdown: [] };
    if (checkIns.length >= 4) {
      const mid = Math.floor(checkIns.length / 2);
      const firstHalf = checkIns.slice(0, mid);
      const secondHalf = checkIns.slice(mid);
      const avg = (arr, field) => +(arr.reduce((s, c) => s + (c[field] || 5), 0) / arr.length).toFixed(1);
      emotionalTrend.previous = { mood: avg(firstHalf, 'mood'), anxiety: avg(firstHalf, 'anxiety'), energy: avg(firstHalf, 'energy') };
      emotionalTrend.current = { mood: avg(secondHalf, 'mood'), anxiety: avg(secondHalf, 'anxiety'), energy: avg(secondHalf, 'energy') };
      const moodDelta = emotionalTrend.current.mood - emotionalTrend.previous.mood;
      if (moodDelta >= 1.5) emotionalTrend.direction = 'improving';
      else if (moodDelta <= -1.5) emotionalTrend.direction = 'declining';
      else emotionalTrend.direction = 'stable';
    } else if (checkIns.length >= 1) {
      const latest = checkIns[checkIns.length - 1];
      emotionalTrend.current = { mood: latest.mood, anxiety: latest.anxiety, energy: latest.energy || 5 };
      emotionalTrend.direction = 'insufficient_data';
    }

    // Desglose diario (últimos 14 días)
    const dailyMap = {};
    checkIns.forEach(c => {
      const day = new Date(c.created_at).toISOString().slice(0, 10);
      if (!dailyMap[day]) dailyMap[day] = { day, moods: [], anxieties: [], energies: [] };
      dailyMap[day].moods.push(c.mood);
      dailyMap[day].anxieties.push(c.anxiety);
      dailyMap[day].energies.push(c.energy || 5);
    });
    emotionalTrend.weeklyBreakdown = Object.values(dailyMap).map(d => ({
      day: d.day,
      mood: +(d.moods.reduce((a, b) => a + b, 0) / d.moods.length).toFixed(1),
      anxiety: +(d.anxieties.reduce((a, b) => a + b, 0) / d.anxieties.length).toFixed(1),
      energy: +(d.energies.reduce((a, b) => a + b, 0) / d.energies.length).toFixed(1),
      count: d.moods.length,
    })).sort((a, b) => a.day.localeCompare(b.day));

    // ── 3. Eventos clave desde la última sesión ─────────────────
    const keyEvents = [];

    // Picos/bajones de ánimo
    if (checkIns.length >= 3) {
      const moods = checkIns.map(c => ({ mood: c.mood, date: c.created_at }));
      const maxMood = moods.reduce((a, b) => b.mood > a.mood ? b : a, moods[0]);
      const minMood = moods.reduce((a, b) => b.mood < a.mood ? b : a, moods[0]);
      if (maxMood.mood >= 8) {
        keyEvents.push({
          type: 'mood_spike',
          description: 'Pico de ánimo positivo: ' + maxMood.mood + '/10',
          date: maxMood.date,
          icon: '😊',
          severity: 'positive',
        });
      }
      if (minMood.mood <= 3) {
        keyEvents.push({
          type: 'mood_drop',
          description: 'Bajón de ánimo: ' + minMood.mood + '/10',
          date: minMood.date,
          icon: '⚠️',
          severity: 'warning',
        });
      }
    }

    // Ansiedad elevada
    if (checkIns.length >= 1) {
      const highAnxiety = checkIns.filter(c => c.anxiety >= 8);
      if (highAnxiety.length >= 2) {
        keyEvents.push({
          type: 'anxiety_spike',
          description: highAnxiety.length + ' episodios de ansiedad elevada (≥8/10)',
          date: highAnxiety[highAnxiety.length - 1].created_at,
          icon: '😰',
          severity: 'warning',
        });
      }
    }

    // Mensajes del paciente sin leer
    const { rows: unreadRows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM messages WHERE patient_id = $1 AND is_therapist = FALSE AND created_at >= $2::timestamptz',
      [patientId, sinceDate]
    );
    if (unreadRows[0].count > 0) {
      keyEvents.push({
        type: 'messages',
        description: unreadRows[0].count + ' mensaje' + (unreadRows[0].count === 1 ? '' : 's') + ' del paciente desde la última sesión',
        count: unreadRows[0].count,
        icon: '💬',
        severity: 'info',
      });
    }

    // Asignaciones completadas
    const { rows: completedSince } = await pool.query(
      "SELECT id, title FROM assignments WHERE patient_id = $1 AND status = 'completed' AND completed_at >= $2::timestamptz ORDER BY completed_at DESC LIMIT 5",
      [patientId, sinceDate]
    );
    completedSince.forEach(a => {
      keyEvents.push({
        type: 'assignment_completed',
        description: 'Completó: "' + a.title + '"',
        icon: '✅',
        severity: 'positive',
      });
    });

    // Metas con progreso
    const { rows: activeGoals } = await pool.query(
      'SELECT id, title, metric, current_value, target_value, status FROM goals WHERE patient_id = $1 AND status = \'active\' ORDER BY created_at DESC LIMIT 5',
      [patientId]
    );
    activeGoals.forEach(g => {
      const pct = g.target_value > 0 ? Math.round((g.current_value / g.target_value) * 100) : 0;
      if (pct >= 50) {
        keyEvents.push({
          type: 'goal_progress',
          description: 'Progreso en "' + g.title + '": ' + g.current_value + '/' + g.target_value + ' (' + pct + '%)',
          icon: '🎯',
          severity: pct >= 80 ? 'positive' : 'info',
        });
      }
    });

    // ── 4. Adherencia a ejercicios ────────────────────────────
    const { rows: allAssignments } = await pool.query(
      'SELECT id, title, status, exercise_kind, due_date FROM assignments WHERE patient_id = $1 ORDER BY created_at DESC',
      [patientId]
    );
    const totalAssignments = allAssignments.length;
    const completedAssignments = allAssignments.filter(a => a.status === 'completed').length;
    const pendingAssignments = totalAssignments - completedAssignments;
    const completionRate = totalAssignments > 0 ? Math.round((completedAssignments / totalAssignments) * 100) : 0;

    // Trending: cuántas completó en los últimos 7 días vs penúltimos 7
    const last7 = allAssignments.filter(a => a.status === 'completed' && a.completed_at && new Date(a.completed_at) >= new Date(Date.now() - 7 * 86400000)).length;
    const prev7 = allAssignments.filter(a => a.status === 'completed' && a.completed_at && new Date(a.completed_at) >= new Date(Date.now() - 14 * 86400000) && new Date(a.completed_at) < new Date(Date.now() - 7 * 86400000)).length;

    // Clinical exercise sessions
    const { rows: sessions } = await pool.query(
      'SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_complete)::int AS completed FROM exercise_sessions WHERE patient_id = $1',
      [patientId]
    );

    const adherence = {
      totalAssignments,
      completedAssignments,
      pendingAssignments,
      completionRate,
      recentCompletions: last7,
      previousCompletions: prev7,
      completionTrend: last7 > prev7 ? 'up' : last7 < prev7 ? 'down' : prev7 === 0 && last7 === 0 ? 'none' : 'stable',
      totalSessions: sessions[0].total,
      completedSessions: sessions[0].completed,
    };

    // ── 5. Métricas generales ─────────────────────────────────
    const { rows: streakRows } = await pool.query(
      'SELECT created_at::date as day FROM check_ins WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 30',
      [patientId]
    );
    let streakDays = 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 0; i < streakRows.length; i++) {
      const d = new Date(streakRows[i].day); d.setHours(0, 0, 0, 0);
      const expected = new Date(today); expected.setDate(expected.getDate() - streakDays);
      if (d.getTime() === expected.getTime()) streakDays++;
      else if (d.getTime() < expected.getTime()) break;
    }

    const latestCheckIn = checkIns.length > 0 ? checkIns[checkIns.length - 1] : null;

    // ── 6. Resumen narrativo ──────────────────────────────────
    let summary = '';
    const patientName = connRows[0].patient_name || 'El paciente';
    if (emotionalTrend.direction === 'no_data' || emotionalTrend.direction === 'insufficient_data') {
      summary = 'Aún no hay suficientes check-ins para detectar una tendencia emocional.';
    } else {
      const dirLabel = emotionalTrend.direction === 'improving' ? 'mejora' : emotionalTrend.direction === 'declining' ? 'disminución' : 'estabilidad';
      const moodWord = emotionalTrend.current && emotionalTrend.current.mood >= 7 ? 'positivo' : emotionalTrend.current && emotionalTrend.current.mood <= 3 ? 'bajo' : 'moderado';
      summary = patientName + ' muestra ' + dirLabel + ' en estado de ánimo (' + (emotionalTrend.current ? emotionalTrend.current.mood : '?') + '/10, nivel ' + moodWord + '). ';
      if (adherence.totalAssignments > 0) {
        summary += 'Adherencia a ejercicios: ' + adherence.completionRate + '% (' + adherence.completedAssignments + '/' + adherence.totalAssignments + ' tareas). ';
      }
      if (streakDays >= 3) {
        summary += 'Registro diario durante ' + streakDays + ' días consecutivos. ';
      }
      if (keyEvents.filter(e => e.severity === 'warning').length > 0) {
        summary += '⚠️ Atención: se detectaron señales de alerta. Revisa los eventos clave.';
      }
    }

    res.json({
      success: true,
      preSession: {
        emotionalTrend,
        keyEvents: keyEvents.slice(0, 10),
        adherence,
        metrics: {
          streakDays,
          totalCheckIns: checkIns.length,
          lastCheckIn: latestCheckIn ? latestCheckIn.created_at : null,
          lastCheckInMood: latestCheckIn ? latestCheckIn.mood : null,
        },
        summary,
        lastSessionDate,
        daysSinceLastSession,
      },
    });
  } catch (err) {
    logger.error('Error pre-sesión', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── MENSAJES DEL TERAPEUTA ───────────────────────────────────
router.post('/patients/:patientId/messages', authWithBilling, async (req, res) => {
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
    // createNotification ahora es awaitable: el INSERT y el bus.publish
    // se confirman antes de que el terapeuta reciba el res.json. Antes era
    // fire-and-forget y el test que cuenta notifications del paciente justo
    // despues del POST /messages hacia una carrera: el INSERT podia no estar
    // commiteado cuando el siguiente GET /notifications ya se ejecutaba. Hoy
    // el orden a)INSERT b)bus.publish c)res.json es estricto desde la BD.
    await createNotification(pool, patientId, 'message', 'Nuevo mensaje de tu terapeuta', preview, msgId);
    auditChange(req, 'send_message', 'message', msgId, { patientId });

    // Publicar al propio terapeuta (multipestaña/modal abierto) y al paciente.
    // La notificación system del paciente ya es entregada por createNotification;
    // aquí emitimos adicionalmente `message:new` para cualquier handler que
    // escuche el chat del paciente (badge de mensajes no leídos en tiempo real).
    bus.publish(bus.topicFor('therapist', req.user.id), 'message:new', {
      patientId, messageId: msgId, from: 'therapist',
    });
    bus.publish(bus.topicFor('patient', patientId), 'message:new', {
      patientId, messageId: msgId, from: 'therapist',
    });

    // Push notification nativa (FCM) — best-effort, no bloquea la respuesta
    fcm.sendToPatient(patientId, {
      title: 'Nuevo mensaje de tu terapeuta',
      body: preview,
    }).catch(err => logger.warn('[Push] Error enviando push de mensaje', { error: err.message, patientId }));

    res.json({ success: true, message_id: msgId });
  } catch (err) {
    logger.error('Error enviando mensaje', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── ASIGNACIONES ────────────────────────────────────────────
router.post('/patients/:patientId/assignments', authWithBilling, async (req, res) => {
  try {
    const { patientId } = req.params;
    const {
      type, title, instructions, due_date,
      // Nuevos (migration 007): exercise_kind indica si el paciente recibirá
      // un formulario interactivo (thought_record | behavioral_activation |
      // graded_exposure) o solo instrucciones de texto (classic, default).
      // exercise_schema es el snapshot del schema embebido en la asignación:
      // se congela la versión clínica que verá el paciente aunque el
      // terapeuta edite la plantilla después (consistencia clínica para
      // tareas ya asignadas). Esta es la razón por la cual guardamos el
      // schema en assignments y no solo en task_templates.
      exercise_kind = 'classic', exercise_schema: clientSchema = null,
      mode = null, phobia = null,
    } = req.body;
    if (!type || !title || !instructions) return res.status(400).json({ success: false, error: 'Tipo, titulo e instrucciones requeridos' });
    if (!KINDS.includes(exercise_kind)) {
      return res.status(400).json({ success: false, error: 'exercise_kind inválido. Valores: ' + KINDS.join(', ') });
    }

    // ── RBAC: verificar que el paciente está activamente vinculado al
    // terapeuta autenticado. Sin esto, un terapeuta autenticado cualquiera
    // podría inyectar assignments (incluidos esquemas clínicos con datos
    // sensibles encriptados posteriormente) en el historial de un paciente
    // que NO es suyo. La PHI solo es legible para el terapeuta vinculado
    // via la ROW therapist_patients.status='active', pero el INSERT sin
    // check crea filas que impactan métricas/búsquedas del paciente
    // objetivo y ensucian su historial clínico.
    //
    // Patrón ya usado en GET /patients/:id (mismo archivo, ~línea 540):
    // 404 si no hay vínculo activo. Usamos 404 (no 403) para no filtrar
    // la existencia del paciente a terceros (side-channel defense).
    const pool0 = getPool();
    const { rows: connRows0 } = await pool0.query(
      "SELECT id FROM therapist_patients WHERE therapist_id = $1 AND patient_id = $2 AND status = 'active'",
      [req.user.id, patientId]
    );
    if (connRows0.length === 0) {
      return res.status(404).json({ success: false, error: 'Paciente no encontrado' });
    }

    // Resolver el schema efectivo. Para 'classic' forzamos null.
    //   • Con clientSchema en body → validar (PUT del editor clínico).
    //   • Sin clientSchema → getSchema() con discriminantes (create
    //     desde catálogo estático).
    let resolvedSchema = null;
    if (exercise_kind !== 'classic') {
      if (clientSchema && typeof clientSchema === 'object' && !Array.isArray(clientSchema)) {
        const v = validateSchemaDefinition(clientSchema, exercise_kind);
        if (!v.valid) {
          return res.status(422).json({ success: false, error: 'Schema inválido', errors: v.errors });
        }
        resolvedSchema = v.schema;
      } else {
        resolvedSchema = getSchema(exercise_kind, null, { mode, phobia });
        if (!resolvedSchema) {
          return res.status(400).json({ success: false, error: 'schema no encontrado para ' + exercise_kind });
        }
      }
    }

    const pool = getPool();
    const assignId = uuidv4();
    await pool.query(
      'INSERT INTO assignments (id, therapist_id, patient_id, type, title, instructions, due_date, exercise_kind, exercise_schema) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [assignId, req.user.id, patientId, type, title, encrypt(instructions), due_date || null, exercise_kind, resolvedSchema ? JSON.stringify(resolvedSchema) : null]
    );

    auditChange(req, 'create_assignment', 'assignment', assignId, { patientId, type, title, exercise_kind });

    const dueMsg = due_date ? ' (vence: ' + new Date(due_date).toLocaleDateString('es-ES') + ')' : '';
    // await: ver comentario en POST /patients/:id/messages arriba. La unica
    // diferencia entre rutas aca es que assignment crea ademas un
    // bus.publish('task:assigned'); ambos quedan ahora garantizados en orden
    // respecto al res.json.
    await createNotification(pool, patientId, 'assignment', 'Nueva tarea asignada', '"' + title + '"' + dueMsg, assignId);

    bus.publish(bus.topicFor('patient', patientId), 'task:assigned', {
      patientId, assignmentId: assignId, title, type, due_date: due_date || null,
    });

    // Push notification nativa (FCM)
    fcm.sendToPatient(patientId, {
      title: 'Nueva tarea asignada',
      body: '"' + title + '"' + dueMsg,
    }).catch(err => logger.warn('[Push] Error push de tarea', { error: err.message, patientId }));

    res.json({ success: true, assignment_id: assignId });
  } catch (err) {
    logger.error('Error creando tarea', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.put('/patients/:patientId/assignments/:assignmentId', authWithBilling, async (req, res) => {
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
router.post('/patients/:patientId/goals', authWithBilling, async (req, res) => {
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

    auditChange(req, 'create_goal', 'goal', goalId, { patientId, title, metric, target_value });
    // await: ver comentario en POST /patients/:id/messages.
    await createNotification(pool, patientId, 'goal', 'Nuevo objetivo', '"' + title + '" - Meta: ' + target_value + ' (' + duration_days + ' dias)', goalId);

    bus.publish(bus.topicFor('patient', patientId), 'goal:new', { patientId, goalId, title, metric, target_value, duration_days });

    res.json({ success: true, goal_id: goalId });
  } catch (err) {
    logger.error('Error creando objetivo', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.put('/patients/:patientId/goals/:goalId', authWithBilling, async (req, res) => {
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
        // await: ver comentario en POST /patients/:id/messages. Solo emite
        // notification cuando current_value != undefined y la meta existe;
        // si falla el INSERT, createNotification lo loggea y retorna null,
        // pero el UPDATE del goal ya commiteo antes — eso es deseable: la
        // notificacion es best-effort mientras el progreso del goal es
        // siempre durable.
        await createNotification(pool, patientId, 'goal', 'Actualizacion de objetivo', '"' + goal.title + '" - ' + msg, goalId);
      }
    } else if (status) {
      await pool.query('UPDATE goals SET status = $1 WHERE id = $2 AND patient_id = $3', [status, goalId, patientId]);
      if (status === 'completed') {
        const { rows: goalRows } = await pool.query('SELECT title FROM goals WHERE id = $1', [goalId]);
        if (goalRows.length > 0) {
          // await: ver comentario en POST /patients/:id/messages.
          await createNotification(pool, patientId, 'goal', 'Objetivo completado', 'Felicidades! Alcanzaste "' + goalRows[0].title + '"', goalId);
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
router.get('/calendar', authWithBilling, async (req, res) => {
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

// GET single session for efficient edit
router.get('/patients/:patientId/clinical-sessions/:sessionId', authWithBilling, async (req, res) => {
  try {
    const { patientId, sessionId } = req.params;
    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT * FROM clinical_sessions WHERE id = $1 AND patient_id = $2 AND therapist_id = $3',
      [sessionId, patientId, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
    res.json({ success: true, session: rows[0] });
  } catch (err) {
    logger.error('Error cargando sesión', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── NOTAS CLINICAS ───────────────────────────────────────────
router.get('/patients/:patientId/clinical-notes', authWithBilling, async (req, res) => {
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

router.post('/patients/:patientId/clinical-notes', authWithBilling, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { subjective, objective, assessment, plan, session_id } = req.body;
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
      'INSERT INTO clinical_notes (id, patient_id, therapist_id, subjective, objective, assessment, plan, session_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, patientId, req.user.id, subjective || null, objective || null, assessment || null, plan || null, session_id || null]
    );
    const { rows: noteRows } = await pool.query('SELECT * FROM clinical_notes WHERE id = $1', [id]);
    auditChange(req, 'create_clinical_note', 'clinical_note', id, { patientId });

    // Las notas SOAP son internas del terapeuta (no se notifican al paciente
    // hasta que decidas exponer una versión "amigable" como propusimos en la
    // lista de features). Solo emitimos al propio terapeuta para sincronizar
    // pestañas (e.g. un modal abierto mostrando notas).
    bus.publish(bus.topicFor('therapist', req.user.id), 'note:created', { patientId, noteId: id });

    res.json({ success: true, note: noteRows[0] });
  } catch (err) {
    logger.error('Error creando nota', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.put('/patients/:patientId/clinical-notes/:noteId', authWithBilling, async (req, res) => {
  try {
    const { patientId, noteId } = req.params;
    const { subjective, objective, assessment, plan, session_id } = req.body;
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
      session_id: session_id !== undefined ? (session_id || null) : note.session_id,
    };
    await pool.query(
      "UPDATE clinical_notes SET subjective=$1, objective=$2, assessment=$3, plan=$4, session_id=$5, updated_at=NOW() WHERE id=$6 AND therapist_id=$7",
      [fields.subjective, fields.objective, fields.assessment, fields.plan, fields.session_id, noteId, req.user.id]
    );
    auditChange(req, 'update_clinical_note', 'clinical_note', noteId, { patientId });
    res.json({ success: true, note: { ...note, ...fields, updated_at: new Date().toISOString() } });
  } catch (err) {
    logger.error('Error actualizando nota', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.delete('/patients/:patientId/clinical-notes/:noteId', authWithBilling, async (req, res) => {
  try {
    const { patientId, noteId } = req.params;
    const pool = getPool();
    const { rows: noteRows } = await pool.query(
      'SELECT * FROM clinical_notes WHERE id = $1 AND patient_id = $2 AND therapist_id = $3',
      [noteId, patientId, req.user.id]
    );
    if (noteRows.length === 0) return res.status(404).json({ success: false, error: 'Nota no encontrada' });

    await pool.query('DELETE FROM clinical_notes WHERE id = $1 AND therapist_id = $2', [noteId, req.user.id]);
    auditChange(req, 'delete_clinical_note', 'clinical_note', noteId, { patientId });
    res.json({ success: true, message: 'Nota eliminada' });
  } catch (err) {
    logger.error('Error eliminando nota', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── BIBLIOTECA TCC ───────────────────────────────────────────
router.get('/task-templates', authWithBilling, async (req, res) => {
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

// ─── SCHEMAS DE EJERCICIOS CLÍNICOS ────────────────────────────
// Devuelve la definición del schema efectivo para `kind` + discriminants.
// El terapeuta lo consume cuando crea una plantilla clínica, para que el
// paciente reciba un formulario interactivo (no solo instrucciones en texto).
//
//   ?kind=behavioral_activation&mode=diary     → BA diario
//   ?kind=behavioral_activation&mode=schedule  → BA plan semanal
//   ?kind=graded_exposure&phobia=agoraphobia   → GE agorafobia
//   ?kind=graded_exposure&phobia=social_anxiety → GE ansiedad social
//   ?kind=graded_exposure&phobia=claustrophobia → GE claustrofobia
//   ?kind=thought_record                        → TR Beck
//
// Para 'classic' devolvemos 400: no tiene schema, el paciente solo recibe
// instrucciones de texto y marca completada (caso legacy preservado por
// default en migration 007). La resolución sigue la prioridad de
// utils/exerciseSchemas.js → getSchema(): BD gana, estático fallback.
router.get('/exercise-schemas', authWithBilling, async (req, res) => {
  try {
    const { kind, mode, phobia } = req.query;
    if (!kind) {
      return res.status(400).json({ success: false, error: 'kind requerido (thought_record | behavioral_activation | graded_exposure)' });
    }
    if (!KINDS.includes(kind)) {
      return res.status(400).json({ success: false, error: 'kind inválido. Valores: ' + KINDS.join(', ') });
    }
    if (kind === 'classic') {
      return res.status(400).json({ success: false, error: 'classic no tiene schema (instrucciones en texto plano)' });
    }
    const schema = getSchema(kind, null, { mode, phobia });
    if (!schema) {
      return res.status(404).json({ success: false, error: 'schema no encontrado para ' + kind });
    }
    res.json({ success: true, kind, mode: mode || null, phobia: phobia || null, schema });
  } catch (err) {
    logger.error('Error cargando exercise-schema', { error: err.message });
    res.status(500).json({ success: false, error: 'Error al cargar schema' });
  }
});

router.post('/task-templates', authWithBilling, async (req, res) => {
  try {
    const {
      category, title, instructions,
      difficulty = 'media', duration_min = 30,
      // Nuevos (migration 007): si el terapeuta elige un kind clínico,
      // ejercicio_schema es opcional. Si no viene, resolvemos el estático
      // desde utils/exerciseSchemas.js usando los discriminantes. Si el
      // cliente manda un schema custom, validamos que tenga `fields` válido
      // y se prefiere sobre el estático (la BD es source-of-truth clínico).
      exercise_kind = 'classic', exercise_schema: clientSchema = null,
      // Discriminantes para que el terapeuta elija entre BA diary vs
      // schedule y entre las 3 fobias de GE ya en el form de creación.
      mode = null, phobia = null,
    } = req.body;
    if (!category || !title || !instructions) return res.status(400).json({ success: false, error: 'Categoria, titulo e instrucciones requeridos' });
    if (!['baja', 'media', 'alta'].includes(difficulty)) return res.status(400).json({ success: false, error: 'Dificultad: baja, media o alta' });
    if (!KINDS.includes(exercise_kind)) {
      return res.status(400).json({ success: false, error: 'exercise_kind inválido. Valores: ' + KINDS.join(', ') });
    }

    // Para kinds clínicos resolvemos el schema efectivo (BD si trae fields
    // válidos, estático en otro caso). Para 'classic' forzamos schema=NULL.
    let resolvedSchema = null;
    if (exercise_kind !== 'classic') {
      resolvedSchema = getSchema(exercise_kind, clientSchema, { mode, phobia });
      if (!resolvedSchema) {
        return res.status(400).json({ success: false, error: 'schema no encontrado para ' + exercise_kind });
      }
    }

    const pool = getPool();
    const id = uuidv4();
    await pool.query(
      'INSERT INTO task_templates (id, therapist_id, category, title, instructions, difficulty, duration_min, exercise_kind, exercise_schema) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [id, req.user.id, category.trim(), title.trim(), instructions.trim(), difficulty, duration_min, exercise_kind, resolvedSchema ? JSON.stringify(resolvedSchema) : null]
    );
    res.json({
      success: true,
      template: {
        id, therapist_id: req.user.id,
        category: category.trim(), title: title.trim(), instructions: instructions.trim(),
        difficulty, duration_min,
        exercise_kind,
        // Devolvemos el schema efectivo para que el cliente pueda pintar el
        // formulario interactivo sin round-trip extra. La BD guarda el mismo
        // JSON. Para classic queda explícitamente null.
        exercise_schema: resolvedSchema,
      }
    });
  } catch (err) {
    // 23514 (check_violation) si por alguna razón se cuela un kind que
    // burla el filtro en memoria; 42703 si la columna no existe (migration
    // 007 no aplicada). Mensaje accionable para el usuario final.
    logger.error('Error creando template', { error: err.message });
    let errorMessage = 'Error al crear plantilla';
    if (err && err.code === '23514' && err.message && /exercise_kind/i.test(err.message)) {
      errorMessage = 'La CHECK constraint de exercise_kind rechazó el valor. Verifica que kind esté en la whitelist del backend.';
    } else if (err && err.code === '42703' && err.message && /exercise_kind|exercise_schema/i.test(err.message)) {
      errorMessage = 'Las columnas exercise_kind/exercise_schema no existen. Pídele a soporte técnico que corra migrations/007_embedded_exercises.sql';
    }
    res.status(500).json({ success: false, error: errorMessage });
  }
});

router.put('/task-templates/:id', authWithBilling, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      category, title, instructions, difficulty, duration_min,
      // Update de exercise_kind/schema: si vienen, validamos y re-resolvemos.
      exercise_kind, exercise_schema: clientSchema,
      mode, phobia,
    } = req.body;
    const pool = getPool();
    const { rows: tmplRows } = await pool.query('SELECT * FROM task_templates WHERE id = $1 AND therapist_id = $2', [id, req.user.id]);
    if (tmplRows.length === 0) return res.status(404).json({ success: false, error: 'Plantilla no encontrada' });

    if (difficulty && !['baja', 'media', 'alta'].includes(difficulty)) return res.status(400).json({ success: false, error: 'Dificultad: baja, media o alta' });
    if (exercise_kind !== undefined && !KINDS.includes(exercise_kind)) {
      return res.status(400).json({ success: false, error: 'exercise_kind inválido. Valores: ' + KINDS.join(', ') });
    }

    const tmpl = tmplRows[0];
    const finalKind = exercise_kind !== undefined ? exercise_kind : tmpl.exercise_kind || 'classic';
    let finalSchema = tmpl.exercise_schema || null;
    if (finalKind !== 'classic') {
      // Tres paths posibles para el resolver el schema efectivo de la plantilla:
      //   • clientSchema presente en body → validar estructura (PUT completo
      //     desde el editor clínico del frontend). Rechaza con 422 si inválido.
      //   • clientSchema ausente + kind clínico → preservar el schema actual
      //     de la fila (ediciones a campos básicos: category/instructions/
      //     difficulty/duration. NO toca exercise_schema).
      //   • kind cambia entre clínico y classic → re-resolver o forzar null.
      if (clientSchema !== undefined && clientSchema !== null && typeof clientSchema === 'object' && !Array.isArray(clientSchema)) {
        const v = validateSchemaDefinition(clientSchema, finalKind);
        if (!v.valid) {
          return res.status(422).json({ success: false, error: 'Schema inválido', errors: v.errors });
        }
        finalSchema = v.schema;
      } else if (finalSchema && finalSchema.schema_version) {
        // Mantener el schema actual; no tocamos fields ni guidance aquí.
        // Esto preserva el snapshot de la plantilla para asignaciones futuras.
      } else {
        finalSchema = getSchema(finalKind, null, {
          mode: mode !== undefined ? mode : (tmpl.exercise_schema && tmpl.exercise_schema.mode),
          phobia: phobia !== undefined ? phobia : (tmpl.exercise_schema && tmpl.exercise_schema.phobia),
        });
        if (!finalSchema) {
          return res.status(400).json({ success: false, error: 'schema no encontrado para ' + finalKind });
        }
      }
    } else {
      // Forzamos null para 'classic' (migration 007 deja el campo nullable pero
      // mantenerlo limpio evita ruido).
      finalSchema = null;
    }

    const fields = {
      category: (category !== undefined ? category : tmpl.category).trim(),
      title: (title !== undefined ? title : tmpl.title).trim(),
      instructions: (instructions !== undefined ? instructions : tmpl.instructions).trim(),
      difficulty: difficulty !== undefined ? difficulty : tmpl.difficulty,
      duration_min: duration_min !== undefined ? duration_min : tmpl.duration_min,
      exercise_kind: finalKind,
      exercise_schema: finalSchema ? JSON.stringify(finalSchema) : null,
    };
    await pool.query(
      'UPDATE task_templates SET category=$1, title=$2, instructions=$3, difficulty=$4, duration_min=$5, exercise_kind=$6, exercise_schema=$7 WHERE id=$8 AND therapist_id=$9',
      [fields.category, fields.title, fields.instructions, fields.difficulty, fields.duration_min, fields.exercise_kind, fields.exercise_schema, id, req.user.id]
    );
    res.json({
      success: true,
      template: { id, therapist_id: req.user.id,
        category: fields.category, title: fields.title, instructions: fields.instructions,
        difficulty: fields.difficulty, duration_min: fields.duration_min,
        exercise_kind: fields.exercise_kind,
        exercise_schema: finalSchema,
      },
    });
  } catch (err) {
    logger.error('Error actualizando template', { error: err.message });
    res.status(500).json({ success: false, error: 'Error al actualizar plantilla' });
  }
});

router.delete('/task-templates/:id', authWithBilling, async (req, res) => {
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

// ─── ESCALAS CLÍNICAS — Historial de puntuaciones ──────────────────
router.get('/patients/:patientId/scale-history', authWithBilling, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { kind } = req.query;
    const pool = getPool();

    const { rows: connRows } = await pool.query(
      "SELECT * FROM therapist_patients WHERE therapist_id = $1 AND patient_id = $2 AND status = 'active'",
      [req.user.id, patientId]
    );
    if (connRows.length === 0) return res.status(404).json({ success: false, error: 'Paciente no encontrado' });

    if (!kind || !SCALE_KINDS.includes(kind)) {
      // Devolver historial de todas las escalas
      const results = {};
      for (const k of SCALE_KINDS) {
        results[k] = await getScoreHistory(pool, patientId, k);
      }
      return res.json({ success: true, scales: results });
    }

    const history = await getScoreHistory(pool, patientId, kind);
    res.json({ success: true, kind, history });
  } catch (err) {
    logger.error('Error scale-history', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── ALERTAS CLÍNICAS ──────────────────────────────────────────────
router.get('/alerts', authWithBilling, async (req, res) => {
  try {
    const pool = getPool();
    const alerts = await getAlerts(pool, req.user.id, { status: req.query.status || 'unread' });
    res.json({ success: true, alerts, count: alerts.length });
  } catch (err) {
    logger.error('Error cargando alertas', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.put('/alerts/read', authWithBilling, async (req, res) => {
  try {
    const { alertIds } = req.body;
    const pool = getPool();
    await markAlertsRead(pool, req.user.id, alertIds);
    res.json({ success: true });
  } catch (err) {
    logger.error('Error marcando alertas', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.put('/alerts/status', authWithBilling, async (req, res) => {
  try {
    const { alertIds, status, note } = req.body || {};
    if (!Array.isArray(alertIds) || alertIds.length === 0) {
      return res.status(400).json({ success: false, error: 'alertIds requerido' });
    }
    if (!['open', 'acknowledged', 'resolved'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Estado invalido' });
    }
    const pool = getPool();
    await updateAlertStatus(pool, req.user.id, alertIds, status, note || null);
    auditChange(req, 'update_alert_status', 'clinical_alert', alertIds.join(','), { status });
    res.json({ success: true });
  } catch (err) {
    logger.error('Error actualizando alertas', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── INSIGHTS SEMANALES ────────────────────────────────────────────
router.get('/patients/:patientId/weekly-insights', authWithBilling, async (req, res) => {
  try {
    const pool = getPool();
    const { patientId } = req.params;

    const { rows: connRows } = await pool.query(
      "SELECT * FROM therapist_patients WHERE therapist_id = $1 AND patient_id = $2 AND status = 'active'",
      [req.user.id, patientId]
    );
    if (connRows.length === 0) return res.status(404).json({ success: false, error: 'Paciente no encontrado' });

    const patientName = connRows[0].patient_name || 'Paciente';

    // ── Check-ins de los últimos 7 días ──
    const { rows: checkIns } = await pool.query(
      `SELECT mood, anxiety, energy, created_at FROM check_ins
       WHERE patient_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
       ORDER BY created_at ASC`,
      [patientId]
    );

    // ── Check-ins de los 7 días anteriores (para comparar) ──
    const { rows: prevCheckIns } = await pool.query(
      `SELECT mood, anxiety, energy FROM check_ins
       WHERE patient_id = $1
         AND created_at >= NOW() - INTERVAL '14 days'
         AND created_at < NOW() - INTERVAL '7 days'`,
      [patientId]
    );

    // ── Tareas ──
    const { rows: assignments } = await pool.query(
      `SELECT title, status FROM assignments
       WHERE patient_id = $1
         AND (created_at >= NOW() - INTERVAL '7 days' OR status = 'assigned')
       ORDER BY created_at DESC`,
      [patientId]
    );

    // ── Metas ──
    const { rows: goals } = await pool.query(
      'SELECT title, current_value, target_value, status FROM goals WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 5',
      [patientId]
    );

    // ── Escalas clínicas completadas ──
    const scaleScores = {};
    for (const kind of SCALE_KINDS) {
      const history = await getScoreHistory(pool, patientId, kind);
      if (history.length > 0) scaleScores[kind] = history;
    }

    // ── Generar insights ──
    const insights = [];

    // 1. Estado de ánimo
    if (checkIns.length >= 3) {
      const avgMood = +(checkIns.reduce((s, c) => s + c.mood, 0) / checkIns.length).toFixed(1);
      const avgAnxiety = +(checkIns.reduce((s, c) => s + c.anxiety, 0) / checkIns.length).toFixed(1);
      const avgEnergy = +(checkIns.reduce((s, c) => s + (c.energy || 5), 0) / checkIns.length).toFixed(1);

      const moodWord = avgMood >= 7 ? 'positivo' : avgMood <= 3 ? 'bajo' : 'moderado';
      insights.push({
        type: 'mood_summary',
        title: 'Estado de ánimo',
        text: 'Esta semana tu ánimo promedio fue de ' + avgMood + '/10 (nivel ' + moodWord + '), con ansiedad media de ' + avgAnxiety + '/10 y energía de ' + avgEnergy + '/10.',
        data: { avgMood, avgAnxiety, avgEnergy, checkInCount: checkIns.length },
      });

      if (prevCheckIns.length >= 3) {
        const prevMood = +(prevCheckIns.reduce((s, c) => s + c.mood, 0) / prevCheckIns.length).toFixed(1);
        const delta = avgMood - prevMood;
        if (Math.abs(delta) >= 0.5) {
          insights.push({
            type: 'mood_change',
            title: 'Cambio respecto a la semana anterior',
            text: 'Tu ánimo ' + (delta >= 0 ? 'mejoró' : 'disminuyó') + ' ' + Math.abs(delta).toFixed(1) + ' puntos respecto a la semana anterior (' + prevMood + ' → ' + avgMood + ').',
            data: { delta, prevMood, currentMood: avgMood },
          });
        }
      }
    } else if (checkIns.length === 0) {
      insights.push({
        type: 'no_checkins',
        title: 'Sin registros esta semana',
        text: 'No has registrado check-ins esta semana. Registrar tu estado de ánimo ayuda a tu terapeuta a seguir tu evolución.',
        data: {},
      });
    }

    // 2. Ejercicios
    const completed = assignments.filter(a => a.status === 'completed').length;
    const pending = assignments.filter(a => a.status === 'assigned').length;
    if (completed > 0 || pending > 0) {
      let exerciseText = 'Esta semana ';
      if (completed > 0) exerciseText += 'completaste ' + completed + ' ejercicio' + (completed === 1 ? '' : 's');
      if (completed > 0 && pending > 0) exerciseText += ' y ';
      if (pending > 0) exerciseText += 'tienes ' + pending + ' pendiente' + (pending === 1 ? '' : 's');
      exerciseText += '.';
      insights.push({
        type: 'exercise_adherence',
        title: 'Adherencia a ejercicios',
        text: exerciseText,
        data: { completed, pending },
      });
    }

    // 3. Metas
    goals.forEach(g => {
      const pct = g.target_value > 0 ? Math.round((g.current_value / g.target_value) * 100) : 0;
      if (pct > 0 && g.status === 'active') {
        insights.push({
          type: 'goal_progress',
          title: 'Progreso: "' + g.title + '"',
          text: 'Llevas un ' + pct + '% de tu meta "' + g.title + '" (' + g.current_value + '/' + g.target_value + '). ¡Sigue así!',
          data: { goal: g.title, current: g.current_value, target: g.target_value, percentage: pct },
        });
      }
    });

    // 4. Escalas clínicas
    for (const [kind, history] of Object.entries(scaleScores)) {
      const latest = history[history.length - 1];
      const scaleNames = { phq9: 'PHQ-9 (Depresión)', gad7: 'GAD-7 (Ansiedad)', bdiii: 'BDI-II (Depresión)' };
      if (latest && latest.total !== null) {
        let scaleText = 'Tu puntuación en ' + scaleNames[kind] + ' fue ' + latest.total + '/' + latest.max + ' — nivel ' + latest.label.toLowerCase() + '.';
        if (history.length >= 2) {
          const prev = history[history.length - 2];
          const delta = latest.total - prev.total;
          if (delta !== 0) {
            scaleText += ' ' + (delta < 0 ? '↓ Bajó ' : '↑ Subió ') + Math.abs(delta) + ' puntos desde la medición anterior (' + new Date(prev.completed_at).toLocaleDateString('es-ES') + ').';
          }
        }
        insights.push({
          type: 'clinical_scale',
          title: scaleNames[kind] || kind,
          text: scaleText,
          data: { kind, total: latest.total, max: latest.max, severity: latest.severity, label: latest.label, history },
        });
      }
    }

    res.json({
      success: true,
      insights,
      patientName,
      weekStart: new Date(Date.now() - 7 * 86400000).toISOString(),
      weekEnd: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Error weekly-insights', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── EXPORTACION ──────────────────────────────────────────────
router.get('/export/:patientId', authWithBilling, async (req, res) => {
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
    auditChange(req, 'export_patient_data', 'patient', patientId, { format });
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

    // Enviar email de recuperación
    const resetUrl = config.APP_URL + '/reset-password?token=' + resetToken;
    const emailSent = await sendRecoveryEmail(email, therapist.name, resetToken, resetUrl);

    if (!config.isProd && !emailSent) {
      logger.info('Password reset token para ' + email + ': ' + resetToken);
      logger.info('URL: ' + resetUrl);
    }

    // En desarrollo, si el email no se envió (SMTP no configurado),
    // devolvemos el reset_url en la respuesta para que el frontend
    // pueda mostrarlo como enlace directo al terapeuta.
    const response = { success: true, message: 'Si el email existe, recibiras instrucciones' };
    if (!config.isProd && !emailSent) {
      response.reset_url = resetUrl;
    }
    res.json(response);
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
    audit({ who: resetRows[0].therapist_id, role: 'therapist', action: 'password_reset', resource: 'therapist', resourceId: resetRows[0].therapist_id, ip: req.ip });
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

// ─── SESIONES CLÍNICAS ────────────────────────────────────────
// Registro estructurado de sesiones clínicas con notas SOAP vinculadas.
// GET    /patients/:patientId/clinical-sessions
// POST   /patients/:patientId/clinical-sessions
// PUT    /patients/:patientId/clinical-sessions/:sessionId
// DELETE /patients/:patientId/clinical-sessions/:sessionId

router.get('/patients/:patientId/clinical-sessions', authWithBilling, async (req, res) => {
  try {
    const { patientId } = req.params;
    const pool = getPool();

    const { rows: connRows } = await pool.query(
      "SELECT * FROM therapist_patients WHERE therapist_id = $1 AND patient_id = $2",
      [req.user.id, patientId]
    );
    if (connRows.length === 0) return res.status(404).json({ success: false, error: 'Paciente no encontrado' });

    const { rows: sessions } = await pool.query(
      `SELECT s.*,
        (SELECT json_agg(json_build_object(
          'id', n.id, 'subjective', n.subjective, 'objective', n.objective,
          'assessment', n.assessment, 'plan', n.plan,
          'created_at', n.created_at, 'updated_at', n.updated_at
        ) ORDER BY n.created_at DESC)
         FROM clinical_notes n WHERE n.session_id = s.id) as notes
       FROM clinical_sessions s
       WHERE s.patient_id = $1 AND s.therapist_id = $2
       ORDER BY s.session_date DESC`,
      [patientId, req.user.id]
    );

    res.json({ success: true, sessions: sessions.map(s => ({ ...s, notes: s.notes || [] })) });
  } catch (err) {
    logger.error('Error cargando sesiones clínicas', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.post('/patients/:patientId/clinical-sessions', authWithBilling, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { session_date, duration_min, type, status, notes_summary } = req.body || {};

    const pool = getPool();
    const { rows: connRows } = await pool.query(
      "SELECT * FROM therapist_patients WHERE therapist_id = $1 AND patient_id = $2 AND status = 'active'",
      [req.user.id, patientId]
    );
    if (connRows.length === 0) return res.status(404).json({ success: false, error: 'Paciente no encontrado' });

    const id = uuidv4();
    await pool.query(
      `INSERT INTO clinical_sessions (id, patient_id, therapist_id, session_date, duration_min, type, status, notes_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id, patientId, req.user.id,
        session_date || new Date().toISOString(),
        duration_min || null,
        type || 'presencial',
        status || 'completed',
        notes_summary || null,
      ]
    );

    const { rows: sessionRows } = await pool.query('SELECT * FROM clinical_sessions WHERE id = $1', [id]);
    auditChange(req, 'create_clinical_session', 'clinical_session', id, { patientId, type });

    bus.publish(bus.topicFor('therapist', req.user.id), 'session:created', { patientId, sessionId: id });

    res.json({ success: true, session: sessionRows[0] });
  } catch (err) {
    logger.error('Error creando sesión clínica', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.put('/patients/:patientId/clinical-sessions/:sessionId', authWithBilling, async (req, res) => {
  try {
    const { patientId, sessionId } = req.params;
    const { session_date, duration_min, type, status, notes_summary } = req.body || {};
    const pool = getPool();

    const { rows: sessRows } = await pool.query(
      'SELECT * FROM clinical_sessions WHERE id = $1 AND patient_id = $2 AND therapist_id = $3',
      [sessionId, patientId, req.user.id]
    );
    if (sessRows.length === 0) return res.status(404).json({ success: false, error: 'Sesión no encontrada' });

    const sess = sessRows[0];
    const fields = {
      session_date: session_date !== undefined ? session_date : sess.session_date,
      duration_min: duration_min !== undefined ? duration_min : sess.duration_min,
      type: type !== undefined ? type : sess.type,
      status: status !== undefined ? status : sess.status,
      notes_summary: notes_summary !== undefined ? notes_summary : sess.notes_summary,
    };

    await pool.query(
      `UPDATE clinical_sessions SET session_date=$1, duration_min=$2, type=$3, status=$4, notes_summary=$5, updated_at=NOW()
       WHERE id=$6 AND therapist_id=$7`,
      [fields.session_date, fields.duration_min, fields.type, fields.status, fields.notes_summary, sessionId, req.user.id]
    );

    auditChange(req, 'update_clinical_session', 'clinical_session', sessionId, { patientId });
    res.json({ success: true, session: { ...sess, ...fields, updated_at: new Date().toISOString() } });
  } catch (err) {
    logger.error('Error actualizando sesión clínica', { error: err.message });
    res.status(500).json({ success: false });
  }
});

router.delete('/patients/:patientId/clinical-sessions/:sessionId', authWithBilling, async (req, res) => {
  try {
    const { patientId, sessionId } = req.params;
    const pool = getPool();

    const { rows: sessRows } = await pool.query(
      'SELECT * FROM clinical_sessions WHERE id = $1 AND patient_id = $2 AND therapist_id = $3',
      [sessionId, patientId, req.user.id]
    );
    if (sessRows.length === 0) return res.status(404).json({ success: false, error: 'Sesión no encontrada' });

    // ON DELETE SET NULL en clinical_notes.session_id preserva las notas
    await pool.query('DELETE FROM clinical_sessions WHERE id = $1 AND therapist_id = $2', [sessionId, req.user.id]);
    auditChange(req, 'delete_clinical_session', 'clinical_session', sessionId, { patientId });

    res.json({ success: true, message: 'Sesión eliminada' });
  } catch (err) {
    logger.error('Error eliminando sesión clínica', { error: err.message });
    res.status(500).json({ success: false });
  }
});

// ─── PUSH TOKENS (FCM) ──────────────────────────────────────
// Registra el token FCM del dispositivo del terapeuta para recibir
// notificaciones push cuando un paciente envía mensajes.
// Llamado por CoterPush.init() en el frontend tras obtener el token.
router.post('/push-token', authWithBilling, async (req, res) => {
  try {
    const { token, platform } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token requerido' });

    const pool = getPool();
    await pool.query(
      `INSERT INTO push_tokens (therapist_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (COALESCE(patient_id::text, therapist_id::text), token)
       DO UPDATE SET platform = $3, updated_at = NOW()`,
      [req.user.id, token, platform || 'android']
    );

    logger.info('[Push] Token FCM registrado para terapeuta', { therapistId: req.user.id, platform: platform || 'android' });
    res.json({ success: true, message: 'Token registrado' });
  } catch (err) {
    logger.error('[Push] Error registrando token FCM de terapeuta', { error: err.message });
    res.status(500).json({ error: 'Error al registrar token' });
  }
});

module.exports = router;
