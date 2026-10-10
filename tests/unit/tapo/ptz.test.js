import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PtzController, PRIVACY_HINT, PRIVACY_MS, PRIVACY_RECHECK_MS, centerTranslation, matchPresetName, normalizePresetName, nudgeTranslation,
} from '../../../electron/tapo/ptz.js';
import { OnvifError } from '../../../electron/tapo/onvif-soap.js';

const DEFAULTS = {
  ptz: 'auto', invertPan: false, invertTilt: false, stepSmall: 0.15, stepMedium: 0.35, stepLarge: 0.75,
  viewUnitsX: 0.5, viewUnitsY: 1.4, minStep: 0.05, holdSpeed: 0.5, msPerUnit: 6000, homePreset: '', localPresets: [],
};

/**
 * A fake OnvifClient: records every call with the (fake) time; GetStatus reports MOVING for
 * `movingFor` ms after a move unless stopped; failures by op.
 */
function fakeClient(o = {}) {
  const c = {
    authFailed: false,
    profile: { token: 'profile_1', ptzConfigToken: 'PTZConfiguration_1', relativeSpace: 'rel', continuousSpace: 'vel', ranges: null },
    calls: /** @type {Array<{ op: string, args: any[], t: number }>} */ ([]),
    fail: /** @type {Record<string, any>} */ ({}),
    movingFor: o.movingFor ?? 600,
    moveUntil: 0,
    stopIgnored: false,
    statusWorks: o.statusWorks ?? true,
    spaces: o.spaces ?? { absolute: [{ uri: 'abs', ranges: null }], relative: [{ uri: 'rel', ranges: { x: { min: -1, max: 1 }, y: { min: -1, max: 1 } } }], continuous: [{ uri: 'vel', ranges: null }] },
    position: { x: 0, y: 0 },
    presets: [{ token: '1', name: 'Door', position: { x: 0.3, y: -0.2 } }, { token: '2', name: 'Window', position: null }],
    /** resolves the current relativeMove when set (to hold a request "in flight") */
    gate: /** @type {Promise<void>|null} */ (null),
    serviceUrl: () => 'http://127.0.0.1:2020/onvif/service',
  };
  const rec = async (op, ...args) => {
    c.calls.push({ op, args, t: Date.now() });
    const f = c.fail[op];
    if (f) throw typeof f === 'function' ? f(args) : f;
  };
  const moved = () => { c.moveUntil = Date.now() + c.movingFor; };
  Object.assign(c, {
    getNodes: async () => { await rec('GetNodes'); return [{ token: 'n', spaces: c.spaces, maxPresets: 8, homeSupported: false }]; },
    getConfigurationOptions: async (t) => { await rec('GetConfigurationOptions', t); return { spaces: { absolute: [], relative: [], continuous: [] } }; },
    getStatus: async () => {
      await rec('GetStatus');
      if (!c.statusWorks) throw new OnvifError('fault', 'GetStatus not supported', { status: 400 });
      return { position: { ...c.position }, moveStatus: Date.now() < c.moveUntil ? 'MOVING' : 'IDLE' };
    },
    relativeMove: async (x, y) => { await rec('RelativeMove', x, y); if (c.gate) await c.gate; moved(); },
    continuousMove: async (x, y, t) => { await rec('ContinuousMove', x, y, t); c.moveUntil = x === 0 && y === 0 ? 0 : Date.now() + 1e9; },
    zeroVelocity: async () => { await rec('ZeroVelocity'); c.moveUntil = 0; },
    stop: async (opt = {}) => { await rec(opt.minimal ? 'StopMinimal' : 'Stop'); if (!c.stopIgnored) c.moveUntil = 0; },
    absoluteMove: async (x, y) => { await rec('AbsoluteMove', x, y); moved(); },
    getPresets: async () => { await rec('GetPresets'); return c.presets; },
    gotoPreset: async (t) => { await rec('GotoPreset', t); moved(); },
    setPreset: async (name) => { await rec('SetPreset', name); c.presets.push({ token: '9', name, position: null }); return '9'; },
    removePreset: async (t) => { await rec('RemovePreset', t); },
  });
  return /** @type {any} */ (c);
}

