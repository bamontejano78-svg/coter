/* ============================================================
   Coter Pro — JS del panel de terapeuta
   (sanitizeHTML y renderEmptyState en /js/shared-ui.js)
   ============================================================ */

// Solo usar URL absoluta en dev local directo (sin nginx).
// En staging/prod con HTTPS o nginx, usar ruta relativa.
const isLocalDev = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.protocol === 'http:';
const API = isLocalDev ? 'http://localhost:3000/api/v1' : '/api/v1';
let token=null,refreshToken=null,therapist=null,currentPatientId=null,patientData=null,trendChart=null,adherenceChart=null,patientBreakdownChart=null,currentPeriod=7;
let templates=[],templateCategories=[],activeCategory=null;
let isRefreshing=false;
let refreshPromise=null;
let patientPoll=null;
let sseConnection=null;
let sseReconnectTimer=null;
let sseBackoffMs=0;

// ═══════════════════════════════════════════════════════════
// ANIMACIONES Y MICRO-INTERACCIONES
// ═══════════════════════════════════════════════════════════

/**
 * Anima un número con efecto de conteo
 * @param {HTMLElement} el - Elemento DOM
 * @param {number} target - Valor final
 * @param {number} duration - Duración en ms
 */
function animateCounter(el, target, duration = 800) {
  const start = parseInt(el.textContent) || 0;
  if (start === target) return;
  const startTime = performance.now();
  const diff = target - start;
  
  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Easing: easeOutCubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(start + diff * eased);
    el.textContent = current;
    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      el.textContent = target;
      // Mini-pop al final
      el.style.animation = 'none';
      el.offsetHeight; // trigger reflow
      el.style.animation = 'countPop .3s ease';
    }
  }
  requestAnimationFrame(update);
}

/**
 * Sistema de toasts no intrusivo
 */
function showToast(message, type = 'info', duration = 3500) {
  // Crear contenedor si no existe
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast-item ${type}`;
  toast.innerHTML = `<span>${icons[type] || '📌'}</span> ${sanitizeHTML(message)}`;
  toast.onclick = () => dismissToast(toast);
  container.appendChild(toast);
  
  const timer = setTimeout(() => dismissToast(toast), duration);
  toast._timer = timer;
}

function dismissToast(toast) {
  if (toast._dismissing) return;
  toast._dismissing = true;
  clearTimeout(toast._timer);
  toast.classList.add('removing');
  setTimeout(() => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, 300);
}

/**
 * Skeleton loading para secciones
 */
function showSkeleton(containerId, type = 'list', count = 3) {
  const el = document.getElementById(containerId);
  if (!el) return;
  
  if (type === 'stats') {
    el.innerHTML = Array(4).fill('<div class="skeleton skeleton-card"></div>').join('');
  } else if (type === 'list') {
    el.innerHTML = Array(count).fill('<div class="skel-row"><div class="skel-row-col"><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text short"></div></div></div>').join('');
  } else if (type === 'table') {
    el.innerHTML = Array(count).fill(`<tr><td colspan="6"><div class="skeleton" style="height:40px"></div></td></tr>`).join('');
  }
}


function saveSession(t, rt, th){
  token=t;refreshToken=rt;therapist=th;
  localStorage.setItem('coter_therapist',JSON.stringify({therapist:th}));
}

async function doLogin(){
  const email=document.getElementById('loginEmail').value.trim();
  const password=document.getElementById('loginPassword').value.trim();
  if(!email||!password)return Swal.fire('Error','Completa todos los campos','error');
  try{
    const r=await fetch(`${API}/therapists/login`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const d=await r.json();
    if(d.success){saveSession(d.token,d.refresh_token,d.therapist);showApp();}
    else Swal.fire('Error',d.error||'Credenciales inválidas','error');
  }catch(e){Swal.fire('Error','No se pudo conectar con el servidor','error');}
}

async function doRegister(){
  const name=document.getElementById('regName').value.trim();
  const email=document.getElementById('regEmail').value.trim();
  const specialty=document.getElementById('regSpecialty').value.trim();
  const password=document.getElementById('regPassword').value.trim();
  if(!name||!email||!specialty||!password)return Swal.fire('Error','Completa todos los campos','error');
  if(password.length<6)return Swal.fire('Error','Contraseña: mínimo 6 caracteres','error');
  try{
    const r=await fetch(`${API}/therapists/register`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,email,specialty,password})});
    const d=await r.json();
    if(d.success){saveSession(d.token,d.refresh_token,d.therapist);showApp();}
    else Swal.fire('Error',d.error||'Error al registrarse','error');
  }catch(e){Swal.fire('Error','No se pudo conectar con el servidor','error');}
}

function showLogin(){document.getElementById('registerScreen').classList.add('hidden');document.getElementById('loginScreen').classList.remove('hidden');}
function showRegister(){document.getElementById('loginScreen').classList.add('hidden');document.getElementById('registerScreen').classList.remove('hidden');}

async function logout(){
  try{
    // Intentar revocar refresh tokens en el servidor
    const headers={'Content-Type':'application/json'};
    if(token)headers.Authorization=`Bearer ${token}`;
    await fetch(`${API}/therapists/logout`,{method:'POST',credentials:'include',headers});
  }catch(e){}
  disconnectSSE();
  localStorage.removeItem('coter_therapist');
  location.reload();
}

// Refresh automático del access token
async function refreshAccessToken(){
  const opts={method:'POST',credentials:'include',headers:{'Content-Type':'application/json'}};
  if(refreshToken)opts.body=JSON.stringify({refresh_token:refreshToken});
  const r=await fetch(`${API}/therapists/refresh-token`,opts);
  const d=await r.json();
  if(!d.success)throw new Error(d.error||'Refresh failed');
  token=d.token;
  refreshToken=d.refresh_token;
  // Actualizar localStorage
  const saved=JSON.parse(localStorage.getItem('coter_therapist')||'{}');
  if(saved.therapist)localStorage.setItem('coter_therapist',JSON.stringify({therapist:saved.therapist}));
  return token;
}

// Wrapper de fetch con auto-refresh en 401
async function api(url,opts={}){
  const doFetch=()=>{
    const headers={'Content-Type':'application/json',...(opts.headers||{})};
    if(token)headers.Authorization=`Bearer ${token}`;
    return fetch(url,{...opts,credentials:'include',headers});
  };

  let r=await doFetch();

  // Si 401, intentar refrescar el token una vez
  if(r.status===401){
    if(!isRefreshing){
      isRefreshing=true;
      refreshPromise=refreshAccessToken().finally(()=>{isRefreshing=false;refreshPromise=null;});
    }
    try{
      await refreshPromise;
      r=await doFetch(); // Reintentar con el nuevo token
    }catch(e){
      // Si falla el refresh, redirigir al login
      localStorage.removeItem('coter_therapist');
      location.reload();
      throw e;
    }
  }

  return r;
}

// Inicializar el cache centralizado de /therapists/patients. Cualquier script
// que llame a GET /api/v1/therapists/patients debe pasar por window.PatientsCache
// (definido en www/js/patients-cache.js, cargado antes que therapist.js en
// terapeuta.html). Lo inicializamos aquí con el wrapper `api()` que ya tiene
// auto-refresh de token integrado.
try { PatientsCache.init({ API, api }); } catch (e) { console.warn('[therapist.js] PatientsCache.init falló', e); }

function showApp(){
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('registerScreen').classList.add('hidden');
  document.getElementById('appScreen').classList.remove('hidden');
  document.getElementById('therapistName').textContent=therapist.name;
  loadDashboard();loadPatients();loadCode();loadAlerts();
  // Dashboard sigue usando polling 30s para stats que no son reactivos
  // (la actividad reciente y los contadores solo cambian cuando llega un
  // evento SSE, así que el polling es ahora opcional — pero lo conservamos
  // como resync defensivo tras reconexiones largas o errores de carga).
  setInterval(loadDashboard,30000);
  connectSSE();
}

// ─── SSE — Real-time stream para el terapeuta ───────────────────────
//
// Sustituye los setInterval(getPatients/check/modal poll) por un único stream
// abierto. La auth sigue el patrón de ticket de un solo uso (ver routes/events.js).
function disconnectSSE() {
  if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer=null; }
  if (sseConnection) { try { sseConnection.close(); } catch(e){} sseConnection=null; }
  sseBackoffMs = 0;
}

async function connectSSE() {
  if (!token) return;
  disconnectSSE();
  try {
    const r = await api(API + '/events/ticket/therapist', { method: 'POST' });
    const d = await r.json();
    if (!d || !d.success || !d.ticket) {
      scheduleSSEReconnect();
      return;
    }
    sseConnection = new EventSource(API + '/events?ticket=' + encodeURIComponent(d.ticket));
    sseBackoffMs = 0;

    sseConnection.addEventListener('connected', () => {
      // Re-sincronizamos la lista de pacientes y el dashboard al reconectar.
      loadPatients({force: true});
      loadDashboard();
      if (currentPatientId) refreshCurrentPatientData();
    });

    sseConnection.onmessage = (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch (e) { return; }
      handleSSEEvent(payload);
    };

    sseConnection.onerror = () => {
      if (!sseConnection) return;
      if (sseConnection.readyState === EventSource.CLOSED) {
        sseConnection.close();
        sseConnection = null;
        scheduleSSEReconnect();
      }
    };
  } catch (e) {
    console.warn('[SSE] connect failed:', e);
    scheduleSSEReconnect();
  }
}

function scheduleSSEReconnect() {
  if (sseReconnectTimer) return;
  sseBackoffMs = sseBackoffMs ? Math.min(sseBackoffMs * 2, 30000) : 2000;
  sseReconnectTimer = setTimeout(() => { sseReconnectTimer=null; connectSSE(); }, sseBackoffMs);
}

// Refetch fresco del paciente cuyo modal está abierto. Llamado cuando llega
// un mensaje:new u otro evento relevante. Encapsulado para que la lógica de
// comparación "último mensaje == emitido vs recibido" (que ya teníamos en el
// patientPoll) siga funcionando exactamente igual.
async function refreshCurrentPatientData() {
  if (!currentPatientId) return;
  try {
    const rp = await api(API + '/therapists/patients/' + currentPatientId);
    const dp = await rp.json();
    if (!dp.success || !dp.patient || !patientData) return;
    const newLatest = dp.patient.messages && dp.patient.messages[0]?.id;
    const oldLatest = patientData.messages && patientData.messages[0]?.id;
    if ((dp.patient.messages || []).length !== (patientData.messages || []).length || newLatest !== oldLatest) {
      patientData = dp.patient;
      renderChat();
    }

    // Tareas: re-render si cambió el conjunto o el estado. La firma es
    // "<id>:<status>" (suficiente para status changes; cambios de título se
    // verían en el próximo render por pestaña).
    const ticketsKey = (dp.patient.assignments || []).map(a => a.id + ':' + a.status).join(',');
    if (currentPatientDataTicketsKey && currentPatientDataTicketsKey !== ticketsKey) {
      currentPatientDataTicketsKey = ticketsKey;
      renderTasks();
    }
    currentPatientDataTicketsKey = ticketsKey;

    // También refrescamos tareas/check-ins si estos cambiaron (la pestaña
    // "Tareas" del modal necesita enterarse).
    if (currentPatientDataTicketsKey && currentPatientDataTicketsKey !== ticketsKey) {
      currentPatientDataTicketsKey = ticketsKey;
      renderTasks();
    }
  } catch (e) {
    console.error('[refreshCurrentPatientData]', e);
  }
}
let currentPatientDataTicketsKey = null;

function handleSSEEvent(payload) {
  if (!payload || !payload.type) return;
  const t = payload.type;
  const data = payload.data || {};
  switch (t) {
    case 'patient:connected':
      // Paciente nuevo acaba de canjear un código de conexión.
      PatientsCache.invalidate();
      loadPatients({force: true});
      loadDashboard();
      showToast('🆕 Nuevo paciente conectado', 'success');
      break;
    case 'checkin:new': {
      loadDashboard();
      // Si este check-in corresponde al paciente del modal abierto, refresca.
      if (currentPatientId && data.patientId === currentPatientId) {
        refreshCurrentPatientData();
      }
      // Alerta clínica sutil si el paciente está en riesgo (mood <=3 o ansiedad >=9).
      // No es un sistema de crisis completo; es una mejora de UX.
      if (typeof data.mood === 'number' && data.mood <= 3) {
        showToast('⚠️ Ánimo bajo en ' + (data.patientId?.slice(0, 8) || 'paciente'), 'warning');
      }
      break;
    }
    case 'task:completed':
      loadDashboard();
      if (currentPatientId && data.patientId === currentPatientId) {
        refreshCurrentPatientData();
      }
      break;
    case 'message:new':
      // Si llega un mensaje y el modal del paciente correspondiente está
      // abierto, refrescamos su chat. Si no hay modal, el dashboard polling
      // 30s lo recogerá (no se considera crítico mostrarlo instantáneo en
      // la lista resumida).
      if (currentPatientId && data.patientId === currentPatientId) {
        refreshCurrentPatientData();
      }
      break;
    case 'connection:terminated':
      if (data.by === 'self') {
        // Confirmación local de que el disconnect que acabamos de hacer
        // quedó propagado a otras pestañas. Nada que hacer en UI.
      } else {
        // Caso extraño (no debería llegar al terapeuta): por seguridad
        // cerramos cualquier modal abierto y refrescamos la lista.
        if (currentPatientId) closePatientModal();
        PatientsCache.invalidate();
        loadPatients({force: true});
      }
      break;
    case 'note:created':
      // Solo relevante si el modal está abierto y la pestaña de notas activa.
      // El render actual solo se dispara al pulsar el tab; lo dejamos para
      // una mejora futura (no añade valor clínico inmediato).
      break;
  }
}

async function loadDashboard(period){
  if(!period) period = currentPeriod;
  currentPeriod = period;
  showSkeleton('recentActivity', 'list', 3);
  try{
    const r=await api(`${API}/therapists/dashboard?period=${period}`);const d=await r.json();
    if(!d.success)return;
    const db=d.dashboard;
    animateCounter(document.getElementById('statPatients'), db.activePatients);
    animateCounter(document.getElementById('statCheckins'), db.todayCheckins);
    animateCounter(document.getElementById('statTasks'), db.pendingTasks);
    animateCounter(document.getElementById('statRisk'), db.atRisk);
    
    // Charts
    updateTrendChart(db.weeklyTrend||[], period);
    updateAdherenceChart(db.adherence);
    updatePatientBreakdownChart(db.patientBreakdown||[]);
    updateComparisonCards(db.comparison, db.todayCheckins);
    updateSessionStats(db.sessionStats);
    
    // Recent activity
    const act=document.getElementById('recentActivity');
    if(!db.recentActivity?.length){renderEmptyState(act,{icon:'📊',title:'Sin actividad reciente',desc:'La actividad de tus pacientes aparecerá aquí cuando registren check-ins o completen tareas.'});return;}
    act.innerHTML=db.recentActivity.map((a,i)=>`<div class="recent-row" style="animation-delay:${i*40}ms"><span>${sanitizeHTML(a.patient_name||'Paciente '+a.patient_id?.slice(0,8))}</span><span>Ánimo: <strong>${a.mood}/10</strong></span><span class="recent-time">${new Date(a.created_at).toLocaleString('es-ES')}</span></div>`).join('');
  }catch(e){console.error(e);}
}

function updateTrendChart(data, period){
  var ctx=document.getElementById('trendChart');if(trendChart)trendChart.destroy();
  // Limpiar mensaje de estado vacío previo
  var existingMsg=ctx.parentNode.querySelector('.empty-chart-msg');
  if(existingMsg) existingMsg.remove();
  ctx.style.display='';
  if(!data||!data.length){
    ctx.style.display='none';
    var msg=document.createElement('div');
    msg.className='empty-chart-msg';
    msg.textContent='No hay suficientes datos para el período seleccionado';
    ctx.parentNode.appendChild(msg);
    return;
  }
  var periodLabel=period===90?'Últimos 90 días':period===30?'Últimos 30 días':'Últimos 7 días';
  trendChart=new Chart(ctx,{type:'line',data:{labels:data.map(function(d){return d.day;}),datasets:[
    {label:'Ánimo',data:data.map(function(d){return d.avg_mood;}),borderColor:'#6366f1',backgroundColor:'rgba(99,102,241,.08)',tension:.4,fill:true,pointRadius:3},
    {label:'Ansiedad',data:data.map(function(d){return d.avg_anxiety;}),borderColor:'#ef4444',backgroundColor:'rgba(239,68,68,.06)',tension:.4,fill:true,pointRadius:3},
    {label:'Energía',data:data.map(function(d){return d.avg_energy;}),borderColor:'#10b981',backgroundColor:'rgba(16,185,129,.05)',tension:.4,fill:true,pointRadius:3,borderDash:[4,2]}
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{usePointStyle:true,padding:20,font:{size:12}}},title:{display:true,text:periodLabel,font:{size:11,weight:'normal'},color:'var(--muted)'}},scales:{y:{min:1,max:10,ticks:{stepSize:1},grid:{color:'rgba(148,163,184,.1)'}},x:{grid:{display:false}}}},interaction:{mode:'index',intersect:false}}});
}

function updateAdherenceChart(adherence){
  var ctx=document.getElementById('adherenceChart');if(adherenceChart)adherenceChart.destroy();
  var container=document.getElementById('adherenceChartContainer');
  var existingMsg=container.querySelector('.empty-chart-msg');
  if(existingMsg) existingMsg.remove();
  ctx.style.display='';
  if(!adherence||adherence.total===0){
    ctx.style.display='none';
    var msg=document.createElement('div');
    msg.className='empty-chart-msg';
    msg.textContent='Sin datos de adherencia en este período';
    container.appendChild(msg);
    return;
  }
  var pending=adherence.total-adherence.completed;
  adherenceChart=new Chart(ctx,{type:'doughnut',data:{labels:['Completadas','Pendientes'],datasets:[{data:[adherence.completed,pending],backgroundColor:['#10b981','#f1f5f9'],borderColor:['#10b981','#e2e8f0'],borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,cutout:'65%',plugins:{legend:{position:'bottom',labels:{usePointStyle:true,padding:20,font:{size:12}}},title:{display:true,text:adherence.rate+'% de adherencia',position:'bottom',font:{size:18,weight:'700'},color:adherence.rate>=70?'#10b981':adherence.rate>=40?'#f59e0b':'#ef4444',padding:0}},layout:{padding:{top:8,bottom:8}}}});
}

function updatePatientBreakdownChart(patients){
  var ctx=document.getElementById('patientBreakdownChart');if(patientBreakdownChart)patientBreakdownChart.destroy();
  var existingMsg=ctx.parentNode.querySelector('.empty-chart-msg');
  if(existingMsg) existingMsg.remove();
  ctx.style.display='';
  if(!patients||!patients.length){
    ctx.style.display='none';
    var msg=document.createElement('div');
    msg.className='empty-chart-msg';
    msg.textContent='Sin datos de pacientes en este período';
    ctx.parentNode.appendChild(msg);
    return;
  }
  var topPatients=patients.slice(0,8);
  patientBreakdownChart=new Chart(ctx,{type:'bar',data:{labels:topPatients.map(function(p){return (p.name||'P'+p.patient_id.slice(0,8)).substring(0,14);}),datasets:[
    {label:'Ánimo medio',data:topPatients.map(function(p){return p.avg_mood;}),backgroundColor:'rgba(99,102,241,.7)',borderRadius:4},
    {label:'Ansiedad media',data:topPatients.map(function(p){return p.avg_anxiety;}),backgroundColor:'rgba(239,68,68,.5)',borderRadius:4}
  ]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{usePointStyle:true,font:{size:12}}}},scales:{x:{min:1,max:10,ticks:{stepSize:1},grid:{color:'rgba(148,163,184,.1)'}},y:{grid:{display:false}}}}});
}

function updateComparisonCards(comparison, todayCheckins){
  var container=document.getElementById('comparisonCards');
  if(!comparison){
    container.innerHTML='<div class="empty-chart-msg">Sin datos comparativos</div>';
    return;
  }
  var delta=comparison.checkins.delta;
  var deltaIcon=delta>0?'📈':delta<0?'📉':'➡️';
  var deltaClass=delta>0?'delta-positive':delta<0?'delta-negative':'delta-neutral';
  var prevLabel=currentPeriod===90?'90 días anteriores':currentPeriod===30?'30 días anteriores':'7 días anteriores';
  var currentLabel=currentPeriod===90?'Últimos 90 días':currentPeriod===30?'Últimos 30 días':'Últimos 7 días';
  container.innerHTML='<div class="comparison-row">'
    +'<div class="comparison-metric"><div class="comparison-value">'+todayCheckins+'</div><div class="comparison-label">Check-ins hoy</div></div>'
    +'<div class="comparison-metric"><div class="comparison-value">'+comparison.checkins.current+'</div><div class="comparison-label">'+currentLabel+'</div></div>'
    +'<div class="comparison-metric"><div class="comparison-value">'+comparison.checkins.previous+'</div><div class="comparison-label">'+prevLabel+'</div></div>'
    +'<div class="comparison-delta '+deltaClass+'">'+deltaIcon+' '+(delta>=0?'+':'')+delta+' vs período anterior</div>'
    +'</div>';
}

function updateSessionStats(sessionStats){
  var container=document.getElementById('sessionStats');
  if(!sessionStats||sessionStats.total===0){
    container.innerHTML='<div class="empty-chart-msg">Sin sesiones en este período</div>';
    return;
  }
  var hours=Math.floor(sessionStats.totalMinutes/60);
  var mins=sessionStats.totalMinutes%60;
  container.innerHTML='<div class="session-stats-grid">'
    +'<div class="session-stat-item"><div class="session-stat-num">'+sessionStats.total+'</div><div class="session-stat-label">Sesiones totales</div></div>'
    +'<div class="session-stat-item"><div class="session-stat-num">'+sessionStats.completed+'</div><div class="session-stat-label">Completadas</div></div>'
    +'<div class="session-stat-item"><div class="session-stat-num">'+(hours>0?hours+'h ':'')+mins+'m</div><div class="session-stat-label">Tiempo total</div></div>'
    +'</div>';
}

async function loadPatients({force=false}={}){
  try{
    const patients=await PatientsCache.getPatients({force});
    const tbody=document.getElementById('patientsTableBody');
    if(!patients.length){tbody.innerHTML='<tr><td colspan="6"><div class="empty-state" style="padding:36px 16px"><span class="empty-icon">👥</span><div class="empty-title">No tienes pacientes aún</div><div class="empty-desc">Genera un código de acceso y compártelo con tus pacientes para que se conecten.</div></div></td></tr>';return;}
    tbody.innerHTML=patients.map((p,i)=>{
      const badge=p.last_mood<=3?'badge-risk':p.last_mood>=7?'badge-ok':'badge-warn';
      return`<tr style="animation:fadeInUp .3s cubic-bezier(.22,1,.36,1) ${i*.04}s both"><td><strong>${sanitizeHTML(p.name||'Anónimo')}</strong><br><small class="id-sub">${p.id?.slice(0,12)}...</small></td><td>${new Date(p.connected_at).toLocaleDateString('es-ES')}</td><td>${p.last_checkin?new Date(p.last_checkin).toLocaleDateString('es-ES'):'Nunca'}</td><td><strong>${p.last_mood||'-'}/10</strong></td><td><span class="badge ${badge}">${p.last_mood<=3?'⚠️ Riesgo':'✅ Estable'}</span></td><td><button class="btn btn-p btn-sm btn-open-patient" data-patient-id="${p.id}">📋 Ver</button></td></tr>`;
    }).join('');
  }catch(e){console.error('Error cargando pacientes:',e);}
}

async function openPatient(patientId){
  currentPatientId=patientId;document.getElementById('patientModal').classList.add('show');
  try{
    const r=await api(`${API}/therapists/patients/${patientId}`);const d=await r.json();
    if(!d.success)return Swal.fire('Error','Paciente no encontrado','error');
    patientData=d.patient;
    currentPatientDataTicketsKey = (patientData.assignments || []).map(a => a.id + ':' + a.status).join(',');
    document.getElementById('modalPatientName').textContent=patientData.name||'Paciente '+patientId.slice(0,8);
    renderChat();renderCheckins();renderTasks();renderGoals();renderSessions();renderNotes();loadPreSession();loadInsights();
    // Eliminamos el patientPoll (antes 4s): los mensajes llegan por SSE
    // (ver handleSSEEvent → message:new) y se refrescan automáticamente
    // mediante refreshCurrentPatientData().
    if (patientPoll) { clearInterval(patientPoll); patientPoll = null; }
  }catch(e){console.error(e);}
}

function closePatientModal(){document.getElementById('patientModal').classList.remove('show');currentPatientId=null;patientData=null;if(patientPoll){clearInterval(patientPoll);patientPoll=null;}}

function renderChat(){
  const box=document.getElementById('patientChat');
  const msgs=(patientData.messages||[]).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  if(!msgs.length){renderEmptyState(box,{icon:'💬',title:'Sin mensajes',desc:'La conversación con este paciente aparecerá aquí.'});return;}
  box.innerHTML=msgs.map(m=>`<div class="msg ${m.is_therapist?'therapist':'patient'}"><div>${sanitizeHTML(m.message)}</div><small>${new Date(m.created_at).toLocaleString('es-ES')}</small></div>`).join('');
  box.scrollTop=box.scrollHeight;
}

async function sendTherapistMsg(){
  const input=document.getElementById('chatMsgInput');const msg=input.value.trim();
  if(!msg||!currentPatientId)return;
  await api(`${API}/therapists/patients/${currentPatientId}/messages`,{method:'POST',body:JSON.stringify({message:msg})});
  input.value='';
  const r=await api(`${API}/therapists/patients/${currentPatientId}`);const d=await r.json();
  if(d.success){patientData=d.patient;renderChat();}
}

function renderCheckins(){
  const box=document.getElementById('patientCheckins');const cis=patientData.checkIns||[];
  if(!cis.length){renderEmptyState(box,{icon:'🌤️',title:'Sin check-ins',desc:'El paciente aún no ha registrado check-ins emocionales.'});return;}
  box.innerHTML=cis.slice(0,30).map((c,i)=>`<div class="checkin-item" style="animation-delay:${i*.04}s"><div class="checkin-mood" data-mood="${c.mood}">${c.mood}</div><div><strong>Ánimo ${c.mood}/10</strong> | Ansiedad ${c.anxiety}/10 | Energía ${c.energy||'-'}/10<br><small class="muted">${new Date(c.created_at).toLocaleString('es-ES')}</small>${c.thoughts?`<br><em>"${sanitizeHTML(c.thoughts)}"</em>`:''}</div></div>`).join('');
  // Apply mood colors
  document.querySelectorAll('.checkin-mood[data-mood]').forEach(el=>{
    const m=parseInt(el.dataset.mood);
    el.style.color=m<=3?'#ef4444':m>=7?'#10b981':'#f59e0b';
  });
}

function renderTasks(){
  const box=document.getElementById('patientTasks');const tasks=patientData.assignments||[];
  if(!tasks.length){renderEmptyState(box,{icon:'📋',title:'Sin tareas asignadas',desc:'Asigna ejercicios desde la biblioteca TCC para que el paciente los complete.',cta:'Abrir biblioteca',ctaAction:()=>{closePatientModal();const tab=document.querySelector('.nav-item[data-tab="library"]');if(tab)tab.click();}});return;}
  box.innerHTML='';
  const kindLabels={thought_record:'Thought Record (Beck)',behavioral_activation:'Activación Conductual',graded_exposure:'Exposición Gradual'};
  tasks.forEach((t,idx)=>{
    const card=document.createElement('div');
    card.className='task-item';
    card.dataset.taskId=t.id;
    const isClinical = window.ExerciseForms && typeof window.ExerciseForms.isClinicalKind === 'function'
      ? window.ExerciseForms.isClinicalKind(t.exercise_kind)
      : (t.exercise_kind && t.exercise_kind !== 'classic');
    const hasCompletedSession=isClinical && t.status==='completed' && t.latest_session && t.latest_session.is_complete;
    card.innerHTML=`<div><strong>${sanitizeHTML(t.title)}</strong> <span class="badge ${t.status==='completed'?'badge-ok':'badge-warn'}">${t.status==='completed'?'Completada':'Pendiente'}</span>${isClinical?` <span class="exercise-kind-badge">${kindLabels[t.exercise_kind]||t.exercise_kind}</span>`:''}</div><small>${sanitizeHTML(t.instructions||'')}</small>${t.due_date?`<br><small> Vence: ${new Date(t.due_date).toLocaleDateString('es-ES')}</small>`:''}`;
    card.style.animationDelay = (idx * 0.04) + 's';
    if(t.status!=='completed'){
      const btn=document.createElement('button');
      btn.className='btn btn-s btn-sm btn-complete-task';
      btn.dataset.taskId=t.id;
      btn.textContent='Marcar completada';
      card.appendChild(btn);
    }
    if(hasCompletedSession){
      const btn=document.createElement('button');
      btn.className='btn btn-w btn-sm btn-view-responses';
      btn.dataset.taskId=t.id;
      btn.textContent='📊 Ver respuestas';
      card.appendChild(btn);
    }
    box.appendChild(card);
  });
}

// toggleResponses(taskId): expande/colapsa inline el panel estructurado de
// respuestas para una tarea clínica completada. Reutiliza el módulo
// window.ExerciseForms (cargado antes de therapist.js).
function toggleResponses(taskId){
  const card=document.querySelector(`#patientTasks [data-task-id="${taskId}"]`);
  if(!card) return;
  const existing=card.nextElementSibling;
  if(existing && existing.classList.contains('exercise-panel')){
    existing.remove();
    return;
  }
  const t=(patientData.assignments||[]).find(x=>x.id===taskId);
  if(!t || !t.latest_session) return;
  const panel=document.createElement('div');
  panel.className='exercise-panel';
  card.parentNode.insertBefore(panel, card.nextSibling);
  if(window.ExerciseForms && typeof window.ExerciseForms.renderReadOnly==='function'){
    window.ExerciseForms.renderReadOnly(panel, t.exercise_schema, t.latest_session.responses||{});
  }else{
    panel.textContent='(Renderer no disponible.)';
  }
}

