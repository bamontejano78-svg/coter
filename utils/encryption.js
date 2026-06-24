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

// Lazy key resolution. config/env.js captures ENCRYPTION_KEY at module-load
// time, pero los tests (p. ej. tests/api.test.js) requieren '../database'
// ANTES de setear process.env.ENCRYPTION_KEY explícitamente. Eso provocaba
// que config.ENCRYPTION_KEY quedara undefined y encrypt() hacía un silent
// fall-through a plaintext — un PHI leak muy difícil de detectar porque los
// tests de mensajes/check-ins solo verificaban longitud, no round-trip
// ciphertext. Leer process.env en cada llamada elimina la dependencia del
// orden de requires y mantiene la promesa de la util de encriptar siempre
// cuando la variable está presente (aunque se setee tarde).
function activeKey() {
  return process.env.ENCRYPTION_KEY || config.ENCRYPTION_KEY;
}

// loadKey() devuelve un Buffer válido de 32 bytes o lanza un error loudly.
// Devuelve null si NO hay clave configurada (caso dev/no-test);
// lanza si la clave está mal-formada para evitar que encrypt()/decrypt()
// caigan en un silent fall-through a plaintext — el bug original que
// activeKey() cierra. El throw está deliberadamente FUERA del try/catch
// de decrypt para no ser capturado y reintroducir el leak que estamos
// cerrando.
function loadKey() {
  const k = activeKey();
  if (!k) return null;
  const buf = Buffer.from(k, 'hex');
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY no decodifica a 32 bytes (AES-256). Verifica formato hex de 64 caracteres.');
  }
  return buf;
}

function encrypt(text) {
  if (!text) return text;
  const keyBuf = loadKey();
  if (!keyBuf) return text;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuf, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
  if (!encryptedText) return encryptedText;
  const keyBuf = loadKey();
  if (!keyBuf) return encryptedText;
  // keyBuf.length === 32 ya garantizado por loadKey() (que lanza si < 32),
  // así que el try/catch de aquí abajo SOLO cubre errores esperados durante
  // el decipher (formato blob inválido, authTag mismatch, etc). Bad key se
  // propaga como excepción a la ruta, que la reporta como 500 — desired.
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 3) return encryptedText;
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, keyBuf, iv);
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
