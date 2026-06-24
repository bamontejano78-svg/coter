// ════════════════════════════════════════════════════════════════════════════
// tests/exerciseSchemas.test.js
// ════════════════════════════════════════════════════════════════════════════
// Unit tests para utils/exerciseSchemas.js — sin BD, sin red. Cubre:
//   · KINDS enum (estabilidad del contrato compartido con migration 007).
//   · Inmutabilidad de exports (Object.freeze en cascada).
//   · getSchema resolución: classic → null, BD gana, mode/phobia discriminators.
//   · validateResponses por cada field type (9 tipos + repeater recursion).
//   · getSensitiveFieldPaths (no emite para emotion fields no sensibles;
//     emite con `[*].` para repeaters; emite para sensitive:true top-level).
//
// Es importante que estos tests no dependan de ningún setup externo: son
// auto-contenidos para que fallen rápido y de forma legible cuando alguien
// rompa el contrato de la biblioteca.
// ════════════════════════════════════════════════════════════════════════════

const {
  KINDS,
  SCHEMAS_BY_KIND,
  BEHAVIORAL_ACTIVATION_SCHEMAS,
  GRADED_EXPOSURE_SCHEMAS,
  THOUGHT_RECORD_SCHEMA,
  BA_DIARY_SCHEMA,
  BA_SCHEDULE_SCHEMA,
  GE_AGORAPHOBIA_SCHEMA,
  GE_SOCIAL_ANXIETY_SCHEMA,
  GE_CLAUSTROPHOBIA_SCHEMA,
  getSchema,
  validateResponses,
  getSensitiveFieldPaths,
  SCHEMA_VERSION,
} = require('../utils/exerciseSchemas');

// Helper: respuestas "completas" para un Thought Record, válidas.
function makeCompleteTR() {
  return {
    situation: 'Reunión trimestral con mi jefe',
    automatic_thought: 'Va a despedirme, no valgo nada',
    emotions: [
      { name: 'ansiedad', intensity: 85, body_location: 'pecho' },
      { name: 'tristeza', intensity: 60, body_location: 'garganta' },
    ],
    distortions: ['catastrophizing', 'labeling'],
    evidence_for: 'Llegué tarde a dos reuniones',
    evidence_against: 'Mi evaluación del año pasado fue buena',
    alternative_thought: 'Hay indicadores contradictorios; no puedo concluir',
    emotions_after: [{ name: 'ansiedad', intensity: 50 }],
  };
}

describe('KINDS enum', () => {
  test('contains exactly the four documented kinds', () => {
    expect(new Set(KINDS)).toEqual(new Set(['classic', 'thought_record', 'behavioral_activation', 'graded_exposure']));
    expect(KINDS.length).toBe(4);
  });

  test('the KINDS array itself is frozen', () => {
    expect(Object.isFrozen(KINDS)).toBe(true);
    expect(() => KINDS.push('x')).toThrow();
  });
});