async function completeTask(taskId){
  await api(`${API}/therapists/patients/${currentPatientId}/assignments/${taskId}`,{method:'PUT',body:JSON.stringify({completed:true})});
  const r=await api(`${API}/therapists/patients/${currentPatientId}`);const d=await r.json();
  if(d.success){patientData=d.patient;renderTasks();showToast('✅ Tarea completada', 'success');}
}

function showAddTask(){
  Swal.fire({title:'Nueva tarea',html:`<input id="swalTaskTitle" class="swal2-input" placeholder="Título"><input id="swalTaskType" class="swal2-input" placeholder="Tipo (ej: ejercicio)"><textarea id="swalTaskInstructions" class="swal2-textarea" placeholder="Instrucciones"></textarea>`,showCancelButton:true,confirmButtonText:'Crear',preConfirm:async()=>{
    const title=document.getElementById('swalTaskTitle').value.trim();
    const type=document.getElementById('swalTaskType').value.trim();
    const instructions=document.getElementById('swalTaskInstructions').value.trim();
    if(!title||!type||!instructions){Swal.showValidationMessage('Completa todos los campos');return false;}
    await api(`${API}/therapists/patients/${currentPatientId}/assignments`,{method:'POST',body:JSON.stringify({title,type,instructions})});
    const r=await api(`${API}/therapists/patients/${currentPatientId}`);const d=await r.json();
    if(d.success){patientData=d.patient;renderTasks();}
  }});
}

function renderGoals(){
  const box=document.getElementById('patientGoals');const goals=patientData.goals||[];
  if(!goals.length){renderEmptyState(box,{icon:'🎯',title:'Sin objetivos definidos',desc:'Establece metas terapéuticas medibles para seguir el progreso del paciente.',cta:'Añadir objetivo',ctaAction:showAddGoal});return;}    box.innerHTML=goals.map((g,i)=>{
    const pct=Math.min(100,Math.round((g.current_value/g.target_value)*100));
    return`<div class="goal-item" style="animation-delay:${i*.04}s"><strong>${sanitizeHTML(g.title)}</strong> <span class="badge ${g.status==='completed'?'badge-ok':'badge-warn'}">${g.status==='completed'?'✅ Completado':'🎯 Activo'}</span><br><small>${sanitizeHTML(g.metric)}: ${g.current_value}/${g.target_value}</small><div class="progress-bar"><div class="progress-fill" data-width="${pct}"></div></div>${g.status!=='completed'?`<input type="number" id="goalVal${g.id}" placeholder="Nuevo valor" class="goal-input"> <button class="btn btn-s btn-sm btn-update-goal" data-goal-id="${g.id}">Actualizar</button>`:''}</div>`;
  }).join('');
  requestAnimationFrame(()=>{
    document.querySelectorAll('.progress-fill[data-width]').forEach(el=>{el.style.width=el.dataset.width+'%';});
  });
}

async function updateGoal(goalId){
  const val=document.getElementById('goalVal'+goalId)?.value;if(!val)return;
  await api(`${API}/therapists/patients/${currentPatientId}/goals/${goalId}`,{method:'PUT',body:JSON.stringify({current_value:parseInt(val)})});
  const r=await api(`${API}/therapists/patients/${currentPatientId}`);const d=await r.json();
  if(d.success){patientData=d.patient;renderGoals();}
}

// ==================== NOTAS CLÍNICAS (SOAP) ====================
async function renderNotes(){
  const box=document.getElementById('patientNotes');
  try{
    const r=await api(`${API}/therapists/patients/${currentPatientId}/clinical-notes`);const d=await r.json();
    if(!d.success||!d.notes?.length){renderEmptyState(box,{icon:'📝',title:'Sin notas clínicas',desc:'Registra notas SOAP para documentar el progreso entre sesiones.',cta:'Nueva nota',ctaAction:showAddNote});return;}
    box.innerHTML=d.notes.map((n,i)=>{
      const date=new Date(n.created_at).toLocaleString('es-ES');
      const updated=n.updated_at&&n.updated_at!==n.created_at?`<span class="edited-tag"> (editada)</span>`:'';
      return`<div class="soap-note" id="note-${n.id}" style="animation-delay:${i*.04}s">
        <div class="soap-note-header"><div><strong>📝 ${date}</strong>${updated}</div><div class="soap-note-date">ID: ${n.id.slice(0,8)}...</div></div>
        ${n.subjective?`<div class="soap-note-field"><strong>S — Subjetivo</strong>${sanitizeHTML(n.subjective)}</div>`:''}
        ${n.objective?`<div class="soap-note-field"><strong>O — Objetivo</strong>${sanitizeHTML(n.objective)}</div>`:''}
        ${n.assessment?`<div class="soap-note-field"><strong>A — Evaluación</strong>${sanitizeHTML(n.assessment)}</div>`:''}
        ${n.plan?`<div class="soap-note-field"><strong>P — Plan</strong>${sanitizeHTML(n.plan)}</div>`:''}
        <div class="soap-note-actions">
          <button class="btn btn-w btn-sm btn-edit-note" data-note-id="${n.id}">✏️ Editar</button>
          <button class="btn btn-d btn-sm btn-delete-note" data-note-id="${n.id}">🗑️ Eliminar</button>
        </div></div>`;
    }).join('');
  }catch(e){box.innerHTML='<p class="empty-msg error">Error al cargar notas</p>';}
}

