// ════════════════════════════════════════════════════════════════════════════
// utils/exerciseSchemas.js
// ════════════════════════════════════════════════════════════════════════════
// Static schemas (3 kinds clínicos) + validators + path-extractor.
//
// Por qué existe:
//   La biblioteca de tareas (routes/therapist.js GET /task-templates) carga
//   `exercise_schema` desde BD. Para validar el lado-servidor ANTES de aceptar
//   una respuesta del paciente, y para que utils/exerciseEncryption.js sepa
//   qué campos encriptar, necesitamos un módulo que:
//     1. Exporte el kind enum (CLÁSICO + 3 ejercicios clínicos).
//     2. Resuelva el schema efectivo (BD gana; estático como fallback).
//     3. Valide respuestas contra el schema (tipos + required + range +
//        options) con códigos de error en español.
//     4. Extraiga todos los "sensitive paths" de un schema (recursivo a
//        través de repeaters, tanto si item_sensitive === true como si sólo
//        algunos children lo son).
//
// Mantenimiento:
//   Los 3 schemas clínicos están sincronizados con migrations/007_embedded_exercises.sql.
//   Si añades un kind, edita AMBOS sitios: la migration (seeds + CHECK constraint)
//   y este archivo. Hay un test de round-trip en tests/exerciseSchemas.test.js
//   que falla si divergen.
//
// Backwards compatibility:
//   - kind === 'classic' → getSchema devuelve null (no hay schema, el paciente
//     solo tiene instrucciones libres).
//   - kind inválido o no presente → getSchema devuelve null; los callers deben
//     comprobar y hacer no-op.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

// ─── Kinds permitidos ────────────────────────────────────────────────────
// Coincide con el CHECK constraint de migration 007 en task_templates,
// assignments y exercise_sessions. Si añades uno nuevo, actualiza:
//   1. migrations/007_embedded_exercises.sql → CHECK (kind IN (...))
//   2. aqui → KINDS + SCHEMAS_BY_KIND key.
const KINDS = Object.freeze(['classic', 'thought_record', 'behavioral_activation', 'graded_exposure']);

const SCHEMA_VERSION = 1;

