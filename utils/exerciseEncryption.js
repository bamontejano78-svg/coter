// ════════════════════════════════════════════════════════════════════════════
// utils/exerciseEncryption.js
// ════════════════════════════════════════════════════════════════════════════
// Encriptación por-campo de las respuestas de un exercise_session.
//
// Por qué existe:
//   exercise_sessions.responses es JSONB en plano, lo cual sirve para queries
//   agregadas (ej: "¿cuáles son las distorsiones cognitivas más frecuentes
//   del paciente X esta semana?"). Pero los pensamientos automáticos, las
//   evidencias a favor/en contra y las reflexiones libres son PHI (Protected
//   Health Information) y NO deben quedar en el JSONB sin encriptar.
//
//   Para mantener ambos objetivos (queryable + PHI encriptado), separamos:
//     - `responses`: solo campos NO sensibles. Se insertan planos en JSONB.
//     - `encrypted_blob`: concatenación cifrada AES-256-GCM de los campos
//       sensibles, codificada como JSON plano con paths dot-bracket.
//
// Contrato:
//   · Entrada: (responses, schema) → { responses, encrypted_blob }
//   · Salida : (responses, encrypted_blob, schema) → responses merged
//   · kind === 'classic' → no-op: blob = null, responses unchanged.
//   · Campos sensibles vacíos ("" / null / undefined) → se omiten del blob
//     para reducir ruido en BD sin perderlos de `responses` (ya estaban vacíos).
//   · Blob malformado / descifrado fallido → fallback seguro: responses
//     se devuelve sin merge (la sesión no queda "rota" en la UI; simplemente
//     los textos sensibles aparecen vacíos hasta que el terapeuta reabra).
//
//   · Path notation: "situation" | "emotions[2].body_location".
//     Los tokens siguen siendo legibles en BD para forensics. La estructura
//     anidada plana permite merge determinista sin ambigüedad.
//
// Dependencias:
//   utils/encryption.js  → encrypt / decrypt AES-256-GCM
//   utils/exerciseSchemas.js → getSensitiveFieldPaths(schema)
//   config/logger.js → logger.warn para fallback
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { encrypt, decrypt } = require('./encryption');
const { getSensitiveFieldPaths } = require('./exerciseSchemas');
const logger = require('../config/logger');

// ─── Path parser / setter / getter ───────────────────────────────────────
// Soporta paths como:
//   "situation"                              → tokens ["situation"]
//   "emotions"                               → ["emotions"]
//   "emotions[0].name"                       → ["emotions", 0, "name"]
//   "emotions[2].intensity"                  → ["emotions", 2, "intensity"]
//   "emotions_after[1].intensity"            → ["emotions_after", 1, "intensity"]
//
// NO soporta paths negativos. NO soporta wildcards "[]". Los wildcards se
// resuelven en caller (encryptFieldsForKind) generando un path indexado
// concreto por cada item del array en `responses`.

function parsePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('parsePath: path debe ser un string no vacío');
  }
  const out = [];
  let i = 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') { i++; continue; }
    if (ch === '[') {
      const end = path.indexOf(']', i);
      if (end === -1) throw new Error('parsePath: bracket sin cerrar en "' + path + '"');
      const num = parseInt(path.substring(i + 1, end), 10);
      if (Number.isNaN(num) || num < 0) throw new Error('parsePath: índice inválido en "' + path + '"');
      out.push(num);
      i = end + 1;
      continue;
    }
    let next = i;
    while (next < path.length && path[next] !== '.' && path[next] !== '[') next++;
    if (next === i) throw new Error('parsePath: separador inesperado en "' + path + '"');
    out.push(path.substring(i, next));
    i = next;
  }
  return out;
}

function getAtPath(obj, path) {
  if (obj === null || obj === undefined) return undefined;
  const tokens = parsePath(path);
  let cur = obj;
  for (let j = 0; j < tokens.length; j++) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[tokens[j]];
  }
  return cur;
}

function setAtPath(obj, path, value) {
  const tokens = parsePath(path);
  let cur = obj;
  for (let j = 0; j < tokens.length - 1; j++) {
    const tok = tokens[j];
    const nextTok = tokens[j + 1];
    if (typeof tok === 'number') {
      while (cur.length <= tok) {
        cur.push(typeof nextTok === 'number' ? [] : {});
      }
      cur = cur[tok];
    } else {
      if (cur[tok] === undefined || cur[tok] === null || typeof cur[tok] !== 'object') {
        cur[tok] = typeof nextTok === 'number' ? [] : {};
      }
      cur = cur[tok];
    }
  }
  cur[tokens[tokens.length - 1]] = value;
}

