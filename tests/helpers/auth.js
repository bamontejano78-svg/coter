/**
 * ═══════════════════════════════════════════════════════════════
 * Helpers de autenticación para tests de integración — Coter Pro
 *
 * Por qué existe:
 *   La migración 023 hizo obligatoria la verificación de email. Desde
 *   entonces POST /therapists/register NO emite JWT ni devuelve el objeto
 *   `therapist`; devuelve { requires_verification: true }.
 *
 *   Los tests necesitan partir del estado "terapeuta verificado", así que
 *   consumen la verification_url devuelta en test contra el endpoint real.
 *   El endpoint marca email_verified_at, consume el token de un solo uso y
 *   emite el JWT de sesión tal como lo haría el usuario al abrir el enlace.
 *   No se actualiza directamente la base de datos ni se fabrica un JWT: el
 *   propio endpoint de verificación emite la sesión.
 *
 *   SMTP se desactiva en el preflight de tests para evitar correos externos y
 *   hacer que el endpoint de registro devuelva la URL de prueba.
 * ═══════════════════════════════════════════════════════════════
 */

const request = require('supertest');

/**
 * Consume una URL de verificación creada por el registro de la app de test.
 * Solo envía el token al endpoint local de Supertest; nunca navega al host de
 * APP_URL. Los errores no incluyen ni la URL ni el token.
 *
 * @param {import('express').Express} app
 * @param {string} verificationUrl
 * @returns {Promise<{id: string, email: string, token: string, therapist: Object}>}
 */
async function verifyEmailAndGetSession(app, verificationUrl) {
  let token;
  try {
    token = new URL(verificationUrl).searchParams.get('token');
  } catch (_error) {
    throw new Error('Registro de test no devolvió una URL de verificación válida.');
  }

  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error('Registro de test no devolvió un token de verificación válido.');
  }

  const verification = await request(app)
    .get('/api/v1/therapists/verify-email')
    .query({ token });
  const body = verification.body || {};

  if (verification.statusCode !== 200 || body.success !== true || !body.token || !body.therapist?.id) {
    const reason = body.code || body.error || 'respuesta inesperada';
    throw new Error(`Verificación de email de test falló (${verification.statusCode}): ${reason}`);
  }

  return {
    id: body.therapist.id,
    email: body.therapist.email,
    token: body.token,
    therapist: body.therapist,
  };
}

module.exports = { verifyEmailAndGetSession };
