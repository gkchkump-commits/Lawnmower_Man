import { describe, it, expect } from 'vitest';
import {
  validateArmPayload, validateCalibratePayload, validateCameraSettingsPatch, validateCredentialsPayload, validateEventIdPayload,
  validateEventsQuery, validatePresetSave, validatePresetsQuery, validatePtzCommand, validateTestOverride, validateTokenPayload,
  validateViewPayload, validateWindowPayload, validateWorkerMessage, bytesOf, MAX_JPEG_BYTES,
} from '../../../electron/tapo/validate.js';
import { TAPO_CHANNELS, registerTapoIpc } from '../../../electron/tapo/ipc.js';
import { fakeIpcMain } from './helpers/fake-electron.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

describe('IPC payload validators', () => {
  it('PTZ commands: only the known ops, fields and ranges', () => {
    expect(validatePtzCommand({ op: 'nudge', dir: 'left', amount: 'small' })).toEqual({ op: 'nudge', dir: 'left', amount: 'small' });
    expect(validatePtzCommand({ op: 'hold', dir: 'up' })).toEqual({ op: 'hold', dir: 'up' });
    for (const op of ['heartbeat', 'release', 'stop', 'home']) expect(validatePtzCommand({ op })).toEqual({ op });
    expect(validatePtzCommand({ op: 'center', u: 0, v: 1 })).toEqual({ op: 'center', u: 0, v: 1 });
    expect(validatePtzCommand({ op: 'preset', token: 'Preset_1' })).toEqual({ op: 'preset', token: 'Preset_1' });
    expect(validatePtzCommand({ op: 'preset-name', name: '  the door ' })).toEqual({ op: 'preset-name', name: 'the door' });
    const bad = [
      undefined, null, 'nudge', [], { op: 'spin' }, { op: 'nudge', dir: 'left' }, { op: 'nudge', dir: 'sideways', amount: 'small' },
      { op: 'nudge', dir: 'left', amount: 'huge' }, { op: 'nudge', dir: 'left', amount: 'small', speed: 1 }, { op: 'hold' },
      { op: 'stop', force: true }, { op: 'center', u: 1.2, v: 0 }, { op: 'center', u: Number.NaN, v: 0 }, { op: 'center', u: '0.5', v: 0.5 },
      { op: 'preset', token: '../x' }, { op: 'preset', token: 'x'.repeat(65) }, { op: 'preset-name', name: '' }, { op: 'preset-name', name: 'a\nb' },
      { op: 'preset-name', name: 'x'.repeat(65) },
    ];
    for (const b of bad) expect(() => validatePtzCommand(b), JSON.stringify(b)).toThrow();
  });

  it('credentials: user name without spaces, password ≤ 128 without line breaks; nothing else', () => {
    expect(validateCredentialsPayload({ username: ' camacct ', password: ' p a s s ' })).toEqual({ username: 'camacct', password: ' p a s s ' });
    for (const b of [{}, { username: 'a b', password: 'x' }, { username: 'a', password: '' }, { username: 'a', password: 'x'.repeat(129) },
      { username: 'a', password: 'x\ny' }, { username: 'a', password: 'x', host: 'h' }, { username: 'a', password: 5 }]) {
      expect(() => validateCredentialsPayload(b)).toThrow();
    }
    // the message never echoes the password
    try {
      validateCredentialsPayload({ username: 'a', password: `se&cret${'x'.repeat(130)}` });
    } catch (err) {
      expect(String(err)).not.toMatch(/cret/);
    }
  });

  it('test overrides: optional host, ports, user and password', () => {
    expect(validateTestOverride(undefined)).toEqual({});
    expect(validateTestOverride({ host: ' 192.168.1.20 ', onvifPort: 2020, rtspPort: 554, username: '', password: '' })).toEqual({ host: '192.168.1.20', onvifPort: 2020, rtspPort: 554 });
    expect(validateTestOverride({ username: 'u', password: 'p' })).toEqual({ username: 'u', password: 'p' });
    for (const b of [{ onvifPort: 0 }, { rtspPort: 70000 }, { onvifPort: 2.5 }, { host: 5 }, { host: 'x'.repeat(254) }, { username: 'a b' }, { password: 'a\rb' }, { extra: 1 }]) {
      expect(() => validateTestOverride(b), JSON.stringify(b)).toThrow();
    }
  });

  it('presets, arm, calibrate, events, ids, window and view', () => {
    expect(validatePresetsQuery(undefined)).toEqual({ refresh: false });
    expect(validatePresetsQuery({ refresh: true })).toEqual({ refresh: true });
    expect(() => validatePresetsQuery({ refresh: 'yes' })).toThrow();
    expect(validatePresetSave({ name: 'Door' })).toEqual({ name: 'Door' });
    expect(validatePresetSave({ name: 'Door', token: '3' })).toEqual({ name: 'Door', token: '3' });
    expect(() => validatePresetSave({ name: 'x'.repeat(41) })).toThrow();
    expect(() => validatePresetSave({ name: 'Door', token: 'a b' })).toThrow();
    expect(validateTokenPayload({ token: '3' })).toEqual({ token: '3' });
    expect(() => validateTokenPayload({})).toThrow();
    expect(validateArmPayload({ armed: true })).toEqual({ armed: true, immediate: false });
    expect(validateArmPayload({ armed: false, immediate: true })).toEqual({ armed: false, immediate: true });
    expect(() => validateArmPayload({ armed: 1 })).toThrow();
    expect(() => validateArmPayload(true)).toThrow();
    expect(validateCalibratePayload({ action: 'start' })).toEqual({ action: 'start' });
    expect(validateCalibratePayload({ action: 'answer', answer: 'none' })).toEqual({ action: 'answer', answer: 'none' });
    expect(() => validateCalibratePayload({ action: 'answer', answer: 'diagonal' })).toThrow();
    expect(() => validateCalibratePayload({ action: 'reset' })).toThrow();
    expect(validateEventsQuery(undefined)).toEqual({});
    expect(validateEventsQuery({ beforeMs: 5, sinceMs: 1, kinds: ['person', 'person'], limit: 200 })).toEqual({ beforeMs: 5, sinceMs: 1, kinds: ['person'], limit: 200 });
    for (const b of [{ limit: 0 }, { limit: 201 }, { kinds: ['cat'] }, { kinds: 'person' }, { beforeMs: -1 }, { sinceMs: Infinity }, { offset: 1 }]) {
      expect(() => validateEventsQuery(b), JSON.stringify(b)).toThrow();
    }
    expect(validateEventIdPayload({ id: '20261010-140312-a1b2' })).toEqual({ id: '20261010-140312-a1b2' });
    for (const b of [{ id: '../../etc' }, { id: '20261010-140312-A1B2' }, {}, { id: 5 }]) expect(() => validateEventIdPayload(b)).toThrow();
    expect(validateWindowPayload({ show: true })).toEqual({ show: true });
    expect(validateWindowPayload({ show: true, eventId: '20261010-140312-a1b2' })).toEqual({ show: true, eventId: '20261010-140312-a1b2' });
    expect(() => validateWindowPayload({ show: true, eventId: 'x' })).toThrow();
    expect(() => validateWindowPayload({})).toThrow();
    expect(validateViewPayload({ visible: false })).toEqual({ visible: false });
    expect(() => validateViewPayload({ visible: 'no' })).toThrow();
  });

  it('the camera window may only patch the tapo and security groups', () => {
    const p = { tapo: { name: 'porch' }, security: { armed: true } };
    expect(validateCameraSettingsPatch(p)).toBe(p);
    for (const b of [{ voice: { engine: 'piper' } }, { tapo: {}, claude: { cliPath: 'evil.exe' } }, { window: {} }, null, 'x', []]) {
      expect(() => validateCameraSettingsPatch(b), JSON.stringify(b)).toThrow();
    }
    expect(() => validateCameraSettingsPatch({ tapo: { name: 'x'.repeat(70 * 1024) } })).toThrow(/too large/);
    const cyc = { tapo: {} };
    cyc.tapo.self = cyc;
    expect(() => validateCameraSettingsPatch(cyc)).toThrow();
  });
});

