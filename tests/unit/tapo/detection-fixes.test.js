// Regression tests for the detection review (fixer round): the 1 Hz armed detector confirms a
// person on its own, the camera's event state does not survive a disarm or a monitor restart,
// the exit delay does not end in an alert for the user walking out, and an event during a video
// outage gets no clip of old frames.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecurityPipeline } from '../../../src/tapo/worker/pipeline.js';
import { SecurityEngine } from '../../../electron/tapo/security-engine.js';
import { PullPointMonitor } from '../../../electron/tapo/events.js';
import { OnvifError } from '../../../electron/tapo/onvif-soap.js';
import { CredentialStore } from '../../../electron/tapo/credentials.js';
import { TapoService } from '../../../electron/tapo/tapo-service.js';
import { Fmp4Parser } from '../../../electron/tapo/fmp4.js';
import { fakeGraphics, fakeImage, flush, manualClock, room } from '../security/helpers.js';
import { startFakeOnvif } from './helpers/fake-onvif.js';
import { FakeMessageChannelMain, FakeRelay, FakeSidecar, fakeCameraWindow, memorySafeStorage, tempSettings, until } from './helpers/fakes.js';

/** @type {Array<() => Promise<void>>} */
let cleanup = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => {});
  cleanup = [];
});

/** A TapoService that is not connected (the camera's own events play no part). */
async function offlineService({ now, security = {} }) {
  const clips = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-det-'));
  const { store, dir } = tempSettings({
    tapo: { enabled: true, host: '127.0.0.1', username: 'camacct', name: 'camera' },
    security: { armDelaySec: 0, postRollSec: 10, cooldownSec: 60, clipsDir: clips, cameraEvents: false, ...security },
  });
  const credentials = new CredentialStore({ dir: path.join(dir, 'tapo'), safeStorage: memorySafeStorage(), platform: 'linux' });
  const notified = [];
  const service = new TapoService({
    settings: store, credentials, paths: { configDir: path.join(dir, 'tapo'), defaultClipsDir: clips },
    deps: { alerts: { notify: (n) => { notified.push(n); return true; } }, createSidecar: () => new FakeSidecar(), createRelay: () => new FakeRelay(), detector: 'stub' },
    env: {}, now,
  });
  cleanup.push(() => service.stop());
  const events = [];
  service.on('security-event', (e) => events.push(e));
  return { service, store, notified, events };
}

/** The real worker pipeline on the far end of the service's port (what the camera window runs). */
function wireWorker(service, clock) {
  const g = fakeGraphics();
  const toMain = [];
  const workerPort = { onmessage: null, postMessage(m) { toMain.push(m); }, start() {}, close() {} };
  const p = new SecurityPipeline({ postPage: () => {}, createImageBitmap: g.createImageBitmap, OffscreenCanvas: g.OffscreenCanvas, detectorDelayMs: 500, ...clock });
  p.attachPort(workerPort);
  const mainPort = { postMessage(m) { workerPort.onmessage({ data: m }); }, close() {}, on() {}, start() {} };
  service._port = mainPort;
  const pump = () => {
    while (toMain.length) service._onWorkerMessage(mainPort, toMain.shift());
  };
  return { pipeline: p, mainPort, pump, sentToMain: () => toMain };
}

describe('the armed 1 Hz detector confirms a person (worker → validator → service → engine)', () => {
  it('a person in view for 20 s with no camera event starts a person event and notifies', async () => {
    const clock = manualClock();
    const { service, events, notified } = await offlineService({ now: clock.wallNow });
    const w = wireWorker(service, clock);
    const dets = [];
    const orig = service._onWorkerMessage.bind(service);
    service._onWorkerMessage = (port, raw) => {
      if (raw?.t === 'det') dets.push(raw);
      orig(port, raw);
    };
    w.mainPort.postMessage({ t: 'hello', detector: 'stub' });
    w.pump();
    service.engine.onStream('live', clock.wallNow() - 60_000);
    expect(service.arm({ armed: true, immediate: true })).toEqual({ armed: true, arming: false });
    for (let i = 0; i < 20 * 15; i++) {
      w.pipeline.onMain({ t: 'bitmap', image: fakeImage(room({ figure: { x: 0.5, y: 0.5 } })), ts: clock.now() });
      await flush(3);
      w.pump();
      clock.advance(1000 / 15);
      service._apply(service.engine.tick(clock.wallNow()));
    }
    // the worker really ran at the armed rate: ~5 det/s, of which ~1/s carry a detector run
    expect(dets.length).toBeGreaterThan(80);
    expect(dets.filter((d) => d.detected).length).toBeLessThan(dets.length / 3);
    const person = events.find((e) => (e.phase === 'start' || e.phase === 'update') && e.event.kind === 'person');
    expect(person, 'a person event').toBeTruthy();
    expect(person.event.sources).toContain('local-person');
    await until(() => notified.length >= 1, 3000);
    expect(notified[0].event.kind).toBe('person');
  }, 30_000);
});

