const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const config = require('../config/env');
const logger = require('../config/logger');
const { getPool } = require('../database');
const { SCALE_KINDS } = require('../utils/clinicalScales');
const { encrypt, decrypt } = require('../utils/encryption');
const { generateSecret, verifyTotp, otpauthUrl, generateBackupCodes, normalizeBackupCode } = require('../utils/totp');

const router = express.Router();

// ─── Admin session ─────────────────────────────────────────────
// The password is accepted only by POST /session. Subsequent requests use
// a short-lived, signed HttpOnly cookie; the password is never sent again.
const ADMIN_COOKIE = 'coter_admin_session';
const ADMIN_SESSION_TTL_MS = 15 * 60 * 1000;
// Ticket de un solo propósito (5 min) para el segundo paso cuando el admin
// tiene 2FA activa. Solo /verify-2fa puede canjearlo por la sesión real.
const ADMIN_2FA_PENDING_COOKIE = 'coter_admin_2fa_pending';
const ADMIN_2FA_PENDING_TTL_MS = 5 * 60 * 1000;

function parseCookie(req, name) {
  const header = req.headers.cookie || '';
  const pair = header.split(';').map(part => part.trim()).find(part => part.startsWith(name + '='));
  if (!pair) return null;
  try {
    return decodeURIComponent(pair.slice(name.length + 1));
  } catch (err) {
    return null;
  }
}

function signAdminSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', config.JWT_SECRET).update(encoded).digest('base64url');
  return encoded + '.' + signature;
}

function verifySignedSession(value, expectedSub) {
  if (!value) return false;
  const [encoded, signature] = value.split('.');
  if (!encoded || !signature) return false;
  const expected = crypto.createHmac('sha256', config.JWT_SECRET).update(encoded).digest('base64url');
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload.exp > Date.now() && payload.sub === expectedSub;
  } catch (err) {
    return false;
  }
}

function verifyAdminSession(value) {
  return verifySignedSession(value, 'admin');
}

function passwordMatches(provided) {
  if (!provided || !config.ADMIN_PASSWORD) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(config.ADMIN_PASSWORD);
  return providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
}

function adminCookieOptions(cookieName, value, ttlMs) {
  return [
    cookieName + '=' + (value ? encodeURIComponent(value) : ''),
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(config.isSecureDeployment ? ['Secure'] : []),
    'Max-Age=' + (value && ttlMs ? Math.floor(ttlMs / 1000) : '0'),
  ].join('; ');
}

