// The connection test (contract §8.11 TestReport): address → ONVIF port → camera clock → sign-in
// → services → video profiles → pan/tilt (probed, never moved) → camera events → RTSP. Each step
// explains itself in plain words with a hint when it fails. Used by the camera window's "Test"
// button (TapoService.test) and by tools/tapo-probe.mjs, which adds its own steps through
// `extra` while the ONVIF client is still connected.
//
// Lockout safety: one sign-in attempt; after a 401 on stream1 the other RTSP paths are skipped.

import net from 'node:net';

import { resolveLanHost, validateHostSetting } from './host.js';
import { OnvifClient } from './onvif-client.js';
import { OnvifError } from './onvif-soap.js';
import { PtzController, noCaps, PRIVACY_HINT } from './ptz.js';
import { rtspDescribe } from './rtsp-probe.js';

/** Hints for the troubleshooting cases (docs/TAPO.md §13). */
export const HINTS = Object.freeze({
  auth: 'Sign-in failed. Use the Camera Account from the Tapo app (camera › Settings › Advanced Settings › Camera Account), not your TP-Link login. The app does not retry by itself, so the camera does not lock it out.',
  unreachable: 'The camera does not answer. Check its address (a DHCP reservation keeps it fixed), that it is switched on, and that the PC and the camera are on the same network (not guest Wi-Fi).',
  clock: 'The camera clock is off; let the camera reach the internet (NTP) or restart it. The app compensates meanwhile.',
  tapoCare: 'If nothing answers at all: Tapo Care cloud recording and a microSD card together switch RTSP/ONVIF off; turn one of them off.',
  busy: 'The camera allows two live viewers at a time (the Tapo app on a phone counts). Close other viewers.',
  events: 'Turn on motion and person detection in the Tapo app for the camera\'s own events; the app still detects on its own.',
});

