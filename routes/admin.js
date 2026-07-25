const express = require('express');
const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../config/logger');
const { getPool } = require('../database');
const { SCALE_KINDS } = require('../utils/clinicalScales');

const router = express.Router();

// ─── Admin password middleware ─────────────────────────────────
// Accepts password via:
//   • Authorization: Bearer <password>  (recommended)
//   • x-admin-password: <password>      (legacy, JS fetch)

function adminAuth(req, res, next) {
  if (!config.ADMIN_PASSWORD) {
    return res.status(503).json({ success: false, error: 'Panel de administración no configurado (ADMIN_PASSWORD ausente)' });
  }

  let provided = null;

  // Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    provided = authHeader.slice(7);
  }

  // x-admin-password header
  if (!provided) {
    provided = req.headers['x-admin-password'];
  }



  // Timing-safe comparison (buffers must be equal length)
  if (!provided) {
    return res.status(401).json({ success: false, error: 'Acceso no autorizado' });
  }
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(config.ADMIN_PASSWORD);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return res.status(401).json({ success: false, error: 'Acceso no autorizado' });
  }

  next();
}

// Apply to all routes
router.use(adminAuth);

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
      pool.query('SELECT COUNT(*)::int AS total FROM clinical_alerts WHERE read = FALSE'),
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

module.exports = router;
