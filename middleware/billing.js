/**
 * ═══════════════════════════════════════════════════════════════
 * Middleware de facturación — Coter Pro
 *
 * billingGuard: verifica que el terapeuta tenga una suscripción
 * activa o en trial antes de permitir el acceso a las rutas
 * protegidas.
 *
 * authWithBilling: array [authenticateToken, billingGuard] que
 * garantiza el orden correcto (primero auth, luego billing).
 * Úsalo en lugar de authenticateToken solo en las rutas de
 * terapeuta.
 *
 * billingGuard es seguro llamarlo sin req.user (hace no-op).
 * ═══════════════════════════════════════════════════════════════
 */

const { getPool } = require('../database');
const { authenticateToken } = require('./auth');
const { checkAccess } = require('../utils/billing');
const logger = require('../config/logger');

/**
 * Middleware que bloquea el acceso si la suscripción no está activa.
 * Debe ejecutarse DESPUÉS de authenticateToken (req.user.id ya poblado).
 * Si req.user no existe, hace no-op (para rutas sin auth como login/register).
 */
async function billingGuard(req, res, next) {
  // En modo test, saltar el guard de facturación a menos que los tests
  // de billing lo activen explícitamente con BILLING_TEST_MODE=true.
  if (process.env.NODE_ENV === 'test' && process.env.BILLING_TEST_MODE !== 'true') return next();

  const therapistId = req.user?.id;
  if (!therapistId) {
    // Ruta sin auth previa (login, register, password-recovery, etc.).
    // El route-level authenticateToken lo atrapará si es una ruta protegida.
    return next();
  }

  try {
    const pool = getPool();
    const access = await checkAccess(pool, therapistId);

    if (!access.allowed) {
      logger.info('Acceso bloqueado por facturación', {
        therapistId,
        code: access.code,
        reason: access.reason,
      });
      return res.status(402).json({
        success: false,
        error: 'Suscripción inactiva. Renueva tu plan para continuar.',
        code: access.code,
      });
    }

    // Adjuntar info de suscripción al request
    req.subscription = access.subscription || null;
    next();
  } catch (err) {
    logger.error('Error en billingGuard', { error: err.message, therapistId });
    // Fail-open: no bloqueamos a terapeutas legítimos por fallo transitorio
    next();
  }
}

/**
 * Middleware combinado: autenticación JWT + verificación de suscripción.
 * Reemplaza a `authenticateToken` en las rutas de terapeuta para que
 * el guard de facturación se ejecute justo después de la auth y con
 * req.user ya poblado.
 */
const authWithBilling = [authenticateToken, billingGuard];

module.exports = { billingGuard, authWithBilling };
