'use strict';

/**
 * Comprueba ownership multi-tenant en recursos clínicos.
 * Devuelve false sin revelar si el paciente existe para otros terapeutas.
 */
async function therapistOwnsActivePatient(pool, therapistId, patientId) {
  const { rows } = await pool.query(
    "SELECT 1 FROM therapist_patients WHERE therapist_id = $1 AND patient_id = $2 AND status = 'active' LIMIT 1",
    [therapistId, patientId]
  );
  return rows.length > 0;
}

module.exports = { therapistOwnsActivePatient };