/** Can we open a TCP connection? @param {{ host: string, port: number, timeoutMs: number }} o */
export function tcpCheck(o) {
  return new Promise((resolve) => {
    const s = net.connect({ host: o.host, port: o.port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, o.timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
}

/**
 * @typedef {{ id: string, label: string, ok: boolean|null, detail: string, hint?: string }} TestStep
 * @typedef {{ ok: boolean, steps: TestStep[], device?: object, clock?: object, profiles?: object[], ptz?: object, topics?: string[], rtsp?: { codecs: string[] } }} TestReport
 * @typedef {{ client: OnvifClient, ip: string, username: string, password: string, report: TestReport,
 *   step: (id: string, label: string, ok: boolean|null, detail: string, hint?: string) => boolean }} TestContext
 */

const LABELS = { tcp2020: 'ONVIF port', clock: 'Camera clock', auth: 'Sign-in', services: 'Services', profiles: 'Video profiles', ptz: 'Pan and tilt', events: 'Camera events', rtsp: 'Video stream' };
const ALL = ['tcp2020', 'clock', 'auth', 'services', 'profiles', 'ptz', 'events', 'rtsp'];

/**
 * @param {{ host: string, onvifPort: number, rtspPort: number, username: string,
 *   getPassword: (validatedHost: string) => Promise<string|null|undefined>,
 *   allowLoopback?: boolean, ptzSettings?: () => any, log?: (level: string, msg: string) => void, now?: () => number,
 *   deps?: { resolveHost?: typeof resolveLanHost, tcpCheck?: typeof tcpCheck, createClient?: (o: any) => any, rtspDescribe?: typeof rtspDescribe },
 *   extra?: (ctx: TestContext) => Promise<void> }} o
 * @returns {Promise<TestReport>}
 */
export async function connectionTest(o) {
  const deps = o.deps || {};
  const log = o.log || (() => {});
  const now = o.now || (() => Date.now());
  const { host, onvifPort, rtspPort, username } = o;
  /** @type {TestReport} */
  const report = { ok: false, steps: [] };
  /** @param {string} id @param {string} label @param {boolean|null} ok @param {string} detail @param {string} [hint] */
  const step = (id, label, ok, detail, hint) => {
    report.steps.push({ id, label, ok, detail, ...(hint ? { hint } : {}) });
    return !!ok;
  };
  const skipRest = (/** @type {string[]} */ ids) => {
    for (const id of ids) step(id, /** @type {any} */ (LABELS)[id], null, 'Skipped.');
    return report;
  };
  // host
  const v = validateHostSetting(host);
  let ip;
  if (!v.ok || !v.value) {
    step('host', 'Camera address', false, v.ok ? 'No address entered.' : `"${String(host).slice(0, 60)}" ${v.reason}.`, 'Use the IP address shown in the Tapo app (camera › Settings › Device Info) or your router.');
    return skipRest(ALL);
  }
  try {
    ip = (await (deps.resolveHost || resolveLanHost)(v.value, { allowLoopback: !!o.allowLoopback })).ip;
    step('host', 'Camera address', true, ip === v.value ? `${ip} is on your home network.` : `${v.value} is ${ip}.`);
  } catch (err) {
    step('host', 'Camera address', false, /** @type {Error} */ (err).message, 'Use the camera\'s IP address from the Tapo app or your router.');
    return skipRest(ALL);
  }
  // tcp
  const tcp = await (deps.tcpCheck || tcpCheck)({ host: ip, port: onvifPort, timeoutMs: 3000 });
  if (!step('tcp2020', 'ONVIF port', tcp, tcp ? `Port ${onvifPort} answers.` : `Nothing answers on port ${onvifPort}.`, tcp ? undefined : `${HINTS.unreachable} ${HINTS.tapoCare}`)) return skipRest(ALL.slice(1));
  const password = await o.getPassword(v.value);
  if (!username || !password) {
    step('clock', 'Camera clock', null, 'Skipped.');
    step('auth', 'Sign-in', false, !username ? 'Enter the Camera Account user name.' : 'Enter the Camera Account password.');
    return skipRest(ALL.slice(3));
  }
  const client = (deps.createClient || ((/** @type {any} */ x) => new OnvifClient(x)))({ host: ip, port: onvifPort, username, getPassword: async () => password, log, now });
  try {
    // clock
    try {
      await client.syncClock();
      const c = client.clock;
      report.clock = { offsetSec: Math.round((c?.offsetMs || 0) / 1000), ntp: c?.ntp ?? null, warn: !!c?.warn };
      step('clock', 'Camera clock', true, c?.warn ? `The camera clock is ${/** @type {any} */ (report.clock).offsetSec} s off (compensated).` : 'In time.', c?.warn ? HINTS.clock : undefined);
    } catch (err) {
      step('clock', 'Camera clock', false, `The camera did not tell its time (${/** @type {Error} */ (err).message}).`, HINTS.unreachable);
      return skipRest(ALL.slice(2));
    }
    // sign-in (one attempt)
    try {
      const info = await client.getDeviceInformation();
      // never the serial number (it identifies the household's camera, §8.13)
      const d = { manufacturer: info.manufacturer, model: info.model, firmware: info.firmware, hardwareId: info.hardwareId };
      report.device = d;
      const note = /C211/i.test(d.model) ? '' : ' (this app is made for the Tapo C211; other ONVIF cameras may work)';
      step('auth', 'Sign-in', true, `Signed in to ${d.manufacturer} ${d.model}, firmware ${d.firmware}${note}.`);
    } catch (err) {
      const auth = err instanceof OnvifError && err.kind === 'auth';
      step('auth', 'Sign-in', false, auth ? 'The camera refused the user name or password.' : `The camera did not answer the sign-in (${/** @type {Error} */ (err).message}).`, auth ? HINTS.auth : HINTS.unreachable);
      return skipRest(ALL.slice(3));
    }
    // services + profiles
    try {
      await client.connect();
      step('services', 'Services', true, `Media${client.xaddr.ptz ? ', pan/tilt' : ''}${client.xaddr.events ? ', events' : ''}.`);
      report.profiles = client.profiles.map((/** @type {any} */ p) => ({ token: p.token, name: p.name, encoding: p.encoding, width: p.width, height: p.height, fps: p.fps }));
      const main = client.profiles[0];
      step('profiles', 'Video profiles', client.profiles.length > 0, main ? client.profiles.map((/** @type {any} */ p) => `${p.encoding} ${p.width}×${p.height}`).join(', ') : 'No video profile.', main && main.encoding === 'H265' ? 'The main stream is H.265; if this PC cannot decode it, use stream2 or a lower video quality in the Tapo app.' : undefined);
    } catch (err) {
      step('services', 'Services', false, /** @type {Error} */ (err).message);
      return skipRest(ALL.slice(4));
    }
    // pan/tilt (probed, not moved)
    const ptz = new PtzController({ client, getSettings: o.ptzSettings || (() => ({})), log, now });
    const caps = await ptz.probe().catch(() => noCaps());
    report.ptz = caps;
    step('ptz', 'Pan and tilt', caps.available, caps.available ? `Works (${caps.mode} moves${caps.canStatus ? ', reports its position' : ''}).` : ptz.privacySuspected ? PRIVACY_HINT : 'Not offered over ONVIF by this camera or firmware.', caps.available ? undefined : ptz.privacySuspected ? undefined : 'Press “Copy diagnostic report” below and send it, so support for your firmware can be checked.');
    await ptz.dispose().catch(() => {});
    // camera events
    try {
      const topics = client.xaddr.events ? await client.getEventProperties() : [];
      report.topics = topics;
      const motion = topics.some((/** @type {string} */ x) => /Motion/i.test(x));
      const people = topics.some((/** @type {string} */ x) => /People|Person/i.test(x));
      step('events', 'Camera events', client.xaddr.events ? true : null, client.xaddr.events ? (motion && people ? 'Motion and person events.' : `${topics.length} topics; ${motion ? '' : 'no motion '}${people ? '' : 'no person '}events.`) : 'Not offered.', motion && people ? undefined : HINTS.events);
    } catch (err) {
      step('events', 'Camera events', false, /** @type {Error} */ (err).message, HINTS.events);
    }
    // RTSP (stream2 only when stream1 did not refuse the sign-in)
    const describe = deps.rtspDescribe || rtspDescribe;
    const s1 = await describe({ ip, port: rtspPort, path: '/stream1', username, password });
    const s2 = s1.status === 401 ? null : await describe({ ip, port: rtspPort, path: '/stream2', username, password });
    report.rtsp = { codecs: s1.ok ? s1.codecs : s2?.codecs || [] };
    const okRtsp = s1.ok || !!s2?.ok;
    step('rtsp', 'Video stream', okRtsp, okRtsp ? `stream1: ${s1.ok ? s1.codecs.join(', ') : s1.error}; stream2: ${s2?.ok ? s2.codecs.join(', ') : s2?.error || 'skipped'}.` : s1.error || 'No video.', okRtsp ? undefined : s1.status === 401 ? HINTS.auth : s1.status === 453 ? HINTS.busy : `${HINTS.unreachable} ${HINTS.tapoCare}`);
    if (o.extra) await o.extra({ client, ip, username, password, report, step });
    report.ok = report.steps.every((x) => x.ok !== false);
  } finally {
    client.close();
  }
  return report;
}