describe('Schema exports are frozen', () => {
  test('THOUGHT_RECORD_SCHEMA and all top-level branches are immutable', () => {
    expect(Object.isFrozen(THOUGHT_RECORD_SCHEMA)).toBe(true);
    expect(Object.isFrozen(THOUGHT_RECORD_SCHEMA.distortion_catalog)).toBe(true);
    expect(Object.isFrozen(THOUGHT_RECORD_SCHEMA.fields)).toBe(true);
    // No podemos usar expect(() => { … }).toThrow() porque depende de
    // strict mode (silencioso en sloppy mode). Verificamos la
    // inmutabilidad por observación: el set no agrega la propiedad.
    const beforeKeys = Object.keys(THOUGHT_RECORD_SCHEMA).length;
    THOUGHT_RECORD_SCHEMA.newProp = 1;
    expect(Object.keys(THOUGHT_RECORD_SCHEMA).length).toBe(beforeKeys);
    expect(THOUGHT_RECORD_SCHEMA.newProp).toBeUndefined();
  });

  test('BA diary and schedule schemas are frozen', () => {
    expect(Object.isFrozen(BA_DIARY_SCHEMA)).toBe(true);
    expect(Object.isFrozen(BA_DIARY_SCHEMA.fields)).toBe(true);
    expect(Object.isFrozen(BA_DIARY_SCHEMA.suggested_activities)).toBe(true);
    expect(Object.isFrozen(BA_SCHEDULE_SCHEMA)).toBe(true);
    expect(Object.isFrozen(BA_SCHEDULE_SCHEMA.fields)).toBe(true);
  });

  test('GE three phobia schemas are frozen', () => {
    expect(Object.isFrozen(GE_AGORAPHOBIA_SCHEMA)).toBe(true);
    expect(Object.isFrozen(GE_SOCIAL_ANXIETY_SCHEMA)).toBe(true);
    expect(Object.isFrozen(GE_CLAUSTROPHOBIA_SCHEMA)).toBe(true);
    expect(Object.isFrozen(GE_AGORAPHOBIA_SCHEMA.hierarchy)).toBe(true);
  });

  test('every export schema_version === 1', () => {
    expect(THOUGHT_RECORD_SCHEMA.schema_version).toBe(1);
    expect(BA_DIARY_SCHEMA.schema_version).toBe(1);
    expect(BA_SCHEDULE_SCHEMA.schema_version).toBe(1);
    expect(GE_AGORAPHOBIA_SCHEMA.schema_version).toBe(1);
    expect(GE_SOCIAL_ANXIETY_SCHEMA.schema_version).toBe(1);
    expect(GE_CLAUSTROPHOBIA_SCHEMA.schema_version).toBe(1);
    expect(SCHEMA_VERSION).toBe(1);
  });

  test('SCHEMAS_BY_KIND indexers are frozen', () => {
    expect(Object.isFrozen(SCHEMAS_BY_KIND)).toBe(true);
    expect(Object.isFrozen(BEHAVIORAL_ACTIVATION_SCHEMAS)).toBe(true);
    expect(Object.isFrozen(GRADED_EXPOSURE_SCHEMAS)).toBe(true);
  });
});

describe('getSchema', () => {
  test('classic returns null (no schema; patient only sees instructions)', () => {
    expect(getSchema('classic')).toBeNull();
  });

  test('null/undefined kind return null', () => {
    expect(getSchema(null)).toBeNull();
    expect(getSchema(undefined)).toBeNull();
    expect(getSchema('')).toBeNull();
  });

  test('thought_record defaults to the static THOUGHT_RECORD_SCHEMA when no dbSchema', () => {
    expect(getSchema('thought_record')).toBe(THOUGHT_RECORD_SCHEMA);
  });

  test('thought_record yields a deep-frozen COPY of dbSchema (no shared ref, no shared mutation)', () => {
    // getSchema debe clonar y congelar recursivamente para que el caller
    // reciba una copia immutable y no referencia al input (que podría
    // seguir mutandose desde fuera del módulo).
    const custom = { fields: [{ key: 'x', type: 'text', required: true }] };
    const result = getSchema('thought_record', custom);
    expect(result).not.toBe(custom);                       // copia, no misma ref
    expect(Object.isFrozen(result)).toBe(true);            // top congelado
    expect(Object.isFrozen(result.fields)).toBe(true);     // nivel 2 congelado
    expect(Object.isFrozen(result.fields[0])).toBe(true);  // nivel 3 congelado
    expect(result.fields[0].key).toBe('x');                 // contenido preservado
  });

  test('behavioral_activation default mode → diary', () => {
    expect(getSchema('behavioral_activation')).toBe(BA_DIARY_SCHEMA);
    expect(getSchema('behavioral_activation', null, { mode: 'diary' })).toBe(BA_DIARY_SCHEMA);
  });

  test('behavioral_activation mode=schedule', () => {
    expect(getSchema('behavioral_activation', null, { mode: 'schedule' })).toBe(BA_SCHEDULE_SCHEMA);
  });

  test('behavioral_activation mode=unknown falls back to diary (gracefully)', () => {
    expect(getSchema('behavioral_activation', null, { mode: 'no-existe' })).toBe(BA_DIARY_SCHEMA);
  });

  test('graded_exposure default phobia → agoraphobia', () => {
    expect(getSchema('graded_exposure')).toBe(GE_AGORAPHOBIA_SCHEMA);
    expect(getSchema('graded_exposure', null, { phobia: 'agoraphobia' })).toBe(GE_AGORAPHOBIA_SCHEMA);
  });

  test('graded_exposure phobia=social_anxiety and claustrophobia', () => {
    expect(getSchema('graded_exposure', null, { phobia: 'social_anxiety' })).toBe(GE_SOCIAL_ANXIETY_SCHEMA);
    expect(getSchema('graded_exposure', null, { phobia: 'claustrophobia' })).toBe(GE_CLAUSTROPHOBIA_SCHEMA);
  });

  test('unknown kind returns null (caller handles gracefully)', () => {
    expect(getSchema('not_a_real_kind')).toBeNull();
  });

  test('dbSchema WITHOUT fields falls back to static (terapeuta no editó la plantilla)', () => {
    expect(getSchema('thought_record', { foo: 'bar' })).toBe(THOUGHT_RECORD_SCHEMA);
    expect(getSchema('thought_record', { fields: 'invalid-as-array' })).toBe(THOUGHT_RECORD_SCHEMA);
  });
});