function deleteAtPath(obj, path) {
  if (obj === null || obj === undefined) return;
  const tokens = parsePath(path);
  let cur = obj;
  for (let j = 0; j < tokens.length - 1; j++) {
    const tok = tokens[j];
    if (cur === null || cur === undefined) return;
    cur = cur[tok];
  }
  if (cur === null || cur === undefined) return;
  const last = tokens[tokens.length - 1];
  if (typeof last === 'number' && Array.isArray(cur)) {
    cur.splice(last, 1);
  } else if (typeof last === 'string' && cur && typeof cur === 'object') {
    delete cur[last];
  }
}

function deepClone(x) {
  if (x === undefined) return undefined;
  return JSON.parse(JSON.stringify(x));
}

// ─── encryptFieldsForKind ────────────────────────────────────────────────
// (responses, schema, opts?) → { responses, encrypted_blob }.
// `opts` se reserva para uso futuro (kind aliasing / modo 'partial') y
// actualmente se ignora.
function encryptFieldsForKind(responses, schema, _opts) {
  // Caso base: sin schema → no podemos saber qué es sensible. Devolvemos
  // respuesta cleana (sin tocar nada) y blob=null. La ruta que llama tiene
  // que haber decidido "classic" y por tanto no haber invocado esto.
  if (!schema || !Array.isArray(schema.fields)) {
    return { responses: deepClone(responses), encrypted_blob: null };
  }

  const paths = getSensitiveFieldPaths(schema);
  // clase de optimización: si 0 paths sensibles, ahorra JSON.parse/stringify.
  if (paths.length === 0) {
    return { responses: deepClone(responses), encrypted_blob: null };
  }

  const cleaned = deepClone(responses);
  const sensitive = {};

  // Track repeaters en los que TODOS los items son sensitive (full_strip).
  // Recorremos los items del cleaned original en orden descendente para
  // splice sin desfasar índices. Cada índice que aparezca como full-strip
  // aparecerá al menos una vez en `paths` con full_strip=true.
  const fullStripIndicesByRepeater = new Map();

  for (const p of paths) {
    if (!p.index_wildcard) {
      const rawPath = p.raw_path;  // ej: "situation"
      const val = getAtPath(responses, rawPath);
      if (isMeaningful(val)) {
        // CRITICO: usamos el path literal como string key. Si llamáramos
        // a setAtPath(sensitive, rawPath, val) con paths que NO tienen
        // brakets (top-level), el resultado es el mismo: sensitive.situation = val.
        // Lo dejamos en asignación directa por consistencia con el caso wildcard.
        sensitive[rawPath] = val;
      }
      // Limpiamos SIEMPRE el campo del cleaned: la BD no debe tener
      // siquiera un string vacío bajo un campo sensitive. Si el paciente
      // pasó un valor vacío, semánticamente es "no tengo nada que decir"
      // y no necesita estar en el JSONB sensible-ish.
      deleteAtPath(cleaned, rawPath);
      continue;
    }
    const arr = responses && responses[p.repeater_key];
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const rawPath = p.repeater_key + '[' + i + '].' + p.sub_key;
      // ej: "logs[0].content" — rawPath literal con brackets y dots INCLUIDOS.
      const val = getAtPath(responses, rawPath);
      if (isMeaningful(val)) {
        // CRITICO: usamos rawPath como string key literal, NO como path
        // estructurado (setAtPath lo desensambla a ['logs', 0, 'content']
        // y crea sensitve.logs[0].content, perdiendo la bracket notation en
        // JSON.stringify y el round-trip). La asignación directa preserva
        // el string completo como key en el envelope, y el parser de decrypt
        // lo desambla simétricamente vía parsePath().
        sensitive[rawPath] = val;
      }
      deleteAtPath(cleaned, rawPath);
      if (p.full_strip) {
        const bucket = fullStripIndicesByRepeater.get(p.repeater_key) || new Set();
        bucket.add(i);
        fullStripIndicesByRepeater.set(p.repeater_key, bucket);
      }
    }
  }

  // Para repeaters full_strip, splice cada item del array original.
  // Iteramos en orden DESCENDENTE sobre cada repeater para no desfasar
  // índices al modificar el array 'cleaned' in-place. Tras splice, si
  // el array queda vacío, eliminamos la propiedad entera para mantener
  // el JSONB plano y limpio.
  for (const [repeaterKey, indices] of fullStripIndicesByRepeater) {
    if (!cleaned || typeof cleaned !== 'object') continue;
    const cleanedArr = cleaned[repeaterKey];
    if (!Array.isArray(cleanedArr)) continue;
    const sorted = [...indices].sort((a, b) => b - a);
    for (const idx of sorted) {
      if (idx < cleanedArr.length) cleanedArr.splice(idx, 1);
    }
    if (cleanedArr.length === 0) {
      delete cleaned[repeaterKey];
    }
  }

  // serializamos y encriptamos SOLO si hay al menos un campo con contenido.
  let encryptedBlob = null;
  try {
    if (Object.keys(sensitive).length === 0) {
      encryptedBlob = null;
    } else {
      const text = JSON.stringify(sensitive);
      encryptedBlob = encrypt(text);
    }
  } catch (e) {
    logger.warn('exerciseEncryption: fallo encriptando sensitive blob', { error: e.message });
    // Fallo no crítico: ponemos blob=null y dejamos responses en plano
    // para no abortar el INSERT del exercise_session. El paciente no pierde
    // su progreso — solo el contenido del blob sensible permanece en plano
    // (pero igual ya era plano en `responses` antes de nuestras manos).
    return { responses: deepClone(responses), encrypted_blob: null };
  }

  return { responses: cleaned, encrypted_blob: encryptedBlob };
}

