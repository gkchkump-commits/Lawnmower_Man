#!/usr/bin/env node
// Regenerate the procedural app/tray icons in electron/assets/ (see electron/icon.js).
//   node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIconPng } from '../electron/icon.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'electron', 'assets');
fs.mkdirSync(outDir, { recursive: true });

// Tray: 16 px base with @1.5x/@2x variants (Electron picks by display scale factor).
// App icon: 512 px PNG (electron-builder converts it to .ico/.icns; Linux uses it directly).
const files = {
  'tray.png': 16,
  'tray@1.5x.png': 24,
  'tray@2x.png': 32,
  'icon.png': 512,
};
for (const [name, size] of Object.entries(files)) {
  const png = renderIconPng(size);
  fs.writeFileSync(path.join(outDir, name), png);
  console.log(`wrote electron/assets/${name} (${size}x${size}, ${png.length} bytes)`);
}