// ─── Schema estático: Thought Record (Beck, 1979 + Burns, 1980) ─────────
// Disponible en migración como seed 11111111-...-111
const THOUGHT_RECORD_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  distortion_catalog: Object.freeze([
    { key: 'all_or_nothing',        label: 'Pensamiento todo-o-nada', description: 'Ves todo en blanco o negro. Si no es perfecto, es un fracaso total.' },
    { key: 'overgeneralization',    label: 'Sobregeneralización',     description: 'De un incidente negativo concluyes "siempre me pasa esto".' },
    { key: 'mental_filter',         label: 'Filtro mental',            description: 'Solo registras el detalle negativo; lo neutral y positivo queda fuera.' },
    { key: 'disqualifying_positive', label: 'Invalidar lo positivo',  description: 'Descartas logros o cumplidos insistiendo en que "no cuentan".' },
    { key: 'mind_reading',          label: 'Lectura de mente',         description: 'Asumes que los demás piensan mal de ti sin evidencia suficiente.' },
    { key: 'fortune_telling',       label: 'Predicción del futuro',    description: 'Anticipas que irá mal y actúas como si tu predicción fuese hecho.' },
    { key: 'catastrophizing',       label: 'Catastrofismo',            description: 'Exageras la importancia: "será terrible, no aguantaré".' },
    { key: 'minimization',          label: 'Minimización',             description: 'Quitas valor a tus logros o capacidades positivas sin justificación.' },
    { key: 'emotional_reasoning',   label: 'Razonamiento emocional',   description: 'Concluyes que algo es verdad porque "me siento mal con ello".' },
    { key: 'should_statements',     label: "Declaraciones 'debería'",   description: "Te exiges con 'debería' o 'no debería', generando culpa constante." },
    { key: 'labeling',              label: 'Etiquetado',               description: 'En lugar de "cometí un error", te etiquetas como "soy un fracasado".' },
    { key: 'personalization',       label: 'Personalización',          description: 'Te culpas por eventos que no controlas o asumes responsabilidad excesiva.' },
    { key: 'blame',                 label: 'Culpabilización',          description: 'Atribuyes toda la responsabilidad a otros sin matiz realista.' },
  ]),
  fields: Object.freeze([
    { key: 'situation',           label: '1. Situación (hechos)',                  type: 'textarea',     required: true,  sensitive: true,  placeholder: 'Dónde, cuándo, con quién. Sólo hechos, sin interpretación.' },
    { key: 'automatic_thought',   label: '2. Pensamiento automático',              type: 'textarea',     required: true,  sensitive: true,  placeholder: 'Lo más literal posible. Una frase, lo que pasó por tu mente.' },
    {
      key: 'emotions',
      label: '3. Emociones sentidas',
      type: 'repeater',
      required: true,
      sensitive: false,
      item_sensitive: false,
      fields: [
        { key: 'name',          type: 'text',  sensitive: false, placeholder: 'ansiedad, tristeza, ira…' },
        { key: 'intensity',     type: 'scale', min: 0, max: 100, sensitive: false, label: 'Intensidad (0–100)' },
        { key: 'body_location', type: 'text',  sensitive: false, required: false, placeholder: 'pecho, estómago…' },
      ],
    },
    { key: 'distortions',         label: '4. Distorsión(es) detectada(s)',         type: 'multi_select', required: true,  sensitive: false, source: 'catalog' },
    { key: 'evidence_for',        label: '5. Evidencia a favor del pensamiento',   type: 'textarea',     required: false, sensitive: true,  placeholder: 'Hechos que respaldan lo que pensaste. Sé honesto(a).' },
    { key: 'evidence_against',    label: '6. Evidencia en contra',                 type: 'textarea',     required: false, sensitive: true,  placeholder: 'Hechos que no encajan con tu pensamiento. Otras perspectivas.' },
    { key: 'alternative_thought', label: '7. Pensamiento alternativo equilibrado',  type: 'textarea',     required: true,  sensitive: true,  placeholder: 'Una versión más fiel a la evidencia completa, sin absolutos.' },
    {
      key: 'emotions_after',
      label: '8. Emociones tras la resignificación',
      type: 'repeater',
      required: false,
      sensitive: false,
      item_sensitive: false,
      fields: [
        { key: 'name',      type: 'text',  sensitive: false, placeholder: 'la misma emoción u otra' },
        { key: 'intensity', type: 'scale', min: 0, max: 100, sensitive: false, label: 'Intensidad (0–100)' },
      ],
    },
  ]),
  guidance: 'Beck (1979) demostró que cuestionando estos pensamientos desciende la intensidad emocional. Las preguntas 5 y 6 son el corazón del ejercicio: evita respuestas como "no hay evidencia a favor" — busca al menos una para después equilibrarla.',
});