let settings;
let client;
let ptz;
const ops = () => client.calls.map((x) => x.op);
const moves = () => client.calls.filter((x) => !['GetNodes', 'GetConfigurationOptions', 'GetStatus', 'GetPresets'].includes(x.op));

async function make(over = {}, clientOpts = {}) {
  settings = { ...DEFAULTS, ...over };
  client = fakeClient(clientOpts);
  ptz = new PtzController({ client, getSettings: () => settings, saveSettings: (p) => Object.assign(settings, p) });
  await ptz.probe();
  client.calls.length = 0;
  return ptz;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-10T12:00:00Z') });
});
afterEach(async () => {
  if (ptz) {
    const d = ptz.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    await d;
  }
  vi.useRealTimers();
});

describe('pure maths', () => {
  it('nudges are fractions of the view, signed by direction and inversion', () => {
    const s = { ...DEFAULTS };
    expect(nudgeTranslation('right', 'medium', s)).toEqual({ x: 0.175, y: 0 });
    expect(nudgeTranslation('left', 'medium', s)).toEqual({ x: -0.175, y: 0 });
    expect(nudgeTranslation('up', 'medium', s).y).toBeCloseTo(0.49);
    expect(nudgeTranslation('down', 'large', s).y).toBeCloseTo(-1.05);
    expect(nudgeTranslation('right', 'medium', { ...s, invertPan: true })).toEqual({ x: -0.175, y: 0 });
    expect(nudgeTranslation('up', 'medium', { ...s, invertTilt: true }).y).toBeCloseTo(-0.49);
    // 0.02 of the view × 0.5 units = 0.01 → raised to minStep
    expect(nudgeTranslation('left', 'small', { ...s, stepSmall: 0.02 })).toEqual({ x: -0.05, y: 0 });
  });

  it('click-to-center: deadband, up is up, minStep', () => {
    const s = { ...DEFAULTS };
    expect(centerTranslation(0.52, 0.49, s)).toEqual({ x: 0, y: 0 });
    const t = centerTranslation(0.75, 0.25, s);
    expect(t.x).toBeCloseTo(0.125);
    expect(t.y).toBeCloseTo(0.35); // clicked above the centre: turn up
    expect(centerTranslation(0.55, 0.5, s)).toEqual({ x: 0.05, y: 0 }); // 0.025 → minStep
    expect(centerTranslation(0.25, 0.9, { ...s, invertPan: true, invertTilt: true }).x).toBeCloseTo(0.125);
  });

  it('matches preset names: exact, prefix, close, ambiguous', () => {
    const P = [{ name: 'Front Door' }, { name: 'Window' }, { name: 'Driveway' }, { name: 'Drive gate' }];
    expect(normalizePresetName('  The FRONT-door! ')).toBe('front door');
    expect(matchPresetName('the front door', P)).toEqual({ preset: P[0] });
    expect(matchPresetName('window', P)).toEqual({ preset: P[1] });
    expect(matchPresetName('front', P)).toEqual({ preset: P[0] });
    expect(matchPresetName('windwo', P)).toEqual({ preset: P[1] });
    expect(matchPresetName('drive', P)).toEqual({ ambiguous: ['Driveway', 'Drive gate'] });
    expect(matchPresetName('garage', P)).toEqual({ none: true });
    expect(matchPresetName('', P)).toEqual({ none: true });
  });
});