const MOTION = 'tns1:RuleEngine/CellMotionDetector/Motion';
const PEOPLE = 'tns1:RuleEngine/PeopleDetector/People';
function memClient() {
  const c = {
    authFailed: false, pullPointSupport: true, serviceUrl: () => 'http://127.0.0.1:2020/onvif/service', pull: null,
    getEventProperties: async () => [MOTION, PEOPLE],
    createPullPoint: async () => ({ address: 'http://127.0.0.1:2020/event-0_2020', terminationTime: '' }),
    pullMessages: () => new Promise((resolve, reject) => { c.pull = { resolve, reject }; }),
    renew: async () => ({ terminationTime: '' }),
    call: async () => {},
    deliver: (msgs) => { const p = c.pull; c.pull = null; p?.resolve(msgs); },
  };
  return c;
}
const msg = (topic, name, value, operation = 'Changed') => ({ topic, utcTime: '', operation, data: { [name]: String(value) } });
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('the camera\'s event state does not outlive its subscription', () => {
  let t = 1_760_000_000_000;
  async function startMonitor(engine, out) {
    const c = memClient();
    const m = new PullPointMonitor({ client: /** @type {any} */ (c) });
    m.on('event', (e) => out.push(...engine.onCamera({ ...e, at: t })));
    await m.start();
    await tick();
    return { m, c };
  }

  it('stop() lets every active state fall; a re-arm hours later with nobody there starts nothing', async () => {
    const engine = new SecurityEngine({ settings: { armDelaySec: 0, postRollSec: 3 }, now: () => t });
    const out = [];
    engine.onStream('live', t - 60_000);
    out.push(...engine.arm(true, { immediate: true, at: t }));
    let { m, c } = await startMonitor(engine, out);
    c.deliver([msg(MOTION, 'IsMotion', false, 'Initialized'), msg(PEOPLE, 'IsPeople', false, 'Initialized')]);
    await tick();
    c.deliver([msg(MOTION, 'IsMotion', true), msg(PEOPLE, 'IsPeople', true)]);
    await tick();
    const falls = [];
    m.on('event', (e) => falls.push(e));
    out.push(...engine.arm(false, { at: t }));
    await m.stop();
    expect(falls.map((e) => [e.kind, e.active]).sort()).toEqual([['motion', false], ['person', false]]);
    t += 3 * 3600_000;
    out.length = 0;
    out.push(...engine.arm(true, { immediate: true, at: t }));
    ({ m, c } = await startMonitor(engine, out));
    c.deliver([msg(MOTION, 'IsMotion', false, 'Initialized'), msg(PEOPLE, 'IsPeople', false, 'Initialized')]);
    await tick();
    for (let i = 0; i < 600; i++) {
      t += 200;
      out.push(...engine.onLocal({ at: t, motion: { active: false, score: 0, global: false }, persons: [], detector: 'on' }));
      out.push(...engine.tick(t));
    }
    await m.stop();
    expect(out.filter((a) => a.type === 'event-start')).toEqual([]);
    expect(engine.state.active).toBeNull();
  });

  it('with the local detector down: no "unconfirmed" person alert for nobody after a re-arm', async () => {
    const engine = new SecurityEngine({ settings: { armDelaySec: 0, postRollSec: 3 }, now: () => t });
    const out = [];
    engine.onStream('live', t - 60_000);
    out.push(...engine.arm(true, { immediate: true, at: t }));
    let { m, c } = await startMonitor(engine, out);
    c.deliver([msg(PEOPLE, 'IsPeople', false, 'Initialized')]);
    await tick();
    c.deliver([msg(PEOPLE, 'IsPeople', true)]);
    await tick();
    out.push(...engine.arm(false, { at: t }));
    // even if the monitor's falls were lost, the engine starts clean on arm
    m.removeAllListeners('event');
    await m.stop();
    t += 3600_000;
    out.length = 0;
    out.push(...engine.arm(true, { immediate: true, at: t }));
    ({ m, c } = await startMonitor(engine, out));
    c.deliver([msg(PEOPLE, 'IsPeople', false, 'Initialized')]);
    await tick();
    t += 7000;
    out.push(...engine.tick(t));
    await m.stop();
    expect(out.filter((a) => a.type === 'notify')).toEqual([]);
  });

  it('a person who left while the camera rebooted: the new subscription\'s Initialized=false ends the event', async () => {
    const engine = new SecurityEngine({ settings: { armDelaySec: 0, postRollSec: 3, confirmLocally: false }, now: () => t });
    const out = [];
    engine.onStream('live', t - 60_000);
    out.push(...engine.arm(true, { immediate: true, at: t }));
    const { m, c } = await startMonitor(engine, out);
    c.deliver([msg(PEOPLE, 'IsPeople', false, 'Initialized')]);
    await tick();
    c.deliver([msg(PEOPLE, 'IsPeople', true)]);
    await tick();
    expect(engine.state.active).toMatchObject({ kind: 'person' });
    // the subscription is lost (reboot) and a new one starts on the same monitor: its baseline
    // says nobody is there any more
    c.pull?.reject(new OnvifError('fault', 'The camera reported an error: no such subscription', { codes: ['env:Sender', 'ter:InvalidArgVal'] }));
    await new Promise((r) => setTimeout(r, 2200));
    c.deliver([msg(PEOPLE, 'IsPeople', false, 'Initialized')]);
    await tick();
    for (let i = 0; i < 10; i++) {
      t += 500;
      out.push(...engine.tick(t));
    }
    await m.stop();
    expect(out.some((a) => a.type === 'event-end')).toBe(true);
    expect(engine.state.active).toBeNull();
  }, 10_000);

  it('Initialized=true on a fresh subscription is a baseline: active but ignored until it falls', async () => {
    const engine = new SecurityEngine({ settings: { armDelaySec: 0, postRollSec: 3, confirmLocally: false }, now: () => t });
    const out = [];
    engine.onStream('live', t - 60_000);
    out.push(...engine.arm(true, { immediate: true, at: t }));
    const { m, c } = await startMonitor(engine, out);
    c.deliver([msg(PEOPLE, 'IsPeople', true, 'Initialized')]);
    await tick();
    expect(out.filter((a) => a.type === 'event-start')).toEqual([]);
    c.deliver([msg(PEOPLE, 'IsPeople', false)]);
    await new Promise((r) => setTimeout(r, 2100)); // the 2 s fall hold
    c.deliver([msg(PEOPLE, 'IsPeople', true)]); // a new rising edge is evidence
    await tick();
    await m.stop();
    expect(out.filter((a) => a.type === 'event-start').map((a) => a.event.kind)).toEqual(['person']);
  }, 10_000);

  it('after a disarm while the camera saw the homeowner, the next intruder\'s rising edges boost the detector', () => {
    let now = 1_760_000_000_000;
    const engine = new SecurityEngine({ settings: { armDelaySec: 0, postRollSec: 10 }, now: () => now });
    engine.onStream('live', now - 60_000);
    engine.arm(true, { immediate: true, at: now });
    engine.onCamera({ kind: 'motion', active: true, at: now });
    engine.onCamera({ kind: 'person', active: true, at: now });
    engine.arm(false, { at: now }); // the monitor's falls are lost here on purpose
    now += 2 * 3600_000;
    engine.arm(true, { immediate: true, at: now });
    now += 1000;
    const acts = [...engine.onCamera({ kind: 'motion', active: true, at: now }), ...engine.onCamera({ kind: 'person', active: true, at: now })];
    expect(acts.filter((a) => a.type === 'boost')).toHaveLength(2);
  });
});