// ═══════════════════════════════════════════════════════════════
// SESIONES CLÍNICAS (registro estructurado)
// ═══════════════════════════════════════════════════════════════
async function renderSessions(){
  const box=document.getElementById('patientSessions');
  if(!currentPatientId){renderEmptyState(box,{icon:'📅',title:'Sin sesiones',desc:'Selecciona un paciente para ver su historial de sesiones clínicas.'});return;}
  try{
    const r=await api(`${API}/therapists/patients/${currentPatientId}/clinical-sessions`);
    const d=await r.json();
    if(!d.success||!d.sessions?.length){renderEmptyState(box,{icon:'📅',title:'Sin sesiones registradas',desc:'Registra sesiones clínicas para documentar el progreso entre consultas.',cta:'Registrar sesión',ctaAction:showAddSession});return;}
    box.innerHTML=d.sessions.map((s,i)=>{
      const date=new Date(s.session_date).toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'});
      const time=new Date(s.session_date).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'});
      const typeLabel=s.type==='presencial'?'🏥 Presencial':s.type==='videollamada'?'📹 Videollamada':s.type==='telefonica'?'📞 Telefónica':'💻 Chat online';
      const statusBadge=s.status==='completed'?'<span class="session-badge completed">✅ Completada</span>':s.status==='cancelled'?'<span class="session-badge cancelled">❌ Cancelada</span>':'<span class="session-badge scheduled">📋 Programada</span>';
      const duration=s.duration_min?` · ${s.duration_min} min`:'';
      const summary=s.notes_summary?`<div class="session-summary">${sanitizeHTML(s.notes_summary)}</div>`:'';
      const notesHtml=(s.notes||[]).length?`<div class="session-notes-list"><div class="session-notes-title">📝 ${s.notes.length} nota${s.notes.length===1?'':'s'} vinculada${s.notes.length===1?'':'s'}:</div>${s.notes.map(n=>`<div class="session-note-item"><div class="session-note-sections">${[['S',n.subjective],['O',n.objective],['A',n.assessment],['P',n.plan]].filter(([,v])=>v).map(([k,v])=>`<span class="soap-tag">${k}: ${sanitizeHTML(v.length>60?v.substring(0,60)+'…':v)}</span>`).join(' ')}</div></div>`).join('')}</div>`:'';
      return`<div class="session-card" id="session-${s.id}" style="animation: fadeInUp .3s cubic-bezier(.22,1,.36,1) ${i*.04}s both">
        <div class="session-header">
          <div class="session-info">
            <div class="session-date">${date} · ${time}${duration}</div>
            <div class="session-meta">${typeLabel} ${statusBadge}</div>
          </div>
          <div class="session-actions">
            <button class="btn btn-w btn-sm" onclick="showEditSession('${s.id}')" aria-label="Editar sesión">✏️</button>
            <button class="btn btn-d btn-sm" onclick="deleteSession('${s.id}')" aria-label="Eliminar sesión">🗑️</button>
          </div>
        </div>
        ${summary}
        ${notesHtml}
      </div>`;
    }).join('');
  }catch(e){console.error('Error loading sessions:',e);}
}

function showAddSession(){
  if(!currentPatientId)return;
  Swal.fire({title:'📅 Registrar sesión clínica',html:`
    <label class="soap-label">Fecha y hora</label>
    <input type="datetime-local" id="swalSessionDate" class="swal2-input">
    <label class="soap-label">Duración (minutos)</label>
    <input type="number" id="swalSessionDuration" class="swal2-input" placeholder="Ej: 50" min="1" max="300" value="50">
    <label class="soap-label">Tipo de sesión</label>
    <select id="swalSessionType" class="swal2-input">
      <option value="presencial">🏥 Presencial</option>
      <option value="videollamada">📹 Videollamada</option>
      <option value="telefonica">📞 Telefónica</option>
      <option value="online_chat">💻 Chat online</option>
    </select>
    <label class="soap-label">Estado</label>
    <select id="swalSessionStatus" class="swal2-input">
      <option value="completed">✅ Completada</option>
      <option value="scheduled">📋 Programada</option>
      <option value="cancelled">❌ Cancelada</option>
    </select>
    <label class="soap-label">Resumen de la sesión (opcional)</label>
    <textarea id="swalSessionSummary" class="swal2-textarea" placeholder="Notas generales de la sesión…" rows="3" maxlength="500"></textarea>
  `,showCancelButton:true,confirmButtonText:'Guardar',confirmButtonColor:'#6366f1',
    preConfirm:async()=>{
      const session_date=document.getElementById('swalSessionDate').value||new Date().toISOString();
      const duration_min=parseInt(document.getElementById('swalSessionDuration').value)||null;
      const type=document.getElementById('swalSessionType').value;
      const status=document.getElementById('swalSessionStatus').value;
      const notes_summary=document.getElementById('swalSessionSummary').value.trim()||null;
      try{
        const r=await api(`${API}/therapists/patients/${currentPatientId}/clinical-sessions`,{method:'POST',body:JSON.stringify({session_date,duration_min,type,status,notes_summary})});
        const d=await r.json();
        if(!d.success)return Swal.showValidationMessage(d.error||'Error al guardar');
        renderSessions();
      }catch(e){Swal.showValidationMessage('Error de conexión');}
    }
  });
}

function showEditSession(sessionId){
  if(!currentPatientId)return;
  api(`${API}/therapists/patients/${currentPatientId}/clinical-sessions/${sessionId}`).then(r=>r.json()).then(d=>{
    if(!d.success||!d.session)return Swal.fire('Error','Sesión no encontrada','error');
    const s=d.session;
    const dateStr=new Date(s.session_date).toISOString().slice(0,16);
    Swal.fire({title:'✏️ Editar sesión',html:`
      <label class="soap-label">Fecha y hora</label>
      <input type="datetime-local" id="swalSessionDate" class="swal2-input" value="${dateStr}">
      <label class="soap-label">Duración (minutos)</label>
      <input type="number" id="swalSessionDuration" class="swal2-input" value="${s.duration_min||'50'}" min="1" max="300">
      <label class="soap-label">Tipo</label>
      <select id="swalSessionType" class="swal2-input">
        <option value="presencial" ${s.type==='presencial'?'selected':''}>🏥 Presencial</option>
        <option value="videollamada" ${s.type==='videollamada'?'selected':''}>📹 Videollamada</option>
        <option value="telefonica" ${s.type==='telefonica'?'selected':''}>📞 Telefónica</option>
        <option value="online_chat" ${s.type==='online_chat'?'selected':''}>💻 Chat online</option>
      </select>
      <label class="soap-label">Estado</label>
      <select id="swalSessionStatus" class="swal2-input">
        <option value="completed" ${s.status==='completed'?'selected':''}>✅ Completada</option>
        <option value="scheduled" ${s.status==='scheduled'?'selected':''}>📋 Programada</option>
        <option value="cancelled" ${s.status==='cancelled'?'selected':''}>❌ Cancelada</option>
      </select>
      <label class="soap-label">Resumen</label>
      <textarea id="swalSessionSummary" class="swal2-textarea" rows="3" maxlength="500">${s.notes_summary||''}</textarea>
    `,showCancelButton:true,confirmButtonText:'Actualizar',confirmButtonColor:'#6366f1',
      preConfirm:async()=>{
        const session_date=document.getElementById('swalSessionDate').value;
        const duration_min=parseInt(document.getElementById('swalSessionDuration').value)||null;
        const type=document.getElementById('swalSessionType').value;
        const status=document.getElementById('swalSessionStatus').value;
        const notes_summary=document.getElementById('swalSessionSummary').value.trim()||null;
        try{
          const r=await api(`${API}/therapists/patients/${currentPatientId}/clinical-sessions/${sessionId}`,{method:'PUT',body:JSON.stringify({session_date,duration_min,type,status,notes_summary})});
          const d=await r.json();
          if(!d.success)return Swal.showValidationMessage(d.error||'Error al actualizar');
          renderSessions();
          Swal.clickConfirm()
        }catch(e){Swal.showValidationMessage('Error de conexión');}
      }
    });
  });
}

async function deleteSession(sessionId){
  if(!currentPatientId)return;
  const result=await Swal.fire({title:'¿Eliminar sesión?',text:'Las notas vinculadas a esta sesión se conservarán (sin sesión asociada).',icon:'warning',showCancelButton:true,confirmButtonText:'Sí, eliminar',cancelButtonText:'Cancelar',confirmButtonColor:'#ef4444'});
  if(!result.isConfirmed)return;
  try{
    const r=await api(`${API}/therapists/patients/${currentPatientId}/clinical-sessions/${sessionId}`,{method:'DELETE'});
    const d=await r.json();
    if(d.success){renderSessions();Swal.fire({title:'🗑️ Sesión eliminada',icon:'success',timer:1500,showConfirmButton:false});}
    else Swal.fire('Error',d.error||'No se pudo eliminar','error');
  }catch(e){Swal.fire('Error','No se pudo eliminar','error');}
}

function showAddNote(){
  // Fetch sessions for the dropdown (async, loads from API)
  var sessionsPromise = currentPatientId
    ? api(`${API}/therapists/patients/${currentPatientId}/clinical-sessions`).then(r=>r.json()).then(d=>(d.sessions||[]).filter(s=>s.status==='completed').slice(0,20)).catch(()=>[])
    : Promise.resolve([]);

  Swal.fire({title:'Nueva nota clínica (SOAP)',html:`
    <label class="soap-label">S — Subjetivo</label>
    <textarea id="swalSubjective" class="swal2-textarea" placeholder="Lo que el paciente reporta: síntomas, quejas, sentimientos..." rows="2"></textarea>
    <label class="soap-label">O — Objetivo</label>
    <textarea id="swalObjective" class="swal2-textarea" placeholder="Datos observables: apariencia, conducta, check-ins recientes..." rows="2"></textarea>
    <label class="soap-label">A — Evaluación</label>
    <textarea id="swalAssessment" class="swal2-textarea" placeholder="Tu análisis clínico: diagnóstico, progreso, patrones..." rows="2"></textarea>
    <label class="soap-label">P — Plan</label>
    <textarea id="swalPlan" class="swal2-textarea" placeholder="Próximos pasos: tareas, objetivos, frecuencia de sesiones..." rows="2"></textarea>
    <label class="soap-label">Vincular a sesión (opcional)</label>
    <select id="swalSessionId" class="swal2-input">
      <option value="">— Sin sesión —</option>
    </select>
    <small style="color:var(--muted);display:block;margin-top:2px">Se muestran las últimas 20 sesiones completadas</small>
  `,showCancelButton:true,confirmButtonText:'Guardar nota',cancelButtonText:'Cancelar',width:650,
    didOpen:()=>{
      var sel=document.getElementById('swalSessionId');
      sessionsPromise.then(function(sessions){
        sel.innerHTML='<option value="">— Sin sesión —</option>' +
          sessions.map(function(s){
            var d=new Date(s.session_date).toLocaleDateString('es-ES',{day:'numeric',month:'short',year:'numeric'});
            var dur=s.duration_min?s.duration_min+' min':'';
            return '<option value="'+s.id+'">'+d+(dur?' · '+dur:'')+(s.notes_summary?' — '+s.notes_summary.substring(0,50):'')+'</option>';
          }).join('');
      });
    },
    preConfirm:async()=>{
    const subjective=document.getElementById('swalSubjective').value.trim();
    const objective=document.getElementById('swalObjective').value.trim();
    const assessment=document.getElementById('swalAssessment').value.trim();
    const plan=document.getElementById('swalPlan').value.trim();
    const sessionId=document.getElementById('swalSessionId').value||null;
    if(!subjective&&!objective&&!assessment&&!plan){Swal.showValidationMessage('Completa al menos un campo SOAP');return false;}
    try{
      await api(`${API}/therapists/patients/${currentPatientId}/clinical-notes`,{method:'POST',body:JSON.stringify({subjective:subjective||null,objective:objective||null,assessment:assessment||null,plan:plan||null,session_id:sessionId})});
      renderNotes();Swal.fire({title:'✅ Nota guardada',icon:'success',timer:1500,showConfirmButton:false});
    }catch(e){Swal.showValidationMessage('Error al guardar la nota');}
  }});
}

function editNote(noteId){
  const r=document.getElementById('note-'+noteId);if(!r)return;
  const fields=r.querySelectorAll('.soap-note-field');
  const getText=(el)=>el?el.textContent.replace(/^[SOAP]\s*[—–-]\s*\w+/,'').trim():'';
  const subjective=fields[0]?getText(fields[0]):'';
  const objective=fields[1]?getText(fields[1]):'';
  const assessment=fields[2]?getText(fields[2]):'';
  const plan=fields[3]?getText(fields[3]):'';
  Swal.fire({title:'Editar nota clínica',html:`
    <label class="soap-label">S — Subjetivo</label>
    <textarea id="swalSubjective" class="swal2-textarea" rows="2">${subjective.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
    <label class="soap-label">O — Objetivo</label>
    <textarea id="swalObjective" class="swal2-textarea" rows="2">${objective.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
    <label class="soap-label">A — Evaluación</label>
    <textarea id="swalAssessment" class="swal2-textarea" rows="2">${assessment.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
    <label class="soap-label">P — Plan</label>
    <textarea id="swalPlan" class="swal2-textarea" rows="2">${plan.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
  `,showCancelButton:true,confirmButtonText:'Guardar cambios',cancelButtonText:'Cancelar',width:650,preConfirm:async()=>{
    const s=document.getElementById('swalSubjective').value.trim();
    const o=document.getElementById('swalObjective').value.trim();
    const a=document.getElementById('swalAssessment').value.trim();
    const p=document.getElementById('swalPlan').value.trim();
    if(!s&&!o&&!a&&!p){Swal.showValidationMessage('Completa al menos un campo SOAP');return false;}
    try{
      await api(`${API}/therapists/patients/${currentPatientId}/clinical-notes/${noteId}`,{method:'PUT',body:JSON.stringify({subjective:s||null,objective:o||null,assessment:a||null,plan:p||null})});
      renderNotes();Swal.fire({title:'✅ Nota actualizada',icon:'success',timer:1500,showConfirmButton:false});
    }catch(e){Swal.showValidationMessage('Error al actualizar');}
  }});
}

async function deleteNote(noteId){
  const result=await Swal.fire({title:'¿Eliminar nota?',text:'La nota clínica se eliminará permanentemente.',icon:'warning',showCancelButton:true,confirmButtonText:'Sí, eliminar',cancelButtonText:'Cancelar',confirmButtonColor:'#ef4444'});
  if(!result.isConfirmed)return;
  try{
    const r=await api(`${API}/therapists/patients/${currentPatientId}/clinical-notes/${noteId}`,{method:'DELETE'});
    const d=await r.json();
    if(d.success){renderNotes();Swal.fire({title:'🗑️ Nota eliminada',icon:'success',timer:1500,showConfirmButton:false});}
    else Swal.fire('Error',d.error||'No se pudo eliminar','error');
  }catch(e){Swal.fire('Error','No se pudo eliminar','error');}
}

function showAddGoal(){
  Swal.fire({title:'Nuevo objetivo',html:`<input id="swalGoalTitle" class="swal2-input" placeholder="Título"><input id="swalGoalMetric" class="swal2-input" placeholder="Métrica (ej: días sin ansiedad)"><input id="swalGoalTarget" class="swal2-input" type="number" placeholder="Valor objetivo"><input id="swalGoalDays" class="swal2-input" type="number" placeholder="Duración (días)">`,showCancelButton:true,confirmButtonText:'Crear',preConfirm:async()=>{
    const title=document.getElementById('swalGoalTitle').value.trim();
    const metric=document.getElementById('swalGoalMetric').value.trim();
    const target=parseInt(document.getElementById('swalGoalTarget').value);
    const days=parseInt(document.getElementById('swalGoalDays').value);
    if(!title||!metric||!target||!days){Swal.showValidationMessage('Completa todos los campos');return false;}
    await api(`${API}/therapists/patients/${currentPatientId}/goals`,{method:'POST',body:JSON.stringify({title,metric,target_value:target,duration_days:days})});
    const r=await api(`${API}/therapists/patients/${currentPatientId}`);const d=await r.json();
    if(d.success){patientData=d.patient;renderGoals();}
  }});
}