describe('probe', () => {
  it('never moves the camera and picks the relative mode', async () => {
    settings = { ...DEFAULTS };
    client = fakeClient();
    ptz = new PtzController({ client, getSettings: () => settings });
    const caps = await ptz.probe();
    expect(caps).toMatchObject({ available: true, mode: 'relative', canStatus: true, canAbsolute: true, maxPresets: 8 });
    expect(ops()).toEqual(['GetNodes', 'GetConfigurationOptions', 'GetStatus', 'GetPresets']);
  });

  it('continuous when only a velocity space exists; none when PTZ is off', async () => {
    await make({}, { spaces: { absolute: [], relative: [], continuous: [{ uri: 'vel', ranges: null }] } });
    client.profile.relativeSpace = null;
    expect((await ptz.probe()).mode).toBe('continuous');
    settings.ptz = 'off';
    expect((await ptz.probe()).available).toBe(false);
    expect(await ptz.command({ op: 'nudge', dir: 'left', amount: 'small' })).toMatchObject({ ok: false, code: 'unsupported' });
  });
});

describe('moves and the watchdog', () => {
  it('nudges with RelativeMove and polls MoveStatus until IDLE (no Stop needed)', async () => {
    await make();
    const r = await ptz.command({ op: 'nudge', dir: 'right', amount: 'medium' });
    expect(r).toMatchObject({ ok: true, moved: true });
    expect(client.calls[0]).toMatchObject({ op: 'RelativeMove', args: [0.175, 0] });
    expect(ptz.moving).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ptz.moving).toBe(false);
    expect(ptz.settleUntil).toBeGreaterThan(Date.now());
    expect(ops().filter((x) => x === 'GetStatus').length).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(10000);
    expect(ops()).not.toContain('Stop');
  });

  it('without GetStatus sends the Stop chain at 1.5 s + |t| × msPerUnit', async () => {
    await make({}, { statusWorks: false });
    expect(ptz.caps.canStatus).toBe(false);
    const t0 = Date.now();
    await ptz.command({ op: 'nudge', dir: 'right', amount: 'medium' });
    await vi.advanceTimersByTimeAsync(2500);
    expect(ops()).not.toContain('Stop');
    await vi.advanceTimersByTimeAsync(100);
    const stop = client.calls.find((x) => x.op === 'Stop');
    expect(stop.t - t0).toBe(1500 + 0.175 * 6000);
    expect(ops()).not.toContain('GetStatus');
    expect(ptz.moving).toBe(false);
  });

  it('stops a RelativeMove that runs away (MoveStatus stays MOVING) at the bound', async () => {
    await make({}, { movingFor: 1e9 });
    const t0 = Date.now();
    await ptz.command({ op: 'nudge', dir: 'up', amount: 'small' });
    await vi.advanceTimersByTimeAsync(9000);
    const stop = client.calls.find((x) => x.op === 'Stop');
    expect(stop).toBeTruthy();
    expect(stop.t - t0).toBe(Math.round(1500 + 0.15 * 1.4 * 6000));
  });

  it('the Stop chain: minimal Stop on a fault, then zero velocity', async () => {
    await make({}, { statusWorks: false });
    client.fail.Stop = new OnvifError('fault', 'nope', { status: 400 });
    await ptz.command({ op: 'stop' });
    // without GetStatus nothing confirms a Stop: zero velocity follows even a Stop that worked
    expect(ops()).toEqual(['Stop', 'StopMinimal', 'ZeroVelocity']);
    client.calls.length = 0;
    client.fail.StopMinimal = new OnvifError('fault', 'nope', { status: 400 });
    await ptz.command({ op: 'stop' });
    expect(ops()).toEqual(['Stop', 'StopMinimal', 'ZeroVelocity']);
  });

  it('zero velocity when the camera ignores Stop (still MOVING 600 ms later)', async () => {
    await make({}, { movingFor: 1e9 });
    client.stopIgnored = true;
    const p = ptz.command({ op: 'hold', dir: 'left' });
    await vi.advanceTimersByTimeAsync(0);
    await p;
    const done = ptz.command({ op: 'release' });
    await vi.advanceTimersByTimeAsync(700);
    await done;
    expect(ops().slice(-3)).toEqual(['Stop', 'GetStatus', 'ZeroVelocity']);
    expect(client.calls.find((x) => x.op === 'ContinuousMove')?.args).toEqual([-0.5, 0, 1]);
  });

  it('a new move cancels the after-Stop check so its own motion is not stopped', async () => {
    await make({}, { movingFor: 5000 });
    const stopping = ptz.command({ op: 'stop' });
    await vi.advanceTimersByTimeAsync(100);
    await ptz.command({ op: 'nudge', dir: 'right', amount: 'small' });
    await stopping;
    await vi.advanceTimersByTimeAsync(700);
    expect(ops()).not.toContain('ZeroVelocity');
  });

  it('continuous mode: a nudge is a ContinuousMove for |t| × msPerUnit, then Stop', async () => {
    await make({ ptz: 'continuous' }, { statusWorks: false });
    const t0 = Date.now();
    await ptz.command({ op: 'nudge', dir: 'right', amount: 'medium' });
    expect(client.calls[0]).toMatchObject({ op: 'ContinuousMove' });
    expect(client.calls[0].args[0]).toBe(0.5);
    expect(client.calls[0].args[2]).toBe(2); // whole seconds (PT2S); the watchdog stops it at 1050 ms
    await vi.advanceTimersByTimeAsync(1100);
    expect(client.calls.find((x) => x.op === 'Stop').t - t0).toBe(1050);
  });

  it('one move in flight; a newer one replaces the queued one', async () => {
    await make();
    let open;
    client.gate = new Promise((r) => { open = r; });
    const a = ptz.command({ op: 'nudge', dir: 'right', amount: 'small' });
    await vi.advanceTimersByTimeAsync(0);
    const b = ptz.command({ op: 'nudge', dir: 'right', amount: 'medium' });
    const c = ptz.command({ op: 'nudge', dir: 'left', amount: 'large' });
    client.gate = null;
    open();
    expect(await b).toEqual({ ok: true, moved: false });
    expect((await a).moved).toBe(true);
    expect((await c).moved).toBe(true);
    expect(client.calls.filter((x) => x.op === 'RelativeMove').map((x) => x.args[0])).toEqual([0.075, -0.375]);
  });

  it('click-to-center inside the deadband does not move', async () => {
    await make();
    expect(await ptz.command({ op: 'center', u: 0.51, v: 0.49 })).toMatchObject({ ok: true, moved: false });
    expect(moves()).toEqual([]);
  });
});

