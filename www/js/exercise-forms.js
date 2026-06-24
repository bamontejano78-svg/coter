// ════════════════════════════════════════════════════════════════════════════
// www/js/exercise-forms.js
// ════════════════════════════════════════════════════════════════════════════
// Renderer compartido entre paciente y terapeuta para ejercicios clínicos
// embebidos (Thought Record, Activación Conductual, Exposición Gradual).
//
// EXPONE: window.ExerciseForms {
//
//   mountInteractiveCard(parent, assignment, latestSession, opts) → state
//     Paciente: monta un formulario interactivo con autosave 6s y botón de
//     finalizar. `assignment.exercise_schema` debe venir pre-resuelto por el
//     backend (variant mode/phobia resuelta). `latestSession` (opcional) trae
//     el estado guardado (respuestas merged, sin blob) para hidratar.
//
//   renderReadOnly(parent, schema, responses)
//     Terapeuta: pinta respuestas estructuradas a partir del schema y de
//     las respuestas (ya descifradas servidor). No es editable.
//
//   submitSession(aid)
//     Disparado por el botón "Finalizar ejercicio": POST /complete; pinta
//     errores 422 inline.
//
//   getStatus(aid) → 'clean' | 'dirty' | 'saving' | 'error'
//
// DISEÑO:
//   - Primitivas (textarea, scale, repeater, …) reusables para los 3 kinds.
//   - Compositores por kind (renderThoughtRecord, renderBA, renderGE)
//     que estructuran los steps clínicamente (TR numerado 1..N, BA rows
//     etiquetados, GE con ladder visual + select del paso).
//   - Autosave state machine por assignmentId con debounce 6s y lazy-mint
//     del session id (POST /start) en el primer PUT.
// ════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  if (!window.ExerciseForms) window.ExerciseForms = {};

  var ns = window.ExerciseForms;
  var AUTOSAVE_DEBOUNCE_MS = 6000;

  // ─── Estado por assignmentId ────────────────────────────────────────
  // sessionState[aid] = {
  //   aid, sid, kind, schema, responses,
  //   status: 'clean' | 'dirty' | 'saving' | 'error',
  //   timer, mountEl, badgeEl, opts
  // }
  var sessionState = {};

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

  // setResponse(state, path, value): soporta "a.b" y "emotions[2].intensity"
  function setResponse(state, path, value) {
    var tokens = [];
    var i = 0;
    while (i < path.length) {
      var ch = path[i];
      if (ch === '.') { i++; continue; }
      if (ch === '[') {
        var end = path.indexOf(']', i);
        tokens.push(parseInt(path.substring(i + 1, end), 10));
        i = end + 1;
        continue;
      }
      var nextDot = path.indexOf('.', i);
      var nextBrk = path.indexOf('[', i);
      var next = -1;
      if (nextDot === -1 && nextBrk === -1) next = path.length;
      else if (nextDot === -1) next = nextBrk;
      else if (nextBrk === -1) next = nextDot;
      else next = Math.min(nextDot, nextBrk);
      tokens.push(path.substring(i, next));
      i = next;
    }
    var cur = state.responses;
    for (var j = 0; j < tokens.length - 1; j++) {
      var t = tokens[j], n = tokens[j + 1];
      if (typeof t === 'number') {
        while (cur.length <= t) cur.push(typeof n === 'number' ? [] : {});
        cur = cur[t];
      } else {
        if (cur[t] == null || typeof cur[t] !== 'object') cur[t] = typeof n === 'number' ? [] : {};
        cur = cur[t];
      }
    }
    cur[tokens[tokens.length - 1]] = value;
  }

  function isMeaningful(v) {
    if (v == null) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  }

  // ─── Primitive inputs ───────────────────────────────────────────────
  function makeTextarea(field, val, onChange) {
    var ta = el('textarea', { className: 'ex-textarea', rows: 4, placeholder: field.placeholder || '' });
    ta.value = val || '';
    ta.addEventListener('input', function () { onChange(ta.value); });
    return ta;
  }
  function makeText(field, val, onChange) {
    var inp = el('input', { type: 'text', className: 'ex-text', placeholder: field.placeholder || '' });
    inp.value = val || '';
    inp.addEventListener('input', function () { onChange(inp.value); });
    return inp;
  }
  function makeNumber(field, val, onChange) {
    var inp = el('input', { type: 'number', className: 'ex-number', step: '1' });
    if (field.min != null) inp.min = field.min;
    if (field.max != null) inp.max = field.max;
    inp.value = val != null && val !== '' ? val : '';
    inp.addEventListener('input', function () {
      if (inp.value === '') return onChange(null);
      var n = Number(inp.value);
      onChange(Number.isFinite(n) ? n : null);
    });
    return inp;
  }
  function makeScale(field, val, onChange) {
    var min = field.min != null ? field.min : 0;
    var max = field.max != null ? field.max : 100;
    var wrap = el('div', { className: 'ex-scale' });
    var slider = el('input', { type: 'range' });
    slider.min = min; slider.max = max; slider.step = 1;
    var out = el('span', { className: 'ex-scale-value' });
    slider.value = val != null ? val : min;
    out.textContent = String(slider.value);
    slider.addEventListener('input', function () {
      out.textContent = String(slider.value);
      onChange(Number(slider.value));
    });
    wrap.appendChild(slider);
    wrap.appendChild(out);
    if (field.description) wrap.appendChild(el('div', { className: 'ex-scale-desc', text: field.description }));
    return wrap;
  }
  function makeDate(field, val, onChange) {
    var inp = el('input', { type: 'date', className: 'ex-date' });
    inp.value = val || '';
    inp.addEventListener('input', function () { onChange(inp.value); });
    return inp;
  }
  function makeBoolean(field, val, onChange) {
    var wrap = el('label', { className: 'ex-boolean' });
    var b = el('input', { type: 'checkbox' });
    b.checked = !!val;
    b.addEventListener('change', function () { onChange(b.checked); });
    wrap.appendChild(b);
    wrap.appendChild(document.createTextNode(' ' + (field.label || 'Completado')));
    return wrap;
  }
  function makeSelect(field, val, options, onChange) {
    var sel = el('select', { className: 'ex-select' });
    sel.appendChild(el('option', { value: '' }, ['—']));
    (options || []).forEach(function (o) {
      var key = typeof o === 'string' ? o : o.key;
      var label = typeof o === 'string' ? o : o.label;
      sel.appendChild(el('option', { value: key }, [label]));
    });
    sel.value = val != null ? String(val) : '';
    sel.addEventListener('change', function () { onChange(sel.value); });
    return sel;
  }
  function makeMultiSelect(field, val, options, onChange) {
    var wrap = el('div', { className: 'ex-multiselect' });
    var search = el('input', { type: 'text', className: 'ex-multiselect-search', placeholder: 'Buscar…' });
    var list = el('div', { className: 'ex-chip-list' });
    wrap.appendChild(search);
    wrap.appendChild(list);
    var arr = Array.isArray(val) ? val.slice() : [];
    var seen = new Set(arr);

    function renderList() {
      list.innerHTML = '';
      var q = (search.value || '').trim().toLowerCase();
      if (arr.length > 0) {
        list.appendChild(el('div', { className: 'ex-multiselect-summary', text: arr.length + ' seleccionada' + (arr.length === 1 ? '' : 's') }));
      }
      (options || []).forEach(function (o) {
        var key = typeof o === 'string' ? o : o.key;
        var label = typeof o === 'string' ? o : o.label;
        var desc = (typeof o === 'object' && o.description) ? o.description : '';
        if (q && label.toLowerCase().indexOf(q) === -1 && desc.toLowerCase().indexOf(q) === -1) return;
        var chip = el('button', { type: 'button', className: 'distortion-chip' + (seen.has(key) ? ' active' : '') });
        chip.appendChild(el('span', { className: 'distortion-chip-label', text: label }));
        if (desc) chip.appendChild(el('span', { className: 'distortion-chip-desc', text: desc }));
        chip.addEventListener('click', function (ev) {
          ev.preventDefault();
          if (seen.has(key)) seen.delete(key); else seen.add(key);
          arr.length = 0; arr.push.apply(arr, Array.from(seen));
          onChange(arr.slice());
          renderList();
        });
        list.appendChild(chip);
      });
    }
    search.addEventListener('input', renderList);
    renderList();
    return wrap;
  }
  function makeRepeater(field, val, onChange) {
    var wrap = el('div', { className: 'ex-repeater' });
    var rows = el('div', { className: 'ex-repeater-rows' });
    var addBtn = el('button', { type: 'button', className: 'btn btn-s btn-sm' }, ['+ Añadir']);
    wrap.appendChild(rows);
    wrap.appendChild(addBtn);

    var arr = Array.isArray(val) ? val.slice() : [];
    function commit() { onChange(arr); }
    function rerender() {
      rows.innerHTML = '';
      arr.forEach(function (it, i) { rows.appendChild(buildRow(i, it)); });
    }
    function onField(idx, key, v) {
      arr[idx] = arr[idx] || {};
      arr[idx][key] = v;
      commit();
    }
    function buildRow(idx, item) {
      var row = el('div', { className: 'emotion-row' });
      (field.fields || []).forEach(function (sf) {
        var cell = el('div', { className: 'emotion-row-cell' });
        cell.appendChild(el('div', { className: 'emotion-row-cell-label', text: sf.label || sf.key }));
        var v = item ? item[sf.key] : undefined;
        var ctrl;
        if (sf.type === 'text') ctrl = makeText(sf, v, function (x) { onField(idx, sf.key, x); });
        else if (sf.type === 'scale') ctrl = makeScale(sf, v, function (x) { onField(idx, sf.key, x); });
        else if (sf.type === 'number') ctrl = makeNumber(sf, v, function (x) { onField(idx, sf.key, x); });
        else ctrl = makeText(sf, v, function (x) { onField(idx, sf.key, x); });
        cell.appendChild(ctrl);
        row.appendChild(cell);
      });
      var delBtn = el('button', { type: 'button', className: 'btn btn-d btn-sm', text: '×' });
      delBtn.addEventListener('click', function () {
        arr.splice(idx, 1);
        rerender();
        commit();
      });
      row.appendChild(delBtn);
      return row;
    }
    addBtn.addEventListener('click', function () {
      arr.push({});
      rerender();
      commit();
    });
    rerender();
    return wrap;
  }

  function renderField(field, val, onChange, extra) {
    extra = extra || {};
    if (field.type === 'textarea') return makeTextarea(field, val, onChange);
    if (field.type === 'text') return makeText(field, val, onChange);
    if (field.type === 'number') return makeNumber(field, val, onChange);
    if (field.type === 'scale') return makeScale(field, val, onChange);
    if (field.type === 'date') return makeDate(field, val, onChange);
    if (field.type === 'boolean') return makeBoolean(field, val, onChange);
    if (field.type === 'select') return makeSelect(field, val, extra.options || field.options || [], onChange);
    if (field.type === 'multi_select') return makeMultiSelect(field, val, extra.options || field.options || [], onChange);
    if (field.type === 'repeater') return makeRepeater(field, val, onChange);
    return makeText(field, val, onChange);
  }

  function fieldGroup(cfg, ctrl) {
    var wrap = el('div', { className: 'ex-field' });
    var header = el('div', { className: 'ex-field-header' });
    if (cfg.number != null) header.appendChild(el('span', { className: 'tr-step-number', text: String(cfg.number) }));
    header.appendChild(el('div', { className: 'ex-field-label', text: cfg.label + (cfg.required ? '' : '  (opcional)') }));
    wrap.appendChild(header);
    wrap.appendChild(ctrl);
    if (cfg.helper) wrap.appendChild(el('div', { className: 'ex-field-helper', text: cfg.helper }));
    if (cfg.error) wrap.appendChild(el('div', { className: 'ex-field-error', text: cfg.error }));
    return wrap;
  }

  // ─── Compositores por kind ──────────────────────────────────────────
  function renderThoughtRecord(formEl, schema, responses) {
    formEl.innerHTML = '';
    if (schema.guidance) {
      formEl.appendChild(el('div', { className: 'ex-guidance', text: schema.guidance }));
    }
    schema.fields.forEach(function (f, idx) {
      var opts = f.source === 'catalog' ? schema.distortion_catalog || [] : (f.options || []);
      var fg = fieldGroup({
        number: idx + 1,
        label: f.label,
        required: !!f.required,
        helper: f.placeholder || f.description,
      }, renderField(f, responses[f.key], function (v) {
        setResponse({ responses: responses }, f.key, v);
        onUserInput(formEl);
      }, { options: opts }));
      fg.classList.add('tr-step');
      fg.dataset.field = f.key;
      formEl.appendChild(fg);
    });
  }

  function renderBA(formEl, schema, responses) {
    formEl.innerHTML = '';
    if (schema.guidance) {
      formEl.appendChild(el('div', { className: 'ex-guidance', text: schema.guidance }));
    }
    schema.fields.forEach(function (f, idx) {
      var fg = fieldGroup({
        number: idx + 1,
        label: f.label,
        required: !!f.required,
        helper: f.placeholder || f.description,
      }, renderField(f, responses[f.key], function (v) {
        setResponse({ responses: responses }, f.key, v);
        onUserInput(formEl);
      }, { options: f.options }));
      fg.classList.add('ba-row');
      fg.dataset.field = f.key;
      formEl.appendChild(fg);
    });
    if (schema.suggested_activities && Array.isArray(schema.suggested_activities) && schema.suggested_activities.length > 0) {
      var sugg = el('div', { className: 'ex-suggested' });
      sugg.appendChild(el('div', { className: 'ex-suggested-title', text: 'Sugerencias' }));
      var chips = el('div', { className: 'ex-chip-list' });
      schema.suggested_activities.forEach(function (s) {
        var chip = el('button', { type: 'button', className: 'distortion-chip static' }, [
          el('span', { className: 'distortion-chip-label', text: s.label })
        ]);
        chip.addEventListener('click', function (ev) {
          ev.preventDefault();
          var activityField = formEl.querySelector('[data-field="activity"]');
          if (activityField) {
            var ta = activityField.querySelector('textarea, input.ex-text');
            if (ta) {
              ta.value = s.label;
              ta.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }
        });
        chips.appendChild(chip);
      });
      sugg.appendChild(chips);
      formEl.appendChild(sugg);
    }
  }

  function renderGE(formEl, schema, responses) {
    formEl.innerHTML = '';
    // Ladder visual (read-only) para que el paciente vea el plan completo.
    var ladderWrap = el('div', { className: 'step-ladder' });
    ladderWrap.appendChild(el('div', { className: 'step-ladder-title', text: 'Jerarquía sugerida' }));
    var ol = el('ol', { className: 'step-ladder-list' });
    (schema.hierarchy || []).forEach(function (s) {
      var li = el('li', { className: 'step-ladder-item' });
      li.appendChild(el('span', { className: 'step-ladder-num', text: String(s.step) }));
      li.appendChild(el('span', { className: 'step-ladder-desc', text: s.description }));
      li.appendChild(el('span', { className: 'step-ladder-suds', text: 'SUDS esp. ' + s.expected_suds }));
      ol.appendChild(li);
    });
    ladderWrap.appendChild(ol);
    formEl.appendChild(ladderWrap);

    var stepField = (schema.fields || []).find(function (f) { return f.key === 'step'; });
    if (stepField) {
      var opts = (schema.hierarchy || []).map(function (s) {
        return { key: String(s.step), label: 'Nº ' + s.step + ': ' + s.description };
      });
      var fg = fieldGroup({
        number: 1, label: stepField.label, required: true, helper: 'Selecciona el paso que acabas de realizar.'
      }, makeSelect({ key: stepField.key }, responses.step, opts, function (v) {
        setResponse({ responses: responses }, stepField.key, v);
        onUserInput(formEl);
      }));
      fg.classList.add('ge-step-card');
      formEl.appendChild(fg);
    }

    (schema.fields || []).filter(function (f) { return f.key !== 'step'; }).forEach(function (f) {
      var fg = fieldGroup({
        label: f.label,
        required: !!f.required,
        helper: f.placeholder || f.description,
      }, renderField(f, responses[f.key], function (v) {
        setResponse({ responses: responses }, f.key, v);
        onUserInput(formEl);
      }, { options: f.options }));
      fg.dataset.field = f.key;
      formEl.appendChild(fg);
    });

    if (schema.guidance) {
      formEl.appendChild(el('div', { className: 'ex-guidance', text: schema.guidance }));
    }
  }

  function renderByKind(formEl, schema, kind, responses) {
    if (!schema) {
      formEl.appendChild(el('div', { className: 'ex-error-banner', text: 'Schema no disponible para esta tarea.' }));
      return;
    }
    if (kind === 'thought_record') return renderThoughtRecord(formEl, schema, responses);
    if (kind === 'behavioral_activation') return renderBA(formEl, schema, responses);
    if (kind === 'graded_exposure') return renderGE(formEl, schema, responses);
    formEl.appendChild(el('div', { className: 'ex-error-banner', text: 'Tipo de ejercicio no soportado: ' + kind }));
  }

  function kindLabel(kind) {
    var m = {
      thought_record: 'Thought Record (Beck)',
      behavioral_activation: 'Activación Conductual',
      graded_exposure: 'Exposición Gradual',
    };
    return m[kind] || kind;
  }

  // ─── Autosave / Submit ──────────────────────────────────────────────
  // Whitelist canónica de kinds clínicos. Mantener sincronizada con
  // KINDS en utils/exerciseSchemas.js (server). El frontend no consulta
  // la BD: si la versión cliente diverge, mantenemos sólo los efectos UI
  // (no se cae; solo el badge kind label o render específico se pierden).
  var CLINICAL_KINDS = { thought_record: 1, behavioral_activation: 1, graded_exposure: 1 };

  function isClinicalKind(kind) {
    return Object.prototype.hasOwnProperty.call(CLINICAL_KINDS, kind);
  }

  function onUserInput(formEl) {
    var aid = formEl.dataset.aid;
    var st = sessionState[aid];
    if (!st) return;
    st.status = 'dirty';
    updateBadge(st);
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(function () { flushAutosave(st); }, AUTOSAVE_DEBOUNCE_MS);
  }

  var BADGE_LABEL = { clean: '✓ Guardado', dirty: '… Editando', saving: '⟳ Guardando…', error: '⚠ Error al guardar' };

  function updateBadge(st) {
    if (!st.badgeEl) return;
    st.badgeEl.className = 'autosave-badge autosave-' + st.status;
    st.badgeEl.textContent = BADGE_LABEL[st.status] || '';
  }

  function fetchHeaders(opts) {
    return {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (opts.authToken || '')
    };
  }

  // stripBanners: deduplica .ex-error-banner y .ex-field-error dentro del
  // form. Sin esto, dos submits consecutivos acumulan banners duplicados.
  function stripBanners(formEl) {
    formEl.querySelectorAll('.ex-error-banner').forEach(function (e) { e.remove(); });
    formEl.querySelectorAll('.ex-field-error').forEach(function (e) { e.remove(); });
  }

  // Concatena inFlight para deduplicar llamadas concurrentes. Sin guard,
  // dos timers que disparan flushAutosave casi-simultáneamente pueden
  // emitir dos POST /sessions/start, mintando dos sessions. La segunda
  // queda orfana y la primera puede invalidarse.
  async function flushAutosave(st) {
    st.timer = null;
    if (st.inFlight) return st.inFlight;
    var run = (async function () {
      st.status = 'saving';
      updateBadge(st);
      try {
        if (!st.sid) {
          var startRes = await fetch(st.opts.apiBase + '/patients/' + st.opts.patientId + '/sessions/start', {
            method: 'POST',
            headers: fetchHeaders(st.opts),
            body: JSON.stringify({ assignment_id: st.aid }),
          });
          var startData = await startRes.json();
          if (!startRes.ok || !startData.success) {
            st.status = 'error';
            updateBadge(st);
            return;
          }
          st.sid = startData.session_id;
        }
        var putRes = await fetch(st.opts.apiBase + '/patients/' + st.opts.patientId + '/sessions/' + st.sid, {
          method: 'PUT',
          headers: fetchHeaders(st.opts),
          body: JSON.stringify({ responses: st.responses }),
        });
        if (!putRes.ok) {
          st.status = 'error';
          updateBadge(st);
          return;
        }
        st.status = 'clean';
        updateBadge(st);
        if (typeof st.opts.onSaved === 'function') st.opts.onSaved(st);
      } catch (e) {
        st.status = 'error';
        updateBadge(st);
      }
    })();
    st.inFlight = run.finally(function () { st.inFlight = null; });
    return st.inFlight;
  }

  async function submitSession(formEl) {
    var aid = formEl.dataset.aid;
    var st = sessionState[aid];
    if (!st) return;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    if (st.inFlight) await st.inFlight; else await flushAutosave(st);
    try {
      if (!st.sid) {
        var startRes = await fetch(st.opts.apiBase + '/patients/' + st.opts.patientId + '/sessions/start', {
          method: 'POST',
          headers: fetchHeaders(st.opts),
          body: JSON.stringify({ assignment_id: aid }),
        });
        var startData = await startRes.json();
        if (!startRes.ok || !startData.success) {
          stripBanners(formEl);
          var banner1 = el('div', { className: 'ex-error-banner', text: 'No se pudo iniciar la sesión: ' + (startData.error || 'error') });
          formEl.insertBefore(banner1, formEl.firstChild);
          return;
        }
        st.sid = startData.session_id;
      }
      var r = await fetch(st.opts.apiBase + '/patients/' + st.opts.patientId + '/sessions/' + st.sid + '/complete', {
        method: 'POST',
        headers: fetchHeaders(st.opts),
        body: JSON.stringify({}),
      });
      var data = await r.json();
      if (!r.ok || !data.success) {
        stripBanners(formEl);
        if (r.status === 422 && Array.isArray(data.errors)) {
          data.errors.forEach(function (err) {
            var fieldEl = formEl.querySelector('[data-field="' + err.field_key + '"]');
            var msg = err.message || ('Falta o inválido: ' + err.path);
            if (fieldEl) fieldEl.appendChild(el('div', { className: 'ex-field-error', text: msg }));
            else formEl.appendChild(el('div', { className: 'ex-error-banner', text: err.path + ': ' + msg }));
          });
        } else {
          var banner = el('div', { className: 'ex-error-banner', text: data.error || ('Error ' + r.status) });
          formEl.insertBefore(banner, formEl.firstChild);
        }
        return;
      }
      if (typeof st.opts.onCompleted === 'function') st.opts.onCompleted(st, data);
    } catch (e) {
      stripBanners(formEl);
      formEl.insertBefore(el('div', { className: 'ex-error-banner', text: 'Error de red al finalizar' }), formEl.firstChild);
    }
  }

  // ─── Public API: mountInteractiveCard ───────────────────────────────
  ns.mountInteractiveCard = function (parent, assignment, latestSession, opts) {
    parent.innerHTML = '';
    opts = opts || {};

    var card = el('div', { className: 'task-item exercise-card' });

    var header = el('div', { className: 'exercise-card-header' });
    header.appendChild(el('div', { className: 'task-title', text: assignment.title || 'Ejercicio clínico' }));
    if (assignment.instructions) {
      header.appendChild(el('div', { className: 'task-instructions', text: assignment.instructions }));
    }
    var meta = el('div', { className: 'exercise-card-meta' });
    meta.appendChild(el('span', { className: 'exercise-kind-badge', text: kindLabel(assignment.exercise_kind) }));
    if (assignment.due_date) {
      meta.appendChild(el('span', { className: 'due-label', text: 'Vence: ' + new Date(assignment.due_date).toLocaleDateString('es-ES') }));
    }
    header.appendChild(meta);
    card.appendChild(header);

    var form = el('div', { className: 'exercise-card-body' });
    form.dataset.aid = assignment.id;
    card.appendChild(form);

    var footer = el('div', { className: 'exercise-card-footer' });
    var badge = el('div', { className: 'autosave-badge autosave-clean', text: '' });
    footer.appendChild(badge);
    var submitBtn = el('button', { type: 'button', className: 'btn btn-p ex-submit', text: '✓ Finalizar ejercicio' });
    submitBtn.addEventListener('click', function () { submitSession(form); });
    footer.appendChild(submitBtn);
    card.appendChild(footer);

    parent.appendChild(card);

    var schema = assignment.exercise_schema || null;
    var initial = latestSession && latestSession.responses ? latestSession.responses : {};
    var responses = {};
    if (initial && typeof initial === 'object') {
      Object.keys(initial).forEach(function (k) {
        var v = initial[k];
        if (v && typeof v === 'object') responses[k] = JSON.parse(JSON.stringify(v));
        else if (v != null && v !== '') responses[k] = v;
      });
    }
    renderByKind(form, schema, assignment.exercise_kind, responses);

    var st = sessionState[assignment.id] = {
      aid: assignment.id,
      sid: latestSession && latestSession.id || null,
      kind: assignment.exercise_kind,
      schema: schema,
      responses: responses,
      status: 'clean',
      timer: null,
      mountEl: card,
      badgeEl: badge,
      opts: opts,
    };
    updateBadge(st);
    return st;
  };

  // ─── Public API: renderReadOnly (terapeuta) ─────────────────────────
  ns.renderReadOnly = function (parent, schema, responses) {
    parent.innerHTML = '';
    if (!schema || !Array.isArray(schema.fields)) {
      parent.textContent = 'Sin esquema disponible.';
      return;
    }
    var titles = {
      thought_record: 'Thought Record (Beck) — respuestas',
      behavioral_activation: 'Activación Conductual — respuestas',
      graded_exposure: 'Exposición Gradual — respuestas',
    };
    parent.appendChild(el('div', { className: 'exercise-panel-title', text: titles[schema.kind || ''] || 'Respuestas' }));

    schema.fields.forEach(function (f, idx) {
      var val = responses ? responses[f.key] : undefined;
      var block = el('div', { className: 'exercise-panel-row' });
      block.appendChild(el('div', { className: 'exercise-panel-label', text: (idx + 1) + '. ' + f.label }));
      block.appendChild(readOnlyValue(val, f, schema));
      parent.appendChild(block);
    });
    if (schema.guidance) parent.appendChild(el('div', { className: 'ex-guidance', text: schema.guidance }));
  };

  function readOnlyValue(val, field, schema) {
    if (!isMeaningful(val)) {
      return el('div', { className: 'exercise-panel-empty', text: '— sin respuesta —' });
    }
    if (field.type === 'text' || field.type === 'textarea') {
      return el('div', { className: 'exercise-panel-text', text: String(val) });
    }
    if (field.type === 'number' || field.type === 'scale') {
      var suffix = field.max != null ? ' / ' + field.max : '';
      return el('div', { className: 'exercise-panel-text', text: String(val) + suffix });
    }
    if (field.type === 'date') {
      return el('div', { className: 'exercise-panel-text', text: new Date(val).toLocaleDateString('es-ES') });
    }
    if (field.type === 'boolean') {
      return el('div', { className: 'exercise-panel-text', text: val ? '✓ Sí' : '— No' });
    }
    if (field.type === 'select') {
      var label = String(val);
      var opts = field.options || [];
      var found = opts.find(function (o) { return (typeof o === 'string' ? o : o.key) === val; });
      if (found) label = typeof found === 'string' ? found : found.label;
      return el('div', { className: 'exercise-panel-text', text: label });
    }
    if (field.type === 'multi_select') {
      var opts2 = field.source === 'catalog' ? (schema.distortion_catalog || []) : (field.options || []);
      var list = el('div', { className: 'exercise-panel-chips' });
      (val || []).forEach(function (v) {
        var label = String(v);
        var found = opts2.find(function (o) { return (typeof o === 'string' ? o : o.key) === v; });
        if (found) label = typeof found === 'string' ? found : found.label;
        list.appendChild(el('span', { className: 'distortion-chip active static', text: label }));
      });
      return list;
    }
    if (field.type === 'repeater') {
      var list2 = el('div', { className: 'exercise-panel-repeater' });
      (val || []).forEach(function (item, i) {
        var itemEl = el('div', { className: 'emotion-row static' });
        (field.fields || []).forEach(function (sf) {
          var cell = el('div', { className: 'emotion-row-cell static' });
          cell.appendChild(el('div', { className: 'emotion-row-cell-label', text: sf.label || sf.key }));
          var cv = item[sf.key];
          if (cv == null || cv === '') cv = '—';
          else if (typeof cv === 'number' && sf.max != null) cv = cv + ' / ' + sf.max;
          cell.appendChild(el('div', { className: 'emotion-row-cell-value', text: String(cv) }));
          itemEl.appendChild(cell);
        });
        list2.appendChild(itemEl);
      });
      return list2;
    }
    return el('div', { className: 'exercise-panel-text', text: JSON.stringify(val) });
  }

  ns.submitSession = function (aid) {
    var st = sessionState[aid];
    if (!st || !st.mountEl) return;
    var formEl = st.mountEl.querySelector('.exercise-card-body');
    if (formEl) submitSession(formEl);
  };

  ns.getStatus = function (aid) {
    var st = sessionState[aid];
    return st ? st.status : null;
  };

  // Whitelist pública para que paciente/terapeuta distingan "clinical kind"
  // sin caer en la heurística `!== 'classic'` (que enmascara filas con kind
  // null si migration 007 fallara o si una BD antigua no tuviera el campo).
  ns.isClinicalKind = isClinicalKind;
})();
