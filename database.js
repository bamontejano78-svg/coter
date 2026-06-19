const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const config = require('./config/env');
const logger = require('./config/logger');

// Pool de conexiones PostgreSQL
let pool;

function createPool() {
  if (!config.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL no configurada. Configurala en .env o variable de entorno.\n' +
      'Ejemplo: DATABASE_URL=postgresql://postgres:password@localhost:5432/coter'
    );
  }

  // Debug: loggear detalles de conexión SIN la contraseña
  try {
    const url = new URL(config.DATABASE_URL);
    logger.info('Conectando a PostgreSQL: ' + url.host + '/' + url.pathname.replace('/', '') + ' como ' + url.username);
  } catch (e) {
    logger.info('Conectando a PostgreSQL (URL no parseable para debug)');
  }

  pool = new Pool({
    connectionString: config.DATABASE_URL,
    min: config.DB_POOL_MIN,
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    ssl: config.DATABASE_URL.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
  });

  pool.on('error', (err) => {
    logger.error('Error inesperado en el pool de PostgreSQL', { error: err.message });
  });

  return pool;
}

function getPool() {
  if (!pool) createPool();
  return pool;
}

// Migraciones
async function runMigrations() {
  const p = getPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      applied_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    logger.warn('Directorio de migraciones no encontrado');
    return;
  }

  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (migrationFiles.length === 0) {
    logger.warn('No se encontraron archivos de migracion');
    return;
  }

  const { rows: applied } = await p.query('SELECT name FROM _migrations');
  const appliedNames = new Set(applied.map(r => r.name));

  for (const fileName of migrationFiles) {
    if (appliedNames.has(fileName)) {
      logger.debug('Migracion ya aplicada: ' + fileName);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, fileName), 'utf8');
    logger.info('Aplicando migracion: ' + fileName);

    try {
      await p.query(sql);
      await p.query('INSERT INTO _migrations (name) VALUES ($1)', [fileName]);
      logger.info('Migracion aplicada: ' + fileName);
    } catch (err) {
      logger.error('Error aplicando migracion ' + fileName, { error: err.message });
      throw err;
    }
  }
}

