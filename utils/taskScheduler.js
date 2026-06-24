/**
 * Task Scheduler — Coter Pro
 *
 * Cron en proceso (node-cron) que ejecuta recordatorios de tareas pendientes
 * en background, desacoplando esa responsabilidad del GET /notifications
 * (que debe ser idempotente para cumplir contrato REST y evitar que un
 * paciente "no abre la app 3 dias = no recibe reminders").
 *
 * Schedule default: cada 10 minutos. Configurable via env CRON_REMINDERS.
 *
 * Por que node-cron y no setInterval / BullMQ:
 *   - setInterval no permite expresiones cron.
 *   - BullMQ requiere Redis (no declarado en este proyecto).
 *   - node-cron es ligero (0 deps pesadas), corre en el mismo proceso,
 *     maneja timezone, perfecto para una app single-instance en Railway.
 *
 * Limitacion conocida: solo UNA instancia puede correr este cron.
 * Si en el futuro escalan a N pods, hay que activar leader-election
 * (e.g. advisory lock en Postgres) o cambiar a un scheduler distribuido.
 */

const cron = require('node-cron');
const logger = require('../config/logger');
const config = require('../config/env');
const { getPool } = require('../database');
const { runAllPendingReminders } = require('./notifications');

// Expansion literal de "star-slash-10" para evitar cerrar el JSDoc.
const DEFAULT_CRON_EXPR = '0,10,20,30,40,50 * * * *';

let scheduledTask = null;
// Mutex simple: si una tick anterior sigue corriendo (BD lenta), no
// arrancamos otra en paralelo. node-cron por defecto NO previene overlaps
// y podria saturar el pool de conexiones.
let runningTick = null;
// Referencia al setTimeout de la primera tick al startup, para poder
// cancelarlo en stop() y evitar fugas tras shutdown.
let startupTimer = null;

async function runTick(reason) {
  if (runningTick) {
    // Importante: en prod este caso indica BD saturada o batch demasiado
    // grande. Loggeamos a nivel info para que sea visible sin subirlo a
    // warn (que dispararia alerta en Datadog).
    logger.info('Reminder tick ya en curso — saltando', { reason });
    return null;
  }
  runningTick = (async () => {
    try {
      const pool = getPool();
      const result = await runAllPendingReminders(pool);
      if (result.scanned > 0 || result.errors > 0 || result.reminders > 0 || result.overdue > 0) {
        logger.info('Reminder tick', { reason, ...result });
      } else {
        logger.debug('Reminder tick (sin tareas que requieran notificacion)', { reason });
      }
      return result;
    } catch (err) {
      logger.error('Reminder tick fallo', { error: err.message, reason });
      return null;
    } finally {
      runningTick = null;
    }
  })();
  return runningTick;
}

/**
 * Arranca el cron. Idempotente: llamar start() dos veces no genera dos
 * tareas paralelas.
 *
 * En test (NODE_ENV=test) NO arranca automaticamente para no dejar timers
 * abiertos que cuelgan jest. Los tests usan runOnce() directo.
 */
function start() {
  if (scheduledTask) return;
  if (config.isTest) {
    logger.debug('TaskScheduler deshabilitado en NODE_ENV=test');
    return;
  }
  const cronExpr = config.CRON_REMINDERS || DEFAULT_CRON_EXPR;
  scheduledTask = cron.schedule(cronExpr, () => runTick('cron'), {
    scheduled: true,
    timezone: process.env.TZ || 'UTC',
  });
  logger.info('TaskScheduler iniciado', { cronExpr });

  // Primera tick al startup con un pequeno delay para que reminders no
  // esten "frios" hasta el primer cron tick (mejora UX justo despues del
  // deploy). Opt-out via env CRON_REMINDERS_RUN_AT_START=false.
  if (process.env.CRON_REMINDERS_RUN_AT_START !== 'false') {
    startupTimer = setTimeout(() => {
      startupTimer = null;
      runTick('startup');
    }, 5_000);
    if (typeof startupTimer.unref === 'function') startupTimer.unref();
  }
}

function stop() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (!scheduledTask) return;
  scheduledTask.stop();
  scheduledTask = null;
  logger.info('TaskScheduler detenido');
}

/**
 * Helper exportado para tests y /api/admin (futuro): ejecuta una tick
 * completa sin esperar al cron.
 */
async function runOnce() {
  return runTick('manual');
}

module.exports = { start, stop, runOnce };
