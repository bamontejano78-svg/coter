// ════════════════════════════════════════════════════════════════════════════
// utils/exerciseHelpers.js
// ════════════════════════════════════════════════════════════════════════════
// Helpers compartidos entre routes/patients.js y routes/therapist.js para
// resolver el schema efectivo de un assignment y decodificar la fila de
// exercise_sessions a respuestas planas "merged" (sensibles + no sensibles).
//
// Por qué existe:
//   El contrato PHI es:
//     • assignments.exercise_schema      → JSONB inmutable salvo que el
//                                          terapeuta edite la plantilla.
//     • exercise_sessions.responses     → JSONB solo con campos NO sensibles
//                                          (queryable agregados clínicos).
//     • exercise_sessions.encrypted_blob → ciphertext AES-256-GCM con los
//                                          textos sensibles del paciente.
//
//   Para que el frontend hidrate el formulario o el terapeuta vea respuestas
//   comprimidas, hay que mergear responses + blob en un único objeto plano.
//   Esa lógica no debe vivir inline en dos rutas diferentes: si cambia
//   encryptFieldsForKind/decryptFieldsForKind, debemos actualizar un solo
//   punto. Además, las pruebas de rutas dependen de esta lógica.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { getSchema } = require('./exerciseSchemas');
const { decryptFieldsForKind } = require('./exerciseEncryption');

// ─── schemaForAssignment ─────────────────────────────────────
// Resuelve el schema efectivo para una fila de assignments. Por qué existe:
// la BD guarda exercise_schema en task_templates + assignments (migration 007),
// y la discriminant mode/phobia vive dentro del schema para BA y graded_exposure.
// Devuelve null si kind='classic' o si la fila no trae exercise_kind.
function schemaForAssignment(asg) {
  if (!asg || !asg.exercise_kind) return null;
  return getSchema(asg.exercise_kind, asg.exercise_schema, {
    mode: asg.exercise_schema && asg.exercise_schema.mode,
    phobia: asg.exercise_schema && asg.exercise_schema.phobia,
  });
}

// ─── decodeSessionResponses ──────────────────────────────────
// Decodifica una fila de exercise_sessions (responses + blob) a respuestas
// planas "merged" (sensibles + no sensibles), usando el schema del assignment.
//   • schema null  → devuelve los responses crudos sin merge. Esto cubre dos
//                    casos:
//                    1) kind='classic' (imposible porque INSERT solo permite
//                       4 kinds clínicos, pero defensivo).
//                    2) caller quiere leer respuestas planas sin descifrar.
//   • blob ausente → devuelve deep clone de responses.
//   • blob malformado/cifrado fallido → logger.warn + clone sin merge (sesión
//                    "vacía" en UI; el terapeuta puede reabriéndola).
function decodeSessionResponses(sessRow, assignment) {
  if (!sessRow || !assignment) return null;
  const schema = schemaForAssignment(assignment);
  if (!schema) return sessRow.responses || {};
  return decryptFieldsForKind(sessRow.responses || {}, sessRow.encrypted_blob, schema);
}

// ─── fetchLatestSessionsForAssignments ───────────────────────
// Para una lista de assignments ya decryptados, devuelve un Map
//   assignment_id → última sesión (más reciente por updated_at DESC).
// Devuelve Map sin clave si no hay sesión iniciada para ese assignment.
// DISTINCT ON (assignment_id) + ORDER BY assignment_id, updated_at DESC
// es la forma idiomática de "uno por grupo con más reciente primero" en
// PostgreSQL. Si el caller lo invoca con un array vacío, retorna Map vacío.
async function fetchLatestSessionsForAssignments(pool, patientId, assignments) {
  const map = new Map();
  if (!assignments || assignments.length === 0) return map;
  const ids = assignments.map(a => a.id);
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (assignment_id)
            assignment_id, id, is_complete, started_at, updated_at, completed_at,
            responses, encrypted_blob, exercise_kind
       FROM exercise_sessions
      WHERE patient_id = $1 AND assignment_id = ANY($2::uuid[])
      ORDER BY assignment_id, updated_at DESC, started_at DESC`,
    [patientId, ids]
  );
  for (const r of rows) map.set(r.assignment_id, r);
  return map;
}

module.exports = {
  schemaForAssignment,
  decodeSessionResponses,
  fetchLatestSessionsForAssignments,
};