// ==================== BIBLIOTECA TCC ====================
async function loadTemplates(){
  if(templates.length)return renderTemplates();
  try{
    const r=await api(`${API}/therapists/task-templates`);const d=await r.json();
    if(d.success){templates=d.templates;templateCategories=d.categories;renderTemplates();renderCategoryFilters();}
  }catch(e){document.getElementById('libraryGrid').innerHTML='<p class="empty-msg error">Error al cargar la biblioteca</p>';}
}

function renderCategoryFilters(){
  const container=document.getElementById('categoryFilter');
  container.innerHTML='<div class="category-chip'+(!activeCategory?' active':'')+'" data-category="">📋 Todas</div>'+
    templateCategories.map(c=>`<div class="category-chip${activeCategory===c?' active':''}" data-category="${c.replace(/'/g,"\\'")}">${c}</div>`).join('');
}

function filterCategory(cat){activeCategory=cat;renderTemplates();renderCategoryFilters();}

function renderTemplates(){
  const search=document.getElementById('librarySearch')?.value?.toLowerCase()||'';
  let filtered=templates;
  if(activeCategory)filtered=filtered.filter(t=>t.category===activeCategory);
  if(search)filtered=filtered.filter(t=>t.title.toLowerCase().includes(search)||t.instructions.toLowerCase().includes(search)||t.category.toLowerCase().includes(search));
  const grid=document.getElementById('libraryGrid');
  if(!filtered.length){grid.innerHTML='<p class="empty-msg">No se encontraron tareas</p>';return;}        grid.innerHTML=filtered.map((t,i)=>{
    const isCustom=!!t.therapist_id;
    const cardClass=isCustom?'template-card custom-template':'template-card system-template';
    const customBadge=isCustom?'<span class="custom-badge">⭐ Tuya</span>':'';
    // Badge clínico: muestra cuando el template NO es 'classic' para que
    // el terapeuta vea de un vistazo qué templates daran al paciente un
    // formulario interactivo (TR/BA/GE con respuestas encriptadas).
    const kindBadgeText = templateKindBadge(t);
    const kindBadge = kindBadgeText ? '<span class="clinical-kind-badge">' + sanitizeHTML(kindBadgeText) + '</span>' : '';
    const hasWidget = window.InteractiveWidgets && window.InteractiveWidgets.isWidgetTemplate(t.title, t.category);
    const previewBtn = hasWidget
      ? `<button class="btn btn-p btn-sm btn-preview-widget" data-template-id="${t.id}">👁️ Previsualizar</button>`
      : '';
    const actionButtons=isCustom
      ?`<button class="btn btn-p btn-sm btn-toggle-template" data-template-id="${t.id}">📖 Ver</button>
         <button class="btn btn-w btn-sm btn-edit-template" data-template-id="${t.id}">✏️ Editar</button>
         <button class="btn btn-d btn-sm btn-delete-template" data-template-id="${t.id}">🗑️ Eliminar</button>
         ${previewBtn}
         <button class="btn btn-s btn-sm btn-assign-template" data-template-id="${t.id}">📋 Asignar</button>`
      :`<button class="btn btn-p btn-sm btn-toggle-template" data-template-id="${t.id}">📖 Ver instrucciones</button>
         ${previewBtn}
         <button class="btn btn-s btn-sm btn-assign-template" data-template-id="${t.id}">📋 Asignar a paciente</button>`;
    return`<div class="${cardClass}" id="tcard-${t.id}" style="animation-delay:${i*.05}s">
      <div class="template-category">${sanitizeHTML(t.category)}${customBadge}${kindBadge}</div>
      <div class="template-title">${sanitizeHTML(t.title)}</div>
      <div class="template-meta">
        <span class="template-difficulty diff-${t.difficulty}">${t.difficulty==='baja'?'🟢 Fácil':t.difficulty==='media'?'🟡 Media':'🔴 Avanzada'}</span>
        <span class="template-duration">⏱ ${t.duration_min} min</span>
      </div>
      <div class="template-instructions">${t.instructions.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>')}</div>
      <div class="template-actions">${actionButtons}</div>
    </div>`;
  }).join('');
}

function toggleTemplate(id){
  const card=document.getElementById('tcard-'+id);
  card.classList.toggle('expanded');
  const btn=card.querySelector('.btn-p');
  btn.textContent=card.classList.contains('expanded')?'🔼 Ocultar':'📖 Ver instrucciones';
}

// ═══════════════════════════════════════════════════════════════
// PREVISUALIZACIÓN DE WIDGETS INTERACTIVOS
// ═══════════════════════════════════════════════════════════════
// Renderiza el widget en un modal de preview con datos mock para que
// el terapeuta pueda ver cómo se verá para el paciente antes de asignarlo.
function previewWidget(templateId){
  var template = templates.find(function(t){ return t.id === templateId; });
  if (!template) return;
  if (!window.InteractiveWidgets || !window.InteractiveWidgets.isWidgetTemplate(template.title, template.category)) return;

  // Crear overlay del modal
  var overlay = document.createElement('div');
  overlay.className = 'widget-preview-overlay';
  overlay.id = 'widgetPreviewOverlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Previsualización: ' + template.title);

  overlay.innerHTML = '<div class="widget-preview-modal">'
    + '<div class="widget-preview-header">'
    + '<div class="widget-preview-title">👁️ ' + sanitizeHTML(template.title) + '</div>'
    + '<div class="widget-preview-subtitle">Vista previa como la verá el paciente</div>'
    + '<button class="widget-preview-close" aria-label="Cerrar previsualización" title="Cerrar">✕</button>'
    + '</div>'
    + '<div class="widget-preview-body" id="widgetPreviewBody">'
    + '<div class="widget-preview-loading"><div class="skel-row"><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text short"></div></div><div class="skel-row"><div class="skeleton skeleton-card"></div></div></div>'
    + '</div>'
    + '<div class="widget-preview-footer">'
    + '<span class="widget-preview-hint">💡 Esta previsualización usa datos de ejemplo. Las respuestas no se guardan.</span>'
    + '<button class="btn btn-s btn-sm" id="btnClosePreview">Cerrar previsualización</button>'
    + '</div>'
    + '</div>';

  document.body.appendChild(overlay);

  // Foco en el botón de cierre para navegación por teclado
  var closeBtn = overlay.querySelector('.widget-preview-close');
  var prevFocused = document.activeElement;
  if (closeBtn) closeBtn.focus();

  // Cerrar con botón, overlay click o Escape
  function closePreview(){
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener('keydown', onKeyDown);
    // Devolver el foco al elemento que abrió el modal
    if (prevFocused && typeof prevFocused.focus === 'function') {
      try { prevFocused.focus(); } catch (e) {}
    }
  }
  function onKeyDown(e){ if (e.key === 'Escape') closePreview(); }
  overlay.addEventListener('click', function(e){
    if (e.target === overlay) closePreview();
  });
  overlay.querySelector('.widget-preview-close').addEventListener('click', closePreview);
  overlay.querySelector('#btnClosePreview').addEventListener('click', closePreview);
  document.addEventListener('keydown', onKeyDown);

  // Crear un assignment falso con datos mock para el widget
  var mockAssignment = {
    id: 'preview_' + templateId,
    title: template.title,
    instructions: template.instructions || '',
    exercise_kind: template.exercise_kind || 'classic',
    status: 'assigned'
  };

  // Pequeño delay para que se vea el skeleton loader antes de renderizar
  setTimeout(function(){
    var body = document.getElementById('widgetPreviewBody');
    if (!body) return;
    try {
      // Limpiar cualquier estado previo del widget en localStorage
      window.InteractiveWidgets.clearWidgetState('preview_' + templateId);
      // Renderizar el widget
      window.InteractiveWidgets.render(body, mockAssignment, { preview: true });
    } catch (e) {
      console.error('[previewWidget] Error al renderizar:', e);
      body.innerHTML = '<p class="empty-msg error">Error al cargar la previsualización. Inténtalo de nuevo.</p>';
    }
  }, 300);
}

async function assignTemplateToPatient(templateId){
  const template=templates.find(t=>t.id===templateId);if(!template)return;

  let patients=[];
  let fetchError=null;
  try{
    patients=await PatientsCache.getPatients();
  }catch(e){
    fetchError=e;
    console.error('[assignTemplateToPatient] fetch /therapists/patients falló:',e);
  }

  if(fetchError){
    const retry=await Swal.fire({
      title:'Error al cargar pacientes',
      text:'No pudimos obtener tu lista de pacientes. Comprueba tu conexión e inténtalo de nuevo.',
      icon:'error',
      showCancelButton:true,
      confirmButtonText:'Reintentar',
      cancelButtonText:'Cancelar'
    });
    if(!retry.isConfirmed)return;
    PatientsCache.invalidate();
    return assignTemplateToPatient(templateId);
  }

  if(!patients.length){
    return Swal.fire({
      title:'Sin pacientes',
      text:'Aún no tienes pacientes conectados. Ve a "🔑 Código de acceso" para crear uno.',
      icon:'info'
    });
  }

  const options={};
  patients.forEach(p=>{options[p.id]=p.name||'Anónimo (ID:'+p.id.slice(0,8)+')';});
  const {value:pId}=await Swal.fire({title:'Asignar a paciente',text:`Tarea: ${template.title}`,input:'select',inputOptions:options,inputPlaceholder:'Selecciona un paciente...',showCancelButton:true,confirmButtonText:'Asignar',cancelButtonText:'Cancelar'});
  if(!pId)return;
  try{
    // Propagamos exercise_kind + discriminants (mode/phobia) desde la plantilla
    // a la asignación. Para 'classic' eso es ruido pero cumple contrato.
    // El backend (POST /patients/:id/assignments) re-resuelve el schema
    // efectivo con getSchema(kind, dbSchema, {mode, phobia}) y lo congela
    // en assignments.exercise_schema. Asi, si el terapeuta edita la plantilla
    // después, el paciente sigue viendo el schema de su tarea original.
    const exerciseKind = template.exercise_kind || 'classic';
    const mode = (template.exercise_schema && template.exercise_schema.mode) || null;
    const phobia = (template.exercise_schema && template.exercise_schema.phobia) || null;
    const body = {
      type: template.category,
      title: template.title,
      instructions: template.instructions,
      exercise_kind: exerciseKind,
      mode: mode,
      phobia: phobia,
    };
    await api(`${API}/therapists/patients/${pId}/assignments`,{method:'POST',body:JSON.stringify(body)});
    const isClinical = window.ExerciseForms && typeof window.ExerciseForms.isClinicalKind === 'function'
      ? window.ExerciseForms.isClinicalKind(exerciseKind)
      : (exerciseKind && exerciseKind !== 'classic');
    if (isClinical) {
      // guidance puede llegar null/empty desde el backend. Cortamos la primera
      // oración defensivamente sin asumir separador; si por BD corrupto
      // llegara solo "." o vacio, mostramos el fallback y no un string roto.
      const rawGuidance = (template.exercise_schema && template.exercise_schema.guidance) || '';
      const firstSentence = rawGuidance.split('.')[0] || '';
      const guidanceText = firstSentence ? `${firstSentence.trim()}.` : 'El paciente verá un formulario interactivo con el schema clínico.';
      Swal.fire({title:'✅ Tarea clínica asignada',text:`"${template.title}". ${sanitizeHTML(guidanceText)}`,icon:'success',timer:2400,showConfirmButton:false});
    } else {
      Swal.fire({title:'✅ Tarea asignada',text:`"${template.title}" asignada al paciente`,icon:'success',timer:2000,showConfirmButton:false});
    }
  }catch(e){
    console.error('[assignTemplateToPatient] asignación falló:',e);
    Swal.fire('Error','No se pudo asignar la tarea','error');
  }
}

// ==================== PLANTILLAS PERSONALIZADAS (CRUD) ====================
// Map: option value en el select de "Tipo de ejercicio" → { kind, mode?, phobia? }
// Se usa tambien para mostrar un nombre legible en el badge de la tarjeta.
// Mantener sincronizado con utils/exerciseSchemas.js KINDS + discriminantes.
const TEMPLATE_KIND_OPTIONS = [
  { value: 'classic',                  label: '📝 Texto plano (instrucciones simples, el paciente solo marca completada)',           kind: 'classic',                  badge: '' },
  { value: 'thought_record',           label: '🧠 Thought Record (Beck) — el paciente rellena 8 pasos con emociones y distorsiones', kind: 'thought_record',           badge: '🧠 Beck' },
  { value: 'ba_diary',                 label: '🎯 Activación Conductual — Diario (Lewinsohn): placer/logro por actividad',            kind: 'behavioral_activation',    mode: 'diary',    badge: '🎯 BA diario' },
  { value: 'ba_schedule',              label: '🎯 Activación Conductual — Plan semanal (Jacobson): programar y reflexionar',         kind: 'behavioral_activation',    mode: 'schedule', badge: '🎯 BA semanal' },
  { value: 'ge_agoraphobia',           label: '🚶 Exposición gradual — Agorafobia (Marks)',                                            kind: 'graded_exposure',          phobia: 'agoraphobia',    badge: '🚶 GE agorafobia' },
  { value: 'ge_social_anxiety',        label: '🚶 Exposición gradual — Ansiedad social (McNally)',                                      kind: 'graded_exposure',          phobia: 'social_anxiety', badge: '🚶 GE ansiedad social' },
  { value: 'ge_claustrophobia',        label: '🚶 Exposición gradual — Claustrofobia (Marks)',                                          kind: 'graded_exposure',          phobia: 'claustrophobia', badge: '🚶 GE claustrofobia' },
];
function getTemplateKindOption(value) {
  return TEMPLATE_KIND_OPTIONS.find(o => o.value === value) || TEMPLATE_KIND_OPTIONS[0];
}
function templateKindBadge(t) {
  // Para templates del sistema (therapist_id IS NULL) el backend ya conoce
  // su kind y schema. Para templates custom del terapeuta, igual.
  // Devuelve un string corto para el badge o '' si classic.
  // Idempotente a null vs undefined: la BD puede serializar mode/phobia como
  // null cuando no aplica, y los matches estructurales requieren comparación
  // tolerante para que TEMPLATE_KIND_OPTIONS encuentre la variante exacta.
  if (!t || !t.exercise_kind || t.exercise_kind === 'classic') return '';
  const sch = t.exercise_schema || {};
  const schemaMode = sch.mode == null ? undefined : sch.mode;
  const schemaPhobia = sch.phobia == null ? undefined : sch.phobia;
  const opt = TEMPLATE_KIND_OPTIONS.find(o =>
    o.kind === t.exercise_kind &&
    (o.mode === undefined ? schemaMode === undefined : o.mode === schemaMode) &&
    (o.phobia === undefined ? schemaPhobia === undefined : o.phobia === schemaPhobia)
  );
  return (opt && opt.badge) || t.exercise_kind;
}

