// ════════════════════════════════════════════════════════════════════════════
// www/js/interactive-widgets.js
// ════════════════════════════════════════════════════════════════════════════
// Widgets interactivos para las plantillas clásicas (classic templates).
// Convierte fichas de instrucciones estáticas en mini-apps interactivas.
//
// EXPONE: window.InteractiveWidgets {
//   render(parent, assignment, opts) → mountEl
//     Detecta el widget adecuado según el título/categoría de la plantilla
//     y monta la experiencia interactiva en `parent`.
//
//   getWidgetState(aid) → { widget, data }
//     Recupera el estado guardado en localStorage para continuar donde se dejó.
//
//   isWidgetTemplate(title, category) → boolean
//     Devuelve true si esta plantilla tiene un widget interactivo asociado.
// }
//
// Fase 1 — Reestructuración Cognitiva:
//   - ThoughtRecordLite         → "Registro de pensamientos automáticos"
//   - SocraticDialogue          → "Cuestionamiento socrático"
//   - DistortionDetective       → "Identificación de distorsiones cognitivas"
//
// Fase 2 — Activación Conductual:
//   - BAActivityDiary           → "Diario de actividades"
//   - BAWeeklyPlan              → "Plan semanal"
//   - PleasantActivitiesScheduler → "Programación de actividades placenteras"
//
// Fase 3 — Exposición y Ansiedad:
//   - ExposureHierarchy         → "Jerarquía de exposición"
//   - ExposureLog               → "Registro de exposición"
//   - InteractiveGrounding       → "Grounding 5-4-3-2-1"
// ════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  if (!window.InteractiveWidgets) window.InteractiveWidgets = {};
  var ns = window.InteractiveWidgets;

  // ─── Helpers DOM ────────────────────────────────────────────────────
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'className') node.className = attrs[k];
      else if (k === 'dataset') Object.assign(node.dataset, attrs[k]);
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, attrs[k]);
    }
    if (children) for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  // ─── Persistencia local (localStorage) ──────────────────────────────
  var STORAGE_KEY = 'coter_widget_states';

  function loadStates() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveStates(states) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(states)); } catch (e) {}
  }

  ns.getWidgetState = function (aid) {
    var states = loadStates();
    return states[aid] || null;
  };

  function setWidgetState(aid, data) {
    var states = loadStates();
    states[aid] = { widget: states[aid] ? states[aid].widget : null, data: data, updatedAt: Date.now() };
    saveStates(states);
  }

  // Limpia el estado de localStorage al completar (evita acumulación indefinida)
  ns.clearWidgetState = function (aid) {
    var states = loadStates();
    delete states[aid];
    saveStates(states);
  };

  // ─── Componentes visuales reutilizables ─────────────────────────────

  // Slider visual con emojis (0-10)
  var MOOD_LABELS = ['Muy bien, ánimo 10', 'Bien, ánimo 8', 'Neutral, ánimo 6', 'Regular, ánimo 4', 'Mal, ánimo 2', 'Muy mal, ánimo 0'];
  function MoodSlider(cfg) {
    var wrap = el('div', { className: 'iw-mood-slider' });
    var label = el('div', { className: 'iw-mood-label', text: cfg.label || 'Intensidad' });
    var emojis = el('div', { className: 'iw-mood-emojis', role: 'radiogroup', 'aria-label': cfg.label || 'Intensidad' });
    ['😊','🙂','😐','😕','😟','😰'].forEach(function (emo, i) {
      var value = 10 - i * 2;
      var btn = el('button', { type: 'button', className: 'iw-emoji-btn', dataset: { val: String(value) }, role: 'radio', 'aria-checked': 'false', 'aria-label': MOOD_LABELS[i] }, [emo]);
      btn.addEventListener('click', function () {
        selectEmoji(emojis, btn);
      });
      btn.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
          ev.preventDefault();
          var next = btn.nextElementSibling;
          if (next && next.classList.contains('iw-emoji-btn')) { selectEmoji(emojis, next); next.focus(); }
        } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          var prev = btn.previousElementSibling;
          if (prev && prev.classList.contains('iw-emoji-btn')) { selectEmoji(emojis, prev); prev.focus(); }
        } else if (ev.key === ' ' || ev.key === 'Enter') {
          ev.preventDefault(); selectEmoji(emojis, btn);
        }
      });
      emojis.appendChild(btn);
    });
    function selectEmoji(group, selected) {
      var btns = group.querySelectorAll('.iw-emoji-btn');
      btns.forEach(function (b) { b.classList.remove('active'); b.setAttribute('aria-checked', 'false'); });
      selected.classList.add('active');
      selected.setAttribute('aria-checked', 'true');
      if (cfg.onChange) cfg.onChange(Number(selected.dataset.val));
    }
    wrap.appendChild(label);
    wrap.appendChild(emojis);
    return wrap;
  }

  // Slider numérico con barra de progreso visual
  function IntensityBar(cfg) {
    var wrap = el('div', { className: 'iw-intensity-bar' });
    var top = el('div', { className: 'iw-intensity-top' });
    var labelText = cfg.label || 'Intensidad';
    top.appendChild(el('span', { className: 'iw-intensity-label', text: labelText }));
    var val = el('span', { className: 'iw-intensity-value', text: String(cfg.value != null ? cfg.value : 5), 'aria-live': 'polite' });
    top.appendChild(val);
    var minVal = cfg.min != null ? cfg.min : 0;
    var maxVal = cfg.max != null ? cfg.max : 10;
    var curVal = cfg.value != null ? cfg.value : 5;
    var slider = el('input', { type: 'range', className: 'iw-intensity-slider', 'aria-label': labelText, 'aria-valuemin': String(minVal), 'aria-valuemax': String(maxVal), 'aria-valuenow': String(curVal) });
    slider.min = minVal;
    slider.max = maxVal;
    slider.value = curVal;
    var fill = el('div', { className: 'iw-intensity-fill', 'aria-hidden': 'true' });
    fill.style.width = ((slider.value - slider.min) / (slider.max - slider.min) * 100) + '%';
    slider.addEventListener('input', function () {
      val.textContent = slider.value;
      slider.setAttribute('aria-valuenow', slider.value);
      fill.style.width = ((slider.value - slider.min) / (slider.max - slider.min) * 100) + '%';
      if (cfg.onChange) cfg.onChange(Number(slider.value));
    });
    wrap.appendChild(top);
    wrap.appendChild(slider);
    wrap.appendChild(fill);
    return wrap;
  }

  // Chip selector (distorsiones, emociones, etc.)
  function ChipGrid(cfg) {
    var wrap = el('div', { className: 'iw-chip-grid' });
    var groupLabel = cfg.title || 'Opciones';
    if (cfg.title) wrap.appendChild(el('div', { className: 'iw-chip-title', text: cfg.title }));
    var grid = el('div', { className: 'iw-chips', role: 'group', 'aria-label': groupLabel });
    var selected = new Set(cfg.selected || []);
    (cfg.options || []).forEach(function (opt) {
      var key = typeof opt === 'string' ? opt : opt.key;
      var label = typeof opt === 'string' ? opt : opt.label;
      var desc = opt.description || '';
      var isActive = selected.has(key);
      var chip = el('button', { type: 'button', className: 'iw-chip' + (isActive ? ' active' : ''), 'aria-pressed': isActive ? 'true' : 'false', 'aria-label': desc ? label + ': ' + desc : label });
      chip.appendChild(el('span', { className: 'iw-chip-label', text: label, 'aria-hidden': 'true' }));
      if (desc) chip.appendChild(el('span', { className: 'iw-chip-desc', text: desc, 'aria-hidden': 'true' }));
      chip.addEventListener('click', function (ev) {
        ev.preventDefault();
        toggleChip(chip, selected, key, cfg);
      });
      chip.addEventListener('keydown', function (ev) {
        var chips = grid.querySelectorAll('.iw-chip');
        var idx = Array.prototype.indexOf.call(chips, chip);
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
          ev.preventDefault();
          var next = chips[idx + 1] || chips[0];
          if (next) next.focus();
        } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          var prev = chips[idx - 1] || chips[chips.length - 1];
          if (prev) prev.focus();
        } else if (ev.key === ' ') {
          ev.preventDefault();
          toggleChip(chip, selected, key, cfg);
        }
      });
      grid.appendChild(chip);
    });
    function toggleChip(chip, set, key, cfg) {
      if (set.has(key)) set.delete(key); else set.add(key);
      var nowActive = set.has(key);
      chip.classList.toggle('active', nowActive);
      chip.setAttribute('aria-pressed', nowActive ? 'true' : 'false');
      if (cfg.onChange) cfg.onChange(Array.from(set));
    }
    wrap.appendChild(grid);
    return wrap;
  }

  // Tarjeta de evidencia (a favor / en contra) con animación de balanza
  function EvidenceBalance(cfg) {
    var wrap = el('div', { className: 'iw-evidence-balance' });
    var cols = el('div', { className: 'iw-evidence-cols' });

    var forCol = el('div', { className: 'iw-evidence-col for' });
    forCol.appendChild(el('div', { className: 'iw-evidence-col-title', text: '✅ A favor' }));
    var forTa = el('textarea', { className: 'iw-evidence-ta', rows: 3, placeholder: 'Hechos que respaldan este pensamiento…', 'aria-label': 'Evidencia a favor' });
    forTa.value = cfg.forText || '';
    forTa.addEventListener('input', function () {
      if (cfg.onChange) cfg.onChange({ for: forTa.value, against: againstTa.value });
    });
    forCol.appendChild(forTa);

    var againstCol = el('div', { className: 'iw-evidence-col against' });
    againstCol.appendChild(el('div', { className: 'iw-evidence-col-title', text: '❌ En contra' }));
    var againstTa = el('textarea', { className: 'iw-evidence-ta', rows: 3, placeholder: 'Hechos que contradicen este pensamiento…', 'aria-label': 'Evidencia en contra' });
    againstTa.value = cfg.againstText || '';
    againstTa.addEventListener('input', function () {
      if (cfg.onChange) cfg.onChange({ for: forTa.value, against: againstTa.value });
    });
    againstCol.appendChild(againstTa);

    cols.appendChild(forCol);
    cols.appendChild(againstCol);
    wrap.appendChild(cols);
    return wrap;
  }

  // Step Wizard con progreso visual
  function StepWizard(cfg) {
    var wrap = el('div', { className: 'iw-step-wizard' });
    var current = cfg.current || 0;
    var steps = cfg.steps || [];
    var total = steps.length;

    // Progress bar
    var progBar = el('div', { className: 'iw-wizard-progress' });
    var progFill = el('div', { className: 'iw-wizard-progress-fill' });
    progFill.style.width = (total > 0 ? (current / total * 100) : 0) + '%';
    progBar.appendChild(progFill);
    wrap.appendChild(progBar);

    // Step indicator
    var indicator = el('div', { className: 'iw-wizard-indicator', text: 'Paso ' + (current + 1) + ' de ' + total });
    wrap.appendChild(indicator);

    // Step content
    var content = el('div', { className: 'iw-wizard-content' });
    if (steps[current]) {
      content.appendChild(el('div', { className: 'iw-wizard-step-title', text: steps[current].title }));
      if (steps[current].description) content.appendChild(el('div', { className: 'iw-wizard-step-desc', text: steps[current].description }));
      if (steps[current].render) content.appendChild(steps[current].render());
    }
    wrap.appendChild(content);

    // Navigation
    var nav = el('div', { className: 'iw-wizard-nav' });
    var prevBtn = el('button', { type: 'button', className: 'btn btn-s iw-wizard-prev', text: '← Anterior' });
    prevBtn.disabled = current === 0;
    var nextBtn = el('button', { type: 'button', className: 'btn btn-p iw-wizard-next', text: current === total - 1 ? '✓ Finalizar' : 'Siguiente →' });

    prevBtn.addEventListener('click', function () {
      if (current > 0 && cfg.onStep) cfg.onStep(current - 1);
    });
    nextBtn.addEventListener('click', function () {
      if (current < total - 1) {
        if (cfg.onStep) cfg.onStep(current + 1);
      } else {
        if (cfg.onComplete) cfg.onComplete();
      }
    });

    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);
    wrap.appendChild(nav);

    return wrap;
  }

  // ─── Thought Card Flip ──────────────────────────────────────────────
  function ThoughtCard(cfg) {
    var wrap = el('div', { className: 'iw-thought-card' });
    wrap.appendChild(el('div', { className: 'iw-thought-card-label', text: cfg.label || 'Pensamiento' }));
    var box = el('div', { className: 'iw-thought-card-box' });
    var content = el('div', { className: 'iw-thought-card-content' });
    content.appendChild(el('div', { className: 'iw-thought-card-before', html: '<span class=\"iw-thought-card-tag\">Automático</span>' + (cfg.autoThought || '…') }));
    if (cfg.alternative) {
      content.appendChild(el('div', { className: 'iw-thought-card-after', html: '<span class=\"iw-thought-card-tag alt\">Alternativo</span>' + cfg.alternative }));
    }
    box.appendChild(content);
    wrap.appendChild(box);
    return wrap;
  }

  // ═══════════════════════════════════════════════════════════════════
  // WIDGET 1: Thought Record Lite
  // Para: "Registro de pensamientos automáticos"
  // ═══════════════════════════════════════════════════════════════════
  function ThoughtRecordLite(parent, assignment, opts) {
    var saved = ns.getWidgetState(assignment.id);
    var data = (saved && saved.data) || { step: 0, situation: '', autoThought: '', emotion: '', intensity: 5, distortions: [], evidenceFor: '', evidenceAgainst: '', alternative: '' };

    function save() { setWidgetState(assignment.id, data); }

    var DISTORTIONS = [
      { key: 'all_or_nothing', label: 'Todo o nada', description: 'Ver en extremos, sin matices' },
      { key: 'catastrophizing', label: 'Catastrofismo', description: 'Anticipar lo peor posible' },
      { key: 'overgeneralization', label: 'Sobregeneralización', description: '"Siempre me pasa esto"' },
      { key: 'mental_filter', label: 'Filtro mental', description: 'Solo ver lo negativo' },
      { key: 'mind_reading', label: 'Lectura de mente', description: 'Asumir lo que otros piensan' },
      { key: 'emotional_reasoning', label: 'Razonamiento emocional', description: '"Me siento mal, así que es verdad"' },
      { key: 'should_statements', label: 'Deberías', description: 'Exigencias rígidas' },
      { key: 'labeling', label: 'Etiquetado', description: '"Soy un fracaso" en vez de "cometí un error"' },
      { key: 'personalization', label: 'Personalización', description: 'Culparte por todo' },
      { key: 'fortune_telling', label: 'Predicción del futuro', description: 'Anticipar que saldrá mal' },
    ];

    var mount = el('div', { className: 'iw-widget iw-tr-lite' });

    function renderStep() {
      mount.innerHTML = '';

      // Header con instrucción
      var header = el('div', { className: 'iw-widget-header' });
      header.appendChild(el('div', { className: 'iw-widget-title', text: '🧠 Registro de pensamientos' }));
      if (assignment.instructions) {
        var inst = el('div', { className: 'iw-widget-instructions', text: assignment.instructions.slice(0, 200) + (assignment.instructions.length > 200 ? '…' : '') });
        inst.style.maxHeight = '60px';
        inst.style.overflow = 'hidden';
        header.appendChild(inst);
      }
      mount.appendChild(header);

      if (data.step === 0) {
        // Paso 1: Situación
        var s1 = el('div', { className: 'iw-step' });
        s1.appendChild(el('div', { className: 'iw-step-num', text: '1' }));
        s1.appendChild(el('div', { className: 'iw-step-label', text: 'Describe la situación' }));
        var ta = el('textarea', { className: 'iw-textarea', rows: 3, placeholder: '¿Qué pasó? ¿Dónde estabas? ¿Con quién? Solo hechos…' });
        ta.value = data.situation || '';
        ta.addEventListener('input', function () { data.situation = ta.value; save(); });
        s1.appendChild(ta);
        mount.appendChild(s1);
      } else if (data.step === 1) {
        // Paso 2: Pensamiento automático
        var s2 = el('div', { className: 'iw-step' });
        s2.appendChild(el('div', { className: 'iw-step-num', text: '2' }));
        s2.appendChild(el('div', { className: 'iw-step-label', text: '¿Qué pensamiento pasó por tu mente?' }));
        var ta2 = el('textarea', { className: 'iw-textarea', rows: 2, placeholder: 'Lo más literal posible. Una frase…' });
        ta2.value = data.autoThought || '';
        ta2.addEventListener('input', function () { data.autoThought = ta2.value; save(); });
        s2.appendChild(ta2);
        mount.appendChild(s2);
      } else if (data.step === 2) {
        // Paso 3: Emoción + intensidad
        var s3 = el('div', { className: 'iw-step' });
        s3.appendChild(el('div', { className: 'iw-step-num', text: '3' }));
        s3.appendChild(el('div', { className: 'iw-step-label', text: '¿Qué emoción sentiste?' }));
        var inp = el('input', { type: 'text', className: 'iw-input', placeholder: 'ansiedad, tristeza, ira, culpa…' });
        inp.value = data.emotion || '';
        inp.addEventListener('input', function () { data.emotion = inp.value; save(); });
        s3.appendChild(inp);
        s3.appendChild(IntensityBar({ label: 'Intensidad (0-10)', value: data.intensity, onChange: function (v) { data.intensity = v; save(); } }));
        mount.appendChild(s3);
      } else if (data.step === 3) {
        // Paso 4: Distorsiones
        var s4 = el('div', { className: 'iw-step' });
        s4.appendChild(el('div', { className: 'iw-step-num', text: '4' }));
        s4.appendChild(el('div', { className: 'iw-step-label', text: '¿Qué distorsiones detectas?' }));
        s4.appendChild(ChipGrid({ options: DISTORTIONS, selected: data.distortions, onChange: function (sel) { data.distortions = sel; save(); } }));
        mount.appendChild(s4);
      } else if (data.step === 4) {
        // Paso 5: Evidencia
        var s5 = el('div', { className: 'iw-step' });
        s5.appendChild(el('div', { className: 'iw-step-num', text: '5' }));
        s5.appendChild(el('div', { className: 'iw-step-label', text: 'Examina la evidencia' }));
        s5.appendChild(EvidenceBalance({ forText: data.evidenceFor, againstText: data.evidenceAgainst, onChange: function (v) { data.evidenceFor = v.for; data.evidenceAgainst = v.against; save(); } }));
        mount.appendChild(s5);
      } else if (data.step === 5) {
        // Paso 6: Pensamiento alternativo + resumen
        var s6 = el('div', { className: 'iw-step' });
        s6.appendChild(el('div', { className: 'iw-step-num', text: '6' }));
        s6.appendChild(el('div', { className: 'iw-step-label', text: 'Escribe un pensamiento más equilibrado' }));
        var ta3 = el('textarea', { className: 'iw-textarea', rows: 3, placeholder: 'Una versión más justa y basada en la evidencia…' });
        ta3.value = data.alternative || '';
        ta3.addEventListener('input', function () { data.alternative = ta3.value; save(); });
        s6.appendChild(ta3);

        // Resumen visual
        if (data.autoThought && data.alternative) {
          s6.appendChild(el('div', { className: 'iw-summary-divider', text: 'Tu progreso' }));
          s6.appendChild(ThoughtCard({ label: 'Transformación', autoThought: data.autoThought, alternative: data.alternative }));
        }
        mount.appendChild(s6);
      }
    }

    // Navegación
    var nav = el('div', { className: 'iw-widget-nav' });
    var prevBtn = el('button', { type: 'button', className: 'btn btn-s iw-nav-prev', text: '← Anterior', 'aria-label': 'Paso anterior' });
    prevBtn.disabled = data.step === 0;
    prevBtn.addEventListener('click', function () { if (data.step > 0) { data.step--; save(); renderStep(); renderNav(); } });

    var nextBtn = el('button', { type: 'button', className: 'btn btn-p iw-nav-next', text: data.step === 5 ? '✓ Completar' : 'Siguiente →', 'aria-label': data.step === 5 ? 'Completar el registro de pensamientos' : 'Paso siguiente' });
    nextBtn.addEventListener('click', function () {
      if (data.step < 5) { data.step++; save(); renderStep(); renderNav(); }
      else {
        mount.innerHTML = '';
        mount.appendChild(el('div', { className: 'iw-complete' }, [
          el('div', { className: 'iw-complete-icon', text: '✨' }),
          el('div', { className: 'iw-complete-title', text: '¡Registro completado!' }),
          el('div', { className: 'iw-complete-desc', text: 'Has identificado y cuestionado un pensamiento automático. Tu terapeuta podrá revisar este trabajo en la próxima sesión.' }),
        ]));
        if (opts && opts.onCompleted) opts.onCompleted(data);
      }
    });

    function renderNav() {
      nav.innerHTML = '';
      nav.appendChild(prevBtn);
      nav.appendChild(nextBtn);
      // Progress dots
      var dots = el('div', { className: 'iw-nav-dots' });
      for (var i = 0; i <= 5; i++) {
        dots.appendChild(el('span', { className: 'iw-nav-dot' + (i === data.step ? ' active' : i < data.step ? ' done' : ''), 'aria-label': 'Paso ' + (i + 1) + ' de 6' + (i === data.step ? ' (actual)' : i < data.step ? ' (completado)' : '') }));
      }
      nav.appendChild(dots);
      mount.appendChild(nav);
    }

    renderStep();
    renderNav();
    parent.appendChild(mount);
    return mount;
  }

  // ═══════════════════════════════════════════════════════════════════
  // WIDGET 2: Socratic Dialogue (Cuestionamiento Socrático)
  // ═══════════════════════════════════════════════════════════════════
  function SocraticDialogue(parent, assignment, opts) {
    var saved = ns.getWidgetState(assignment.id);
    var data = (saved && saved.data) || { step: 0, thought: '', q1: '', q2: '', q3: '', q4: '', q5: '', reflection: '' };

    function save() { setWidgetState(assignment.id, data); }

    var questions = [
      { key: 'q1', emoji: '🔍', title: '¿Qué evidencia tengo?', hint: 'Hechos concretos que apoyan este pensamiento', placeholder: 'Ej: Mi jefe no me miró cuando pasé…' },
      { key: 'q2', emoji: '🔄', title: '¿Qué evidencia NO tengo?', hint: 'Hechos que contradicen o no encajan', placeholder: 'Ej: Me saludó después, estaba concentrado…' },
      { key: 'q3', emoji: '👁️', title: '¿Estoy ignorando información?', hint: '¿Hay algo positivo o neutral que estoy pasando por alto?', placeholder: 'Ej: Otros días sí me ha mirado…' },
      { key: 'q4', emoji: '💬', title: '¿Qué le diría a un amigo?', hint: 'Si un ser querido tuviera este pensamiento, ¿cómo le responderías?', placeholder: 'Ej: Le diría que no saque conclusiones sin hablar…' },
      { key: 'q5', emoji: '⚖️', title: '¿Me ayuda o me perjudica?', hint: '¿Este pensamiento me acerca a mis objetivos o me aleja?', placeholder: 'Ej: Me perjudica porque me hace evitar a mi jefe…' },
    ];

    var mount = el('div', { className: 'iw-widget iw-socratic' });

    function render() {
      mount.innerHTML = '';

      var header = el('div', { className: 'iw-widget-header' });
      header.appendChild(el('div', { className: 'iw-widget-title', text: '💡 Cuestionamiento Socrático' }));
      mount.appendChild(header);

      if (data.step === 0) {
        var s0 = el('div', { className: 'iw-step iw-step-intro' });
        s0.appendChild(el('div', { className: 'iw-socratic-intro', html: '<p>Vamos a examinar un pensamiento con preguntas guiadas. No hay respuestas correctas o incorrectas — solo exploración honesta.</p>' }));
        s0.appendChild(el('div', { className: 'iw-step-label', text: '¿Qué pensamiento quieres examinar?' }));
        var ta = el('textarea', { className: 'iw-textarea', rows: 2, placeholder: 'Escribe el pensamiento que te gustaría cuestionar…' });
        ta.value = data.thought || '';
        ta.addEventListener('input', function () { data.thought = ta.value; save(); });
        s0.appendChild(ta);
        mount.appendChild(s0);
      } else if (data.step >= 1 && data.step <= 5) {
        var q = questions[data.step - 1];
        var sq = el('div', { className: 'iw-step' });
        var qhead = el('div', { className: 'iw-socratic-q' });
        qhead.appendChild(el('span', { className: 'iw-socratic-emoji', text: q.emoji }));
        qhead.appendChild(el('div', { className: 'iw-socratic-title', text: q.title }));
        qhead.appendChild(el('div', { className: 'iw-socratic-hint', text: q.hint }));
        sq.appendChild(qhead);
        var ta2 = el('textarea', { className: 'iw-textarea', rows: 3, placeholder: q.placeholder });
        ta2.value = data[q.key] || '';
        ta2.addEventListener('input', function () { data[q.key] = ta2.value; save(); });
        sq.appendChild(ta2);

        // Mostrar pensamiento original como referencia
        sq.appendChild(el('div', { className: 'iw-socratic-ref', html: '<span>Pensamiento examinado:</span> "' + (data.thought || '…') + '"' }));
        mount.appendChild(sq);
      } else if (data.step === 6) {
        // Reflexión final
        var sf = el('div', { className: 'iw-step' });
        sf.appendChild(el('div', { className: 'iw-step-label', text: 'Reflexión final' }));
        sf.appendChild(el('div', { className: 'iw-socratic-summary-title', text: 'Después de este cuestionamiento…' }));
        var ta3 = el('textarea', { className: 'iw-textarea', rows: 4, placeholder: '¿Cómo ves ahora ese pensamiento inicial? ¿Ha cambiado algo?' });
        ta3.value = data.reflection || '';
        ta3.addEventListener('input', function () { data.reflection = ta3.value; save(); });
        sf.appendChild(ta3);

        // Resumen de respuestas
        if (data.q1 || data.q2 || data.q3 || data.q4 || data.q5) {
          sf.appendChild(el('div', { className: 'iw-summary-divider', text: 'Tus respuestas' }));
          questions.forEach(function (q) {
            if (data[q.key]) {
              sf.appendChild(el('div', { className: 'iw-socratic-answer', html: '<span>' + q.emoji + ' ' + q.title + '</span> ' + data[q.key] }));
            }
          });
        }
        mount.appendChild(sf);
      } else if (data.step === 7) {
        mount.appendChild(el('div', { className: 'iw-complete' }, [
          el('div', { className: 'iw-complete-icon', text: '💡' }),
          el('div', { className: 'iw-complete-title', text: '¡Cuestionamiento completado!' }),
          el('div', { className: 'iw-complete-desc', text: 'Has examinado tu pensamiento desde múltiples ángulos. Esta práctica fortalece tu capacidad de ver las situaciones con más matices.' }),
        ]));
        if (opts && opts.onCompleted) opts.onCompleted(data);
        return;
      }

      // Navegación
      var nav = el('div', { className: 'iw-widget-nav' });
      var prevBtn = el('button', { type: 'button', className: 'btn btn-s iw-nav-prev', text: '← Anterior', 'aria-label': 'Paso anterior' });
      prevBtn.disabled = data.step === 0;
      prevBtn.addEventListener('click', function () { if (data.step > 0) { data.step--; save(); render(); } });

      var nextLabel = data.step === 6 ? '✓ Completar' : 'Siguiente →';
      var nextBtn = el('button', { type: 'button', className: 'btn btn-p iw-nav-next', text: nextLabel, 'aria-label': data.step === 6 ? 'Completar el cuestionamiento socrático' : 'Paso siguiente' });
      nextBtn.addEventListener('click', function () {
        if (data.step < 7) { data.step++; save(); render(); }
      });

      nav.appendChild(prevBtn);
      nav.appendChild(nextBtn);
      var dots = el('div', { className: 'iw-nav-dots' });
      for (var i = 0; i <= 7; i++) {
        dots.appendChild(el('span', { className: 'iw-nav-dot' + (i === data.step ? ' active' : i < data.step ? ' done' : '') }, 'aria-label': 'Paso ' + (i + 1) + ' de 8' + (i === data.step ? ' (actual)' : i < data.step ? ' (completado)' : '') }));
      }
      nav.appendChild(dots);
      mount.appendChild(nav);
    }

    render();
    parent.appendChild(mount);
    return mount;
  }

  // ═══════════════════════════════════════════════════════════════════
  // WIDGET 3: Distortion Detective
  // Para: "Identificación de distorsiones cognitivas"
  // ═══════════════════════════════════════════════════════════════════
  function DistortionDetective(parent, assignment, opts) {
    var saved = ns.getWidgetState(assignment.id);
    var data = (saved && saved.data) || { thoughts: [], currentIndex: 0 };

    function save() { setWidgetState(assignment.id, data); }

    var DISTORTIONS = [
      { key: 'all_or_nothing', label: 'Todo o nada', description: 'Ver las cosas en extremos: blanco o negro, éxito o fracaso total' },
      { key: 'catastrophizing', label: 'Catastrofismo', description: 'Anticipar el peor escenario posible sin evidencia' },
      { key: 'overgeneralization', label: 'Sobregeneralización', description: 'Un incidente aislado se convierte en patrón permanente' },
      { key: 'mental_filter', label: 'Filtro mental', description: 'Enfocarte solo en lo negativo, ignorando lo positivo' },
      { key: 'mind_reading', label: 'Lectura de mente', description: 'Asumir lo que otros piensan sin evidencia' },
      { key: 'emotional_reasoning', label: 'Razonamiento emocional', description: 'Creer que algo es cierto porque "se siente" así' },
      { key: 'should_statements', label: 'Declaraciones "debería"', description: 'Exigencias rígidas sobre cómo deberían ser las cosas' },
      { key: 'labeling', label: 'Etiquetado', description: 'Poner etiquetas globales en vez de describir conductas' },
      { key: 'personalization', label: 'Personalización', description: 'Atribuirte responsabilidad por eventos externos' },
      { key: 'fortune_telling', label: 'Predicción del futuro', description: 'Anticipar negativamente sin base real' },
      { key: 'disqualifying_positive', label: 'Invalidar lo positivo', description: 'Descartar logros diciendo "no cuenta"' },
      { key: 'blame', label: 'Culpabilización', description: 'Culpar a otros sin asumir tu parte' },
    ];

    var mount = el('div', { className: 'iw-widget iw-detective' });

    function addThought() {
      data.thoughts.push({ text: '', distortions: [] });
      data.currentIndex = data.thoughts.length - 1;
      save();
      render();
    }

    function render() {
      mount.innerHTML = '';

      var header = el('div', { className: 'iw-widget-header' });
      header.appendChild(el('div', { className: 'iw-widget-title', text: '🕵️ Detective de distorsiones' }));
      header.appendChild(el('div', { className: 'iw-widget-instructions', text: 'Anota pensamientos automáticos e identifica qué distorsiones contienen. El objetivo es reconocer patrones.' }));
      mount.appendChild(header);

      // Lista de pensamientos registrados
      if (data.thoughts.length > 0) {
        var list = el('div', { className: 'iw-detective-list', role: 'listbox', 'aria-label': 'Pensamientos registrados' });
        data.thoughts.forEach(function (t, idx) {
          var item = el('div', { className: 'iw-detective-item' + (idx === data.currentIndex ? ' active' : ''), role: 'option', 'aria-selected': idx === data.currentIndex ? 'true' : 'false', tabindex: 0 });
          item.appendChild(el('span', { className: 'iw-detective-item-num', text: String(idx + 1), 'aria-hidden': 'true' }));
          item.appendChild(el('span', { className: 'iw-detective-item-text', text: t.text || '(sin texto)' }));
          if (t.distortions.length > 0) {
            item.appendChild(el('span', { className: 'iw-detective-item-count', text: String(t.distortions.length) + ' dist.', 'aria-label': t.distortions.length + ' distorsiones' }));
          }
          item.addEventListener('click', function () { data.currentIndex = idx; save(); render(); });
          item.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); data.currentIndex = idx; save(); render(); }
            else if (ev.key === 'ArrowDown') { ev.preventDefault(); var next = list.children[idx + 1]; if (next) { next.focus(); next.click(); } }
            else if (ev.key === 'ArrowUp') { ev.preventDefault(); var prev = list.children[idx - 1]; if (prev) { prev.focus(); prev.click(); } }
          });
          list.appendChild(item);
        });
        mount.appendChild(list);
      }

      // Editor del pensamiento actual
      if (data.thoughts.length > 0 && data.currentIndex < data.thoughts.length) {
        var t = data.thoughts[data.currentIndex];
        var editor = el('div', { className: 'iw-detective-editor' });

        var ta = el('textarea', { className: 'iw-textarea', rows: 2, placeholder: 'Escribe el pensamiento automático…' });
        ta.value = t.text || '';
        ta.addEventListener('input', function () { t.text = ta.value; save(); });
        editor.appendChild(el('div', { className: 'iw-step-label', text: 'Pensamiento ' + (data.currentIndex + 1) }));
        editor.appendChild(ta);

        editor.appendChild(ChipGrid({ title: 'Selecciona las distorsiones:', options: DISTORTIONS, selected: t.distortions, onChange: function (sel) { t.distortions = sel; save(); } }));

        // Botón eliminar
        var delBtn = el('button', { type: 'button', className: 'btn btn-d btn-sm', text: '🗑 Eliminar este pensamiento', 'aria-label': 'Eliminar pensamiento ' + (data.currentIndex + 1) });
        delBtn.addEventListener('click', function () {
          data.thoughts.splice(data.currentIndex, 1);
          data.currentIndex = Math.min(data.currentIndex, data.thoughts.length - 1);
          save(); render();
        });
        editor.appendChild(delBtn);
        mount.appendChild(editor);
      }

      // Botón añadir pensamiento
      var addBtn = el('button', { type: 'button', className: 'btn btn-p iw-detective-add', text: '+ Añadir otro pensamiento', 'aria-label': 'Añadir otro pensamiento automático' });
      addBtn.addEventListener('click', addThought);
      mount.appendChild(addBtn);

      // Resumen / completar
      if (data.thoughts.length >= 2) {
        var summary = el('div', { className: 'iw-detective-summary' });
        var totalDistortions = 0;
        var distCounts = {};
        data.thoughts.forEach(function (t) {
          t.distortions.forEach(function (d) { distCounts[d] = (distCounts[d] || 0) + 1; totalDistortions++; });
        });
        summary.appendChild(el('div', { className: 'iw-summary-divider', text: 'Resumen: ' + data.thoughts.length + ' pensamientos, ' + totalDistortions + ' distorsiones detectadas' }));
        var topDist = Object.entries(distCounts).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 3);
        if (topDist.length > 0) {
          summary.appendChild(el('div', { className: 'iw-detective-top', text: 'Tus distorsiones más frecuentes:' }));
          topDist.forEach(function (entry) {
            var found = DISTORTIONS.find(function (d) { return d.key === entry[0]; });
            summary.appendChild(el('div', { className: 'iw-detective-top-item', html: '<strong>' + (found ? found.label : entry[0]) + '</strong>: ' + entry[1] + ' vez/veces' }));
          });
        }
        mount.appendChild(summary);

        var completeBtn = el('button', { type: 'button', className: 'btn btn-p iw-complete-btn', text: '✓ He terminado' });
        completeBtn.addEventListener('click', function () {
          mount.innerHTML = '';
          mount.appendChild(el('div', { className: 'iw-complete' }, [
            el('div', { className: 'iw-complete-icon', text: '🕵️' }),
            el('div', { className: 'iw-complete-title', text: '¡Ejercicio completado!' }),
            el('div', { className: 'iw-complete-desc', text: 'Has identificado ' + data.thoughts.length + ' pensamientos y detectado ' + totalDistortions + ' distorsiones. Reconocer estos patrones es el primer paso para cambiarlos.' }),
          ]));
          if (opts && opts.onCompleted) opts.onCompleted(data);
        });
        mount.appendChild(completeBtn);
      }
    }

    // Empezar con un pensamiento vacío si no hay
    if (data.thoughts.length === 0) addThought();
    else render();

    parent.appendChild(mount);
    return mount;
  }

  // ═══════════════════════════════════════════════════════════════════
  // WIDGET 4: BA Activity Diary (Diario de Actividades)
  // Para: "Diario de actividades" / "Registro diario de actividades"
  // ═══════════════════════════════════════════════════════════════════
  function BAActivityDiary(parent, assignment, opts) {
    var saved = ns.getWidgetState(assignment.id);
    var data = (saved && saved.data) || { activities: [{ time: '', activity: '', pleasure: 5, mastery: 5 }] };

    function save() { setWidgetState(assignment.id, data); }

    var mount = el('div', { className: 'iw-widget iw-ba-diary' });

    function addRow() {
      data.activities.push({ time: '', activity: '', pleasure: 5, mastery: 5 });
      save();
      render();
    }

    function removeRow(idx) {
      if (data.activities.length <= 1) return;
      data.activities.splice(idx, 1);
      save();
      render();
    }

    function render() {
      mount.innerHTML = '';

      var header = el('div', { className: 'iw-widget-header' });
      header.appendChild(el('div', { className: 'iw-widget-title', text: '📓 Diario de actividades' }));
      header.appendChild(el('div', { className: 'iw-widget-instructions', text: 'Registra tus actividades del día. Anota qué hiciste, cuánto placer te dio (0-10) y qué nivel de logro sentiste (0-10).' }));
      mount.appendChild(header);

      // Tabla de actividades
      var table = el('div', { className: 'iw-ba-table' });

      data.activities.forEach(function (act, idx) {
        var row = el('div', { className: 'iw-ba-row' });

        // Hora
        var timeWrap = el('div', { className: 'iw-ba-cell iw-ba-time' });
        timeWrap.appendChild(el('div', { className: 'iw-ba-cell-label', text: 'Hora' }));
        var timeInp = el('input', { type: 'text', className: 'iw-input', placeholder: '8:00 / mañana…', 'aria-label': 'Hora de la actividad ' + (idx + 1) });
        timeInp.value = act.time || '';
        timeInp.addEventListener('input', function () { act.time = timeInp.value; save(); });
        timeWrap.appendChild(timeInp);
        row.appendChild(timeWrap);

        // Actividad
        var actWrap = el('div', { className: 'iw-ba-cell iw-ba-activity' });
        actWrap.appendChild(el('div', { className: 'iw-ba-cell-label', text: 'Actividad' }));
        var actInp = el('input', { type: 'text', className: 'iw-input', placeholder: '¿Qué hiciste?', 'aria-label': 'Descripción de actividad ' + (idx + 1) });
        actInp.value = act.activity || '';
        actInp.addEventListener('input', function () { act.activity = actInp.value; save(); });
        actWrap.appendChild(actInp);
        row.appendChild(actWrap);

        // Placer
        var plWrap = el('div', { className: 'iw-ba-cell iw-ba-rating' });
        plWrap.appendChild(el('div', { className: 'iw-ba-cell-label', text: 'Placer' }));
        plWrap.appendChild(IntensityBar({ label: 'Placer actividad ' + (idx + 1), value: act.pleasure, onChange: function (v) { act.pleasure = v; save(); } }));
        row.appendChild(plWrap);

        // Logro
        var mstWrap = el('div', { className: 'iw-ba-cell iw-ba-rating' });
        mstWrap.appendChild(el('div', { className: 'iw-ba-cell-label', text: 'Logro' }));
        mstWrap.appendChild(IntensityBar({ label: 'Logro actividad ' + (idx + 1), value: act.mastery, onChange: function (v) { act.mastery = v; save(); } }));
        row.appendChild(mstWrap);

        // Eliminar
        var delBtn = el('button', { type: 'button', className: 'iw-ba-remove', text: '✕', 'aria-label': 'Eliminar actividad ' + (idx + 1) });
        delBtn.addEventListener('click', function () { removeRow(idx); });
        row.appendChild(delBtn);

        table.appendChild(row);
      });

      mount.appendChild(table);

      // Add button
      var addBtn = el('button', { type: 'button', className: 'btn btn-s iw-ba-add', text: '+ Añadir actividad', 'aria-label': 'Añadir otra actividad' });
      addBtn.addEventListener('click', addRow);
      mount.appendChild(addBtn);

      // Resumen y completar
      var filled = data.activities.filter(function (a) { return a.activity && a.activity.trim(); });
      var summary = el('div', { className: 'iw-detective-summary' });
      if (filled.length >= 1) {
        var avgPleasure = +(filled.reduce(function (s, a) { return s + (a.pleasure || 0); }, 0) / filled.length).toFixed(1);
        var avgMastery = +(filled.reduce(function (s, a) { return s + (a.mastery || 0); }, 0) / filled.length).toFixed(1);
        summary.appendChild(el('div', { className: 'iw-summary-divider', text: 'Resumen: ' + filled.length + ' actividad(es) registrada(s)' }));
        summary.appendChild(el('div', { className: 'iw-ba-summary-stats', html: '<span>Placer promedio: <strong>' + avgPleasure + '/10</strong></span><span>Logro promedio: <strong>' + avgMastery + '/10</strong></span>' }));
      }
      mount.appendChild(summary);

      var completeBtn = el('button', { type: 'button', className: 'btn btn-p iw-complete-btn', text: '✓ He terminado' });
      var finalMsg = filled.length >= 1
        ? 'Has registrado ' + filled.length + ' actividades con placer promedio de ' + (filled.length >= 1 ? (+(filled.reduce(function (s, a) { return s + (a.pleasure || 0); }, 0) / filled.length).toFixed(1)) : '—') + ' y logro de ' + (filled.length >= 1 ? (+(filled.reduce(function (s, a) { return s + (a.mastery || 0); }, 0) / filled.length).toFixed(1)) : '—') + '.'
        : 'No registraste actividades hoy. A veces reconocer un día difícil también es importante.';
      completeBtn.addEventListener('click', function () {
        mount.innerHTML = '';
        mount.appendChild(el('div', { className: 'iw-complete' }, [
          el('div', { className: 'iw-complete-icon', text: '📓' }),
          el('div', { className: 'iw-complete-title', text: '¡Diario completado!' }),
          el('div', { className: 'iw-complete-desc', text: finalMsg + ' Tu terapeuta puede ver este registro.' }),
        ]));
        if (opts && opts.onCompleted) opts.onCompleted(data);
      });
      mount.appendChild(completeBtn);
    }

    render();
    parent.appendChild(mount);
    return mount;
  }

  // ═══════════════════════════════════════════════════════════════════
  // WIDGET 5: BA Weekly Plan (Plan Semanal)
  // Para: "Plan semanal" / "Planificación semanal de actividades"
  // ═══════════════════════════════════════════════════════════════════
  function BAWeeklyPlan(parent, assignment, opts) {
    var saved = ns.getWidgetState(assignment.id);
    var DAYS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
    var DAY_LABELS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
    var defaultDays = {};
    DAYS.forEach(function (d) { defaultDays[d] = { plan: '', obstacles: '', planB: '' }; });
    var data = (saved && saved.data) || { activeDay: 0, days: defaultDays };
    // Merge saved days with defaults (por si se añaden/quitan días)
    DAYS.forEach(function (d) { if (!data.days[d]) data.days[d] = { plan: '', obstacles: '', planB: '' }; });

    function save() { setWidgetState(assignment.id, data); }

    var mount = el('div', { className: 'iw-widget iw-ba-weekly' });

    function render() {
      mount.innerHTML = '';

      var header = el('div', { className: 'iw-widget-header' });
      header.appendChild(el('div', { className: 'iw-widget-title', text: '📅 Plan semanal' }));
      header.appendChild(el('div', { className: 'iw-widget-instructions', text: 'Planifica una actividad para cada día. Identifica posibles obstáculos y prepara un plan alternativo.' }));
      mount.appendChild(header);

      // Day tabs
      var tabs = el('div', { className: 'iw-weekly-tabs', role: 'tablist', 'aria-label': 'Días de la semana' });
      DAYS.forEach(function (d, idx) {
        var hasContent = data.days[d].plan && data.days[d].plan.trim();
        var tab = el('button', { type: 'button', className: 'iw-weekly-tab' + (idx === data.activeDay ? ' active' : '') + (hasContent ? ' filled' : ''), role: 'tab', 'aria-selected': idx === data.activeDay ? 'true' : 'false', 'aria-label': DAY_LABELS[idx] + (hasContent ? ' (con plan)' : '') });
        tab.appendChild(el('span', { className: 'iw-weekly-tab-day', text: DAY_LABELS[idx].substring(0, 3) }));
        tab.addEventListener('click', function () { data.activeDay = idx; save(); render(); });
        tabs.appendChild(tab);
      });
      mount.appendChild(tabs);

      // Editor for active day
      var dayKey = DAYS[data.activeDay];
      var day = data.days[dayKey];
      var editor = el('div', { className: 'iw-weekly-editor' });

      editor.appendChild(el('div', { className: 'iw-step-label', text: DAY_LABELS[data.activeDay] }));

      // Actividad planificada
      editor.appendChild(el('div', { className: 'iw-ba-cell-label', text: 'Actividad planificada' }));
      var planTa = el('textarea', { className: 'iw-textarea', rows: 2, placeholder: '¿Qué actividad harás este día?', 'aria-label': 'Actividad para el ' + DAY_LABELS[data.activeDay] });
      planTa.value = day.plan || '';
      planTa.addEventListener('input', function () { day.plan = planTa.value; save(); });
      editor.appendChild(planTa);

      // Obstáculos
      editor.appendChild(el('div', { className: 'iw-ba-cell-label', text: 'Posibles obstáculos' }));
      var obstTa = el('textarea', { className: 'iw-textarea', rows: 2, placeholder: '¿Qué podría impedirte hacerlo?', 'aria-label': 'Obstáculos para el ' + DAY_LABELS[data.activeDay] });
      obstTa.value = day.obstacles || '';
      obstTa.addEventListener('input', function () { day.obstacles = obstTa.value; save(); });
      editor.appendChild(obstTa);

      // Plan B
      editor.appendChild(el('div', { className: 'iw-ba-cell-label', text: 'Plan B' }));
      var planBTa = el('textarea', { className: 'iw-textarea', rows: 2, placeholder: 'Si surge un obstáculo, ¿qué harás en su lugar?', 'aria-label': 'Plan B para el ' + DAY_LABELS[data.activeDay] });
      planBTa.value = day.planB || '';
      planBTa.addEventListener('input', function () { day.planB = planBTa.value; save(); });
      editor.appendChild(planBTa);

      mount.appendChild(editor);

      // Summary + complete
      var plannedDays = DAYS.filter(function (d) { return data.days[d].plan && data.days[d].plan.trim(); });
      if (plannedDays.length >= 1) {
        var summary = el('div', { className: 'iw-detective-summary' });
        summary.appendChild(el('div', { className: 'iw-summary-divider', text: 'Resumen: ' + plannedDays.length + ' de 7 días planificados' }));

        // Progress bar
        var progBar = el('div', { className: 'progress-bar' });
        var progFill = el('div', { className: 'progress-fill' });
        progFill.style.width = Math.round(plannedDays.length / 7 * 100) + '%';
        progBar.appendChild(progFill);
        summary.appendChild(progBar);
        mount.appendChild(summary);

        var completeBtn = el('button', { type: 'button', className: 'btn btn-p iw-complete-btn', text: '✓ He terminado' });
        completeBtn.addEventListener('click', function () {
          mount.innerHTML = '';
          mount.appendChild(el('div', { className: 'iw-complete' }, [
            el('div', { className: 'iw-complete-icon', text: '📅' }),
            el('div', { className: 'iw-complete-title', text: '¡Plan semanal completado!' }),
            el('div', { className: 'iw-complete-desc', text: 'Has planificado ' + plannedDays.length + ' de 7 días con actividades y estrategias de respaldo. ¡A por ello!' }),
          ]));
          if (opts && opts.onCompleted) opts.onCompleted(data);
        });
        mount.appendChild(completeBtn);
      }
    }

    render();
    parent.appendChild(mount);
    return mount;
  }

  // ═══════════════════════════════════════════════════════════════════
  // WIDGET 6: Pleasant Activities Scheduler
  // Para: "Programacion de actividades placenteras"
  // ═══════════════════════════════════════════════════════════════════
  function PleasantActivitiesScheduler(parent, assignment, opts) {
    var saved = ns.getWidgetState(assignment.id);
    var data = (saved && saved.data) || { activities: [] };

    function save() { setWidgetState(assignment.id, data); }

    var SUGGESTED = [
      'Dar un paseo al aire libre', 'Escuchar música que me gusta', 'Llamar a un amigo o familiar',
      'Leer un libro o revista', 'Ver una película o serie', 'Cocinar algo que me gusta',
      'Tomar un baño relajante', 'Practicar un hobby', 'Hacer ejercicio suave',
      'Escribir en un diario', 'Ordenar un espacio pequeño', 'Tomar un café o té tranquilo',
      'Salir a tomar el sol 10 min', 'Jugar con una mascota', 'Hacer estiramientos',
      'Mirar fotos de buenos recuerdos', 'Plantar o regar una planta', 'Escuchar un pódcast',
    ];

    var mount = el('div', { className: 'iw-widget iw-ba-pleasant' });

    function addActivity(name) {
      data.activities.push({ name: name || '', scheduled: '', predicted: 5, completed: false, actual: 0 });
      save();
      render();
    }

    function removeActivity(idx) {
      data.activities.splice(idx, 1);
      save();
      render();
    }

    function render() {
      mount.innerHTML = '';

      var header = el('div', { className: 'iw-widget-header' });
      header.appendChild(el('div', { className: 'iw-widget-title', text: '🌈 Actividades placenteras' }));
      header.appendChild(el('div', { className: 'iw-widget-instructions', text: 'Programa actividades que disfrutes. Predice cuánto las disfrutarás, hazlas, y compara con lo que realmente sentiste.' }));
      mount.appendChild(header);

      // Sugerencias rápidas
      var sugg = el('div', { className: 'iw-pleasant-suggestions' });
      sugg.appendChild(el('div', { className: 'iw-ba-cell-label', text: '💡 Sugerencias (clic para añadir):' }));
      var suggChips = el('div', { className: 'iw-chips' });
      SUGGESTED.forEach(function (s) {
        var alreadyAdded = data.activities.some(function (a) { return a.name === s; });
        if (alreadyAdded) return;
        var chip = el('button', { type: 'button', className: 'iw-chip', text: s, 'aria-label': 'Añadir: ' + s });
        chip.addEventListener('click', function () { addActivity(s); });
        suggChips.appendChild(chip);
      });
      sugg.appendChild(suggChips);
      mount.appendChild(sugg);

      // Actividades añadidas
      if (data.activities.length > 0) {
        var list = el('div', { className: 'iw-pleasant-list' });
        data.activities.forEach(function (act, idx) {
          var card = el('div', { className: 'iw-pleasant-card' });

          // Nombre
          var nameRow = el('div', { className: 'iw-pleasant-card-top' });
          var nameEl = el('span', { className: 'iw-pleasant-name', text: act.name || 'Nueva actividad' });
          var delBtn = el('button', { type: 'button', className: 'iw-ba-remove', text: '✕', 'aria-label': 'Eliminar: ' + (act.name || 'actividad sin nombre') });
          delBtn.addEventListener('click', function () { removeActivity(idx); });
          nameRow.appendChild(nameEl);
          nameRow.appendChild(delBtn);
          card.appendChild(nameRow);

          // Predicción
          card.appendChild(IntensityBar({ label: '¿Cuánto crees que disfrutarás? (0-10)', value: act.predicted, onChange: function (v) { act.predicted = v; save(); } }));

          // ¿Hecho?
          var doneRow = el('div', { className: 'iw-pleasant-done-row' });
          var doneLabel = el('label', { className: 'iw-pleasant-check-label' });
          var doneCheck = el('input', { type: 'checkbox', className: 'iw-pleasant-check' });
          doneCheck.checked = act.completed;
          doneCheck.addEventListener('change', function () { act.completed = doneCheck.checked; save(); render(); });
          doneLabel.appendChild(doneCheck);
          doneLabel.appendChild(document.createTextNode(' ¡Hecho! Ahora evalúa:'));
          doneRow.appendChild(doneLabel);
          card.appendChild(doneRow);

          // Satisfacción real (solo si completado)
          if (act.completed) {
            card.appendChild(IntensityBar({ label: '¿Cuánto disfrutaste realmente? (0-10)', value: act.actual || 0, onChange: function (v) { act.actual = v; save(); } }));
            // Comparación
            if (act.actual > 0) {
              var diff = act.actual - act.predicted;
              var compText = diff > 1 ? '¡Mejor de lo esperado! (+' + diff + ')' : diff < -1 ? 'No tan bien como esperaba (' + diff + ')' : 'Bastante cerca de lo esperado';
              var compClass = diff > 1 ? 'iw-pleasant-better' : diff < -1 ? 'iw-pleasant-worse' : 'iw-pleasant-neutral';
              card.appendChild(el('div', { className: 'iw-pleasant-compare ' + compClass, text: compText }));
            }
          }

          list.appendChild(card);
        });
        mount.appendChild(list);
      }

      // Añadir manualmente
      var addRow = el('div', { className: 'iw-pleasant-add-row' });
      var addInp = el('input', { type: 'text', className: 'iw-input', placeholder: 'Escribe tu propia actividad…', 'aria-label': 'Nombre de nueva actividad placentera' });
      var addBtn = el('button', { type: 'button', className: 'btn btn-s', text: 'Añadir', 'aria-label': 'Añadir actividad personalizada' });
      addBtn.addEventListener('click', function () { if (addInp.value.trim()) { addActivity(addInp.value.trim()); addInp.value = ''; } });
      addInp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && addInp.value.trim()) { addActivity(addInp.value.trim()); addInp.value = ''; } });
      addRow.appendChild(addInp);
      addRow.appendChild(addBtn);
      mount.appendChild(addRow);

      // Resumen y completar
      if (data.activities.length >= 1) {
        var completed = data.activities.filter(function (a) { return a.completed; });
        var summary = el('div', { className: 'iw-detective-summary' });
        summary.appendChild(el('div', { className: 'iw-summary-divider', text: 'Resumen: ' + data.activities.length + ' actividades, ' + completed.length + ' completadas' }));
        if (completed.length > 0) {
          var avgPredicted = +(completed.reduce(function (s, a) { return s + (a.predicted || 0); }, 0) / completed.length).toFixed(1);
          var avgActual = +(completed.reduce(function (s, a) { return s + (a.actual || 0); }, 0) / completed.length).toFixed(1);
          summary.appendChild(el('div', { className: 'iw-ba-summary-stats', html: '<span>Disfrute esperado: <strong>' + avgPredicted + '/10</strong></span><span>Disfrute real: <strong>' + avgActual + '/10</strong></span>' }));
        }
        mount.appendChild(summary);

        var completeBtn = el('button', { type: 'button', className: 'btn btn-p iw-complete-btn', text: '✓ He terminado' });
        completeBtn.addEventListener('click', function () {
          mount.innerHTML = '';
          mount.appendChild(el('div', { className: 'iw-complete' }, [
            el('div', { className: 'iw-complete-icon', text: '🌈' }),
            el('div', { className: 'iw-complete-title', text: '¡Ejercicio completado!' }),
            el('div', { className: 'iw-complete-desc', text: 'Has programado ' + data.activities.length + ' actividades placenteras y completado ' + completed.length + '. Comparar expectativas con la realidad ayuda a desafiar creencias de "no voy a disfrutarlo".' }),
          ]));
          if (opts && opts.onCompleted) opts.onCompleted(data);
        });
        mount.appendChild(completeBtn);
      }
    }

    render();
    parent.appendChild(mount);
    return mount;
  }

  // ═══════════════════════════════════════════════════════════════════
  // WIDGET 7: Exposure Hierarchy (Jerarquía de Exposición)
  // Para: "Jerarquía de exposición" / "Escalera de miedo"
  // ═══════════════════════════════════════════════════════════════════
  function ExposureHierarchy(parent, assignment, opts) {
    var saved = ns.getWidgetState(assignment.id);
    var data = (saved && saved.data) || { items: [], newName: '' };

    function save() { setWidgetState(assignment.id, data); }

    var mount = el('div', { className: 'iw-widget iw-exposure-hierarchy' });

    function addItem() {
      var name = (data.newName || '').trim();
      if (!name) return;
      data.items.push({ id: Date.now().toString(36), name: name, suds: 50 });
      data.newName = '';
      data.items.sort(function (a, b) { return a.suds - b.suds; });
      save();
      render();
    }

    function removeItem(id) {
      data.items = data.items.filter(function (it) { return it.id !== id; });
      save();
      render();
    }

    function updateSUDS(id, val) {
      var item = data.items.find(function (it) { return it.id === id; });
      if (item) { item.suds = val; data.items.sort(function (a, b) { return a.suds - b.suds; }); }
      save();
      render();
    }

    function render() {
      mount.innerHTML = '';

      var header = el('div', { className: 'iw-widget-header' });
      header.appendChild(el('div', { className: 'iw-widget-title', text: '🪜 Jerarquía de exposición' }));
      header.appendChild(el('div', { className: 'iw-widget-instructions', text: 'Crea tu escalera de situaciones temidas, de menor a mayor ansiedad. Evalúa cada situación con SUDS (0-100) y ordénalas.' }));
      mount.appendChild(header);

      // Ladder visual
      if (data.items.length > 0) {
        var ladder = el('div', { className: 'iw-ladder' });
        data.items.forEach(function (it, idx) {
          var rung = el('div', { className: 'iw-ladder-rung' });

          var info = el('div', { className: 'iw-ladder-info' });
          info.appendChild(el('span', { className: 'iw-ladder-num', text: String(idx + 1) }));
          info.appendChild(el('span', { className: 'iw-ladder-name', text: it.name }));
          rung.appendChild(info);

          var sudsWrap = el('div', { className: 'iw-ladder-suds' });
          sudsWrap.appendChild(IntensityBar({ label: 'SUDS ' + it.name, min: 0, max: 100, value: it.suds, onChange: function (v) { updateSUDS(it.id, v); } }));
          rung.appendChild(sudsWrap);

          var delBtn = el('button', { type: 'button', className: 'iw-ba-remove iw-ladder-del', text: '✕', 'aria-label': 'Eliminar: ' + it.name });
          delBtn.addEventListener('click', function () { removeItem(it.id); });
          rung.appendChild(delBtn);

          // Color band based on SUDS intensity
          var intensity = it.suds / 100;
          var hue = 120 - intensity * 120; // green(120) → red(0)
          rung.style.borderLeftColor = 'hsl(' + hue + ', 60%, 45%)';

          ladder.appendChild(rung);
        });
        mount.appendChild(ladder);
      }

      // Add item row
      var addRow = el('div', { className: 'iw-pleasant-add-row' });
      var addInp = el('input', { type: 'text', className: 'iw-input', placeholder: 'Situación temida (ej: hablar en público)…', value: data.newName || '', 'aria-label': 'Nueva situación para la jerarquía' });
      addInp.addEventListener('input', function () { data.newName = addInp.value; save(); });
      addInp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') addItem(); });
      var addBtn = el('button', { type: 'button', className: 'btn btn-s', text: 'Añadir', 'aria-label': 'Añadir situación a la jerarquía' });
      addBtn.addEventListener('click', addItem);
      addRow.appendChild(addInp);
      addRow.appendChild(addBtn);
      mount.appendChild(addRow);

      // Complete
      if (data.items.length >= 2) {
        var completeBtn = el('button', { type: 'button', className: 'btn btn-p iw-complete-btn', text: '✓ He terminado' });
        completeBtn.addEventListener('click', function () {
          mount.innerHTML = '';
          mount.appendChild(el('div', { className: 'iw-complete' }, [
            el('div', { className: 'iw-complete-icon', text: '🪜' }),
            el('div', { className: 'iw-complete-title', text: '¡Jerarquía creada!' }),
            el('div', { className: 'iw-complete-desc', text: 'Has definido ' + data.items.length + ' situaciones ordenadas por nivel de ansiedad. Empieza por las de abajo y ve subiendo.' }),
          ]));
          if (opts && opts.onCompleted) opts.onCompleted(data);
        });
        mount.appendChild(completeBtn);
      }
    }

    render();
    parent.appendChild(mount);
    return mount;
  }

  // ═══════════════════════════════════════════════════════════════════
  // WIDGET 8: Exposure Log (Registro de Exposición)
  // Para: "Registro de exposición" / "Diario de exposición"
  // ═══════════════════════════════════════════════════════════════════
  function ExposureLog(parent, assignment, opts) {
    var saved = ns.getWidgetState(assignment.id);
    var data = (saved && saved.data) || { sessions: [{ date: '', situation: '', sudsBefore: 50, sudsDuring: 40, sudsAfter: 30, duration: '', notes: '' }] };

    function save() { setWidgetState(assignment.id, data); }

    var mount = el('div', { className: 'iw-widget iw-exposure-log' });

    function addSession() {
      data.sessions.push({ date: '', situation: '', sudsBefore: 50, sudsDuring: 40, sudsAfter: 30, duration: '', notes: '' });
      save();
      render();
    }

    function removeSession(idx) {
      if (data.sessions.length <= 1) return;
      data.sessions.splice(idx, 1);
      save();
      render();
    }

    function render() {
      mount.innerHTML = '';

      var header = el('div', { className: 'iw-widget-header' });
      header.appendChild(el('div', { className: 'iw-widget-title', text: '📋 Registro de exposición' }));
      header.appendChild(el('div', { className: 'iw-widget-instructions', text: 'Registra cada sesión de exposición. Anota la situación, nivel de ansiedad antes/durante/después (SUDS 0-100), duración y observaciones.' }));
      mount.appendChild(header);

      var list = el('div', { className: 'iw-exposure-list' });

      data.sessions.forEach(function (sess, idx) {
        var card = el('div', { className: 'iw-exposure-card' });

        var topRow = el('div', { className: 'iw-exposure-top' });
        var numEl = el('span', { className: 'iw-ladder-num', text: String(idx + 1) });
        topRow.appendChild(numEl);

        // Date + situation
        var dp = el('div', { className: 'iw-exposure-main' });
        var dateInp = el('input', { type: 'date', className: 'iw-input iw-exposure-date', 'aria-label': 'Fecha sesión ' + (idx + 1) });
        dateInp.value = sess.date || '';
        dateInp.addEventListener('input', function () { sess.date = dateInp.value; save(); });
        dp.appendChild(dateInp);
        var sitInp = el('input', { type: 'text', className: 'iw-input', placeholder: 'Situación enfrentada…', 'aria-label': 'Situación sesión ' + (idx + 1) });
        sitInp.value = sess.situation || '';
        sitInp.addEventListener('input', function () { sess.situation = sitInp.value; save(); });
        dp.appendChild(sitInp);
        topRow.appendChild(dp);

        var delBtn = el('button', { type: 'button', className: 'iw-ba-remove', text: '✕', 'aria-label': 'Eliminar sesión ' + (idx + 1) });
        delBtn.addEventListener('click', function () { removeSession(idx); });
        topRow.appendChild(delBtn);
        card.appendChild(topRow);

        // SUDS track
        var sudsRow = el('div', { className: 'iw-exposure-suds-row' });
        sudsRow.appendChild(IntensityBar({ label: 'SUDS antes', min: 0, max: 100, value: sess.sudsBefore, onChange: function (v) { sess.sudsBefore = v; save(); } }));
        sudsRow.appendChild(IntensityBar({ label: 'SUDS durante', min: 0, max: 100, value: sess.sudsDuring, onChange: function (v) { sess.sudsDuring = v; save(); } }));
        sudsRow.appendChild(IntensityBar({ label: 'SUDS después', min: 0, max: 100, value: sess.sudsAfter, onChange: function (v) { sess.sudsAfter = v; save(); } }));
        card.appendChild(sudsRow);

        // Duration + notes
        var extraRow = el('div', { className: 'iw-exposure-extra' });
        var durInp = el('input', { type: 'text', className: 'iw-input', placeholder: 'Duración (ej: 20 min)', 'aria-label': 'Duración sesión ' + (idx + 1) });
        durInp.value = sess.duration || '';
        durInp.addEventListener('input', function () { sess.duration = durInp.value; save(); });
        extraRow.appendChild(durInp);
        var notesInp = el('input', { type: 'text', className: 'iw-input', placeholder: 'Notas / ¿qué aprendiste?', 'aria-label': 'Notas sesión ' + (idx + 1) });
        notesInp.value = sess.notes || '';
        notesInp.addEventListener('input', function () { sess.notes = notesInp.value; save(); });
        extraRow.appendChild(notesInp);
        card.appendChild(extraRow);

        // SUDS reduction badge
        var reduction = sess.sudsBefore - sess.sudsAfter;
        if (sess.sudsBefore > 0 && sess.sudsAfter > 0 && reduction > 0) {
          card.appendChild(el('div', { className: 'iw-exposure-reduction', html: '⬇️ Reducción SUDS: <strong>-' + reduction + '</strong> (' + Math.round(reduction / sess.sudsBefore * 100) + '%)' }));
        }

        list.appendChild(card);
      });

      mount.appendChild(list);

      var addBtn = el('button', { type: 'button', className: 'btn btn-s iw-ba-add', text: '+ Añadir sesión', 'aria-label': 'Añadir otra sesión de exposición' });
      addBtn.addEventListener('click', addSession);
      mount.appendChild(addBtn);

      // Summary
      var filled = data.sessions.filter(function (s) { return s.situation && s.situation.trim(); });
      if (filled.length >= 1) {
        var summary = el('div', { className: 'iw-detective-summary' });
        summary.appendChild(el('div', { className: 'iw-summary-divider', text: 'Resumen: ' + filled.length + ' sesión(es) registrada(s)' }));
        mount.appendChild(summary);

        var completeBtn = el('button', { type: 'button', className: 'btn btn-p iw-complete-btn', text: '✓ He terminado' });
        completeBtn.addEventListener('click', function () {
          mount.innerHTML = '';
          mount.appendChild(el('div', { className: 'iw-complete' }, [
            el('div', { className: 'iw-complete-icon', text: '📋' }),
            el('div', { className: 'iw-complete-title', text: '¡Registro completado!' }),
            el('div', { className: 'iw-complete-desc', text: 'Has documentado ' + filled.length + ' sesiones de exposición. Revisa cómo baja el SUDS con la práctica repetida.' }),
          ]));
          if (opts && opts.onCompleted) opts.onCompleted(data);
        });
        mount.appendChild(completeBtn);
      }
    }

    render();
    parent.appendChild(mount);
    return mount;
  }

  // ═══════════════════════════════════════════════════════════════════
  // WIDGET 9: Interactive Grounding (5-4-3-2-1)
  // Para: "Grounding 5-4-3-2-1" / "Técnica de anclaje"
  // ═══════════════════════════════════════════════════════════════════
  function InteractiveGrounding(parent, assignment, opts) {
    var saved = ns.getWidgetState(assignment.id);
    var data = (saved && saved.data) || { step: 0, see: ['','','','',''], touch: ['','','',''], hear: ['','',''], smell: ['',''], taste: '' };

    function save() { setWidgetState(assignment.id, data); }

    var STEPS = [
      { title: '5 cosas que puedes VER', icon: '👁️', field: 'see', count: 5, hint: 'Mira a tu alrededor y nombra 5 cosas que ves ahora mismo.' },
      { title: '4 cosas que puedes TOCAR', icon: '✋', field: 'touch', count: 4, hint: 'Siente 4 texturas diferentes a tu alcance.' },
      { title: '3 cosas que puedes OÍR', icon: '👂', field: 'hear', count: 3, hint: 'Cierra los ojos un momento y escucha 3 sonidos.' },
      { title: '2 cosas que puedes OLER', icon: '👃', field: 'smell', count: 2, hint: 'Huele 2 cosas cerca de ti (tu ropa, café, aire…).' },
      { title: '1 cosa que puedes SABOREAR', icon: '👅', field: 'taste', count: 1, hint: 'Nota un sabor en tu boca o toma un sorbo de agua.' },
    ];

    var mount = el('div', { className: 'iw-widget iw-grounding' });

    function render() {
      mount.innerHTML = '';

      var header = el('div', { className: 'iw-widget-header' });
      header.appendChild(el('div', { className: 'iw-widget-title', text: '🌍 Grounding 5-4-3-2-1' }));
      header.appendChild(el('div', { className: 'iw-widget-instructions', text: 'Técnica de anclaje al presente. Usa tus 5 sentidos para conectar con el aquí y ahora.' }));
      mount.appendChild(header);

      if (data.step <= 4) {
        var st = STEPS[data.step];
        var stepEl = el('div', { className: 'iw-step iw-grounding-step' });

        var headEl = el('div', { className: 'iw-grounding-head' });
        headEl.appendChild(el('span', { className: 'iw-socratic-emoji', text: st.icon }));
        headEl.appendChild(el('div', { className: 'iw-socratic-title', text: st.title }));
        headEl.appendChild(el('div', { className: 'iw-socratic-hint', text: st.hint }));
        stepEl.appendChild(headEl);

        var field = st.field;
        if (field === 'taste') {
          var inp = el('input', { type: 'text', className: 'iw-input', placeholder: 'Describe el sabor que notas…', 'aria-label': st.title });
          inp.value = data[field] || '';
          inp.addEventListener('input', function () { data[field] = inp.value; save(); });
          stepEl.appendChild(inp);
        } else {
          for (var i = 0; i < st.count; i++) {
            var row = el('div', { className: 'iw-grounding-row' });
            var num = el('span', { className: 'iw-ladder-num', text: String(i + 1) });
            row.appendChild(num);
            var gi = el('input', { type: 'text', className: 'iw-input', placeholder: (i + 1) + 'ª cosa…', 'aria-label': st.title + ', item ' + (i + 1) });
            gi.value = data[field][i] || '';
            gi.addEventListener('input', function () { data[field][i] = gi.value; save(); });
            row.appendChild(gi);
            stepEl.appendChild(row);
          }
        }
        mount.appendChild(stepEl);
      } else {
        // Step 5: Review
        var review = el('div', { className: 'iw-step' });
        review.appendChild(el('div', { className: 'iw-step-label', text: 'Resumen de tu grounding' }));

        var allItems = [];
        STEPS.forEach(function (st) {
          if (st.field === 'taste') {
            if (data.taste) allItems.push({ icon: st.icon, text: data.taste });
          } else {
            (data[st.field] || []).forEach(function (item) {
              if (item && item.trim()) allItems.push({ icon: st.icon, text: item });
            });
          }
        });

        if (allItems.length > 0) {
          var checklist = el('div', { className: 'iw-grounding-checklist' });
          allItems.forEach(function (ai) {
            checklist.appendChild(el('div', { className: 'iw-grounding-item', html: '<span>' + ai.icon + '</span> ' + ai.text }));
          });
          review.appendChild(checklist);
        }

        mount.appendChild(review);
      }

      // Navigation
      var nav = el('div', { className: 'iw-widget-nav' });
      var prevBtn = el('button', { type: 'button', className: 'btn btn-s iw-nav-prev', text: '← Anterior', 'aria-label': 'Paso anterior' });
      prevBtn.disabled = data.step === 0;
      prevBtn.addEventListener('click', function () { if (data.step > 0) { data.step--; save(); render(); } });

      var nextLabel = data.step === 5 ? '✓ Completar' : 'Siguiente →';
      var nextBtn = el('button', { type: 'button', className: 'btn btn-p iw-nav-next', text: nextLabel, 'aria-label': data.step === 5 ? 'Completar grounding' : 'Paso siguiente' });
      nextBtn.addEventListener('click', function () {
        if (data.step < 5) { data.step++; save(); render(); }
        else {
          mount.innerHTML = '';
          mount.appendChild(el('div', { className: 'iw-complete' }, [
            el('div', { className: 'iw-complete-icon', text: '🌍' }),
            el('div', { className: 'iw-complete-title', text: '¡Grounding completado!' }),
            el('div', { className: 'iw-complete-desc', text: 'Has practicado la técnica 5-4-3-2-1 conectando con tus sentidos. Úsala cuando te sientas abrumado.' }),
          ]));
          if (opts && opts.onCompleted) opts.onCompleted(data);
        }
      });

      nav.appendChild(prevBtn);
      nav.appendChild(nextBtn);
      var dots = el('div', { className: 'iw-nav-dots' });
      for (var i = 0; i <= 5; i++) {
        dots.appendChild(el('span', { className: 'iw-nav-dot' + (i === data.step ? ' active' : i < data.step ? ' done' : ''), 'aria-label': 'Paso ' + (i + 1) + ' de 6' + (i === data.step ? ' (actual)' : i < data.step ? ' (completado)' : '') }));
      }
      nav.appendChild(dots);
      mount.appendChild(nav);
    }

    render();
    parent.appendChild(mount);
    return mount;
  }

  // ═══════════════════════════════════════════════════════════════════
  // API Pública
  // ═══════════════════════════════════════════════════════════════════

  // Mapa de títulos de plantilla → widget renderer
  var WIDGET_MAP = {
    'Registro de pensamientos automaticos': ThoughtRecordLite,
    'Registro de pensamientos automáticos': ThoughtRecordLite,
    'Cuestionamiento socratico': SocraticDialogue,
    'Cuestionamiento socrático': SocraticDialogue,
    'Identificacion de distorsiones cognitivas': DistortionDetective,
    'Identificación de distorsiones cognitivas': DistortionDetective,
    'Diario de actividades': BAActivityDiary,
    'Registro diario de actividades': BAActivityDiary,
    'Plan semanal': BAWeeklyPlan,
    'Planificacion semanal de actividades': BAWeeklyPlan,
    'Planificación semanal de actividades': BAWeeklyPlan,
    'Programacion de actividades placenteras': PleasantActivitiesScheduler,
    'Programación de actividades placenteras': PleasantActivitiesScheduler,
    'Jerarquia de exposicion': ExposureHierarchy,
    'Jerarquía de exposición': ExposureHierarchy,
    'Escalera de miedo': ExposureHierarchy,
    'Registro de exposicion': ExposureLog,
    'Registro de exposición': ExposureLog,
    'Diario de exposicion': ExposureLog,
    'Grounding 5-4-3-2-1': InteractiveGrounding,
    'Grounding 54321': InteractiveGrounding,
    'Tecnica de anclaje': InteractiveGrounding,
    'Técnica de anclaje': InteractiveGrounding,
  };

  // Mapa de título → exercise_kind estable (para guardar en BD)
  var WIDGET_KIND_MAP = {
    'Registro de pensamientos automaticos': 'widget_thought_record_lite',
    'Registro de pensamientos automáticos': 'widget_thought_record_lite',
    'Cuestionamiento socratico': 'widget_socratic_dialogue',
    'Cuestionamiento socrático': 'widget_socratic_dialogue',
    'Identificacion de distorsiones cognitivas': 'widget_distortion_detective',
    'Identificación de distorsiones cognitivas': 'widget_distortion_detective',
    'Diario de actividades': 'widget_ba_activity_diary',
    'Registro diario de actividades': 'widget_ba_activity_diary',
    'Plan semanal': 'widget_ba_weekly_plan',
    'Planificacion semanal de actividades': 'widget_ba_weekly_plan',
    'Planificación semanal de actividades': 'widget_ba_weekly_plan',
    'Programacion de actividades placenteras': 'widget_ba_pleasant_activities',
    'Programación de actividades placenteras': 'widget_ba_pleasant_activities',
    'Jerarquia de exposicion': 'widget_exposure_hierarchy',
    'Jerarquía de exposición': 'widget_exposure_hierarchy',
    'Escalera de miedo': 'widget_exposure_hierarchy',
    'Registro de exposicion': 'widget_exposure_log',
    'Registro de exposición': 'widget_exposure_log',
    'Diario de exposicion': 'widget_exposure_log',
    'Grounding 5-4-3-2-1': 'widget_interactive_grounding',
    'Grounding 54321': 'widget_interactive_grounding',
    'Tecnica de anclaje': 'widget_interactive_grounding',
    'Técnica de anclaje': 'widget_interactive_grounding',
  };

  ns.WIDGET_MAP = WIDGET_MAP;

  ns.getWidgetKind = function (title) {
    var key = (title || '').toLowerCase()
      .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
      .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ñ/g, 'n');
    for (var k in WIDGET_KIND_MAP) {
      var nk = k.toLowerCase()
        .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
        .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ñ/g, 'n');
      if (key.indexOf(nk) !== -1 || nk.indexOf(key) !== -1) return WIDGET_KIND_MAP[k];
    }
    // Fallback estable: normalizar título sin caracteres problemáticos
    return 'widget_' + key.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').substring(0, 50);
  };

  ns.isWidgetTemplate = function (title, category) {
    // Normalizar título (sin acentos, lowercase)
    var key = (title || '').toLowerCase()
      .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
      .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ñ/g, 'n');
    // Buscar en WIDGET_MAP
    for (var k in WIDGET_MAP) {
      var nk = k.toLowerCase()
        .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
        .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ñ/g, 'n');
      if (key.indexOf(nk) !== -1 || nk.indexOf(key) !== -1) return true;
    }
    return false;
  };

  ns.getWidgetFor = function (title) {
    var key = (title || '').toLowerCase()
      .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
      .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ñ/g, 'n');
    for (var k in WIDGET_MAP) {
      var nk = k.toLowerCase()
        .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
        .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ñ/g, 'n');
      if (key.indexOf(nk) !== -1 || nk.indexOf(key) !== -1) return WIDGET_MAP[k];
    }
    return null;
  };

  ns.render = function (parent, assignment, opts) {
    var widgetFn = ns.getWidgetFor(assignment.title);
    if (!widgetFn) return null;
    return widgetFn(parent, assignment, opts || {});
  };
})();
