// Main's side of the calibration's gated picture protocol (tapo-service.js): every relayed video
// chunk carries main's own monotonic receive time, shift-ref / shift-measure carry `after` (when
// the last move ended, same clock), and answers that do not show the gate — an older camera
// window's worker, or a picture from before the move — are never passed on as usable.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStore } from '../../../electron/tapo/credentials.js';
import { TapoService } from '../../../electron/tapo/tapo-service.js';
import { FakeRelay, FakeSidecar, memorySafeStorage, tempSettings } from './helpers/fakes.js';

/** @type {Array<() => Promise<void>>} */
let cleanup = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => {});
  cleanup = [];
});

async function service(o = {}) {
  const clips = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-calproto-'));
  const { store, dir } = tempSettings({ tapo: { enabled: true, host: '127.0.0.1', username: 'camacct', name: 'camera' }, security: { clipsDir: clips } });
  const credentials = new CredentialStore({ dir: path.join(dir, 'tapo'), safeStorage: memorySafeStorage(), platform: 'linux' });
  const logs = [];
  const s = new TapoService({
    settings: store, credentials, paths: { configDir: path.join(dir, 'tapo'), defaultClipsDir: clips },
    deps: { alerts: { notify: () => true }, createSidecar: () => new FakeSidecar(), createRelay: () => new FakeRelay(), detector: 'stub' },
    env: {}, log: (level, msg) => logs.push(msg), ...o,
  });
  cleanup.push(() => s.stop());
  s.relay.state = 'live';
  const sent = [];
  const port = { postMessage: (m) => sent.push(m), close() {} };
  s._port = port;
  /** answer main's latest request of type t with the worker message `reply(request)` */
  const answer = async (t, reply) => {
    for (let i = 0; i < 100 && !sent.some((m) => m.t === t); i++) await new Promise((r) => setTimeout(r, 20));
    const req = sent.filter((m) => m.t === t).at(-1);
    s._onWorkerMessage(port, { ...reply(req), id: req.id });
    return req;
  };
  return { s, sent, port, answer, logs };
}

describe('video chunks carry main\'s receive time', () => {
  it('the relay\'s rx stamp goes to the worker with the chunk; a sample without one is stamped by main', async () => {
    let mono = 5000;
    const { s, sent } = await service({ mono: () => mono });
    s._onSample({ gen: 1, key: true, pts: 0, duration: 6000, data: Buffer.alloc(8), rx: 4321.25 });
    mono = 6000;
    s._onSample({ gen: 1, key: false, pts: 6000, duration: 6000, data: Buffer.alloc(8) });
    expect(sent.filter((m) => m.t === 'chunk').map((m) => m.rx)).toEqual([4321.25, 6000]);
  });
});

