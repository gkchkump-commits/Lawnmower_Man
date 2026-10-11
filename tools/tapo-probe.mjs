#!/usr/bin/env node
// The "send me this report" tool for a real Tapo camera (contract §8.12, docs/TAPO.md):
//
//   npm run probe:tapo -- --host 192.168.1.50 --user camacct [--move] [--json]
//
// It runs the app's connection test (address, ONVIF port, clock, one sign-in, services,
// profiles, pan/tilt capabilities, camera events, RTSP) and then, still signed in:
//   - GetStreamUri for every profile,
//   - an RTSP DESCRIBE of /stream1, /stream2 and /stream8 (stopped after a refused sign-in),
//   - one PullPoint subscription: subscribe, one pull, unsubscribe,
//   - with --move only: RelativeMove(+0.2, 0), back with RelativeMove(-0.2, 0), then Stop —
//     each move watched by the app's motor watchdog, and Stop on Ctrl+C.
// The password comes from TAPO_PASSWORD or a hidden prompt and is never printed. The report is
// redacted: no password, no user name, the camera's address as <camera>, the serial number cut
// to its first 4 characters. Nothing is sent anywhere; the user copies the report themselves.
//
// Exit code: 0 all good, 1 something failed (see the report), 2 bad usage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { connectionTest } from '../electron/tapo/connection-test.js';
import { PtzController } from '../electron/tapo/ptz.js';
import { rtspDescribe } from '../electron/tapo/rtsp-probe.js';
import { redact } from '../electron/tapo/credentials.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `Usage: npm run probe:tapo -- --host <camera IP> --user <Camera Account> [--move] [--json]
         [--onvif-port 2020] [--rtsp-port 554]
The password is read from TAPO_PASSWORD or asked for (hidden).
--move  pans the camera right by a small step and back (watch it), then sends Stop.`;

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ host: string, user: string, move: boolean, json: boolean, onvifPort: number, rtspPort: number, help: boolean }} */
  const o = { host: '', user: '', move: false, json: false, onvifPort: 2020, rtspPort: 554, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    const port = () => {
      const n = Number(val());
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${a} must be a port number`);
      return n;
    };
    if (a === '--host') o.host = val();
    else if (a === '--user') o.user = val();
    else if (a === '--move') o.move = true;
    else if (a === '--json') o.json = true;
    else if (a === '--onvif-port') o.onvifPort = port();
    else if (a === '--rtsp-port') o.rtspPort = port();
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.help && (!o.host || !o.user)) throw new Error('--host and --user are required');
  return o;
}

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
  for (const h of [...new Set(o.hosts)].sort((a, b) => b.length - a.length)) all(h, '<camera>');
  if (o.username.length >= 3) all(o.username, '<camera account>');
  // any other IPv4 address (the camera may report its own in stream URIs)
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>');
  return JSON.parse(s);
}

/** The path of a URL (or '?' when it is not one). @param {string} u */
function pathOf(u) {
  try {
    return new URL(u).pathname;
  } catch {
    return '?';
  }
}