function showCreateTemplate(){
  // Render del <select> con las 7 opciones. Usamos innerHTML controlado
  // (sin values de usuario) para evitar XSS; los labels son hardcodeados.
  const kindOptionsHtml = TEMPLATE_KIND_OPTIONS.map(o =>
    '<option value="' + o.value + '">' + sanitizeHTML(o.label) + '</option>'
  ).join('');
  Swal.fire({title:'Crear nueva plantilla',html:`
    <label class="soap-label">Categoría</label>
    <input id="swalTmplCat" class="swal2-input" placeholder="Ej: 🧘 Respiración guiada">
    <label class="soap-label">Título</label>
    <input id="swalTmplTitle" class="swal2-input" placeholder="Título de la tarea">
    <label class="soap-label">Instrucciones</label>
    <textarea id="swalTmplInstructions" class="swal2-textarea" placeholder="Instrucciones detalladas..." rows="4"></textarea>
    <label class="soap-label">Tipo de ejercicio</label>
    <select id="swalTmplKind" class="swal2-input">${kindOptionsHtml}</select>
    <p class="swal-kind-hint" id="swalKindHint" style="margin:6px 0 10px;font-size:12px;color:var(--muted);text-align:left">📝 Texto plano: el paciente solo recibe instrucciones y marca “completada”.</p>
    <label class="soap-label">Dificultad</label>
    <select id="swalTmplDifficulty" class="swal2-input"><option value="baja">🟢 Fácil</option><option value="media" selected>🟡 Media</option><option value="alta">🔴 Avanzada</option></select>
    <label class="soap-label">Duración (minutos)</label>
    <input id="swalTmplDuration" class="swal2-input" type="number" value="30" min="5" max="180">
  `,showCancelButton:true,confirmButtonText:'Crear plantilla',cancelButtonText:'Cancelar',width:600,didOpen:()=>{
    // didOpen corre cuando el DOM de SweetAlert2 ya está listo: enganchamos
    // el change handler del select de kind para refrescar el hint contextual.
    // Sin esto el usuario no sabe por qué “Thought Record” vs “BA Diario” son
    // diferentes (el schema que recibirá el paciente).
    const sel = document.getElementById('swalTmplKind');
    const hint = document.getElementById('swalKindHint');
    function refreshHint() {
      const opt = getTemplateKindOption(sel.value);
      const hints = {
        classic: '📝 Texto plano: el paciente solo recibe instrucciones y marca “completada”.',
        thought_record: '🧠 Thought Record (Beck): el paciente rellena situación → pensamiento automático → emoción → distorsión → evidencia → reencuadre. 8 pasos con respuestas encriptadas (PHI).',
        ba_diary: '🎯 BA Diario (Lewinsohn): cada actividad lleva placer (P) y logro (L) 0–10. Sugerencias integradas.',
        ba_schedule: '🎯 BA Plan semanal (Jacobson): programa la semana domingo-noche, con obstáculos y plan B.',
        ge_agoraphobia: '🚶 Exposición gradual de 8 pasos (Marks 1978). SUDS 0–100 registrado en cada sesión.',
        ge_social_anxiety: '🚶 Exposición gradual de 7 pasos (McNally 2007). Quita comportamientos de seguridad.',
        ge_claustrophobia: '🚶 Exposición gradual de 7 pasos (Marks). Habitúate hasta que SUDS baje.',
      };
      if (hint) hint.textContent = hints[sel.value] || hints.classic;
    }
    if (sel) sel.addEventListener('change', refreshHint);
    refreshHint();
  },preConfirm:async()=>{
    const category=document.getElementById('swalTmplCat').value.trim();
    const title=document.getElementById('swalTmplTitle').value.trim();
    const instructions=document.getElementById('swalTmplInstructions').value.trim();
    const difficulty=document.getElementById('swalTmplDifficulty').value;
    const duration=parseInt(document.getElementById('swalTmplDuration').value)||30;
    if(!category||!title||!instructions){Swal.showValidationMessage('Categoría, título e instrucciones son obligatorios');return false;}
    const opt = getTemplateKindOption(document.getElementById('swalTmplKind').value);
    // Plantillas clínicas (TR/BA/GE): cerramos este modal básico y abrimos
    // el editor clínico de 3 secciones (Básico + Tipo + Campos). El paciente
    // verá un formulario interactivo, no solo instrucciones en texto plano.
    if (opt.kind !== 'classic') {
      Swal.close();
      await openClinicalEditor({
        mode: 'create',
        prefill: { category, title, instructions, difficulty, duration_min: duration, kind: opt.kind, mode: opt.mode || null, phobia: opt.phobia || null }
      });
      // No confirmamos el modal actual; el editor emite su propio toast de éxito.
      return false;
    }
    try{
      // El backend resuelve el schema efectivo desde utils/exerciseSchemas.js
      // a partir de (kind, mode, phobia). Para 'classic' persiste schema=NULL.
      // El cliente NO necesita mandar `exercise_schema` adivinando estructura;
      // basta con kind + discriminant.
      const r=await api(`${API}/therapists/task-templates`,{method:'POST',body:JSON.stringify({
        category,title,instructions,difficulty,duration_min:duration,
        exercise_kind: opt.kind,
        mode: opt.mode || null,
        phobia: opt.phobia || null,
      })});
      const d=await r.json();
      if(d.success){templates.unshift(d.template);renderTemplates();renderCategoryFilters();Swal.fire({title:'✅ Plantilla creada',text:'Plantilla clásica guardada',icon:'success',timer:1800,showConfirmButton:false});}
      else Swal.showValidationMessage(d.error||'Error al crear');
    }catch(e){Swal.showValidationMessage('Error de conexión');}
  }});
}

// ═══════════════════════════════════════════════════════════════════════
// EDITOR CLÍNICO — refinar campos del schema de TR/BA/GE desde el panel
// ═══════════════════════════════════════════════════════════════════════
// Por qué existe:
//   Hasta este commit el terapeuta solo podía crear plantillas clínicas
//   desde el form básico (elegir kind → backend resolvía el schema
//   estático) y luego editarlas con un formulario de texto plano.
//   Para refinar los campos (ej: añadir “Impacto somático” al Thought
//   Record, cambiar las opciones del select, quitar un SUDS field) no
//   había UI. Esta función abre un modal de 3 secciones: Básico, Tipo,
//   Campos. Cada field es una .field-editor-row con type/key bloqueados
//   (renombrarlos rompe asignaciones previas) y controles editables
//   específicos por tipo (label, placeholder, required, sensitive,
//   min/max para number/scale, options[] para select/multi_select).
// Contrato:
//   openClinicalEditor({mode:'create'|'edit', template?, prefill?})
//     → resuelve a {saved:true,template} | null
// ═══════════════════════════════════════════════════════════════════════

// Defaults visuales por cada uno de los 9 tipos. Sirven para "Añadir field"
// y para que el server entienda qué shape espera por tipo. El server valida
// uno a uno y rechaza tipos fuera de FIELD_TYPES (utils/exerciseSchemas.js).
const EDITOR_FIELD_TYPE_DEFAULTS = {
  text:         { label:'Nuevo texto',               placeholder:'',                maxlength:500 },
  textarea:     { label:'Nueva área de texto',       placeholder:'',                maxlength:2000 },
  number:       { label:'Nuevo número',              min:0, max:100 },
  scale:        { label:'Nueva escala (0–10)',       min:0, max:10 },
  select:       { label:'Nueva selección',           options:[{key:'value', label:'Opción'}] },
  multi_select: { label:'Nueva multi-selección',     options:[{key:'opt1', label:'Opción 1'}] },
  boolean:      { label:'Nuevo sí/no' },
  date:         { label:'Nueva fecha' },
  repeater:     { label:'Nueva lista',               item_sensitive:false, fields:[{key:'entry', type:'text', label:'Entrada', sensitive:false}] },
};

// Builder de un row completo. mod = {fields:[...]}, idx = posición. Devuelve
// HTML listo para .innerHTML. NO incluye bindings (ver bindEditorFieldRows).
function renderEditorFieldRowHtml(field, mod, idx) {
  const isSystem = !!(field && (field.source === 'catalog' || field.source === 'hierarchy'));
  const type = field.type || 'text';
  const safeLabel = sanitizeHTML(field.label || '');
  const fieldKey = sanitizeHTML(field.key || '');
  let bodyHtml = '';
  // Cada tipo se renderiza con sus controles nativos. Los campos disabled son
  // los que el server no aceptaría cambios (catalog/hierarchy) o los campos
  // bloqueados por contrato (key, type).
  if (type === 'text' || type === 'textarea') {
    bodyHtml += '<div><label>Etiqueta</label><input data-bind="label" type="text" value="' + safeLabel + '"></div>'
      + '<div><label>Placeholder</label><input data-bind="placeholder" type="text" value="' + sanitizeHTML(field.placeholder || '') + '"></div>'
      + '<div class="checkbox-row">'
      + '<label><input data-bind="required" type="checkbox"' + (field.required ? ' checked' : '') + '> Obligatorio</label>'
      + '<label><input data-bind="sensitive" type="checkbox"' + (field.sensitive ? ' checked' : '') + '> <span title="Si está marcado, el contenido del paciente viaja encriptado en exercise_sessions.encrypted_blob">Contenido sensible (PHI)</span></label>'
      + '</div>';
  } else if (type === 'number' || type === 'scale') {
    bodyHtml += '<div><label>Etiqueta</label><input data-bind="label" type="text" value="' + safeLabel + '"></div><div></div>'
      + '<div><label>Mínimo</label><input data-bind="min" type="number" value="' + (field.min ?? 0) + '"></div>'
      + '<div><label>Máximo</label><input data-bind="max" type="number" value="' + (field.max ?? 10) + '"></div>'
      + '<div class="checkbox-row">'
      + '<label><input data-bind="required" type="checkbox"' + (field.required ? ' checked' : '') + '> Obligatorio</label>'
      + '<label><input data-bind="sensitive" type="checkbox"' + (field.sensitive ? ' checked' : '') + '> Contenido sensible</label>'
      + '</div>';
  } else if (type === 'select' || type === 'multi_select') {
    const opts = Array.isArray(field.options) ? field.options : [];
    let optsInner;
    if (isSystem) {
      // Catalog/hierarchy: el server inyecta las opciones. Mostramos un aviso
      // y no permitimos editar porque cualquier manipulación romperá el form
      // del paciente (los options[] no van en PUT del editor clínico).
      optsInner = '<div class="system-only-notice">🔒 Sistema: las opciones las resuelve el servidor desde el catálogo de distorsiones (TR) o la jerarquía (GE). No son editables.</div>';
    } else {
      optsInner = opts.map((o, oi) => {
        const optKey = typeof o === 'string' ? o : (o && o.key);
        const optLabel = typeof o === 'string' ? o : (o && o.label);
        return '<div class="option-row" data-opt-row="' + oi + '">'
          + '<input data-opt-key="' + oi + '" type="text" value="' + sanitizeHTML(optKey) + '" placeholder="key">'
          + '<input data-opt-label="' + oi + '" type="text" value="' + sanitizeHTML(optLabel) + '" placeholder="etiqueta">'
          + '<button class="btn-mini btn-mini-danger" data-remove-opt="' + oi + '" type="button" title="Eliminar opción">✕</button>'
          + '</div>';
      }).join('') + '<div style="display:flex;gap:6px;margin-top:6px"><button class="btn-mini" data-add-opt type="button">+ Añadir opción</button></div>';
    }
    bodyHtml = '<div><label>Etiqueta</label><input data-bind="label" type="text" value="' + safeLabel + '"></div><div></div>'
      + '<div class="full-row"><label>Opciones</label><div class="options-list-editor">' + optsInner + '</div></div>'
      + '<div class="checkbox-row"><label><input data-bind="required" type="checkbox"' + (field.required ? ' checked' : '') + '> Obligatorio</label></div>';
  } else if (type === 'boolean' || type === 'date') {
    bodyHtml += '<div><label>Etiqueta</label><input data-bind="label" type="text" value="' + safeLabel + '"></div><div></div>'
      + '<div class="checkbox-row"><label><input data-bind="required" type="checkbox"' + (field.required ? ' checked' : '') + '> Obligatorio</label></div>';
  } else if (type === 'repeater') {
    // v1: el repeater es "lista de sub-entradas". Las sub-entradas NO son
    // editables desde este editor (sería recursion 2 niveles). Se muestra
    // un resumen de las sub-fields pero solo meta (label/required/item_sensitive).
    bodyHtml = '<div><label>Etiqueta</label><input data-bind="label" type="text" value="' + safeLabel + '"></div><div></div>'
      + '<div class="full-row editor-help-text">🔁 Repeater: lista dinámica de entradas. Las sub-entradas (ej: emotions con name/intensity/body_location) no son editables en v1 — están fijadas por el schema del sistema.</div>'
      + '<div class="checkbox-row">'
      + '<label><input data-bind="required" type="checkbox"' + (field.required ? ' checked' : '') + '> Obligatorio</label>'
      + '<label><input data-bind="item_sensitive" type="checkbox"' + (field.item_sensitive ? ' checked' : '') + '> Items sensibles (PHI)</label>'
      + '</div>';
  }
  // system-only (catalog/hierarchy) rows are NOT re-ordenables: mover un
  // row del sistema dentro del medio del array deja al paciente con un
  // form raro donde un field opcional aparece entre campos requeridos.
  const upDisabled = (isSystem || idx === 0) ? ' disabled' : '';
  const downDisabled = (isSystem || idx === mod.fields.length - 1) ? ' disabled' : '';
  const remAttr = isSystem ? ' title="Los fields del sistema no se pueden eliminar" disabled' : ' title="Eliminar field"';
  return '<div class="field-editor-row' + (isSystem ? ' system-only' : '') + '" data-field-idx="' + idx + '">'
    + '<div class="field-editor-header">'
    + '<span class="type-pill locked" title="El tipo se fija tras creación — renombrarlo rompe asignaciones previas">' + sanitizeHTML(type) + '<span class="lock-icon">🔒</span></span>'
    + '<span class="field-editor-key">' + fieldKey + '</span>'
    + (isSystem ? '<span class="system-only-badge">Sistema</span>' : '')
    + '<div class="field-editor-header-actions">'
    + '<button class="btn-mini" data-move-up="' + idx + '" type="button"' + upDisabled + ' title="Mover arriba">↑</button>'
    + '<button class="btn-mini" data-move-down="' + idx + '" type="button"' + downDisabled + ' title="Mover abajo">↓</button>'
    + '<button class="btn-mini btn-mini-danger" data-remove-field="' + idx + '" type="button"' + remAttr + '>✕</button>'
    + '</div></div>'
    + '<div class="field-editor-body">' + bodyHtml + '</div></div>';
}

// Re-renderiza la lista completa de fields + rebindea handlers. Llamado tras
// add/remove/move para que el DOM refleje el cambio de orden o longitud.
function refreshEditorFieldsSection(rootEl, mod) {
  const listEl = rootEl.querySelector('#editorFieldsList');
  if (!listEl) return;
  listEl.innerHTML = mod.fields.map((f, i) => renderEditorFieldRowHtml(f, mod, i)).join('');
  bindEditorFieldRows(rootEl, mod);
  const summaryEl = rootEl.querySelector('#editorFieldsSummary');
  if (summaryEl) summaryEl.textContent = mod.fields.length + ' campo' + (mod.fields.length === 1 ? '' : 's') + ' en total';
}

// Bindea los inputs/buttons de cada .field-editor-row para que editen
// mod.fields[idx] en vivo. Estrategia: en cada cambio actualizamos la fila
// del array mutante; el render explícito se hace con refreshEditorFieldsSection.
function bindEditorFieldRows(rootEl, mod) {
  rootEl.querySelectorAll('.field-editor-row').forEach(rowEl => {
    const idx = parseInt(rowEl.dataset.fieldIdx, 10);
    const field = mod.fields[idx];
    if (!field) return;
    rowEl.querySelectorAll('[data-bind]').forEach(input => {
      const key = input.dataset.bind;
      // Para checkbox: actualiza al primer 'change' para evitar detonar guard
      // masivo en cada render. Para text/number: actualiza en 'input' live.
      const evt = input.type === 'checkbox' ? 'change' : 'input';
      input.addEventListener(evt, () => {
        if (input.type === 'checkbox') field[key] = input.checked;
        else if (input.type === 'number') {
          const n = parseFloat(input.value);
          field[key] = Number.isFinite(n) ? n : undefined;
        } else field[key] = input.value;
      });
    });
    const up = rowEl.querySelector('[data-move-up]');
    if (up) up.addEventListener('click', () => { if (idx > 0) { const t = mod.fields[idx - 1]; mod.fields[idx - 1] = mod.fields[idx]; mod.fields[idx] = t; refreshEditorFieldsSection(rootEl, mod); } });
    const down = rowEl.querySelector('[data-move-down]');
    if (down) down.addEventListener('click', () => { if (idx < mod.fields.length - 1) { const t = mod.fields[idx + 1]; mod.fields[idx + 1] = mod.fields[idx]; mod.fields[idx] = t; refreshEditorFieldsSection(rootEl, mod); } });
    const rem = rowEl.querySelector('[data-remove-field]');
    if (rem) rem.addEventListener('click', () => {
      if (field.source === 'catalog' || field.source === 'hierarchy') return;
      mod.fields.splice(idx, 1);
      refreshEditorFieldsSection(rootEl, mod);
    });
    // options[] editor (solo select/multi_select SIN source=catalog/hierarchy)
    if ((field.type === 'select' || field.type === 'multi_select') && !field.source) {
      rowEl.querySelectorAll('.option-row[data-opt-row]').forEach(optEl => {
        const oi = parseInt(optEl.dataset.optRow, 10);
        const keyIn = optEl.querySelector('[data-opt-key]');
        const labelIn = optEl.querySelector('[data-opt-label]');
        const updOpt = () => {
          field.options[oi] = { key: (keyIn.value || '').trim(), label: (labelIn.value || '').trim() };
        };
        if (keyIn) keyIn.addEventListener('input', updOpt);
        if (labelIn) labelIn.addEventListener('input', updOpt);
        const remOpt = optEl.querySelector('[data-remove-opt]');
        if (remOpt) remOpt.addEventListener('click', () => { field.options.splice(oi, 1); refreshEditorFieldsSection(rootEl, mod); });
      });
      const addOpt = rowEl.querySelector('[data-add-opt]');
      if (addOpt) addOpt.addEventListener('click', () => {
        field.options = field.options || [];
        const nextIdx = field.options.length + 1;
        field.options.push({ key: 'opt' + nextIdx, label: 'Opción ' + nextIdx });
        refreshEditorFieldsSection(rootEl, mod);
      });
    }
  });
}

// Helper: GET /therapists/exercise-schemas?kind&mode&phobia → schema efectivo
// (server es source-of-truth de la forma canonical del schema). Devuelve null
// si falla; el editor mostrará un toast y abortará.
async function fetchEditorSchemaDefaults(kind, mode, phobia) {
  const params = new URLSearchParams({ kind });
  if (mode) params.set('mode', mode);
  if (phobia) params.set('phobia', phobia);
  try {
    const r = await api(API + '/therapists/exercise-schemas?' + params.toString());
    const d = await r.json();
    if (!d.success) return null;
    return d.schema;
  } catch (e) {
    console.error('[fetchEditorSchemaDefaults]', e);
    return null;
  }
}

// Helper: dada una fila de field del cliente, devuelve el kind+mode+phobia
// compuesto como value del select (TEMPLATE_KIND_OPTIONS usa esto).
function editorKindValueFor(kind, mode, phobia) {
  const normMode = mode || null;
  const normPhobia = phobia || null;
  const opt = TEMPLATE_KIND_OPTIONS.find(o => o.kind === kind && (o.mode || null) === normMode && (o.phobia || null) === normPhobia);
  return opt ? opt.value : 'classic';
}