// Plantillas TCC
const DEFAULT_TASK_TEMPLATES = [
  { category: 'Reestructuracion cognitiva', title: 'Registro de pensamientos automaticos', difficulty: 'baja', duration_min: 20, instructions: 'Objetivo: Identificar y cuestionar pensamientos automaticos negativos. Instrucciones: 1. Cuando notes una emocion negativa, anota la situacion, pensamiento y emocion (0-10). 2. Cuestiona cada pensamiento: hay evidencia? hay alternativa? 3. Escribe un pensamiento alternativo. Repite 7 dias.' },
  { category: 'Reestructuracion cognitiva', title: 'Cuestionamiento socratico', difficulty: 'media', duration_min: 30, instructions: 'Objetivo: Cuestionar creencias irracionales. Responde: que evidencia tengo? que evidencia NO tengo? ignoro informacion? que le diria a un amigo? me ayuda o me perjudica? cual seria una forma mas realista? Realizar 3 veces esta semana.' },
  { category: 'Reestructuracion cognitiva', title: 'Identificacion de distorsiones cognitivas', difficulty: 'media', duration_min: 25, instructions: 'Objetivo: Reconocer patrones distorsionados. Distorsiones: todo-o-nada, catastrofismo, sobregeneralizacion, filtro mental, lectura de mente, personalizacion. Cada dia elige 2 pensamientos, identifica la distorsion y reescribelos. 5 dias.' },
  { category: 'Activacion conductual', title: 'Programacion de actividades placenteras', difficulty: 'baja', duration_min: 20, instructions: 'Objetivo: Romper ciclo de inactividad. 1. Lista 10 actividades que disfrutabas. 2. Clasificalas en faciles, medias, desafiantes. 3. Programa 1 facil cada dia y 1 media cada 2-3 dias. 4. Anota como te sentiste (0-10). Meta: 5 actividades esta semana.' },
  { category: 'Activacion conductual', title: 'Experimento conductual', difficulty: 'alta', duration_min: 40, instructions: 'Objetivo: Probar creencias negativas mediante accion. 1. Identifica creencia limitante. 2. Disena experimento: que haras, que predices, cuando. 3. Ejecuta. 4. Evalua resultados y aprendizajes. Repite con 2 creencias diferentes esta semana.' },
  { category: 'Exposicion gradual', title: 'Jerarquia de exposicion', difficulty: 'alta', duration_min: 45, instructions: 'Objetivo: Enfrentar situaciones temidas gradualmente. 1. Identifica situacion evitada. 2. Crea jerarquia de 5-8 pasos. 3. Empieza por el paso 1 hasta que ansiedad baje 50%. 4. Avanza solo cuando paso actual <= 3/10. 5. Registra ansiedad antes, durante y despues.' },
  { category: 'Exposicion gradual', title: 'Exposicion en imaginacion', difficulty: 'media', duration_min: 30, instructions: 'Objetivo: Procesar recuerdos en entorno seguro. 1. Sientate tranquilo, elige recuerdo moderado. 2. Imagina la escena con detalle. 3. Manten 2-3 min, califica ansiedad cada minuto. 4. Repite hasta que baje a la mitad. 5. Termina con 2 min de respiracion profunda.' },
  { category: 'Mindfulness y relajacion', title: 'Escanner corporal', difficulty: 'baja', duration_min: 20, instructions: 'Objetivo: Desarrollar conciencia corporal. 1. Tumbate comodo, cierra ojos, respira 3 veces. 2. Dirige atencion desde pies hasta coronilla. 3. En cada zona nota sensaciones sin juzgar. 4. Si hay tension imagina que se disuelve. Practica 3-4 veces/semana.' },
  { category: 'Mindfulness y relajacion', title: 'Mindfulness diario', difficulty: 'baja', duration_min: 15, instructions: 'Objetivo: Atencion plena en lo cotidiano. Elige UNA actividad diaria: beber cafe, ducharte, caminar, comer fruta. Sin prisas, sin pantallas, 5 min minimo. Si la mente divaga, vuelve suavemente. Practica 2 semanas.' },
  { category: 'Mindfulness y relajacion', title: 'Relajacion muscular progresiva', difficulty: 'baja', duration_min: 15, instructions: 'Objetivo: Reducir tension muscular. Tensa y relaja cada grupo 5/10 seg: manos, brazos, hombros, cara, cuello, pecho, abdomen, piernas, pies. Disfruta 2 min de relajacion total. Practica a diario antes de dormir.' },
  { category: 'Autorregistro emocional', title: 'Diario de emociones', difficulty: 'baja', duration_min: 20, instructions: 'Objetivo: Conciencia emocional. 3 veces/dia registra: situacion, emocion, intensidad (0-10), sensaciones fisicas, que hiciste, funciono? Al final de la semana busca patrones. Mantener 2 semanas.' },
  { category: 'Autorregistro emocional', title: 'Termometro de ansiedad', difficulty: 'baja', duration_min: 10, instructions: 'Objetivo: Monitorizar ansiedad. Cada 2-3 horas califica ansiedad (0-10) y anota que hacias. Tras 1 semana tendras mapa de patrones.' },
  { category: 'Habilidades sociales', title: 'Entrenamiento en asertividad', difficulty: 'media', duration_min: 30, instructions: 'Objetivo: Expresar necesidades claramente. Tecnica del disco rayado. Formula: "Entiendo que... Sin embargo, yo... Asi que..." Practica frente al espejo y aplica en situacion real esta semana.' },
  { category: 'Habilidades sociales', title: 'Role-playing conversaciones dificiles', difficulty: 'alta', duration_min: 35, instructions: 'Objetivo: Preparar conversaciones importantes. Escribe guion con inicio, puntos clave, objeciones y cierre. Practica en voz alta. Programa la conversacion real esta semana.' },
  { category: 'Resolucion de problemas', title: 'Tecnica de 6 pasos', difficulty: 'media', duration_min: 35, instructions: '6 pasos: 1. Definir problema. 2. Lluvia de ideas (10+). 3. Evaluar opciones. 4. Elegir mejor. 5. Plan de accion. 6. Revisar en 1 semana. Aplica a UN problema real esta semana.' },
  { category: 'Resolucion de problemas', title: 'Parada de pensamiento', difficulty: 'baja', duration_min: 15, instructions: 'Objetivo: Interrumpir rumiacion. Di STOP, cambia de lugar, haz algo incompatible 5 min (contar, cantar, ejercicio). Preguntate: puedo hacer algo constructivo ahora? Si: tecnica 6 pasos. No: programa pensarlo manana.' },
  { category: 'Higiene del sueno', title: 'Rutina de higiene del sueno', difficulty: 'baja', duration_min: 20, instructions: 'Noche: apaga pantallas 1-2h antes, baja luces, actividad relajante, no cafeina/alcohol. Cama solo para dormir. Si 20 min sin dormir, levantate. Manana: misma hora siempre, luz natural 15-30 min. Registra calidad 2 semanas.' },
  { category: 'Autocompasion', title: 'Carta de autocompasion', difficulty: 'media', duration_min: 30, instructions: 'Escribe carta a ti mism@ como a un amigo querido: 1. Reconoce el dolor. 2. Normaliza la experiencia. 3. Ofrece consuelo. 4. Mira adelante con amabilidad. Leela en voz alta y guardala.' }
];

