-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 007 — Embedded Clinical Exercises (Biblioteca interactiva)
-- ═══════════════════════════════════════════════════════════════════════════
-- Por que existe:
--   La biblioteca actual (task_templates / assignments) almacena solo
--   `title` + `instructions` como texto plano. El paciente solo recibe
--   "Haz esto" → "Marcar completada". No hay forma estructurada de
--   capturar qué pensó, qué emoción sintió, qué aprendió. El terapeuta
--   recibe un booleano. Esto es incompatible con TCC/CBT clínica real.
--
-- Qué añade esta migration:
--   1. exercise_kind		TEXT en task_templates + assignments
--                            con default 'classic' (= comportamiento actual)
--   2. exercise_schema	JSONB en task_templates + assignments (snapshot
--                            copiado al assignment al crearlo para que el
--                            schema quede congelado para el paciente).
--   3. CHECK constraints	validan que exercise_kind ∈ 4 valores.
--   4. exercise_sessions	tabla nueva con respuestas del paciente en JSONB
--                            + encrypted_blob para campos sensibles
--                            (pensamientos automáticos, reflexiones).
--   5. Seeds clínicos		6 plantillas del sistema con JSONB validable
--                            y schema_version:1 (1 TR + 2 BA + 3 GE).
--
-- Backwards compatibility:
--   - Default exercise_kind='classic' → cero impacto en asignaciones
--     existentes ni en el frontend actual.
--   - El endpoint GET /task-templates ya existente sigue devolviendo
--     los mismos campos; exercise_kind y exercise_schema son nuevos
--     y quedan disponibles para la UI que vendra en iteracion 2.
--   - El runner de migraciones registra `007_embedded_exercises.sql`
--     en `_migrations`, asi que NO se vuelve a aplicar en arranque.
--
-- Referencias clínicas:
--   - Beck, A.T. (1979). Cognitive Therapy of Depression.
--   - Burns, D.D. (1980). Feeling Good (12 distorsiones canonicas).
--   - Lewinsohn, P.M. (1976). Activity schedules in depression.
--   - Jacobson, N.S. (1996). Behavioral Activation Treatment.
--   - Marks, I.M. (1978). Behavioral Treatments of Phobic Disorders.
--   - McNally, R.J. (2007). Mechanisms of exposure therapy.

-- 1) Columnas exercise_kind + exercise_schema + CHECK constraints
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE task_templates
  ADD COLUMN IF NOT EXISTS exercise_kind  TEXT NOT NULL DEFAULT 'classic',
  ADD COLUMN IF NOT EXISTS exercise_schema JSONB;

-- Deduplicamos la logica: si la columna ya existia con NOT NULL DEFAULT
-- 'classic' (deploys parciales), el ALTER IF NOT EXISTS no hace nada. En
-- cambio el CHECK sí lo aplicamos si no existe (ver mas abajo con query).

ALTER TABLE task_templates
  ADD CONSTRAINT chk_task_templates_kind
  CHECK (exercise_kind IN ('classic','thought_record','behavioral_activation','graded_exposure'));

ALTER TABLE assignments
  ADD COLUMN IF NOT EXISTS exercise_kind   TEXT NOT NULL DEFAULT 'classic',
  ADD COLUMN IF NOT EXISTS exercise_schema JSONB;

ALTER TABLE assignments
  ADD CONSTRAINT chk_assignments_kind
  CHECK (exercise_kind IN ('classic','thought_record','behavioral_activation','graded_exposure'));

-- Indice sobre exercise_kind acelera filtros de la biblioteca por tipo
-- (p.ej. cuando el terapeuta pida solo Thought Records para un paciente
-- con sesgo cognitivo fuerte). No es del-runner inicial pero bajamos
-- el costo del primer GET /task-templates?kind=thought_record.
CREATE INDEX IF NOT EXISTS idx_task_templates_kind
  ON task_templates(exercise_kind)
  WHERE exercise_kind <> 'classic';

CREATE INDEX IF NOT EXISTS idx_assignments_kind
  ON assignments(exercise_kind)
  WHERE exercise_kind <> 'classic';


