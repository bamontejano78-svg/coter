/**
 * ═══════════════════════════════════════════════════════════════
 * Cliente HTTP para tests de integración — Coter Pro
 *
 * Qué hace:
 *   Es `supertest`, con una sola diferencia: cuando la petición va a
 *   POST /api/v1/therapists/register y el registro tiene éxito, completa
 *   automáticamente la verificación de email a través del endpoint HTTP real
 *   y adjunta los datos autenticados en `res.testSession` (sin alterar el body).
 *
 * Por qué:
 *   La migración 023 dejó el registro devolviendo { requires_verification }
 *   sin JWT. Eso es correcto en producción. Los tests que necesitan una
 *   sesión válida leen `res.testSession`; el body sigue fiel al contrato real.
 *
 *   Los tests parten del estado "terapeuta listo para usar", no del estado
 *   "acabo de registrarme y no he abierto el correo". El cuerpo HTTP original
 *   permanece idéntico al real para que no se oculte el contrato del registro.
 *
 * Reglas:
 *   - Los registros que NO tienen éxito (email duplicado, password corta…) NO
 *     se tocan: se devuelve la respuesta tal cual, para que los tests de
 *     camino negativo sigan comprobando lo que deben.
 *   - Si la verificación falla, la petición del test rechaza con un error
 *     explícito; nunca se oculta como una respuesta satisfactoria.
 *   - En el resto de rutas, es supertest puro.
 *
 * Uso en un test:
 *   const request = require('./helpers/request');
 * ═══════════════════════════════════════════════════════════════
 */

const supertest = require('supertest');
const { verifyEmailAndGetSession } = require('./auth');

// Evitar correo saliente en tests sin cargar config/env antes de que los tests
// definan sus secretos deterministas. dotenv no sobrescribe variables vacías.
for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) {
  process.env[key] = '';
}

const REGISTER_PATH = '/api/v1/therapists/register';

/**
 * Completa la verificación y anexa la sesión de test sin cambiar el body HTTP.
 *
 * @param {import('express').Express} app
 * @param {Object} test — Test de supertest
 * @returns {Object} el mismo Test, encadenable
 */
function patchRegister(app, test) {
  let patched = false;

  const originalThen = test.then.bind(test);
  test.then = function (onFulfilled, onRejected) {
    return originalThen(async (res) => {
      const body = res && res.body;

      // Solo actuamos si el registro salió bien. Caminos negativos intactos.
      if (!patched && body && body.success === true) {
        patched = true;
        if (body.requires_verification !== true || !body.verification_url) {
          throw new Error('Registro exitoso no devolvió el estado de verificación esperado para tests.');
        }
        res.testSession = await verifyEmailAndGetSession(app, body.verification_url);
      }

      return onFulfilled ? onFulfilled(res) : res;
    }, onRejected);
  };

  return test;
}

/**
 * Sustituto de `supertest(app)` para tests.
 *
 * @param {import('express').Express} app
 * @returns {Object}
 */
function request(app) {
  const agent = supertest(app);

  const originalPost = agent.post.bind(agent);
  agent.post = function (url) {
    const test = originalPost(url);
    return url === REGISTER_PATH ? patchRegister(app, test) : test;
  };

  return agent;
}

module.exports = request;