describe('worker messages', () => {
  it('ready, det, snap, shift, stats and error are cleaned; anything else is dropped', () => {
    expect(validateWorkerMessage({ t: 'ready', detector: 'on' })).toEqual({ t: 'ready', detector: 'on' });
    expect(validateWorkerMessage({ t: 'ready', detector: 'failed', error: 'x'.repeat(400) }).error).toHaveLength(300);
    expect(validateWorkerMessage({ t: 'ready', detector: 'maybe' })).toBeNull();
    const det = { t: 'det', at: 1, frameTs: 2, motion: { active: true, score: 0.3, global: false }, persons: [{ score: 0.9, box: [0.1, 0.2, 0.3, 0.4], extra: 1 }], junk: 1 };
    // no `detected` field (§9.3 as written): every det is a detector sample
    expect(validateWorkerMessage(det)).toEqual({ t: 'det', at: 1, frameTs: 2, motion: { active: true, score: 0.3, global: false }, persons: [{ score: 0.9, box: [0.1, 0.2, 0.3, 0.4] }], detected: true });
    // lane B's worker says which det messages carry a detector run (the others are motion samples)
    expect(validateWorkerMessage({ ...det, persons: [], detected: false })).toMatchObject({ persons: [], detected: false });
    expect(validateWorkerMessage({ ...det, detected: true })).toMatchObject({ detected: true });
    for (const b of [
      { ...det, detected: 'yes' },
      { ...det, at: 'now' }, { ...det, motion: {} }, { ...det, motion: { active: true, score: 2 } }, { ...det, persons: null },
      { ...det, persons: Array(11).fill({ score: 0.5, box: [0, 0, 0.1, 0.1] }) }, { ...det, persons: [{ score: 0.5, box: [0, 0, 1.5, 0.1] }] },
      { ...det, persons: [{ score: 0.5, box: [0, 0, 0.1] }] },
    ]) expect(validateWorkerMessage(b)).toBeNull();
    const snap = validateWorkerMessage({ t: 'snap-ok', id: 'r1', jpeg: JPEG.buffer, width: 640.4, height: 360, frameTs: 5 });
    expect(snap).toMatchObject({ t: 'snap-ok', id: 'r1', width: 640, height: 360, frameTs: 5 });
    expect(Buffer.isBuffer(snap.jpeg)).toBe(true);
    expect(validateWorkerMessage({ t: 'snap-ok', id: 'r1', jpeg: new Uint8Array([1, 2, 3, 4, 5]), width: 1, height: 1 })).toBeNull(); // not a JPEG
    expect(validateWorkerMessage({ t: 'snap-ok', id: 'r1', jpeg: new Uint8Array(MAX_JPEG_BYTES + 1).fill(0xff), width: 1, height: 1 })).toBeNull();
    expect(validateWorkerMessage({ t: 'snap-ok', id: 'r1', jpeg: 'base64', width: 1, height: 1 })).toBeNull();
    expect(validateWorkerMessage({ t: 'snap-err', id: 'r2', message: 'no frame' })).toEqual({ t: 'snap-err', id: 'r2', message: 'no frame' });
    expect(validateWorkerMessage({ t: 'shift', id: 'r3', dx: -0.2, dy: 0.1, score: 0.7, settledMs: 800 })).toEqual({ t: 'shift', id: 'r3', dx: -0.2, dy: 0.1, score: 0.7, settledMs: 800 });
    expect(validateWorkerMessage({ t: 'shift', id: 'r3', dx: 5, dy: 0, score: 0 })).toBeNull();
    // the gated calibration answers keep their fields (main checks how current the picture is);
    // an answer without the gate stays bare, malformed fields are dropped, never passed on
    expect(validateWorkerMessage({ t: 'shift', id: 'r4', dx: -0.2, dy: 0, score: 0.8, settledMs: 700, gated: true, at: 5012.5, refAt: 3001, frames: 6, moved: true }))
      .toEqual({ t: 'shift', id: 'r4', dx: -0.2, dy: 0, score: 0.8, settledMs: 700, gated: true, at: 5012.5, refAt: 3001, frames: 6, moved: true });
    expect(validateWorkerMessage({ t: 'shift', id: 'r4', dx: 0, dy: 0, score: 0, gated: true, at: 'now', refAt: Infinity, frames: -1, moved: 'yes' }))
      .toEqual({ t: 'shift', id: 'r4', dx: 0, dy: 0, score: 0, settledMs: 0, gated: true, frames: 0, moved: false });
    expect(validateWorkerMessage({ t: 'shift', id: 'r4', dx: 0, dy: 0, score: 0.9, at: 5000, refAt: 3000 })).toEqual({ t: 'shift', id: 'r4', dx: 0, dy: 0, score: 0.9, settledMs: 0 });
    expect(validateWorkerMessage({ t: 'shift-ref-ok', id: 'r5' })).toEqual({ t: 'shift-ref-ok', id: 'r5' });
    expect(validateWorkerMessage({ t: 'shift-ref-ok', id: 'r5', gated: true, ok: true, at: 4000, still: true })).toEqual({ t: 'shift-ref-ok', id: 'r5', gated: true, ok: true, still: true, at: 4000 });
    expect(validateWorkerMessage({ t: 'shift-ref-ok', id: 'r5', gated: true, ok: 1, at: NaN })).toEqual({ t: 'shift-ref-ok', id: 'r5', gated: true, ok: false, still: false });
    expect(validateWorkerMessage({ t: 'shift-ref-ok', id: 7 })).toBeNull();
    expect(validateWorkerMessage({ t: 'stats', fps: 15, decodeQueue: 1, dropped: 0, decoder: 'prefer-hardware', detectorMs: 30, detectorHz: 2 })).toEqual({ t: 'stats', fps: 15, decodeQueue: 1, dropped: 0, decoder: 'prefer-hardware', configSupported: true, detectorMs: 30, detectorHz: 2 });
    expect(validateWorkerMessage({ t: 'stats', fps: 15, decoder: 'gpu-please' }).decoder).toBeNull();
    expect(validateWorkerMessage({ t: 'error', fatal: 1, message: 'boom' })).toEqual({ t: 'error', fatal: true, message: 'boom' });
    for (const b of [null, 5, 'det', {}, { t: 'eval', code: 'x' }, { t: 'chunk', data: new ArrayBuffer(4) }]) expect(validateWorkerMessage(b)).toBeNull();
  });

  it('bytesOf accepts ArrayBuffer and views only', () => {
    expect(bytesOf(new Uint8Array([1, 2, 3]).subarray(1))).toEqual(Buffer.from([2, 3]));
    expect(bytesOf(new ArrayBuffer(2))?.length).toBe(2);
    expect(bytesOf([1, 2])).toBeNull();
  });
});