-- 2) Tabla exercise_sessions
-- ═══════════════════════════════════════════════════════════════════════════
-- Diseño:
--   - responses JSONB: campos NO sensibles del ejercicio, en plano, para
--     permitir queries SQL agregadas (ej: "distorsiones mas frecuentes
--     en los TR del Paciente X esta semana").
--   - encrypted_blob TEXT: concatenacion de campos sensibles encriptados
--     con AES-256-GCM (utils/encryption.js). Los pensamientos automaticos
--     y reflexiones libres son PHI (Protected Health Information) y
--     NO deben quedar en plano dentro del JSONB.
--   - assignment_id y patient_id FK con ON DELETE CASCADE: si el
--     terapeuta o sistema elimina una asignacion, su sesion de ejercicio
--     se va con ella.
--   - is_complete BOOLEAN: el front-end usa este flag para mostrar el
--     estado del ejercicio sin leer la tabla assignments (mas barato
--     cuando el terapeuta abre el modal).
--   - No UNIQUE(assignment_id): el paciente podria tener multiples
--     sesiones para una misma asignacion (ej: cancelo a media, retoma
--     otro dia). El front-end tomara la ultima por updated_at.

CREATE TABLE IF NOT EXISTS exercise_sessions (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  assignment_id   UUID        NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  patient_id      UUID        NOT NULL REFERENCES patients(id)    ON DELETE CASCADE,
  exercise_kind   TEXT        NOT NULL,
  responses       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  encrypted_blob  TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  is_complete     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_exercise_session_kind
    CHECK (exercise_kind IN ('classic','thought_record','behavioral_activation','graded_exposure'))
);

-- Indice principal: terapeuta ve "ultima sesion por paciente" en el modal
-- sin tener que recorrer todas. Partial index sobre unfinished nos da la
-- lista "en curso" del paciente en su dashboard en una sola query.
CREATE INDEX IF NOT EXISTS idx_exercise_sessions_assignment
  ON exercise_sessions(assignment_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_exercise_sessions_patient_unfinished
  ON exercise_sessions(patient_id, updated_at DESC)
  WHERE NOT is_complete;

-- Trigger simple para mantener updated_at coherente con la convencion
-- del resto del schema (CHECK_INS no lo tiene pero assignments/goals sí:
-- ver utils/notifications.js y la `updated_at` que se setea en los PUT).
-- Aqui lo creamos aunque solo hay used PUTs por la implementacion
-- (iteracion 2), pero queremos el contrato en BD para que luego no se
-- olvide.
CREATE OR REPLACE FUNCTION trg_exercise_sessions_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS exercise_sessions_touch_updated_at ON exercise_sessions;
CREATE TRIGGER exercise_sessions_touch_updated_at
  BEFORE UPDATE ON exercise_sessions
  FOR EACH ROW EXECUTE FUNCTION trg_exercise_sessions_touch_updated_at();


-- 3) Seeds clínicos: 6 plantillas del sistema (therapist_id IS NULL)
-- ═══════════════════════════════════════════════════════════════════════════
-- UUIDs deterministas por legibilidad en logs/tests. therapist_id = NULL
-- las marca como plantillas del sistema (no se muestran en el "Tuyas"
-- del terapeuta, sí aparecen en la biblioteca global).
--
-- Cada exercise_schema integra:
--   - schema_version: 1            → permite versioning explícito
--   - fields: [ {key, label, type, required, sensitive, ...}, ... ]
--   - (kind-specifico) catalog, suggested_activities, hierarchy, etc.
--   - guidance: texto clínico corto al pie para el terapeuta que la use
--
-- Types disponibles (versión 1 del schema declarativo):
--   text      → <input type=text>
--   textarea  → <textarea>
--   number    → <input type=number min=.. max=..>
--   scale     → <input range> + label  (min..max va por config)
--   select    → <select> con options[]
--   multi_select → checkboxes con options[]
--   boolean   → toggle
--   date      → <input type=date>
--   repeater  → lista dinamica de sub-fields[]
--
-- `sensitive: true` marca campos que se encriptan en encrypted_blob
-- en lugar de quedar en el JSONB plano.


-- ─── 1) THOUGHT RECORD (Beck, 1979 + Burns, 1980 — 12 distorsiones) ───
INSERT INTO task_templates (
  id, therapist_id, category, title, instructions,
  difficulty, duration_min, exercise_kind, exercise_schema
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  NULL,
  '🧠 Reestructuración cognitiva',
  'Registro de pensamiento automático (Beck)',
  $$Beck (1979). Ante una emoción intensa, identifica el pensamiento automático que la disparó, ponle nombre con una distorsión cognitiva y constrúyele un reencuadre más fiel a la evidencia.

Pasos (5-8 min cada uno):
1. Anota la situación y el pensamiento literal.
2. Nombra la emoción y su intensidad 0-100.
3. Identifica qué distorsión estás usando.
4. Busca evidencia a favor Y en contra con honestidad.
5. Escribe un pensamiento alternativo equilibrado.
6. Reevalúa la emoción.

Un registro al día durante 7 días para empezar a notar tu patrón personal.$$,
  'media',
  20,
  'thought_record',
  $${
    "schema_version": 1,
    "distortion_catalog": [
      {"key":"all_or_nothing",       "label":"Pensamiento todo-o-nada",     "description":"Ves todo en blanco o negro. Si no es perfecto, es un fracaso total."},
      {"key":"overgeneralization",   "label":"Sobregeneralización",        "description":"De un incidente negativo concluyes 'siempre me pasa esto'."},
      {"key":"mental_filter",        "label":"Filtro mental",               "description":"Solo registras el detalle negativo; lo neutral y positivo queda fuera."},
      {"key":"disqualifying_positive","label":"Invalidar lo positivo",      "description":"Descartas logros o cumplidos insistiendo en que 'no cuentan'."},
      {"key":"mind_reading",         "label":"Lectura de mente",            "description":"Asumes que los demás piensan mal de ti sin evidencia suficiente."},
      {"key":"fortune_telling",      "label":"Predicción del futuro",       "description":"Anticipas que irá mal y actúas como si tu predicción fuese hecho."},
      {"key":"catastrophizing",      "label":"Catastrofismo",               "description":"Exageras la importancia: 'será terrible, no aguantaré'."},
      {"key":"minimization",         "label":"Minimización",                "description":"Quitas valor a tus logros o capacidades positivas sin justificación."},
      {"key":"emotional_reasoning",  "label":"Razonamiento emocional",      "description":"Concluyes que algo es verdad porque 'me siento mal con ello'."},
      {"key":"should_statements",    "label":"Declaraciones 'debería'",     "description":"Te exiges con 'debería' o 'no debería', generando culpa constante."},
      {"key":"labeling",             "label":"Etiquetado",                  "description":"En lugar de 'cometí un error', te etiquetas como 'soy un fracasado'."},
      {"key":"personalization",      "label":"Personalización",             "description":"Te culpas por eventos que no controlas o asumes responsabilidad excesiva."},
      {"key":"blame",                "label":"Culpabilización",             "description":"Atribuyes toda la responsabilidad a otros sin matiz realista."}
    ],
    "fields": [
      {"key":"situation",          "label":"1. Situación (hechos)",                  "type":"textarea","required":true, "sensitive":true,  "placeholder":"Dónde, cuándo, con quién. Sólo hechos, sin interpretación."},
      {"key":"automatic_thought",  "label":"2. Pensamiento automático",              "type":"textarea","required":true, "sensitive":true,  "placeholder":"Lo más literal posible. Una frase, lo que pasó por tu mente."},
      {"key":"emotions",           "label":"3. Emociones sentidas",                  "type":"repeater", "required":true, "sensitive":false, "item_sensitive":false, "fields":[
        {"key":"name",            "type":"text",  "placeholder":"ansiedad, tristeza, ira…", "sensitive":false},
        {"key":"intensity",       "type":"scale", "min":0, "max":100, "label":"Intensidad (0–100)", "sensitive":false},
        {"key":"body_location",   "type":"text",  "placeholder":"pecho, estómago…", "required":false, "sensitive":false}
      ]},
      {"key":"distortions",        "label":"4. Distorsión(es) detectada(s)",         "type":"multi_select","required":true, "sensitive":false, "source":"catalog"},
      {"key":"evidence_for",       "label":"5. Evidencia a favor del pensamiento",   "type":"textarea","required":false,"sensitive":true,  "placeholder":"Hechos que respaldan lo que pensaste. Sé honesto(a)."},
      {"key":"evidence_against",  "label":"6. Evidencia en contra",                 "type":"textarea","required":false,"sensitive":true,  "placeholder":"Hechos que no encajan con tu pensamiento. Otras perspectivas."},
      {"key":"alternative_thought","label":"7. Pensamiento alternativo equilibrado", "type":"textarea","required":true, "sensitive":true,  "placeholder":"Una versión más fiel a la evidencia completa, sin absolutos."},
      {"key":"emotions_after",     "label":"8. Emociones tras la resignificación",  "type":"repeater","required":false,"sensitive":false,"item_sensitive":false, "fields":[
        {"key":"name",          "type":"text",  "placeholder":"la misma emoción u otra", "sensitive":false},
        {"key":"intensity",     "type":"scale","min":0,"max":100,"label":"Intensidad (0–100)", "sensitive":false}
      ]}
    ],
    "guidance":"Beck (1979) demostró que cuestionando estos pensamientos desciende la intensidad emocional.Las preguntas 5 y 6 son el corazón del ejercicio: evita respuestas como 'no hay evidencia a favor' — busca al menos una para después equilibrarla."
  }$$::jsonb
)
ON CONFLICT (id) DO NOTHING;


