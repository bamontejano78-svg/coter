/* ============================================================
   Coter — JS de la app de paciente
   ============================================================ */

// URL de API: usa ruta relativa para funcionar en cualquier dominio
// Solo usar URL absoluta en dev local directo (sin nginx).
// En staging/prod con HTTPS o nginx, usar ruta relativa.
const isLocalDev = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.protocol === 'http:';
const API = isLocalDev ? 'http://localhost:3000/api/v1' : '/api/v1';
let patientId=null,patientData=null,moodChart=null,authToken=null;
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

// Sanitizar HTML para prevenir XSS en mensajes
function sanitizeHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const saved=localStorage.getItem('patientConnection');
if(saved){try{patientData=JSON.parse(saved);patientId=patientData.patient_id;authToken=patientData.auth_token;showMainScreen();loadEverything();}catch(e){localStorage.removeItem('patientConnection');}}

function updateSlider(id){document.getElementById(id+'Val').textContent=document.getElementById(id).value;}

async function connect(){
  const code=document.getElementById('codeInput').value.trim().toUpperCase();
  if(!code)return toastMsg('Ingresa el código de acceso','error');
  try{
    const r=await fetch(`${API}/patients/connect`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({connection_code:code})});
    const d=await r.json();
    if(d.success){patientData=d;patientId=d.patient_id;authToken=d.auth_token;localStorage.setItem('patientConnection',JSON.stringify(d));showMainScreen();loadEverything();toastMsg(`¡Conectado con ${d.therapist.name}!`);}
    else toastMsg(d.error||'Código inválido','error');
  }catch(e){toastMsg('Error de conexión con el servidor','error');}
}

function showMainScreen(){
  document.getElementById('connectScreen').classList.add('hidden');
  document.getElementById('mainScreen').classList.remove('hidden');
  document.getElementById('therapistName').textContent=patientData.therapist.name;
}

