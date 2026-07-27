/**
 * ═══════════════════════════════════════════════════════════════
 * FCM (Firebase Cloud Messaging) — Coter Pro
 * ═══════════════════════════════════════════════════════════════
 * Utilidad para enviar notificaciones push nativas a dispositivos
 * Android/iOS registrados via @capacitor/push-notifications.
 *
 * Configuración requerida en .env:
 *   FCM_SERVER_KEY — Server key de Firebase Console → Cloud Messaging
 *   FCM_SENDER_ID  — Sender ID del proyecto Firebase
 *
 * Uso:
 *   const fcm = require('../utils/fcm');
 *   await fcm.send(patientId, { title: 'Nuevo mensaje', body: '...' });
 * ═══════════════════════════════════════════════════════════════
 */

const https = require('https');
const { getPool } = require('../database');
const config = require('../config/env');
const logger = require('../config/logger');

const FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send';

/**
 * Envía una notificación push a todos los dispositivos registrados
 * de un paciente.
 *
 * @param {string} patientId — UUID del paciente
 * @param {Object} notification — { title, body, data? }
 * @param {Object} opts — Opciones adicionales
 * @returns {Promise<{sent: number, failed: number}>}
 */
async function sendToPatient(patientId, notification, opts = {}) {
  if (!config.FCM_SERVER_KEY) {
    logger.warn('[FCM] FCM_SERVER_KEY no configurado — notificación push no enviada');
    return { sent: 0, failed: 0, skipped: true };
  }

  const pool = getPool();
  const { rows: tokens } = await pool.query(
    'SELECT token, platform FROM push_tokens WHERE patient_id = $1',
    [patientId]
  ).catch(err => {
    logger.error('[FCM] Error consultando push_tokens', { error: err.message, patientId });
    return { rows: [] };
  });

  if (!tokens.length) {
    logger.debug('[FCM] No hay tokens registrados para el paciente', { patientId });
    return { sent: 0, failed: 0 };
  }

  const { title, body, data } = notification;
  let sent = 0;
  let failed = 0;

  for (const { token } of tokens) {
    try {
      await sendToOne(token, { title, body, data }, opts);
      sent++;
    } catch (err) {
      logger.warn('[FCM] Error enviando push a token', { error: err.message, patientId });
      failed++;
    }
  }

  return { sent, failed };
}

/**
 * Envía una notificación push a un único token FCM.
 */
function sendToOne(token, { title, body, data }, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!config.FCM_SERVER_KEY) {
      return reject(new Error('FCM_SERVER_KEY no configurado'));
    }

    const payload = JSON.stringify({
      to: token,
      notification: {
        title: title || 'Coter Pro',
        body: body || '',
        sound: 'default',
        ...(opts.icon ? { icon: opts.icon } : {}),
        ...(opts.click_action ? { click_action: opts.click_action } : {}),
      },
      data: data || {},
      priority: opts.priority || 'high',
    });

    const url = new URL(FCM_ENDPOINT);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'key=' + config.FCM_SERVER_KEY,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, async (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', async () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode === 200 && result.success > 0) {
            resolve(result);
          } else {
            const error = result.results?.[0]?.error || 'Unknown FCM error';
            // Clean up stale/invalid tokens so we don't keep sending to dead devices
            if (error === 'NotRegistered' || error === 'InvalidRegistration') {
              try {
                const pool = getPool();
                await pool.query('DELETE FROM push_tokens WHERE token = $1', [token]);
                logger.info('[FCM] Stale token removed', { token: token.substring(0, 12) + '...' });
              } catch (cleanupErr) {
                logger.warn('[FCM] Error cleaning stale token', { error: cleanupErr.message });
              }
            }
            reject(new Error(error));
          }
        } catch (e) {
          if (res.statusCode === 200) resolve(body);
          else reject(new Error('FCM responded with ' + res.statusCode + ': ' + body));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Envía una notificación push a todos los dispositivos registrados
 * de un terapeuta.
 *
 * @param {string} therapistId — UUID del terapeuta
 * @param {Object} notification — { title, body, data? }
 * @param {Object} opts — Opciones adicionales
 * @returns {Promise<{sent: number, failed: number}>}
 */
async function sendToTherapist(therapistId, notification, opts = {}) {
  if (!config.FCM_SERVER_KEY) {
    logger.warn('[FCM] FCM_SERVER_KEY no configurado — notificación push no enviada');
    return { sent: 0, failed: 0, skipped: true };
  }

  const pool = getPool();
  const { rows: tokens } = await pool.query(
    'SELECT token, platform FROM push_tokens WHERE therapist_id = $1',
    [therapistId]
  ).catch(err => {
    logger.error('[FCM] Error consultando push_tokens (therapist)', { error: err.message, therapistId });
    return { rows: [] };
  });

  if (!tokens.length) {
    logger.debug('[FCM] No hay tokens registrados para el terapeuta', { therapistId });
    return { sent: 0, failed: 0 };
  }

  const { title, body, data } = notification;
  let sent = 0;
  let failed = 0;

  for (const { token } of tokens) {
    try {
      await sendToOne(token, { title, body, data }, opts);
      sent++;
    } catch (err) {
      logger.warn('[FCM] Error enviando push a token de terapeuta', { error: err.message, therapistId });
      failed++;
    }
  }

  return { sent, failed };
}

module.exports = { sendToPatient, sendToTherapist, sendToOne };
