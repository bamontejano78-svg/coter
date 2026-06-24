/**
 * ═══════════════════════════════════════════════════════════════
 * Notifications — Coter Pro
 *
 * Crea notificaciones para pacientes y emite notification:new al bus
 * para entrega en tiempo real via SSE. La verificacion de tareas
 * vencidas o por vencer se hace de forma batch en background (ver
 * runAllPendingReminders y utils/taskScheduler), NO inline en un GET.
 *
 * Por que batch + cron en lugar de inline-en-GET:
 *   - GET /notifications debe ser idempotente (REST).
 *   - Si el paciente no abre la app 3 dias, los recordatorios no se generan.
 *   - Una sola query batch es mas eficiente que N queries por paciente.
 *
 * Idempotencia: dos capas de defensa.
 *   1. SELECT del scan usa NOT EXISTS para excluir reminders ya enviados.
 *   2. INSERT batch usa ON CONFLICT DO NOTHING sobre un unique index
 *      parcial (migrations/006_unique_reminder_index.sql). Cierra la
 *      ventana TOCTOU entre los dos pasos si dos crons corren en
 *      paralelo o si en el futuro escalan a N pods.
 * ═══════════════════════════════════════════════════════════════
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../config/logger');
const bus = require('./eventBus');

const REMINDER_WINDOW_HOURS = 24;
// Tamaño de chunk para el INSERT batch. Multi-VALUES con N placeholders
// se vuelve problematico cerca del limite de 65535 bind params de PG; con
// 6 params por fila (id, patient_id, type, title, message, reference_id),
// 1000 filas = 6000 placeholders, holgura amplia. Chunking mantiene la
// query SQL razonable aunque una clínica tenga miles de matches en una
// sola tick.
const INSERT_CHUNK_SIZE = 1000;

/**
 * Crea una notificacion para un paciente. Retorna la PROMESA del INSERT
 * (no fire-and-forget): el caller puede awaitar para confirmar el commit
 * antes de continuar. Esto es lo que usa runAllPendingReminders para que
 * el contador de "reminders" / "overdue" refleje lo realmente persistido
 * y los tests no vean filas por mitad.
 *
 * Aun asi, el bus.publish sigue siendo fire-and-forget dentro del .then()
 * si la insercion tuvo exito. Si la BD falla, NO emitimos eventos fantasma.
 */
function createNotification(pool, patientId, type, title, message, referenceId = null) {
  const id = uuidv4();
  return pool.query(
    'INSERT INTO notifications (id, patient_id, type, title, message, reference_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, patientId, type, title, message, referenceId]
  ).then(() => {
    bus.publish(
      bus.topicFor('patient', patientId),
      'notification:new',
      { id, type, title, message, reference_id: referenceId }
    );
    return { id, patientId, type, title, message, reference_id: referenceId };
  }).catch(err => {
    logger.error('Error creando notificacion', { error: err.message });
    return null;
  });
}

/**
 * Batch que escanea TODAS las tareas pendientes para TODOS los pacientes
 * activos en una sola query, y crea notificaciones de "overdue" o
 * "reminder" segun corresponda.
 *
 * Disenado para ser invocado por el cron en background
 * (utils/taskScheduler.runTick) cada N minutos - NO en el GET /notifications.
 *
 * Optimizaciones vs la version original:
 *   - Dedup embebido en el SELECT (NOT EXISTS, una sola query batch).
 *   - INSERT en CHUNKs multi-VALUES con ON CONFLICT DO NOTHING: en lugar
 *     del patron N+1 (N round-trips por cada createNotification), hace
 *     ceil(N/1000) round-trips. A 100 matches = 0 queries extra; a 5000
 *     matches = 5 queries totales en lugar de 5000. La reduccion se nota
 *     especialmente en clínicas grandes.
 *   - createNotification ahora retorna la promesa del INSERT y se awaita
 *     para que los contadores reflejen commits confirmados.
 *
 * La query une assignments con therapist_patients y filtra solo vinculos
 * activos: un paciente desconectado (soft-delete en therapist_patients)
 * no debe recibir reminders aunque tenga tareas pendientes.
 *
 * @returns {Promise<{scanned:number, reminders:number, overdue:number, errors:number}>}
 */
