/* ============================================================
   Coter — JS de la app de paciente
   (sanitizeHTML y renderEmptyState en /js/shared-ui.js)
   ============================================================ */

// URL de API: usa ruta relativa para funcionar en cualquier dominio
// Solo usar URL absoluta en dev local directo (sin nginx).
// En staging/prod con HTTPS o nginx, usar ruta relativa.
const isLocalDev = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.protocol === 'http:';
const API = isLocalDev ? 'http://localhost:3000/api/v1' : '/api/v1';
let patientId=null,patientData=null,moodChart=null,authToken=null;
let taskFilter='pending';
let taskCache=[];
let deferredInstallPrompt=null;
let isSubmittingCheckin=false;
const OFFLINE_COMPLETIONS_KEY='coter_patient_pending_completions';
let sseConnection=null;
let sseReconnectTimer=null;
let sseBackoffMs=0;

// ═══════════════════════════════════════════════════════════
// ANIMACIONES Y MICRO-INTERACCIONES
// ═══════════════════════════════════════════════════════════

function animateCounter(el, target, duration = 600) {
  const start = parseInt(el.textContent) || 0;
  if (start === target || isNaN(target)) return;
  const startTime = performance.now();
  const diff = target - start;
  
  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(start + diff * eased);
    el.textContent = current;
    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      el.textContent = target;
      el.style.animation = 'none';
      el.offsetHeight;
      el.style.animation = 'countPop .3s ease';
    }
  }
  requestAnimationFrame(update);
}

// La conexión se mantiene solo durante la sesión del navegador. El cookie httpOnly
// sigue siendo la credencial principal; no guardamos identidad clínica en localStorage.
const saved=sessionStorage.getItem('patientConnection') || localStorage.getItem('patientConnection');
if(saved){try{patientData=JSON.parse(saved);patientId=patientData.patient_id;authToken=patientData.auth_token||null;sessionStorage.setItem('patientConnection',saved);localStorage.removeItem('patientConnection');showMainScreen();loadEverything();}catch(e){sessionStorage.removeItem('patientConnection');localStorage.removeItem('patientConnection');}}

function updateSlider(id){
  const input=document.getElementById(id);
  const output=document.getElementById(id+'Val');
  if(!input||!output)return;
  const value=input.value;
  output.textContent=value+'/10';
  input.setAttribute('aria-valuenow',value);
  input.setAttribute('aria-valuetext',value+'/10 — '+(id==='mood'?'ánimo':id==='anxiety'?'ansiedad':'energía'));
}

async function connect(){
  const code=document.getElementById('codeInput').value.trim().toUpperCase();
  if(!code)return toastMsg('Ingresa el código de acceso','error');
  try{
    const r=await fetch(`${API}/patients/connect`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({connection_code:code})});
    const d=await r.json();
    if(d.success){patientData={...d};patientId=d.patient_id;authToken=d.auth_token;const stored={...d};delete stored.auth_token;sessionStorage.setItem('patientConnection',JSON.stringify(stored));showMainScreen();loadEverything();toastMsg(`¡Conectado con ${d.therapist.name}!`);}
    else toastMsg(d.error||'Código inválido','error');
  }catch(e){toastMsg('Error de conexión con el servidor','error');}
}

function showMainScreen(){
  document.getElementById('connectScreen').classList.add('hidden');
  document.getElementById('mainScreen').classList.remove('hidden');
  document.getElementById('therapistName').textContent=patientData.therapist.name;
  document.body.classList.add('patient-active');
}

function showConnectScreen(){
  disconnectSSE();
  sessionStorage.removeItem('patientConnection');
  localStorage.removeItem('patientConnection');
  patientId=null; patientData=null; authToken=null;
  document.getElementById('mainScreen')?.classList.add('hidden');
  document.getElementById('connectScreen')?.classList.remove('hidden');
  toastMsg('Tu sesión ha caducado. Vuelve a conectar tu espacio','error');
}

function registerPatientServiceWorker(){
  if('serviceWorker' in navigator){ navigator.serviceWorker.register('/patient-sw.js').catch(()=>{}); }
  window.addEventListener('beforeinstallprompt',function(e){
    e.preventDefault(); deferredInstallPrompt=e;
    document.getElementById('installBanner')?.classList.remove('hidden');
  });
}

async function installPatientApp(){
  if(!deferredInstallPrompt)return;
  deferredInstallPrompt.prompt();
  try{await deferredInstallPrompt.userChoice;}catch(e){}
  deferredInstallPrompt=null;
  document.getElementById('installBanner')?.classList.add('hidden');
}

async function loadEverything(){
  registerPatientServiceWorker();
  syncOfflineCompletions();
  loadMessages();loadTasks();loadGoals();loadStats();loadNotifications();loadProgress();
  updateDailySummary();
  // Polling lento solo para stats y progreso (visual; los mensajes y notificaciones
  // llegan por SSE en tiempo real — ver connectSSE). El dashboard del paciente es
  // mayormente estático y un refresco cada 30s es suficiente para mantener
  // streak/contadores al día cuando no entran eventos SSE.
  setInterval(loadStats,30000);
  setInterval(loadProgress,60000);
  connectSSE();

  // Inicializar notificaciones push nativas (Capacitor)
  try {
    if (window.CoterPush && typeof window.CoterPush.init === 'function') {
      window.CoterPush.init({
        patientId: patientId,
        apiBase: API,
        onToken: function (token) { console.log('[patient] FCM token:', token); },
        onNotification: function (data) {
          if (data && data.source === 'tap') { loadMessages(); loadTasks(); }
        }
      });
    }
  } catch (e) {
    console.warn('[patient] Push notifications not available:', e.message);
  }
}