/** @param {Promise<any>} p @param {number} ms @param {string} what */
function within(p, ms, what) {
  /** @type {any} */
  let t;
  return Promise.race([p, new Promise((_r, rej) => { t = setTimeout(() => rej(new Error(`${what} took longer than ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t));
}

/**
 * Run the probe. `onPtz` receives the PTZ controller while a move may be in progress (Ctrl+C).
 * @param {{ host: string, user: string, password: string, onvifPort?: number, rtspPort?: number, move?: boolean,
 *   allowLoopback?: boolean, log?: (level: string, msg: string) => void, onPtz?: (ptz: PtzController|null) => void }} o
 */
export async function runProbe(o) {
  const log = o.log || (() => {});
  const onvifPort = o.onvifPort ?? 2020;
  const rtspPort = o.rtspPort ?? 554;
  let appVersion = '';
  try {
    appVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '';
  } catch { /* not in the repo */ }
  /** @type {any} */
  const out = { tool: 'tapo-probe', version: 1, appVersion, at: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version, options: { onvifPort, rtspPort, move: !!o.move } };
  let ip = '';
  const report = await connectionTest({
    host: o.host,
    onvifPort,
    rtspPort,
    username: o.user,
    getPassword: async () => o.password,
    allowLoopback: !!o.allowLoopback,
    log,
    extra: async (ctx) => {
      ip = ctx.ip;
      const { client } = ctx;
      // the serial number, cut short (what model batch, not which camera)
      try {
        const info = await client.getDeviceInformation();
        out.serial = truncateSerial(info.serialNumber);
      } catch (err) {
        out.serial = `(${/** @type {Error} */ (err).message})`;
      }
      out.xaddr = Object.fromEntries(Object.entries(client.xaddr || {}).map(([k, v]) => [k, v ? pathOf(String(v)) : null]));
      // stream URIs
      out.streamUris = [];
      for (const p of client.profiles) {
        try {
          out.streamUris.push({ profile: p.token, uri: await client.getStreamUri(p.token) });
        } catch (err) {
          out.streamUris.push({ profile: p.token, error: /** @type {Error} */ (err).message });
        }
      }
      // RTSP paths (stop at a refused sign-in: lockouts)
      out.rtspPaths = [];
      for (const p of ['/stream1', '/stream2', '/stream8']) {
        const r = await rtspDescribe({ ip: ctx.ip, port: rtspPort, path: p, username: ctx.username, password: ctx.password });
        out.rtspPaths.push({ path: p, ok: r.ok, status: r.status, codecs: r.codecs, fmtp: r.fmtp, ...(r.error ? { error: r.error } : {}) });
        if (r.status === 401) {
          out.rtspPaths.push({ note: 'The camera refused the RTSP sign-in; the other paths were not tried.' });
          break;
        }
      }
      // one PullPoint round
      out.pullPoint = { subscribed: false };
      if (client.xaddr?.events) {
        try {
          const sub = await within(client.createPullPoint(), 8000, 'Subscribing');
          out.pullPoint = { subscribed: true, terminationTime: sub.terminationTime, addressPath: pathOf(sub.address) };
          try {
            const msgs = await within(client.pullMessages(sub.address, 2, 10, { socketTimeoutMs: 8000 }), 9000, 'Pulling');
            out.pullPoint.pulled = msgs.length;
            out.pullPoint.messages = msgs.slice(0, 10);
          } catch (err) {
            out.pullPoint.pullError = /** @type {Error} */ (err).message;
          }
          try {
            await client.unsubscribe(sub.address, { timeoutMs: 3000 });
            out.pullPoint.unsubscribed = true;
          } catch (err) {
            out.pullPoint.unsubscribeError = /** @type {Error} */ (err).message;
          }
        } catch (err) {
          out.pullPoint.error = /** @type {Error} */ (err).message;
        }
      }
      // the optional move pair
      if (o.move) out.move = await movePair(client, log, o.onPtz);
    },
  });
  Object.assign(out, report, { ok: report.ok && (!out.move || out.move.ok !== false) });
  return redactReport(out, { password: o.password, username: o.user, hosts: [o.host, ip].filter(Boolean) });
}

/**
 * RelativeMove(+0.2, 0), back with (-0.2, 0), then Stop. The PTZ controller's watchdog stops a
 * move that does not end by itself.
 * @param {any} client @param {(level: string, msg: string) => void} log @param {((p: PtzController|null) => void)|undefined} onPtz
 */
async function movePair(client, log, onPtz) {
  /** @type {any} */
  const m = { ok: false, steps: [] };
  const ptz = new PtzController({ client, getSettings: () => ({ ptz: 'auto' }), log });
  onPtz?.(ptz);
  try {
    const caps = await ptz.probe();
    if (!caps.available) {
      m.error = 'Pan and tilt are not available, so nothing was moved.';
      return m;
    }
    if (caps.mode !== 'relative') {
      m.error = `The camera offers ${caps.mode} moves only; the probe moves with RelativeMove, so nothing was moved.`;
      return m;
    }
    const status = async () => (caps.canStatus ? client.getStatus().catch((/** @type {Error} */ e) => ({ error: e.message })) : null);
    for (const x of [0.2, -0.2]) {
      const before = await status();
      const t0 = Date.now();
      const r = await ptz.rawMove(x, 0, { maxWaitMs: 8000 });
      m.steps.push({ x, y: 0, settledMs: r.settledMs, wallMs: Date.now() - t0, before, after: await status() });
    }
    m.ok = true;
  } catch (err) {
    m.error = /** @type {Error} */ (err).message;
  } finally {
    await ptz.stopAll('probe done', { force: true }).catch((err) => { m.stopError = err.message; });
    m.stopped = !m.stopError;
    await ptz.dispose().catch(() => {});
    onPtz?.(null);
  }
  return m;
}

/** Read a password without echo (a TTY), or TAPO_PASSWORD. */
async function readPassword() {
  if (process.env.TAPO_PASSWORD) return process.env.TAPO_PASSWORD;
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error('Set TAPO_PASSWORD, or run this in a terminal to type the password.');
  process.stderr.write('Camera Account password (not shown): ');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let pw = '';
    /** @param {string} chunk */
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          done();
          process.stderr.write('\n');
          resolve(pw);
          return;
        }
        if (ch === '\u0003') {
          done();
          process.stderr.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') pw = pw.slice(0, -1);
        else if (ch >= ' ') pw += ch;
      }
    };
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

/** Plain-text summary for a person. @param {any} r */
function summary(r) {
  const mark = (/** @type {boolean|null} */ ok) => (ok === true ? 'ok  ' : ok === false ? 'FAIL' : '--  ');
  const lines = [`Tapo probe ${r.at}${r.device ? ` · ${r.device.manufacturer} ${r.device.model} · firmware ${r.device.firmware}` : ''}`, ''];
  for (const s of r.steps) {
    lines.push(`${mark(s.ok)} ${s.label}: ${s.detail}`);
    if (s.hint) lines.push(`      ${s.hint}`);
  }
  for (const p of r.rtspPaths || []) if (p.path) lines.push(`RTSP ${p.path}: ${p.ok ? p.codecs.join(', ') : p.error || p.status}`);
  if (r.pullPoint) lines.push(`Camera events: ${r.pullPoint.subscribed ? `subscribed, ${r.pullPoint.pulled ?? 0} message(s), ${r.pullPoint.unsubscribed ? 'unsubscribed' : 'not unsubscribed'}` : r.pullPoint.error || 'not offered'}`);
  if (r.move) lines.push(`Move test: ${r.move.ok ? r.move.steps.map((s) => `${s.x > 0 ? 'right' : 'left'} ${s.settledMs} ms`).join(', ') : r.move.error}${r.move.stopped ? ' · stopped' : ' · STOP FAILED'}`);
  lines.push('', r.ok ? 'Everything works.' : 'Something did not work; see above.', 'Run with --json for the full report to send (it has no password, user name, address or serial number).');
  return lines.join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${/** @type {Error} */ (err).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  let password;
  try {
    password = await readPassword();
  } catch (err) {
    console.error(/** @type {Error} */ (err).message);
    process.exit(2);
  }
  /** @type {PtzController|null} */
  let ptz = null;
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error('\nStopping the camera…');
    Promise.resolve(ptz?.stopAll('probe interrupted', { force: true })).catch(() => {}).finally(() => process.exit(130));
  });
  const verbose = !!process.env.TAPO_PROBE_DEBUG;
  const report = await runProbe({
    host: args.host,
    user: args.user,
    password,
    onvifPort: args.onvifPort,
    rtspPort: args.rtspPort,
    move: args.move,
    allowLoopback: process.env.LAWNMOWER_TAPO_ALLOW_LOOPBACK === '1',
    log: (level, msg) => { if (verbose) console.error(redact(`${level} ${msg}`, [password])); },
    onPtz: (p) => { ptz = p; },
  });
  console.log(args.json ? JSON.stringify(report, null, 2) : summary(report));
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`tapo-probe: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}