// ─── Admin settings (2FA) ──────────────────────────────────────
// Claves usadas en admin_settings: two_factor_secret (cifrado AES-256-GCM),
// two_factor_enabled ('true'/'false').
async function getAdminSetting(db, key) {
  const { rows } = await db.query('SELECT value FROM admin_settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}

async function setAdminSetting(db, key, value) {
  await db.query(
    `INSERT INTO admin_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}

// Session creation and revocation are intentionally outside adminAuth.
router.post('/session', async (req, res) => {
  if (!config.ADMIN_PASSWORD) {
    return res.status(503).json({ success: false, error: 'Panel de administración no configurado' });
  }
  if (!passwordMatches(req.body?.password)) {
    return res.status(401).json({ success: false, error: 'Acceso no autorizado' });
  }

  // 2FA: si está activa, la contraseña sola NO abre sesión. Se emite un
  // ticket pendiente de 5 min que solo /verify-2fa puede canjear.
  try {
    const pool = getPool();
    const enabled = (await getAdminSetting(pool, 'two_factor_enabled')) === 'true';
    if (enabled) {
      const pending = signAdminSession({ sub: 'admin_2fa_pending', exp: Date.now() + ADMIN_2FA_PENDING_TTL_MS });
      res.setHeader('Set-Cookie', [
        adminCookieOptions(ADMIN_2FA_PENDING_COOKIE, pending, ADMIN_2FA_PENDING_TTL_MS),
        adminCookieOptions(ADMIN_COOKIE, null, 0),
      ]);
      return res.json({ success: true, requires_2fa: true });
    }
  } catch (err) {
    // Fail-closed: sin poder verificar el estado de 2FA, no conceder sesión.
    logger.error('Error consultando estado 2FA admin', { error: err.message });
    return res.status(503).json({ success: false, error: 'Error del servidor' });
  }

  const token = signAdminSession({ sub: 'admin', exp: Date.now() + ADMIN_SESSION_TTL_MS });
  res.setHeader('Set-Cookie', adminCookieOptions(ADMIN_COOKIE, token, ADMIN_SESSION_TTL_MS));
  return res.json({ success: true });
});

// ─── VERIFICACIÓN 2FA (segundo paso del login de admin) ─────────
router.post('/verify-2fa', async (req, res) => {
  if (!config.ADMIN_PASSWORD) {
    return res.status(503).json({ success: false, error: 'Panel de administración no configurado' });
  }
  if (!verifySignedSession(parseCookie(req, ADMIN_2FA_PENDING_COOKIE), 'admin_2fa_pending')) {
    return res.status(401).json({ success: false, error: 'Sesión de verificación expirada. Introduce la contraseña de nuevo.' });
  }

  const code = (req.body && req.body.code) ? String(req.body.code).trim() : '';
  if (!code) return res.status(400).json({ success: false, error: 'Código requerido' });

  try {
    const pool = getPool();
    const secretEnc = await getAdminSetting(pool, 'two_factor_secret');
    const enabled = (await getAdminSetting(pool, 'two_factor_enabled')) === 'true';
    if (!enabled || !secretEnc) {
      return res.status(401).json({ success: false, error: 'La verificación en dos pasos no está activa' });
    }
    const secret = decrypt(secretEnc);
    let method = null;

    // 1) TOTP de 6 dígitos
    if (verifyTotp(secret, code)) {
      method = 'totp';
    } else {
      // 2) Código de respaldo (16 chars, de un solo uso)
      const backupCode = normalizeBackupCode(code);
      if (backupCode) {
        const { rows: codes } = await pool.query(
          'SELECT id, code_hash FROM admin_2fa_backup_codes WHERE used_at IS NULL'
        );
        for (const c of codes) {
          if (await bcrypt.compare(backupCode, c.code_hash)) {
            await pool.query('UPDATE admin_2fa_backup_codes SET used_at = NOW() WHERE id = $1', [c.id]);
            method = 'backup_code';
            break;
          }
        }
      }
    }

    if (!method) {
      return res.status(401).json({ success: false, error: 'Código inválido' });
    }

    const token = signAdminSession({ sub: 'admin', exp: Date.now() + ADMIN_SESSION_TTL_MS });
    res.setHeader('Set-Cookie', [
      adminCookieOptions(ADMIN_COOKIE, token, ADMIN_SESSION_TTL_MS),
      adminCookieOptions(ADMIN_2FA_PENDING_COOKIE, null, 0),
    ]);
    return res.json({ success: true });
  } catch (err) {
    logger.error('Error en admin verify-2fa', { error: err.message });
    res.status(500).json({ success: false, error: 'Error del servidor' });
  }
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', [
    adminCookieOptions(ADMIN_COOKIE, null, 0),
    adminCookieOptions(ADMIN_2FA_PENDING_COOKIE, null, 0),
  ]);
  return res.json({ success: true });
});

function adminAuth(req, res, next) {
  if (!config.ADMIN_PASSWORD) {
    return res.status(503).json({ success: false, error: 'Panel de administración no configurado' });
  }
  if (!verifyAdminSession(parseCookie(req, ADMIN_COOKIE))) {
    return res.status(401).json({ success: false, error: 'Sesión de administración inválida o expirada' });
  }
  next();
}

router.use(adminAuth);

// ─── 2FA: gestión de la verificación en dos pasos del admin ────

router.get('/2fa/status', async (req, res) => {
  try {
    const pool = getPool();
    const enabled = (await getAdminSetting(pool, 'two_factor_enabled')) === 'true';
    res.json({ success: true, enabled });
  } catch (err) {
    logger.error('Error en admin 2fa/status', { error: err.message });
    res.status(500).json({ success: false, error: 'Error del servidor' });
  }
});

router.post('/2fa/setup', async (req, res) => {
  try {
    const pool = getPool();
    const enabled = (await getAdminSetting(pool, 'two_factor_enabled')) === 'true';
    if (enabled) {
      return res.status(409).json({ success: false, error: 'La verificación en dos pasos ya está activa. Desactívala antes de reconfigurarla.' });
    }

    const secret = generateSecret();
    const otpauth = otpauthUrl(secret, 'admin', 'Coter Pro Admin');
    const qrCodeDataUrl = await QRCode.toDataURL(otpauth, { width: 240, margin: 1, errorCorrectionLevel: 'M' });

    await setAdminSetting(pool, 'two_factor_secret', encrypt(secret));
    await setAdminSetting(pool, 'two_factor_enabled', 'false');
    await pool.query('DELETE FROM admin_2fa_backup_codes');
    res.json({ success: true, secret, otpauth_url: otpauth, qr_code_data_url: qrCodeDataUrl });
  } catch (err) {
    logger.error('Error en admin 2fa/setup', { error: err.message });
    res.status(500).json({ success: false, error: 'Error del servidor' });
  }
});

router.post('/2fa/confirm', async (req, res) => {
  try {
    const code = (req.body && req.body.code) ? String(req.body.code).trim() : '';
    const pool = getPool();
    const secretEnc = await getAdminSetting(pool, 'two_factor_secret');
    const enabled = (await getAdminSetting(pool, 'two_factor_enabled')) === 'true';
    if (enabled) return res.status(409).json({ success: false, error: 'La verificación en dos pasos ya está activa' });
    if (!secretEnc) return res.status(400).json({ success: false, error: 'Primero genera un secreto con /2fa/setup' });

    const secret = decrypt(secretEnc);
    if (!verifyTotp(secret, code)) {
      return res.status(401).json({ success: false, error: 'Código inválido. Comprueba el código actual de tu app autenticadora.' });
    }

    const backupCodes = generateBackupCodes(10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM admin_2fa_backup_codes');
      for (const c of backupCodes) {
        const hash = await bcrypt.hash(c, 10);
        await client.query('INSERT INTO admin_2fa_backup_codes (id, code_hash) VALUES ($1, $2)', [uuidv4(), hash]);
      }
      await setAdminSetting(client, 'two_factor_enabled', 'true');
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ success: true, backup_codes: backupCodes });
  } catch (err) {
    logger.error('Error en admin 2fa/confirm', { error: err.message });
    res.status(500).json({ success: false, error: 'Error del servidor' });
  }
});

router.post('/2fa/disable', async (req, res) => {
  try {
    const code = (req.body && req.body.code) ? String(req.body.code).trim() : '';
    const pool = getPool();
    const secretEnc = await getAdminSetting(pool, 'two_factor_secret');
    const enabled = (await getAdminSetting(pool, 'two_factor_enabled')) === 'true';
    if (!enabled) return res.status(400).json({ success: false, error: 'La verificación en dos pasos no está activa' });
    if (!secretEnc) return res.status(400).json({ success: false, error: 'No hay secreto configurado' });

    const secret = decrypt(secretEnc);
    if (!verifyTotp(secret, code)) {
      return res.status(401).json({ success: false, error: 'Código inválido' });
    }

    await pool.query('DELETE FROM admin_2fa_backup_codes');
    await setAdminSetting(pool, 'two_factor_secret', null);
    await setAdminSetting(pool, 'two_factor_enabled', 'false');
    res.json({ success: true, message: 'Verificación en dos pasos desactivada' });
  } catch (err) {
    logger.error('Error en admin 2fa/disable', { error: err.message });
    res.status(500).json({ success: false, error: 'Error del servidor' });
  }
});

// ─── GET /stats — Estadísticas globales ────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const pool = getPool();

    const [
      therapistsRes,
      activeTherapistsRes,
      patientsRes,
      activeConnectionsRes,
      checkInsRes,
      scalesRes,
      alertsRes,
      subscriptionsRes,
      stripeRes,
      billingRevenueRes,
    ] = await Promise.all([
      // Total therapists
      pool.query('SELECT COUNT(*)::int AS total FROM therapists'),
      // Active therapists (at least 1 login)
      pool.query(
        `SELECT COUNT(DISTINCT t.id)::int AS total
         FROM therapists t
         WHERE t.id IN (
           SELECT DISTINCT tp.therapist_id FROM therapist_patients tp WHERE tp.status = 'active'
         )`
      ),
      // Total patients
      pool.query('SELECT COUNT(*)::int AS total FROM patients'),
      // Active connections
      pool.query("SELECT COUNT(*)::int AS total FROM therapist_patients WHERE status = 'active'"),
      // Total check-ins
      pool.query('SELECT COUNT(*)::int AS total FROM check_ins'),
      // Scales completed this week (across all SCALE_KINDS)
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM exercise_sessions
         WHERE exercise_kind = ANY($1)
           AND is_complete = TRUE
           AND completed_at >= NOW() - INTERVAL '7 days'`,
        [SCALE_KINDS]
      ),
      // Alerts generated
      pool.query('SELECT COUNT(*)::int AS total FROM clinical_alerts'),
      // Unread alerts
      pool.query('SELECT COUNT(*)::int AS total FROM clinical_alerts WHERE is_read = FALSE'),
      // Trial subscriptions
      pool.query(
        `SELECT COUNT(*)::int AS total, status
         FROM subscriptions
         GROUP BY status
         ORDER BY status`
      ),
      // Stripe revenue (billing events)
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE event_type = 'invoice.paid')::int AS paid_invoices,
           COUNT(*) FILTER (WHERE event_type = 'checkout.session.completed')::int AS completed_checkouts,
           COUNT(*) FILTER (WHERE event_type = 'customer.subscription.created')::int AS subscriptions_created,
           COUNT(*) FILTER (WHERE event_type = 'customer.subscription.deleted')::int AS subscriptions_cancelled
         FROM billing_events`
      ),
      // Revenue this month
      pool.query(
        `SELECT COALESCE(SUM((metadata->>'amount_paid')::numeric), 0)::float AS total
         FROM billing_events
         WHERE event_type = 'invoice.paid'
           AND created_at >= date_trunc('month', NOW())`
      ),
    ]);

    // Build subscription summary
    const subscriptionByStatus = {};
    subscriptionsRes.rows.forEach(r => {
      subscriptionByStatus[r.status] = r.total;
    });

    // Therapists registered this month
    const { rows: therapistsThisMonth } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM therapists
       WHERE created_at >= date_trunc('month', NOW())`
    );

    // Patients registered this month
    const { rows: patientsThisMonth } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM patients
       WHERE created_at >= date_trunc('month', NOW())`
    );

    // Daily check-ins (last 14 days)
    const { rows: dailyCheckIns } = await pool.query(
      `SELECT created_at::date AS day, COUNT(*)::int AS count
       FROM check_ins
       WHERE created_at >= NOW() - INTERVAL '14 days'
       GROUP BY day
       ORDER BY day ASC`
    );

    // Scales breakdown by kind
    const { rows: scalesBreakdown } = await pool.query(
      `SELECT exercise_kind, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_complete)::int AS completed
       FROM exercise_sessions
       WHERE exercise_kind = ANY($1)
       GROUP BY exercise_kind
       ORDER BY exercise_kind`,
      [SCALE_KINDS]
    );

    // Pioneer count
    const { rows: pioneers } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM subscriptions
       WHERE is_pioneer = TRUE`
    );

    res.json({
      success: true,
      stats: {
        therapists: {
          total: therapistsRes.rows[0].total,
          active: activeTherapistsRes.rows[0].total,
          thisMonth: therapistsThisMonth[0].total,
        },
        patients: {
          total: patientsRes.rows[0].total,
          activeConnections: activeConnectionsRes.rows[0].total,
          thisMonth: patientsThisMonth[0].total,
        },
        checkIns: {
          total: checkInsRes.rows[0].total,
          daily: dailyCheckIns,
        },
        clinicalScales: {
          completedThisWeek: scalesRes.rows[0].total,
          breakdown: scalesBreakdown,
        },
        alerts: {
          total: alertsRes.rows[0].total,
          unread: alertsRes.rows[0].total,
        },
        billing: {
          subscriptions: subscriptionByStatus,
          pioneers: pioneers[0].total,
          stripe: stripeRes.rows[0],
          revenueThisMonth: billingRevenueRes.rows[0].total,
        },
      },
    });
  } catch (err) {
    logger.error('Error en admin stats', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, error: 'Error al cargar estadísticas' });
  }
});

