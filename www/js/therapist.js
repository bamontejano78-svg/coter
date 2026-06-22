/* ============================================================
   Coter Pro — JS del panel de terapeuta
   ============================================================ */

// Solo usar URL absoluta en dev local directo (sin nginx).
// En staging/prod con HTTPS o nginx, usar ruta relativa.
const isLocalDev = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.protocol === 'http:';
const API = isLocalDev ? 'http://localhost:3000/api/v1' : '/api/v1';
let token=null,refreshToken=null,therapist=null,currentPatientId=null,patientData=null,trendChart=null;
let templates=[],templateCategories=[],activeCategory=null;
let isRefreshing=false;
let refreshPromise=null;
let patientPoll=null;

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
    el.innerHTML = Array(count).fill(`<div style="padding:12px 0;border-bottom:1px solid #f1f5f9"><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text short"></div></div>`).join('');
  } else if (type === 'table') {
    el.innerHTML = Array(count).fill(`<tr><td colspan="6"><div class="skeleton" style="height:40px"></div></td></tr>`).join('');
  }
}


// Sanitizar HTML para prevenir XSS en mensajes
function sanitizeHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function saveSession(t, rt, th){
  token=t;refreshToken=rt;therapist=th;
  localStorage.setItem('coter_therapist',JSON.stringify({token,refresh_token:rt,therapist:th}));
}

async function doLogin(){
  const email=document.getElementById('loginEmail').value.trim();
  const password=document.getElementById('loginPassword').value.trim();
  if(!email||!password)return Swal.fire('Error','Completa todos los campos','error');
  try{
    const r=await fetch(`${API}/therapists/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
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
    const r=await fetch(`${API}/therapists/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,email,specialty,password})});
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
    await fetch(`${API}/therapists/logout`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`}});
  }catch(e){}
  localStorage.removeItem('coter_therapist');
  location.reload();
}

// Refresh automático del access token
async function refreshAccessToken(){
  if (!refreshToken) throw new Error('No refresh token');
  const r=await fetch(`${API}/therapists/refresh-token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:refreshToken})});
  const d=await r.json();
  if(!d.success)throw new Error(d.error||'Refresh failed');
  token=d.token;
  refreshToken=d.refresh_token;
  // Actualizar localStorage
  const saved=JSON.parse(localStorage.getItem('coter_therapist')||'{}');
  saved.token=token;
  saved.refresh_token=refreshToken;
  localStorage.setItem('coter_therapist',JSON.stringify(saved));
  return token;
}

