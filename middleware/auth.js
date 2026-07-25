const jwt = require('jsonwebtoken');
const config = require('../config/env');
const logger = require('../config/logger');
const { getPool } = require('../database');
const { COOKIE_NAMES, getCookie } = require('../utils/cookies');

function bearerToken(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token || token === 'null' || token === 'undefined') return null;
  return token;
}

const authenticateToken = (req, res, next) => {
  const token = bearerToken(req) || getCookie(req, COOKIE_NAMES.therapistAccess);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Token requerido' });
  }

  jwt.verify(token, config.JWT_SECRET, (err, user) => {
    if (err) {
      logger.warn('Token invalido', { error: err.message });
      return res.status(403).json({ success: false, error: 'Token invalido o expirado' });
    }
    req.user = user;
    next();
  });
};

// Autenticación para pacientes (token simple guardado en BD)
const authenticatePatient = async (req, res, next) => {
  const { patientId } = req.params;
  const token = bearerToken(req) || getCookie(req, COOKIE_NAMES.patientAuth);

  if (!patientId) {
    return res.status(400).json({ success: false, error: 'ID de paciente requerido' });
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'Token requerido' });
  }

  try {
    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT id FROM patients WHERE id = $1 AND auth_token = $2',
      [patientId, token]
    );

    if (rows.length === 0) {
      return res.status(403).json({ success: false, error: 'Token invalido o paciente no encontrado' });
    }

    req.patientId = patientId;
    next();
  } catch (err) {
    logger.error('Error en auth paciente', { error: err.message });
    return res.status(500).json({ success: false, error: 'Error de autenticacion' });
  }
};

module.exports = { authenticateToken, authenticatePatient };
