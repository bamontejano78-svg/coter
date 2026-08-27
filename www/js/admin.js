  // ════════ Admin Dashboard JS ════════
  const API = window.location.origin + '/api/v1/admin';
  let authenticated = false;

  // ─── DOM refs ─────────────────────────────────────────────
  const loginScreen = document.getElementById('loginScreen');
  const dashboardScreen = document.getElementById('dashboardScreen');
  const loginForm = document.getElementById('loginForm');
  const loginBtn = document.getElementById('loginBtn');
  const loginBtnText = document.getElementById('loginBtnText');
  const loginSpinner = document.getElementById('loginSpinner');
  const loginError = document.getElementById('loginError');
  const adminPassword = document.getElementById('adminPassword');
  const passwordField = document.getElementById('passwordField');
  const twoFactorField = document.getElementById('twoFactorField');
  const twoFactorCode = document.getElementById('twoFactorCode');
  const backToPasswordBtn = document.getElementById('backToPasswordBtn');
  const lastUpdated = document.getElementById('lastUpdated');
  const refreshBtn = document.getElementById('refreshBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  let pending2fa = false;

  function enterDashboard() {
    authenticated = true;
    pending2fa = false;
    loginScreen.classList.add('hidden');
    dashboardScreen.classList.remove('hidden');
    loadStats();
    loadActivity();
    loadAdminSecurity();
    loadAudit();
  }

  // ─── Auto-login ──────────────────────────────────────────
  // The server validates the HttpOnly admin cookie on the first request.
  // No password or bearer token is persisted in browser storage.
  (async () => {
    try {
      const r = await fetch(API + '/stats', { credentials: 'include' });
      if (r.ok) {
        enterDashboard();
      }
    } catch (err) {
      // Stay on the login screen.
    }
  })();

  // ─── Login (2 pasos: contraseña → código 2FA) ────────────
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pending2fa) {
      await submitTwoFactorCode();
      return;
    }

    const password = adminPassword.value.trim();
    if (!password) return;

    loginBtn.disabled = true;
    loginBtnText.classList.add('hidden');
    loginSpinner.classList.remove('hidden');
    loginError.classList.add('hidden');

    try {
      const r = await fetch(API + '/session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const d = await r.json();

      if (r.ok && d.success) {
        if (d.requires_2fa) {
          pending2fa = true;
          passwordField.classList.add('hidden');
          twoFactorField.classList.remove('hidden');
          backToPasswordBtn.classList.remove('hidden');
          loginBtnText.textContent = 'Verificar código';
          twoFactorCode.focus();
        } else {
          enterDashboard();
        }
      } else {
        throw new Error(d.error || 'Contraseña incorrecta');
      }
    } catch (err) {
      loginError.textContent = err.message || 'Error de conexión';
      loginError.classList.remove('hidden');
    } finally {
      loginBtn.disabled = false;
      loginBtnText.classList.remove('hidden');
      loginSpinner.classList.add('hidden');
    }
  });

  backToPasswordBtn.addEventListener('click', () => {
    pending2fa = false;
    passwordField.classList.remove('hidden');
    twoFactorField.classList.add('hidden');
    backToPasswordBtn.classList.add('hidden');
    loginBtnText.textContent = 'Acceder al panel';
    twoFactorCode.value = '';
    adminPassword.focus();
  });

  async function submitTwoFactorCode() {
    const code = twoFactorCode.value.trim();
    if (!code) return;

    loginBtn.disabled = true;
    loginBtnText.classList.add('hidden');
    loginSpinner.classList.remove('hidden');
    loginError.classList.add('hidden');

    try {
      const r = await fetch(API + '/verify-2fa', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const d = await r.json();
      if (r.ok && d.success) {
        enterDashboard();
      } else {
        throw new Error(d.error || 'Código incorrecto');
      }
    } catch (err) {
      loginError.textContent = err.message || 'Error de conexión';
      loginError.classList.remove('hidden');
    } finally {
      loginBtn.disabled = false;
      loginBtnText.classList.remove('hidden');
      loginSpinner.classList.add('hidden');
    }
  }

  // ─── Logout ──────────────────────────────────────────────
  logoutBtn.addEventListener('click', () => {
    fetch(API + '/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    authenticated = false;
    pending2fa = false;
    dashboardScreen.classList.add('hidden');
    loginScreen.classList.remove('hidden');
    passwordField.classList.remove('hidden');
    twoFactorField.classList.add('hidden');
    backToPasswordBtn.classList.add('hidden');
    loginBtnText.textContent = 'Acceder al panel';
    adminPassword.value = '';
    adminPassword.focus();
  });

  // ─── Refresh ─────────────────────────────────────────────
  refreshBtn.addEventListener('click', () => { loadStats(); loadActivity(); loadAudit(); });

  // ─── API helpers ─────────────────────────────────────────
  async function apiFetch(path, options = {}) {
    if (!authenticated) throw new Error('No autenticado');
    const r = await fetch(API + path, { ...options, credentials: 'include' });
    if (r.status === 401) {
      authenticated = false;
      pending2fa = false;
      dashboardScreen.classList.add('hidden');
      loginScreen.classList.remove('hidden');
      throw new Error('Sesión expirada');
    }
    return r.json();
  }

  // ─── Security: verificación en dos pasos (2FA) ───────────
  async function loadAdminSecurity() {
    const container = document.getElementById('adminSecurityContent');
    if (!container) return;
    try {
      const d = await apiFetch('/2fa/status');
      if (!d.success) throw new Error(d.error || 'Error');
      renderAdminSecurity(container, !!d.enabled);
    } catch (err) {
      container.innerHTML = '<div class="activity-error">No se pudo cargar el estado de seguridad</div>';
    }
  }

  function renderAdminSecurity(container, enabled) {
    if (enabled) {
      container.innerHTML =
        '<div class="security-row">' +
          '<div><strong>Activada</strong>' +
          '<p>Se requiere un código de tu app autenticadora además de la contraseña para entrar al panel.</p></div>' +
          '<button id="adminDisable2faBtn" class="btn-logout">Desactivar</button>' +
        '</div>';
    } else {
      container.innerHTML =
        '<div class="security-row">' +
          '<div><strong>Desactivada</strong>' +
          '<p>Protege el acceso al panel con un segundo factor. Necesitarás una app autenticadora (Google Authenticator, Authy, 1Password…).</p></div>' +
          '<button id="adminEnable2faBtn" class="btn-refresh">Activar</button>' +
        '</div>';
    }
    const enableBtn = document.getElementById('adminEnable2faBtn');
    if (enableBtn) enableBtn.addEventListener('click', adminSetup2fa);
    const disableBtn = document.getElementById('adminDisable2faBtn');
    if (disableBtn) disableBtn.addEventListener('click', adminDisable2fa);
  }

  async function adminSetup2fa() {
    const container = document.getElementById('adminSecurityContent');
    try {
      const d = await apiFetch('/2fa/setup', { method: 'POST' });
      if (!d.success) { alert(d.error || 'Error'); return; }
      container.innerHTML =
        '<div class="security-row" style="flex-direction:column;align-items:flex-start;gap:14px">' +
          '<div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap">' +
            '<img src="' + d.qr_code_data_url + '" alt="Código QR para la app autenticadora" style="width:200px;height:200px;border-radius:8px;border:1px solid var(--b)">' +
            '<div style="flex:1;min-width:240px">' +
              '<strong>Escanea y confirma</strong>' +
              '<p>Escanea el QR con tu app autenticadora o introduce la clave manualmente:</p>' +
              '<code>' + d.secret + '</code>' +
              '<p style="margin-top:10px">Introduce el código de 6 dígitos que genera tu app:</p>' +
              '<input type="text" id="admin2faConfirmCode" class="login-input" placeholder="Código de 6 dígitos" style="max-width:220px;margin-bottom:10px" autocomplete="one-time-code" inputmode="numeric" maxlength="6">' +
              '<div style="display:flex;gap:10px">' +
                '<button id="admin2faConfirmBtn" class="btn-refresh">Confirmar</button>' +
                '<button id="admin2faCancelBtn" class="btn-logout">Cancelar</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      document.getElementById('admin2faConfirmBtn').addEventListener('click', async () => {
        const code = document.getElementById('admin2faConfirmCode').value.trim();
        if (!code) return;
        try {
          const c = await apiFetch('/2fa/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
          });
          if (!c.success) { alert(c.error || 'Código incorrecto'); return; }
          renderAdminBackupCodes(c.backup_codes || []);
        } catch (err) { alert(err.message || 'Error'); }
      });
      document.getElementById('admin2faCancelBtn').addEventListener('click', () => loadAdminSecurity());
    } catch (err) {
      alert(err.message || 'No se pudo iniciar la configuración');
      loadAdminSecurity();
    }
  }

  function renderAdminBackupCodes(codes) {
    const container = document.getElementById('adminSecurityContent');
    const list = codes.map(function (c) {
      return '<code>' + c + '</code>';
    }).join('');
    container.innerHTML =
      '<div class="security-row" style="flex-direction:column;align-items:flex-start;gap:14px">' +
        '<strong>¡Verificación activada! Guarda tus códigos de respaldo</strong>' +
        '<p>Estos códigos permiten entrar si pierdes el acceso a tu app autenticadora. <strong>Solo se muestran una vez.</strong></p>' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px">' + list + '</div>' +
        '<button id="admin2faDoneBtn" class="btn-refresh">He guardado los códigos</button>' +
      '</div>';
    document.getElementById('admin2faDoneBtn').addEventListener('click', () => loadAdminSecurity());
  }

  async function adminDisable2fa() {
    const code = prompt('Introduce el código actual de tu app autenticadora para desactivar la verificación:', '');
    if (!code) return;
    try {
      const d = await apiFetch('/2fa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!d.success) { alert(d.error || 'Código incorrecto'); return; }
      loadAdminSecurity();
    } catch (err) { alert(err.message || 'Error'); }
  }

  // ─── Auditoría de accesos a fichas clínicas ───────────────
  const AUDIT_ACTION_LABELS = {
    view_patient: 'Ficha del paciente',
    view_pre_session: 'Memoria pre-sesión',
    view_notes: 'Notas clínicas',
    view_sessions: 'Sesiones clínicas',
    view_scale_history: 'Historial de escalas',
    view_insights: 'Insights semanales',
    export_patient_data: 'Exportación',
  };

  async function loadAudit() {
    const tbody = document.getElementById('auditTableBody');
    if (!tbody) return;
    try {
      const d = await apiFetch('/patient-audit?limit=50');
      if (!d.success) throw new Error(d.error || 'Error');
      renderAudit(tbody, d.entries || []);
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="activity-error">No se pudo cargar la auditoría</div></td></tr>';
    }
  }

  function renderAudit(tbody, entries) {
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="activity-loading">Sin accesos registrados todavía</div></td></tr>';
      return;
    }
    tbody.innerHTML = entries.map(function (e) {
      const date = new Date(e.created_at).toLocaleString('es-ES', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      const action = AUDIT_ACTION_LABELS[e.action] || e.action;
      const isExport = e.action === 'export_patient_data';
      const patientCell = e.patient_name
        ? escapeHtml(e.patient_name)
        : '<span class="audit-patient-deleted">Eliminado (RGPD)</span>';
      return '<tr>' +
        '<td>' + date + '</td>' +
        '<td><strong>' + escapeHtml(e.therapist_name) + '</strong><div style="color:var(--muted);font-size:12px">' + escapeHtml(e.therapist_email) + '</div></td>' +
        '<td>' + patientCell + '</td>' +
        '<td><span class="audit-action' + (isExport ? ' audit-action--export' : '') + '">' + escapeHtml(action) + '</span></td>' +
        '<td style="font-family:monospace;font-size:12px;color:var(--muted)">' + escapeHtml(e.ip || '—') + '</td>' +
      '</tr>';
    }).join('');
  }

  // ─── Load stats ──────────────────────────────────────────
  async function loadStats() {
    try {
      const d = await apiFetch('/stats');
      if (d.success) renderStats(d.stats);
      document.getElementById('lastUpdated').textContent =
        'Actualizado: ' + new Date().toLocaleTimeString('es-ES');
    } catch (err) {
      console.error('[admin] loadStats:', err);
    }
  }

  function renderStats(s) {
    // Therapists
    document.getElementById('statTherapists').textContent = s.therapists.total;
    document.getElementById('statTherapistsSub').textContent =
      'Activos: ' + s.therapists.active + ' · Este mes: +' + s.therapists.thisMonth;

    // Patients
    document.getElementById('statPatients').textContent = s.patients.total;
    document.getElementById('statPatientsSub').textContent =
      'Conexiones activas: ' + s.patients.activeConnections + ' · Este mes: +' + s.patients.thisMonth;

    // Check-ins
    document.getElementById('statCheckIns').textContent = s.checkIns.total;

    // Daily chart
    renderDailyChart(s.checkIns.daily);

    // Scales
    document.getElementById('statScales').textContent = s.clinicalScales.completedThisWeek;
    renderScalesBreakdown(s.clinicalScales.breakdown);

    // Alerts
    document.getElementById('statAlerts').textContent = s.alerts.total;
    document.getElementById('statAlertsSub').textContent = 'Sin leer: ' + s.alerts.unread;

    // Billing
    const rev = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(s.billing.revenueThisMonth);
    document.getElementById('statRevenue').textContent = rev;
    document.getElementById('statBillingSub').textContent =
      'Pioneros: ' + (s.billing.pioneers || 0) +
      ' · Trials: ' + ((s.billing.subscriptions && s.billing.subscriptions.trial) || 0);

    // Stripe
    const se = s.billing.stripe || {};
    const totalEvents = (se.paid_invoices || 0) + (se.completed_checkouts || 0) + (se.subscriptions_created || 0) + (se.subscriptions_cancelled || 0);
    document.getElementById('statStripeEvents').textContent = totalEvents;
    document.getElementById('statStripeSub').textContent =
      'Creadas: ' + (se.subscriptions_created || 0) +
      ' · Canceladas: ' + (se.subscriptions_cancelled || 0);
  }

  // ─── Daily chart ─────────────────────────────────────────
  function renderDailyChart(daily) {
    const container = document.getElementById('chartBars');
    if (!daily || daily.length === 0) {
      container.innerHTML = '<div class="chart-empty">Sin datos de check-ins</div>';
      return;
    }

    const maxVal = Math.max(...daily.map(d => d.count), 1);
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const found = daily.find(x => x.day === key);
      days.push({ day: key, count: found ? found.count : 0, label: d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric' }) });
    }

    container.innerHTML = days.map(d => {
      const h = Math.max((d.count / maxVal) * 100, d.count > 0 ? 4 : 0);
      const cls = d.count === 0 ? 'bar-zero' : d.count >= maxVal * 0.8 ? 'bar-peak' : 'bar-normal';
      return '<div class="chart-bar-col">' +
        '<div class="chart-bar-value">' + (d.count || '') + '</div>' +
        '<div class="chart-bar ' + cls + '" style="height:' + h + '%" title="' + d.day + ': ' + d.count + ' check-ins"></div>' +
        '<div class="chart-bar-label">' + d.label.split(' ')[0] + '</div>' +
      '</div>';
    }).join('');
  }

  // ─── Scales breakdown ────────────────────────────────────
  function renderScalesBreakdown(breakdown) {
    const container = document.getElementById('scalesBreakdown');
    if (!breakdown || breakdown.length === 0) {
      container.innerHTML = '<div class="scales-empty">Sin escalas completadas</div>';
      return;
    }

    const names = { phq9: 'PHQ-9', gad7: 'GAD-7', bdiii: 'BDI-II' };
    const maxTotal = Math.max(...breakdown.map(b => b.total), 1);

    container.innerHTML = breakdown.map(b => {
      const pct = maxTotal > 0 ? Math.round((b.total / maxTotal) * 100) : 0;
      const name = names[b.exercise_kind] || b.exercise_kind;
      return '<div class="scale-item">' +
        '<div class="scale-item-header">' +
          '<span class="scale-item-name">' + name + '</span>' +
          '<span class="scale-item-count">' + b.completed + '/' + b.total + '</span>' +
        '</div>' +
        '<div class="scale-item-bar-bg"><div class="scale-item-bar" style="width:' + pct + '%"></div></div>' +
      '</div>';
    }).join('');
  }

  // ─── Load activity ───────────────────────────────────────
  async function loadActivity() {
    const feed = document.getElementById('activityFeed');
    try {
      const d = await apiFetch('/recent-activity?limit=20');
      if (!d.success) throw new Error(d.error);

      const icons = {
        therapist_registered: '🧑‍⚕️',
        patient_connected: '🔗',
        scale_completed: '📋',
        alert_triggered: '🔔',
        stripe_event: '💳',
      };
      const labels = {
        therapist_registered: 'Terapeuta registrado',
        patient_connected: 'Paciente conectado',
        scale_completed: 'Escala completada',
        alert_triggered: 'Alerta disparada',
        stripe_event: 'Evento Stripe',
      };

      feed.innerHTML = d.activity.map(a => {
        const timeAgo = getTimeAgo(new Date(a.created_at));
        return '<div class="activity-item">' +
          '<div class="activity-icon">' + (icons[a.type] || '📌') + '</div>' +
          '<div class="activity-content">' +
            '<div class="activity-type">' + (labels[a.type] || a.type) + '</div>' +
            '<div class="activity-detail">' +
              '<strong>' + escapeHtml(a.label) + '</strong>' +
              (a.detail ? ' · ' + escapeHtml(a.detail) : '') +
            '</div>' +
          '</div>' +
          '<div class="activity-time">' + timeAgo + '</div>' +
        '</div>';
      }).join('');
    } catch (err) {
      feed.innerHTML = '<div class="activity-error">Error al cargar actividad</div>';
    }
  }

  function getTimeAgo(date) {
    const secs = Math.floor((Date.now() - date.getTime()) / 1000);
    if (secs < 60) return 'ahora';
    if (secs < 3600) return Math.floor(secs / 60) + ' min';
    if (secs < 86400) return Math.floor(secs / 3600) + ' h';
    if (secs < 604800) return Math.floor(secs / 86400) + ' d';
    return date.toLocaleDateString('es-ES');
  }

  function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Footer env ──────────────────────────────────────────
  (async () => {
    try {
      const r = await fetch('/api/health');
      const d = await r.json();
      document.getElementById('footerEnv').textContent = 'Env: ' + (d.environment || '?');
    } catch (e) { document.getElementById('footerEnv').textContent = 'Env: ?'; }
  })();
