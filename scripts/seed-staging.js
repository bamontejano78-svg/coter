/**
 * Seed demo data into the staging database (Neon PostgreSQL)
 */

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// ⚠️  La DATABASE_URL debe configurarse como variable de entorno.
// La credencial que estaba aquí fue rotada por seguridad.
if (!process.env.DATABASE_URL) {
  console.error('❌ ERROR: DATABASE_URL no está configurada.');
  console.error('   Define la variable de entorno: DATABASE_URL=postgresql://...');
  process.exit(1);
}
const DATABASE_URL = process.env.DATABASE_URL;

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 15000 });

  try {
    // Check existing
    const { rows: existing } = await pool.query('SELECT COUNT(*) as c FROM therapists');
    if (parseInt(existing[0].c) > 0) {
      console.log('✅ Ya existen ' + existing[0].c + ' terapeuta(s), saltando seed.');
      const { rows: codes } = await pool.query('SELECT code FROM connection_codes WHERE is_active = true');
      console.log('🔑 Códigos activos: ' + (codes.map(c => c.code).join(', ') || 'ninguno'));
      await pool.end();
      return;
    }

    // Create demo therapist
    const tid = uuidv4();
    const hash = await bcrypt.hash('123456', 10);
    await pool.query(
      'INSERT INTO therapists (id, name, email, password, specialty) VALUES ($1, $2, $3, $4, $5)',
      [tid, 'Dra. Ana Garcia', 'ana@coter.com', hash, 'psicologia']
    );
    console.log('👩‍⚕️  Terapeuta demo: ana@coter.com / 123456');

    // Create connection code
    await pool.query(
      "INSERT INTO connection_codes (id, therapist_id, code, duration_hours, max_uses, uses, expires_at) VALUES ($1, $2, $3, $4, $5, 0, NOW() + INTERVAL '1 year')",
      [uuidv4(), tid, 'TH-ABC123', 8760, 100]
    );
    console.log('🔑 Código demo: TH-ABC123');

    await pool.end();
    console.log('✅ Seed completado.');
  } catch (err) {
    console.error('❌ Error:', err.message);
    await pool.end();
    process.exit(1);
  }
}

main();
