/**
 * ═══════════════════════════════════════════════════════════════
 * Event Bus — Coter Pro
 *
 * In-process pub/sub usado por el stream SSE para entregar mensajes
 * y notificaciones en tiempo real al terapeuta y al paciente.
 *
 * Topics:
 *   therapist:{therapistId}    — eventos que recibe el terapeuta
 *   patient:{patientId}        — eventos que recibe el paciente
 *
 * Payload:
 *   { type: 'message:new', data: { ... } }
 *
 * También expone un sistema de *tickets* efímeros usado para autenticar
 * la conexión SSE. Los tickets NO son JWTs ni tokens persistentes:
 * son UUIDs de un solo uso, válidos por 15 segundos, que el cliente
 * canjea al abrir el stream. Esto evita que el JWT del terapeuta o el
 * auth_token del paciente viajen en la URL (donde quedarían plasmados
 * en los logs de morgan `combined` en prod).
 *
 * Por qué in-memory y no Redis Pub/Sub:
 *   Hoy la app corre como una sola instancia (Railway single service).
 *   Si en el futuro escalas horizontalmente, este módulo es la única
 *   superficie a sustituir por un adapter (e.g. ioredis-x subscribe).
 *   Las rutas solo dependen de `publish()` y `on()` — el cambio será
 *   local a este archivo, no quirúrgico a 8 rutas y 2 frontends.
 * ═══════════════════════════════════════════════════════════════
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const logger = require('../config/logger');

const TICKET_TTL_MS = 15_000; // 15s. Suficiente para que el navegador abra EventSource.

class EventBus extends EventEmitter {
  constructor() {
    super();
    // EventEmitter avisa a partir de 10 listeners. Nuestro caso típico son
    // <5 terapeutas activos por instancia con 1-2 pestañas cada uno. Subimos
    // el límite para no spammear warnings si una clínica tiene muchos usuarios.
    this.setMaxListeners(100);
    this.tickets = new Map(); // ticketUuid -> { role, userId, expiresAt }
    // Limpieza periódica para que tickets expirados no se acumulen si los
    // `setTimeout` de generateTicket se desincronizan (cron drift, etc.).
    this._gcInterval = setInterval(() => this._gcTickets(), 30_000);
    if (typeof this._gcInterval.unref === 'function') this._gcInterval.unref();
  }

  // ─── Tickets ──────────────────────────────────────────────────────
  /**
   * Genera un ticket de un solo uso para abrir el stream SSE.
   * @param {'therapist'|'patient'} role
   * @param {string} userId - id del terapeuta o paciente
   * @returns {string} UUID del ticket
   */
  generateTicket(role, userId) {
    const ticket = crypto.randomUUID();
    const expiresAt = Date.now() + TICKET_TTL_MS;
    this.tickets.set(ticket, { role, userId, expiresAt });
    setTimeout(() => {
      // Borrado silencioso: si el cliente ya lo consumió, la entrada no existirá.
      this.tickets.delete(ticket);
    }, TICKET_TTL_MS).unref?.();
    return ticket;
  }

  /**
   * Canjea un ticket: lo elimina (uso único) y devuelve los datos del usuario.
   * Devuelve `null` si el ticket no existe o está expirado.
   */
  validateTicket(ticket) {
    if (!ticket || typeof ticket !== 'string') return null;
    const data = this.tickets.get(ticket);
    if (!data) return null;
    this.tickets.delete(ticket); // single-use
    if (data.expiresAt <= Date.now()) return null;
    return { role: data.role, userId: data.userId };
  }

  _gcTickets() {
    const now = Date.now();
    for (const [t, data] of this.tickets) {
      if (data.expiresAt <= now) this.tickets.delete(t);
    }
  }

  // ─── Pub/Sub ───────────────────────────────────────────────────────
  /**
   * Publica un evento en un topic. Cualquier suscriptor activo lo recibe
   * con la forma `{ type, data }`.
   *
   * Si nadie escucha (caso común: terapeuta con la pestaña cerrada), el
   * evento se pierde por diseño. El cliente que vuelve a abrir el stream
   * (o carga la pantalla) Invoca a su vez el endpoint REST correspondiente
   * que hace de fuente de verdad. SSE no es durable storage.
   */
  publish(topic, type, data) {
    if (!topic) return;
    const payload = { type, data: data || {}, ts: Date.now() };
    this.emit(topic, payload);
  }

  /**
   * Helper para crear el nombre del topic.
   */
  topicFor(role, userId) {
    return `${role}:${userId}`;
  }
}

// Singleton: una sola instancia compartida por toda la app.
const bus = new EventBus();

module.exports = bus;