function fakeService() {
  const calls = [];
  const rec = (name, ret) => (...a) => {
    calls.push([name, ...a]);
    return ret;
  };
  return {
    calls,
    status: rec('status', { connection: 'online' }),
    setCredentials: rec('setCredentials', { ok: true, persistence: 'encrypted' }),
    clearCredentials: rec('clearCredentials', { ok: true }),
    test: rec('test', { ok: true }),
    discover: rec('discover', []),
    ptz: rec('ptz', { ok: true }),
    presets: rec('presets', []),
    savePreset: rec('savePreset', { ok: true }),
    removePreset: rec('removePreset', { ok: true }),
    arm: rec('arm', { armed: true, arming: false }),
    calibrate: rec('calibrate', { phase: 'idle' }),
    listEvents: rec('listEvents', { events: [], total: 0 }),
    removeEvent: rec('removeEvent', { ok: true }),
    ackEvent: rec('ackEvent', { ok: true }),
    openClips: rec('openClips', { ok: true }),
    attachWorker: rec('attachWorker', true),
    setViewVisible: rec('setViewVisible'),
    // added by the UX fixes: Retry, Copy diagnostic report (camera window only)
    retry: rec('retry', { ok: true, connection: 'connecting' }),
    diagnostics: rec('diagnostics', { tool: 'lawnmower-diagnostics' }),
  };
}