async function loadEverything(){
  loadMessages();loadTasks();loadGoals();loadStats();loadNotifications();loadProgress();
  // Polling lento solo para stats y progreso (visual; los mensajes y notificaciones
  // llegan por SSE en tiempo real — ver connectSSE). El dashboard del paciente es
  // mayormente estático y un refresco cada 30s es suficiente para mantener
  // streak/contadores al día cuando no entran eventos SSE.
  setInterval(loadStats,30000);
  setInterval(loadProgress,60000);
  connectSSE();
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
  if (!patientId || !authToken) return;
  disconnectSSE();
  try {
    // 1) Pedir un ticket de un solo uso al backend (auth normal con Bearer)
    const r = await fetch(API + '/events/ticket/patient/' + patientId, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + authToken }
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

function authHeaders(){return{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`};}

async function sendCheckin(){
  const payload={mood:+document.getElementById('mood').value,anxiety:+document.getElementById('anxiety').value,energy:+document.getElementById('energy').value,thoughts:document.getElementById('thoughts').value};
  await fetch(`${API}/patients/${patientId}/check-ins`,{method:'POST',headers:authHeaders(),body:JSON.stringify(payload)});
  toastMsg('✅ Check-in enviado a tu terapeuta');
  document.getElementById('thoughts').value='';
  loadStats();loadMessages();
}

async function loadMessages(){
  try{
    const r=await fetch(`${API}/patients/${patientId}/messages`,{headers:authHeaders()});const d=await r.json();
    const box=document.getElementById('chatBox');
    const msgs=(d.messages||[]).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
    if(!msgs.length){box.innerHTML='<div class="chat-empty-msg">¡Escribe el primer mensaje! ✍️</div>';return;}
    box.innerHTML=msgs.map((m,i)=>`<div class="msg ${m.is_therapist?'therapist':'patient'}" style="animation-delay:${Math.min(i*.03,.3)}s"><strong>${sanitizeHTML(m.is_therapist?patientData.therapist.name:'Tú')}</strong><div class="msg-body">${sanitizeHTML(m.message)}</div><div class="msg-time">${new Date(m.created_at).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}</div></div>`).join('');
    box.scrollTop=box.scrollHeight;
  }catch(e){}
}

async function sendMessage(){
  const input=document.getElementById('msgInput');const msg=input.value.trim();
  if(!msg)return;
  try{
    const r=await fetch(`${API}/patients/${patientId}/messages`,{method:'POST',headers:authHeaders(),body:JSON.stringify({message:msg})});
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

async function loadTasks(){
  try{
    const r=await fetch(`${API}/patients/${patientId}/assignments`,{headers:authHeaders()});const d=await r.json();
    const list=document.getElementById('tasksList');
    list.innerHTML='';
    if(!d.assignments?.length){list.innerHTML='<div class="empty-state">No tienes tareas pendientes 🎉</div>';return;}
    const now=new Date();
    d.assignments.forEach((t, i)=>{
      const card=document.createElement('div');
      card.className='task-item';
      card.dataset.taskId=t.id;
      let dueClass='',dueLabelHtml='';
      if(t.due_date){
        const due=new Date(t.due_date);
        const hoursLeft=(due-now)/(1000*60*60);
        if(hoursLeft<0){dueClass='task-overdue';dueLabelHtml=`<div class="due-label overdue">⚠️ ¡VENCIDA! ${due.toLocaleDateString('es-ES')}</div>`;}
        else if(hoursLeft<=24){dueClass='task-due-today';dueLabelHtml=`<div class="due-label due-today">⏰ Vence hoy: ${due.toLocaleDateString('es-ES')}</div>`;}
        else{dueLabelHtml=`<div class="due-label due-future">📅 Vence: ${due.toLocaleDateString('es-ES')}</div>`;}
      }
      card.classList.add(dueClass);
      // Title + kind + due label are still inline-string so the static look
      // is preserved; only the form area is substituted when exercise_kind=clinical.
      const head=document.createElement('div');
      head.innerHTML=`<div class="task-title">${sanitizeHTML(t.title)}</div>${dueLabelHtml}`;
      card.appendChild(head);
      if(t.instructions){
        const ins=document.createElement('div');
        ins.className='task-instructions';
        ins.textContent=t.instructions;
        card.appendChild(ins);
      }
      // kind clinical → renderizar formulario interactivo (form, autosave,
      // submit /complete). kind classic → botón legacy "Marcar completada".
      // Usar whitelist explícita (no heurística != 'classic') por si una BD
      // antigua tiene exercise_kind=null: cae al camino classic sin ambigüedad.
      const isClinical = window.ExerciseForms && typeof window.ExerciseForms.isClinicalKind === 'function'
        ? window.ExerciseForms.isClinicalKind(t.exercise_kind)
        : (t.exercise_kind && t.exercise_kind !== 'classic');
      if(isClinical){
        const formMount=document.createElement('div');
        formMount.className='exercise-form-mount';
        card.appendChild(formMount);
        // Helper global expuesto por /js/exercise-forms.js
        if(window.ExerciseForms && typeof window.ExerciseForms.mountInteractiveCard==='function'){
          window.ExerciseForms.mountInteractiveCard(formMount, t, t.latest_session||null, {
            patientId, authToken, apiBase: API,
            onSaved: ()=>{ /* autosave exito: nada por hacer */ },
            onCompleted: (st, data)=>{
              toastMsg('✅ Ejercicio finalizado. Tu terapeuta ya puede ver tus respuestas.');
              loadTasks(); loadStats();
            },
          });
        }else{
          formMount.textContent='(Cargando formulario clínico…)';
        }
      }else{
        const btn=document.createElement('button');
        btn.className='btn btn-s btn-complete-task';
        btn.dataset.taskId=t.id;
        btn.textContent='✅ Marcar completada';
        card.appendChild(btn);
      }
      list.appendChild(card);
      // Staggered entrance delay for each task card
      card.style.animationDelay = (i * 0.04) + 's';
    });
  }catch(e){}
}

async function completeTask(id){
  // Legacy path: solo aplica a kind='classic' (los kinds clínicos usan el
  // botón "Finalizar ejercicio" dentro del formulario interactivo, que ya
  // publica vía /sessions/:sid/complete y marca el assignment).
  await fetch(`${API}/patients/${patientId}/assignments/${id}`,{method:'PUT',headers:authHeaders(),body:JSON.stringify({completed:true})});
  toastMsg('🎉 ¡Tarea completada!');
  loadTasks();loadStats();
}

async function loadGoals(){
  try{
    const r=await fetch(`${API}/patients/${patientId}/goals`,{headers:authHeaders()});const d=await r.json();
    const list=document.getElementById('goalsList');
    if(!d.goals?.length){list.innerHTML='<div class="empty-state">Sin objetivos definidos</div>';return;}
    list.innerHTML=d.goals.map((g,i)=>{const pct=Math.min(100,Math.round((g.current_value/g.target_value)*100));return`<div class="goal-item" style="animation-delay:${i*.04}s"><strong>${sanitizeHTML(g.title)}</strong><br><small>${sanitizeHTML(g.metric)}: ${g.current_value}/${g.target_value}</small><div class="progress-bar"><div class="progress-fill" data-width="${pct}"></div></div></div>`;}).join('');
    // Apply progress bar widths after render
    requestAnimationFrame(()=>{
      document.querySelectorAll('.progress-fill[data-width]').forEach(el=>{el.style.width=el.dataset.width+'%';});
    });
  }catch(e){}
}

async function loadStats(){
  try{
    const r=await fetch(`${API}/patients/${patientId}/check-ins`,{headers:authHeaders()});const d=await r.json();
    const checkIns=d.check_ins||[];
    const streak = calcStreak(checkIns);
    animateCounter(document.getElementById('streakDays'), streak);
    if(checkIns.length){const recent=checkIns.slice(0,7);document.getElementById('avgMood').textContent=(recent.reduce((s,c)=>s+c.mood,0)/recent.length).toFixed(1);}
    const tr=await fetch(`${API}/patients/${patientId}/assignments`,{headers:authHeaders()});const td=await tr.json();
    const done = (td.assignments||[]).filter(t=>t.status==='completed').length;
    animateCounter(document.getElementById('tasksDone'), done);
    updateMoodChart(checkIns);
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

function disconnect(){if(confirm('¿Desconectarte de tu terapeuta?')){disconnectSSE();localStorage.removeItem('patientConnection');location.reload();}}

async function loadProgress(){
  try{
    const r=await fetch(`${API}/patients/${patientId}/progress`,{headers:authHeaders()});const d=await r.json();
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
    const r=await fetch(`${API}/patients/${patientId}/notifications`,{headers:authHeaders()});const d=await r.json();
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
  if(!notifs.length){list.innerHTML='<div class="notif-empty">🔔 No tienes notificaciones</div>';return;}    list.innerHTML=notifs.map((n,i)=>{
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
  panel.classList.toggle('show');
  if(panel.classList.contains('show'))loadNotifications();
}

async function markNotificationRead(id, el){
  try{
    await fetch(`${API}/patients/${patientId}/notifications/${id}/read`,{method:'PUT',headers:authHeaders()});
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
    await fetch(`${API}/patients/${patientId}/notifications/read-all`,{method:'PUT',headers:authHeaders()});
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
    case 'toggle-notifications': toggleNotifications(); break;
    case 'technique': startTechnique(btn.dataset.technique); break;
    default: console.warn('Unknown data-action:', action);
  }
});

// Sliders: monitorear inputs
document.addEventListener('input', function(e){
  if (e.target.dataset.slider) {
    updateSlider(e.target.dataset.slider);
  }
});

// Enter en chat input
document.addEventListener('keypress', function(e){
  if (e.key === 'Enter' && e.target.id === 'msgInput') {
    sendMessage();
  }
});