-- ─── 2) BEHAVIORAL ACTIVATION — Diario (Lewinsohn, 1976) ───
INSERT INTO task_templates (
  id, therapist_id, category, title, instructions,
  difficulty, duration_min, exercise_kind, exercise_schema
) VALUES (
  '22222222-2222-2222-2222-222222222222',
  NULL,
  '🎯 Activación conductual',
  'Registro diario de actividades placenteras (Lewinsohn)',
  $$Anota cada actividad entre check-ins (3-5 por día). Califica placer (P) y logro (L) en escala 0–10.

Lewinsohn (1976) demostró que en estados depresivos, la caída de ambas dimensiones — placer y logro — perpetúa el ciclo. Monitorizarlas hace visibles los patrones y permite ajustar la semana siguiente.

Placer = cuánto disfrutaste.
Logro = qué sensación de capacidad / propósito te dio.

Revisión semanal sugerida: identifica 2 patrones (qué actividades bajan de placer con repetición, cuáles escalan logro).$$,
  'baja',
  15,
  'behavioral_activation',
  $${
    "schema_version": 1,
    "mode": "diary",
    "fields": [
      {"key":"activity",        "label":"Actividad",          "type":"text",     "required":true,  "sensitive":false, "placeholder":"¿Qué hiciste exactamente?"},
      {"key":"time_slot",       "label":"Momento del día",    "type":"select",   "required":true,  "sensitive":false, "options":["Mañana", "Tarde", "Noche"]},
      {"key":"duration_min",    "label":"Duración (min)",     "type":"number",   "required":false, "sensitive":false, "min":1, "max":480},
      {"key":"pleasure",        "label":"Placer (0–10)",      "type":"scale",    "required":true,  "sensitive":false, "min":0, "max":10, "description":"Cuánto placer/diversión te dio"},
      {"key":"achievement",     "label":"Logro (0–10)",       "type":"scale",    "required":true,  "sensitive":false, "min":0, "max":10, "description":"Sensación de capacidad o propósito"},
      {"key":"accompanying",    "label":"Con quién",          "type":"text",     "required":false, "sensitive":false, "placeholder":"solo/a, con… "},
      {"key":"notes",           "label":"Notas / reflexión",  "type":"textarea", "required":false, "sensitive":true,  "placeholder":"¿Qué sentiste? ¿La repetirías? ¿Qué ajustarías?"}
    ],
    "suggested_activities": [
      {"label":"Pasear 20 min por un parque",                       "category":"suave","difficulty":"baja"},
      {"label":"Llamar o videollamar a alguien que aprecies",         "category":"social","difficulty":"baja"},
      {"label":"Tomar un café o té sin prisa",                        "category":"suave","difficulty":"baja"},
      {"label":"Leer un libro o artículo que te interese",            "category":"suave","difficulty":"baja"},
      {"label":"Pasear a tu perro / cuidar una mascota",              "category":"suave","difficulty":"baja"},
      {"label":"Cocinar una receta nueva",                            "category":"media","difficulty":"media"},
      {"label":"Escuchar tu música o podcast favorito",              "category":"suave","difficulty":"baja"},
      {"label":"Mirar el atardecer o las nubes con calma",           "category":"suave","difficulty":"baja"},
      {"label":"Hacer ejercicio suave (yoga, estiramientos)",        "category":"suave","difficulty":"baja"},
      {"label":"Resolver un puzzle, sudoku o juego de mesa",          "category":"suave","difficulty":"baja"},
      {"label":"Escribir en un diario o dibujar",                     "category":"suave","difficulty":"baja"},
      {"label":"Visitar a un familiar sin agenda concreta",           "category":"social","difficulty":"baja"},
      {"label":"Cuidar plantas (regar, podar, trasplantar)",          "category":"suave","difficulty":"baja"},
      {"label":"Tomar una foto que te guste y guardarla",             "category":"suave","difficulty":"baja"},
      {"label":"Hacer una llamada pendiente esta semana",             "category":"social","difficulty":"media"},
      {"label":"Ordenar un cajón o estante pequeño",                  "category":"logro","difficulty":"baja"},
      {"label":"Completar un trámite administrativo que arrastras",  "category":"logro","difficulty":"media"},
      {"label":"Aprender algo nuevo (video de 15 min, curso corto)",  "category":"logro","difficulty":"media"},
      {"label":"Voluntariado puntual o ayudar a un conocido",          "category":"social","difficulty":"media"},
      {"label":"Asistir a un evento local (mercado, concierto, biblioteca)", "category":"social","difficulty":"media"}
    ],
    "guidance":"Lewinsohn (1976). En estados depresivos la inactividad reduce placer y logro.una actividad diaria con P≥5 es suficiente para empezar a romper el ciclo. Si P y L son ambos 0-2 tres días seguidos, replantear junto a tu terapeuta."
  }$$::jsonb
)
ON CONFLICT (id) DO NOTHING;