// Wrapper de fetch con auto-refresh en 401
async function api(url,opts={}){
  const doFetch=()=>fetch(url,{...opts,headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`,...(opts.headers||{})}});

  let r=await doFetch();

  // Si 401, intentar refrescar el token una vez
  if(r.status===401&&refreshToken){
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
  loadDashboard();loadPatients();loadCode();
  setInterval(loadDashboard,30000);
}

async function loadDashboard(){
  showSkeleton('recentActivity', 'list', 3);
  try{
    const r=await api(`${API}/therapists/dashboard`);const d=await r.json();
    if(!d.success)return;
    const db=d.dashboard;
    animateCounter(document.getElementById('statPatients'), db.activePatients);
    animateCounter(document.getElementById('statCheckins'), db.todayCheckins);
    animateCounter(document.getElementById('statTasks'), db.pendingTasks);
    animateCounter(document.getElementById('statRisk'), db.atRisk);
    updateTrendChart(db.weeklyTrend||[]);
    const act=document.getElementById('recentActivity');
    if(!db.recentActivity?.length){act.innerHTML='<p class="empty-msg">Sin actividad reciente</p>';return;}
    act.innerHTML=db.recentActivity.map((a,i)=>`<div class="recent-row" style="animation-delay:${i*50}ms"><span>${sanitizeHTML(a.patient_name||'Paciente '+a.patient_id?.slice(0,8))}</span><span>Ánimo: <strong>${a.mood}/10</strong></span><span class="recent-time">${new Date(a.created_at).toLocaleString('es-ES')}</span></div>`).join('');
  }catch(e){console.error(e);}
}

function updateTrendChart(data){
  const ctx=document.getElementById('trendChart');if(trendChart)trendChart.destroy();
  if(!data.length)return;
  trendChart=new Chart(ctx,{type:'line',data:{labels:data.map(d=>d.day),datasets:[
    {label:'Ánimo',data:data.map(d=>d.avg_mood),borderColor:'#6366f1',backgroundColor:'rgba(99,102,241,.1)',tension:.4,fill:true},
    {label:'Ansiedad',data:data.map(d=>d.avg_anxiety),borderColor:'#ef4444',backgroundColor:'rgba(239,68,68,.1)',tension:.4,fill:true}
  ]},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{min:1,max:10}}}});
}

async function loadPatients({force=false}={}){
  try{
    const patients=await PatientsCache.getPatients({force});
    const tbody=document.getElementById('patientsTableBody');
    if(!patients.length){tbody.innerHTML='<tr><td colspan="6" class="empty-cell">No tienes pacientes aún</td></tr>';return;}
    tbody.innerHTML=patients.map(p=>{
      const badge=p.last_mood<=3?'badge-risk':p.last_mood>=7?'badge-ok':'badge-warn';
      return`<tr><td><strong>${sanitizeHTML(p.name||'Anónimo')}</strong><br><small class="id-sub">${p.id?.slice(0,12)}...</small></td><td>${new Date(p.connected_at).toLocaleDateString('es-ES')}</td><td>${p.last_checkin?new Date(p.last_checkin).toLocaleDateString('es-ES'):'Nunca'}</td><td><strong>${p.last_mood||'-'}/10</strong></td><td><span class="badge ${badge}">${p.last_mood<=3?'⚠️ Riesgo':'✅ Estable'}</span></td><td><button class="btn btn-p btn-sm btn-open-patient" data-patient-id="${p.id}">📋 Ver</button></td></tr>`;
    }).join('');
  }catch(e){console.error('Error cargando pacientes:',e);}
}

async function openPatient(patientId){
  currentPatientId=patientId;document.getElementById('patientModal').classList.add('show');
  try{
    const r=await api(`${API}/therapists/patients/${patientId}`);const d=await r.json();
    if(!d.success)return Swal.fire('Error','Paciente no encontrado','error');
    patientData=d.patient;
    document.getElementById('modalPatientName').textContent=patientData.name||'Paciente '+patientId.slice(0,8);
    renderChat();renderCheckins();renderTasks();renderGoals();renderNotes();
    // FIX: polling a 4s para que los mensajes del paciente aparezcan en vivo
    // mientras el modal está abierto. Antes solo se refrescaba al abrir;
    // mensajes enviados en tiempo real quedaban invisibles hasta que el
    // terapeuta cerrara y volviera a abrir el modal o enviara él mismo.
    if(patientPoll)clearInterval(patientPoll);
    patientPoll=setInterval(async()=>{
      if(!currentPatientId)return;
      try{
        const rp=await api(`${API}/therapists/patients/${currentPatientId}`);const dp=await rp.json();
        // Comparamos por length Y por id del mensaje más reciente:
        // - length cambia si entra/sale algo de la ventana.
        // - latest.id cambia cuando llega un mensaje nuevo (o cuando un
        //   mensaje viejo cae fuera del límite de 100 en routes/therapist.js
        //   → el más nuevo se mantiene visible aunque length quede estable).
        // Antes solo comparabamos length, lo que dejaba invisibles los
        // mensajes nuevos una vez cruzada la primera centena de historial.
        if(dp.success&&dp.patient.messages&&patientData&&patientData.messages){
          const newLatest=dp.patient.messages[0]?.id;
          const oldLatest=patientData.messages[0]?.id;
          if(dp.patient.messages.length!==patientData.messages.length||newLatest!==oldLatest){
            patientData.messages=dp.patient.messages;
            renderChat();
          }
        }
      }catch(e){console.error('[patientPoll] error:',e);}
    },4000);
  }catch(e){console.error(e);}
}

function closePatientModal(){document.getElementById('patientModal').classList.remove('show');currentPatientId=null;patientData=null;if(patientPoll){clearInterval(patientPoll);patientPoll=null;}}

function renderChat(){
  const box=document.getElementById('patientChat');
  const msgs=(patientData.messages||[]).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  if(!msgs.length){box.innerHTML='<p class="empty-msg">No hay mensajes aún</p>';return;}
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
  if(!cis.length){box.innerHTML='<p class="empty-msg">Sin check-ins</p>';return;}
  box.innerHTML=cis.slice(0,30).map(c=>`<div class="checkin-item"><div class="checkin-mood" data-mood="${c.mood}">${c.mood}</div><div><strong>Ánimo ${c.mood}/10</strong> | Ansiedad ${c.anxiety}/10 | Energía ${c.energy||'-'}/10<br><small class="muted">${new Date(c.created_at).toLocaleString('es-ES')}</small>${c.thoughts?`<br><em>"${sanitizeHTML(c.thoughts)}"</em>`:''}</div></div>`).join('');
  // Apply mood colors
  document.querySelectorAll('.checkin-mood[data-mood]').forEach(el=>{
    const m=parseInt(el.dataset.mood);
    el.style.color=m<=3?'#ef4444':m>=7?'#10b981':'#f59e0b';
  });
}

function renderTasks(){
  const box=document.getElementById('patientTasks');const tasks=patientData.assignments||[];
  if(!tasks.length){box.innerHTML='<p class="empty-msg">Sin tareas asignadas</p>';return;}
  box.innerHTML=tasks.map(t=>`<div class="task-item"><strong>${sanitizeHTML(t.title)}</strong> <span class="badge ${t.status==='completed'?'badge-ok':'badge-warn'}">${t.status==='completed'?'✅ Completada':'⏳ Pendiente'}</span><br><small>${sanitizeHTML(t.instructions)}</small>${t.due_date?`<br><small>📅 Vence: ${new Date(t.due_date).toLocaleDateString('es-ES')}</small>`:''}${t.status!=='completed'?`<br><button class="btn btn-s btn-sm btn-complete-task" data-task-id="${t.id}">Marcar completada</button>`:''}</div>`).join('');
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
  if(!goals.length){box.innerHTML='<p class="empty-msg">Sin objetivos</p>';return;}
  box.innerHTML=goals.map(g=>{
    const pct=Math.min(100,Math.round((g.current_value/g.target_value)*100));
    return`<div class="goal-item"><strong>${sanitizeHTML(g.title)}</strong> <span class="badge ${g.status==='completed'?'badge-ok':'badge-warn'}">${g.status==='completed'?'✅ Completado':'🎯 Activo'}</span><br><small>${sanitizeHTML(g.metric)}: ${g.current_value}/${g.target_value}</small><div class="progress-bar"><div class="progress-fill" data-width="${pct}"></div></div>${g.status!=='completed'?`<input type="number" id="goalVal${g.id}" placeholder="Nuevo valor" class="goal-input"> <button class="btn btn-s btn-sm btn-update-goal" data-goal-id="${g.id}">Actualizar</button>`:''}</div>`;
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
    if(!d.success||!d.notes?.length){box.innerHTML='<p class="empty-msg">Sin notas clínicas</p>';return;}
    box.innerHTML=d.notes.map(n=>{
      const date=new Date(n.created_at).toLocaleString('es-ES');
      const updated=n.updated_at&&n.updated_at!==n.created_at?`<span class="edited-tag"> (editada)</span>`:'';
      return`<div class="soap-note" id="note-${n.id}">
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

function showAddNote(){
  Swal.fire({title:'Nueva nota clínica (SOAP)',html:`
    <label class="soap-label">S — Subjetivo</label>
    <textarea id="swalSubjective" class="swal2-textarea" placeholder="Lo que el paciente reporta: síntomas, quejas, sentimientos..." rows="2"></textarea>
    <label class="soap-label">O — Objetivo</label>
    <textarea id="swalObjective" class="swal2-textarea" placeholder="Datos observables: apariencia, conducta, check-ins recientes..." rows="2"></textarea>
    <label class="soap-label">A — Evaluación</label>
    <textarea id="swalAssessment" class="swal2-textarea" placeholder="Tu análisis clínico: diagnóstico, progreso, patrones..." rows="2"></textarea>
    <label class="soap-label">P — Plan</label>
    <textarea id="swalPlan" class="swal2-textarea" placeholder="Próximos pasos: tareas, objetivos, frecuencia de sesiones..." rows="2"></textarea>
  `,showCancelButton:true,confirmButtonText:'Guardar nota',cancelButtonText:'Cancelar',width:650,preConfirm:async()=>{
    const subjective=document.getElementById('swalSubjective').value.trim();
    const objective=document.getElementById('swalObjective').value.trim();
    const assessment=document.getElementById('swalAssessment').value.trim();
    const plan=document.getElementById('swalPlan').value.trim();
    if(!subjective&&!objective&&!assessment&&!plan){Swal.showValidationMessage('Completa al menos un campo SOAP');return false;}
    try{
      await api(`${API}/therapists/patients/${currentPatientId}/clinical-notes`,{method:'POST',body:JSON.stringify({subjective:subjective||null,objective:objective||null,assessment:assessment||null,plan:plan||null})});
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
  if(!filtered.length){grid.innerHTML='<p class="empty-msg">No se encontraron tareas</p>';return;}
  grid.innerHTML=filtered.map(t=>{
    const isCustom=!!t.therapist_id;
    const cardClass=isCustom?'template-card custom-template':'template-card system-template';
    const customBadge=isCustom?'<span class="custom-badge">⭐ Tuya</span>':'';
    const actionButtons=isCustom
      ?`<button class="btn btn-p btn-sm btn-toggle-template" data-template-id="${t.id}">📖 Ver</button>
         <button class="btn btn-w btn-sm btn-edit-template" data-template-id="${t.id}">✏️ Editar</button>
         <button class="btn btn-d btn-sm btn-delete-template" data-template-id="${t.id}">🗑️ Eliminar</button>
         <button class="btn btn-s btn-sm btn-assign-template" data-template-id="${t.id}">📋 Asignar</button>`
      :`<button class="btn btn-p btn-sm btn-toggle-template" data-template-id="${t.id}">📖 Ver instrucciones</button>
         <button class="btn btn-s btn-sm btn-assign-template" data-template-id="${t.id}">📋 Asignar a paciente</button>`;
    return`<div class="${cardClass}" id="tcard-${t.id}">
      <div class="template-category">${sanitizeHTML(t.category)}${customBadge}</div>
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
    await api(`${API}/therapists/patients/${pId}/assignments`,{method:'POST',body:JSON.stringify({type:template.category,title:template.title,instructions:template.instructions})});
    Swal.fire({title:'✅ Tarea asignada',text:`"${template.title}" asignada al paciente`,icon:'success',timer:2000,showConfirmButton:false});
  }catch(e){
    console.error('[assignTemplateToPatient] asignación falló:',e);
    Swal.fire('Error','No se pudo asignar la tarea','error');
  }
}

// ==================== PLANTILLAS PERSONALIZADAS (CRUD) ====================
function showCreateTemplate(){
  Swal.fire({title:'Crear nueva plantilla',html:`
    <label class="soap-label">Categoría</label>
    <input id="swalTmplCat" class="swal2-input" placeholder="Ej: 🧘 Respiración guiada">
    <label class="soap-label">Título</label>
    <input id="swalTmplTitle" class="swal2-input" placeholder="Título de la tarea">
    <label class="soap-label">Instrucciones</label>
    <textarea id="swalTmplInstructions" class="swal2-textarea" placeholder="Instrucciones detalladas..." rows="4"></textarea>
    <label class="soap-label">Dificultad</label>
    <select id="swalTmplDifficulty" class="swal2-input"><option value="baja">🟢 Fácil</option><option value="media" selected>🟡 Media</option><option value="alta">🔴 Avanzada</option></select>
    <label class="soap-label">Duración (minutos)</label>
    <input id="swalTmplDuration" class="swal2-input" type="number" value="30" min="5" max="180">
  `,showCancelButton:true,confirmButtonText:'Crear plantilla',cancelButtonText:'Cancelar',width:600,preConfirm:async()=>{
    const category=document.getElementById('swalTmplCat').value.trim();
    const title=document.getElementById('swalTmplTitle').value.trim();
    const instructions=document.getElementById('swalTmplInstructions').value.trim();
    const difficulty=document.getElementById('swalTmplDifficulty').value;
    const duration=parseInt(document.getElementById('swalTmplDuration').value)||30;
    if(!category||!title||!instructions){Swal.showValidationMessage('Categoría, título e instrucciones son obligatorios');return false;}
    try{
      const r=await api(`${API}/therapists/task-templates`,{method:'POST',body:JSON.stringify({category,title,instructions,difficulty,duration_min:duration})});
      const d=await r.json();
      if(d.success){templates.unshift(d.template);renderTemplates();renderCategoryFilters();Swal.fire({title:'✅ Plantilla creada',icon:'success',timer:1500,showConfirmButton:false});}
      else Swal.showValidationMessage(d.error||'Error al crear');
    }catch(e){Swal.showValidationMessage('Error de conexión');}
  }});
}

function editCustomTemplate(templateId){
  const t=templates.find(x=>x.id===templateId);if(!t)return;
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
  try{
    const r=await api(`${API}/therapists/export/${currentPatientId}?format=csv`);
    const blob=await r.blob();const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=`coter_${currentPatientId.slice(0,8)}.csv`;a.click();URL.revokeObjectURL(url);
    Swal.fire({title:'✅ Exportado',icon:'success',timer:1500,showConfirmButton:false});
  }catch(e){Swal.fire('Error','No se pudo exportar','error');}
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
    if(d.success){calendarData=d.dates||{};renderCalendar();}
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
  document.getElementById('calendarDayContent').innerHTML=html;
  panel.classList.remove('hidden');
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
      case 'add-note': showAddNote(); break;
      case 'create-template': showCreateTemplate(); break;
      case 'prev-month': prevMonth(); break;
      case 'next-month': nextMonth(); break;
      case 'go-today': goToToday(); break;
      default: console.warn('Unknown data-action:', action);
    }
    return;
  }
  
  // Nav tabs
  const navItem = e.target.closest('.nav-item[data-tab]');
  if (navItem) {
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
    navItem.classList.add('active');
    const tabId = 'tab-'+navItem.dataset.tab;
    const tabEl = document.getElementById(tabId);
    if (tabEl) tabEl.classList.add('active');
    if(navItem.dataset.tab==='patients')loadPatients();
    if(navItem.dataset.tab==='code')loadCode();
    if(navItem.dataset.tab==='calendar')loadCalendar();
    if(navItem.dataset.tab==='library')loadTemplates();
    return;
  }
  
  // Modal tabs
  const modalTab = e.target.closest('.modal-tab[data-ptab]');
  if (modalTab) {
    document.querySelectorAll('.modal-tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.modal-tab-content').forEach(c=>c.classList.remove('active'));
    modalTab.classList.add('active');
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
if(saved){try{const s=JSON.parse(saved);token=s.token;refreshToken=s.refresh_token;therapist=s.therapist;showApp();}catch(e){localStorage.removeItem('coter_therapist');}}
