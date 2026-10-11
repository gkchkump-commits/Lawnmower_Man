// Security policy for the renderer: Content-Security-Policy, trusted origins and permission
// decisions. Pure functions so they are unit-tested without Electron.

export const APP_SCHEME = 'app';
export const APP_HOST = 'lawnmower';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const NETWORK_SCHEMES = ['http:', 'https:', 'ws:', 'wss:'];

/**
 * Only a loopback Vite dev server is accepted as VITE_DEV_SERVER_URL.
 * @param {string|undefined} raw @returns {string|null} normalized origin URL (with trailing /)
 */
export function validateDevServerUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!LOOPBACK_HOSTS.includes(u.hostname)) return null;
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
  // the home camera's clips and snapshots are served by app://lawnmower/__clips/ (app-protocol.js
  // mounts): 'self' covers that in production; the dev server page needs it spelled out
  const clips = [];
  if (o.devServerUrl) {
    const u = new URL(o.devServerUrl);
    connect.push(`ws://${u.host}`, `wss://${u.host}`);
    clips.push(APP_ORIGIN);
  }
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    ["img-src 'self' data: blob:", ...clips].join(' '),
    ["media-src 'self' data: blob: mediastream:", ...clips].join(' '),
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
 * May the app's session make this request? The renderer never needs the internet: the voice
 * server and the dev server are loopback, links open in the browser (shell.openExternal) and the
 * Claude CLI is a child process. So network requests (http/https/ws/wss) go to loopback hosts
 * only, whatever context makes them; the CSP is the first line, this also covers a context
 * without one. Other schemes (app:, blob:, data:, devtools:, …) are not network requests.
 * @param {string} url
 */
export function isAllowedRequestUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!NETWORK_SCHEMES.includes(u.protocol)) return true;
  return LOOPBACK_HOSTS.includes(u.hostname);
}

/** URL patterns for session.webRequest.onBeforeRequest: every network request. */
export const NETWORK_URL_PATTERNS = Object.freeze(['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']);

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
 * Permission policy, for our own origin only: microphone capture ('media' with audio), the
 * camera ('media' with video) only while settings.camera.enabled is on (`o.camera`), and
 * sanitized clipboard writes (copy buttons in the chat panel), and full screen for the home
 * camera's page (its live view: F, double-click). Everything else is denied.
 * @param {string} permission
 * @param {{ url?: string, mediaTypes?: string[], mediaType?: string }} details
 * @param {{ devServerUrl?: string|null, camera?: boolean }} [o]
 */
export function decidePermission(permission, details, o = {}) {
  if (!isTrustedUrl(details && details.url, o)) return false;
  if (permission === 'media') {
    const allowed = o.camera === true ? ['audio', 'video'] : ['audio'];
    if (Array.isArray(details.mediaTypes)) {
      return details.mediaTypes.length > 0 && details.mediaTypes.every((t) => allowed.includes(t));
    }
    // Permission *checks* carry a single mediaType ('audio' | 'video' | 'unknown').
    return details.mediaType === undefined || allowed.includes(details.mediaType);
  }
  if (permission === 'fullscreen') {
    try {
      return new URL(String(details.url)).pathname.startsWith('/tapo/');
    } catch {
      return false;
    }
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