// ─── SSE — Real-time stream ───────────────────────────────────────────
//
// Sustituye el polling de mensajes (4s) y notificaciones (15s) por un único
// stream abierto que nos entrega eventos del terapeuta en milisegundos.
//
// Auth pattern (defendido en utils/eventBus.js + routes/events.js):
//  • POST /events/ticket/patient/:patientId con el auth_token en header → ticket
//  • GET /events?ticket=UUID → stream SSE (el token NUNCA va en la URL).
//
// Reconexión: EventSource reconecta solo en errores transitorios (3s por
// defecto del navegador). Pero si el backend rechaza el ticket, el navegador
// NO reconecta, así que necesitamos un loop manual con backoff exponencial
// para el caso "auth del ticket falló".
function disconnectSSE() {
  if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer=null; }
  if (sseConnection) { try { sseConnection.close(); } catch(e){} sseConnection=null; }
  sseBackoffMs = 0;
}

async function connectSSE() {
  if (!patientId) return;
  disconnectSSE();
  try {
    // 1) Pedir un ticket de un solo uso al backend (auth normal con Bearer)
    const r = await fetch(API + '/events/ticket/patient/' + patientId, {
      method: 'POST',
      credentials: 'include',
      headers: authHeaders(false)
    });
    const d = await r.json();
    if (!d || !d.success || !d.ticket) {
      // Si falla el ticket, no es un error fatal: los 4 endpoints REST siguen
      // funcionando. Volvemos a intentar con backoff para no spammear.
      scheduleSSEReconnect();
      return;
    }
    // 2) Abrir el stream. Nótese: el ticket viaja en query pero es efímero.
    sseConnection = new EventSource(API + '/events?ticket=' + encodeURIComponent(d.ticket));
    sseBackoffMs = 0; // éxito → resetea el backoff

    sseConnection.addEventListener('connected', () => {
      // Handshake recibido. Re-fetch mensajes y notificaciones por si el SSE
      // quedó caído durante un rato y entramos a la conexión sin historial.
      loadMessages();
      loadNotifications();
    });

    sseConnection.onmessage = (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch (e) { return; }
      handleSSEEvent(payload);
    };

    sseConnection.onerror = () => {
      // EventSource ya intenta reconectar solo (3s). No hace falta hacer nada.
      // Si el ticket fue rechazado por el servidor (401), EventSource NO
      // reconecta y entra en loop de errores. En ese caso el listener queda
      // muerto y necesitamos reabrir la conexión desde cero con un ticket
      // nuevo. Detectamos el caso via readyState=CLOSED.
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
  if (sseReconnectTimer) return; // ya programado
  sseBackoffMs = sseBackoffMs ? Math.min(sseBackoffMs * 2, 30000) : 2000;
  sseReconnectTimer = setTimeout(() => { sseReconnectTimer=null; connectSSE(); }, sseBackoffMs);
}

function handleSSEEvent(payload) {
  const type = payload && payload.type;
  const data = (payload && payload.data) || {};
  if (!type) return;
  switch (type) {
    case 'message:new':
      // El terapeuta envió un mensaje o nosotros mismos en otra pestaña.
      loadMessages();
      if (data.from === 'therapist') {
        toastMsg('💬 Nuevo mensaje de tu terapeuta');
      }
      break;
    case 'notification:new':
      // Cualquier notificación — refresca lista y badge; toast sólo si es del
      // terapeuta o del sistema, no si es un reminder de tarea propia.
      loadNotifications();
      if (data.type && ['message', 'assignment', 'goal', 'system'].indexOf(data.type) !== -1) {
        toastMsg('🔔 ' + (data.title || 'Nueva notificación'));
      }
      break;
    case 'task:assigned':
      // El terapeuta asignó una nueva tarea; refresca lista y stats.
      loadTasks();
      loadStats();
      break;
    case 'goal:new':
      loadGoals();
      break;
    case 'connection:terminated':
      // El terapeuta terminó la conexión — cerramos nuestra SSE y bloqueamos
      // el envío de mensajes. Coincide con el caso POST /messages que rebota
      // con 400; el frontend ya muestra toast de error desde sendMessage.
      disconnectSSE();
      toastMsg('Tu terapeuta terminó la conexión', 'error');
      break;
    // Otros tipos (checkin:new, task:completed, note:created) no son relevantes
    // para el paciente y se ignoran silenciosamente.
  }
}

function authHeaders(includeContentType=true){
  const headers={};
  if(includeContentType)headers['Content-Type']='application/json';
  if(authToken)headers.Authorization=`Bearer ${authToken}`;
  return headers;
}

async function authFetch(url, opts={}){
  const response=await fetch(url,{...opts,credentials:'include',headers:{...authHeaders(!(opts.body instanceof FormData)),...(opts.headers||{})}});
  if((response.status===401||response.status===403) && patientId && !url.includes('/logout')){
    showConnectScreen();
  }
  return response;
}

async function sendCheckin(){
  if(isSubmittingCheckin)return;
  const mood=+document.getElementById('mood').value;
  const anxiety=+document.getElementById('anxiety').value;
  const energy=+document.getElementById('energy').value;
  const sleepHours=document.getElementById('sleepHours')?.value;
  const sleepQuality=document.getElementById('sleepQuality')?.value;
  const thoughts=document.getElementById('thoughts').value.trim();
  const emotions=[...document.querySelectorAll('#emotionOptions input:checked')].map(input=>input.value);
  if(![mood,anxiety,energy].every(v=>Number.isInteger(v)&&v>=1&&v<=10))return toastMsg('Revisa los valores del check-in','error');
  if(sleepHours!=='' && (Number(sleepHours)<0||Number(sleepHours)>24))return toastMsg('Las horas de sueño deben estar entre 0 y 24','error');
  isSubmittingCheckin=true;
  const button=document.querySelector('[data-action="send-checkin"]');
  if(button){button.disabled=true;button.textContent='Guardando…';}
  const payload={mood,anxiety,energy,thoughts,emotions};
  if(sleepHours!=='')payload.sleep_hours=Number(sleepHours);
  if(sleepQuality!=='')payload.sleep_quality=Number(sleepQuality);
  try{
    const r=await authFetch(`${API}/patients/${patientId}/check-ins`,{method:'POST',body:JSON.stringify(payload)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||d.success===false)return toastMsg(d.error||'No se pudo enviar el check-in','error');
    toastMsg(d.duplicate?'Este check-in ya estaba guardado':'✅ Check-in enviado a tu terapeuta');
    document.getElementById('thoughts').value='';
    document.querySelectorAll('#emotionOptions input').forEach(input=>{input.checked=false;});
    if(document.getElementById('sleepHours'))document.getElementById('sleepHours').value='';
    if(document.getElementById('sleepQuality'))document.getElementById('sleepQuality').value='';
    updateThoughtsCount();
    loadStats();loadProgress();updateDailySummary();
  }catch(e){toastMsg('Error de conexión. Inténtalo de nuevo','error');}
  finally{isSubmittingCheckin=false;if(button){button.disabled=false;button.textContent='Enviar check-in';}}
}

function updateThoughtsCount(){
  const input=document.getElementById('thoughts');
  const count=document.getElementById('thoughtsCount');
  if(input&&count)count.textContent=input.value.length+'/2000';
}

function updateDailySummary(){
  const title=document.getElementById('dailySummaryTitle');
  const text=document.getElementById('dailySummaryText');
  const action=document.querySelector('[data-action="summary-action"]');
  if(!title||!text)return;
  const pending=taskCache.filter(t=>t.status!=='completed');
  const overdue=pending.filter(t=>t.due_date&&new Date(t.due_date)<new Date()).length;
  if(overdue){title.textContent='Tienes algo urgente';text.textContent=overdue===1?'Hay una tarea vencida que puedes revisar.':`Tienes ${overdue} tareas vencidas que puedes revisar.`;}
  else if(pending.length){title.textContent='Un paso cada vez';text.textContent=pending.length===1?'Tienes 1 tarea pendiente para hoy.':`Tienes ${pending.length} tareas pendientes para continuar.`;}
  else {title.textContent='Todo al día';text.textContent='No tienes tareas pendientes. También puedes registrar cómo te sientes.';}
  if(action)action.textContent=pending.length?'Ver tareas':'Hacer check-in';
}

function focusSummaryAction(){
  const pending=taskCache.some(t=>t.status!=='completed');
  document.getElementById(pending?'tasksCard':'checkinCard')?.scrollIntoView({behavior:'smooth',block:'start'});
}

async function loadMessages(){
  try{
    const r=await authFetch(`${API}/patients/${patientId}/messages`);const d=await r.json();
    const box=document.getElementById('chatBox');
    const unreadLabel=document.getElementById('chatUnreadLabel');
    if(unreadLabel){unreadLabel.classList.toggle('hidden',!(d.newly_read_count>0));}
    const msgs=(d.messages||[]).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
    if(!msgs.length){renderEmptyState(box,{icon:'💬',title:'Sin mensajes aún',desc:'Escribe el primer mensaje para empezar la conversación con tu terapeuta.',cta:'Ir al chat',ctaAction:()=>document.getElementById('msgInput')?.focus()});return;}
    let lastDay='';
    box.innerHTML=msgs.map((m,i)=>{
      const date=new Date(m.created_at);const day=date.toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'});
      const separator=day!==lastDay?`<div class="chat-date">${sanitizeHTML(day)}</div>`:'';lastDay=day;
      return separator+`<div class="msg ${m.is_therapist?'therapist':'patient'}" style="animation-delay:${Math.min(i*.03,.3)}s"><strong>${sanitizeHTML(m.is_therapist?patientData.therapist.name:'Tú')}</strong><div class="msg-body">${sanitizeHTML(m.message)}</div><div class="msg-time">${date.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}</div></div>`;
    }).join('');
    box.scrollTop=box.scrollHeight;
  }catch(e){}
}

async function sendMessage(){
  const input=document.getElementById('msgInput');const msg=input.value.trim();
  if(!msg)return;
  try{
    const r=await authFetch(`${API}/patients/${patientId}/messages`,{method:'POST',body:JSON.stringify({message:msg})});
    const d=await r.json();
    // FIX: detectar rechazo del backend (ej: status='inactive' tras disconnect)
    // y avisar al paciente en vez de pretender que el mensaje salió.
    // Antes este fetch ignoraba la respuesta, vaciaba el input y llamaba
    // loadMessages; el paciente creía que lo había enviado cuando realmente
    // el backend lo rechazó con 400 "Paciente no conectado".
    if(!r.ok||!d.success)return toastMsg(d.error||'No se pudo enviar el mensaje','error');
    input.value='';loadMessages();
  }catch(e){toastMsg('Error de conexión','error');}
}

function getOfflineCompletionIds(){
  try{
    const values=JSON.parse(sessionStorage.getItem(OFFLINE_COMPLETIONS_KEY)||'[]');
    return Array.isArray(values)?values.filter(value=>typeof value==='string'):[];
  }catch(e){return [];}
}

function saveOfflineCompletion(id){
  const ids=new Set(getOfflineCompletionIds());ids.add(String(id));
  sessionStorage.setItem(OFFLINE_COMPLETIONS_KEY,JSON.stringify([...ids]));
}

async function syncOfflineCompletions(){
  if(!navigator.onLine||!patientId)return;
  const pending=getOfflineCompletionIds();
  if(!pending.length)return;
  const remaining=[];
  for(const id of pending){
    try{
      const response=await authFetch(`${API}/patients/${patientId}/assignments/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify({completed:true})});
      if(!response.ok&&response.status!==404)remaining.push(id);
    }catch(e){remaining.push(id);}
  }
  if(remaining.length)sessionStorage.setItem(OFFLINE_COMPLETIONS_KEY,JSON.stringify(remaining));
  else sessionStorage.removeItem(OFFLINE_COMPLETIONS_KEY);
  loadTasks();loadStats();updateDailySummary();
}

async function loadTasks(){
  try{
    const query=taskFilter==='all'?'?status=all':'';
    const r=await authFetch(`${API}/patients/${patientId}/assignments${query}`);const d=await r.json();
    const list=document.getElementById('tasksList');
    taskCache=d.assignments||[];
    list.innerHTML='';
    const offlineIds=new Set(getOfflineCompletionIds());
    const isDone=t=>t.status==='completed'||offlineIds.has(String(t.id));
    const visibleTasks=taskFilter==='all'?taskCache:taskCache.filter(t=>!isDone(t));
    const countLabel=document.getElementById('taskCountLabel');
    const pendingCount=taskCache.filter(t=>!isDone(t)).length;
    if(countLabel)countLabel.textContent=pendingCount?`${pendingCount} pendiente(s)`:'';
    updateDailySummary();
    if(!visibleTasks.length){renderEmptyState(list,{icon:taskFilter==='all'?'📋':'✅',title:taskFilter==='all'?'Aún no hay tareas':'Sin tareas pendientes',desc:taskFilter==='all'?'Aquí aparecerá tu historial de tareas.':'Tu terapeuta te asignará ejercicios y tareas para trabajar entre sesiones.'});return;}
    const now=new Date();
    visibleTasks.forEach((t, i)=>{
      const card=document.createElement('div');card.className='task-item';card.dataset.taskId=t.id;
      let dueClass='',dueLabelHtml='';
      const isCompleted=isDone(t);const isOfflineCompleted=!isCompleted?false:offlineIds.has(String(t.id));
      if(t.due_date){const due=new Date(t.due_date);const hoursLeft=(due-now)/(1000*60*60);if(isCompleted)dueLabelHtml=`<div class="due-label completed">${isOfflineCompleted?'⏳ Guardada sin conexión':'✅ Completada'}</div>`;else if(hoursLeft<0){dueClass='task-overdue';dueLabelHtml=`<div class="due-label overdue">⚠️ Vencida · ${due.toLocaleDateString('es-ES')}</div>`;}else if(hoursLeft<=24){dueClass='task-due-today';dueLabelHtml=`<div class="due-label due-today">⏰ Vence hoy</div>`;}else dueLabelHtml=`<div class="due-label due-future">📅 Vence: ${due.toLocaleDateString('es-ES')}</div>`;}
      else if(isCompleted)dueLabelHtml=`<div class="due-label completed">${isOfflineCompleted?'⏳ Guardada sin conexión':'✅ Completada'}</div>`;
      card.classList.add(dueClass);
      const head=document.createElement('div');head.innerHTML=`<div class="task-title">${sanitizeHTML(t.title)}</div>${dueLabelHtml}`;card.appendChild(head);
      if(t.instructions){const ins=document.createElement('div');ins.className='task-instructions';ins.textContent=t.instructions;card.appendChild(ins);}
      const isClinical=window.ExerciseForms&&typeof window.ExerciseForms.isClinicalKind==='function'?window.ExerciseForms.isClinicalKind(t.exercise_kind):(t.exercise_kind&&t.exercise_kind!=='classic');
      if(isCompleted){card.classList.add('task-completed');if(isOfflineCompleted)card.classList.add('task-offline');}
      else if(isClinical){const formMount=document.createElement('div');formMount.className='exercise-form-mount';card.appendChild(formMount);if(window.ExerciseForms&&typeof window.ExerciseForms.mountInteractiveCard==='function')window.ExerciseForms.mountInteractiveCard(formMount,t,t.latest_session||null,{patientId,authToken,apiBase:API,onSaved:()=>{},onCompleted:()=>{toastMsg('✅ Ejercicio finalizado. Tu terapeuta ya puede ver tus respuestas.');loadTasks();loadStats();}});}
      else if(window.InteractiveWidgets&&window.InteractiveWidgets.isWidgetTemplate(t.title,t.category)){const widgetMount=document.createElement('div');widgetMount.className='iw-widget-mount';card.appendChild(widgetMount);if(typeof window.InteractiveWidgets.render==='function')window.InteractiveWidgets.render(widgetMount,t,{patientId,authToken,apiBase:API,onCompleted:function(data){const widgetKind=window.InteractiveWidgets.getWidgetKind?window.InteractiveWidgets.getWidgetKind(t.title):'widget_unknown';authFetch(API+'/patients/'+patientId+'/widget-complete',{method:'POST',body:JSON.stringify({assignment_id:t.id,exercise_kind:widgetKind,widget_responses:data})}).then(function(r){if(r.ok){if(window.InteractiveWidgets.clearWidgetState)window.InteractiveWidgets.clearWidgetState(t.id);toastMsg('🎉 ¡Ejercicio completado y guardado!');loadTasks();loadStats();}else toastMsg('No se pudo guardar el ejercicio','error');}).catch(function(){toastMsg('Sin conexión: no se pudo sincronizar','error');});}});}
      else{const btn=document.createElement('button');btn.className='btn btn-s btn-complete-task';btn.dataset.taskId=t.id;btn.textContent='✅ Marcar completada';card.appendChild(btn);}
      list.appendChild(card);card.style.animationDelay=(i*.04)+'s';
    });
  }catch(e){}
}

async function completeTask(id){
  // Legacy path: solo aplica a tareas classic. En offline guardamos únicamente
  // el UUID de la asignación; nunca instrucciones, reflexiones ni respuestas.
  if(!navigator.onLine){saveOfflineCompletion(id);toastMsg('Tarea guardada. Se sincronizará al recuperar conexión');loadTasks();updateDailySummary();return;}
  try{
    const response=await authFetch(`${API}/patients/${patientId}/assignments/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify({completed:true})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||data.success===false)return toastMsg(data.error||'No se pudo completar la tarea','error');
    toastMsg('🎉 ¡Tarea completada!');
    loadTasks();loadStats();loadProgress();
  }catch(e){saveOfflineCompletion(id);toastMsg('Sin conexión: la tarea se sincronizará después');loadTasks();updateDailySummary();}
}

async function loadGoals(){
  try{
    const r=await authFetch(`${API}/patients/${patientId}/goals`);const d=await r.json();
    const list=document.getElementById('goalsList');
    if(!d.goals?.length){renderEmptyState(list,{icon:'🎯',title:'Sin objetivos definidos',desc:'Tu terapeuta establecerá metas terapéuticas para seguir tu progreso.'});return;}
    list.innerHTML=d.goals.map((g,i)=>{const pct=Math.min(100,Math.round((g.current_value/g.target_value)*100));return`<div class="goal-item" style="animation-delay:${i*.04}s"><strong>${sanitizeHTML(g.title)}</strong><br><small>${sanitizeHTML(g.metric)}: ${g.current_value}/${g.target_value}</small><div class="progress-bar"><div class="progress-fill" data-width="${pct}"></div></div></div>`;}).join('');
    // Apply progress bar widths after render
    requestAnimationFrame(()=>{
      document.querySelectorAll('.progress-fill[data-width]').forEach(el=>{el.style.width=el.dataset.width+'%';});
    });
  }catch(e){}
}

async function loadStats(){
  try{
    const r=await authFetch(`${API}/patients/${patientId}/check-ins`);const d=await r.json();
    const checkIns=d.check_ins||[];
    const streak = calcStreak(checkIns);
    animateCounter(document.getElementById('streakDays'), streak);
    if(checkIns.length){const recent=checkIns.slice(0,7);document.getElementById('avgMood').textContent=(recent.reduce((s,c)=>s+c.mood,0)/recent.length).toFixed(1);}
    const tr=await authFetch(`${API}/patients/${patientId}/assignments?status=all`);const td=await tr.json();
    taskCache=td.assignments||taskCache;
    const done = taskCache.filter(t=>t.status==='completed').length;
    animateCounter(document.getElementById('tasksDone'), done);
    updateMoodChart(checkIns);
    const chartSummary=document.getElementById('chartSummary');
    if(chartSummary){
      if(!checkIns.length)chartSummary.textContent='Todavía no hay registros. Tu primer check-in aparecerá aquí.';
      else if(checkIns.length===1)chartSummary.textContent='Ya tienes tu primer registro. Continúa a tu ritmo para identificar tendencias.';
      else {const recent=checkIns.slice(0,7);const moodAvg=(recent.reduce((s,c)=>s+c.mood,0)/recent.length).toFixed(1);const anxietyAvg=(recent.reduce((s,c)=>s+c.anxiety,0)/recent.length).toFixed(1);chartSummary.textContent=`Últimos registros: ánimo ${moodAvg}/10 · ansiedad ${anxietyAvg}/10.`;}
    }
    updateDailySummary();
  }catch(e){}
}

function calcStreak(checkIns){
  let streak=0;const sorted=[...checkIns].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const today=new Date();today.setHours(0,0,0,0);
  for(let i=0;i<sorted.length;i++){const d=new Date(sorted[i].created_at);d.setHours(0,0,0,0);const exp=new Date(today);exp.setDate(exp.getDate()-streak);if(d.getTime()===exp.getTime())streak++;else if(d.getTime()<exp.getTime())break;}
  return streak;
}

function updateMoodChart(checkIns){
  const ctx=document.getElementById('moodChart');if(moodChart)moodChart.destroy();
  if(!checkIns.length)return;
  const data=[...checkIns].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)).slice(-14);
  moodChart=new Chart(ctx,{type:'line',data:{labels:data.map(c=>new Date(c.created_at).toLocaleDateString('es-ES',{day:'numeric',month:'short'})),datasets:[
    {label:'Ánimo',data:data.map(c=>c.mood),borderColor:'#6366f1',backgroundColor:'rgba(99,102,241,.1)',tension:.4,fill:true},
    {label:'Ansiedad',data:data.map(c=>c.anxiety),borderColor:'#ef4444',backgroundColor:'rgba(239,68,68,.1)',tension:.4,fill:true}
  ]},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{min:1,max:10}}}});
}