// Semillas de desarrollo
async function seedSampleData() {
  if (config.isProd) {
    logger.info('Produccion: saltando datos de ejemplo');
    return;
  }
  const p = getPool();

  try {
    const { rows } = await p.query('SELECT COUNT(*) as count FROM therapists');
    if (parseInt(rows[0].count) > 0) {
      await seedTaskTemplates();
      return;
    }

    const therapistId = uuidv4();
    const hash = await bcrypt.hash('123456', 10);
    await p.query(
      'INSERT INTO therapists (id, name, email, password, specialty) VALUES ($1, $2, $3, $4, $5)',
      [therapistId, 'Dra. Ana Garcia', 'ana@coter.com', hash, 'psicologia']
    );
    logger.info('Terapeuta demo: ana@coter.com / 123456');

    await p.query(
      "INSERT INTO connection_codes (id, therapist_id, code, duration_hours, max_uses, uses, expires_at) VALUES ($1, $2, $3, $4, $5, 0, NOW() + INTERVAL '1 year')",
      [uuidv4(), therapistId, 'TH-ABC123', 8760, 100]
    );
    logger.info('Codigo demo: TH-ABC123');

    await seedTaskTemplates();
  } catch (err) {
    logger.error('Error en semillas', { error: err.message });
    if (err.code !== '23505') throw err;
  }
}

async function seedTaskTemplates() {
  const p = getPool();
  const { rows } = await p.query('SELECT COUNT(*) as count FROM task_templates');
  if (parseInt(rows[0].count) > 0) return;

  for (let i = 0; i < DEFAULT_TASK_TEMPLATES.length; i += 5) {
    const batch = DEFAULT_TASK_TEMPLATES.slice(i, i + 5);
    const params = [];
    const phs = [];
    batch.forEach((t, idx) => {
      const b = idx * 6 + 1;
      params.push(uuidv4(), t.category, t.title, t.instructions, t.difficulty, t.duration_min);
      phs.push('($' + b + ', NULL, $' + (b + 1) + ', $' + (b + 2) + ', $' + (b + 3) + ', $' + (b + 4) + ', $' + (b + 5) + ')');
    });
    await p.query(
      'INSERT INTO task_templates (id, therapist_id, category, title, instructions, difficulty, duration_min) VALUES ' + phs.join(', ') + ' ON CONFLICT DO NOTHING',
      params
    );
  }
  logger.info(DEFAULT_TASK_TEMPLATES.length + ' plantillas TCC sembradas');
}

// Inicializacion
let initialized = false;

async function initializeDatabase() {
  if (initialized) return;

  try {
    createPool();
    const p = getPool();
    await p.query('SELECT 1');
    logger.info('Conectado a PostgreSQL');
    await p.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await runMigrations();
    await seedSampleData();
    initialized = true;
    logger.info('Base de datos inicializada correctamente');
  } catch (err) {
    logger.error('Error inicializando BD', { error: err.message, stack: err.stack });
    throw err;
  }
}

async function closeDatabase() {
  if (pool) {
    logger.info('Cerrando pool PostgreSQL...');
    await pool.end();
    pool = null;
  }
}

module.exports = { initializeDatabase, closeDatabase, getPool };