describe('press-and-hold', () => {
  it('re-sends ContinuousMove every 500 ms while heartbeats come, stops 700 ms after the last one', async () => {
    await make({}, { statusWorks: false });
    await ptz.command({ op: 'hold', dir: 'right' });
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(250);
      await ptz.command({ op: 'heartbeat' });
    }
    const lastBeat = Date.now();
    const sends = client.calls.filter((x) => x.op === 'ContinuousMove').length;
    expect(sends).toBeGreaterThanOrEqual(4);
    expect(ops()).not.toContain('Stop');
    await vi.advanceTimersByTimeAsync(1000);
    const stop = client.calls.find((x) => x.op === 'Stop');
    expect(stop.t - lastBeat).toBeLessThanOrEqual(700);
    expect(ptz.holding).toBe(false);
    // every ContinuousMove went out within 700 ms of a heartbeat, none after the Stop
    const beats = [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000].map((ms) => stop.t - (stop.t - lastBeat) - 2000 + ms);
    for (const cm of client.calls.filter((x) => x.op === 'ContinuousMove')) {
      expect(cm.t).toBeLessThan(stop.t);
      expect(Math.min(...beats.filter((b) => b <= cm.t).map((b) => cm.t - b))).toBeLessThanOrEqual(700);
    }
    const after = client.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(client.calls.length).toBe(after); // nothing re-sent
  });

  it('a relative-only camera gets small nudges every 700 ms instead', async () => {
    await make({}, { spaces: { absolute: [], relative: [{ uri: 'rel', ranges: null }], continuous: [] } });
    client.profile.continuousSpace = null;
    await ptz.probe();
    expect(ptz.caps.canContinuous).toBe(false);
    client.calls.length = 0;
    await ptz.command({ op: 'hold', dir: 'up' });
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(250);
      await ptz.command({ op: 'heartbeat' });
    }
    await ptz.command({ op: 'release' });
    const rel = client.calls.filter((x) => x.op === 'RelativeMove');
    expect(rel.length).toBe(3); // t = 0, 700, 1400
    expect(rel[0].args[1]).toBeCloseTo(0.21);
    expect(ops()).toContain('Stop');
  });

  it('stopAll (window blur, renderer gone) ends a hold with a Stop; idle stopAll sends nothing', async () => {
    await make({}, { statusWorks: false });
    await ptz.stopAll('blur');
    expect(ops()).toEqual([]);
    await ptz.command({ op: 'hold', dir: 'down' });
    await ptz.stopAll('blur');
    // no GetStatus to confirm the Stop: zero velocity after it
    expect(ops()).toEqual(['ContinuousMove', 'Stop', 'ZeroVelocity']);
    expect(ptz.holding).toBe(false);
    await ptz.stopAll('quit', { force: true });
    expect(ops()).toEqual(['ContinuousMove', 'Stop', 'ZeroVelocity', 'Stop', 'ZeroVelocity']);
  });
});