function startTechnique(type){
  const techniques={
    breath:{title:'🫁 Respiración 4-7-8',html:`<div class="technique-content"><p>Inhala por la nariz durante <b>4 segundos</b></p><p>Mantén la respiración <b>7 segundos</b></p><p>Exhala lentamente por la boca durante <b>8 segundos</b></p><br><div class="breath-count" id="breathCount">4</div><p class="technique-hint">Repite 4 ciclos</p></div>`,timer:120},
    mindfulness:{title:'🧠 Mindfulness 5 min',html:`<div class="technique-content"><p>Siéntate cómodamente y cierra los ojos</p><p>Concéntrate en tu <b>respiración natural</b></p><p>Nota cómo el aire entra y sale</p><p>Si tu mente divaga, vuelve suavemente a la respiración</p><br><div class="mind-timer" id="mindTimer">5:00</div></div>`,timer:300},
    grounding:{title:'🌍 Grounding 5-4-3-2-1',html:`<div class="technique-content"><p>Mira a tu alrededor y nombra:</p><p><b>5</b> cosas que puedes VER</p><p><b>4</b> cosas que puedes TOCAR</p><p><b>3</b> sonidos que puedes OÍR</p><p><b>2</b> olores que puedes OLER</p><p><b>1</b> sabor que puedes SABOREAR</p></div>`,timer:180},
    gratitude:{title:'🙏 Gratitud',html:`<div class="technique-content"><p>Piensa en <b>3 cosas</b> por las que estás agradecid@ hoy</p><p>Pueden ser grandes o pequeñas</p><p>Escríbelas mentalmente con detalle</p><br><p class="technique-hint">Tómate tu tiempo para sentir la gratitud</p></div>`,timer:120}
  };
  const t=techniques[type];
  Swal.fire({title:t.title,html:t.html,timer:t.timer*1000,timerProgressBar:true,showConfirmButton:true,confirmButtonText:'Terminar',confirmButtonColor:'#6366f1',
    didOpen:()=>{
      if(type==='breath'){let phase=0,count=4;const phases=[4,7,8];const el=document.getElementById('breathCount');const iv=setInterval(()=>{el.textContent=count;el.style.color=count<=4?'#6366f1':count<=7?'#8b5cf6':'#10b981';count--;if(count<0){phase=(phase+1)%3;count=phases[phase];}},1000);}
      if(type==='mindfulness'){const el=document.getElementById('mindTimer');const iv=setInterval(()=>{const left=Math.ceil(Swal.getTimerLeft()/1000);const m=Math.floor(left/60);const s=left%60;el.textContent=`${m}:${s.toString().padStart(2,'0')}`;if(left<=0)clearInterval(iv);},1000);}
    },willClose:()=>toastMsg(`✅ ${t.title.split(' ').slice(0,2).join(' ')} completada`)});
}