describe('validateResponses', () => {
  test('null schema → no errors (passthrough, callers treat classic)', () => {
    expect(validateResponses({ anything: 1 }, null)).toEqual({ valid: true, errors: [] });
  });

  test('non-object responses (array) → invalid_root', () => {
    const res = validateResponses([], THOUGHT_RECORD_SCHEMA);
    expect(res.valid).toBe(false);
    expect(res.errors[0].code).toBe('invalid_root');
  });

  test('TR: complete valid responses → valid:true, errors=[]', () => {
    const res = validateResponses(makeCompleteTR(), THOUGHT_RECORD_SCHEMA);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test('TR: missing situation (required) → required_missing at path "situation"', () => {
    const bad = makeCompleteTR();
    delete bad.situation;
    const res = validateResponses(bad, THOUGHT_RECORD_SCHEMA);
    expect(res.valid).toBe(false);
    const miss = res.errors.find(e => e.code === 'required_missing');
    expect(miss).toBeDefined();
    expect(miss.path).toBe('situation');
    expect(miss.field_key).toBe('situation');
  });

  test('TR: empty emotions array → required_missing at "emotions"', () => {
    const bad = makeCompleteTR();
    bad.emotions = [];
    const res = validateResponses(bad, THOUGHT_RECORD_SCHEMA);
    expect(res.valid).toBe(false);
    const miss = res.errors.find(e => e.code === 'required_missing' && e.path === 'emotions');
    expect(miss).toBeDefined();
  });

  test('TR: out-of-range SUDS (intensity = 150) → out_of_range', () => {
    const bad = makeCompleteTR();
    bad.emotions[0].intensity = 150;
    const res = validateResponses(bad, THOUGHT_RECORD_SCHEMA);
    expect(res.valid).toBe(false);
    const range = res.errors.find(e => e.code === 'out_of_range');
    expect(range).toBeDefined();
    expect(range.path).toBe('emotions[0].intensity');
  });

  test('TR: invalid multi_select distortion (not in catalog) → fail IF field has resolved options; passes otherwise (source=catalog)', () => {
    // distortions tiene source:'catalog' → NO validation against alta strictly;
    // defender: que el caller de la UI resolvió opciones y trae solo keys válidos.
    const bad = makeCompleteTR();
    bad.distortions = ['potato_type'];
    const res = validateResponses(bad, THOUGHT_RECORD_SCHEMA);
    // El validator ignora options check cuando hay source; los duplicados o
    // no-strings sí fallan. Acá debe pasar.
    expect(res.errors.filter(e => e.path === 'distortions')).toEqual([]);
  });

  test('TR: multi_select repeated value → duplicate_value', () => {
    const bad = makeCompleteTR();
    bad.distortions = ['catastrophizing', 'catastrophizing'];
    const res = validateResponses(bad, THOUGHT_RECORD_SCHEMA);
    expect(res.valid).toBe(false);
    const dup = res.errors.find(e => e.code === 'duplicate_value');
    expect(dup).toBeDefined();
    expect(dup.path).toBe('distortions');
  });

  test('GE: complete valid exposure entry → passes', () => {
    const ge = {
      step: 1,
      date: '2026-06-23',
      suds_pre: 60,
      suds_peak: 80,
      suds_post: 35,
      duration_actual_min: 12,
      completed: true,
      coping: ['breath', 'grounding'],
      notes: 'Avance esperado',
    };
    const res = validateResponses(ge, GE_AGORAPHOBIA_SCHEMA);
    expect(res.valid).toBe(true);
  });

  test('GE: invalid option in coping multi_select → invalid_option', () => {
    const ge = {
      step: 1, date: '2026-06-23', suds_pre: 60, suds_post: 35,
      completed: true, coping: ['drink_beer'],
    };
    const res = validateResponses(ge, GE_AGORAPHOBIA_SCHEMA);
    expect(res.valid).toBe(false);
    const inv = res.errors.find(e => e.code === 'invalid_option' && e.path === 'coping');
    expect(inv).toBeDefined();
  });

  test('GE: invalid date format → invalid_date', () => {
    const ge = {
      step: 1, date: 'not-a-date', suds_pre: 60, suds_post: 35, completed: true,
    };
    const res = validateResponses(ge, GE_AGORAPHOBIA_SCHEMA);
    expect(res.valid).toBe(false);
    const inv = res.errors.find(e => e.code === 'invalid_date');
    expect(inv).toBeDefined();
    expect(inv.path).toBe('date');
  });

  test('GE: missing required completed (false is required valid input but not provided) → required_missing', () => {
    const ge = {
      step: 1, date: '2026-06-23', suds_pre: 60, suds_post: 35,
    };
    const res = validateResponses(ge, GE_AGORAPHOBIA_SCHEMA);
    expect(res.valid).toBe(false);
    const miss = res.errors.find(e => e.code === 'required_missing' && e.path === 'completed');
    expect(miss).toBeDefined();
  });

  test('select: invalid value → invalid_option', () => {
    const bad = makeCompleteTR();
    // TR tiene solo multi_selects; usamos BA diary que tiene select="time_slot".
    const ba = {
      activity: 'algo', time_slot: 'Madrugada', duration_min: 30,
      pleasure: 5, achievement: 4, accompanying: 'solo',
    };
    const res = validateResponses(ba, BA_DIARY_SCHEMA);
    expect(res.valid).toBe(false);
    const inv = res.errors.find(e => e.code === 'invalid_option' && e.path === 'time_slot');
    expect(inv).toBeDefined();
  });

  test('boolean: passed as string → not_a_boolean', () => {
    const ge = {
      step: 1, date: '2026-06-23', suds_pre: 60, suds_post: 35, completed: 'yes',
    };
    const res = validateResponses(ge, GE_AGORAPHOBIA_SCHEMA);
    expect(res.valid).toBe(false);
    const inv = res.errors.find(e => e.code === 'not_a_boolean');
    expect(inv).toBeDefined();
    expect(inv.path).toBe('completed');
  });

  test('repeater: emotions not an array → not_an_array', () => {
    const bad = makeCompleteTR();
    bad.emotions = 'ansiedad,tristeza'; // string en lugar de array
    const res = validateResponses(bad, THOUGHT_RECORD_SCHEMA);
    expect(res.valid).toBe(false);
    const inv = res.errors.find(e => e.code === 'not_an_array' && e.path === 'emotions');
    expect(inv).toBeDefined();
  });

  test('repeater: sub-field with required:true missing → required_missing at indexed path', () => {
    // Sintético: el THOUGHT_RECORD_SCHEMA real no marca `name` como required
    // para no forzar al paciente a ponerle etiqueta textual (algunos
    // pacientes usan solo intensidad). Para testear la recursion con un
    // required explícito usamos un repeater local.
    const synthSchema = {
      fields: [
        {
          key: 'log', type: 'repeater', required: true,
          sensitive: false,
          fields: [
            { key: 'time',    type: 'text',    required: true,  sensitive: false },
            { key: 'note',    type: 'textarea', sensitive: false },
          ],
        },
      ],
    };
    const bad = { log: [{ note: 'sin tiempo registrado' }] }; // 'time' falta en log[0]
    const res = validateResponses(bad, synthSchema);
    expect(res.valid).toBe(false);
    const miss = res.errors.find(e => e.code === 'required_missing' && e.path === 'log[0].time');
    expect(miss).toBeDefined();
  });
});

describe('getSensitiveFieldPaths', () => {
  test('THOUGHT_RECORD_SCHEMA emits exactly 5 top-level sensitive paths', () => {
    const paths = getSensitiveFieldPaths(THOUGHT_RECORD_SCHEMA);
    const topLevel = paths.filter(p => !p.index_wildcard);
    expect(topLevel.length).toBe(5);
    const keys = topLevel.map(p => p.raw_path).sort();
    expect(keys).toEqual(['alternative_thought', 'automatic_thought', 'evidence_against', 'evidence_for', 'situation']);
  });

  test('THOUGHT_RECORD_SCHEMA emits 0 repeater-wildcard sensitive paths (no emotion fields are sensitive)', () => {
    const paths = getSensitiveFieldPaths(THOUGHT_RECORD_SCHEMA);
    const repeater = paths.filter(p => p.index_wildcard);
    expect(repeater.length).toBe(0);
  });

  test('GE agoraphobia emits exactly 1 sensitive path: notes', () => {
    const paths = getSensitiveFieldPaths(GE_AGORAPHOBIA_SCHEMA);
    expect(paths.length).toBe(1);
    expect(paths[0].raw_path).toBe('notes');
    expect(paths[0].index_wildcard).toBe(false);
    expect(paths[0].repeater_key).toBeNull();
  });

  test('GE social_anxiety emits exactly 1 sensitive path: notes', () => {
    const paths = getSensitiveFieldPaths(GE_SOCIAL_ANXIETY_SCHEMA);
    expect(paths.length).toBe(1);
    expect(paths[0].raw_path).toBe('notes');
  });

  test('GE claustrophobia emits exactly 1 sensitive path: notes', () => {
    const paths = getSensitiveFieldPaths(GE_CLAUSTROPHOBIA_SCHEMA);
    expect(paths.length).toBe(1);
    expect(paths[0].raw_path).toBe('notes');
  });

  test('BA diary emits exactly 1 sensitive path: notes', () => {
    const paths = getSensitiveFieldPaths(BA_DIARY_SCHEMA);
    expect(paths.length).toBe(1);
    expect(paths[0].raw_path).toBe('notes');
  });

  test('BA schedule emits exactly 1 sensitive path: reflection', () => {
    const paths = getSensitiveFieldPaths(BA_SCHEDULE_SCHEMA);
    expect(paths.length).toBe(1);
    expect(paths[0].raw_path).toBe('reflection');
  });

  test('null schema → empty array (silent safe)', () => {
    expect(getSensitiveFieldPaths(null)).toEqual([]);
  });

  test('schema without fields → empty array', () => {
    expect(getSensitiveFieldPaths({})).toEqual([]);
    expect(getSensitiveFieldPaths({ fields: 'invalid' })).toEqual([]);
  });

  test('repeater with item_sensitive=true: every sub-field becomes per-item sensitive path', () => {
    const schema = {
      fields: [
        {
          key: 'journal', type: 'repeater', item_sensitive: true,
          fields: [
            { key: 'entry',  type: 'text', sensitive: false },
            { key: 'mood',   type: 'number', sensitive: false },
          ],
        },
      ],
    };
    const paths = getSensitiveFieldPaths(schema);
    expect(paths.length).toBe(2);
    expect(paths.every(p => p.index_wildcard && p.repeater_key === 'journal')).toBe(true);
    expect(paths.map(p => p.sub_key).sort()).toEqual(['entry', 'mood']);
    expect(paths.map(p => p.raw_path).sort()).toEqual(['journal[*].entry', 'journal[*].mood']);
  });

  test('repeater with item_sensitive=false and MIXED child sensitivity: only sensitive:true children get paths', () => {
    const schema = {
      fields: [
        {
          key: 'thought_log', type: 'repeater', item_sensitive: false,
          fields: [
            { key: 'time',     type: 'text',    sensitive: false },
            { key: 'content',  type: 'textarea', sensitive: true },
            { key: 'severity', type: 'number',   sensitive: false },
          ],
        },
      ],
    };
    const paths = getSensitiveFieldPaths(schema);
    expect(paths.length).toBe(1);
    expect(paths[0].sub_key).toBe('content');
    expect(paths[0].raw_path).toBe('thought_log[*].content');
  });

  test('non-sensitive fields are NOT emitted (auto-de-xclusion)', () => {
    const schema = {
      fields: [
        { key: 'activity', type: 'text', sensitive: false },
        { key: 'severity', type: 'scale', sensitive: false, min: 0, max: 10 },
        { key: 'notes',    type: 'textarea', sensitive: false },
      ],
    };
    expect(getSensitiveFieldPaths(schema).length).toBe(0);
  });
});