describe('privacy mode', () => {
  // Updated on purpose (UX review: the D-pad stayed dead for 60 s after privacy mode was turned
  // off): commands still go out while privacy is suspected, and a cheap read every 5 s clears it
  // as soon as the camera answers normally. The hint and "never unsupported" stay.
  it('a malformed answer: privacy suspected with the hint, never "unsupported"; a normal answer clears it within 5 s', async () => {
    await make();
    const events = [];
    ptz.on('privacy', (v) => events.push(v));
    const malformed = new OnvifError('malformed', 'Parse Error', { code: 'HPE_INVALID_CONSTANT' });
    client.fail.RelativeMove = malformed;
    client.fail.GetStatus = malformed;
    expect(await ptz.command({ op: 'nudge', dir: 'left', amount: 'small' })).toEqual({ ok: false, code: 'privacy', error: PRIVACY_HINT });
    expect(ptz.caps.available).toBe(true);
    expect(ptz.privacySuspected).toBe(true);
    // the user may just have turned privacy mode off: the next command is still sent
    const sent = () => client.calls.filter((x) => x.op === 'RelativeMove').length;
    const n = sent();
    expect((await ptz.command({ op: 'nudge', dir: 'left', amount: 'small' })).code).toBe('privacy');
    expect(sent()).toBe(n + 1);
    // still in privacy mode: the 5 s check keeps the suspicion
    await vi.advanceTimersByTimeAsync(PRIVACY_RECHECK_MS * 2 + 100);
    expect(ptz.privacySuspected).toBe(true);
    expect(ptz.caps.available).toBe(true);
    // privacy mode off: the next check clears it
    delete client.fail.RelativeMove;
    delete client.fail.GetStatus;
    await vi.advanceTimersByTimeAsync(PRIVACY_RECHECK_MS + 100);
    expect(ptz.privacySuspected).toBe(false);
    expect((await ptz.command({ op: 'nudge', dir: 'left', amount: 'small' })).ok).toBe(true);
    expect(events).toEqual([true, false]);
  });

  it('without new symptoms the suspicion ends after 60 s at the latest', async () => {
    await make();
    client.fail.RelativeMove = new OnvifError('malformed', 'Parse Error', { code: 'HPE_INVALID_CONSTANT' });
    client.fail.GetStatus = new OnvifError('http', 'HTTP 500', { status: 500 });
    await ptz.command({ op: 'nudge', dir: 'left', amount: 'small' });
    expect(ptz.privacySuspected).toBe(true);
    delete client.fail.GetStatus;
    client.fail.GetStatus = new OnvifError('fault', 'not now', { status: 400 }); // not a privacy symptom, not a normal answer
    await vi.advanceTimersByTimeAsync(PRIVACY_MS + 100);
    expect(ptz.privacySuspected).toBe(false);
  });

  it('HTTP 500 counts too; a probe during privacy keeps the earlier capabilities', async () => {
    await make();
    client.fail.GetNodes = new OnvifError('http', 'HTTP 500', { status: 500 });
    client.spaces = { absolute: [], relative: [], continuous: [] };
    const caps = await ptz.probe();
    expect(caps.available).toBe(true);
    expect(caps.mode).toBe('relative');
    expect(ptz.privacySuspected).toBe(true);
  });
});

