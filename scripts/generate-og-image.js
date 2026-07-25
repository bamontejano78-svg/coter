#!/usr/bin/env node
/* ============================================================
   Coter Pro — Conversión de OG Image SVG → PNG
   ============================================================
   Requisitos: Node.js + sharp (`npm install --save-dev sharp`)
   Uso:        node scripts/generate-og-image.js

   Si no puedes instalar sharp, convierte manualmente:
   1. Abre www/og-image.svg en Chrome
   2. DevTools → Device Toolbar → Responsive: 1200×630
   3. Haz una captura de pantalla del viewport
   4. Guarda como www/og-image.png
   ============================================================ */

const fs = require('fs');
const path = require('path');

const SVG_PATH = path.join(__dirname, '..', 'www', 'og-image.svg');
const PNG_PATH = path.join(__dirname, '..', 'www', 'og-image.png');

async function main() {
  if (!fs.existsSync(SVG_PATH)) {
    console.error('❌ No se encontró www/og-image.svg');
    process.exit(1);
  }

  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    console.log('⚠️  sharp no está instalado. Instálalo con:');
    console.log('   npm install --save-dev sharp');
    console.log('');
    console.log('📋 Alternativa manual:');
    console.log('   1. Abre www/og-image.svg en Chrome');
    console.log('   2. DevTools → Device Toolbar → Responsive: 1200×630');
    console.log('   3. Haz captura del viewport y guarda como www/og-image.png');
    process.exit(0);
  }

  try {
    const svgBuffer = fs.readFileSync(SVG_PATH);
    await sharp(svgBuffer)
      .resize(1200, 630)
      .png()
      .toFile(PNG_PATH);
    console.log('✅ www/og-image.png generado correctamente (1200×630)');
  } catch (err) {
    console.error('❌ Error al convertir:', err.message);
    process.exit(1);
  }
}

main();