// ─── decryptFieldsForKind ────────────────────────────────────────────────
// (responses, encrypted_blob, schema) → responses merged.
// Robusto a:
//   · encrypted_blob null/undefined → no-op, devuelve responses.
//   · encrypted_blob malformado (decrypt devuelve el mismo string)
//     → log warning + devuelve responses sin merge.
//   · decrypted text no es JSON parseable → log warning + no-op.
//   · schema null y blob presente → no intentamos merger (paths indefinidos)
function decryptFieldsForKind(responses, encryptedBlob, schema) {
  if (!encryptedBlob || typeof encryptedBlob !== 'string') {
    return deepClone(responses);
  }
  // Defensa: schema null con blob presente. Imposible en práctica
  // (la BD guarda CHECK exercise_kind ∈ 4 valores y blob solo se setea
  // desde routes con kind resuelto), pero blindamos.
  if (!schema || !Array.isArray(schema.fields)) {
    logger.warn('exerciseEncryption: decrypt sin schema, blob descartado');
    return deepClone(responses);
  }

  let envelope = null;
  try {
    const decrypted = decrypt(encryptedBlob);
    // utils/encryption.js decrypt devuelve el mismo input si el formato
    // no es iv:authTag:ct (3 partes separadas por ':'). Eso indica blob
    // corrupto o escrito por un cliente externo. No es JSON parseable.
    if (decrypted === encryptedBlob) {
      logger.warn('exerciseEncryption: encrypted_blob no descifrable (formato inválido)');
      return deepClone(responses);
    }
    envelope = JSON.parse(decrypted);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      logger.warn('exerciseEncryption: envelope no es un objeto plano');
      return deepClone(responses);
    }
  } catch (e) {
    logger.warn('exerciseEncryption: decrypt/parse falló', { error: e.message });
    return deepClone(responses);
  }

  const merged = deepClone(responses);
  for (const key of Object.keys(envelope)) {
    try {
      setAtPath(merged, key, envelope[key]);
    } catch (e) {
      // Path inválido escrito por cliente malicioso o schema drift; no
      // abortamos todo el merge por una sola clave mala.
      logger.warn('exerciseEncryption: setAtPath falló para clave', { key, error: e.message });
    }
  }
  return merged;
}

function isMeaningful(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  // number, boolean y objetos con contenido son significativos
  return true;
}

module.exports = {
  encryptFieldsForKind,
  decryptFieldsForKind,
  parsePath,
  getAtPath,
  setAtPath,
  deleteAtPath,
};