// ─── Schema estático: BA — Diario (Lewinsohn, 1976) ──────────────────────
const BA_DIARY_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  mode: 'diary',
  fields: Object.freeze([
    { key: 'activity',     label: 'Actividad',          type: 'text',     required: true,  sensitive: false, placeholder: '¿Qué hiciste exactamente?' },
    { key: 'time_slot',    label: 'Momento del día',    type: 'select',   required: true,  sensitive: false, options: ['Mañana', 'Tarde', 'Noche'] },
    { key: 'duration_min', label: 'Duración (min)',     type: 'number',   required: false, sensitive: false, min: 1, max: 480 },
    { key: 'pleasure',     label: 'Placer (0–10)',      type: 'scale',    required: true,  sensitive: false, min: 0, max: 10,  description: 'Cuánto placer/diversión te dio' },
    { key: 'achievement',  label: 'Logro (0–10)',       type: 'scale',    required: true,  sensitive: false, min: 0, max: 10,  description: 'Sensación de capacidad o propósito' },
    { key: 'accompanying', label: 'Con quién',          type: 'text',     required: false, sensitive: false, placeholder: 'solo/a, con… ' },
    { key: 'notes',        label: 'Notas / reflexión',  type: 'textarea', required: false, sensitive: true,  placeholder: '¿Qué sentiste? ¿La repetirías? ¿Qué ajustarías?' },
  ]),
  suggested_activities: Object.freeze([
    { label: 'Pasear 20 min por un parque',                          category: 'suave',  difficulty: 'baja' },
    { label: 'Llamar o videollamar a alguien que aprecies',           category: 'social', difficulty: 'baja' },
    { label: 'Tomar un café o té sin prisa',                          category: 'suave',  difficulty: 'baja' },
    { label: 'Leer un libro o artículo que te interese',              category: 'suave',  difficulty: 'baja' },
    { label: 'Pasear a tu perro / cuidar una mascota',                category: 'suave',  difficulty: 'baja' },
    { label: 'Cocinar una receta nueva',                              category: 'media',  difficulty: 'media' },
    { label: 'Escuchar tu música o podcast favorito',                 category: 'suave',  difficulty: 'baja' },
    { label: 'Mirar el atardecer o las nubes con calma',              category: 'suave',  difficulty: 'baja' },
    { label: 'Hacer ejercicio suave (yoga, estiramientos)',          category: 'suave',  difficulty: 'baja' },
    { label: 'Resolver un puzzle, sudoku o juego de mesa',            category: 'suave',  difficulty: 'baja' },
    { label: 'Escribir en un diario o dibujar',                       category: 'suave',  difficulty: 'baja' },
    { label: 'Visitar a un familiar sin agenda concreta',             category: 'social', difficulty: 'baja' },
    { label: 'Cuidar plantas (regar, podar, trasplantar)',            category: 'suave',  difficulty: 'baja' },
    { label: 'Tomar una foto que te guste y guardarla',               category: 'suave',  difficulty: 'baja' },
    { label: 'Hacer una llamada pendiente esta semana',               category: 'social', difficulty: 'media' },
    { label: 'Ordenar un cajón o estante pequeño',                    category: 'logro',  difficulty: 'baja' },
    { label: 'Completar un trámite administrativo que arrastras',    category: 'logro',  difficulty: 'media' },
    { label: 'Aprender algo nuevo (video de 15 min, curso corto)',    category: 'logro',  difficulty: 'media' },
    { label: 'Voluntariado puntual o ayudar a un conocido',           category: 'social', difficulty: 'media' },
    { label: 'Asistir a un evento local (mercado, concierto, biblioteca)', category: 'social', difficulty: 'media' },
  ]),
  guidance: 'Lewinsohn (1976). En estados depresivos la inactividad reduce placer y logro. Una actividad diaria con P≥5 es suficiente para empezar a romper el ciclo. Si P y L son ambos 0-2 tres días seguidos, replantear junto a tu terapeuta.',
});

// ─── Schema estático: BA — Plan semanal (Jacobson, 1996) ─────────────────
const BA_SCHEDULE_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  mode: 'schedule',
  fields: Object.freeze([
    { key: 'day',         label: 'Día',                       type: 'select',   required: true,  sensitive: false, options: ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'] },
    { key: 'time_slot',   label: 'Franja',                    type: 'select',   required: true,  sensitive: false, options: ['Mañana (8–12)', 'Tarde (12–18)', 'Noche (18–22)'] },
    { key: 'activity',    label: 'Actividad planificada',     type: 'text',     required: true,  sensitive: false, placeholder: 'Concreta y medible (ej: "pasear 30 min")' },
    { key: 'category',    label: 'Tipo',                      type: 'select',   required: true,  sensitive: false, options: ['Placer', 'Logro', 'Social', 'Auto-cuidado', 'Productivo', 'Descanso'] },
    { key: 'obstacles',   label: 'Posibles obstáculos',       type: 'textarea', required: false, sensitive: false, placeholder: '¿Qué podría impedirlo? ¿Cómo lo solventarías?' },
    { key: 'alternative', label: 'Plan B (alternativa)',      type: 'text',     required: false, sensitive: false, placeholder: 'Si surge imprevisto, ¿qué harás en su lugar?' },
    { key: 'completed',   label: '¿Lo hiciste?',              type: 'select',   required: true,  sensitive: false, options: ['Sí, completo', 'Parcialmente', 'No', 'Lo reprogramé'] },
    { key: 'reflection',  label: 'Reflexión',                 type: 'textarea', required: false, sensitive: true,  placeholder: '¿Qué funcionó? ¿Qué ajustarías la próxima semana?' },
  ]),
  guidance: 'Jacobson (1996). Programa el domingo por la noche de la semana siguiente. Si tienes una agenda muy ocupada, prioriza al menos 1 actividad con P y 1 con L por día. La constancia pesa más que la intensidad.',
});

