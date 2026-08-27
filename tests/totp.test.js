// Tests unitarios de utils/totp.js — RFC 6238
const {
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  totp,
  verifyTotp,
  otpauthUrl,
  generateBackupCodes,
  normalizeBackupCode,
} = require('../utils/totp');

// Secreto de los vectores del Apéndice B de RFC 6238:
// ASCII "12345678901234567890" → base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_SECRET_ASCII = '12345678901234567890';

describe('base32 (RFC 4648)', () => {
  test('encode ASCII "12345678901234567890"', () => {
    expect(base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'))).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  test('decode round-trip', () => {
    const decoded = base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(decoded.toString('ascii')).toBe(RFC_SECRET_ASCII);
  });

  test('tolera minúsculas y padding "="', () => {
    const decoded = base32Decode('gezdgnbvgy3tqojqgezdgnbvgy3tqojq====');
    expect(decoded.toString('ascii')).toBe(RFC_SECRET_ASCII);
  });

  test('generateSecret produce base32 válido de 32 chars', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret).length).toBe(20);
  });
});

describe('TOTP — vectores RFC 6238 (SHA1)', () => {
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  test.each(vectors)('T=%d → %s (8 dígitos)', (time, expected) => {
    expect(hotp(RFC_SECRET, Math.floor(time / 30), 8)).toBe(expected);
  });

  test('código de 6 dígitos para T=59 es 287082', () => {
    expect(totp(RFC_SECRET, { time: 59 * 1000, digits: 6 })).toBe('287082');
  });

  test('verifyTotp acepta el código correcto dentro de la ventana', () => {
    const time = 1234567890 * 1000;
    const code = totp(RFC_SECRET, { time });
    expect(verifyTotp(RFC_SECRET, code, { time })).toBe(true);
  });

  test('verifyTotp rechaza código incorrecto', () => {
    expect(verifyTotp(RFC_SECRET, '000000', { time: 59 * 1000 })).toBe(false);
  });

  test('verifyTotp acepta ±1 step por desincronización de reloj', () => {
    const time = 1234567890 * 1000;
    const nextCode = totp(RFC_SECRET, { time: time + 30 * 1000 });
    expect(verifyTotp(RFC_SECRET, nextCode, { time })).toBe(true);
    const staleCode = totp(RFC_SECRET, { time: time - 30 * 1000 });
    expect(verifyTotp(RFC_SECRET, staleCode, { time })).toBe(true);
    // Fuera de ventana (±2 steps) → rechazado
    const farCode = totp(RFC_SECRET, { time: time + 90 * 1000 });
    expect(verifyTotp(RFC_SECRET, farCode, { time })).toBe(false);
  });

  test('verifyTotp rechaza formatos no numéricos', () => {
    expect(verifyTotp(RFC_SECRET, 'abcdef')).toBe(false);
    expect(verifyTotp(RFC_SECRET, '12345')).toBe(false);
    expect(verifyTotp(RFC_SECRET, null)).toBe(false);
  });
});

describe('otpauthUrl', () => {
  test('construye URI con issuer y account', () => {
    const uri = otpauthUrl(RFC_SECRET, 'ana@coter.com', 'Coter Pro');
    expect(uri).toContain('otpauth://totp/Coter%20Pro:ana%40coter.com');
    expect(uri).toContain('secret=' + RFC_SECRET);
    expect(uri).toContain('issuer=Coter+Pro');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('códigos de respaldo', () => {
  test('genera 10 códigos de 16 chars del alfabeto sin ambiguos', () => {
    const codes = generateBackupCodes(10);
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{16}$/);
    }
    // Todos distintos
    expect(new Set(codes).size).toBe(10);
  });

  test('normalizeBackupCode tolera minúsculas y separadores', () => {
    expect(normalizeBackupCode('abcdefg-hjklmnpqr')).toBe('ABCDEFGHJKLMNPQR');
    expect(normalizeBackupCode('ABCDEFGHJKLMNPQR')).toBe('ABCDEFGHJKLMNPQR');
    expect(normalizeBackupCode('')).toBeNull();
    expect(normalizeBackupCode('123456')).toBeNull(); // parece TOTP, no respaldo
    expect(normalizeBackupCode(null)).toBeNull();
    expect(normalizeBackupCode('ABCDEFGHJKLMNPQIO')).toBeNull(); // I/O no están en el alfabeto
    expect(normalizeBackupCode('ZZZZZZZZZZZZZZZZZZZZ')).toBeNull(); // 20 chars ≠ 16
  });
});
