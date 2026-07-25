let unreadAlerts = [];
let insightsData = null;

async function loadAlerts() {
  try {
    const r = await api(API + '/therapists/alerts');
    const d = await r.json();
    if (!d.success) return;
    unreadAlerts = d.alerts || [];
    renderAlertsBadge();
    if (unreadAlerts.length > 0) renderAlertsPanel();
  } catch (e) {
    console.error('[loadAlerts]', e);
  }
}

function renderAlertsBadge() {
  const badge = document.getElementById('alertsBadge');
  if (!badge) return;
  const count = unreadAlerts.length;
  if (count === 0) { badge.classList.add('hidden'); return; }
  badge.classList.remove('hidden');
  badge.textContent = count;
  const hasCritical = unreadAlerts.some(a => a.severity === 'critical');
  badge.className = 'alerts-badge' + (hasCritical ? ' alerts-critical' : '');
}

function renderAlertsPanel() {
  const panel = document.getElementById('alertsPanel');
  const list = document.getElementById('alertsList');
  if (!panel || !list) return;
  panel.style.display = 'block';
  list.innerHTML = unreadAlerts.map((a, i) => {
    const sevCls = a.severity === 'critical' ? 'alert-critical' : a.severity === 'warning' ? 'alert-warning' : 'alert-info';
    const icon = a.severity === 'critical' ? '!' : a.severity === 'warning' ? '?' : 'i';
    return '<div class="alert-item ' + sevCls + '" style="animation-delay:' + (i * 40) + 'ms">' +
      '<span class="alert-icon">' + icon + '</span>' +
      '<div class="alert-body">' +
      '<div class="alert-msg">' + sanitizeHTML(a.message) + '</div>' +
      '<div class="alert-meta">' + sanitizeHTML(a.patient_name || 'Paciente') + ' · ' + new Date(a.created_at).toLocaleString('es-ES') + '</div>' +
      '<div class="alert-actions">' +
      '<button class="btn btn-sm" data-action="ack-alert" data-alert-id="' + sanitizeHTML(a.id) + '">Reconocer</button>' +
      '<button class="btn btn-sm btn-p" data-action="resolve-alert" data-alert-id="' + sanitizeHTML(a.id) + '">Resolver</button>' +
      '</div></div></div>';
  }).join('');
}

async function dismissAllAlerts() {
  const ids = unreadAlerts.map(a => a.id);
  if (!ids.length) return;
  try {
    await api(API + '/therapists/alerts/read', { method: 'PUT', body: JSON.stringify({ alertIds: ids }) });
    unreadAlerts = [];
    renderAlertsBadge();
    const panel = document.getElementById('alertsPanel');
    if (panel) panel.style.display = 'none';
    showToast('Alertas marcadas como leidas', 'success');
  } catch (e) {
    console.error('[dismissAllAlerts]', e);
  }
}

async function updateOneAlertStatus(alertId, status) {
  if (!alertId) return;
  try {
    await api(API + '/therapists/alerts/status', { method: 'PUT', body: JSON.stringify({ alertIds: [alertId], status }) });
    unreadAlerts = unreadAlerts.filter(a => a.id !== alertId);
    renderAlertsBadge();
    if (unreadAlerts.length) renderAlertsPanel();
    else {
      const panel = document.getElementById('alertsPanel');
      if (panel) panel.style.display = 'none';
    }
    showToast(status === 'resolved' ? 'Alerta resuelta' : 'Alerta reconocida', 'success');
  } catch (e) {
    console.error('[updateOneAlertStatus]', e);
    showToast('No se pudo actualizar la alerta', 'error');
  }
}

async function loadInsights() {
  if (!currentPatientId) return;
  const box = document.getElementById('patientInsights');
  if (!box) return;
  box.innerHTML = '<div class="presession-loading"><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text short"></div></div>';
  try {
    const r = await api(API + '/therapists/patients/' + currentPatientId + '/weekly-insights');
    const d = await r.json();
    if (!d.success) { renderEmptyState(box,{icon:'⚠️',title:'Error al cargar insights',desc:'No se pudieron obtener los insights semanales. Intenta de nuevo.'}); return; }
    insightsData = d;
    renderInsights();
  } catch (e) {
    console.error('[loadInsights]', e);
    renderEmptyState(box,{icon:'🔌',title:'Error de conexión',desc:'No se pudo conectar con el servidor para cargar los insights.'});
  }
}

function renderInsights() {
  const box = document.getElementById('patientInsights');
  if (!box || !insightsData) return;
  const ins = insightsData;
  let html = '';
  html += '<div class="insights-header"><div class="insights-header-icon">#</div><div><strong>' + sanitizeHTML(ins.patientName) + '</strong><br><small>Semana del ' + new Date(ins.weekStart).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) + ' al ' + new Date(ins.weekEnd).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) + '</small></div></div>';
  if (!ins.insights || !ins.insights.length) {
    html += '<div class="empty-state" style="padding:24px 16px"><span class="empty-icon">📊</span><div class="empty-title">Datos insuficientes</div><div class="empty-desc">El paciente necesita más check-ins y actividad esta semana para generar insights automáticos.</div></div>';
  } else {
    const typeIcons = { mood_summary: ':)', mood_change: '+', no_checkins: '-', exercise_adherence: '%', goal_progress: '*', clinical_scale: '#' };
    ins.insights.forEach(item => {
      html += '<div class="insight-item"><span class="insight-icon">' + (typeIcons[item.type] || '*') + '</span><div class="insight-body"><div class="insight-title">' + sanitizeHTML(item.title) + '</div><div class="insight-text">' + sanitizeHTML(item.text) + '</div></div></div>';
    });
  }
  html += '<div class="insights-actions"><button class="btn btn-p btn-sm" data-action="send-insight-to-patient">Enviar resumen al paciente</button></div>';
  box.innerHTML = html;
  const sendBtn = box.querySelector('[data-action="send-insight-to-patient"]');
  if (sendBtn) sendBtn.addEventListener('click', sendInsightToPatient);
}

async function sendInsightToPatient() {
  if (!insightsData || !insightsData.insights) return;
  const text = insightsData.insights.map(i => '- ' + i.text).join('\n\n');
  const msg = 'Resumen semanal de ' + (insightsData.patientName || 'Coter') + ':\n\n' + text + '\n\n- Tu terapeuta en Coter Pro';
  try {
    await api(API + '/therapists/patients/' + currentPatientId + '/messages', { method: 'POST', body: JSON.stringify({ message: msg }) });
    showToast('Resumen enviado al paciente', 'success');
  } catch (e) {
    showToast('Error al enviar', 'error');
  }
}
