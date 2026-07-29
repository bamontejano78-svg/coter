/* ============================================================
   Coter Pro — Billing / Stripe Checkout UI
   Se engancha al sistema de tabs existente en therapist.js.
   ============================================================ */

(function () {
  'use strict';

  // Esperar a que el DOM y therapist.js estén listos
  function init() {
    // Observar clicks en el nav item de Facturación
    document.addEventListener('click', function (e) {
      var navItem = e.target.closest('.nav-item[data-tab="billing"]');
      if (navItem) {
        // Pequeño delay para que el tab switching del sistema se ejecute primero
        setTimeout(loadBilling, 50);
      }
    });

    // Botones de refresh y checkout dentro del tab de billing
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      if (action === 'refresh-billing') loadBilling();
      if (action === 'start-checkout') startCheckout();
      if (action === 'manage-billing') manageBilling();
    });

    // Manejar retorno de Stripe (checkout=success | checkout=cancel en URL)
    handleCheckoutReturn();

    // Cargar al iniciar si el billing tab es el activo (poco común, pero posible)
    if (document.getElementById('tab-billing') && 
        document.getElementById('tab-billing').classList.contains('active')) {
      loadBilling();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // LOAD BILLING STATUS
  // ═══════════════════════════════════════════════════════════
  async function loadBilling() {
    var container = document.getElementById('billingContent');
    if (!container) return;

    // Skeleton loading
    container.innerHTML = '<div class="card" style="grid-column:1/-1"><div style="text-align:center;padding:32px"><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text short"></div></div></div>';

    try {
      // Hacer ambas peticiones en paralelo
      var [statusRes, usageRes] = await Promise.all([
        api(API + '/billing/status'),
        api(API + '/billing/usage')
      ]);

      if (!statusRes.ok) throw new Error('Error HTTP ' + statusRes.status + ' en /billing/status');

      var statusData = await statusRes.json();
      var usageData = usageRes.ok ? await usageRes.json() : { success: false };

      if (!statusData.success) {
        renderBillingError(container, statusData.error || 'No se pudo cargar la información de facturación');
        return;
      }

      renderBillingStatus(container, statusData.subscription, usageData.success ? usageData.usage : null);

    } catch (err) {
      console.error('Error loading billing:', err);
      renderBillingError(container, 'Error de conexión al cargar facturación');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER BILLING STATUS
  // ═══════════════════════════════════════════════════════════
  function renderBillingStatus(container, sub, usage) {
    var status = sub.status;
    var isTrial = status === 'trialing';
    var isActive = status === 'active';
    var isPastDue = status === 'past_due';
    var isCanceled = status === 'canceled';
    var isPioneer = sub.isPioneer === true;

    var statusIcons = {
      trialing: '🧪',
      active: '✅',
      past_due: '⚠️',
      canceled: '❌',
      incomplete: '⏳'
    };

    var statusLabels = {
      trialing: 'Período de prueba',
      active: 'Suscripción activa',
      past_due: 'Pago pendiente',
      canceled: 'Cancelada',
      incomplete: 'Pendiente de completar'
    };

    var statusDescriptions = {
      trialing: 'Estás disfrutando del período de prueba gratuito. Sin cargos hasta que termine.',
      active: 'Tu suscripción está activa. Tienes acceso completo a todas las funcionalidades.',
      past_due: 'Hubo un problema con tu último pago. Tienes 7 días de gracia para actualizarlo.',
      canceled: 'Tu suscripción ha sido cancelada. Puedes reactivarla en cualquier momento.',
      incomplete: 'Tu suscripción está pendiente de configuración.'
    };

    var patientCount = usage ? usage.activePatients : sub.patientCount || 0;
    var priceCents = sub.pricePerPatientCents || 300;
    var estimatedCost = patientCount * priceCents;

    var html = '';

    // ── Status Card ──────────────────────────────────────
    html += '<div class="billing-status-card">';
    html += '<div class="billing-status-icon ' + status + '">' + (statusIcons[status] || '📋') + '</div>';
    html += '<div class="billing-status-body">';
    html += '<h2>' + (statusLabels[status] || status) + '';
    if (isPioneer) html += ' <span style="font-size:13px;color:var(--w);font-weight:600">⭐ Pionero</span>';
    html += '</h2>';
    html += '<p>' + (statusDescriptions[status] || '') + '</p>';
    if (isPioneer && sub.priceLockedUntil) {
      var lockDate = new Date(sub.priceLockedUntil).toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
      html += '<p style="margin-top:4px;font-size:12px;color:var(--w)">🔒 Precio bloqueado (3€/paciente) hasta ' + lockDate + '</p>';
    }
    html += '</div>';
    html += '<span class="billing-status-badge ' + status + '">' + (statusLabels[status] || status) + '</span>';
    html += '</div>';

    // ── Trial Banner ─────────────────────────────────────
    if (isTrial && sub.trial) {
      var trialDaysLeft = Math.max(0, sub.trial.daysLeft || 0);
      var trialDuration = sub.trial.totalDays || 14; // Usar total del backend o asumir 14 días
      var trialPct = Math.min(100, Math.max(0, Math.round(((trialDuration - trialDaysLeft) / trialDuration) * 100)));

      html += '<div class="billing-trial-banner">';
      html += '<h3>🧪 Período de prueba</h3>';
      html += '<p style="font-size:13px;color:var(--muted);margin:0">Te quedan <strong>' + trialDaysLeft + ' días</strong> de prueba gratuita. Después, la suscripción cuesta <strong>' + (priceCents / 100).toFixed(2).replace('.', ',') + '€/paciente/mes</strong>.</p>';
      html += '<div class="billing-trial-bar"><div class="billing-trial-fill" style="width:' + trialPct + '%"></div></div>';
      html += '<div class="billing-trial-meta"><span>Día 1</span><span><strong>' + trialDaysLeft + ' días restantes</strong></span><span>Día ' + trialDuration + '</span></div>';
      html += '</div>';
    }

    // ── Usage Stats ──────────────────────────────────────
    html += '<div class="billing-stat">';
    html += '<div class="billing-stat-num">' + patientCount + '</div>';
    html += '<div class="billing-stat-label">Pacientes activos</div>';
    html += '</div>';

    html += '<div class="billing-stat">';
    html += '<div class="billing-stat-num">' + (estimatedCost / 100).toFixed(2).replace('.', ',') + '€</div>';
    html += '<div class="billing-stat-label">Coste estimado / mes</div>';
    html += '</div>';

    // ── Details ──────────────────────────────────────────
    html += '<div class="card" style="margin:0">';
    html += '<h2>📋 Detalles de la suscripción</h2>';
    html += '<div class="billing-info-row"><span class="billing-info-label">Precio por paciente</span><span class="billing-info-value">' + (priceCents / 100).toFixed(2).replace('.', ',') + '€/mes</span></div>';
    html += '<div class="billing-info-row"><span class="billing-info-label">Pacientes activos</span><span class="billing-info-value">' + patientCount + '</span></div>';
    html += '<div class="billing-info-row"><span class="billing-info-label">Coste mensual estimado</span><span class="billing-info-value">' + (estimatedCost / 100).toFixed(2).replace('.', ',') + '€</span></div>';
    if (sub.currentPeriodStart) {
      html += '<div class="billing-info-row"><span class="billing-info-label">Período actual</span><span class="billing-info-value">' + new Date(sub.currentPeriodStart).toLocaleDateString('es-ES') + ' — ' + new Date(sub.currentPeriodEnd).toLocaleDateString('es-ES') + '</span></div>';
    }
    if (sub.priceLockedUntil) {
      html += '<div class="billing-info-row"><span class="billing-info-label">Precio bloqueado hasta</span><span class="billing-info-value">' + new Date(sub.priceLockedUntil).toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' }) + '</span></div>';
    }
    html += '</div>';

    // ── Stripe CTA ───────────────────────────────────────
    if (isTrial || isPastDue || isCanceled || status === 'incomplete') {
      html += '<div class="billing-stripe-cta">';
      var ctaText, ctaDesc;
      if (isTrial) {
        ctaText = '💳 Activar suscripción ahora';
        ctaDesc = 'Al añadir tu método de pago, la suscripción se activará automáticamente al terminar el trial. Puedes cancelar en cualquier momento.';
      } else if (isPastDue) {
        ctaText = '💳 Actualizar método de pago';
        ctaDesc = 'Tu último pago no se ha podido procesar. Actualiza tu método de pago para reactivar la suscripción.';
      } else {
        ctaText = '💳 Reactivar suscripción';
        ctaDesc = 'Reactiva tu suscripción para recuperar el acceso completo a la plataforma.';
      }
      html += '<p>' + ctaDesc + '</p>';
      html += '<button class="billing-stripe-btn" data-action="start-checkout">';
      html += '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.976 10.533c.83 0 1.59-.35 2.12-.96l3.84-3.84a3 3 0 0 0-4.24-4.24l-3.84 3.84a3 3 0 0 0 2.12 5.2zm-3.952 2.934a3 3 0 0 0-2.12 5.2l3.84 3.84a3 3 0 0 0 4.24-4.24l-3.84-3.84a3 3 0 0 0-2.12-.96zm-3 1.1a3 3 0 0 0-5.02 1.92 3 3 0 0 0 .78 2.43l3.84 3.84a3 3 0 0 0 4.24 0 3 3 0 0 0 0-4.24l-3.84-3.95zm11.024-3a3 3 0 0 0-1.92-5.02 3 3 0 0 0-2.43.78l-3.84 3.84a3 3 0 0 0 4.24 4.24l3.95-3.84z"/></svg>';
      html += ctaText;
      html += '</button>';
      html += '</div>';
    }

    // ── Manage billing portal ───────────────────────────
    if (isActive) {
      html += '<div class="billing-stripe-cta" style="padding:20px 24px">';
      html += '<p style="margin-bottom:12px">Gestiona tu método de pago, facturas y configuración de suscripción desde el portal de Stripe.</p>';
      html += '<button class="billing-stripe-btn" data-action="manage-billing" style="background:var(--white);color:#635bff;border:2px solid #635bff">⚙️ Gestionar suscripción</button>';
      html += '</div>';
    }

    container.innerHTML = html;
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER ERROR
  // ═══════════════════════════════════════════════════════════
  function renderBillingError(container, message) {
    container.innerHTML = '<div class="card" style="grid-column:1/-1;text-align:center;padding:32px">' +
      '<div style="font-size:40px;margin-bottom:12px">⚠️</div>' +
      '<h2 style="margin-bottom:8px">Error al cargar facturación</h2>' +
      '<p style="color:var(--muted);margin-bottom:16px">' + sanitizeHTML(message) + '</p>' +
      '<button class="btn btn-p" data-action="refresh-billing">Reintentar</button>' +
      '</div>';
  }

  // ═══════════════════════════════════════════════════════════
  // START STRIPE CHECKOUT
  // ═══════════════════════════════════════════════════════════
  async function startCheckout() {
    // Prevenir doble clic
    var btn = document.querySelector('[data-action="start-checkout"]');
    var originalText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.style.opacity = '0.7'; btn.textContent = 'Conectando...'; }

    try {
      // Mostrar loading
      if (typeof Swal !== 'undefined') {
        Swal.fire({
          title: 'Conectando con Stripe...',
          text: 'Serás redirigido a la página segura de pago.',
          allowOutsideClick: false,
          didOpen: function () {
            Swal.showLoading();
          }
        });
      }

      var res = await api(API + '/billing/create-checkout', { method: 'POST' });
      if (!res.ok) {
        throw new Error('Error HTTP ' + res.status);
      }
      var data = await res.json();

      if (!data.success || !data.checkoutUrl) {
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = originalText || 'Activar suscripción'; }
        if (typeof Swal !== 'undefined') {
          Swal.fire('Error', data.error || 'No se pudo iniciar el proceso de pago. Verifica que Stripe esté configurado.', 'error');
        }
        return;
      }

      // Redirigir a Stripe Checkout
      window.location.href = data.checkoutUrl;

    } catch (err) {
      console.error('Error starting checkout:', err);
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = originalText || 'Activar suscripción'; }
      if (typeof Swal !== 'undefined') {
        Swal.fire('Error', 'No se pudo conectar con el servidor de pagos.', 'error');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // MANAGE BILLING (Stripe Customer Portal)
  // TODO: Implementar endpoint /billing/portal que use
  // stripe.billingPortal.sessions.create() para redirigir al
  // Customer Portal de Stripe en lugar de una checkout session.
  // ═══════════════════════════════════════════════════════════
  function manageBilling() {
    // Por ahora, mostrar info de que el portal estará disponible pronto.
    // No usar /create-checkout para suscripciones activas porque crearía
    // una nueva checkout session en lugar del portal de gestión.
    if (typeof Swal !== 'undefined') {
      Swal.fire({
        title: 'Portal de facturación',
        html: 'El portal de gestión de suscripción estará disponible próximamente.<br><br>Para gestionar tu método de pago, facturas o cancelar tu suscripción, contacta con soporte.',
        icon: 'info',
        confirmButtonText: 'Entendido',
        confirmButtonColor: '#6366f1'
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // HANDLE CHECKOUT RETURN (success/cancel URL params)
  // ═══════════════════════════════════════════════════════════
  function handleCheckoutReturn() {
    var params = new URLSearchParams(window.location.search);
    var status = params.get('checkout');

    if (!status) return;

    // Limpiar URL sin recargar
    var url = new URL(window.location);
    url.searchParams.delete('checkout');
    window.history.replaceState({}, '', url);

    if (status === 'success') {
      if (typeof Swal !== 'undefined') {
        Swal.fire({
          title: '✅ ¡Suscripción activada!',
          text: 'Tu método de pago se ha configurado correctamente. Ya tienes acceso completo a Coter Pro.',
          icon: 'success',
          confirmButtonText: 'Continuar',
          confirmButtonColor: '#6366f1'
        }).then(function () {
          // Cambiar al tab de billing para que vea el estado actualizado
          var billingTab = document.querySelector('.nav-item[data-tab="billing"]');
          if (billingTab) billingTab.click();
        });
      }
    } else if (status === 'cancel') {
      if (typeof Swal !== 'undefined') {
        Swal.fire({
          title: 'Configuración cancelada',
          text: 'No se realizó ningún cargo. Puedes activar tu suscripción cuando quieras desde la sección de Facturación.',
          icon: 'info',
          confirmButtonText: 'Entendido',
          confirmButtonColor: '#6366f1'
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // INIT — arrancar cuando el DOM esté listo
  // ═══════════════════════════════════════════════════════════
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
