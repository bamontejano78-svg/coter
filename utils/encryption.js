const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../config/logger');

const ALGORITHM = 'aes-256-gcm';

// Validar clave al cargar
if (config.ENCRYPTION_KEY) {
  if (!/^[0-9a-fA-F]{64}$/.test(config.ENCRYPTION_KEY)) {
    logger.error('ENCRYPTION_KEY invalida: 64 caracteres hex requeridos (32 bytes)');
  } else {
    logger.info('Encriptacion AES-256-GCM activada');
  }
} else if (!config.isProd) {
  logger.warn('ENCRYPTION_KEY no configurada - datos sensibles SIN encriptar');
}

function encrypt(text) {
  if (!text || !config.ENCRYPTION_KEY) return text;
  const iv = crypto.randomBytes(16);
  const key = Buffer.from(config.ENCRYPTION_KEY, 'hex');
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
  if (!encryptedText || !config.ENCRYPTION_KEY) return encryptedText;
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 3) return encryptedText;
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const key = Buffer.from(config.ENCRYPTION_KEY, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(parts[2], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return encryptedText;
  }
}

function decryptCheckIns(checkIns) {
  if (!checkIns || !Array.isArray(checkIns)) return checkIns;
  return checkIns.map(c => ({ ...c, thoughts: decrypt(c.thoughts) }));
}

function decryptMessages(messages) {
  if (!messages || !Array.isArray(messages)) return messages;
  return messages.map(m => ({ ...m, message: decrypt(m.message) }));
}

function decryptAssignments(assignments) {
  if (!assignments || !Array.isArray(assignments)) return assignments;
  return assignments.map(a => ({ ...a, instructions: decrypt(a.instructions) }));
}

module.exports = { encrypt, decrypt, decryptCheckIns, decryptMessages, decryptAssignments };
