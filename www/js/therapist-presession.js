// ═══════════════════════════════════════════════════════════════════════
// MEMORIA TERAPÉUTICA AUMENTADA (Pre-sesión)
// Cargado después de therapist.js. Añade las funciones loadPreSession
// y renderPreSession al scope global.
// ═══════════════════════════════════════════════════════════════════════

let preSessionData = null;

async function loadPreSession(){
  if(!currentPatientId) return;
  const box = document.getElementById('patientPreSession');
  if(!box) return;
  box.innerHTML = '<div class="presession-loading"><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text short"></div><div class="skeleton skeleton-card"></div></div>';
  try {
    const r = await api(API + '/therapists/patients/' + currentPatientId + '/pre-session');
    const d = await r.json();
    if(!d.success) { renderEmptyState(box,{icon:'⚠️',title:'Error al cargar',desc:'No se pudo obtener la memoria pre-sesión. Intenta de nuevo más tarde.'}); return; }
    preSessionData = d.preSession;
    renderPreSession();
  } catch(e) {
    console.error('[loadPreSession]', e);
    renderEmptyState(box,{icon:'🔌',title:'Error de conexión',desc:'No se pudo conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo.'});
  }
}

function renderPreSession(){
  const box = document.getElementById('patientPreSession');
  if(!box || !preSessionData) return;
  const ps = preSessionData;

  const dirConfig = {
    improving: { label: 'Mejorando 📈', cls: 'presession-trend-up', icon: '📈' },
    declining: { label: 'Disminuyendo 📉', cls: 'presession-trend-down', icon: '📉' },
    stable: { label: 'Estable ➡️', cls: 'presession-trend-stable', icon: '➡️' },
    insufficient_data: { label: 'Datos insuficientes', cls: 'presession-trend-neutral', icon: '📊' },
    no_data: { label: 'Sin datos aún', cls: 'presession-trend-neutral', icon: '📊' },
  };
  const dir = dirConfig[ps.emotionalTrend.direction] || dirConfig.no_data;

  let html = '';

  // ── 1. Resumen narrativo ──
  html += '<div class="presession-summary">';
  html += '<div class="presession-summary-icon">🧠</div>';
  html += '<div class="presession-summary-text">' + sanitizeHTML(ps.summary || 'Cargando síntesis...') + '</div>';
  html += '</div>';

  // ── 2. Meta de última sesión ──
  if(ps.daysSinceLastSession !== null && ps.daysSinceLastSession !== undefined) {
    html += '<div class="presession-meta-row">';
    html += '<span>📅 Última sesión: <strong>' + new Date(ps.lastSessionDate).toLocaleDateString('es-ES', {day:'numeric',month:'long',year:'numeric'}) + '</strong></span>';
    html += '<span>⏱ Hace <strong>' + ps.daysSinceLastSession + ' día' + (ps.daysSinceLastSession === 1 ? '' : 's') + '</strong></span>';
    html += '</div>';
  } else {
    html += '<div class="presession-meta-row"><span>📝 Sin notas clínicas aún — mostrando datos de los últimos 14 días</span></div>';
  }

  // ── 3. Tarjetas ──
  html += '<div class="presession-grid">';

  // Tendencia emocional
  html += '<div class="presession-card ' + dir.cls + '">';
  html += '<div class="presession-card-header">' + dir.icon + ' Tendencia emocional</div>';
  html += '<div class="presession-card-value ' + dir.cls + '">' + sanitizeHTML(dir.label) + '</div>';
  if(ps.emotionalTrend.current && ps.emotionalTrend.previous) {
    const cur = ps.emotionalTrend.current;
    const prev = ps.emotionalTrend.previous;
    const moodDelta = cur.mood - prev.mood;
    const anxietyDelta = cur.anxiety - prev.anxiety;
    html += '<div class="presession-deltas">';
    html += '<div class="presession-delta"><span class="presession-delta-label">Ánimo</span><span class="presession-delta-val ' + (moodDelta >= 0 ? 'positive' : 'negative') + '">' + (moodDelta >= 0 ? '+' : '') + moodDelta.toFixed(1) + '</span></div>';
    html += '<div class="presession-delta"><span class="presession-delta-label">Ansiedad</span><span class="presession-delta-val ' + (anxietyDelta <= 0 ? 'positive' : 'negative') + '">' + (anxietyDelta > 0 ? '+' : '') + anxietyDelta.toFixed(1) + '</span></div>';
    html += '</div>';
  } else if(ps.emotionalTrend.current) {
    html += '<div style="font-size:13px;color:var(--muted)">Ánimo actual: <strong>' + ps.emotionalTrend.current.mood + '/10</strong></div>';
  }
  html += '</div>';

  // Adherencia
  html += '<div class="presession-card">';
  html += '<div class="presession-card-header">📋 Adherencia a ejercicios</div>';
  const rate = ps.adherence.completionRate;
  html += '<div class="presession-adherence-ring">';
  html += '<svg viewBox="0 0 100 100" class="presession-ring"><circle cx="50" cy="50" r="42" fill="none" stroke="var(--b)" stroke-width="8"/><circle cx="50" cy="50" r="42" fill="none" stroke="' + (rate >= 75 ? 'var(--s)' : rate >= 40 ? 'var(--w)' : 'var(--d)') + '" stroke-width="8" stroke-dasharray="' + (rate * 2.64) + ' 264" stroke-linecap="round" transform="rotate(-90 50 50)"/></svg>';
  html += '<div class="presession-ring-center"><span class="presession-ring-num">' + rate + '%</span><span class="presession-ring-sub">' + ps.adherence.completedAssignments + '/' + ps.adherence.totalAssignments + '</span></div>';
  html += '</div>';
  html += '<div class="presession-adherence-detail">';
  html += '<div><span class="presession-dot" style="background:var(--s)"></span> Completadas: <strong>' + ps.adherence.completedAssignments + '</strong></div>';
  html += '<div><span class="presession-dot" style="background:var(--w)"></span> Pendientes: <strong>' + ps.adherence.pendingAssignments + '</strong></div>';
  html += '<div><span class="presession-dot" style="background:var(--p)"></span> Sesiones clínicas: <strong>' + ps.adherence.completedSessions + '/' + ps.adherence.totalSessions + '</strong></div>';
  html += '</div>';
  html += '</div>';

  // Racha
  html += '<div class="presession-card">';
  html += '<div class="presession-card-header">🔥 Registro diario</div>';
  html += '<div class="presession-streak"><span class="presession-streak-num">' + (ps.metrics.streakDays || 0) + '</span><span class="presession-streak-label">días consecutivos</span></div>';
  html += '<div class="presession-metrics-mini">';
  html += '<div><span>📊 Check-ins totales</span><strong>' + (ps.metrics.totalCheckIns || 0) + '</strong></div>';
  if(ps.metrics.lastCheckIn) {
    html += '<div><span>🕐 Último registro</span><strong>' + new Date(ps.metrics.lastCheckIn).toLocaleDateString('es-ES', {day:'numeric',month:'short'}) + '</strong></div>';
  }
  html += '</div>';
  html += '</div>';
  html += '</div>';

  // ── 4. Eventos clave ──
  if(ps.keyEvents && ps.keyEvents.length > 0) {
    html += '<div class="presession-section"><div class="presession-section-title">📌 Eventos clave desde la última sesión</div>';
    html += '<div class="presession-events">';
    ps.keyEvents.forEach(ev => {
      const sevCls = ev.severity === 'warning' ? 'presession-event-warning' : ev.severity === 'positive' ? 'presession-event-positive' : 'presession-event-info';
      html += '<div class="presession-event ' + sevCls + '">';
      html += '<span class="presession-event-icon">' + (ev.icon || '📌') + '</span>';
      html += '<div class="presession-event-body">';
      html += '<div class="presession-event-text">' + sanitizeHTML(ev.description) + '</div>';
      if(ev.date) html += '<div class="presession-event-date">' + new Date(ev.date).toLocaleDateString('es-ES', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) + '</div>';
      html += '</div></div>';
    });
    html += '</div></div>';
  }

  // ── 5. Mini-chart de barras ──
  if(ps.emotionalTrend.weeklyBreakdown && ps.emotionalTrend.weeklyBreakdown.length >= 2) {
    html += '<div class="presession-section"><div class="presession-section-title">📈 Evolución diaria (14 días)</div>';
    html += '<div class="presession-mini-chart"><div class="presession-mini-chart-bars">';
    const maxMood = Math.max(...ps.emotionalTrend.weeklyBreakdown.map(d => d.mood), 1);
    ps.emotionalTrend.weeklyBreakdown.forEach(d => {
      const h = Math.round((d.mood / maxMood) * 80);
      const barCls = d.mood >= 7 ? 'mood-high' : d.mood >= 4 ? 'mood-mid' : 'mood-low';
      html += '<div class="presession-bar-col" title="' + sanitizeHTML(new Date(d.day + 'T00:00:00').toLocaleDateString('es-ES', {day:'numeric',month:'short'})) + ': Ánimo ' + d.mood + '/10, Ansiedad ' + d.anxiety + '/10">';
      html += '<div class="presession-bar ' + barCls + '" style="height:' + h + 'px"></div>';
      html += '<div class="presession-bar-label">' + d.mood + '</div>';
      html += '<div class="presession-bar-day">' + new Date(d.day + 'T00:00:00').toLocaleDateString('es-ES', {day:'numeric'}) + '</div>';
      html += '</div>';
    });
    html += '</div></div></div>';
  }

  // ── 6. Acciones rápidas ──
  html += '<div class="presession-actions">';
  html += '<button class="btn btn-s btn-sm" data-action="add-note" style="margin-right:8px">+ Nota de sesión (SOAP)</button>';
  html += '<button class="btn btn-p btn-sm" data-action="go-chat">💬 Ir al chat</button>';
  html += '</div>';

  box.innerHTML = html;

  // Bind "go-chat" button to switch to chat tab
  const goChatBtn = box.querySelector('[data-action="go-chat"]');
  if(goChatBtn) {
    goChatBtn.addEventListener('click', () => {
      document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.modal-tab-content').forEach(c => c.classList.remove('active'));
      const chatTab = document.querySelector('.modal-tab[data-ptab="ptab-chat"]');
      const chatContent = document.getElementById('ptab-chat');
      if(chatTab) chatTab.classList.add('active');
      if(chatContent) chatContent.classList.add('active');
    });
  }

  // Bind "add-note" button to trigger existing showAddNote
  const addNoteBtn = box.querySelector('[data-action="add-note"]');
  if(addNoteBtn) {
    addNoteBtn.addEventListener('click', () => {
      if(typeof showAddNote === 'function') showAddNote();
    });
  }
}
