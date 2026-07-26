// Fix exercise_sessions CHECK constraint to allow widget kinds
// Run: node scripts/fix-widget-constraint.js
const { getPool, initializeDatabase, closeDatabase } = require('../database');
const fs = require('fs');
const path = require('path');

(async () => {
  try {
    await initializeDatabase();
    const pool = getPool();
    const sql = fs.readFileSync(path.join(__dirname, 'fix-widget-constraint.sql'), 'utf8');
    await pool.query(sql);
    console.log('✅ Constraint fixed: widget exercise kinds now allowed');
    await closeDatabase();
  } catch (err) {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  }
})();
