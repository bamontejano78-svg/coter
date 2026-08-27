  (function(){
    const form = document.getElementById('pioneerForm');
    const submitBtn = document.getElementById('submitBtn');
    const successMsg = document.getElementById('successMsg');
    const applyCard = document.getElementById('applyCard');

    function showError(id, msg) {
      const el = document.getElementById(id + 'Error');
      if (el) { el.textContent = msg; el.classList.add('visible'); }
    }
    function clearErrors() {
      document.querySelectorAll('.error-msg').forEach(e => { e.textContent = ''; e.classList.remove('visible'); });
    }

    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      clearErrors();

      const name = document.getElementById('name').value.trim();
      const email = document.getElementById('email').value.trim();
      const specialty = document.getElementById('specialty').value.trim();
      const phone = document.getElementById('phone').value.trim();
      const message = document.getElementById('message').value.trim();

      // Validación client-side
      let valid = true;
      if (!name) { showError('name', 'El nombre es obligatorio'); valid = false; }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError('email', 'Email válido obligatorio'); valid = false; }
      if (!specialty) { showError('specialty', 'La especialidad es obligatoria'); valid = false; }
      if (!valid) return;

      // Enviar
      submitBtn.disabled = true;
      submitBtn.classList.add('loading');
      submitBtn.textContent = '';

      try {
        const res = await fetch('/api/v1/pioneers/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, specialty, phone: phone || undefined, message: message || undefined }),
        });

        const data = await res.json();

        if (data.success) {
          form.style.display = 'none';
          successMsg.style.display = 'block';
        } else if (data.errors) {
          data.errors.forEach(err => {
            if (err.path === 'name') showError('name', err.msg);
            if (err.path === 'email') showError('email', err.msg);
            if (err.path === 'specialty') showError('specialty', err.msg);
          });
        } else {
          showToast(data.error || 'Error al enviar la solicitud', 'error');
        }
      } catch (err) {
        showToast('Error de conexión. Intenta de nuevo.', 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.classList.remove('loading');
        submitBtn.textContent = 'Solicitar acceso al Programa Pioneros';
      }
    });

    function showToast(msg, type) {
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = msg;
      document.body.appendChild(toast);
      setTimeout(() => { toast.remove(); }, 4000);
    }
  })();
