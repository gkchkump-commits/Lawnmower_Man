// The diagnostic report (review: the troubleshooting table sent users to `npm run probe:tapo`,
// which needs the source code and Node). The camera window's "Copy diagnostic report" runs the
// connection test plus the probe's read-only steps in main and copies the result. Pure Node.
//
// Redacted like tools/tapo-probe.mjs: no password (any encoding), no user name, the camera's
// address as <camera>, other IPv4 addresses as <ip>, the serial number cut to 4 characters.
// Nothing moves the camera.

import { redact } from './credentials.js';
import { connectionTest } from './connection-test.js';

/** First 4 characters of a serial number. @param {unknown} s */
export const truncateSerial = (s) => (typeof s === 'string' && s ? `${s.slice(0, 4)}…` : '');

/**
 * Redact a report: password (every encoding), user name, camera address, other IPv4 addresses.
 * @param {any} report @param {{ password: string, username: string, hosts: string[] }} o
 */
export function redactReport(report, o) {
  let s = JSON.stringify(report);
  s = redact(s, [o.password]);
  /** @param {string} v @param {string} by */
  const all = (v, by) => {
    if (!v || v.length < 2) return;
    s = s.split(JSON.stringify(v).slice(1, -1)).join(by);
  };
  for (const h of [...new Set(o.hosts)].filter(Boolean).sort((a, b) => b.length - a.length)) all(h, '<camera>');
  if (o.username && o.username.length >= 3) all(o.username, '<camera account>');
  // any other IPv4 address (the camera may report its own in stream URIs)
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>');
  return JSON.parse(s);
}

/** The path of a URL (or '?' when it is not one). @param {string} u */
export function pathOf(u) {
  try {
    return new URL(u).pathname;
  } catch {
    return '?';
  }
}

/**
 * Run the read-only checks and build the redacted report.
 * @param {{ host: string, onvifPort: number, rtspPort: number, username: string, password: string, allowLoopback?: boolean,
 *   status?: any, appVersion?: string, platform?: string, log?: (level: string, msg: string) => void, now?: () => number,
 *   ptzSettings?: () => any, deps?: any }} o
 */
export async function diagnosticReport(o) {
  const now = o.now || (() => Date.now());
  /** @type {any} */
  const out = { tool: 'lawnmower-diagnostics', version: 1, appVersion: o.appVersion || '', at: new Date(now()).toISOString(), platform: o.platform || `${process.platform}-${process.arch}` };
  let ip = '';
  const report = await connectionTest({
    host: o.host,
    onvifPort: o.onvifPort,
    rtspPort: o.rtspPort,
    username: o.username,
    getPassword: async () => o.password,
    allowLoopback: !!o.allowLoopback,
    ptzSettings: o.ptzSettings,
    log: o.log,
    now: o.now,
    deps: o.deps,
    extra: async (ctx) => {
      ip = ctx.ip;
      const { client } = ctx;
      try {
        const info = await client.getDeviceInformation();
        out.serial = truncateSerial(info.serialNumber);
      } catch (err) {
        out.serial = `(${/** @type {Error} */ (err).message})`;
      }
      out.xaddr = Object.fromEntries(Object.entries(client.xaddr || {}).map(([k, v]) => [k, v ? pathOf(String(v)) : null]));
      out.streamUris = [];
      for (const p of client.profiles || []) {
        try {
          out.streamUris.push({ profile: p.token, uri: await client.getStreamUri(p.token) });
        } catch (err) {
          out.streamUris.push({ profile: p.token, error: /** @type {Error} */ (err).message });
        }
      }
    },
  });
  Object.assign(out, { test: report });
  if (o.status) {
    // what the app sees right now (the connection, video, pan/tilt, events, detector, security)
    const st = JSON.parse(JSON.stringify(o.status));
    if (st.security?.storage) delete st.security.storage.dir; // a path names the Windows user
    out.status = st;
  }
  return redactReport(out, { password: o.password, username: o.username, hosts: [o.host, ip].filter(Boolean) });
}
