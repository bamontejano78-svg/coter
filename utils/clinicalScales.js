// ════════════════════════════════════════════════════════════════════════════
// utils/clinicalScales.js
// ════════════════════════════════════════════════════════════════════════════
// Schemas estáticos y scoring automático para escalas clínicas estandarizadas.
//
// PHQ-9  (Patient Health Questionnaire-9) — Kroenke, Spitzer & Williams, 2001
// GAD-7  (Generalized Anxiety Disorder-7)  — Spitzer, Kroenke, Williams, 2006
// BDI-II (Beck Depression Inventory-II)    — Beck, Steer & Brown, 1996
//
// Cada escala es un exercise_kind clínico con auto_score=true. El paciente
// responde preguntas tipo scale (0-3). El backend calcula la puntuación
// total y la severidad. Los resultados se grafican en el tiempo.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const SCHEMA_VERSION = 1;

// ─── PHQ-9 ──────────────────────────────────────────────────────────────
const PHQ9_QUESTIONS = [
  { key: 'q01', label: 'Poco interés o placer en hacer las cosas' },
  { key: 'q02', label: 'Sentirse desanimado/a, deprimido/a o sin esperanza' },
  { key: 'q03', label: 'Problemas para dormir (dormir poco o demasiado)' },
  { key: 'q04', label: 'Sentirse cansado/a o con poca energía' },
  { key: 'q05', label: 'Poco apetito o comer en exceso' },
  { key: 'q06', label: 'Sentirte mal contigo mismo/a, fracasado/a, o haber defraudado a tu familia' },
  { key: 'q07', label: 'Dificultad para concentrarte en cosas como leer o ver televisión' },
  { key: 'q08', label: 'Moverte o hablar tan despacio que otros lo notan, o lo contrario: estar inquieto/a' },
  { key: 'q09', label: 'Pensamientos de que estarías mejor muerto/a o de hacerte daño' },
];

const PHQ9_SCORING = {
  ranges: [
    { min: 0,  max: 4,  label: 'Mínima',     severity: 'none' },
    { min: 5,  max: 9,  label: 'Leve',        severity: 'mild' },
    { min: 10, max: 14, label: 'Moderada',     severity: 'moderate' },
    { min: 15, max: 19, label: 'Moderada-Severa', severity: 'moderate_severe' },
    { min: 20, max: 27, label: 'Severa',       severity: 'severe' },
  ],
  max_score: 27,
};

const PHQ9_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  auto_score: true,
  scoring: PHQ9_SCORING,
  fields: Object.freeze(
    PHQ9_QUESTIONS.map(q => ({
      key: q.key,
      label: q.label,
      type: 'scale',
      required: true,
      sensitive: false,
      min: 0,
      max: 3,
      description: '0 = Nunca | 1 = Varios días | 2 = Más de la mitad de los días | 3 = Casi todos los días',
    }))
  ),
  guidance: 'PHQ-9 (Kroenke et al., 2001). Cuestionario de 9 ítems para cribado de depresión. Responde según cómo te has sentido las últimas 2 semanas. La pregunta 9 (pensamientos de autolesión) requiere atención clínica inmediata si la puntuación es ≥1.',
});

// ─── GAD-7 ──────────────────────────────────────────────────────────────
const GAD7_QUESTIONS = [
  { key: 'q01', label: 'Sentirte nervioso/a, ansioso/a o con los nervios de punta' },
  { key: 'q02', label: 'No poder dejar de preocuparte o controlar la preocupación' },
  { key: 'q03', label: 'Preocuparte demasiado por diferentes cosas' },
  { key: 'q04', label: 'Dificultad para relajarte' },
  { key: 'q05', label: 'Estar tan inquieto/a que es difícil quedarse quieto/a' },
  { key: 'q06', label: 'Irritarte o enfadarte con facilidad' },
  { key: 'q07', label: 'Sentir miedo como si algo terrible pudiera pasar' },
];

const GAD7_SCORING = {
  ranges: [
    { min: 0,  max: 4,  label: 'Mínima',      severity: 'none' },
    { min: 5,  max: 9,  label: 'Leve',         severity: 'mild' },
    { min: 10, max: 14, label: 'Moderada',      severity: 'moderate' },
    { min: 15, max: 21, label: 'Severa',        severity: 'severe' },
  ],
  max_score: 21,
};

const GAD7_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  auto_score: true,
  scoring: GAD7_SCORING,
  fields: Object.freeze(
    GAD7_QUESTIONS.map(q => ({
      key: q.key,
      label: q.label,
      type: 'scale',
      required: true,
      sensitive: false,
      min: 0,
      max: 3,
      description: '0 = Nunca | 1 = Varios días | 2 = Más de la mitad de los días | 3 = Casi todos los días',
    }))
  ),
  guidance: 'GAD-7 (Spitzer et al., 2006). Cuestionario de 7 ítems para cribado de ansiedad generalizada. Responde según cómo te has sentido las últimas 2 semanas.',
});

