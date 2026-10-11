// The tray icon while "Hey Jade" has the microphone open (electron/wake/tray-icon.js): the head
// with a cyan dot in the lower right corner, at the tray's three scales; wakeMicOpen() says when.
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { TRAY_SIZES, listeningTrayImage, renderListeningTrayPng } from '../../../electron/wake/tray-icon.js';
import { renderIconPng } from '../../../electron/icon.js';
import { wakeMicOpen } from '../../../electron/tray-menu.js';

/** RGBA of a PNG written by electron/icon.js encodePng (8-bit RGBA, filter 0 per row) */
function decode(png) {
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const idat = [];
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    const type = png.toString('ascii', o + 4, o + 8);
    if (type === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) px.set(raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)), y * w * 4);
  return { w, h, px };
}

describe('the listening tray icon', () => {
  it('is the tray head plus a cyan dot in the lower right corner, at 16, 24 and 32 px', () => {
    for (const [, size] of TRAY_SIZES) {
      const { w, h, px } = decode(renderListeningTrayPng(size));
      expect([w, h]).toEqual([size, size]);
      const at = (x, y) => Array.from(px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));
      const c = Math.round(size - size * 0.21 - 0.5);
      const [r, g, b, a] = at(c, c);
      expect(a).toBe(255);
      expect(b).toBeGreaterThan(200);
      expect(g).toBeGreaterThan(180);
      expect(r).toBeLessThan(160);
      // the head itself is unchanged away from the dot
      const plain = decode(renderIconPng(size)).px;
      const rows = size * 4 * Math.floor(size / 3);
      expect(Array.from(px.subarray(0, rows))).toEqual(Array.from(plain.subarray(0, rows)));
    }
  });

  it('builds one image with three representations (cached)', () => {
    const reps = [];
    const ni = { createEmpty: () => ({ addRepresentation: (r) => reps.push(r) }) };
    const img = listeningTrayImage(ni);
    expect(reps.map((r) => r.scaleFactor)).toEqual([1, 1.5, 2]);
    expect(listeningTrayImage(ni)).toBe(img);
  });

  it('wakeMicOpen: while the mic is open for her name (waiting, a capture, busy, muted), not off/paused/locked/blocked', () => {
    for (const state of ['waiting', 'attention', 'listening', 'followup', 'look', 'busy', 'barge', 'muted']) expect(wakeMicOpen({ enabled: true, state }), state).toBe(true);
    for (const state of ['off', 'unavailable', 'starting', 'paused', 'locked', 'blocked']) expect(wakeMicOpen({ enabled: true, state }), state).toBe(false);
    expect(wakeMicOpen({ enabled: false, state: 'waiting' })).toBe(false);
    expect(wakeMicOpen(undefined)).toBe(false);
  });
});