// ─── Schemas estáticos: Graded Exposure (Marks, 1978 / McNally, 2007) ────
const GE_FIELD_BASE = Object.freeze([
  { key: 'step',                label: 'Nº de paso',               type: 'select',       required: true,  sensitive: false, source: 'hierarchy' },
  { key: 'date',                label: 'Fecha realizada',          type: 'date',         required: true,  sensitive: false },
  { key: 'suds_pre',            label: 'SUDS antes (0–100)',       type: 'scale',        required: true,  sensitive: false, min: 0, max: 100 },
  { key: 'suds_peak',           label: 'SUDS pico (0–100)',        type: 'scale',        required: false, sensitive: false, min: 0, max: 100 },
  { key: 'suds_post',           label: 'SUDS al terminar (0–100)', type: 'scale',        required: true,  sensitive: false, min: 0, max: 100 },
  { key: 'duration_actual_min', label: 'Duración real (min)',     type: 'number',       required: false, sensitive: false, min: 1, max: 300 },
  { key: 'completed',           label: 'Lo completé sin huir',     type: 'boolean',      required: true,  sensitive: false },
  { key: 'coping',              label: 'Estrategias usadas',      type: 'multi_select', required: false, sensitive: false, options: [
    { key: 'breath',      label: 'Respiración diafragmática' },
    { key: 'grounding',   label: 'Grounding 5-4-3-2-1' },
    { key: 'self_talk',   label: 'Diálogo interno estructurado' },
    { key: 'safety_item', label: 'Recurso de seguridad (llamar a alguien)' },
    { key: 'other',       label: 'Otra' },
  ] },
  { key: 'notes',               label: 'Notas / aprendizajes',     type: 'textarea',     required: false, sensitive: true,  placeholder: '¿Qué descubriste? ¿Qué ajustarías la próxima exposición?' },
]);

const GE_AGORAPHOBIA_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  phobia: 'agoraphobia',
  hierarchy: Object.freeze([
    { step: 1, description: 'Imaginarme entrando solo(a) a una tienda conocida',                            expected_suds: 30, estimated_duration_min: 5 },
    { step: 2, description: 'Entrar solo(a) a una tienda grande conocida y comprar algo',                    expected_suds: 40, estimated_duration_min: 10 },
    { step: 3, description: 'Quedarme 15 min en un centro comercial pequeño en horas valle',                expected_suds: 50, estimated_duration_min: 15 },
    { step: 4, description: 'Ir solo(a) al supermercado pequeño en hora moderada',                          expected_suds: 55, estimated_duration_min: 20 },
    { step: 5, description: 'Visitar un centro comercial amplio y concurrido en hora punta',                expected_suds: 65, estimated_duration_min: 25 },
    { step: 6, description: 'Usar transporte público solo(a) en un trayecto corto',                          expected_suds: 70, estimated_duration_min: 30 },
    { step: 7, description: 'Pasar 1 hora solo(a) en una plaza muy concurrida',                              expected_suds: 75, estimated_duration_min: 60 },
    { step: 8, description: 'Viajar solo(a) a otra ciudad y comer en un restaurante desconocido',            expected_suds: 80, estimated_duration_min: 180 },
  ]),
  fields: GE_FIELD_BASE,
  guidance: 'Marks (1978). Avanza solo cuando el paso anterior baje al menos al 50%. Practica cada paso 2-3 veces antes de avanzar — la consolidación es clave. Para registrar correctamente el SUDS: "pre" es antes de empezar; "pico" es el momento más difícil; "post" es al cierre.',
});

const GE_SOCIAL_ANXIETY_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  phobia: 'social_anxiety',
  hierarchy: Object.freeze([
    { step: 1, description: 'Imaginarme en una reunión social donde no conozco a nadie',                       expected_suds: 30, estimated_duration_min: 5 },
    { step: 2, description: 'Hablar 5 min con un dependiente en una tienda',                                  expected_suds: 40, estimated_duration_min: 5 },
    { step: 3, description: 'Pedir la cuenta y hacer una pregunta al camarero en un restaurante lleno',        expected_suds: 50, estimated_duration_min: 10 },
    { step: 4, description: 'Iniciar conversación con un desconocido en el gimnasio o en la calle',           expected_suds: 60, estimated_duration_min: 10 },
    { step: 5, description: 'Llamar por teléfono y hacerme entender por una consulta',                        expected_suds: 65, estimated_duration_min: 15 },
    { step: 6, description: 'Dar mi opinión en voz alta en un grupo de 4-5 personas',                          expected_suds: 75, estimated_duration_min: 10 },
    { step: 7, description: 'Asistir solo(a) a una reunión social de 1 h con desconocidos',                   expected_suds: 80, estimated_duration_min: 60 },
  ]),
  fields: Object.freeze(GE_FIELD_BASE.map(f => f.key === 'completed'
    ? { ...f, label: 'Lo completé sin comportamientos de seguridad' }
    : (f.key === 'coping' ? { ...f, options: [
        { key: 'breath',       label: 'Respiración' },
        { key: 'grounding',    label: 'Grounding' },
        { key: 'focus_others', label: 'Foco en los otros (no en mí)' },
        { key: 'self_talk',    label: 'Diálogo interno realista' },
        { key: 'other',        label: 'Otra' },
      ] } : f))),
  guidance: 'McNally (2007). El avance requiere eliminar comportamientos de seguridad: NO estar mirando el móvil "por si acaso", NO evitar contacto visual, NO ensayar frases en bucle. Si te descubres usándolos, repite el mismo paso antes de subir.',
});

