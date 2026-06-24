const API = '/api/v1';
let resetToken = null;

// Detectar si venimos con token en la URL
const urlParams = new URLSearchParams(window.location.search);
resetToken = urlParams.get('token');

if (resetToken) {
  document.getElementById('stepRequest').classList.add('hidden');
  document.getElementById('stepReset').classList.remove('hidden');
}

document.addEventListener('click', function(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  
  const action = btn.dataset.action;
  
  if (action === 'request-recovery') {
    requestRecovery();
  } else if (action === 'reset-password') {
    doResetPassword();
  } else if (action === 'show-request') {
    document.getElementById('stepError').classList.add('hidden');
    document.getElementById('stepRequest').classList.remove('hidden');
  }
});

document.addEventListener('keypress', function(e) {
  if (e.key === 'Enter') {
    const stepReq = document.getElementById('stepRequest');
    const stepReset = document.getElementById('stepReset');
    if (!stepReq.classList.contains('hidden')) {
      requestRecovery();
    } else if (!stepReset.classList.contains('hidden')) {
      doResetPassword();
    }
  }
});

async function requestRecovery() {
  const email = document.getElementById('recoveryEmail').value.trim();
  if (!email) {
    Swal.fire('Error', 'Ingresa tu email', 'error');
    return;
  }
  
  try {
    const r = await fetch(`${API}/therapists/password-recovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const d = await r.json();
    
    if (d.success) {
      // En desarrollo, si el servidor devolvió el reset_url (SMTP no configurado),
      // mostramos el enlace directamente para que el usuario pueda hacer clic.
      let htmlMsg = 'Si el email está registrado, recibirás un enlace para restablecer tu contraseña.<br><br><small style="color:#888">Revisa también la carpeta de spam.</small>';
      if (d.reset_url) {
        htmlMsg += '<br><br><div style="margin:16px 0;padding:12px;background:var(--p-soft,#eef2ff);border-radius:8px;word-break:break-all"><small style="color:var(--muted,#888)">Modo desarrollo — enlace directo:</small><br><a href="' + d.reset_url + '" style="color:var(--p,#6366f1);font-weight:600;font-size:13px">' + d.reset_url + '</a></div>';
      }
      Swal.fire({
        title: '📧 Revisa tu email',
        html: htmlMsg,
        icon: 'success',
        confirmButtonText: 'Entendido',
        confirmButtonColor: '#6366f1'
      });
    } else {
      Swal.fire('Error', d.error || 'No se pudo procesar la solicitud', 'error');
    }
  } catch(e) {
    Swal.fire('Error', 'No se pudo conectar con el servidor', 'error');
  }
}

async function doResetPassword() {
  if (!resetToken) {
    Swal.fire('Error', 'Token no encontrado. Usa el enlace del email.', 'error');
    return;
  }
  
  const newPassword = document.getElementById('newPassword').value;
  const confirmPassword = document.getElementById('confirmPassword').value;
  
  if (!newPassword || newPassword.length < 6) {
    Swal.fire('Error', 'La contraseña debe tener al menos 6 caracteres', 'error');
    return;
  }
  
  if (newPassword !== confirmPassword) {
    Swal.fire('Error', 'Las contraseñas no coinciden', 'error');
    return;
  }
  
  try {
    const r = await fetch(`${API}/therapists/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, new_password: newPassword })
    });
    const d = await r.json();
    
    if (d.success) {
      document.getElementById('stepReset').classList.add('hidden');
      document.getElementById('stepSuccess').classList.remove('hidden');
    } else {
      document.getElementById('stepReset').classList.add('hidden');
      document.getElementById('stepError').classList.remove('hidden');
    }
  } catch(e) {
    Swal.fire('Error', 'No se pudo conectar con el servidor', 'error');
  }
}
