import { describe, it, expect, beforeAll, afterAll } from 'vitest';
/* global Request */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  APP_ORIGIN,
  buildCsp,
  decidePermission,
  isSafeExternalUrl,
  isTrustedUrl,
  validateDevServerUrl,
  withCspHeader,
} from '../../../electron/security.js';
import { createAppProtocolHandler, mimeTypeFor, resolveSafePath } from '../../../electron/app-protocol.js';

describe('CSP', () => {
  it('is strict in production', () => {
    const csp = buildCsp();
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("connect-src 'self' http://127.0.0.1:* blob: data:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("media-src 'self' data: blob: mediastream:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/(^|\s)'unsafe-eval'/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
  it('adds the HMR websocket in dev', () => {
    expect(buildCsp({ devServerUrl: 'http://127.0.0.1:5173/' })).toContain('ws://127.0.0.1:5173');
  });
  it('withCspHeader replaces existing CSP headers case-insensitively', () => {
    const h = withCspHeader({ 'content-security-policy': ['x'], 'Content-Type': ['text/html'] }, 'P');
    expect(h).toEqual({ 'Content-Type': ['text/html'], 'Content-Security-Policy': ['P'] });
  });
});

describe('origins and permissions', () => {
  const dev = { devServerUrl: validateDevServerUrl('http://127.0.0.1:5173') };
  it('accepts only loopback dev servers', () => {
    expect(validateDevServerUrl('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/');
    expect(validateDevServerUrl('http://localhost:5173/x')).toBe('http://localhost:5173/');
    expect(validateDevServerUrl('http://evil.example:5173')).toBeNull();
    expect(validateDevServerUrl('file:///etc/passwd')).toBeNull();
    expect(validateDevServerUrl('')).toBeNull();
  });
  it('trusts app://lawnmower and the dev server only', () => {
    expect(isTrustedUrl(`${APP_ORIGIN}/index.html`)).toBe(true);
    expect(isTrustedUrl('app://other/index.html')).toBe(false);
    expect(isTrustedUrl('https://example.com')).toBe(false);
    expect(isTrustedUrl('http://127.0.0.1:5173/index.html', dev)).toBe(true);
    expect(isTrustedUrl('http://127.0.0.1:5174/', dev)).toBe(false);
    expect(isTrustedUrl('not a url')).toBe(false);
  });
  it('allows microphone (audio only) and clipboard writes for our origin, nothing else', () => {
    const url = `${APP_ORIGIN}/index.html`;
    expect(decidePermission('media', { url, mediaTypes: ['audio'] })).toBe(true);
    expect(decidePermission('media', { url, mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(decidePermission('media', { url, mediaTypes: [] })).toBe(false);
    expect(decidePermission('media', { url, mediaType: 'audio' })).toBe(true);
    expect(decidePermission('media', { url, mediaType: 'video' })).toBe(false);
    expect(decidePermission('media', { url: 'https://evil.example', mediaTypes: ['audio'] })).toBe(false);
    expect(decidePermission('clipboard-sanitized-write', { url })).toBe(true);
    for (const p of ['geolocation', 'notifications', 'display-capture', 'clipboard-read', 'openExternal', 'hid']) {
      expect(decidePermission(p, { url })).toBe(false);
    }
  });
  it('opens only web/mail links externally', () => {
    expect(isSafeExternalUrl('https://anthropic.com')).toBe(true);
    expect(isSafeExternalUrl('mailto:a@b.c')).toBe(true);
    expect(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
    expect(isSafeExternalUrl('ms-settings:privacy')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('app:// protocol handler', () => {
  let root;
  let outside;
  let handler;
  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-proto-'));
    root = path.join(base, 'dist');
    outside = path.join(base, 'secret.txt');
    fs.mkdirSync(path.join(root, 'assets', 'avatars', 'reference'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>x</title>');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(root, 'assets', 'avatars', 'reference', 'head.glb'), Buffer.from([0x67, 0x6c, 0x54, 0x46]));
    fs.writeFileSync(path.join(root, 'assets', 'with space.png'), Buffer.from([0x89, 0x50]));
    fs.writeFileSync(outside, 'TOP SECRET');
    handler = createAppProtocolHandler({ root, host: 'lawnmower', csp: "default-src 'self'" });
  });
  afterAll(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

  const get = (url, init) => handler(new Request(url, init));

  it('serves files with MIME types, CSP on HTML and nosniff', async () => {
    const html = await get('app://lawnmower/index.html');
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(await html.text()).toContain('<title>x</title>');
    const js = await get('app://lawnmower/assets/app.js');
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('content-security-policy')).toBeNull();
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    const glb = await get('app://lawnmower/assets/avatars/reference/head.glb');
    expect(glb.headers.get('content-type')).toBe('model/gltf-binary');
    expect(new Uint8Array(await glb.arrayBuffer())).toEqual(new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
    const spaced = await get('app://lawnmower/assets/with%20space.png');
    expect(spaced.status).toBe(200);
  });

  it('serves index.html for / and for extension-less routes; 404 for missing assets', async () => {
    expect((await get('app://lawnmower/')).status).toBe(200);
    expect(await (await get('app://lawnmower/settings')).text()).toContain('<title>');
    expect((await get('app://lawnmower/assets/missing.png')).status).toBe(404);
    expect((await get('app://otherhost/index.html')).status).toBe(404);
  });

  it('blocks path traversal in all its encodings', async () => {
    for (const p of [
      'app://lawnmower/..%2Fsecret.txt',
      'app://lawnmower/..%2F..%2Fsecret.txt',
      'app://lawnmower/assets/..%2F..%2Fsecret.txt',
      'app://lawnmower/..%5Csecret.txt',
      'app://lawnmower/%2e%2e%2fsecret.txt',
      'app://lawnmower/assets%2F..%2F..%2Fsecret.txt',
      'app://lawnmower/C:%5CWindows%5Cwin.ini',
      'app://lawnmower/index.html%00.png',
      'app://lawnmower/%E0%A4%A',
    ]) {
      const r = await get(p);
      expect([400, 403, 404], p).toContain(r.status);
      expect(await r.text(), p).not.toContain('TOP SECRET');
    }
  });

  it('supports HEAD and rejects other methods', async () => {
    const head = await get('app://lawnmower/index.html', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String('<!doctype html><title>x</title>'.length));
    expect((await get('app://lawnmower/index.html', { method: 'POST', body: 'x' })).status).toBe(405);
  });

  it('resolveSafePath and mimeTypeFor', () => {
    expect(resolveSafePath('/r', '/a/b.txt', path.posix)).toBe('/r/a/b.txt');
    expect(resolveSafePath('/r', '/a/../../x', path.posix)).toBeNull();
    expect(resolveSafePath('C:\\r', '/a%5C..%5C..%5Cx', path.win32)).toBeNull();
    expect(resolveSafePath('C:\\r', '/D:/x', path.win32)).toBeNull();
    expect(resolveSafePath('C:\\r', '/assets/x.png', path.win32)).toBe('C:\\r\\assets\\x.png');
    expect(mimeTypeFor('a.wasm')).toBe('application/wasm');
    expect(mimeTypeFor('a.unknown')).toBe('application/octet-stream');
  });
});