const GE_CLAUSTROPHOBIA_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  phobia: 'claustrophobia',
  hierarchy: Object.freeze([
    { step: 1, description: 'Imaginarme en un cuarto cerrado pequeño',                                  expected_suds: 25, estimated_duration_min: 5 },
    { step: 2, description: 'Entrar a un baño pequeño y cerrar la puerta 30 s',                        expected_suds: 35, estimated_duration_min: 2 },
    { step: 3, description: 'Sentarme en el centro del coche con todas las puertas cerradas 1 min',   expected_suds: 50, estimated_duration_min: 5 },
    { step: 4, description: 'Estar en un armario o cuarto sin ventanas 3 min',                         expected_suds: 60, estimated_duration_min: 5 },
    { step: 5, description: 'Subir a un ascensor pequeño con 1 persona, 5 pisos',                      expected_suds: 70, estimated_duration_min: 5 },
    { step: 6, description: 'Subir a un ascensor lleno en hora punta, 10 pisos',                     expected_suds: 80, estimated_duration_min: 5 },
    { step: 7, description: 'Estar en un cuarto sin ventanas con 3+ personas 10 min',                  expected_suds: 85, estimated_duration_min: 12 },
  ]),
  fields: Object.freeze(GE_FIELD_BASE.map(f => f.key === 'duration_actual_min' ? { ...f, max: 60 } : (f.key === 'coping'
    ? { ...f, options: [
        { key: 'breath',     label: 'Respiración diafragmática' },
        { key: 'grounding',  label: 'Grounding 5-4-3-2-1' },
        { key: 'focus_exit', label: 'Atención focalizada en la salida (¿segura?)' },
        { key: 'self_talk',  label: 'Diálogo interno realista' },
        { key: 'other',      label: 'Otra' },
      ] }
    : f))),
  guidance: "Marks (1978). No huyas si el SUDS sube: la habituación requiere mantener la exposición hasta que baje. Si sientes pánico, enfócate en medir el SUDS en voz alta (contar del 0 al 100) — esto externaliza el control emocional.",
});

// ─── Indexadores por kind ────────────────────────────────────────────────
const BEHAVIORAL_ACTIVATION_SCHEMAS = Object.freeze({
  diary:    BA_DIARY_SCHEMA,
  schedule: BA_SCHEDULE_SCHEMA,
});

const GRADED_EXPOSURE_SCHEMAS = Object.freeze({
  agoraphobia:    GE_AGORAPHOBIA_SCHEMA,
  social_anxiety: GE_SOCIAL_ANXIETY_SCHEMA,
  claustrophobia: GE_CLAUSTROPHOBIA_SCHEMA,
});

const SCHEMAS_BY_KIND = Object.freeze({
  thought_record:        THOUGHT_RECORD_SCHEMA,
  behavioral_activation: BA_DIARY_SCHEMA,        // default antes de resolver mode
  graded_exposure:       GE_AGORAPHOBIA_SCHEMA,  // default antes de resolver phobia
});

// ─── getSchema: resuelve schema efectivo ──────────────────────────────────
// Prioridad:
//   1. dbSchema (de task_templates.exercise_schema) si tiene `fields` válido.
//      Esto cubre el caso "el terapeuta editó la plantilla" — la BD es
//      la fuente de verdad clínica.
//   2. SCHEMAS_BY_KIND [...] indexado por (kind, mode?, phobia?).
//   3. null si kind === 'classic' o kind inválido (lo que sea que devolviera
//      la BD no es utilizable).
function deepFreeze(value) {
  // Recursive freeze que no rompe sobre JSONB-like: recursa a través de
  // objetos y arrays planos, y se detiene en funciones / valores primitivos.
  // Idempotente: si un nodo ya está congelado, no hace nada.
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return value;
}