-- ─── 3) BEHAVIORAL ACTIVATION — Plan semanal (Jacobson, 1996) ───
INSERT INTO task_templates (
  id, therapist_id, category, title, instructions,
  difficulty, duration_min, exercise_kind, exercise_schema
) VALUES (
  '33333333-3333-3333-3333-333333333333',
  NULL,
  '🎯 Activación conductual',
  'Plan semanal estructurado de actividades (Jacobson)',
  $$Programa la semana completa el domingo por la noche. Por cada bloque registra actividad, obstáculos previstos y un plan B.

Jacobson (1996) demostró que la programación estructurada + sistema de obstáculos/plan B es más sostenida que improvisar según el estado de ánimo del momento.

Clave: una actividad GASTRADA con plan B es terapéutica; una actividad IMPROVISADA con cumplimiento del 30% genera culpa y refuerza la evitación.$$,
  'baja',
  30,
  'behavioral_activation',
  $${
    "schema_version": 1,
    "mode": "schedule",
    "fields": [
      {"key":"day",             "label":"Día",                       "type":"select",  "required":true, "sensitive":false, "options":["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado","Domingo"]},
      {"key":"time_slot",       "label":"Franja",                    "type":"select",  "required":true, "sensitive":false, "options":["Mañana (8–12)","Tarde (12–18)","Noche (18–22)"]},
      {"key":"activity",        "label":"Actividad planificada",     "type":"text",    "required":true, "sensitive":false, "placeholder":"Concreta y medible (ej: 'pasear 30 min')"},
      {"key":"category",        "label":"Tipo",                      "type":"select",  "required":true, "sensitive":false, "options":["Placer","Logro","Social","Auto-cuidado","Productivo","Descanso"]},
      {"key":"obstacles",       "label":"Posibles obstáculos",       "type":"textarea","required":false,"sensitive":false, "placeholder":"¿Qué podría impedirlo? ¿Cómo lo solventarías?"},
      {"key":"alternative",     "label":"Plan B (alternativa)",      "type":"text",    "required":false,"sensitive":false, "placeholder":"Si surge imprevisto, ¿qué harás en su lugar?"},
      {"key":"completed",       "label":"¿Lo hiciste?",              "type":"select",  "required":true, "sensitive":false, "options":["Sí, completo","Parcialmente","No","Lo reprogramé"]},
      {"key":"reflection",      "label":"Reflexión",                 "type":"textarea","required":false,"sensitive":true,  "placeholder":"¿Qué funcionó? ¿Qué ajustarías la próxima semana?"}
    ],
    "guidance":"Jacobson (1996). programa el domingo por la noche de la semana siguiente.Si tienes una agenda muy ocupada, prioriza al menos 1 actividad con P y 1 con L por día. La constancia pesa más que la intensidad."
  }$$::jsonb
)
ON CONFLICT (id) DO NOTHING;


