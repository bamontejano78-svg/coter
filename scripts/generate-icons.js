#!/usr/bin/env node
/* ============================================================
   Coter Pro — Generación de iconos PNG Android
   ============================================================
   Convierte el SVG del brand mark a PNG en todos los tamaños
   de densidad para compatibilidad pre-API 26.

   Requisitos: sharp (`npm install` ya lo tiene como devDep)

   Tamaños de launcher icon (full asset, pre-adaptive):
     mdpi    —  48x48  (1x)
     hdpi    —  72x72  (1.5x)
     xhdpi   —  96x96  (2x)
     xxhdpi  — 144x144 (3x)
     xxxhdpi — 192x192 (4x)

   Uso: node scripts/generate-icons.js
   ============================================================ */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const RES_DIR = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
const SVG_PATH = path.join(RES_DIR, 'drawable', 'ic_launcher_source.svg');

const DENSITIES = [
  { name: 'mdpi',    size: 48  },
  { name: 'hdpi',    size: 72  },
  { name: 'xhdpi',   size: 96  },
  { name: 'xxhdpi',  size: 144 },
  { name: 'xxxhdpi', size: 192 },
];

async function main() {
  console.log('🎨 Coter Icon Generator\n');

  if (!fs.existsSync(SVG_PATH)) {
    console.error('❌ SVG source not found at:', SVG_PATH);
    process.exit(1);
  }

  const svgBuffer = fs.readFileSync(SVG_PATH);

  for (const d of DENSITIES) {
    const dir = path.join(RES_DIR, `mipmap-${d.name}`);
    fs.mkdirSync(dir, { recursive: true });

    // ── Standard icon ──────────────────────────────────
    const standardPath = path.join(dir, 'ic_launcher.png');
    await sharp(svgBuffer)
      .resize(d.size, d.size)
      .png()
      .toFile(standardPath);
    console.log(`  ✅ mipmap-${d.name}/ic_launcher.png  (${d.size}x${d.size})`);

    // ── Round icon (circular mask) ─────────────────────
    const roundPath = path.join(dir, 'ic_launcher_round.png');
    const circleSvg = Buffer.from(
      `<svg width="${d.size}" height="${d.size}" viewBox="0 0 ${d.size} ${d.size}">` +
      `<defs><clipPath id="circle"><circle cx="${d.size / 2}" cy="${d.size / 2}" r="${d.size / 2}"/></clipPath></defs>` +
      `<g clip-path="url(#circle)"><image href="data:image/svg+xml;base64,${svgBuffer.toString('base64')}" width="${d.size}" height="${d.size}"/></g>` +
      '</svg>'
    );
    await sharp(circleSvg)
      .resize(d.size, d.size)
      .png()
      .toFile(roundPath);
    console.log(`  ✅ mipmap-${d.name}/ic_launcher_round.png  (${d.size}x${d.size})`);
  }

  console.log('\n✅ Done! 10 PNG icons generated (5 standard + 5 round).');
  console.log('📱 Pre-API 26 devices will use these PNGs as fallback.');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
