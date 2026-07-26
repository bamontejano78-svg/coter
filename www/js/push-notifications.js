/* ============================================================
   Coter Pro — Push Notifications (Capacitor)
   ============================================================
   Integración con @capacitor/push-notifications para recibir
   notificaciones push nativas en Android/iOS.

   Requisitos:
   - Firebase Cloud Messaging (FCM) configurado
   - google-services.json en android/app/
   - Servidor de notificaciones que envíe a los tokens FCM

   Uso:
     window.CoterPush.init({ onToken: fn, onNotification: fn });
   ============================================================ */

(function () {
  'use strict';

  var PushNotifications, Capacitor;
  try {
    Capacitor = window.Capacitor || null;
  } catch (e) {
    Capacitor = null;
  }

  var isNative = Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform();

  /**
   * Inicializa el sistema de notificaciones push.
   * @param {Object} opts
   * @param {Function} opts.onToken — callback(token) cuando se obtiene el token FCM
   * @param {Function} opts.onNotification — callback(data) al recibir notificación en foreground
   * @param {string}  opts.apiBase — URL base de la API para registrar el token (default: '/api/v1')
   */
  function init(opts) {
    opts = opts || {};
    var onToken = opts.onToken || null;
    var onNotification = opts.onNotification || null;
    var apiBase = opts.apiBase || '/api/v1';

    if (!isNative) {
      console.log('[CoterPush] No es plataforma nativa — notificaciones push no disponibles');
      return;
    }

    try {
      PushNotifications = window.Capacitor.Plugins.PushNotifications;
    } catch (e) {
      console.warn('[CoterPush] Plugin PushNotifications no encontrado:', e.message);
      return;
    }

    if (!PushNotifications) {
      console.warn('[CoterPush] Plugin PushNotifications no disponible');
      return;
    }

    // Solicitar permisos de notificación
    PushNotifications.requestPermissions().then(function (result) {
      if (result.receive === 'granted') {
        console.log('[CoterPush] Permisos concedidos');
        PushNotifications.register();
      } else {
        console.log('[CoterPush] Permisos denegados por el usuario');
      }
    }).catch(function (e) {
      console.warn('[CoterPush] Error solicitando permisos:', e);
    });

    // Token FCM recibido al registrarse
    PushNotifications.addListener('registration', function (data) {
      console.log('[CoterPush] Token FCM recibido:', data.value);
      if (onToken) onToken(data.value);

      // Registrar token en el backend
      registerTokenOnServer(data.value, apiBase);
    });

    // Error de registro
    PushNotifications.addListener('registrationError', function (err) {
      console.error('[CoterPush] Error de registro:', err);
    });

    // Notificación recibida en foreground
    PushNotifications.addListener('pushNotificationReceived', function (notification) {
      console.log('[CoterPush] Notificación recibida en foreground:', notification);
      if (onNotification) onNotification(notification);
    });

    // Usuario tocó la notificación y se abrió la app
    PushNotifications.addListener('pushNotificationActionPerformed', function (notification) {
      console.log('[CoterPush] Notificación abierta:', notification);
      if (onNotification) onNotification({ ...notification, source: 'tap' });
    });
  }

  /**
   * Registra el token FCM en el backend para que el servidor pueda enviar notificaciones.
   */
  async function registerTokenOnServer(token, apiBase) {
    try {
      var patient = null;
      try {
        patient = JSON.parse(localStorage.getItem('coter_patient') || '{}');
      } catch (e) {}

      if (patient && patient.patient_id) {
        var r = await fetch(apiBase + '/patients/' + patient.patient_id + '/push-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token, platform: 'android' }),
          credentials: 'include'
        });
        if (r.ok) {
          console.log('[CoterPush] Token registrado en el servidor');
        }
      }
    } catch (e) {
      console.warn('[CoterPush] Error registrando token en servidor:', e);
    }
  }

  window.CoterPush = { init: init };
})();