// ─── BDI-II ──────────────────────────────────────────────────────────────
const BDI_II_QUESTIONS = [
  { key: 'q01', label: 'Tristeza' },
  { key: 'q02', label: 'Pesimismo sobre el futuro' },
  { key: 'q03', label: 'Sensación de fracaso' },
  { key: 'q04', label: 'Pérdida de placer (anhedonia)' },
  { key: 'q05', label: 'Sentimientos de culpa' },
  { key: 'q06', label: 'Sentimientos de castigo' },
  { key: 'q07', label: 'Disgusto con uno mismo' },
  { key: 'q08', label: 'Autocrítica' },
  { key: 'q09', label: 'Pensamientos suicidas' },
  { key: 'q10', label: 'Llanto' },
  { key: 'q11', label: 'Agitación' },
  { key: 'q12', label: 'Pérdida de interés' },
  { key: 'q13', label: 'Indecisión' },
  { key: 'q14', label: 'Sentimiento de inutilidad' },
  { key: 'q15', label: 'Pérdida de energía' },
  { key: 'q16', label: 'Cambios en el sueño' },
  { key: 'q17', label: 'Irritabilidad' },
  { key: 'q18', label: 'Cambios en el apetito' },
  { key: 'q19', label: 'Dificultad de concentración' },
  { key: 'q20', label: 'Cansancio o fatiga' },
  { key: 'q21', label: 'Pérdida de interés en el sexo' },
];

const BDI_II_SCORING = {
  ranges: [
    { min: 0,  max: 13,  label: 'Mínima',        severity: 'none' },
    { min: 14, max: 19,  label: 'Leve',           severity: 'mild' },
    { min: 20, max: 28,  label: 'Moderada',       severity: 'moderate' },
    { min: 29, max: 63,  label: 'Severa',         severity: 'severe' },
  ],
  max_score: 63,
};

const BDI_II_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  auto_score: true,
  scoring: BDI_II_SCORING,
  fields: Object.freeze(
    BDI_II_QUESTIONS.map(q => ({
      key: q.key,
      label: q.label,
      type: 'scale',
      required: true,
      sensitive: false,
      min: 0,
      max: 3,
      description: '0 = No me afecta | 1 = Leve | 2 = Moderado | 3 = Grave',
    }))
  ),
  guidance: 'BDI-II (Beck et al., 1996). Inventario de Depresión de Beck, 21 ítems. Responde según cómo te has sentido las últimas 2 semanas, incluyendo hoy. La pregunta 9 (pensamientos suicidas) requiere atención clínica urgente si la puntuación es ≥2.',
});

// ─── Index by kind ─────────────────────────────────────────────────────
const CLINICAL_SCALES = Object.freeze({
  phq9:  PHQ9_SCHEMA,
  gad7:  GAD7_SCHEMA,
  bdiii: BDI_II_SCHEMA,
});

const SCALE_KINDS = Object.freeze(['phq9', 'gad7', 'bdiii']);

// ─── Scoring ────────────────────────────────────────────────────────────
/**
 * Calcula la puntuación de una escala clínica a partir de las respuestas.
 * @param {Object} responses - { q01: 2, q02: 1, ... }
 * @param {string} kind - 'phq9' | 'gad7' | 'bdiii'
 * @returns {{ total: number, max: number, severity: string, label: string, q09_flag?: boolean }}
 */
function scoreResponses(responses, kind) {
  const scale = CLINICAL_SCALES[kind];
  if (!scale || !responses) return null;

  let total = 0;
  for (const field of scale.fields) {
    const val = responses[field.key];
    if (typeof val === 'number' && val >= 0 && val <= 3) {
      total += val;
    }
  }

  const scoring = scale.scoring;
  let severity = 'unknown';
  let label = 'Sin clasificar';
  for (const range of scoring.ranges) {
    if (total >= range.min && total <= range.max) {
      severity = range.severity;
      label = range.label;
      break;
    }
  }

  const result = {
    total,
    max: scoring.max_score,
    severity,
    label,
    completedAt: new Date().toISOString(),
  };

  // Flag de seguridad: pregunta de autolesión/suicidio
  if (kind === 'phq9' && responses.q09 >= 1) {
    result.q09_flag = true;
    result.q09_value = responses.q09;
  }
  if (kind === 'bdiii' && responses.q09 >= 2) {
    result.q09_flag = true;
    result.q09_value = responses.q09;
  }

  return result;
}

/**
 * Obtiene el historial de puntuaciones para un paciente + escala.
 * @param {Object} pool - PostgreSQL pool
 * @param {string} patientId
 * @param {string} kind - phq9 | gad7 | bdiii
 * @returns {Promise<Array<{ id, total, severity, label, completed_at, q09_flag }>>}
 */
async function getScoreHistory(pool, patientId, kind) {
  if (!SCALE_KINDS.includes(kind)) return [];

  const { rows } = await pool.query(
    `SELECT es.id, es.responses, es.completed_at
     FROM exercise_sessions es
     JOIN assignments a ON a.id = es.assignment_id
     WHERE a.patient_id = $1
       AND a.exercise_kind = $2
       AND es.is_complete = TRUE
     ORDER BY es.completed_at ASC`,
    [patientId, kind]
  );

  return rows.map(row => {
    let responses = {};
    try { responses = typeof row.responses === 'string' ? JSON.parse(row.responses) : (row.responses || {}); } catch (e) { /* ignore */ }
    const score = scoreResponses(responses, kind);
    return {
      id: row.id,
      total: score ? score.total : null,
      max: score ? score.max : null,
      severity: score ? score.severity : null,
      label: score ? score.label : null,
      completed_at: row.completed_at,
      q09_flag: score ? score.q09_flag : false,
    };
  }).filter(s => s.total !== null);
}

// ─── Exports ─────────────────────────────────────────────────────────────
module.exports = {
  SCALE_KINDS,
  CLINICAL_SCALES,
  PHQ9_SCHEMA,
  GAD7_SCHEMA,
  BDI_II_SCHEMA,
  scoreResponses,
  getScoreHistory,
};