describe('the exit delay', () => {
  const T0 = 1_760_000_000_000;

  it('the user walks out past the camera (no falling edge, no det while arming): no alert when watching starts', () => {
    let now = T0;
    const engine = new SecurityEngine({ settings: { armDelaySec: 30, postRollSec: 10 }, now: () => now });
    const out = [];
    engine.onStream('live', now - 60_000);
    out.push(...engine.onLocal({ at: now, motion: { active: false, score: 0, global: false }, persons: [], detector: 'on' }));
    out.push(...engine.arm(true, { at: now }));
    now += 5000;
    out.push(...engine.onCamera({ kind: 'person', active: true, at: now }));
    out.push(...engine.onCamera({ kind: 'motion', active: true, at: now }));
    for (let i = 0; i < 60; i++) {
      now += 500;
      out.push(...engine.tick(now));
    }
    expect(out.filter((a) => a.type === 'notify' || a.type === 'event-start')).toEqual([]);
  });

  it('the same with the worker running during the delay (what the service does now)', () => {
    let now = T0;
    const engine = new SecurityEngine({ settings: { armDelaySec: 30, postRollSec: 10 }, now: () => now });
    const out = [];
    engine.onStream('live', now - 60_000);
    out.push(...engine.arm(true, { at: now }));
    let k = 0;
    for (let i = 0; i < 300; i++) {
      now += 200;
      if (i === 25) {
        out.push(...engine.onCamera({ kind: 'person', active: true, at: now }));
        out.push(...engine.onCamera({ kind: 'motion', active: true, at: now }));
      }
      const userInView = i < 40; // the first 8 s
      out.push(...engine.onLocal({ at: now, motion: { active: userInView, score: userInView ? 0.05 : 0, global: false }, persons: k++ % 5 === 0 ? (userInView ? [{ score: 0.9, box: [0.4, 0.3, 0.15, 0.4] }] : []) : undefined, detector: 'on' }));
      out.push(...engine.tick(now));
    }
    expect(out.filter((a) => a.type === 'notify' || a.type === 'event-start')).toEqual([]);
  });

  it('a real intruder after the delay with the local detector down still gets the unconfirmed alert, 6 s on', () => {
    let now = T0;
    const engine = new SecurityEngine({ settings: { armDelaySec: 30, postRollSec: 10 }, now: () => now });
    const out = [];
    engine.onStream('live', now - 60_000);
    out.push(...engine.arm(true, { at: now }));
    now += 40_000;
    out.push(...engine.tick(now));
    out.push(...engine.onCamera({ kind: 'person', active: true, at: now }));
    const startAt = now;
    for (let i = 0; i < 20; i++) {
      now += 500;
      out.push(...engine.tick(now));
    }
    const n = out.find((a) => a.type === 'notify');
    expect(n?.event).toMatchObject({ kind: 'person', unconfirmed: true });
    expect(n.event.startedAt - startAt).toBeGreaterThanOrEqual(6000);
  });

  it('the service keeps the worker running while arming (armed.on = armed, not watching)', async () => {
    let now = T0;
    const { service } = await offlineService({ now: () => now, security: { armDelaySec: 30 } });
    const win = fakeCameraWindow();
    service._deps.MessageChannelMain = FakeMessageChannelMain;
    service.attachWorker(win);
    await until(() => win.count('hello') === 1);
    expect(service.arm({ armed: true })).toMatchObject({ armed: true, arming: true });
    await until(() => win.received.filter((m) => m.t === 'armed').length >= 2);
    expect(win.received.filter((m) => m.t === 'armed').at(-1)).toMatchObject({ on: true });
    now += 31_000;
    service._apply(service.engine.tick(now));
    expect(service.engine.watching).toBe(true);
  });
});