// ─── GET /recent-activity — Actividad reciente global ──────────
router.get('/recent-activity', async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const { rows: recentActivity } = await pool.query(
      `SELECT 'therapist_registered' AS type, t.name AS label, t.email AS detail, t.created_at
       FROM therapists t
       UNION ALL
       SELECT 'patient_connected' AS type, p.name AS label, 'via ' || tp.connection_code AS detail, tp.connected_at AS created_at
       FROM therapist_patients tp
       JOIN patients p ON p.id = tp.patient_id
       WHERE tp.connected_at IS NOT NULL
       UNION ALL
       SELECT 'scale_completed' AS type,
              COALESCE(p.name, 'Anónimo') AS label,
              es.exercise_kind AS detail,
              es.completed_at AS created_at
       FROM exercise_sessions es
       LEFT JOIN patients p ON p.id = es.patient_id
       WHERE es.is_complete = TRUE AND es.completed_at IS NOT NULL
       UNION ALL
       SELECT 'alert_triggered' AS type,
              ca.message AS label,
              ca.severity AS detail,
              ca.created_at
       FROM clinical_alerts ca
       UNION ALL
       SELECT 'stripe_event' AS type,
              be.event_type AS label,
              COALESCE(be.metadata->>'customer_email', '') AS detail,
              be.created_at
       FROM billing_events be
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    res.json({ success: true, activity: recentActivity });
  } catch (err) {
    logger.error('Error en admin activity', { error: err.message });
    res.status(500).json({ success: false, error: 'Error al cargar actividad' });
  }
});

// ─── GET /patient-audit — Accesos a fichas clínicas ──────────
// Traza de quién consultó cada ficha y cuándo (RGPD/LOPDGDD).
// LEFT JOIN patients: la traza sobrevive al borrado RGPD del paciente.
router.get('/patient-audit', async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const patientFilter = req.query.patient_id ? String(req.query.patient_id) : null;

    const where = patientFilter ? 'WHERE paa.patient_id = $2' : '';
    const params = patientFilter ? [limit, patientFilter] : [limit];

    const { rows } = await pool.query(
      `SELECT paa.id, paa.patient_id, paa.action, paa.ip, paa.created_at,
              t.name AS therapist_name, t.email AS therapist_email,
              CASE WHEN p.id IS NULL THEN NULL
                   ELSE COALESCE(p.name, 'Paciente sin nombre') END AS patient_name
         FROM patient_access_audit paa
         JOIN therapists t ON t.id = paa.therapist_id
         LEFT JOIN patients p ON p.id = paa.patient_id
         ${where}
         ORDER BY paa.created_at DESC
         LIMIT $1`,
      params
    );
    res.json({ success: true, entries: rows });
  } catch (err) {
    logger.error('Error en admin patient-audit', { error: err.message });
    res.status(500).json({ success: false, error: 'Error al cargar auditoría' });
  }
});

module.exports = router;
