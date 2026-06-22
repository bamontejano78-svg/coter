-- Migration 004: Añadir columna patient_name a connection_codes
--
-- Contexto: La columna patient_name se incluyó originalmente en 001_initial.sql.
-- En bases de datos existentes que ya tenían aplicada la migración 001,
-- el runner de migraciones no re-aplica ficheros antiguos, por lo que la
-- columna nunca llegó a crearse en producción/staging. Esto provocaba que
-- cualquier INSERT a connection_codes que listara patient_name en el
-- INSERT fallase con:
--   ERROR: column "patient_name" of relation "connection_codes" does not exist
--
-- Esta migración es idempotente (ADD COLUMN IF NOT EXISTS).
-- No añadimos índice: no hay queries que filtren por patient_name hoy;
-- si surge esa necesidad se creará cuando aparezca la consulta para
-- evitar coste de escritura en cada INSERT del terapeuta.

ALTER TABLE connection_codes
  ADD COLUMN IF NOT EXISTS patient_name TEXT;
