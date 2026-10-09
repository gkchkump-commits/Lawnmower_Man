// app://lawnmower/ request handler: serves the built renderer (dist/) with correct MIME types,
// the CSP header and strict path-traversal protection. Uses the WHATWG Response global
// (Node 18+/Electron), so it is unit-tested without Electron. Electron's fs transparently reads
// from app.asar in packaged builds.

/* global Response */
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.exr': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.task': 'application/octet-stream',
  '.npy': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
});

/** @param {string} file */
export function mimeTypeFor(file) {
  return /** @type {Record<string,string>} */ (MIME_TYPES)[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Map a request pathname to a file under `root`, or null when it escapes the root.
 * Handles percent-encoding (%2e%2e, %2f, %5c), backslashes, NUL bytes and absolute/drive paths.
 * @param {string} root absolute
 * @param {string} pathname URL pathname (still percent-encoded)
 * @param {typeof path} [P]
 * @returns {string|null}
 */
export function resolveSafePath(root, pathname, P = path) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^[a-zA-Z]:/.test(rel)) return null; // drive-letter path smuggled into the URL
  const segments = rel.split('/');
  if (segments.some((s) => s === '..')) return null;
  const full = P.resolve(root, ...segments.filter((s) => s !== '' && s !== '.'));
  const check = P.relative(root, full);
  if (check.startsWith('..') || P.isAbsolute(check)) return null;
  return full;
}

/**
 * @param {{ root: string, host?: string, csp?: string, indexFile?: string, fs?: typeof fsp, log?: (level: string, msg: string) => void }} o
 * @returns {(request: Request) => Promise<Response>}
 */
export function createAppProtocolHandler(o) {
  const root = path.resolve(o.root);
  const host = o.host || 'lawnmower';
  const indexFile = o.indexFile || 'index.html';
  const fs = o.fs || fsp;
  const log = o.log || (() => {});

  /** @param {number} status @param {string} text */
  const plain = (status, text) =>
    new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } });

  return async function handleAppRequest(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return plain(400, 'Bad request');
    }
    if (url.host !== host) return plain(404, 'Not found');
    const method = (request.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return plain(405, 'Method not allowed');

    let pathname = url.pathname;
    if (pathname === '' || pathname.endsWith('/')) pathname += indexFile;
    let file = resolveSafePath(root, pathname);
    if (!file) {
      log('warn', `[app://] blocked path ${url.pathname}`);
      return plain(403, 'Forbidden');
    }

    try {
      let st = await fs.stat(file);
      if (st.isDirectory()) {
        file = path.join(file, indexFile);
        st = await fs.stat(file);
      }
      if (!st.isFile()) return plain(404, 'Not found');
    } catch {
      // Extension-less unknown routes fall back to the SPA entry; missing assets are 404s.
      if (path.extname(file)) return plain(404, 'Not found');
      file = path.join(root, indexFile);
    }

    /** @type {Record<string, string>} */
    const headers = {
      'Content-Type': mimeTypeFor(file),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    };
    // Pages and scripts carry the CSP. A dedicated/module worker (the face tracker) takes its
    // policy from its own script's response, not from the page: without it the worker could
    // fetch anything (MediaPipe's built-in usage metrics to Google, for one). Scripts loaded by
    // the page ignore the header.
    if (o.csp && /\.(html?|m?js)$/i.test(file)) headers['Content-Security-Policy'] = o.csp;
    try {
      if (method === 'HEAD') {
        const st = await fs.stat(file);
        headers['Content-Length'] = String(st.size);
        return new Response(null, { status: 200, headers });
      }
      const data = await fs.readFile(file);
      headers['Content-Length'] = String(data.byteLength);
      return new Response(data, { status: 200, headers });
    } catch (err) {
      log('warn', `[app://] read failed ${file}: ${/** @type {Error} */ (err).message}`);
      return plain(404, 'Not found');
    }
  };
}