describe('an event while the video is down', () => {
  it('gets no clip made of the frames from before the outage', async () => {
    const cam = await startFakeOnvif();
    cleanup.push(() => cam.close());
    const clips = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ring-clips-'));
    const { store, dir } = tempSettings({
      tapo: { enabled: true, host: '127.0.0.1', onvifPort: cam.port, rtspPort: 554, username: 'camacct', name: 'camera' },
      security: { armDelaySec: 0, preRollSec: 1, postRollSec: 2, cooldownSec: 10, clipsDir: clips, confirmLocally: false, cameraEvents: false },
    });
    const credentials = new CredentialStore({ dir: path.join(dir, 'tapo'), safeStorage: memorySafeStorage(), platform: 'linux' });
    await credentials.setPassword('se&cret', { host: '127.0.0.1' });
    const relay = new FakeRelay();
    const service = new TapoService({
      settings: store, credentials, paths: { configDir: path.join(dir, 'tapo'), defaultClipsDir: clips },
      deps: { MessageChannelMain: FakeMessageChannelMain, alerts: { notify: () => true }, openPath: async () => '', detector: 'stub', createSidecar: () => new FakeSidecar(), createRelay: () => relay },
      env: { LAWNMOWER_TAPO_ALLOW_LOOPBACK: '1' },
    });
    store.on('change', (n, p) => service.applySettings(n, p));
    cleanup.push(() => service.stop());
    await service.start();
    await until(() => service.status().connection === 'online');
    service.attachWorker(fakeCameraWindow());
    service.arm({ armed: true, immediate: true });
    await until(() => relay.state === 'live');
    await new Promise((r) => setTimeout(r, 2500)); // the ring fills
    const sentBeforeOutage = relay.sent;
    relay._stop();
    relay.state = 'stalled';
    relay.emit('state', 'stalled');
    await new Promise((r) => setTimeout(r, 1000));
    service._apply(service.engine.onCamera({ kind: 'person', active: true, at: Date.now() }));
    await new Promise((r) => setTimeout(r, 600));
    service._apply(service.engine.onCamera({ kind: 'person', active: false, at: Date.now() }));
    await until(() => !service.engine.state.active, 8000);
    await new Promise((r) => setTimeout(r, 500));
    expect(relay.sent).toBe(sentBeforeOutage);
    const day = fs.readdirSync(clips).find((d) => /^\d{4}-/.test(d));
    const mp4s = day ? fs.readdirSync(path.join(clips, day)).filter((f) => f.endsWith('.mp4')) : [];
    const info = mp4s.map((f) => {
      const p = new Fmp4Parser();
      let n = 0;
      p.on('sample', () => n++);
      p.push(fs.readFileSync(path.join(clips, day, f)));
      return { f, samples: n };
    });
    expect(info).toEqual([]);
    // the event itself is listed (without a clip)
    const { events } = await service.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0].clipUrl).toBeUndefined();
  }, 30_000);
});
