// ════════════════════════════════════════════════════════════════════════════
// tests/exerciseEncryption.test.js
// ════════════════════════════════════════════════════════════════════════════
// Unit tests para utils/exerciseEncryption.js — sin BD, sin red.
//
// IMPORTANTE: las env vars se setean ANTES del primer require. Sin
// ENCRYPTION_KEY, utils/encryption.js es no-op y todos los round-trips
// fallarían. (Cuando este test corre dentro del api.test.js suite, jest
// ejecuta cada archivo en una VM independiente — no hay herencia.)
// ════════════════════════════════════════════════════════════════════════════

process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

const logger = require('../config/logger');
const {
  encryptFieldsForKind,
  decryptFieldsForKind,
  parsePath,
  getAtPath,
  setAtPath,
  deleteAtPath,
} = require('../utils/exerciseEncryption');
const {
  THOUGHT_RECORD_SCHEMA,
  BA_DIARY_SCHEMA,
  GE_AGORAPHOBIA_SCHEMA,
} = require('../utils/exerciseSchemas');

let warnSpy;
beforeEach(() => {
  warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe('parsePath', () => {
  test('parses simple top-level keys', () => {
    expect(parsePath('situation')).toEqual(['situation']);
    expect(parsePath('evidence_for')).toEqual(['evidence_for']);
  });

  test('parses bracketed indices inside a repeater', () => {
    expect(parsePath('emotions[0].name')).toEqual(['emotions', 0, 'name']);
    expect(parsePath('emotions[2].intensity')).toEqual(['emotions', 2, 'intensity']);
  });

  test('parses multiple brackets in sequence', () => {
    expect(parsePath('a[0][1].b')).toEqual(['a', 0, 1, 'b']);
  });

  test('rejects empty path', () => {
    expect(() => parsePath('')).toThrow();
  });

  test('rejects open bracket without close', () => {
    expect(() => parsePath('emotions[0')).toThrow();
  });

  test('rejects non-numeric bracket', () => {
    expect(() => parsePath('emotions[abc]')).toThrow();
  });

  test('rejects negative bracket (deferred feature)', () => {
    expect(() => parsePath('emotions[-1]')).toThrow();
  });
});

describe('getAtPath / setAtPath / deleteAtPath round-trip', () => {
  test('top-level keys round-trip', () => {
    const obj = {};
    setAtPath(obj, 'situation', 'texto');
    expect(obj.situation).toBe('texto');
    expect(getAtPath(obj, 'situation')).toBe('texto');
    deleteAtPath(obj, 'situation');
    expect(getAtPath(obj, 'situation')).toBeUndefined();
    expect(Object.keys(obj)).toEqual([]);
  });

  test('nested repeater path round-trip with indexed array', () => {
    const obj = {};
    setAtPath(obj, 'emotions[0].name', 'ansiedad');
    setAtPath(obj, 'emotions[0].intensity', 75);
    setAtPath(obj, 'emotions[1].name', 'ira');
    expect(getAtPath(obj, 'emotions[0].name')).toBe('ansiedad');
    expect(getAtPath(obj, 'emotions[0].intensity')).toBe(75);
    expect(getAtPath(obj, 'emotions[1].name')).toBe('ira');
    expect(getAtPath(obj, 'emotions[2]')).toBeUndefined();
    // Eliminar emotions[0] entero: el array se compacta y el que estaba en
    // index 1 ahora vive en index 0. Eso es splice semantic.
    deleteAtPath(obj, 'emotions[0]');
    expect(obj.emotions.length).toBe(1);
    expect(getAtPath(obj, 'emotions[0].name')).toBe('ira');
    expect(getAtPath(obj, 'emotions[1]')).toBeUndefined();
  });

  test('setAtPath creates arrays vs objects based on the next token type', () => {
    const obj = {};
    setAtPath(obj, 'a[2].b[1]', 'final');
    expect(Array.isArray(obj.a)).toBe(true);
    expect(Array.isArray(obj.a[2].b)).toBe(true);
    expect(obj.a[2].b[1]).toBe('final');
  });

  test('setAtPath does not overwrite an existing array with an object', () => {
    const obj = { a: [{ b: 1 }, { b: 2 }] };
    setAtPath(obj, 'a[0].b', 99);
    expect(obj.a).toEqual([{ b: 99 }, { b: 2 }]);
  });

  test('setAtPath with missing intermediate object creates one lazily', () => {
    const obj = {};
    setAtPath(obj, 'x.y.z', 42);
    expect(obj.x.y.z).toBe(42);
  });

  test('getAtPath returns undefined on missing branches instead of throwing', () => {
    const obj = {};
    expect(getAtPath(obj, 'x.y.z')).toBeUndefined();
    expect(getAtPath(undefined, 'x')).toBeUndefined();
    expect(getAtPath(null, 'x')).toBeUndefined();
  });

  test('deleteAtPath on missing keys is a no-op (does not throw)', () => {
    const obj = { a: 1 };
    expect(() => deleteAtPath(obj, 'b.c.d')).not.toThrow();
    expect(() => deleteAtPath(undefined, 'x.y')).not.toThrow();
    expect(() => deleteAtPath(null, 'x')).not.toThrow();
  });

  test('deleteAtPath on top-level string key', () => {
    const obj = { a: 1, b: 2 };
    deleteAtPath(obj, 'a');
    expect(obj).toEqual({ b: 2 });
  });
});

describe('encryptFieldsForKind', () => {
  test('classic / null schema → no-op (responses unchanged, blob=null)', () => {
    const responses = { foo: 'bar', baz: 42 };
    const result = encryptFieldsForKind(responses, null);
    expect(result.responses).toEqual(responses);
    expect(result.encrypted_blob).toBeNull();
  });

  test('schema without sensitive fields → no-op', () => {
    const responses = { foo: 'bar' };
    const schema = { fields: [{ key: 'foo', type: 'text', sensitive: false }] };
    const result = encryptFieldsForKind(responses, schema);
    expect(result.encrypted_blob).toBeNull();
    expect(result.responses).toEqual(responses);
  });

  test('TR: extracts all 5 sensitive fields into blob, leaves emotions+distortions+emotions_after in responses', () => {
    const responses = {
      situation: 'Reunión trimestral',
      automatic_thought: 'Me van a despedir',
      emotions: [{ name: 'ansiedad', intensity: 85, body_location: 'pecho' }],
      distortions: ['catastrophizing', 'labeling'],
      evidence_for: 'Llegué tarde',
      evidence_against: 'Evaluación previa buena',
      alternative_thought: 'Hay datos mixtos',
      emotions_after: [{ name: 'ansiedad', intensity: 50 }],
    };
    const result = encryptFieldsForKind(responses, THOUGHT_RECORD_SCHEMA);
    expect(result.encrypted_blob).toBeDefined();
    expect(typeof result.encrypted_blob).toBe('string');
    // responses NUNCA contiene los campos sensibles (limpiados)
    expect(result.responses).not.toHaveProperty('situation');
    expect(result.responses).not.toHaveProperty('automatic_thought');
    expect(result.responses).not.toHaveProperty('evidence_for');
    expect(result.responses).not.toHaveProperty('evidence_against');
    expect(result.responses).not.toHaveProperty('alternative_thought');
    // Los no sensibles siguen
    expect(result.responses.emotions).toEqual([{ name: 'ansiedad', intensity: 85, body_location: 'pecho' }]);
    expect(result.responses.distortions).toEqual(['catastrophizing', 'labeling']);
    expect(result.responses.emotions_after).toEqual([{ name: 'ansiedad', intensity: 50 }]);
  });

  test('TR round-trip: encrypt then decrypt recovers the original object', () => {
    const original = {
      situation: 'reunión',
      automatic_thought: 'me van a despedir',
      emotions: [{ name: 'ansiedad', intensity: 85, body_location: 'pecho' }],
      distortions: ['catastrophizing'],
      evidence_for: 'llegué tarde',
      evidence_against: 'evaluación previa buena',
      alternative_thought: 'datos mixtos',
      emotions_after: [{ name: 'ansiedad', intensity: 50 }],
    };
    const encrypted = encryptFieldsForKind(original, THOUGHT_RECORD_SCHEMA);
    const recovered = decryptFieldsForKind(encrypted.responses, encrypted.encrypted_blob, THOUGHT_RECORD_SCHEMA);
    // El round-trip debe preservar no solo las claves presentes, sino los
    // valores originales. Esto valida que (a) la envoltura es lossless y
    // (b) la merge de paths re-construye los arrays repeater completos.
    expect(recovered).toEqual(original);
  });

  test('does NOT mutate the input responses (deep clone)', () => {
    const input = {
      situation: 'X',
      automatic_thought: 'Y',
      emotions: [{ name: 'ira', intensity: 80 }],
      distortions: ['labeling'],
      alternative_thought: 'Z',
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    encryptFieldsForKind(input, THOUGHT_RECORD_SCHEMA);
    expect(input).toEqual(snapshot);
  });

  test('empty sensitive strings are SKIPPED from blob AND stripped from responses (no empty PHI in JSONB)', () => {
    const input = {
      situation: '',
      automatic_thought: 'auto',
      emotions: [{ name: 'ansiedad', intensity: 50 }],
      distortions: ['mind_reading'],
      evidence_for: '',
      evidence_against: '',
      alternative_thought: '',
    };
    const result = encryptFieldsForKind(input, THOUGHT_RECORD_SCHEMA);
    expect(result.encrypted_blob).toBeDefined();
    expect(result.responses).not.toHaveProperty('situation');
    expect(result.responses).not.toHaveProperty('evidence_for');
    expect(result.responses).not.toHaveProperty('evidence_against');
    expect(result.responses).not.toHaveProperty('alternative_thought');
    // el único no vacío (automatic_thought) se fue al blob
    expect(result.responses).not.toHaveProperty('automatic_thought');
  });

  test('all sensitive empty → blob=null (no encriptar envelope vacío)', () => {
    const input = {
      situation: '', automatic_thought: '',
      emotions: [{ name: 'a', intensity: 50 }],
      distortions: ['mind_reading'],
      evidence_for: '', evidence_against: '',
      alternative_thought: '',
    };
    const result = encryptFieldsForKind(input, THOUGHT_RECORD_SCHEMA);
    expect(result.encrypted_blob).toBeNull();
    expect(result.responses).toEqual({
      emotions: [{ name: 'a', intensity: 50 }],
      distortions: ['mind_reading'],
    });
  });

  test('synthetic schema with item_sensitive=true: extracts every per-item child into blob, splices whole items from cleaned', () => {
    const schema = {
      fields: [
        {
          key: 'journal', type: 'repeater', item_sensitive: true,
          fields: [
            { key: 'entry',  type: 'text',    sensitive: false },
            { key: 'rating', type: 'number',  sensitive: false },
          ],
        },
      ],
    };
    const input = {
      journal: [
        { entry: 'primer día difícil', rating: 2 },
        { entry: 'algo mejor',         rating: 6 },
      ],
    };
    const result = encryptFieldsForKind(input, schema);
    expect(result.encrypted_blob).toBeDefined();
    // responses: propiedad journal entera eliminada (splice total de items).
    expect(result.responses).toEqual({});
    // Decrypt round-trip: setAtPath reconstruye journal con todos los items.
    const recovered = decryptFieldsForKind(result.responses, result.encrypted_blob, schema);
    expect(recovered).toEqual(input);
  });

  test('synthetic schema with item_sensitive=false and partial child sensitivity: only the sensitive child fields go to the blob', () => {
    const schema = {
      fields: [
        {
          key: 'logs', type: 'repeater', item_sensitive: false,
          fields: [
            { key: 'time',    type: 'text',     sensitive: false },
            { key: 'content', type: 'textarea', sensitive: true },
            { key: 'severity', type: 'scale',   sensitive: false, min: 0, max: 10 },
          ],
        },
      ],
    };
    const input = {
      logs: [
        { time: '10:00', content: 'pensé que me iban a despedir', severity: 8 },
        { time: '14:00', content: 'todo normal',                    severity: 3 },
      ],
    };
    const result = encryptFieldsForKind(input, schema);
    expect(result.encrypted_blob).toBeDefined();
    // responses keeps non-sensitive fields per item con `content` strippeado
    expect(result.responses.logs[0].time).toBe('10:00');
    expect(result.responses.logs[0].severity).toBe(8);
    expect(result.responses.logs[0]).not.toHaveProperty('content');
    expect(result.responses.logs[1].time).toBe('14:00');
    expect(result.responses.logs[1].severity).toBe(3);
    expect(result.responses.logs[1]).not.toHaveProperty('content');
    // Round-trip
    const recovered = decryptFieldsForKind(result.responses, result.encrypted_blob, schema);
    expect(recovered).toEqual(input);
  });

  test('GE: complete valid input → extracts notes only and round-trips', () => {
    const input = {
      step: 1, date: '2026-06-23', suds_pre: 60, suds_post: 35, completed: true,
      notes: 'Avance: ansiedad bajó de 60 a 35',
    };
    const result = encryptFieldsForKind(input, GE_AGORAPHOBIA_SCHEMA);
    expect(result.encrypted_blob).toBeDefined();
    expect(result.responses).not.toHaveProperty('notes');
    // Lo no sensible limpio
    expect(result.responses.step).toBe(1);
    expect(result.responses.suds_pre).toBe(60);
    expect(result.responses.suds_post).toBe(35);
    expect(result.responses.completed).toBe(true);
    // Round-trip
    const recovered = decryptFieldsForKind(result.responses, result.encrypted_blob, GE_AGORAPHOBIA_SCHEMA);
    expect(recovered).toEqual(input);
  });

  test('BA diary round-trip with non-sensitive + sensitive', () => {
    const input = {
      activity: 'Pasear 20 min por un parque',
      time_slot: 'Tarde',
      duration_min: 20,
      pleasure: 7,
      achievement: 4,
      accompanying: 'solo',
      notes: 'Estuvo bien repetirla por segunda vez esta semana',
    };
    const result = encryptFieldsForKind(input, BA_DIARY_SCHEMA);
    expect(result.encrypted_blob).toBeDefined();
    expect(result.responses).not.toHaveProperty('notes');
    expect(result.responses.activity).toBe('Pasear 20 min por un parque');
    expect(result.responses.time_slot).toBe('Tarde');
    expect(result.responses.pleasure).toBe(7);
    const recovered = decryptFieldsForKind(result.responses, result.encrypted_blob, BA_DIARY_SCHEMA);
    expect(recovered).toEqual(input);
  });

  test('full_strip synthetic: encrypting → all items spliced, blob holds full content, decrypt reconstructs', () => {
    const schema = {
      fields: [
        {
          key: 'log_diario', type: 'repeater', item_sensitive: true,
          fields: [
            { key: 'mood', type: 'scale', sensitive: false, min: 0, max: 10 },
            { key: 'note', type: 'textarea', sensitive: false },
          ],
        },
      ],
    };
    const input = { log_diario: [{ mood: 4, note: 'bajón por la mañana' }, { mood: 7, note: 'mejor tras comer' }] };
    const result = encryptFieldsForKind(input, schema);
    expect(result.responses.log_diario).toBeUndefined();
    const recovered = decryptFieldsForKind(result.responses, result.encrypted_blob, schema);
    expect(recovered).toEqual(input);
  });
});

describe('decryptFieldsForKind defensive paths', () => {
  test('null blob → returns responses unchanged (no-op)', () => {
    const responses = { foo: 1 };
    expect(decryptFieldsForKind(responses, null, THOUGHT_RECORD_SCHEMA)).toEqual(responses);
  });

  test('undefined blob → returns responses unchanged', () => {
    const responses = { foo: 1 };
    expect(decryptFieldsForKind(responses, undefined, THOUGHT_RECORD_SCHEMA)).toEqual(responses);
  });

  test('non-string blob → no-op (early return, no log warn)', () => {
    const responses = { foo: 1 };
    const result = decryptFieldsForKind(responses, 12345, THOUGHT_RECORD_SCHEMA);
    expect(result).toEqual(responses);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('blob malformado (no formato iv:authTag:ct) → no-op + log.warn', () => {
    const responses = { distortion: ['catastrophizing'] };
    const result = decryptFieldsForKind(responses, 'esto-no-es-un-ciphertext-valido', THOUGHT_RECORD_SCHEMA);
    expect(result).toEqual({ distortion: ['catastrophizing'] });
    expect(warnSpy).toHaveBeenCalled();
  });

  test('null schema con blob presente → no-op + log.warn', () => {
    const responses = { foo: 1 };
    const result = decryptFieldsForKind(responses, 'aa:bb:cc', null);
    expect(result).toEqual(responses);
    expect(warnSpy).toHaveBeenCalled();
  });

  test('envelope con path inválido: setAtPath falla por clave rota pero el resto del envelope se mergea', () => {
    // Bypassamos encrypt: usamos utils/encryption.js directo para forzar un
    // envelope con un path imposible ("emotions[abc].name" — idx es NaN).
    // parsePath()[abc] rechaza → setAtPath lanza. La parte buena del
    // envelope ("alternative_thought":"sí") SÍ debe mergear.
    const { encrypt } = require('../utils/encryption');
    const fakeEnvelope = '{"emotions[abc].name":"x","alternative_thought":"sí"}';
    const blob = encrypt(fakeEnvelope);
    const responses = {
      emotions: [{ intensity: 50 }],
      distortions: ['mind_reading'],
    };
    const result = decryptFieldsForKind(responses, blob, THOUGHT_RECORD_SCHEMA);
    // La parte buena se mergear: alternative_thought aterriza en result.
    expect(result.alternative_thought).toBe('sí');
    // El resto (campos no sensibles) sigue intacto.
    expect(result).toEqual({
      emotions: [{ intensity: 50 }],
      distortions: ['mind_reading'],
      alternative_thought: 'sí',
    });
    // Y emitimos un warn por la clave rota (sin abortar el merge).
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('integration: getSensitiveFieldPaths + encrypt + decrypt compose correctly', () => {
  test('TR completo cubre 5 campos top-level sensibles y round-trip con AES-256-GCM real', () => {
    const fresh = {
      situation: 'reunión trimestral', automatic_thought: 'me van a despedir',
      emotions: [{ name: 'ansiedad', intensity: 85, body_location: 'pecho' }],
      distortions: ['catastrophizing', 'labeling'],
      evidence_for: 'llegué tarde', evidence_against: 'evaluación previa buena',
      alternative_thought: 'datos mixtos',
      emotions_after: [{ name: 'ansiedad', intensity: 50 }],
    };
    const result = encryptFieldsForKind(fresh, THOUGHT_RECORD_SCHEMA);
    expect(result.encrypted_blob).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/); // iv:authTag:ct encriptado
    const recovered = decryptFieldsForKind(result.responses, result.encrypted_blob, THOUGHT_RECORD_SCHEMA);
    expect(recovered).toEqual(fresh);
  });

  test('blob AES-256-GCM es opaco (no es el envelope en claro)', () => {
    // Sanity check adicional: el blob en BD debe ser ciphertext, no JSON.
    // Si utils/encryption.js se rompe (no-op) el test anterior fallaría —
    // aquí añadimos un assertion explícito sobre el formato.
    const { encrypt, decrypt } = require('../utils/encryption');
    const sample = '{"situation":"X","automatic_thought":"Y"}';
    const ct = encrypt(sample);
    expect(ct).not.toBe(sample);                     // no es plain text
    expect(ct).not.toContain('situaci');             // no expone texto plano
    expect(ct.split(':').length).toBe(3);           // iv:authTag:ct
    // Sanity: decrypt del ciphertext recupera el envelope original.
    expect(decrypt(ct)).toBe(sample);
  });
});
