/* ============================================================
   Coter Pro — Cache centralizado de pacientes del terapeuta
   ============================================================
   Single source of truth para todas las llamadas a
   GET /api/v1/therapists/patients desde el frontend.

   Antes: loadPatients y assignTemplateToPatient vivían en
   www/js/therapist.js con su propia copia de la lógica de fetch +
   cache + manejo de error. La duplicación permitía que en algún
   futuro las dos rutas divergieran (regression conocido en commits
   previos: catch silencioso que mostraba "no tienes pacientes"
   cuando el fetch fallaba).

   Ahora: este módulo expone PatientsCache (init, getPatients,
   invalidate) en window. Cualquier script que necesite la lista
   de pacientes activos del terapeuta debe pasar por aquí — así
   solo hay que mantener UNA implementación de:
     - TTL del cache (30s por defecto)
     - distinción entre success:true y success:false en respuesta
     - manejo de fetchError (lanza con mensaje significativo)

   Uso desde www/js/therapist.js:
     PatientsCache.init({ API, api });          // tras definir API+api
     const list = await PatientsCache.getPatients({ force: false });
     PatientsCache.invalidate();                // tras crear/desconectar
   ============================================================ */

(function (global) {
  'use strict';

  const DEFAULT_TTL_MS = 30 * 1000;
  let _cache = null;
  let _cacheAt = 0;
  let _ttlMs = DEFAULT_TTL_MS;
  let _API = null;
  let _api = null;

  /**
   * Inicializa el módulo con la URL base de la API y el wrapper `api(url, opts)`
   * que ya tiene el flujo de auto-refresh de token integrado.
   * Debe llamarse antes de cualquier getPatients/invalidate.
   */
  function init({ API, api, ttlMs } = {}) {
    if (!API) throw new Error('PatientsCache.init: API es obligatorio');
    if (typeof api !== 'function') throw new Error('PatientsCache.init: api debe ser una función');
    _API = API;
    _api = api;
    if (typeof ttlMs === 'number' && ttlMs > 0) _ttlMs = ttlMs;
  }

  /**
   * Devuelve la lista de pacientes activos del terapeuta.
   * Usa el cache si está vigente y no se ha pedido force.
   *
   * @param {Object} [opts]
   * @param {boolean} [opts.force=false] - true para saltarse el cache y re-fetchear
   * @returns {Promise<Array>} array de pacientes (puede estar vacío)
   * @throws {Error} si el fetch falla o el servidor responde success=false
   */
  async function getPatients({ force = false } = {}) {
    if (!_API || !_api) {
      throw new Error('PatientsCache.getPatients: el módulo no está inicializado (llama init primero)');
    }
    const now = Date.now();
    if (!force && _cache && (now - _cacheAt) < _ttlMs) {
      return _cache;
    }
    const r = await _api(_API + '/therapists/patients');
    const d = await r.json();
    _cacheAt = now;
    if (!d.success) {
      // Limpiar cache para no devolver datos viejos si el siguiente fetch también falla
      _cache = null;
      const message = (d && d.error) || 'Servidor respondió success=false';
      throw new Error(message);
    }
    _cache = d.patients || [];
    return _cache;
  }

  /**
   * Invalida el cache. Llamar tras operaciones que cambian la lista activa:
   *   - POST /connection-codes con patient_name (nuevo paciente)
   *   - DELETE /connections (desconectar)
   * (también puede ser llamada en sesión debug manualmente desde la consola)
   */
  function invalidate() {
    _cache = null;
    _cacheAt = 0;
  }

  /**
   * Utilidad de diagnóstico: estado actual del cache.
   * Útil para inspect en la consola del navegador.
   */
  function _debug() {
    const now = Date.now();
    return {
      initialized: !!_API,
      cached: !!_cache,
      patientsCount: _cache ? _cache.length : 0,
      ageMs: _cache ? now - _cacheAt : null,
      ttlMs: _ttlMs,
      validUntil: _cache ? new Date(_cacheAt + _ttlMs).toISOString() : null,
    };
  }

  global.PatientsCache = {
    init,
    getPatients,
    invalidate,
    debug: _debug,
  };
})(typeof window !== 'undefined' ? window : globalThis);
