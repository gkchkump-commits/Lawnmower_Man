// app://lawnmower/ request handler: serves the built renderer (dist/) with correct MIME types,
// the CSP header and strict path-traversal protection. Uses the WHATWG Response global
// (Node 18+/Electron), so it is unit-tested without Electron. Electron's fs transparently reads
// from app.asar in packaged builds.

/* global Response */
import nodeFs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

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
  '.tflite': 'application/octet-stream',
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
 * A single "Range: bytes=…" against a file of `size` bytes → [start, end] (inclusive), null when
 * there is none, or 'unsatisfiable'.
 * @param {string|null} header @param {number} size
 * @returns {[number, number]|null|'unsatisfiable'}
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return header.trim().startsWith('bytes=') ? 'unsatisfiable' : null;
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'unsatisfiable';
  return [start, end];
}

/**
 * Extra folders served under a path prefix (the home camera's clips at /__clips/): only names
 * matching `pattern`, inside the folder (resolveSafePath), GET/HEAD, with Range for video seeking.
 * @typedef {{ prefix: string, getRoot: () => string|null, pattern: RegExp, range?: boolean }} Mount
 */

/**
 * @param {{ root: string, host?: string, csp?: string, indexFile?: string, fs?: typeof fsp, log?: (level: string, msg: string) => void, mounts?: Mount[] }} o
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

  /**
   * @param {Mount} m @param {string} encodedRel still percent-encoded @param {Request} request @param {string} method
   */
  async function serveMount(m, encodedRel, request, method) {
    let rel;
    try {
      rel = decodeURIComponent(encodedRel);
    } catch {
      return plain(400, 'Bad request');
    }
    const root = m.getRoot();
    const file = root && m.pattern.test(rel) ? resolveSafePath(path.resolve(root), encodedRel) : null;
    if (!file) {
      log('warn', `[app://] blocked ${m.prefix}${encodedRel.slice(0, 200)}`);
      return plain(403, 'Forbidden');
    }
    let st;
    try {
      st = await fs.lstat(file);
      if (!st.isFile()) return plain(404, 'Not found');
    } catch {
      return plain(404, 'Not found');
    }
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': mimeTypeFor(file), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };
    if (m.range) headers['Accept-Ranges'] = 'bytes';
    const range = m.range ? parseRange(request.headers.get('range'), st.size) : null;
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${st.size}` } });
    const [start, end] = range || [0, st.size - 1];
    const length = st.size === 0 ? 0 : end - start + 1;
    headers['Content-Length'] = String(length);
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    const status = range ? 206 : 200;
    if (method === 'HEAD' || length === 0) return new Response(null, { status, headers });
    const body = /** @type {any} */ (Readable.toWeb(nodeFs.createReadStream(file, { start, end })));
    return new Response(body, { status, headers });
  }

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

    for (const m of o.mounts || []) {
      if (url.pathname.startsWith(m.prefix)) return serveMount(m, url.pathname.slice(m.prefix.length), request, method);
    }

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
