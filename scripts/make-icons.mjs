#!/usr/bin/env node
// Regenerate the procedural tray icons in electron/assets/ (see electron/icon.js).
//   node scripts/make-icons.mjs
// The application icon (icon.png + the multi-size icon.ico used for the Windows exe and the
// installer) is the hologram-face badge built by scripts/make-app-icon.py; main.js only falls back
// to the procedural icon when icon.png is missing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIconPng } from '../electron/icon.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'electron', 'assets');
fs.mkdirSync(outDir, { recursive: true });

// Tray: 16 px base with @1.5x/@2x variants (Electron picks by display scale factor).
const files = {
  'tray.png': 16,
  'tray@1.5x.png': 24,
  'tray@2x.png': 32,
};
for (const [name, size] of Object.entries(files)) {
  const png = renderIconPng(size);
  fs.writeFileSync(path.join(outDir, name), png);
  console.log(`wrote electron/assets/${name} (${size}x${size}, ${png.length} bytes)`);
}