function getSchema(kind, dbSchema, opts) {
  if (!kind || kind === 'classic') return null;
  if (dbSchema && Array.isArray(dbSchema.fields) && dbSchema.fields.length > 0) {
    // Deep-clone via JSON para no compartir referencia con el caller.
    // exercises_schema es JSONB serializable de PostgreSQL → siempre JSON.
    // Tras clonar, congelamos recursivamente para que mutaciones internas
    // (distortion_catalog[], hierarchy[], fields[]) también reboten.
    const cloned = JSON.parse(JSON.stringify(dbSchema));
    return deepFreeze(cloned);
  }
  if (kind === 'thought_record') return THOUGHT_RECORD_SCHEMA;
  if (kind === 'behavioral_activation') {
    const mode = (opts && opts.mode) || 'diary';
    return BEHAVIORAL_ACTIVATION_SCHEMAS[mode] || BA_DIARY_SCHEMA;
  }
  if (kind === 'graded_exposure') {
    const phobia = (opts && opts.phobia) || 'agoraphobia';
    return GRADED_EXPOSURE_SCHEMAS[phobia] || GE_AGORAPHOBIA_SCHEMA;
  }
  return null;
}

// ─── validateResponses ───────────────────────────────────────────────────
// Devuelve { valid: boolean, errors: [{ path, code, message }] }.
// `path` usa notación con índices cuando descendemos por repeater:
//   "emotions[2].intensity". `code` está pensado para ser mapeable a
//   i18n en el cliente (es un vocabulario cerrado, no strings de UI).
function validateResponses(responses, schema) {
  const errors = [];
  if (!schema || !Array.isArray(schema.fields)) {
    return { valid: true, errors };
  }
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) {
    errors.push({ path: '', code: 'invalid_root', message: 'responses debe ser un objeto plano' });
    return { valid: false, errors };
  }
  for (const field of schema.fields) {
    walkValidation(field, responses, '', errors);
  }
  return { valid: errors.length === 0, errors };
}

function isRequiredMissing(field, value) {
  if (!field.required) return false;
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.length === 0) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function buildError(path, code, field) {
  return {
    path,
    code,
    message: `Campo "${field.label}" → ${code}`,
    field_key: field.key,
  };
}

function looksLikeNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function walkValidation(field, value, parentPath, errors) {
  const fpath = parentPath ? parentPath + '.' + field.key : field.key;
  const fvalue = value && typeof value === 'object' && !Array.isArray(value) ? value[field.key] : undefined;

  if (isRequiredMissing(field, fvalue)) {
    errors.push(buildError(fpath, 'required_missing', field));
    return;
  }
  if (fvalue === undefined || fvalue === null) return;

  switch (field.type) {
    case 'text':
    case 'textarea':
      // Cualquier string válido (incluido el vacío si required=false). Tamaño
      // máximo se valida en backendSizedRoute si el campo tiene maxlength.
      break;

    case 'date':
      if (typeof fvalue !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(fvalue)) {
        errors.push(buildError(fpath, 'invalid_date', field));
      }
      break;

    case 'number':
    case 'scale': {
      if (!looksLikeNumber(fvalue)) {
        errors.push(buildError(fpath, 'not_a_number', field));
        break;
      }
      const min = field.min === undefined ? -Infinity : field.min;
      const max = field.max === undefined ? Infinity : field.max;
      if (fvalue < min || fvalue > max) {
        errors.push(buildError(fpath, 'out_of_range', field));
      }
      break;
    }

    case 'select': {
      const opts = field.options || [];
      const allowed = new Set(opts.map(o => (typeof o === 'string' ? o : o.key)));
      // Si el campo tiene `source` (catalog/hierarchy), el caller resolverá
      // las opciones dinámicamente y ya pasó el valor validado por el UI.
      // Aún así defendemos: si la opción no está, error.
      if (!field.source && !allowed.has(fvalue)) {
        errors.push(buildError(fpath, 'invalid_option', field));
      }
      break;
    }

    case 'multi_select': {
      if (!Array.isArray(fvalue)) {
        errors.push(buildError(fpath, 'not_an_array', field));
        break;
      }
      // multi_select con source === catalog/hierarchy: el caller resolvió
      // y trae los valores correctos por nombre; validamos unicidad.
      if (field.source) {
        const seen = new Set();
        for (const v of fvalue) {
          if (typeof v !== 'string') {
            errors.push(buildError(fpath, 'invalid_option', field));
            return;
          }
          if (seen.has(v)) {
            errors.push(buildError(fpath, 'duplicate_value', field));
            return;
          }
          seen.add(v);
        }
        break;
      }
      const opts = field.options || [];
      const allowed = new Set(opts.map(o => (typeof o === 'string' ? o : o.key)));
      const invalid = fvalue.filter(v => !allowed.has(v));
      if (invalid.length > 0) {
        errors.push(buildError(fpath, 'invalid_option', field));
      }
      break;
    }

    case 'boolean': {
      if (typeof fvalue !== 'boolean') {
        errors.push(buildError(fpath, 'not_a_boolean', field));
      }
      break;
    }

    case 'repeater': {
      if (!Array.isArray(fvalue)) {
        errors.push(buildError(fpath, 'not_an_array', field));
        break;
      }
      // Repeater: walk por cada item, salvando fvalue[i] como valor local.
      // Para sub-campos sensibles de item_sensitive=true / sub.sensitive=true
      // el validator sigue funcionando igual; la sensibilidad no afecta a la
      // corrección de tipos, solo a la decisión de encriptar (delegada a
      // utils/exerciseEncryption.js).
      for (let i = 0; i < fvalue.length; i++) {
        if (field.fields) {
          for (const sub of field.fields) {
            walkValidation(sub, fvalue[i], fpath + '[' + i + ']', errors);
          }
        }
      }
      break;
    }

    default:
      // tipo desconocido → registramos un warning pero NO fallamos el PUT.
      // El backend debe aceptar schemas nuevos que la UI ya conozca.
      break;
  }
}