-- ─── 4) GRADED EXPOSURE — Agorafobia (Marks, 1978) ───
INSERT INTO task_templates (
  id, therapist_id, category, title, instructions,
  difficulty, duration_min, exercise_kind, exercise_schema
) VALUES (
  '44444444-4444-4444-4444-444444444444',
  NULL,
  '🚶 Exposición gradual',
  'Jerarquía de exposición — Agorafobia (Marks)',
  $$Sube por la jerarquía de 8 pasos usando el SUDS (0–100) para cuantificar ansiedad.

Marks (1978) demostró que la exposición gradual + prevención de respuesta es la intervención de primera línea para agorafobia.

Reglas:
- Avanza solo cuando el paso anterior baje al menos al 50%.
- Repite cada paso 2-3 veces antes de subir.
- No huyas en el pico de ansiedad: la habituación requiere sostener.$$,
  'alta',
  45,
  'graded_exposure',
  $${
    "schema_version": 1,
    "phobia": "agoraphobia",
    "hierarchy": [
      {"step":1,"description":"Imaginarme entrando solo(a) a una tienda conocida","expected_suds":30,"estimated_duration_min":5},
      {"step":2,"description":"Entrar solo(a) a una tienda grande conocida y comprar algo","expected_suds":40,"estimated_duration_min":10},
      {"step":3,"description":"Quedarme 15 min en un centro comercial pequeño en horas valle","expected_suds":50,"estimated_duration_min":15},
      {"step":4,"description":"Ir solo(a) al supermercado pequeño en hora moderada","expected_suds":55,"estimated_duration_min":20},
      {"step":5,"description":"Visitar un centro comercial amplio y concurrido en hora punta","expected_suds":65,"estimated_duration_min":25},
      {"step":6,"description":"Usar transporte público solo(a) en un trayecto corto","expected_suds":70,"estimated_duration_min":30},
      {"step":7,"description":"Pasar 1 hora solo(a) en una plaza muy concurrida","expected_suds":75,"estimated_duration_min":60},
      {"step":8,"description":"Viajar solo(a) a otra ciudad y comer en un restaurante desconocido","expected_suds":80,"estimated_duration_min":180}
    ],
    "fields": [
      {"key":"step",                "label":"Nº de paso",               "type":"select",   "required":true, "sensitive":false, "source":"hierarchy"},
      {"key":"date",                "label":"Fecha realizada",          "type":"date",     "required":true, "sensitive":false},
      {"key":"suds_pre",            "label":"SUDS antes (0–100)",       "type":"scale",    "required":true, "sensitive":false, "min":0, "max":100},
      {"key":"suds_peak",           "label":"SUDS pico (0–100)",        "type":"scale",    "required":false,"sensitive":false, "min":0, "max":100},
      {"key":"suds_post",           "label":"SUDS al terminar (0–100)", "type":"scale",    "required":true, "sensitive":false, "min":0, "max":100},
      {"key":"duration_actual_min", "label":"Duración real (min)",     "type":"number",   "required":false,"sensitive":false, "min":1, "max":300},
      {"key":"completed",           "label":"Lo completé sin huir",     "type":"boolean",  "required":true, "sensitive":false},
      {"key":"coping",              "label":"Estrategias usadas",      "type":"multi_select","required":false,"sensitive":false, "options":[
        {"key":"breath",      "label":"Respiración diafragmática"},
        {"key":"grounding",   "label":"Grounding 5-4-3-2-1"},
        {"key":"self_talk",   "label":"Diálogo interno estructurado"},
        {"key":"safety_item", "label":"Recurso de seguridad (llamar a alguien)"},
        {"key":"other",       "label":"Otra"}
      ]},
      {"key":"notes",               "label":"Notas / aprendizajes",     "type":"textarea", "required":false,"sensitive":true,  "placeholder":"¿Qué descubriste? ¿Qué ajustarías la próxima exposición?"}
    ],
    "guidance":"Marks (1978). Avanza solo cuando el paso anterior baje al menos al 50%.Practica cada paso 2-3 veces antes de avanzar — la consolidación es clave.Para registrar correctamente el SUDS: 'pre' es antes de empezar; 'pico' es el momento más difícil; 'post' es al cierre."
  }$$::jsonb
)
ON CONFLICT (id) DO NOTHING;


