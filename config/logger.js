const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Crear directorio de logs si no existe
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const isProd = (process.env.NODE_ENV || 'development') === 'production';
const isTest = (process.env.NODE_ENV || 'development') === 'test';
const logLevel = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');

// Formateador personalizado
const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    if (stack) {
      return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}\n${stack}`;
    }
    return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
  })
);

// Formateador para consola con colores
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    if (stack) {
      return `${timestamp} ${level}: ${message}${metaStr}\n${stack}`;
    }
    return `${timestamp} ${level}: ${message}${metaStr}`;
  })
);

const transports = [];

// En tests, solo loguear a consola con nivel error
if (isTest) {
  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
      level: 'error',
    })
  );
} else {
  // Consola: siempre
  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
      level: logLevel,
    })
  );

  // Archivo: errores
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5 MB
      maxFiles: 5,
    })
  );

  // Archivo: todos los logs
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 10,
    })
  );
}

const logger = winston.createLogger({
  level: logLevel,
  format: customFormat,
  transports,
  exitOnError: false,
});

// Logger wrapper con soporte para datos estructurados
module.exports = {
  error: (message, meta = {}) => logger.error(message, meta),
  warn: (message, meta = {}) => logger.warn(message, meta),
  info: (message, meta = {}) => logger.info(message, meta),
  http: (message, meta = {}) => logger.http(message, meta),
  debug: (message, meta = {}) => logger.debug(message, meta),

  // Log de peticiones HTTP (usado por morgan)
  stream: {
    write: (message) => {
      logger.http(message.trim());
    },
  },

  // Acceso al logger winston subyacente
  winston: logger,
};
