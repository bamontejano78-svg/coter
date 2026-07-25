/* ============================================================
   Coter Pro — Utilidades UI compartidas
   Cargado antes de patient.js, therapist.js, y sus plugins.
   ============================================================ */

/**
 * Sanitiza texto para prevenir XSS en contenido dinámico.
 * @param {string} str
 * @returns {string}
 */
function sanitizeHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Renderiza un estado vacío diseñado con icono, título y CTA opcional.
 * @param {string|HTMLElement} container - ID del elemento o elemento DOM
 * @param {object} opts
 * @param {string} [opts.icon='📭'] - Emoji o icono
 * @param {string} [opts.title=''] - Título
 * @param {string} [opts.desc=''] - Descripción
 * @param {string} [opts.cta=''] - Texto del botón CTA
 * @param {Function} [opts.ctaAction=null] - Callback al hacer clic en el CTA
 */
function renderEmptyState(container, opts = {}) {
  const { icon = '📭', title = '', desc = '', cta = '', ctaAction = null } = opts;
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;
  let html = '<div class="empty-state">';
  if (icon) html += '<span class="empty-icon">' + icon + '</span>';
  if (title) html += '<div class="empty-title">' + sanitizeHTML(title) + '</div>';
  if (desc) html += '<div class="empty-desc">' + sanitizeHTML(desc) + '</div>';
  if (cta) html += '<button class="empty-cta" data-empty-cta>' + sanitizeHTML(cta) + '</button>';
  html += '</div>';
  el.innerHTML = html;
  if (cta && ctaAction && typeof ctaAction === 'function') {
    const btn = el.querySelector('[data-empty-cta]');
    if (btn) btn.addEventListener('click', ctaAction);
  }
}