async function disconnect(){if(confirm('¿Desconectarte de tu terapeuta?')){try{await authFetch(`${API}/patients/${patientId}/logout`,{method:'POST'});}catch(e){}disconnectSSE();sessionStorage.removeItem('patientConnection');localStorage.removeItem('patientConnection');location.reload();}}

// ─── RGPD: exportación y borrado de datos ──────────────────────
async function exportMyData(){
  try{
    const r=await authFetch(`${API}/patients/${patientId}/export`);
    if(!r.ok){const d=await r.json().catch(()=>({}));return toastMsg(d.error||'No se pudo exportar tus datos','error');}
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=`coter-datos-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),2000);
    toastMsg('✅ Copia de tus datos descargada');
  }catch(e){toastMsg('Error de conexión. Inténtalo de nuevo','error');}
}

async function deleteMyData(){
  const {value:confirmText}=await Swal.fire({
    title:'¿Borrar todos tus datos?',
    html:'Esta acción <strong>no se puede deshacer</strong>: se eliminarán tus check-ins, mensajes, tareas, objetivos y toda tu información, y tu terapeuta será notificado.<br><br>Escribe <strong>BORRAR</strong> para confirmar:',
    input:'text',
    inputPlaceholder:'BORRAR',
    inputAttributes:{autocapitalize:'characters',maxlength:'20'},
    showCancelButton:true,
    confirmButtonText:'Eliminar definitivamente',
    cancelButtonText:'Cancelar',
    confirmButtonColor:'#ef4444',
    allowOutsideClick:false,
  });
  if(!confirmText)return;
  try{
    const r=await authFetch(`${API}/patients/${patientId}/delete`,{method:'POST',body:JSON.stringify({confirm:confirmText})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.success)return toastMsg(d.error||'No se pudo eliminar tus datos','error');
    disconnectSSE();
    sessionStorage.removeItem('patientConnection');
    localStorage.removeItem('patientConnection');
    await Swal.fire({title:'Datos eliminados',text:'Tu información ha sido eliminada. Gracias por usar Coter.',icon:'success'});
    location.reload();
  }catch(e){toastMsg('Error de conexión. Inténtalo de nuevo','error');}
}

async function loadProgress(){
  try{
    const r=await authFetch(`${API}/patients/${patientId}/progress`);const d=await r.json();
    if(!d.success)return;
    const p=d.progress;
    const ach=document.getElementById('progressAchievements');
    const badges=ach.querySelectorAll('.progress-badge-value');
    badges[0].textContent=p.achievements.streakDays||0;
    badges[1].textContent=p.achievements.totalCheckins||0;
    badges[2].textContent=`${p.achievements.completedTasks||0}/${p.achievements.totalTasks||0}`;
    badges[3].textContent=`${p.achievements.completedGoals||0}/${p.achievements.totalGoals||0}`;
    const weekly=document.getElementById('progressWeekly');
    if(!p.weeklyTrends?.length){weekly.innerHTML='<p class="progress-empty">Sin datos aún</p>';}
    else{
      weekly.innerHTML=p.weeklyTrends.map((w,i)=>{
        const prev=p.weeklyTrends[i+1];
        let arrow='',arrowClass='neutral';
        if(prev&&prev.avg_mood){
          const diff=w.avg_mood-prev.avg_mood;
          if(diff>=0.4){arrow='↑';arrowClass='up';}
          else if(diff<=-0.4){arrow='↓';arrowClass='down';}
          else{arrow='→';}
        }
        return`<div class="progress-week"><div class="progress-week-label">${w.week.replace('Esta','')||'Actual'}</div><div class="progress-week-arrow ${arrowClass}">${arrow} ${w.avg_mood}</div><div class="progress-week-count">${w.count} check-ins</div></div>`;
      }).join('');
    }
    const noteDiv=document.getElementById('progressNote');
    if(p.latestNote){
      noteDiv.classList.remove('hidden');
      noteDiv.innerHTML=`<div class="progress-note-label">📝 Resumen de tu terapeuta</div><div>"${sanitizeHTML(p.latestNote.excerpt)}"</div><div class="progress-note-date">${new Date(p.latestNote.date).toLocaleDateString('es-ES')} · ${p.totalNotes||0} nota(s) clínica(s)</div>`;
    }else{noteDiv.classList.add('hidden');}
    const tl=document.getElementById('progressTimeline');
    if(!p.timeline?.length){tl.innerHTML='';return;}
    tl.innerHTML=p.timeline.map((t,i)=>{
      const iconMap={checkin:'🌤️',task_done:'✅',goal_done:'🎯'};
      const icon=iconMap[t.type]||'📌';
      const date=new Date(t.date);
      const timeStr=date.toLocaleDateString('es-ES')===new Date().toLocaleDateString('es-ES')
        ?date.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})
        :date.toLocaleDateString('es-ES',{day:'numeric',month:'short'});
      return`<div class="progress-timeline-item" style="animation-delay:${i*.04}s"><span class="progress-timeline-icon">${icon}</span><span>${sanitizeHTML(t.summary)}</span><span class="progress-timeline-date">${timeStr}</span></div>`;
    }).join('');
  }catch(e){console.error('Progress error:',e);}
}

async function loadNotifications(){
  try{
    const r=await authFetch(`${API}/patients/${patientId}/notifications`);const d=await r.json();
    if(!d.success)return;
    const badge=document.getElementById('notifBadge');
    const count=d.unread_count||0;
    if(count>0){badge.textContent=count>99?'99+':count;badge.classList.remove('hidden');}
    else{badge.classList.add('hidden');}
    renderNotifications(d.notifications||[]);
  }catch(e){}
}

function renderNotifications(notifs){
  const list=document.getElementById('notifList');
  if(!notifs.length){list.innerHTML='<div class="empty-state" style="padding:28px 16px"><span class="empty-icon">🔔</span><div class="empty-title">Sin notificaciones</div><div class="empty-desc">Aquí aparecerán avisos de tu terapeuta y recordatorios.</div></div>';return;}    list.innerHTML=notifs.map((n,i)=>{
    const iconMap={assignment:'📋',message:'💬',reminder:'⏰',overdue:'⚠️',goal:'🎯',system:'ℹ️'};
    const icon=iconMap[n.type]||'📌';
    const time=new Date(n.created_at);
    const timeStr=time.toLocaleDateString('es-ES')==new Date().toLocaleDateString('es-ES')
      ?time.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})
      :time.toLocaleDateString('es-ES',{day:'numeric',month:'short'});
    return`<div class="notif-item${n.is_read?'':' unread'}" data-notif-id="${n.id}" style="animation:fadeInUp .3s cubic-bezier(.22,1,.36,1) ${i*.03}s both"><div class="notif-icon">${icon}</div><div class="notif-content"><div class="notif-title">${sanitizeHTML(n.title)}</div><div class="notif-message">${sanitizeHTML(n.message)}</div><div class="notif-time">${timeStr}</div></div></div>`;
  }).join('');
}

function toggleNotifications(){
  const panel=document.getElementById('notifPanel');
  const notifBar=document.querySelector('.notif-bar');
  panel.classList.toggle('show');
  const isOpen=panel.classList.contains('show');
  if(notifBar)notifBar.setAttribute('aria-expanded',isOpen?'true':'false');
  if(isOpen)loadNotifications();
}

async function markNotificationRead(id, el){
  try{
    await authFetch(`${API}/patients/${patientId}/notifications/${id}/read`,{method:'PUT'});
    el.classList.remove('unread');
    const badge=document.getElementById('notifBadge');
    let count=parseInt(badge.textContent)||0;
    count=Math.max(0,count-1);
    if(count>0){badge.textContent=count>99?'99+':count;}
    else{badge.classList.add('hidden');}
  }catch(e){}
}

async function markAllRead(){
  try{
    await authFetch(`${API}/patients/${patientId}/notifications/read-all`,{method:'PUT'});
    const badge=document.getElementById('notifBadge');
    badge.classList.add('hidden');
    loadNotifications();
  }catch(e){}
}

function toastMsg(text,type='success'){
  const toast=document.getElementById('toast');
  if (!toast) return;
  const el=document.getElementById('toastText');
  el.textContent=text;
  toast.className='toast'+(type==='error'?' error':'');
  toast.classList.remove('hidden','hiding');
  toast.classList.add('show');
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(()=>{
    toast.classList.add('hiding');
    setTimeout(()=>toast.classList.add('hidden'),300);
  },3000);
}

// ==================== EVENT DELEGATION ====================
// Reemplaza todos los onclick inline del HTML
document.addEventListener('click', function(e){
  // Buscar el ancestro más cercano con data-action o clase identificable
  const btn = e.target.closest('[data-action]');
  if (!btn) {
    // Delegación para elementos con clases específicas
    const notifItem = e.target.closest('.notif-item[data-notif-id]');
    if (notifItem) { markNotificationRead(notifItem.dataset.notifId, notifItem); return; }
    
    const completeBtn = e.target.closest('.btn-complete-task');
    if (completeBtn) { completeTask(completeBtn.dataset.taskId); return; }
    return;
  }
  
  const action = btn.dataset.action;
  switch(action) {
    case 'connect': connect(); break;
    case 'send-checkin': sendCheckin(); break;
    case 'send-message': sendMessage(); break;
    case 'mark-all-read': markAllRead(); break;
    case 'disconnect': disconnect(); break;
    case 'export-data': exportMyData(); break;
    case 'delete-data': deleteMyData(); break;
    case 'toggle-notifications': toggleNotifications(); break;
    case 'technique': startTechnique(btn.dataset.technique); break;
    case 'summary-action': focusSummaryAction(); break;
    case 'install-app': installPatientApp(); break;
    case 'dismiss-install': document.getElementById('installBanner')?.classList.add('hidden'); break;
    default: console.warn('Unknown data-action:', action);
  }
});

// Sliders, contador de reflexión y filtros: interacción delegada
document.addEventListener('input', function(e){
  if (e.target.dataset.slider) {
    updateSlider(e.target.dataset.slider);
    e.target.setAttribute('aria-valuenow', e.target.value);
  }
  if(e.target.id==='thoughts')updateThoughtsCount();
});

document.addEventListener('click', function(e){
  const filter=e.target.closest('[data-task-filter]');
  if(filter){
    taskFilter=filter.dataset.taskFilter;
    document.querySelectorAll('[data-task-filter]').forEach(btn=>btn.classList.toggle('active',btn===filter));
    loadTasks();
  }
});

// Enter en chat input
document.addEventListener('keypress', function(e){
  if (e.key === 'Enter' && e.target.id === 'msgInput') {
    e.preventDefault(); sendMessage();
  }
});

window.addEventListener('online',()=>{document.body.classList.remove('is-offline');toastMsg('Conexión recuperada');syncOfflineCompletions();});
window.addEventListener('offline',()=>{document.body.classList.add('is-offline');toastMsg('Sin conexión. Las tareas se guardarán para sincronizarse después','error');});
if(!navigator.onLine)document.body.classList.add('is-offline');
updateThoughtsCount();