describe('registerTapoIpc', () => {
  const AVATAR = { sender: { id: 1, kind: 'avatar' } };
  const CAMERA = { sender: { id: 2, kind: 'camera' } };
  const OTHER = { sender: { id: 3, kind: 'other' } };
  /** what main.js's isTrustedSender does: throw unless the sender is one of the allowed windows */
  const isTrustedSender = (event, kinds) => {
    if (!kinds.includes(event.sender.kind)) throw new Error('Untrusted IPC sender');
  };

  it('registers every channel of the contract with the right senders, validates, and unregisters', async () => {
    const ipcMain = fakeIpcMain();
    const service = fakeService();
    const windows = [];
    const logs = [];
    const unregister = registerTapoIpc({ ipcMain, isTrustedSender, service, onWindow: (r) => windows.push(r), log: (l, m) => logs.push(`${l} ${m}`) });
    const invokeChannels = Object.keys(TAPO_CHANNELS).filter((c) => c !== 'lm:tapo:view');
    expect([...ipcMain.handlers.keys()].sort()).toEqual(invokeChannels.sort());
    const sample = {
      'lm:tapo:set-credentials': { username: 'u', password: 'p' }, 'lm:tapo:ptz': { op: 'stop' }, 'lm:tapo:preset-save': { name: 'Door' },
      'lm:tapo:preset-remove': { token: '1' }, 'lm:tapo:arm': { armed: true }, 'lm:tapo:calibrate': { action: 'cancel' },
      'lm:tapo:event-remove': { id: '20261010-140312-a1b2' }, 'lm:tapo:event-ack': { id: '20261010-140312-a1b2' }, 'lm:tapo:window': { show: true },
    };
    for (const ch of invokeChannels) {
      const allowed = TAPO_CHANNELS[ch];
      for (const [kind, ev] of [['avatar', AVATAR], ['camera', CAMERA], ['other', OTHER]]) {
        const p = ipcMain.invoke(ch, ev, sample[ch]);
        if (allowed.includes(kind)) await expect(p, `${ch} from ${kind}`).resolves.toBeDefined();
        else await expect(p, `${ch} from ${kind}`).rejects.toThrow(/Untrusted/);
      }
    }
    // payloads are validated before the service sees them
    const before = service.calls.length;
    await expect(ipcMain.invoke('lm:tapo:ptz', CAMERA, { op: 'spin' })).rejects.toThrow(/Unknown camera command/);
    await expect(ipcMain.invoke('lm:tapo:status', CAMERA, { x: 1 })).rejects.toThrow(/no arguments/);
    await expect(ipcMain.invoke('lm:tapo:event-remove', CAMERA, { id: '../../x' })).rejects.toThrow(/Invalid event/);
    expect(service.calls.length).toBe(before);
    expect(service.calls.find((c) => c[0] === 'removeEvent')).toEqual(['removeEvent', '20261010-140312-a1b2']);
    expect(service.calls.find((c) => c[0] === 'attachWorker')).toEqual(['attachWorker', CAMERA.sender]);
    expect(windows).toEqual([{ show: true }]);
    // lm:tapo:view is a send from the camera window only; bad ones are logged, never thrown
    ipcMain.emit('lm:tapo:view', CAMERA, { visible: true });
    ipcMain.emit('lm:tapo:view', AVATAR, { visible: false });
    ipcMain.emit('lm:tapo:view', CAMERA, { visible: 'yes' });
    expect(service.calls.filter((c) => c[0] === 'setViewVisible')).toEqual([['setViewVisible', true]]);
    expect(logs.filter((l) => l.startsWith('warn [ipc] lm:tapo:view'))).toHaveLength(2);
    unregister();
    expect(ipcMain.handlers.size).toBe(0);
    expect(ipcMain.listenerCount('lm:tapo:view')).toBe(0);
  });
});
