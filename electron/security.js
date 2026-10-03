// Security policy for the renderer: Content-Security-Policy, trusted origins and permission
// decisions. Pure functions so they are unit-tested without Electron.

export const APP_SCHEME = 'app';
export const APP_HOST = 'lawnmower';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Only a loopback Vite dev server is accepted as VITE_DEV_SERVER_URL.
 * @param {string|undefined} raw @returns {string|null} normalized origin URL (with trailing /)
 */
export function validateDevServerUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null;
    return `${u.origin}/`;
  } catch {
    return null;
  }
}

/**
 * The renderer CSP. 'self' is app://lawnmower in production and the dev-server origin in dev.
 *  - script-src 'self' (+ 'wasm-unsafe-eval' so WebAssembly decoders can compile; no JS eval),
 *  - connect-src 'self' + http://127.0.0.1:* for the local voice server (+ dev HMR websocket),
 *  - media/img blob: + data: for WebAudio/TTS playback and generated textures,
 *  - worker-src 'self' blob:.
 * @param {{ devServerUrl?: string|null }} [o]
 */
export function buildCsp(o = {}) {
  const connect = ["'self'", 'http://127.0.0.1:*', 'blob:', 'data:'];
  if (o.devServerUrl) {
    const u = new URL(o.devServerUrl);
    connect.push(`ws://${u.host}`, `wss://${u.host}`);
  }
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob: mediastream:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Is `url` one of our own pages (app://lawnmower/… or the dev server)?
 * @param {string|undefined|null} url @param {{ devServerUrl?: string|null }} [o]
 */
export function isTrustedUrl(url, o = {}) {
  if (!url || typeof url !== 'string') return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST) return true;
  if (o.devServerUrl) {
    try {
      return u.origin === new URL(o.devServerUrl).origin;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Permission policy: only microphone capture ('media' with audio only) and sanitized clipboard
 * writes (copy buttons in the chat panel) for our own origin. Everything else is denied.
 * @param {string} permission
 * @param {{ url?: string, mediaTypes?: string[], mediaType?: string }} details
 * @param {{ devServerUrl?: string|null }} [o]
 */
export function decidePermission(permission, details, o = {}) {
  if (!isTrustedUrl(details && details.url, o)) return false;
  if (permission === 'media') {
    if (Array.isArray(details.mediaTypes)) {
      return details.mediaTypes.length > 0 && details.mediaTypes.every((t) => t === 'audio');
    }
    // Permission *checks* carry a single mediaType ('audio' | 'video' | 'unknown').
    return details.mediaType === 'audio' || details.mediaType === undefined;
  }
  return permission === 'clipboard-sanitized-write';
}

/**
 * External links the user clicks in the chat panel open in the default browser — only these
 * schemes, never file: or custom protocols.
 * @param {string} url
 */
export function isSafeExternalUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

/**
 * Replace any CSP header (case-insensitive) in an Electron responseHeaders map.
 * @param {Record<string, string[]|string>|undefined} headers @param {string} csp
 */
export function withCspHeader(headers, csp) {
  /** @type {Record<string, string[]|string>} */
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === 'content-security-policy' || k.toLowerCase() === 'content-security-policy-report-only') continue;
    out[k] = v;
  }
  out['Content-Security-Policy'] = [csp];
  return out;
}
