const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { initializeDatabase, closeDatabase } = require('./database');
const config = require('./config/env');
const logger = require('./config/logger');

const therapistRoutes = require('./routes/therapist');
const patientRoutes = require('./routes/patients');

const app = express();

// ─── Seguridad ───────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
    },
  },
}));

app.use(cors({
  origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : '*',
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

// Servir archivos estaticos (frontend)
app.use(express.static('www'));
app.use(express.static('public'));

// ─── Rate Limiting ────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Demasiadas peticiones, intenta mas tarde' },
});

const authLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.isProd ? 10 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Demasiados intentos, espera unos minutos' },
});

// ─── Logging HTTP ─────────────────────────────────────────────
if (config.isProd) {
  app.use(morgan('combined', { stream: logger.stream }));
} else {
  app.use(morgan('dev'));
}

// ─── Rutas (API v1) ───────────────────────────────────────────
app.use('/api/v1/therapists', authLimiter);
app.use('/api/v1/patients', apiLimiter);
app.use('/api/v1/therapists', therapistRoutes);
app.use('/api/v1/patients', patientRoutes);

// Compatibilidad con rutas antiguas sin version
app.use('/api/therapists', authLimiter, therapistRoutes);
app.use('/api/patients', apiLimiter, patientRoutes);

// Health check mejorado
app.get('/api/health', async (req, res) => {
  try {
    const { getPool } = require('./database');
    const pool = getPool();
    // Timeout de 3 segundos para evitar bloqueo si el pool esta saturado
    const result = await Promise.race([
      pool.query('SELECT 1 as ok'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    res.json({
      status: 'ok',
      database: 'connected',
      environment: config.NODE_ENV,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      database: err.message === 'timeout' ? 'timeout' : 'disconnected',
      environment: config.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  }
});

// ─── Manejo de errores ────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Ruta no encontrada' });
});

app.use((err, req, res, _next) => {
  logger.error('Error no manejado', { error: err.message, stack: err.stack, url: req.url, method: req.method });
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    error: config.isProd ? 'Error interno del servidor' : err.message,
  });
});

// ─── Arranque ─────────────────────────────────────────────────
initializeDatabase()
  .then(() => {
    const server = app.listen(config.PORT, config.HOST, () => {
      logger.info('Coter Pro iniciado en http://' + config.HOST + ':' + config.PORT);
      logger.info('Entorno: ' + config.NODE_ENV);
      logger.info('Frontend: http://' + config.HOST + ':' + config.PORT);
      if (!config.isProd) {
        logger.info('Terapeuta demo: ana@coter.com / 123456');
        logger.info('Codigo demo: TH-ABC123');
      }
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info('Recibido ' + signal + ', cerrando servidor...');
      server.close(async () => {
        await closeDatabase();
        logger.info('Servidor cerrado');
        process.exit(0);
      });
      // Forzar cierre tras 10s
      setTimeout(() => {
        logger.error('Cierre forzado tras timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch(err => {
    logger.error('Error fatal al iniciar', { error: err.message, stack: err.stack });
    process.exit(1);
  });

module.exports = app;