describe('presets and home', () => {
  it('goes to camera presets by token and by name', async () => {
    await make();
    expect(await ptz.command({ op: 'preset', token: '1' })).toMatchObject({ ok: true, moved: true, preset: 'Door' });
    expect(await ptz.command({ op: 'preset-name', name: 'the door' })).toMatchObject({ ok: true, preset: 'Door' });
    expect(client.calls.filter((x) => x.op === 'GotoPreset').map((x) => x.args[0])).toEqual(['1', '1']);
    expect(await ptz.command({ op: 'preset-name', name: 'garage' })).toMatchObject({ ok: false, code: 'no-preset' });
  });

  it('home: the home preset, else AbsoluteMove(0,0), else a preset named Home, else unsupported', async () => {
    await make({ homePreset: '2' });
    await ptz.command({ op: 'home' });
    expect(client.calls.at(-1)).toMatchObject({ op: 'GotoPreset', args: ['2'] });
    settings.homePreset = '';
    await ptz.command({ op: 'home' });
    expect(client.calls.find((x) => x.op === 'AbsoluteMove')?.args).toEqual([0, 0]);
    await make({}, { spaces: { absolute: [], relative: [{ uri: 'rel', ranges: null }], continuous: [] } });
    client.presets.push({ token: '5', name: 'HOME', position: null });
    await ptz.presets({ refresh: true });
    await ptz.command({ op: 'home' });
    expect(client.calls.at(-1)).toMatchObject({ op: 'GotoPreset', args: ['5'] });
    client.presets.pop();
    await ptz.presets({ refresh: true });
    expect(await ptz.command({ op: 'home' })).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('saves with SetPreset when it works, else as a local position, else explains', async () => {
    await make();
    expect(await ptz.savePreset('Garden')).toEqual({ ok: true, token: '9' });
    expect(ptz.caps.canSetPreset).toBe(true);
    await make();
    client.fail.SetPreset = new OnvifError('fault', 'not supported', { status: 500, codes: ['ter:Action'] });
    client.position = { x: 0.4, y: -0.1 };
    expect(await ptz.savePreset('Garden')).toEqual({ ok: true, token: 'local-0' });
    expect(settings.localPresets).toEqual([{ name: 'Garden', x: 0.4, y: -0.1 }]);
    expect(ptz.caps.canSetPreset).toBe(false);
    const list = await ptz.presets();
    expect(list.at(-1)).toEqual({ token: 'local-0', name: 'Garden', source: 'local' });
    await ptz.command({ op: 'preset', token: 'local-0' });
    expect(client.calls.find((x) => x.op === 'AbsoluteMove')?.args).toEqual([0.4, -0.1]);
    expect(await ptz.removePreset('local-0')).toEqual({ ok: true });
    expect(settings.localPresets).toEqual([]);
    await make({}, { statusWorks: false });
    client.fail.SetPreset = new OnvifError('fault', 'not supported', { status: 500 });
    expect(await ptz.savePreset('Garden')).toEqual({ ok: false, error: 'Save positions in the Tapo app, then press Refresh.' });
  });

  it('refuses to move after the sign-in failed', async () => {
    await make();
    client.authFailed = true;
    expect(await ptz.command({ op: 'nudge', dir: 'left', amount: 'small' })).toMatchObject({ ok: false, code: 'auth' });
    expect(moves()).toEqual([]);
  });
});
