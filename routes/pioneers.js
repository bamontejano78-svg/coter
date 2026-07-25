/**
 * ═══════════════════════════════════════════════════════════════
 * Rutas de Pioneros — Coter Pro
 *
 * Endpoints públicos (sin autenticación):
 *   POST /apply → enviar solicitud al Programa Pioneros
 *
 * La solicitud se guarda en pioneer_applications y se notifica
 * por email al equipo de COTER para revisión manual.
 * ═══════════════════════════════════════════════════════════════
 */

const express = require('express');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { getPool } = require('../database');
const config = require('../config/env');
const logger = require('../config/logger');

const router = express.Router();

// ─── Email transporter (lazy, reutilizado de therapist.js) ─────
let mailTransporter = null;
function getMailTransporter() {
  if (mailTransporter) return mailTransporter;
  if (!config.SMTP_HOST || !config.SMTP_USER || !config.SMTP_PASS) {
    return null;
  }
  mailTransporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  });
  return mailTransporter;
}

/**
 * Envía notificación al equipo de COTER cuando alguien aplica.
 * Best-effort: si falla el email, la solicitud ya está guardada en BD.
 */
async function notifyTeamAboutApplication(application) {
  const transporter = getMailTransporter();
  const notifyEmail = config.PIONEER_NOTIFY_EMAIL || config.SMTP_FROM || 'equipo@coter.app';

  if (!transporter) {
    logger.warn('SMTP no configurado — no se envió notificación de solicitud pionera', {
      email: application.email,
    });
    return false;
  }

  try {
    await transporter.sendMail({
      from: '"Coter Pro" <' + config.SMTP_FROM + '>',
      to: notifyEmail,
      subject: 'Nueva solicitud al Programa Pioneros — ' + application.name,
      text:
        'NUEVA SOLICITUD AL PROGRAMA PIONEROS\n' +
        '═══════════════════════════════════\n\n' +
        'Nombre: ' + application.name + '\n' +
        'Email: ' + application.email + '\n' +
        'Especialidad: ' + application.specialty + '\n' +
        'Teléfono: ' + (application.phone || 'No proporcionado') + '\n' +
        'Mensaje: ' + (application.message || 'Sin mensaje') + '\n\n' +
        'Revisa todas las solicitudes en la base de datos.\n' +
        'Tabla: pioneer_applications\n\n' +
        '— Coter Pro',
      html:
        '<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">' +
        '<h2 style="color:#6366f1">Nueva solicitud — Programa Pioneros</h2>' +
        '<table style="width:100%;border-collapse:collapse;margin:20px 0">' +
        '<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888;width:120px">Nombre</td><td style="padding:8px;border-bottom:1px solid #eee"><strong>' + application.name + '</strong></td></tr>' +
        '<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Email</td><td style="padding:8px;border-bottom:1px solid #eee">' + application.email + '</td></tr>' +
        '<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Especialidad</td><td style="padding:8px;border-bottom:1px solid #eee">' + application.specialty + '</td></tr>' +
        '<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Teléfono</td><td style="padding:8px;border-bottom:1px solid #eee">' + (application.phone || '—') + '</td></tr>' +
        '<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Mensaje</td><td style="padding:8px;border-bottom:1px solid #eee">' + (application.message || '—') + '</td></tr>' +
        '</table>' +
        '<p style="color:#888;font-size:14px">Revisa la tabla <code>pioneer_applications</code> para gestionar las solicitudes.</p>' +
        '</div>',
    });
    logger.info('Notificación de solicitud pionera enviada a ' + notifyEmail);
    return true;
  } catch (err) {
    logger.error('Error enviando notificación de solicitud pionera', {
      error: err.message,
      email: application.email,
    });
    return false;
  }
}

// ─── POST /apply ──────────────────────────────────────────────
// Endpoint público: cualquier terapeuta puede solicitar acceso.
// Rate limit desde server.js (apiLimiter genérico).
router.post('/apply', [
  body('name').trim().notEmpty().withMessage('Nombre requerido'),
  body('email').isEmail().normalizeEmail().withMessage('Email válido requerido'),
  body('specialty').trim().notEmpty().withMessage('Especialidad requerida'),
  body('phone').optional().trim(),
  body('message').optional().trim(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const { name, email, specialty, phone, message } = req.body;

  // Guardar en BD (await — no respondemos hasta que esté persistido)
  const pool = getPool();
  const id = uuidv4();

  try {
    await pool.query(
      `INSERT INTO pioneer_applications (id, name, email, specialty, phone, message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, name, email, specialty, phone || null, message || null]
    );

    logger.info('Solicitud pionera registrada', { id, email });

    // Notificar al equipo (best-effort, no bloquea la respuesta)
    notifyTeamAboutApplication({ name, email, specialty, phone, message }).catch(() => {});

    res.json({
      success: true,
      message: 'Solicitud recibida. Te contactaremos pronto.',
    });
  } catch (err) {
    logger.error('Error guardando solicitud pionera', { error: err.message, email });
    res.status(500).json({
      success: false,
      error: 'Error al procesar la solicitud. Intenta de nuevo.',
    });
  }
});

module.exports = router;