// ─── getSensitiveFieldPaths ──────────────────────────────────────────────
// Devuelve `[{ raw_path, repeater_key, sub_key, index_wildcard, kind }]`.
// Todos los paths emitidos son absolutos desde la raíz de `responses`.
//   - raw_path: "situation" || "emotions[*].name" || "emotions[0].body_location".
//   - repeater_key: "emotions" si el path entra dentro de un repeater.
//   - sub_key: "name" si es dentro de un repeater.
//   - index_wildcard: true → la indexación concreta se computa contra el array
//     en responses (lo hace utils/exerciseEncryption.js).
//   - kind: el tipo del field (text | textarea | scale | number | …) — útil
//     para que el encriptador sepa qué vacío puede ignorar.
function getSensitiveFieldPaths(schema) {
  const out = [];
  if (!schema || !Array.isArray(schema.fields)) return out;
  for (const field of schema.fields) walkSensitive(field, '', out);
  return out;
}

function walkSensitive(field, parentPath, out) {
  const headKey = parentPath ? parentPath + '.' + field.key : field.key;

  if (field.type === 'repeater') {
    const itemSensitive = field.item_sensitive === true;
    const subs = Array.isArray(field.fields) ? field.fields : [];
    // full_strip === "ningún sub-campo del item sobrevive en responses".
    // Se activa cuando item_sensitive=true o cuando cada sub-field declara
    // sensitive=true explícitamente. En este caso el item completo va al
    // blob y el array en `responses` queda con items vacíos [] o sin la
    // propiedad entera (delegado al walker de encryption para decidir).
    const allSubSensitive = subs.length > 0 && subs.every(s => s.sensitive === true);
    const fullStrip = itemSensitive || allSubSensitive;

    for (const sub of subs) {
      if (fullStrip || sub.sensitive === true) {
        pushRepeaterPath(out, headKey, sub, fullStrip);
      }
    }
    return;
  }

  if (field.sensitive === true) {
    out.push({
      raw_path: headKey,
      repeater_key: null,
      sub_key: null,
      index_wildcard: false,
      kind: field.type,
      full_strip: false,
    });
  }
}

function pushRepeaterPath(out, repeaterKey, sub, fullStrip) {
  out.push({
    raw_path: repeaterKey + '[*].' + sub.key,
    repeater_key: repeaterKey,
    sub_key: sub.key,
    index_wildcard: true,
    kind: sub.type,
    full_strip: fullStrip === true,
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────
module.exports = {
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
  deepFreeze,
  SCHEMA_VERSION,
};
