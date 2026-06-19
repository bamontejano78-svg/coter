/**
 * ═══════════════════════════════════════════════════════════════
 * Audit Logging — Coter Pro
 * 
 * Registra operaciones sensibles para cumplimiento GDPR/HIPAA.
 * Usa Winston structured logging para facilitar parseo por
 * herramientas de agregación de logs (Datadog, ELK, etc.).
 * 
 * Cada evento incluye:
 *   - who: id del usuario que realizó la acción
 *   - role: 'therapist' | 'patient' | 'system'
 *   - action: verbo descriptivo (ej: 'login', 'view_patient')
 *   - resource: tipo de recurso afectado
 *   - resourceId: id del recurso
 *   - ip: dirección IP del cliente
 *   - metadata: datos adicionales específicos del evento
 * ═══════════════════════════════════════════════════════════════
 */

const logger = require('../config/logger');

/**
 * Registra un evento de auditoría
 * @param {Object} opts
 * @param {string} opts.who - ID del usuario
 * @param {'therapist'|'patient'|'system'} opts.role
 * @param {string} opts.action - Verbo: 'login','logout','view_patient','create_assignment', etc.
 * @param {string} [opts.resource] - Tipo de recurso
 * @param {string} [opts.resourceId] - ID del recurso
 * @param {string} [opts.ip] - IP del cliente
 * @param {Object} [opts.metadata] - Datos adicionales
 */
function audit(opts) {
  const { who, role, action, resource, resourceId, ip, metadata } = opts;

  logger.info('AUDIT', {
    event: 'audit',
    who: who || 'anonymous',
    role: role || 'unknown',
    action,
    resource: resource || null,
    resourceId: resourceId || null,
    ip: ip || null,
    metadata: metadata || {},
    timestamp: new Date().toISOString(),
  });
}

/**
 * Registra acceso a datos de paciente (para cumplimiento GDPR)
 */
function auditAccess(req, action, patientId, metadata = {}) {
  const who = req.user?.id || req.patientId || 'anonymous';
  const role = req.user ? 'therapist' : (req.patientId ? 'patient' : 'system');
  const ip = req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress;

  audit({
    who,
    role,
    action,
    resource: 'patient_data',
    resourceId: patientId,
    ip,
    metadata,
  });
}

/**
 * Registra cambios en datos sensibles (crear/modificar/eliminar)
 */
function auditChange(req, action, resource, resourceId, metadata = {}) {
  const who = req.user?.id || 'system';
  const role = req.user ? 'therapist' : 'system';
  const ip = req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress;

  audit({
    who,
    role,
    action,
    resource,
    resourceId,
    ip,
    metadata,
  });
}

module.exports = { audit, auditAccess, auditChange };
