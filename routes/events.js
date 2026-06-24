/**
 * ═══════════════════════════════════════════════════════════════
 * SSE — Real-time event stream
 *
 * Endpoints:
 *   POST /api/v1/events/ticket/therapist           — emite ticket (req JWT)
 *   POST /api/v1/events/ticket/patient/:patientId  — emite ticket (req Bearer auth_token)
 *   GET  /api/v1/events?ticket=UUID                — abre el stream SSE
 *
 * Por qué viajamos un *ticket* y no el bearer en la query string del GET:
 *   - EventSource no soporta headers custom en el navegador.
 *   - Si pusiéramos `?token=<jwt>` o `?token=<auth_token>` el token quedaría
 *     en los logs de morgan `combined` (URL completa) y en el historial del
 *     proxy. Un ticket de un solo uso y 15s de vida elimina ambos riesgos.
 *
 * El stream emite eventos con formato:
 *   data: {"type":"message:new","data":{...},"ts":1700000000000}\n\n
 *
 * Headers de la respuesta SSE:
 *   Content-Type: text/event-stream
 *   Cache-Control: no-cache, no-transform
 *   Connection: keep-alive
 *   X-Accel-Buffering: no  ← para que nginx/Railway no bufferice
 * ═══════════════════════════════════════════════════════════════
 */

const express = require('express');
const { authenticateToken, authenticatePatient } = require('../middleware/auth');
const bus = require('../utils/eventBus');
const logger = require('../config/logger');

const router = express.Router();

// ─── Helper: emite ticket tras auth ─────────────────────────────────
function issueTicket(role, userId) {
  const ticket = bus.generateTicket(role, userId);
  return { success: true, ticket, expires_in_ms: 15_000 };
}

// ─── POST /ticket/therapist ─────────────────────────────────────────
router.post('/ticket/therapist', authenticateToken, (req, res) => {
  const ticket = bus.generateTicket('therapist', req.user.id);
  res.json({ success: true, ticket, expires_in_ms: 15_000 });
});

// ─── POST /ticket/patient/:patientId ─────────────────────────────────
// El paciente envía los mismos headers que en cualquier otra ruta de /patients
// (Bearer con el auth_token guardado en localStorage). Reutilizamos el
// middleware authenticatePatient para verificar tokens contra la BD.
router.post('/ticket/patient/:patientId', authenticatePatient, (req, res) => {
  const ticket = bus.generateTicket('patient', req.patientId);
  res.json({ success: true, ticket, expires_in_ms: 15_000 });
});

// ─── GET / (stream SSE) ─────────────────────────────────────────────
router.get('/', (req, res) => {
  // Soporta token como query para EventSource, y también Authorization
  // Bearer como fallback (no se usa desde el navegador, pero es útil para
  // curl/scripts de monitoreo).
  let ticket = req.query.ticket;
  if (!ticket) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      ticket = authHeader.split(' ')[1];
    }
  }
  const user = bus.validateTicket(ticket);
  if (!user) {
    // 401 sin body — el cliente EventSource nunca lee la respuesta de todas
    // formas y queremos mantener el parser SSE estándar.
    return res.status(401).end();
  }

  // Headers SSE correctos.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // ← crítico para nginx/Railway
  });
  res.flushHeaders?.();

  // Mensaje de apertura inmediatamente visible para confirmar al cliente.
  // Usamos el campo `event:` para que el cliente pueda escuchar 'connected'
  // sin tener que parsear `data`.
  res.write('event: connected\n');
  res.write(`data: ${JSON.stringify({ role: user.role, userId: user.userId })}\n\n`);

  const topic = bus.topicFor(user.role, user.userId);
  const listener = (event) => {
    // Si el socket ya está cerrado (race entre publish y close), escribir
    // lanzaría EPIPE. `res.write` acepta string y detecta escritura en
    // socket cerrado devolviendo false, pero queremos detección más
    // explícita.
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  bus.on(topic, listener);

  // Heartbeat cada 15s. Comentarios (`:`) son ignorados por el DOM EventSource
  // pero cuentan como bytes para mantener proxy/keepalive vivos.
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      return;
    }
    res.write(': ping\n\n');
  }, 15_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  logger.info('SSE stream abierto', { role: user.role, userId: user.userId, topic });

  req.on('close', () => {
    bus.off(topic, listener);
    clearInterval(heartbeat);
    logger.info('SSE stream cerrado', { role: user.role, userId: user.userId, topic });
  });
});

module.exports = router;
