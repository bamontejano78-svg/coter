-- Migración inicial: Crear todas las tablas de Coter Pro
-- Ejecutar: Esta migración se aplica automáticamente al iniciar la app

-- ─── EXTENSIONES ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── TERAPEUTAS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS therapists (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password      TEXT NOT NULL,
  specialty     TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PACIENTES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patients (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT,
  email         TEXT,
  phone         TEXT,
  birth_date    TEXT,
  notes         TEXT,
  status        TEXT DEFAULT 'active',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── VÍNCULO TERAPEUTA-PACIENTE ────────────────────────────────
CREATE TABLE IF NOT EXISTS therapist_patients (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  therapist_id    UUID NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  connection_code TEXT NOT NULL,
  status          TEXT DEFAULT 'active',
  connected_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(therapist_id, patient_id)
);

-- ─── CÓDIGOS DE CONEXIÓN ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS connection_codes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  therapist_id    UUID NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  code            TEXT UNIQUE NOT NULL,
  duration_hours  INTEGER DEFAULT 168,
  max_uses        INTEGER DEFAULT 1,
  uses            INTEGER DEFAULT 0,
  is_active       BOOLEAN DEFAULT TRUE,
  patient_name    TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ
);

-- ─── CHECK-INS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS check_ins (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id    UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  mood          INTEGER NOT NULL CHECK (mood >= 1 AND mood <= 10),
  anxiety       INTEGER NOT NULL CHECK (anxiety >= 1 AND anxiety <= 10),
  energy        INTEGER DEFAULT 5 CHECK (energy >= 1 AND energy <= 10),
  thoughts      TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── MENSAJES ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  therapist_id  UUID NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  patient_id    UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  message       TEXT NOT NULL,
  is_therapist  BOOLEAN NOT NULL,
  read          BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ASIGNACIONES / TAREAS ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS assignments (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  therapist_id  UUID NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  patient_id    UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  instructions  TEXT NOT NULL,
  due_date      TEXT,
  status        TEXT DEFAULT 'assigned',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

-- ─── OBJETIVOS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goals (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id    UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  metric        TEXT NOT NULL,
  target_value  INTEGER NOT NULL,
  current_value INTEGER DEFAULT 0,
  duration_days INTEGER NOT NULL,
  status        TEXT DEFAULT 'active',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PLANTILLAS DE TAREAS TCC ──────────────────────────────────
CREATE TABLE IF NOT EXISTS task_templates (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  therapist_id  UUID REFERENCES therapists(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  title         TEXT NOT NULL,
  instructions  TEXT NOT NULL,
  difficulty    TEXT DEFAULT 'media',
  duration_min  INTEGER DEFAULT 30,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── NOTIFICACIONES ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id    UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  message       TEXT NOT NULL,
  reference_id  TEXT,
  is_read       BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── NOTAS CLÍNICAS (SOAP) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinical_notes (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id    UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  therapist_id  UUID NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  subjective    TEXT,
  objective     TEXT,
  assessment    TEXT,
  plan          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── RESETEO DE CONTRASEÑA ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_resets (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  therapist_id  UUID NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  token         TEXT UNIQUE NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  used          BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ÍNDICES ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_therapist_patients_therapist ON therapist_patients(therapist_id);
CREATE INDEX IF NOT EXISTS idx_therapist_patients_patient ON therapist_patients(patient_id);
CREATE INDEX IF NOT EXISTS idx_connection_codes_therapist ON connection_codes(therapist_id);
CREATE INDEX IF NOT EXISTS idx_connection_codes_code ON connection_codes(code);
CREATE INDEX IF NOT EXISTS idx_check_ins_patient ON check_ins(patient_id);
CREATE INDEX IF NOT EXISTS idx_check_ins_created ON check_ins(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_check_ins_patient_created ON check_ins(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_therapist ON messages(therapist_id);
CREATE INDEX IF NOT EXISTS idx_messages_patient ON messages(patient_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assignments_therapist ON assignments(therapist_id);
CREATE INDEX IF NOT EXISTS idx_assignments_patient ON assignments(patient_id);
CREATE INDEX IF NOT EXISTS idx_goals_patient ON goals(patient_id);
CREATE INDEX IF NOT EXISTS idx_notifications_patient ON notifications(patient_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(patient_id, is_read) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_clinical_notes_patient ON clinical_notes(patient_id);
CREATE INDEX IF NOT EXISTS idx_clinical_notes_therapist ON clinical_notes(therapist_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);