async function runAllPendingReminders(pool) {
  // reminders y overdue se cuentan desde insertedRows (paso 4) — NO desde
  // el plan en paso 2. Razon: si un cron paralelo pre-inserta las mismas
  // filas, ON CONFLICT DO NOTHING retorna 0 rows para ese chunk, y el
  // contador debe reflejar 0 inserts reales para evitar doble-cuenta en
  // metricas cron-vs-cron o cron-vs-ROUTE.
  let reminders = 0;
  let overdue = 0;
  let errors = 0;

  // ═══ Paso 1: SELECT scan con NOT EXISTS dedup ═══
  // Una sola query batch. Esto baja de O(2N+1) queries a O(N+1): N inserts
  // sobre N matches. ("scanned" son los matches unicos que necesitan
  // notificacion, NO el total de assignments con due_date en el sistema,
  // que es mayor.)
  //
  // Schema: assignments.due_date es TIMESTAMPTZ y notifications.reference_id
  // es UUID (ver migrations/005_alter_types.sql). Sin casts: PG usa indices
  // nativos sobre las columnas y devuelve los tipos correctos al cliente
  // (pg-node expone due_date como Date JS y reference_id como string UUID).
  const { rows: tasks } = await pool.query(
    `SELECT a.id, a.patient_id, a.title, a.due_date
     FROM assignments a
     JOIN therapist_patients tp ON tp.patient_id = a.patient_id
     WHERE a.status = 'assigned'
       AND a.due_date IS NOT NULL
       AND a.due_date <= NOW() + make_interval(hours => $1)
       AND tp.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.patient_id = a.patient_id
           AND n.reference_id = a.id
           AND n.type IN ('overdue', 'reminder')
       )`,
    [REMINDER_WINDOW_HOURS]
  ).catch(err => {
    // Si la query de scan falla, loggeamos y devolvemos ceros - runTick
    // no debe tirar la app por un fallo transitorio de BD.
    logger.error('Error en batch scan de reminders', { error: err.message });
    return { rows: [] };
  });

  const scanned = tasks.length;
  if (!scanned) return { scanned: 0, reminders: 0, overdue: 0, errors: 0 };

  // ═══ Paso 2: row-building en JS ═══
  // Mantenemos la clasificacion overdue/reminder Y el formateo de la fecha
  // en toLocaleDateString('es-ES') aqui porque (a) preserva exactamente el
  // formato del frontend y (b) el redondeo de hoursLeft con Math.round()
  // no tiene equivalente natural en SQL. Generamos el uuidv4() en JS para
  // evitar la dependencia del orden no-garantizado de RETURNING.
  const now = Date.now();
  const toInsert = [];
  for (const task of tasks) {
    const dueMs = new Date(task.due_date).getTime();
    const hoursLeft = (dueMs - now) / (1000 * 60 * 60);

    const isOverdue = hoursLeft <= 0;
    if (!isOverdue && hoursLeft > REMINDER_WINDOW_HOURS) continue; // safety net

    const dueDateFormatted = new Date(task.due_date).toLocaleDateString('es-ES');

    toInsert.push({
      id: uuidv4(),
      patient_id: task.patient_id,
      type: isOverdue ? 'overdue' : 'reminder',
      title: isOverdue ? 'Tarea vencida' : 'Tarea por vencer',
      message: isOverdue
        ? '"' + task.title + '" vencio el ' + dueDateFormatted + '. Completala cuanto antes!'
        : '"' + task.title + '" vence en ' + (
            hoursLeft < 1 ? 'menos de 1 hora' : Math.round(hoursLeft) + ' horas'
          ) + '. No olvides completarla!',
      reference_id: task.id,
    });
    // (counters incrementan en paso 4 desde insertedRows — ver comentario al inicio)
  }

  // Map id→row para que el publish loop pueda correlacionar las filas que
  // RETURNING trae (en orden NO garantizado) con la informacion de JS.
  const toInsertById = new Map(toInsert.map(r => [r.id, r]));

  if (!toInsert.length) return { scanned, reminders: 0, overdue: 0, errors: 0 };

  // ═══ Paso 3: chunked INSERT multi-VALUES con ON CONFLICT DO NOTHING ═══
  // Antes este loop era N+1 queries (createNotification por cada tarea). Hoy
  // son ceil(N/1000) queries totales, cada una con hasta 1000 VALUES tuples
  // y un solo RETURNING. La segunda capa de dedup (unique index parcial via
  // migrations/006) protege contra TOCTOU si dos crons corren en paralelo.
  for (let chunkStart = 0; chunkStart < toInsert.length; chunkStart += INSERT_CHUNK_SIZE) {
    const chunk = toInsert.slice(chunkStart, chunkStart + INSERT_CHUNK_SIZE);

    const placeholders = chunk.map((_, i) => {
      const off = i * 6 + 1;
      return '($' + off + ', $' + (off + 1) + ', $' + (off + 2) + ', $' + (off + 3) + ', $' + (off + 4) + ', $' + (off + 5) + ')';
    }).join(', ');

    const params = [];
    for (const r of chunk) params.push(r.id, r.patient_id, r.type, r.title, r.message, r.reference_id);

    const { rows: insertedRows } = await pool.query(
      `INSERT INTO notifications (id, patient_id, type, title, message, reference_id)
       VALUES ${placeholders}
       ON CONFLICT (patient_id, reference_id, type) WHERE type IN ('overdue', 'reminder')
       DO NOTHING
       RETURNING id, patient_id, type, reference_id`,
      params
    ).catch(err => {
      // Si el chunk entero falla (caida de conexion transitoria, etc.) no
      // sabemos cuantas filas hubieran persistido; lo reportamos como
      // chunks_failed para que el log distinga chunks perdidos de filas.
      logger.error('Error en batch INSERT de reminders', { error: err.message, chunkSize: chunk.length });
      errors += chunk.length;
      return { rows: [] };
    });

    // ═══ Paso 4: conteo commit-confirmado + bus.publish ═══
    // Solo iteramos sobre insertedRows (RETURNING excluye las filas que
    // cayeron en ON CONFLICT DO NOTHING). El orden de RETURNING no está
    // garantizado en PostgreSQL — por eso correlacionamos por id (que
    // generamos en JS, no en SQL).
    //
    // Counter desde insertedRows garantiza exactitud: si una fila cay[o
    // en ON CONFLICT (cron paralelo pre-insertó), NO se cuenta como
    // reminder/overdue. Bug pre-fix: los counters se incrementaban en el
    // paso 2 (plan), inflando metricas y haciendo que el reporte del cron
    // sobre-declare envios.
    //
    // Aislamiento de errores: EventEmitter.emit (que es lo que usa
    // bus.publish por debajo) es sync y PROPAGA excepciones de los
    // listeners. Si un subscriber (e.g. una conexion SSE cerrada) tira
    // un throw, sin try/catch eso bloqueria el resto del loop y
    // dejaria al siguiente chunk sin ejecutar. Aislamos cada publish.
    for (const row of insertedRows) {
      if (row.type === 'overdue') overdue++;
      else if (row.type === 'reminder') reminders++;

      const src = toInsertById.get(row.id);
      if (!src) continue; // defensivo: no deberia pasar
      try {
        bus.publish(
          bus.topicFor('patient', row.patient_id),
          'notification:new',
          {
            id: row.id,
            type: row.type,
            title: src.title,
            message: src.message,
            reference_id: row.reference_id,
          }
        );
      } catch (publishErr) {
        logger.warn('Error publicando notification:new al bus (sigue con el resto del chunk)', {
          error: publishErr.message, notificationId: row.id,
        });
      }
    }
  }

  return { scanned, reminders, overdue, errors };
}

module.exports = { createNotification, runAllPendingReminders };