-- ─── 5) GRADED EXPOSURE — Ansiedad social (McNally, 2007) ───
INSERT INTO task_templates (
  id, therapist_id, category, title, instructions,
  difficulty, duration_min, exercise_kind, exercise_schema
) VALUES (
  '55555555-5555-5555-5555-555555555555',
  NULL,
  '🚶 Exposición gradual',
  'Jerarquía de exposición — Ansiedad social',
  $$Sube por la jerarquía de 7 pasos centrada en interacciones sociales evaluativas. CUantifica ansiedad con SUDS.

McNally (2007) enfatiza que la mejoría requiere eliminar los 'comportamientos de seguridad' (mirar el móvil para escapar, evitar contacto visual, ensayar frases). Sin ese paso, la exposición consolida la evitación con apariencia de valentía.$$,
  'alta',
  40,
  'graded_exposure',
  $${
    "schema_version": 1,
    "phobia": "social_anxiety",
    "hierarchy": [
      {"step":1,"description":"Imaginarme en una reunión social donde no conozco a nadie","expected_suds":30,"estimated_duration_min":5},
      {"step":2,"description":"Hablar 5 min con un dependiente en una tienda","expected_suds":40,"estimated_duration_min":5},
      {"step":3,"description":"Pedir la cuenta y hacer una pregunta al camarero en un restaurante lleno","expected_suds":50,"estimated_duration_min":10},
      {"step":4,"description":"Iniciar conversación con un desconocido en el gimnasio o en la calle","expected_suds":60,"estimated_duration_min":10},
      {"step":5,"description":"Llamar por teléfono y hacerme entender por una consulta","expected_suds":65,"estimated_duration_min":15},
      {"step":6,"description":"Dar mi opinión en voz alta en un grupo de 4-5 personas","expected_suds":75,"estimated_duration_min":10},
      {"step":7,"description":"Asistir solo(a) a una reunión social de 1 h con desconocidos","expected_suds":80,"estimated_duration_min":60}
    ],
    "fields": [
      {"key":"step",                "label":"Nº de paso",               "type":"select",   "required":true, "sensitive":false, "source":"hierarchy"},
      {"key":"date",                "label":"Fecha realizada",          "type":"date",     "required":true, "sensitive":false},
      {"key":"suds_pre",            "label":"SUDS antes (0–100)",       "type":"scale",    "required":true, "sensitive":false, "min":0, "max":100},
      {"key":"suds_peak",           "label":"SUDS pico (0–100)",        "type":"scale",    "required":false,"sensitive":false, "min":0, "max":100},
      {"key":"suds_post",           "label":"SUDS al terminar (0–100)", "type":"scale",    "required":true, "sensitive":false, "min":0, "max":100},
      {"key":"duration_actual_min", "label":"Duración real (min)",     "type":"number",   "required":false,"sensitive":false, "min":1, "max":180},
      {"key":"completed",           "label":"Lo completé sin comportamientos de seguridad", "type":"boolean", "required":true, "sensitive":false},
      {"key":"coping",              "label":"Estrategias usadas",      "type":"multi_select","required":false,"sensitive":false, "options":[
        {"key":"breath",        "label":"Respiración"},
        {"key":"grounding",     "label":"Grounding"},
        {"key":"focus_others",  "label":"Foco en los otros (no en mí)"},
        {"key":"self_talk",     "label":"Diálogo interno realista"},
        {"key":"other",         "label":"Otra"}
      ]},
      {"key":"notes",               "label":"Notas / aprendizajes",     "type":"textarea", "required":false,"sensitive":true,  "placeholder":"¿Qué descubriste? ¿Qué creencia cambió?"}
    ],
    "guidance":"McNally (2007). El avance requiere eliminar comportamientos de seguridad: NO estar mirando el móvil 'por si acaso', NO evitar contacto visual, NO ensayar frases en bucle.Si te descubres usándolos, repite el mismo paso antes de subir."
  }$$::jsonb
)
ON CONFLICT (id) DO NOTHING;


