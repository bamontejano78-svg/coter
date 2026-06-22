/**
 * ═══════════════════════════════════════════════════════════════
 * Coter Pro — Staging Server (HTTPS)
 * 
 * Arranca el servidor Express con HTTPS usando los certificados
 * self-signed en nginx/certs/. Se conecta a la BD configurada
 * en .env.staging (Neon PostgreSQL).
 * 
 * Uso: node scripts/start-staging.js
 * ═══════════════════════════════════════════════════════════════
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Cargar .env.staging
const envPath = path.join(__dirname, '..', '.env.staging');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return;
    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
  console.log('✅ .env.staging cargado');
} else {
  console.warn('⚠️  .env.staging no encontrado — usa variables de entorno del sistema');
}

// Establecer NODE_ENV si no está definido
process.env.NODE_ENV = process.env.NODE_ENV || 'staging';

// Cargar certificados SSL
const certsDir = path.join(__dirname, '..', 'nginx', 'certs');
const sslOptions = {
  key: fs.readFileSync(path.join(certsDir, 'staging.key')),
  cert: fs.readFileSync(path.join(certsDir, 'staging.crt')),
};

// Cargar la app Express
const app = require('../server');

const PORT = parseInt(process.env.STAGING_PORT || process.env.PORT, 10) || 3000;
const HTTPS_PORT = parseInt(process.env.STAGING_HTTPS_PORT, 10) || 8443;

// Determinar la DATABASE_URL
const dbUrl = process.env.DATABASE_URL || '';
const isNeon = dbUrl.includes('neon.tech');
const maskedUrl = dbUrl ? dbUrl.replace(/\/\/[^:]+:[^@]+@/, '//***:***@') : 'no configurada';

console.log('');
console.log('╔══════════════════════════════════════════════╗');
console.log('║   🧠 Coter Pro — Staging                    ║');
console.log('╠══════════════════════════════════════════════╣');
console.log('║   Entorno:     ' + process.env.NODE_ENV.padEnd(30) + '║');
console.log('║   BD:          ' + (isNeon ? 'Neon PostgreSQL'.padEnd(30) : maskedUrl.substring(0,30).padEnd(30)) + '║');
console.log('║   HTTP:        http://localhost:' + String(PORT).padEnd(20) + '║');
console.log('║   HTTPS:       https://localhost:' + String(HTTPS_PORT).padEnd(16) + '║');
console.log('╚══════════════════════════════════════════════╝');
console.log('');

// Iniciar servidor HTTP
http.createServer(app).listen(PORT, () => {
  console.log('🌐 HTTP  → http://localhost:' + PORT);
});

// Iniciar servidor HTTPS
https.createServer(sslOptions, app).listen(HTTPS_PORT, () => {
  console.log('🔒 HTTPS → https://localhost:' + HTTPS_PORT);
  console.log('');
  console.log('   🌟  Inicio:     https://localhost:' + HTTPS_PORT + '/');
  console.log('   🧑‍⚕️  Terapeuta: https://localhost:' + HTTPS_PORT + '/terapeuta.html');
  console.log('   🧑‍💻  Paciente:  https://localhost:' + HTTPS_PORT + '/paciente.html');
  console.log('   🩺  Health:    https://localhost:' + HTTPS_PORT + '/api/health');
  console.log('');
  console.log('   ⚠️  Certificado self-signed. El navegador mostrará');
  console.log('      advertencia. Haz clic en "Avanzado" → "Continuar".');
  console.log('');
  console.log('   🛑  Ctrl+C para detener');
  console.log('');
});
