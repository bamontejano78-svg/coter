const { v4: uuidv4 } = require('uuid');
const logger = require('../config/logger');

/**
 * Crea una notificacion para un paciente
 */
function createNotification(pool, patientId, type, title, message, referenceId = null) {
  const id = uuidv4();
  pool.query(
    'INSERT INTO notifications (id, patient_id, type, title, message, reference_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, patientId, type, title, message, referenceId]
  ).catch(err => {
    logger.error('Error creando notificacion', { error: err.message });
  });
}

/**
 * Verifica tareas pendientes y genera recordatorios
 */
function checkTaskReminders(pool, patientId) {
  pool.query(
    "SELECT * FROM assignments WHERE patient_id = $1 AND status = 'assigned' AND due_date IS NOT NULL",
    [patientId]
  ).then(({ rows: tasks }) => {
    if (!tasks || !tasks.length) return;
    const now = new Date();

    tasks.forEach(task => {
      const dueDate = new Date(task.due_date);
      const hoursLeft = (dueDate - now) / (1000 * 60 * 60);

      if (hoursLeft <= 0) {
        pool.query(
          "SELECT id FROM notifications WHERE patient_id = $1 AND reference_id = $2 AND type = 'overdue'",
          [patientId, task.id]
        ).then(({ rows: existing }) => {
          if (!existing.length) {
            createNotification(pool, patientId, 'overdue',
              'Tarea vencida',
              '"' + task.title + '" vencio el ' + dueDate.toLocaleDateString('es-ES') + '. Completala cuanto antes!',
              task.id);
          }
        }).catch(() => {});
      } else if (hoursLeft <= 24) {
        pool.query(
          "SELECT id FROM notifications WHERE patient_id = $1 AND reference_id = $2 AND type = 'reminder'",
          [patientId, task.id]
        ).then(({ rows: existing }) => {
          if (!existing.length) {
            const timeLeft = hoursLeft < 1 ? 'menos de 1 hora' : Math.round(hoursLeft) + ' horas';
            createNotification(pool, patientId, 'reminder',
              'Tarea por vencer',
              '"' + task.title + '" vence en ' + timeLeft + '. No olvides completarla!',
              task.id);
          }
        }).catch(() => {});
      }
    });
  }).catch(err => {
    logger.error('Error verificando recordatorios', { error: err.message });
  });
}

module.exports = { createNotification, checkTaskReminders };