async function openClinicalEditor(opts) {
  // opts = { mode:'create'|'edit', template?, prefill? }
  // Mode 'create': parte desde los defaults del sistema (o lo que diga prefill).
  // Mode 'edit': parte desde template.exercise_schema.fields si está, si no desde defaults.
  const mode = opts.mode || 'create';
  const t = (mode === 'edit') ? (opts.template || null) : null;
  const prefill = opts.prefill || {};
  const isEdit = mode === 'edit' && !!t;

  // Snapshot mutable que se actualizará con los inputs del modal. El servidor
  // validará al final; mientras tanto conservamos cualquier cambio del
  // terapeuta. Si la validación falla, le dejamos ver los errores en banner.
  const initialKind = isEdit ? t.exercise_kind : (prefill.kind || 'thought_record');
  const initialMode = isEdit ? ((t.exercise_schema && t.exercise_schema.mode) || null) : (prefill.mode || null);
  const initialPhobia = isEdit ? ((t.exercise_schema && t.exercise_schema.phobia) || null) : (prefill.phobia || null);
  const mod = {
    kind: initialKind,
    mode: initialMode,
    phobia: initialPhobia,
    fields: isEdit && t.exercise_schema && Array.isArray(t.exercise_schema.fields) ? JSON.parse(JSON.stringify(t.exercise_schema.fields)) : [],
    guidance: isEdit && t.exercise_schema ? (t.exercise_schema.guidance || '') : '',
    basic: {
      category: isEdit ? t.category : (prefill.category || ''),
      title: isEdit ? t.title : (prefill.title || ''),
      instructions: isEdit ? t.instructions : (prefill.instructions || ''),
      difficulty: isEdit ? t.difficulty : (prefill.difficulty || 'media'),
      duration_min: isEdit ? t.duration_min : (prefill.duration_min || 30),
    },
  };

  // Si editamos y no tenemos fields[] en plantilla (caso raro: kind clínico
  // sin schema previo), pedimos al server los defaults en lugar de renderizar
  // una sección vacía.
  if (mod.fields.length === 0) {
    const def = await fetchEditorSchemaDefaults(mod.kind, mod.mode, mod.phobia);
    if (def) {
      mod.fields = (def.fields || []).map(f => JSON.parse(JSON.stringify(f)));
      if (!mod.guidance) mod.guidance = def.guidance || '';
    } else if (mode === 'create') {
      Swal.fire('Error', 'No pude cargar los campos por defecto del sistema. Revisa tu conexión e inténtalo de nuevo.', 'error');
      return null;
    }
  }

  const kindOptionsHtml = TEMPLATE_KIND_OPTIONS.map(o => '<option value="' + o.value + '">' + sanitizeHTML(o.label) + '</option>').join('');
  const initialKindValue = editorKindValueFor(mod.kind, mod.mode, mod.phobia);

  const html = '<div id="editorErrorBanner" class="editor-error-banner" style="display:none"></div>'
    + '<div class="editor-section">'
    + '<div class="editor-section-title">📋 Básico</div>'
    + '<label class="soap-label">Categoría</label>'
    + '<input id="editorBasicCategory" class="swal2-input" value="' + sanitizeHTML(mod.basic.category) + '">'
    + '<label class="soap-label">Título</label>'
    + '<input id="editorBasicTitle" class="swal2-input" value="' + sanitizeHTML(mod.basic.title) + '">'
    + '<label class="soap-label">Instrucciones</label>'
    + '<textarea id="editorBasicInstructions" class="swal2-textarea" rows="3">' + sanitizeHTML(mod.basic.instructions) + '</textarea>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
    + '<div><label class="soap-label">Dificultad</label>'
    + '<select id="editorBasicDifficulty" class="swal2-input">'
    + '<option value="baja"' + (mod.basic.difficulty === 'baja' ? ' selected' : '') + '>🟢 Fácil</option>'
    + '<option value="media"' + (mod.basic.difficulty === 'media' ? ' selected' : '') + '>🟡 Media</option>'
    + '<option value="alta"' + (mod.basic.difficulty === 'alta' ? ' selected' : '') + '>🔴 Avanzada</option>'
    + '</select></div>'
    + '<div><label class="soap-label">Duración (min)</label>'
    + '<input id="editorBasicDuration" class="swal2-input" type="number" value="' + mod.basic.duration_min + '" min="5" max="180">'
    + '</div></div></div>'
    + '<div class="editor-section">'
    + '<div class="editor-section-title">🧬 Tipo de ejercicio'
    + '<span class="editor-section-actions">'
    + '<button class="btn-mini" id="editorResetDefaultsBtn" type="button" title="Reemplazar los campos actuales por los del sistema para este tipo">↺ Reset a defaults</button>'
    + '</span></div>'
    + '<select id="editorKindSelect" class="swal2-input"' + (isEdit ? ' disabled title="No se puede cambiar el kind de una plantilla existente (las asignaciones ya tienen schema congelado)"' : '') + '>'
    + kindOptionsHtml + '</select>'
    + '<p class="editor-help-text" id="editorKindHelp">' + sanitizeHTML((TEMPLATE_KIND_OPTIONS.find(o => o.value === initialKindValue) || {}).label || '') + '</p>'
    + '<label class="soap-label">Guía clínica (opcional, la verá el paciente)</label>'
    + '<textarea id="editorGuidance" class="swal2-textarea" rows="2" placeholder="Texto terapéutico mostrado antes de empezar">' + sanitizeHTML(mod.guidance) + '</textarea>'
    + '</div>'
    + '<div class="editor-section">'
    + '<div class="editor-section-title">🧩 Campos del formulario'
    + '<span class="editor-section-actions">'
    + '<span class="add-field-summary" id="editorFieldsSummary"></span>'
    + '</span></div>'
    + '<div id="editorFieldsList"></div>'
    + '<div class="add-field-row">'
    + '<select id="editorAddFieldType" aria-label="Tipo de field a añadir"></select>'
    + '<button class="btn btn-s btn-sm" id="editorAddFieldBtn" type="button">+ Añadir field</button>'
    + '</div>'
    + '</div>';

  return new Promise((resolve) => {
    Swal.fire({
      title: isEdit ? 'Editar plantilla clínica' : 'Nueva plantilla clínica',
      html,
      width: 720,
      focusConfirm: false,
      showCancelButton: true,
      confirmButtonText: isEdit ? 'Guardar cambios' : 'Crear plantilla',
      cancelButtonText: 'Cancelar',
      customClass: { htmlContainer: 'editor-container' },
      didOpen: () => {
        const rootEl = document.querySelector('.swal2-html-container');
        const kindSelect = rootEl.querySelector('#editorKindSelect');
        kindSelect.value = initialKindValue;
        // Render inicial + bind
        refreshEditorFieldsSection(rootEl, mod);
        // Picker de tipo al añadir field
        const typeSel = rootEl.querySelector('#editorAddFieldType');
        const FIELD_LABELS = { text:'Texto corto', textarea:'Texto largo', number:'Número', scale:'Escala (slider)', select:'Selección única', multi_select:'Selección múltiple', boolean:'Sí/No', date:'Fecha', repeater:'Lista repetible' };
        typeSel.innerHTML = Object.keys(FIELD_LABELS).map(t => '<option value="' + t + '">' + sanitizeHTML(FIELD_LABELS[t]) + '</option>').join('');
        rootEl.querySelector('#editorAddFieldBtn').addEventListener('click', () => {
          const t = typeSel.value;
          const defaults = EDITOR_FIELD_TYPE_DEFAULTS[t] || {};
          // key único basado en timestamp para evitar colisiones con cualquier
          // field existente (los nuevos keys pueden ser renombrados por el
          // terapeuta en el server mediante un próximo PUT si quiere).
          const newKey = 'custom_' + t.replace('_', '') + '_' + Date.now().toString(36).slice(-5);
          mod.fields.push(Object.assign({ key: newKey, type: t, required: false, sensitive: false }, defaults));
          refreshEditorFieldsSection(rootEl, mod);
        });
        // Capture live edits del textarea de guía clínica en mod.guidance.
        // preConfirm re-lee el value al enviar, pero tener el state vivo evita
        // drift si en el futuro algun handler intermedio necesita el state.
        rootEl.querySelector('#editorGuidance').addEventListener('input', (e) => { mod.guidance = e.target.value; });

        // Cambio de kind solo permitido en create (el select va disabled en edit).
        if (!isEdit) {
          kindSelect.addEventListener('change', async () => {
            const newOpt = TEMPLATE_KIND_OPTIONS.find(o => o.value === kindSelect.value);
            if (!newOpt) return;
            const proceed = await Swal.fire({ title:'¿Cambiar tipo de ejercicio?', text:'Esto reemplazará los campos actuales por los del sistema. Tu trabajo no guardado se perderá.', icon:'warning', showCancelButton:true, confirmButtonText:'Sí, cambiar y resetar', cancelButtonText:'Cancelar' });
            if (!proceed.isConfirmed) { kindSelect.value = editorKindValueFor(mod.kind, mod.mode, mod.phobia); return; }
            const def = await fetchEditorSchemaDefaults(newOpt.kind, newOpt.mode || null, newOpt.phobia || null);
            if (!def) { showToast('Error al cargar defaults del nuevo tipo', 'error'); kindSelect.value = editorKindValueFor(mod.kind, mod.mode, mod.phobia); return; }
            mod.kind = newOpt.kind; mod.mode = newOpt.mode || null; mod.phobia = newOpt.phobia || null;
            mod.fields = (def.fields || []).map(f => JSON.parse(JSON.stringify(f)));
            mod.guidance = def.guidance || '';
            rootEl.querySelector('#editorKindHelp').textContent = newOpt.label;
            rootEl.querySelector('#editorGuidance').value = mod.guidance;
            refreshEditorFieldsSection(rootEl, mod);
          });
        }
        // Reset a defaults (sólo campos; preserva kind, mode, phobia actuales).
        rootEl.querySelector('#editorResetDefaultsBtn').addEventListener('click', async () => {
          const proceed = await Swal.fire({ title:'¿Resetear campos al esquema del sistema?', text:'Los campos que hayas añadido o modificado se perderán.', icon:'warning', showCancelButton:true, confirmButtonText:'Sí, resetar', cancelButtonText:'Cancelar' });
          if (!proceed.isConfirmed) return;
          const def = await fetchEditorSchemaDefaults(mod.kind, mod.mode, mod.phobia);
          if (!def) { showToast('Error al cargar defaults', 'error'); return; }
          mod.fields = (def.fields || []).map(f => JSON.parse(JSON.stringify(f)));
          mod.guidance = def.guidance || '';
          rootEl.querySelector('#editorGuidance').value = mod.guidance;
          refreshEditorFieldsSection(rootEl, mod);
        });
      },
      preConfirm: async () => {
        const rootEl = document.querySelector('.swal2-html-container');
        // 1. Snapshot de los inputs básicos (en este orden el server validará
        //    primero los básicos, luego el schema).
        mod.basic.category = rootEl.querySelector('#editorBasicCategory').value.trim();
        mod.basic.title = rootEl.querySelector('#editorBasicTitle').value.trim();
        mod.basic.instructions = rootEl.querySelector('#editorBasicInstructions').value.trim();
        mod.basic.difficulty = rootEl.querySelector('#editorBasicDifficulty').value;
        const dur = parseInt(rootEl.querySelector('#editorBasicDuration').value, 10);
        mod.basic.duration_min = Number.isFinite(dur) && dur >= 5 ? dur : 30;
        mod.guidance = rootEl.querySelector('#editorGuidance').value || '';

        if (!mod.basic.category || !mod.basic.title || !mod.basic.instructions) {
          Swal.showValidationMessage('Categoría, título e instrucciones son obligatorios');
          return false;
        }
        if (mod.fields.length === 0) {
          Swal.showValidationMessage('El esquema clínico debe tener al menos un campo');
          return false;
        }
        const nonRepeater = mod.fields.filter(f => f && f.type !== 'repeater').length;
        if (nonRepeater === 0) {
          Swal.showValidationMessage('Al menos un campo debe ser no-repeater (text/number/scale/select/...)');
          return false;
        }

        const exerciseSchema = {
          fields: mod.fields,
          guidance: mod.guidance,
          mode: mod.mode || undefined,
          phobia: mod.phobia || undefined,
        };

        const body = {
          category: mod.basic.category,
          title: mod.basic.title,
          instructions: mod.basic.instructions,
          difficulty: mod.basic.difficulty,
          duration_min: mod.basic.duration_min,
          exercise_kind: mod.kind,
          mode: mod.mode || null,
          phobia: mod.phobia || null,
          exercise_schema: exerciseSchema,
        };

        try {
          let r, d;
          if (isEdit && t) {
            r = await api(API + '/therapists/task-templates/' + t.id, { method: 'PUT', body: JSON.stringify(body) });
          } else {
            r = await api(API + '/therapists/task-templates', { method: 'POST', body: JSON.stringify(body) });
          }
          d = await r.json();
          if (d.success) {
            // Limpia el banner de errores al guardar OK.
            const banner = rootEl.querySelector('#editorErrorBanner');
            if (banner) banner.style.display = 'none';
            return d.template;
          }
          // 422 errors[] del server: pintamos banner y BLOQUEAMOS confirmación
          // (return false mantiene el modal abierto).
          const banner = rootEl.querySelector('#editorErrorBanner');
          if (banner) {
            const errs = Array.isArray(d.errors) ? d.errors : [];
            banner.innerHTML = '<strong>⚠️ ' + sanitizeHTML(d.error || 'Schema inválido') + '</strong>'
              + (errs.length ? '<ul>' + errs.slice(0, 15).map(e => '<li>' + sanitizeHTML((e.path || '') + ' → ' + (e.code || '') + (e.message ? ' (' + e.message + ')' : '')) + '</li>').join('') + '</ul>'
                + (errs.length > 15 ? '<p>+ ' + (errs.length - 15) + ' errores más…</p>' : '')
              : '');
            banner.style.display = 'block';
            banner.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          return false;
        } catch (e) {
          Swal.showValidationMessage('Error de conexión con el servidor');
          return false;
        }
      },
    }).then((sr) => {
      if (sr.isConfirmed && sr.value) {
        const saved = sr.value;
        if (isEdit && t) {
          const idx = templates.findIndex(x => x.id === t.id);
          if (idx !== -1) templates[idx] = Object.assign({}, templates[idx], saved);
        } else {
          templates.unshift(saved);
        }
        renderTemplates();
        renderCategoryFilters();
        showToast(isEdit ? '✅ Plantilla clínica actualizada' : '✅ Plantilla clínica creada', 'success');
        resolve({ saved: true, template: saved });
      } else {
        resolve(null);
      }
    });
  });
}

function editCustomTemplate(templateId){
  const t=templates.find(x=>x.id===templateId);if(!t)return;
  // Plantillas clínicas (TR/BA/GE): editor rico de 3 secciones (Básico +
  // Tipo + Campos). Las clásicas conservan el form simple backward-compat.
  if (t.exercise_kind && t.exercise_kind !== 'classic') {
    return openClinicalEditor({ mode: 'edit', template: t });
  }
  Swal.fire({title:'Editar plantilla',html:`
    <label class="soap-label">Categoría</label>
    <input id="swalTmplCat" class="swal2-input" value="${t.category.replace(/"/g,'&quot;')}">
    <label class="soap-label">Título</label>
    <input id="swalTmplTitle" class="swal2-input" value="${t.title.replace(/"/g,'&quot;')}">
    <label class="soap-label">Instrucciones</label>
    <textarea id="swalTmplInstructions" class="swal2-textarea" rows="4">${t.instructions.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
    <label class="soap-label">Dificultad</label>
    <select id="swalTmplDifficulty" class="swal2-input"><option value="baja"${t.difficulty==='baja'?' selected':''}>🟢 Fácil</option><option value="media"${t.difficulty==='media'?' selected':''}>🟡 Media</option><option value="alta"${t.difficulty==='alta'?' selected':''}>🔴 Avanzada</option></select>
    <label class="soap-label">Duración (minutos)</label>
    <input id="swalTmplDuration" class="swal2-input" type="number" value="${t.duration_min}" min="5" max="180">
  `,showCancelButton:true,confirmButtonText:'Guardar cambios',cancelButtonText:'Cancelar',width:600,preConfirm:async()=>{
    const category=document.getElementById('swalTmplCat').value.trim();
    const title=document.getElementById('swalTmplTitle').value.trim();
    const instructions=document.getElementById('swalTmplInstructions').value.trim();
    const difficulty=document.getElementById('swalTmplDifficulty').value;
    const duration=parseInt(document.getElementById('swalTmplDuration').value)||30;
    if(!category||!title||!instructions){Swal.showValidationMessage('Categoría, título e instrucciones son obligatorios');return false;}
    try{
      const r=await api(`${API}/therapists/task-templates/${templateId}`,{method:'PUT',body:JSON.stringify({category,title,instructions,difficulty,duration_min:duration})});
      const d=await r.json();
      if(d.success){
        const idx=templates.findIndex(x=>x.id===templateId);
        if(idx!==-1){templates[idx]={...templates[idx],category,title,instructions,difficulty,duration_min:duration};}
        renderTemplates();renderCategoryFilters();Swal.fire({title:'✅ Plantilla actualizada',icon:'success',timer:1500,showConfirmButton:false});
      }else Swal.showValidationMessage(d.error||'Error al actualizar');
    }catch(e){Swal.showValidationMessage('Error de conexión');}
  }});
}

async function deleteCustomTemplate(templateId){
  const t=templates.find(x=>x.id===templateId);if(!t)return;
  const result=await Swal.fire({title:'¿Eliminar plantilla?',text:`"${t.title}" se eliminará permanentemente.`,icon:'warning',showCancelButton:true,confirmButtonText:'Sí, eliminar',cancelButtonText:'Cancelar',confirmButtonColor:'#ef4444'});
  if(!result.isConfirmed)return;
  try{
    const r=await api(`${API}/therapists/task-templates/${templateId}`,{method:'DELETE'});
    const d=await r.json();
    if(d.success){templates=templates.filter(x=>x.id!==templateId);renderTemplates();renderCategoryFilters();Swal.fire({title:'🗑️ Eliminada',icon:'success',timer:1500,showConfirmButton:false});}
    else Swal.fire('Error',d.error||'No se pudo eliminar','error');
  }catch(e){Swal.fire('Error','No se pudo eliminar','error');}
}

async function disconnectPatient(){
  if(!currentPatientId)return showToast('No hay paciente seleccionado','error');
  const patientName=document.getElementById('modalPatientName')?.textContent||'este paciente';
  const result=await Swal.fire({
    title:'¿Desconectar paciente?',
    html:`<p>Vas a desconectar a <strong>${sanitizeHTML(patientName)}</strong>.</p><p style="color:#888;font-size:.85rem;margin-top:8px">El historial clínico (check-ins, mensajes, tareas, notas) se conserva, pero el paciente dejará de aparecer en tu lista activa y no podŕa enviarte mensajes nuevos. Se puede volver a conectar con un nuevo código.</p>`,
    input:'textarea',
    inputPlaceholder:'Motivo (opcional, solo para tu registro)',
    inputAttributes:{'maxlength':'500','aria-label':'Motivo de desconexión'},
    icon:'warning',
    showCancelButton:true,
    confirmButtonText:'Sí, desconectar',
    cancelButtonText:'Cancelar',
    confirmButtonColor:'#ef4444',
  });
  if(!result.isConfirmed)return;
  try{
    await api(`${API}/therapists/patients/${currentPatientId}/connections`,{method:'DELETE',body:JSON.stringify({reason:(result.value||'').trim()})});
    PatientsCache.invalidate();
    closePatientModal();
    await loadPatients({force:true});
    Swal.fire({title:'Paciente desconectado',text:`${sanitizeHTML(patientName)} ya no aparece en tu lista activa`,icon:'success',timer:1800,showConfirmButton:false});
  }catch(e){
    console.error('[disconnectPatient] error:',e);
    Swal.fire('Error','No se pudo desconectar al paciente','error');
  }
}

async function exportPatientData(){
  if(!currentPatientId)return;
  var patientName=patientData&&patientData.name||currentPatientId.slice(0,8);
  var result=await Swal.fire({
    title:'Exportar historial clínico',
    html:`<p style="margin-bottom:16px;color:var(--muted);font-size:13px;">Exporta el historial completo de <strong>${sanitizeHTML(patientName)}</strong>: check-ins, mensajes, tareas, objetivos, notas SOAP y sesiones.</p>`,
    icon:'question',
    showCancelButton:true,
    showConfirmButton:false,
    cancelButtonText:'Cancelar',
    showDenyButton:true,
    denyButtonText:'📄 PDF (reporte)',
    footer:`<button id="btnExportCSV" class="swal2-confirm swal2-styled" style="margin-right:8px;font-size:14px">📊 CSV (datos)</button>`,
    didOpen:function(){
      document.getElementById('btnExportCSV').addEventListener('click',function(){
        Swal.close();
        downloadExport('csv');
      });
    }
  });
  if(result.isDenied){
    downloadExport('pdf');
  }
}

async function downloadExport(format){
  try{
    var r=await api(`${API}/therapists/export/${currentPatientId}?format=${format}`);
    if(!r.ok) throw new Error('HTTP '+r.status);
    if(format==='pdf'){
      // Abrir reporte HTML en nueva pestaña (el usuario puede imprimir/guardar como PDF)
      var html=await r.text();
      var w=window.open('','_blank','width=1000,height=800');
      if(!w){Swal.fire('Error','El navegador bloqueó la ventana emergente. Permite ventanas emergentes para ver el reporte.','warning');return;}
      w.document.write(html);
      w.document.close();
      Swal.fire({title:'✅ Reporte abierto',text:'Usa Ctrl+P → Guardar como PDF para descargarlo.',icon:'success',timer:2500,showConfirmButton:false});
    }else{
      var blob=await r.blob();var url=URL.createObjectURL(blob);
      var a=document.createElement('a');a.href=url;a.download='coter_'+currentPatientId.slice(0,8)+'.csv';a.click();URL.revokeObjectURL(url);
      Swal.fire({title:'✅ CSV descargado',icon:'success',timer:1500,showConfirmButton:false});
    }
  }catch(e){Swal.fire('Error','No se pudo exportar: '+e.message,'error');}
}

async function loadCode(){
  try{
    const r=await api(`${API}/therapists/connection-codes`);const d=await r.json();
    if(d.success&&d.codes?.length){const c=d.codes[0];document.getElementById('currentCode').innerHTML=`${c.code}<small>Expira: ${new Date(c.expires_at).toLocaleDateString('es-ES')} | Usos: ${c.uses}/${c.max_uses}</small>`;}
    else document.getElementById('currentCode').textContent='Sin códigos activos';
  }catch(e){console.error(e);}
}

async function generateCode(){
  // try/catch añadido por consistencia con showNewPatient(): antes un
  // fallo de red o de token-refresh se quedaba como promesa rechazada
  // sin mensaje visible al usuario. Ahora la UX siempre da feedback
  // (sea success:false del backend o un error de red puro).
  try{
    const r=await api(`${API}/therapists/connection-codes`,{method:'POST',body:JSON.stringify({duration_hours:720,max_uses:5})});
    const d=await r.json();
    if(d.success){
      loadCode();
      // Invalidate por simetría con showNewPatient(): aunque generar un
      // código no crea directamente un paciente, cuando el paciente lo
      // rescate vía /patients/connect aparecerá en la lista activa y el
      // próximo getPatients volverá con datos frescos.
      PatientsCache.invalidate();
      Swal.fire({title:'¡Código generado!',html:`<div class="code-box code-box-popup">${d.code}</div><p class="code-popup-text">Comparte este código con tu paciente</p>`,icon:'success'});
    } else {
      console.error('[generateCode] backend error:', d.error);
      Swal.fire('Error',d.error||'No se pudo generar el código','error');
    }
  }catch(e){
    console.error('[generateCode] fetch falló:', e);
    Swal.fire('Error','No se pudo conectar con el servidor','error');
  }
}

function showNewPatient(){
  Swal.fire({title:'Nuevo paciente',html:`<input id="swalPatientName" class="swal2-input" placeholder="Nombre y apellidos del paciente">`,showCancelButton:true,confirmButtonText:'Crear código',cancelButtonText:'Cancelar',preConfirm:async()=>{
    const name=document.getElementById('swalPatientName').value.trim();
    if(!name){Swal.showValidationMessage('Ingresa el nombre del paciente');return false;}
    try{
      const r=await api(`${API}/therapists/connection-codes`,{method:'POST',body:JSON.stringify({duration_hours:720,max_uses:1,patient_name:name})});
      const d=await r.json();
      if(d.success){loadCode();PatientsCache.invalidate();Swal.fire({title:'¡Código creado!',html:`<h3 class="code-popup-name">${name}</h3><div class="code-box code-box-popup">${d.code}</div><p class="code-popup-text">Comparte este código exclusivo con ${name.split(' ')[0]}</p>`,icon:'success'});}
      else Swal.fire('Error',d.error||'No se pudo crear el código','error');
    }catch(e){Swal.fire('Error','No se pudo conectar con el servidor','error');}
  }});
}

// ==================== CALENDARIO ====================
let calendarYear,calendarMonth,calendarData={};
function initCalendar(){const now=new Date();calendarYear=now.getFullYear();calendarMonth=now.getMonth();}
function loadCalendar(){
  if(!calendarYear)initCalendar();
  const monthStr=`${calendarYear}-${String(calendarMonth+1).padStart(2,'0')}`;
  document.getElementById('calendarMonthLabel').textContent=new Date(calendarYear,calendarMonth).toLocaleDateString('es-ES',{month:'long',year:'numeric'});
  api(`${API}/therapists/calendar?month=${monthStr}`).then(r=>r.json()).then(d=>{
    if(d.success){calendarData=d.dates||{};renderCalendar();renderAgenda();}
  }).catch(e=>{document.getElementById('calendarGrid').innerHTML='<p class="empty-msg error">Error al cargar calendario</p>';});
}
function prevMonth(){calendarMonth--;if(calendarMonth<0){calendarMonth=11;calendarYear--;}loadCalendar();hideDayPanel();}
function nextMonth(){calendarMonth++;if(calendarMonth>11){calendarMonth=0;calendarYear++;}loadCalendar();hideDayPanel();}
function goToToday(){initCalendar();loadCalendar();hideDayPanel();}
function hideDayPanel(){document.getElementById('calendarDayPanel').classList.add('hidden');}

function renderCalendar(){
  const grid=document.getElementById('calendarGrid');
  const todayStr=new Date().toISOString().slice(0,10);
  const today=new Date();today.setHours(0,0,0,0);
  const firstDay=new Date(calendarYear,calendarMonth,1);
  const lastDay=new Date(calendarYear,calendarMonth+1,0);
  const startOffset=(firstDay.getDay()+6)%7;
  const totalDays=lastDay.getDate();
  const dayNames=['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
  let html=dayNames.map(d=>`<div class="calendar-day-header">${d}</div>`).join('');
  for(let i=0;i<startOffset;i++){html+=`<div class="calendar-day other-month"><div class="calendar-day-num"></div></div>`;}
  for(let d=1;d<=totalDays;d++){
    const dateStr=`${calendarYear}-${String(calendarMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayData=calendarData[dateStr]||{checkins:[],tasks:[]};
    const checkins=dayData.checkins||[];const tasks=dayData.tasks||[];
    const dateObj=new Date(calendarYear,calendarMonth,d);dateObj.setHours(0,0,0,0);
    const isToday=dateObj.getTime()===today.getTime();
    let dots='';
    const avgMood=checkins.length?Math.round(checkins.reduce((s,c)=>s+c.mood,0)/checkins.length):null;
    if(avgMood!==null){const moodClass=avgMood>=7?'mood-high':avgMood>=4?'mood-mid':'mood-low';dots+=`<div class="calendar-dot ${moodClass}" title="Ánimo prom: ${avgMood}/10"></div>`;}
    const overdueTasks=tasks.filter(t=>t.due_date&&t.due_date.slice(0,10)<todayStr);
    const dueTasks=tasks.filter(t=>t.due_date&&t.due_date.slice(0,10)>=todayStr);
    if(overdueTasks.length)dots+=`<div class="calendar-dot task-overdue" title="${overdueTasks.length} vencidas"></div>`;
    if(dueTasks.length)dots+=`<div class="calendar-dot task-due" title="${dueTasks.length} tareas"></div>`;
    html+=`<div class="calendar-day${isToday?' today':''}" data-date="${dateStr}"><div class="calendar-day-num">${d}</div><div class="calendar-dots">${dots}</div></div>`;
  }
  const remaining=42-(startOffset+totalDays);
  for(let i=0;i<remaining&&i<14;i++){html+=`<div class="calendar-day other-month"><div class="calendar-day-num"></div></div>`;}
  grid.innerHTML=html;
}

function selectCalendarDay(dateStr){
  document.querySelectorAll('.calendar-day.selected').forEach(el=>el.classList.remove('selected'));
  document.querySelectorAll('.calendar-day').forEach(el=>{
    const num=el.querySelector('.calendar-day-num')?.textContent;
    if(num&&`${calendarYear}-${String(calendarMonth+1).padStart(2,'0')}-${String(parseInt(num)).padStart(2,'0')}`===dateStr)el.classList.add('selected');
  });
  const panel=document.getElementById('calendarDayPanel');
  const dayData=calendarData[dateStr]||{checkins:[],tasks:[]};
  const checkins=dayData.checkins||[];const tasks=dayData.tasks||[];
  const dateLabel=new Date(dateStr+'T00:00:00').toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  document.getElementById('calendarDayTitle').textContent=dateLabel;
  let html='';
  html+=`<h4>🌤️ Check-ins (${checkins.length})</h4>`;
  if(!checkins.length)html+='<div class="calendar-empty">Sin check-ins este día</div>';
  else html+=checkins.map(c=>`<div class="calendar-event checkin"><span class="cal-emoji">${c.mood<=3?'😔':c.mood>=7?'😊':'😐'}</span><div><strong>${sanitizeHTML(c.patient_name)}</strong> — Ánimo ${c.mood}/10 | Ansiedad ${c.anxiety}/10 | Energía ${c.energy||'-'}/10</div></div>`).join('');
  html+=`<h4>📋 Tareas (${tasks.length})</h4>`;
  if(!tasks.length)html+='<div class="calendar-empty">Sin tareas este día</div>';
  else html+=tasks.map(t=>{
    const isOverdue=t.due_date&&t.due_date.slice(0,10)<new Date().toISOString().slice(0,10);
    const cls=isOverdue?'task-overdue-cal':'task-item-cal';
    const badge=t.status==='completed'?'✅':isOverdue?'⚠️ Vencida':t.due_date?'⏳ Pendiente':'📌 Asignada';
    return`<div class="calendar-event ${cls}"><span class="cal-emoji">${isOverdue?'⚠️':'📋'}</span><div><strong>${sanitizeHTML(t.title)}</strong> <span class="cal-badge">${badge}</span><br><small>${sanitizeHTML(t.patient_name)}${t.due_date?` · Vence: ${new Date(t.due_date).toLocaleDateString('es-ES')}`:''}</small></div></div>`;
  }).join('');
  html+=`<button class="cal-assign-btn" data-action="cal-assign-task" data-date="${dateStr}">+ Asignar tarea</button>`;
  document.getElementById('calendarDayContent').innerHTML=html;
  panel.classList.remove('hidden');
}

// ==================== AGENDA DEL DÍA ====================
function renderAgenda(){
  const todayStr=new Date().toISOString().slice(0,10);
  const todayData=calendarData[todayStr]||{checkins:[],tasks:[]};
  const todayCheckins=todayData.checkins||[];
  const todayTasks=todayData.tasks||[];

  // — Agenda de hoy —
  const todayEl=document.getElementById('agendaToday');
  let todayHtml='';

  if(todayCheckins.length){
    todayHtml+=`<div class="agenda-section-title">Check-ins (${todayCheckins.length})</div>`;
    todayCheckins.forEach((c,i)=>{
      const moodIcon=c.mood<=3?'😔':c.mood>=7?'😊':'😐';
      todayHtml+=`<div class="agenda-item" style="animation-delay:${i*40}ms"><span class="agenda-item-icon">${moodIcon}</span><div class="agenda-item-body"><div class="agenda-item-title">${sanitizeHTML(c.patient_name)}</div><div class="agenda-item-meta">Ánimo ${c.mood}/10 · Ansiedad ${c.anxiety}/10</div></div></div>`;
    });
  }

  if(todayTasks.length){
    todayHtml+=`<div class="agenda-section-title">Tareas (${todayTasks.length})</div>`;
    todayTasks.forEach((t,i)=>{
      const done=t.status==='completed';
      const icon=done?'✅':'📋';
      todayHtml+=`<div class="agenda-item" style="animation-delay:${(todayCheckins.length+i)*40}ms"><span class="agenda-item-icon">${icon}</span><div class="agenda-item-body"><div class="agenda-item-title">${sanitizeHTML(t.title)}</div><div class="agenda-item-meta">${sanitizeHTML(t.patient_name)}${done?' · Completada':''}</div></div></div>`;
    });
  }

  if(!todayCheckins.length&&!todayTasks.length){
    todayHtml='<div class="agenda-empty">Sin actividad registrada hoy</div>';
  }
  todayEl.innerHTML=todayHtml;

  // — Próximos 7 días —
  const upcomingEl=document.getElementById('agendaUpcoming');
  let upHtml='';
  const now=new Date();now.setHours(0,0,0,0);
  const upcomingItems=[];

  for(let d=1;d<=7;d++){
    const dt=new Date(now);dt.setDate(dt.getDate()+d);
    const ds=dt.toISOString().slice(0,10);
    const dd=calendarData[ds]||{checkins:[],tasks:[]};
    (dd.tasks||[]).forEach(t=>{
      if(t.status!=='completed'&&t.due_date){
        upcomingItems.push({...t,_date:ds,_dateLabel:dt.toLocaleDateString('es-ES',{weekday:'short',day:'numeric',month:'short'})});
      }
    });
  }

  // Also include overdue tasks from past days (still assigned)
  Object.keys(calendarData).forEach(ds=>{
    if(ds>=todayStr)return;
    const dd=calendarData[ds]||{tasks:[]};
    (dd.tasks||[]).forEach(t=>{
      if(t.status!=='completed'&&t.due_date&&t.due_date.slice(0,10)===ds){
        const already=upcomingItems.some(u=>u.id===t.id);
        if(!already) upcomingItems.push({...t,_date:ds,_dateLabel:'Vencida',_overdue:true});
      }
    });
  });

  if(upcomingItems.length){
    upcomingItems.forEach((t,i)=>{
      const badgeClass=t._overdue?'overdue':'';
      upHtml+=`<div class="agenda-item" style="animation-delay:${i*40}ms"><span class="agenda-item-icon">📋</span><div class="agenda-item-body"><div class="agenda-item-title">${sanitizeHTML(t.title)}</div><div class="agenda-item-meta">${sanitizeHTML(t.patient_name)}</div></div><span class="agenda-date-badge ${badgeClass}">${t._dateLabel}</span></div>`;
    });
  }else{
    upHtml='<div class="agenda-empty">Sin tareas próximas</div>';
  }
  upcomingEl.innerHTML=upHtml;
}

// ==================== CREAR TAREA DESDE CALENDARIO ====================
async function showCalendarAssignTask(dateStr){
  let patients=[];
  try{
    patients=await PatientsCache.getPatients();
  }catch(e){
    console.error('[showCalendarAssignTask] fetch patients falló:',e);
  }
  if(!patients.length){
    return Swal.fire({title:'Sin pacientes',text:'No tienes pacientes conectados.',icon:'info'});
  }
  const patientOpts={};
  patients.forEach(p=>{patientOpts[p.id]=p.name||'Anónimo (ID:'+p.id.slice(0,8)+')';});

  const dateDisplay=new Date(dateStr+'T00:00:00').toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'});

  Swal.fire({
    title:'Asignar tarea',
    html:`
      <p style="color:var(--muted);font-size:13px;margin-bottom:14px">Fecha de vencimiento: <strong>${dateDisplay}</strong></p>
      <label class="soap-label">Paciente</label>
      <select id="swalCalPatient" class="swal2-input"></select>
      <label class="soap-label">Título</label>
      <input id="swalCalTitle" class="swal2-input" placeholder="Título de la tarea">
      <label class="soap-label">Tipo</label>
      <input id="swalCalType" class="swal2-input" placeholder="Ej: ejercicio, lectura, registro">
      <label class="soap-label">Instrucciones</label>
      <textarea id="swalCalInstructions" class="swal2-textarea" placeholder="Instrucciones detalladas para el paciente..." rows="3"></textarea>
    `,
    showCancelButton:true,
    confirmButtonText:'Asignar tarea',
    cancelButtonText:'Cancelar',
    width:520,
    didOpen:()=>{
      const sel=document.getElementById('swalCalPatient');
      Object.entries(patientOpts).forEach(([id,name])=>{
        const opt=document.createElement('option');opt.value=id;opt.textContent=name;sel.appendChild(opt);
      });
    },
    preConfirm:async()=>{
      const patientId=document.getElementById('swalCalPatient').value;
      const title=document.getElementById('swalCalTitle').value.trim();
      const type=document.getElementById('swalCalType').value.trim();
      const instructions=document.getElementById('swalCalInstructions').value.trim();
      if(!patientId||!title||!type||!instructions){Swal.showValidationMessage('Completa todos los campos');return false;}
      try{
        await api(`${API}/therapists/patients/${patientId}/assignments`,{method:'POST',body:JSON.stringify({title,type,instructions,due_date:dateStr})});
        // Refresh calendar data so the new task appears
        loadCalendar();
      }catch(e){
        Swal.showValidationMessage('Error al asignar la tarea');
        return false;
      }
    }
  }).then(r=>{
    if(r.isConfirmed) showToast('✅ Tarea asignada para '+dateDisplay,'success');
  });
}

// ==================== FACTURACIÓN ====================

async function loadBilling(){
  const container = document.getElementById('billingContent');
  if (!container) return;
  container.innerHTML = '<div class="card" style="grid-column:1/-1"><div style="text-align:center;padding:32px"><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text short"></div></div></div>';
  try {
    const r = await api(`${API}/billing/status`);
    const d = await r.json();
    if (!d.success) {
      container.innerHTML = '<div class="card" style="grid-column:1/-1"><p class="empty-msg error">Error al cargar información de facturación: ' + sanitizeHTML(d.error || 'Error desconocido') + '</p></div>';
      return;
    }
    renderBilling(container, d.subscription);
  } catch (e) {
    console.error('[loadBilling]', e);
    container.innerHTML = '<div class="card" style="grid-column:1/-1"><p class="empty-msg error">Error de conexión al cargar facturación</p></div>';
  }
}

function renderBilling(container, sub) {
  const status = sub.status || 'unknown';
  const statusLabels = { trialing:'Período de prueba', active:'Activa', past_due:'Pago pendiente', canceled:'Cancelada', incomplete:'Configuración pendiente' };
  const statusIcons = { trialing:'🧪', active:'✅', past_due:'⚠️', canceled:'❌', incomplete:'⏳' };
  let patientCount = sub.patientCount || 0;
  const priceEur = (sub.pricePerPatientCents / 100).toFixed(2);
  const estimatedEur = (sub.estimatedMonthlyCostCents / 100).toFixed(2);
  let h = "";
  h += '<div class="billing-status-card"><div class="billing-status-icon ' + status + '">' + (statusIcons[status] || '📋') + '</div><div class="billing-status-body"><h2>' + sanitizeHTML(statusLabels[status] || status) + ' <span class="billing-status-badge ' + status + '">' + status + '</span></h2>';
  if (status === 'trialing' && sub.trial) h += '<p>Disfrutas de acceso completo gratuito durante ' + sub.trial.daysLeft + ' días más.</p>';
  else if (status === 'active') h += '<p>Tu suscripción está activa. Se te facturará <strong>' + priceEur + ' €/paciente/mes</strong>.</p>';
  else if (status === 'past_due') h += '<p>Tu último pago no se ha podido procesar. Tienes 7 días de gracia para actualizar tu método de pago.</p>';
  else if (status === 'canceled') h += '<p>Tu suscripción ha sido cancelada. Reactívala para seguir accediendo a tus pacientes.</p>';
  h += '</div></div>';
  if (status === 'trialing' && sub.trial) {
    const trialPct = Math.min(100, Math.round(((14 - sub.trial.daysLeft) / 14) * 100));
    const endsDate = sub.trial.endsAt ? new Date(sub.trial.endsAt).toLocaleDateString('es-ES', { weekday:'long', day:'numeric', month:'long' }) : '';
    h += '<div class="billing-trial-banner"><h3>🧪 Período de prueba — ' + sub.trial.daysLeft + ' día' + (sub.trial.daysLeft !== 1 ? 's' : '') + ' restante' + (sub.trial.daysLeft !== 1 ? 's' : '') + '</h3>';
    h += '<p style="font-size:13px;color:var(--muted);margin:0 0 4px">El trial finaliza el <strong>' + sanitizeHTML(endsDate) + '</strong>. Después se facturará <strong>' + priceEur + ' €/paciente/mes</strong>.</p>';
    h += '<div class="billing-trial-bar"><div class="billing-trial-fill" style="width:' + trialPct + '%"></div></div>';
    h += '<div class="billing-trial-meta"><span>Inicio</span><span><strong>' + sub.trial.daysLeft + ' días</strong> restantes</span><span>Fin: ' + sanitizeHTML((endsDate || '').split(',')[0] || endsDate) + '</span></div></div>';
  }
  h += '<div class="billing-stat"><div class="billing-stat-num" id="billingPatientCount">' + patientCount + '</div><div class="billing-stat-label">Pacientes activos</div></div>';
  h += '<div class="billing-stat"><div class="billing-stat-num" id="billingMonthlyCost">' + estimatedEur + ' €</div><div class="billing-stat-label">Coste mensual estimado</div></div>';
  h += '<div class="card" style="grid-column:1/-1"><h2>📊 Detalles del plan</h2>';
  h += '<div class="billing-info-row"><span class="billing-info-label">Precio por paciente</span><span class="billing-info-value">' + priceEur + ' €/mes</span></div>';
  h += '<div class="billing-info-row"><span class="billing-info-label">Pacientes activos este mes</span><span class="billing-info-value">' + patientCount + '</span></div>';
  h += '<div class="billing-info-row"><span class="billing-info-label">Estimado mensual</span><span class="billing-info-value">' + estimatedEur + ' €</span></div>';
  if (sub.currentPeriodStart) h += '<div class="billing-info-row"><span class="billing-info-label">Período actual</span><span class="billing-info-value">' + new Date(sub.currentPeriodStart).toLocaleDateString('es-ES') + ' — ' + new Date(sub.currentPeriodEnd).toLocaleDateString('es-ES') + '</span></div>';
  if (sub.trial && sub.trial.endsAt) h += '<div class="billing-info-row"><span class="billing-info-label">Fin del trial</span><span class="billing-info-value">' + new Date(sub.trial.endsAt).toLocaleDateString('es-ES') + '</span></div>';
  h += '</div>';
  if (status === 'trialing' || status === 'active' || status === 'past_due') {
    h += '<div class="billing-stripe-cta"><p>La pasarela de pago con Stripe estará disponible próximamente.<br>Por ahora, disfruta del acceso completo durante el trial.</p>';
    h += '<button class="billing-stripe-btn" disabled title="Próximamente"><svg viewBox="0 0 24 24" fill="currentColor" style="width:20px;height:20px;flex-shrink:0"><path d="M13.976 8.872c-.17-1.217-.93-2.138-1.936-2.682-.562-.304-1.185-.498-1.828-.614l.735-3.118.057-.245c0-.143-.102-.266-.247-.278l-2.006-.153a.28.28 0 00-.2.07.265.265 0 00-.08.195l-.753 3.191c-.14.015-.28.032-.418.052l.917-3.906c.016-.072.024-.146.024-.22 0-.144-.102-.267-.247-.278L6.423.646a.28.28 0 00-.2.07.265.265 0 00-.08.195l-.916 3.908a25.2 25.2 0 00-.347.05L4.005 1.96c-.017-.072-.025-.146-.025-.22 0-.144-.102-.266-.248-.278L2.756 1.31a.28.28 0 00-.2.07.265.265 0 00-.08.195l.88 3.743a.04.04 0 01.002.023 9.3 9.3 0 00-1.092.418c-1.29.62-2.24 1.726-2.18 3.48.05 1.455.949 2.515 2.159 3.025 1.43.604 2.782.67 3.656.764.964.103 1.78.401 1.924 1.103.17.833-.394 1.71-1.46 2.237-1.114.55-2.542.516-3.763-.134-.306-.163-.586-.36-.834-.593a.27.27 0 00-.258-.08.266.266 0 00-.18.202l-.77 3.255a.284.284 0 00.076.276c.452.416 1.007.746 1.63.974 1.331.487 2.776.578 4.044.244 2.378-.626 3.921-2.427 3.754-4.657z"/></svg> Pagar con Stripe (próximamente)</button></div>';
  }
  container.innerHTML = h;
  requestAnimationFrame(function() { const numEl = document.getElementById('billingPatientCount'); if (numEl) animateCounter(numEl, patientCount); });
}

// ==================== EVENT DELEGATION ====================
document.addEventListener('click', function(e){
  const btn = e.target.closest('[data-action]');
  if (btn) {
    const action = btn.dataset.action;
    switch(action) {
      case 'login': doLogin(); break;
      case 'register': doRegister(); break;
      case 'show-register': showRegister(); break;
      case 'show-login': showLogin(); break;
      case 'logout': logout(); break;
      case 'refresh-billing': loadBilling(); break;
      case 'ack-alert': updateOneAlertStatus(btn.dataset.alertId, 'acknowledged'); break;
      case 'resolve-alert': updateOneAlertStatus(btn.dataset.alertId, 'resolved'); break;
              case 'refresh-patients': loadPatients({force:true}); break;
      case 'refresh-code': loadCode(); break;
      case 'gen-code': generateCode(); break;
      case 'new-patient': showNewPatient(); break;
      case 'export-patient': exportPatientData(); break;
      case 'disconnect-patient': disconnectPatient(); break;
      case 'close-modal': closePatientModal(); break;
      case 'send-msg': sendTherapistMsg(); break;
      case 'add-task': showAddTask(); break;
      case 'add-goal': showAddGoal(); break;
      case 'add-session': showAddSession(); break;
      case 'add-note': showAddNote(); break;
      case 'create-template': showCreateTemplate(); break;
      case 'prev-month': prevMonth(); break;
      case 'next-month': nextMonth(); break;
      case 'go-today': goToToday(); break;
      case 'cal-assign-task': showCalendarAssignTask(btn.dataset.date); break;
      case 'toggle-sidebar': toggleSidebar(); break;
      case 'close-sidebar': closeSidebar(); break;
      default: console.warn('Unknown data-action:', action);
    }
    return;
  }

  // Period selector buttons (data-period)
  const periodBtn = e.target.closest('[data-period]');
  if (periodBtn) {
    const period = parseInt(periodBtn.dataset.period);
    if (!period) return;
    // Update active state
    document.querySelectorAll('.period-btn').forEach(function(b){ b.classList.remove('active'); b.setAttribute('aria-pressed','false'); });
    periodBtn.classList.add('active');
    periodBtn.setAttribute('aria-pressed','true');
    // Reload dashboard with new period
    loadDashboard(period);
    return;
  }
  
  // Nav tabs
  closeSidebar();
  const navItem = e.target.closest('.nav-item[data-tab]');
  if (navItem) {
    document.querySelectorAll('.nav-item').forEach(n=>{n.classList.remove('active');n.removeAttribute('aria-current');});
    document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
    navItem.classList.add('active');
    navItem.setAttribute('aria-current','page');
    const tabId = 'tab-'+navItem.dataset.tab;
    const tabEl = document.getElementById(tabId);
    if (tabEl) tabEl.classList.add('active');
    if(navItem.dataset.tab==='patients')loadPatients();
    if(navItem.dataset.tab==='code')loadCode();
    if(navItem.dataset.tab==='calendar')loadCalendar();
    if(navItem.dataset.tab==='billing')loadBilling();
    if(navItem.dataset.tab==='library')loadTemplates();
    return;
  }
  
  // Modal tabs
  const modalTab = e.target.closest('.modal-tab[data-ptab]');
  if (modalTab) {
    document.querySelectorAll('.modal-tab').forEach(t=>{t.classList.remove('active');t.setAttribute('aria-selected','false');});
    document.querySelectorAll('.modal-tab-content').forEach(c=>c.classList.remove('active'));
    modalTab.classList.add('active');
    modalTab.setAttribute('aria-selected','true');
    const ptabEl = document.getElementById(modalTab.dataset.ptab);
    if (ptabEl) ptabEl.classList.add('active');
    return;
  }
  
  // Open patient
  const openBtn = e.target.closest('.btn-open-patient');
  if (openBtn) { openPatient(openBtn.dataset.patientId); return; }
  
  // Complete task (patient modal)
  const completeBtn = e.target.closest('.btn-complete-task');
  if (completeBtn) { completeTask(completeBtn.dataset.taskId); return; }
  const viewResponsesBtn = e.target.closest('.btn-view-responses');
  if (viewResponsesBtn) { toggleResponses(viewResponsesBtn.dataset.taskId); return; }
  
  // Update goal
  const goalBtn = e.target.closest('.btn-update-goal');
  if (goalBtn) { updateGoal(goalBtn.dataset.goalId); return; }
  
  // Edit note
  const editNoteBtn = e.target.closest('.btn-edit-note');
  if (editNoteBtn) { editNote(editNoteBtn.dataset.noteId); return; }
  
  // Delete note
  const delNoteBtn = e.target.closest('.btn-delete-note');
  if (delNoteBtn) { deleteNote(delNoteBtn.dataset.noteId); return; }
  
  // Template actions
  const toggleTmpl = e.target.closest('.btn-toggle-template');
  if (toggleTmpl) { toggleTemplate(toggleTmpl.dataset.templateId); return; }
  const editTmpl = e.target.closest('.btn-edit-template');
  if (editTmpl) { editCustomTemplate(editTmpl.dataset.templateId); return; }
  const delTmpl = e.target.closest('.btn-delete-template');
  if (delTmpl) { deleteCustomTemplate(delTmpl.dataset.templateId); return; }
  const assignTmpl = e.target.closest('.btn-assign-template');
  if (assignTmpl) { assignTemplateToPatient(assignTmpl.dataset.templateId); return; }
  const previewBtn = e.target.closest('.btn-preview-widget');
  if (previewBtn) { previewWidget(previewBtn.dataset.templateId); return; }
  
  // Category chips
  const chip = e.target.closest('.category-chip[data-category]');
  if (chip) { filterCategory(chip.dataset.category || null); return; }
  
  // Calendar day
  const calDay = e.target.closest('.calendar-day[data-date]');
  if (calDay) { selectCalendarDay(calDay.dataset.date); return; }
});

// Enter en input de chat del terapeuta
document.addEventListener('keypress', function(e){
  if (e.key === 'Enter' && e.target.id === 'chatMsgInput') {
    sendTherapistMsg();
  }
});

// Búsqueda en biblioteca
document.addEventListener('input', function(e){
  if (e.target.id === 'librarySearch') {
    renderTemplates();
  }
});

// ==================== AUTO-LOGIN ====================
const saved=localStorage.getItem('coter_therapist');
if(saved){try{const s=JSON.parse(saved);token=s.token||null;refreshToken=s.refresh_token||null;therapist=s.therapist;if(therapist)showApp();}catch(e){localStorage.removeItem('coter_therapist');}}