-- ─── 6) GRADED EXPOSURE — Claustrofobia (Marks, 1978) ───
INSERT INTO task_templates (
  id, therapist_id, category, title, instructions,
  difficulty, duration_min, exercise_kind, exercise_schema
) VALUES (
  '66666666-6666-6666-6666-666666666666',
  NULL,
  '🚶 Exposición gradual',
  'Jerarquía de exposición — Claustrofobia (Marks)',
  $$Sube por la jerarquía de 7 pasos usando SUDS (0–100). La claustración responde muy bien a exposición in vivo repetida.

Marks (1978). Si la exposición se vuelve intolerable, divide el paso en mitades más cortas y practica primero la mitad inferior hasta que el SUDS baje al 30%. Sube por fases.$$,
  'alta',
  40,
  'graded_exposure',
  $${
    "schema_version": 1,
    "phobia": "claustrophobia",
    "hierarchy": [
      {"step":1,"description":"Imaginarme en un cuarto cerrado pequeño","expected_suds":25,"estimated_duration_min":5},
      {"step":2,"description":"Entrar a un baño pequeño y cerrar la puerta 30 s","expected_suds":35,"estimated_duration_min":2},
      {"step":3,"description":"Sentarme en el centro del coche con todas las puertas cerradas 1 min","expected_suds":50,"estimated_duration_min":5},
      {"step":4,"description":"Estar en un armario o cuarto sin ventanas 3 min","expected_suds":60,"estimated_duration_min":5},
      {"step":5,"description":"Subir a un ascensor pequeño con 1 persona, 5 pisos","expected_suds":70,"estimated_duration_min":5},
      {"step":6,"description":"Subir a un ascensor lleno en hora punta, 10 pisos","expected_suds":80,"estimated_duration_min":5},
      {"step":7,"description":"Estar en un cuarto sin ventanas con 3+ personas 10 min","expected_suds":85,"estimated_duration_min":12}
    ],
    "fields": [
      {"key":"step",                "label":"Nº de paso",               "type":"select",   "required":true, "sensitive":false, "source":"hierarchy"},
      {"key":"date",                "label":"Fecha realizada",          "type":"date",     "required":true, "sensitive":false},
      {"key":"suds_pre",            "label":"SUDS antes (0–100)",       "type":"scale",    "required":true, "sensitive":false, "min":0, "max":100},
      {"key":"suds_peak",           "label":"SUDS pico (0–100)",        "type":"scale",    "required":false,"sensitive":false, "min":0, "max":100},
      {"key":"suds_post",           "label":"SUDS al terminar (0–100)", "type":"scale",    "required":true, "sensitive":false, "min":0, "max":100},
      {"key":"duration_actual_min", "label":"Duración real (min)",     "type":"number",   "required":false,"sensitive":false, "min":1, "max":60},
      {"key":"completed",           "label":"Lo completé sin huir",     "type":"boolean",  "required":true, "sensitive":false},
      {"key":"coping",              "label":"Estrategias usadas",      "type":"multi_select","required":false,"sensitive":false, "options":[
        {"key":"breath",      "label":"Respiración diafragmática"},
        {"key":"grounding",   "label":"Grounding 5-4-3-2-1"},
        {"key":"focus_exit",  "label":"Atención focalizada en la salida (¿segura?)"},
        {"key":"self_talk",   "label":"Diálogo interno realista"},
        {"key":"other",       "label":"Otra"}
      ]},
      {"key":"notes",               "label":"Notas / aprendizajes",     "type":"textarea", "required":false,"sensitive":true,  "placeholder":"¿Qué descubriste? ¿La creencia 'no podré respirar' cambió?"}
    ],
    "guidance":"Marks (1978). No huyas si el SUDS sube: la habituación requiere mantener la exposición hasta que baje.Si sientes pánico, enfócate en medir el SUDS en voz alta (contar del 0 al 100) — esto externaliza el control emocional."
  }$$::jsonb
)
ON CONFLICT (id) DO NOTHING;


-- 4) Logs de la migration aplicada
-- ═══════════════════════════════════════════════════════════════════════════
-- No usamos RAISE NOTICE porque el runner ya emite logger.info('Migracion aplicada:').
-- Dejamos un comentario explicito sobre cómo verificarlo manualmente:
--   SELECT exercise_kind, COUNT(*) FROM task_templates
--    WHERE therapist_id IS NULL GROUP BY exercise_kind;
--
-- Resultado esperado tras la primera aplicacion:
--   classic                  | 18
--   thought_record           | 1
--   behavioral_activation    | 2
--   graded_exposure          | 3
