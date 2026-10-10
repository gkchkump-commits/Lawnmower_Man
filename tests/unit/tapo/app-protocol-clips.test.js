import { describe, it, expect } from 'vitest';
/* global Request */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppProtocolHandler, mimeTypeFor, parseRange } from '../../../electron/app-protocol.js';
import { buildCsp } from '../../../electron/security.js';

describe('app:// clip mount with Range', () => {
  const PATTERN = /^\d{4}-\d{2}-\d{2}\/\d{6}-(person|motion|tamper)-[a-z0-9]{4}\.(mp4|jpg)$/;
  function setup() {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-dist-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>');
    const clips = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-clips-'));
    fs.mkdirSync(path.join(clips, '2026-10-10'));
    const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    fs.writeFileSync(path.join(clips, '2026-10-10', '140312-person-a1b2.mp4'), data);
    fs.writeFileSync(path.join(clips, '2026-10-10', '140312-person-a1b2.json'), '{"secret":true}');
    fs.writeFileSync(path.join(clips, 'notes.mp4'), 'x');
    fs.writeFileSync(path.join(os.tmpdir(), 'lm-outside.mp4'), 'outside');
    fs.symlinkSync(path.join(os.tmpdir(), 'lm-outside.mp4'), path.join(clips, '2026-10-10', '140313-person-c3d4.mp4'));
    const handler = createAppProtocolHandler({ root: dist, host: 'lawnmower', csp: 'x', mounts: [{ prefix: '/__clips/', getRoot: () => clips, pattern: PATTERN, range: true }] });
    return { handler, data };
  }
  const get = (handler, p, headers = {}, method = 'GET') => handler(new Request(`app://lawnmower${p}`, { method, headers }));

  it('serves a clip, whole and by byte range', async () => {
    const { handler, data } = setup();
    const whole = await get(handler, '/__clips/2026-10-10/140312-person-a1b2.mp4');
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await whole.arrayBuffer()).equals(data)).toBe(true);
    const part = await get(handler, '/__clips/2026-10-10/140312-person-a1b2.mp4', { Range: 'bytes=100-199' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(part.headers.get('content-length')).toBe('100');
    expect(Buffer.from(await part.arrayBuffer()).equals(data.subarray(100, 200))).toBe(true);
    const tail = await get(handler, '/__clips/2026-10-10/140312-person-a1b2.mp4', { Range: 'bytes=-10' });
    expect(tail.headers.get('content-range')).toBe('bytes 990-999/1000');
    const open = await get(handler, '/__clips/2026-10-10/140312-person-a1b2.mp4', { Range: 'bytes=900-' });
    expect((await open.arrayBuffer()).byteLength).toBe(100);
    const bad = await get(handler, '/__clips/2026-10-10/140312-person-a1b2.mp4', { Range: 'bytes=5000-6000' });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */1000');
    const head = await get(handler, '/__clips/2026-10-10/140312-person-a1b2.mp4', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('1000');
  });

  it('refuses anything but our clip and snapshot names, traversal and links', async () => {
    const { handler } = setup();
    for (const p of [
      '/__clips/2026-10-10/140312-person-a1b2.json',
      '/__clips/notes.mp4',
      '/__clips/2026-10-10/%2e%2e/140312-person-a1b2.mp4',
      '/__clips/2026-10-10/..%2F..%2Fetc%2Fpasswd',
      '/__clips/2026-10-10/%2e%2e%2f140312-person-a1b2.mp4', // (bare %2e%2e segments are normalized away by URL parsing)
      '/__clips/2026-10-10/140312-person-A1B2.mp4',
    ]) {
      const r = await get(handler, p);
      expect(r.status, p).toBe(403);
    }
    expect((await get(handler, '/__clips/2026-10-10/140313-person-c3d4.mp4')).status).toBe(404); // a symlink
    expect((await get(handler, '/__clips/2026-10-10/140314-person-zzzz.mp4')).status).toBe(404);
    expect((await get(handler, '/__clips/2026-10-10/140312-person-a1b2.mp4', {}, 'POST')).status).toBe(405);
    expect((await get(handler, '/index.html')).status).toBe(200); // the app itself still works
  });

  it('parseRange, the .tflite type and the dev-server CSP', () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange('bytes=0-4', 10)).toEqual([0, 4]);
    expect(parseRange('bytes=5-100', 10)).toEqual([5, 9]);
    expect(parseRange('bytes=-3', 10)).toEqual([7, 9]);
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,4-5', 10)).toBe('unsatisfiable');
    expect(parseRange('items=0-1', 10)).toBeNull();
    expect(mimeTypeFor('a/efficientdet_lite0_int8.tflite')).toBe('application/octet-stream');
    expect(buildCsp()).toContain("img-src 'self' data: blob:;");
    expect(buildCsp()).not.toContain('app://');
    const dev = buildCsp({ devServerUrl: 'http://127.0.0.1:5221/' });
    expect(dev).toContain("img-src 'self' data: blob: app://lawnmower;");
    expect(dev).toContain("media-src 'self' data: blob: mediastream: app://lawnmower;");
  });
});
