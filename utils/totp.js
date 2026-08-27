'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 * TOTP (RFC 6238) — Coter Pro
 *
 * Implementación sin dependencias externas usando crypto nativo.
 * Compatible con Google Authenticator, Authy, 1Password, etc.
 *
 *   - HMAC-SHA1 (estándar), step 30s, 6 dígitos
 *   - Base32 RFC 4648 sin padding
 *   - Ventana de verificación configurable (±1 step por defecto)
 * ═══════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// Alfabeto base32 sin caracteres ambiguos (0/O, 1/I) para códigos de respaldo.
const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output; // sin padding '=' (la mayoría de apps lo aceptan)
}

function base32Decode(str) {
  const cleaned = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Genera un secreto base32 para TOTP (20 bytes = 160 bits, el estándar).
 * @param {number} [bytes=20]
 * @returns {string} secreto en base32 sin padding
 */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/**
 * HOTP (RFC 4226) — base del TOTP.
 * @param {string} secret - secreto base32
 * @param {number} counter - contador
 * @param {number} digits - dígitos (default 6)
 * @returns {string} código de `digits` dígitos
 */
function hotp(secret, counter, digits = 6) {
  const key = base32Decode(secret);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return (bin % Math.pow(10, digits)).toString().padStart(digits, '0');
}

/**
 * TOTP (RFC 6238) para un timestamp dado.
 * @param {string} secret - secreto base32
 * @param {Object} [opts]
 * @param {number} [opts.time=Date.now()] - epoch en milisegundos
 * @param {number} [opts.step=30] - periodo en segundos
 * @param {number} [opts.digits=6]
 * @returns {string} código TOTP
 */
function totp(secret, opts = {}) {
  const { time = Date.now(), step = 30, digits = 6 } = opts;
  const counter = Math.floor(time / 1000 / step);
  return hotp(secret, counter, digits);
}

/**
 * Verifica un código TOTP tolerando `window` pasos a cada lado.
 * Comparación de strings (suficiente para 6 dígitos).
 * @param {string} secret
 * @param {string} token
 * @param {Object} [opts]
 * @param {number} [opts.window=1]
 * @param {number} [opts.time=Date.now()]
 * @param {number} [opts.step=30]
 * @param {number} [opts.digits=6]
 * @returns {boolean}
 */
function verifyTotp(secret, token, opts = {}) {
  const { window: win = 1, time = Date.now(), step = 30, digits = 6 } = opts;
  if (typeof token !== 'string') return false;
  if (!new RegExp('^\\d{' + digits + '}$').test(token)) return false;
  const counter = Math.floor(time / 1000 / step);
  for (let i = -win; i <= win; i++) {
    if (hotp(secret, counter + i, digits) === token) return true;
  }
  return false;
}

/**
 * Construye la URI otpauth:// para registrar el secreto en apps autenticadoras.
 * @param {string} secret - secreto base32
 * @param {string} accountName - normalmente el email del usuario
 * @param {string} [issuer='Coter Pro']
 * @returns {string}
 */
function otpauthUrl(secret, accountName, issuer = 'Coter Pro') {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(accountName);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return 'otpauth://totp/' + label + '?' + params.toString();
}

/**
 * Genera códigos de respaldo legibles por humanos (16 chars base32 sin ambiguos).
 * @param {number} [count=10]
 * @returns {string[]}
 */
function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    // 16 bytes, cada uno mapeado a BACKUP_ALPHABET (256 % 32 === 0 → sin sesgo).
    const bytes = crypto.randomBytes(16); // 16 × 5 bits = 80 bits de entropía
    let code = '';
    for (let j = 0; j < 16; j++) {
      code += BACKUP_ALPHABET[bytes[j] % 32];
    }
    codes.push(code);
  }
  return codes;
}

/**
 * Normaliza un código de respaldo introducido por el usuario
 * (tolera minúsculas, espacios y guiones). Devuelve null si el formato
 * no parece un código de respaldo.
 * @param {string} code
 * @returns {string|null} código normalizado en mayúsculas o null
 */
function normalizeBackupCode(code) {
  if (typeof code !== 'string') return null;
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // A-HJ-NP-Z (sin I/O) + 2-9 → alfabeto de respaldo sin ambiguos
  if (!/^[A-HJ-NP-Z2-9]{16}$/.test(normalized)) return null;
  return normalized;
}

module.exports = {
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  totp,
  verifyTotp,
  otpauthUrl,
  generateBackupCodes,
  normalizeBackupCode,
};