describe('shift-ref: only a gated reference counts', () => {
  it('a gated answer with a picture from after the move is a reference', async () => {
    const { s, answer } = await service();
    const p = s._shiftRef(1000);
    const req = await answer('shift-ref', () => ({ t: 'shift-ref-ok', gated: true, ok: true, still: false, at: 1040 }));
    expect(req.after).toBe(1000);
    expect(await p).toEqual({ ok: true, at: 1040, still: false });
  });

  it('its contrast and how far it is from the frame the last measurement ended on are passed on (a malformed one is not)', async () => {
    for (const [vsLast, want] of [[{ at: 900, dx: 0.001, dy: -0.002, score: 0.97 }, { at: 900, dx: 0.001, dy: -0.002, score: 0.97 }], [{ at: 'x', dx: 0, dy: 0, score: 1 }, undefined]]) {
      const { s, answer } = await service();
      const p = s._shiftRef(1000);
      await answer('shift-ref', () => ({ t: 'shift-ref-ok', gated: true, ok: true, still: true, at: 1040, contrast: 22.1, vsLast }));
      const r = await p;
      expect(r).toMatchObject({ ok: true, at: 1040, still: true, contrast: 22.1 });
      expect(r.vsLast).toEqual(want);
    }
  });

  it('an older worker\'s bare answer, the worker\'s "none" and a picture from before the move are no reference', async () => {
    for (const reply of [
      { t: 'shift-ref-ok' }, // an older camera window: says nothing about how current its picture is
      { t: 'shift-ref-ok', gated: true, ok: false, still: false },
      { t: 'shift-ref-ok', gated: true, ok: true, still: true, at: 999 }, // reached main before `after`
      { t: 'shift-ref-ok', gated: true, ok: true, still: true }, // no stamp
    ]) {
      const { s, answer } = await service();
      const p = s._shiftRef(1000);
      await answer('shift-ref', () => reply);
      const r = await p;
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(reply.gated ? /no picture arrived after the camera's last move/ : /out of date/);
    }
  });
});

describe('shift-measure: an answer without the gate is not measurable', () => {
  // (updated on purpose: a gated answer now also says whether the picture settled and when it
  // first changed, which main passes on)
  it('a gated answer is passed on with its stamps', async () => {
    const { s, answer } = await service();
    const p = s._shiftMeasure(6000, true, 2000);
    const req = await answer('shift-measure', () => ({ t: 'shift', dx: 0.25, dy: 0, score: 0.9, settledMs: 800, gated: true, at: 2100, refAt: 1040, frames: 5, moved: true, settled: true, firstAt: 2010, changedAt: 2050, contrast: 31.5 }));
    expect(req).toMatchObject({ timeoutMs: 6000, expectMove: true, after: 2000 });
    expect(await p).toEqual({ dx: 0.25, dy: 0, score: 0.9, settledMs: 800, at: 2100, refAt: 1040, frames: 5, moved: true, settled: true, firstAt: 2010, changedAt: 2050, contrast: 31.5 });
  });

  it('a gated answer that does not say the picture settled (a camera window from before `settled`) reads as not settled', async () => {
    const { s, answer } = await service();
    const p = s._shiftMeasure(6000, true, 2000);
    await answer('shift-measure', () => ({ t: 'shift', dx: 0.25, dy: 0, score: 0.9, settledMs: 800, gated: true, at: 2100, refAt: 1040, frames: 5, moved: true }));
    const r = await p;
    expect(r.settled).toBe(false); // and the wizard does not use a measurement that did not settle
    expect(r.changedAt).toBeUndefined();
  });

  it('a cancelled calibration drops its pending request at once (no 30 s wait for a stalled worker)', async () => {
    const { s, sent } = await service();
    const ac = new AbortController();
    const p = s._shiftMeasure(6000, true, 2000, ac.signal);
    for (let i = 0; i < 50 && !sent.some((m) => m.t === 'shift-measure'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(s._pending.size).toBe(1);
    const t0 = Date.now();
    ac.abort();
    expect(await p).toEqual({ dx: 0, dy: 0, score: 0, settledMs: 0 });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(s._pending.size).toBe(0);
    // the late answer is dropped
    const req = sent.find((m) => m.t === 'shift-measure');
    s._onWorkerMessage(s._port, { t: 'shift', id: req.id, dx: 0.25, dy: 0, score: 0.9, settledMs: 800, gated: true, at: 2100, refAt: 1040, frames: 5, moved: true, settled: true });
    const r = s._shiftRef(1000, ac.signal);
    expect((await r).ok).toBe(false); // an aborted signal: no request at all
  });

  it('an older worker\'s answer (no gate: its picture may be from before the move) has score 0', async () => {
    const { s, answer, logs } = await service();
    const p = s._shiftMeasure(6000, true, 2000);
    await answer('shift-measure', () => ({ t: 'shift', dx: -0.25, dy: 0, score: 0.93, settledMs: 876 }));
    expect(await p).toEqual({ dx: -0.25, dy: 0, score: 0, settledMs: 876 });
    expect(logs.some((l) => /does not say how current its picture is/.test(l))).toBe(true);
  });
});

describe('the wizard through the service', () => {
  it('quitting mid-calibration puts the camera back where it started (within the quit bound)', async () => {
    const { s } = await service();
    const moves = [];
    let pos = { x: 0, y: 0 };
    s.ptzCtl = /** @type {any} */ ({ caps: { available: true }, privacySuspected: false, moving: false, settleUntil: 0, idleMs: Infinity,
      command: async () => ({ ok: true }), readPosition: async () => ({ ...pos }), stopAll: async () => {}, dispose: async () => {},
      rawMove: async (x, y) => { moves.push([x, y]); pos = { x: pos.x + x, y: pos.y + y }; return { settledMs: 900, measured: true, moved: true, travel: { x, y } }; } });
    s._conn = { state: 'online', detail: '' };
    // a worker that answers the reference, then never the measurement: the camera is turned when the app quits
    s._post = (m) => {
      if (m.t === 'shift-ref') setTimeout(() => s._onWorkerMessage(s._port, { t: 'shift-ref-ok', id: m.id, gated: true, ok: true, still: true, at: m.after + 1 }), 5);
    };
    s.calibration.start();
    for (let i = 0; i < 300 && !moves.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(moves).toEqual([[0.2, 0]]);
    const t0 = Date.now();
    await s.stop();
    expect(Date.now() - t0).toBeLessThan(4500);
    expect(pos.x).toBeCloseTo(0);
    expect(s.calibration.running).toBe(false);
  }, 15_000);

  it('while it runs, other camera moves are refused (the D-pad, keys, click-to-center, Claude\'s camera_look), then allowed again', async () => {
    const { s } = await service();
    const commands = [];
    const moves = [];
    s.ptzCtl = /** @type {any} */ ({ caps: { available: true }, privacySuspected: false, moving: false, settleUntil: 0,
      command: async (c) => { commands.push(c); return { ok: true, moved: true }; },
      rawMove: async (x, y) => { moves.push([x, y]); return { settledMs: 900, measured: true, moved: true, travel: { x, y } }; },
      readPosition: async () => ({ x: 0, y: 0 }), stopAll: async () => {} });
    s._conn = { state: 'online', detail: '' };
    s._shiftRefTimeoutMs = 60_000; // a worker that does not answer: the calibration waits
    s.calibration.start();
    expect(s.calibration.running).toBe(true);
    for (const cmd of [{ op: 'nudge', dir: 'left', amount: 'small' }, { op: 'center', u: 0.7, v: 0.5 }, { op: 'hold', dir: 'up' }, { op: 'preset-name', name: 'Door' }, { op: 'home' }, { op: 'stop' }]) {
      const r = await s.ptz(/** @type {any} */ (cmd));
      expect(r).toMatchObject({ ok: false, code: 'busy' });
      expect(r.error).toMatch(/calibrating/);
    }
    expect((await s.ptz({ op: 'heartbeat' })).ok).toBe(true); // (ends nothing: no hold can start)
    // Claude's camera_look goes through the same door
    const look = await s._mcpAdapter().ptz({ op: 'nudge', dir: 'right', amount: 'medium' });
    expect(look).toMatchObject({ ok: false, code: 'busy' });
    expect(commands).toEqual([{ op: 'heartbeat' }]);
    s.calibration.cancel();
    for (let i = 0; i < 100 && s.calibration.running; i++) await new Promise((r) => setTimeout(r, 10));
    expect(s.calibration.running).toBe(false);
    expect((await s.ptz({ op: 'nudge', dir: 'left', amount: 'small' })).ok).toBe(true);
  });

  it('with an older camera window (bare answers) it never measures: it asks', async () => {
    const { s, sent, port } = await service();
    // a fake PTZ that reports its moves, and an old worker that answers everything at once
    s.ptzCtl = /** @type {any} */ ({ caps: { available: true }, privacySuspected: false, moving: false, settleUntil: 0,
      rawMove: async () => ({ settledMs: 900, measured: true, moved: true }), stopAll: async () => {} });
    s._conn = { state: 'online', detail: '' };
    s._shiftRefTimeoutMs = 2000;
    const old = setInterval(() => {
      for (const m of sent.splice(0)) {
        if (m.t === 'shift-ref' && m.id) s._onWorkerMessage(port, { t: 'shift-ref-ok', id: m.id });
        if (m.t === 'shift-measure') s._onWorkerMessage(port, { t: 'shift', id: m.id, dx: -0.25, dy: 0, score: 0.93, settledMs: 876 });
      }
    }, 10);
    cleanup.push(async () => clearInterval(old));
    s.calibration._delay = async () => {};
    s.calibration.start();
    for (let i = 0; i < 300 && s.calibration.state.step !== 'ask'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(s.calibration.state.step).toBe('ask');
    s.calibration.cancel();
  }, 15_000);
});
