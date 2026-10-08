// Main-process side of the camera (docs/CAMERA.md): the camera settings group, the permission
// policy gated by camera.enabled, validation of images sent with a turn, the image content
// blocks ClaudeSession writes (end to end against the fake CLI), the persona line and the tray
// item.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClaudeSession,
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BASE64,
  MAX_TURN_IMAGES,
  userMessageContent,
} from '../../../electron/claude-session.js';
import { validateTurnOptions } from '../../../electron/ipc-validate.js';
import { buildPersona, SPEECH_RULES } from '../../../electron/persona.js';
import { APP_ORIGIN, decidePermission, validateDevServerUrl } from '../../../electron/security.js';
import { DEFAULT_SETTINGS, SettingsStore, applyPatch, cloneSettings, defaultSettings } from '../../../electron/settings.js';
import { buildTrayTemplate } from '../../../electron/tray-menu.js';
import { DEFAULT_SETTINGS as RENDERER_DEFAULTS } from '../../../src/app/settings-defaults.js';

/** A minimal JPEG (SOI, an SOF0 segment for 640x480, EOI): enough for the magic and size checks. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, 0]).toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3]).toString('base64');
const WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1').toString('base64');

describe('camera settings group', () => {
  it('is off by default, with the documented fields, mirrored in the renderer defaults', () => {
    expect(DEFAULT_SETTINGS.camera).toEqual({
      enabled: false, deviceId: '', followFace: true, presence: true, mirrorExpressions: true,
      shareWithClaude: false, greet: false, lookToTalk: false,
    });
    expect(RENDERER_DEFAULTS.camera).toEqual(DEFAULT_SETTINGS.camera);
    expect(defaultSettings('win32').camera.enabled).toBe(false);
  });

  it('validates every field like the other groups', () => {
    const base = defaultSettings('linux');
    const ok = applyPatch(base, { camera: { enabled: true, deviceId: 'a1B2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2', shareWithClaude: true, lookToTalk: true } });
    expect(ok.warnings).toEqual([]);
    expect(ok.settings.camera).toMatchObject({ enabled: true, shareWithClaude: true, lookToTalk: true });
    const bad = applyPatch(base, { camera: { enabled: 'yes', deviceId: 'bad id\nwith newline', greet: 1, bogus: true } });
    expect(bad.settings.camera).toEqual(base.camera);
    expect(bad.warnings).toHaveLength(4);
    expect(bad.warnings.join('\n')).toMatch(/camera\.enabled/);
    expect(bad.warnings.join('\n')).toMatch(/unknown setting "camera\.bogus"/);
    expect(applyPatch(base, { camera: { deviceId: 'x'.repeat(300) } }).warnings[0]).toMatch(/longer than 256/);
    expect(applyPatch(base, { camera: { deviceId: '' } }).warnings).toEqual([]);
  });

  it('an older settings file without the group loads the camera defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-cam-settings-'));
    try {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 2, voice: { handsFree: true } }));
      const store = new SettingsStore({ dir, platform: 'linux' });
      const s = store.load();
      expect(s.camera).toEqual(DEFAULT_SETTINGS.camera);
      expect(s.voice.handsFree).toBe(true);
      const changes = [];
      store.on('change', (next, prev) => changes.push([prev.camera.enabled, next.camera.enabled]));
      store.update({ camera: { enabled: true } });
      expect(changes).toEqual([[false, true]]);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).camera.enabled).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('permission policy: the camera only while camera.enabled is on', () => {
  const url = `${APP_ORIGIN}/index.html`;
  it('denies video while the camera is off (the default), allows it while on', () => {
    expect(decidePermission('media', { url, mediaTypes: ['video'] })).toBe(false);
    expect(decidePermission('media', { url, mediaTypes: ['video'] }, { camera: false })).toBe(false);
    expect(decidePermission('media', { url, mediaTypes: ['video'] }, { camera: true })).toBe(true);
    expect(decidePermission('media', { url, mediaTypes: ['audio', 'video'] }, { camera: true })).toBe(true);
    // permission checks (device labels for the camera picker)
    expect(decidePermission('media', { url, mediaType: 'video' })).toBe(false);
    expect(decidePermission('media', { url, mediaType: 'video' }, { camera: true })).toBe(true);
    expect(decidePermission('media', { url, mediaType: 'unknown' }, { camera: true })).toBe(false);
  });
  it('the microphone stays as before, whatever the camera does', () => {
    for (const camera of [false, true]) {
      expect(decidePermission('media', { url, mediaTypes: ['audio'] }, { camera })).toBe(true);
      expect(decidePermission('media', { url, mediaType: 'audio' }, { camera })).toBe(true);
      expect(decidePermission('media', { url, mediaTypes: [] }, { camera })).toBe(false);
    }
  });
  it('other origins are denied even with the camera on; the dev server only when trusted', () => {
    expect(decidePermission('media', { url: 'https://evil.example/', mediaTypes: ['video'] }, { camera: true })).toBe(false);
    expect(decidePermission('media', { url: 'app://other/index.html', mediaTypes: ['video'] }, { camera: true })).toBe(false);
    expect(decidePermission('media', { url: 'http://127.0.0.1:5173/index.html', mediaTypes: ['video'] }, { camera: true })).toBe(false);
    const dev = { devServerUrl: validateDevServerUrl('http://127.0.0.1:5173'), camera: true };
    expect(decidePermission('media', { url: 'http://127.0.0.1:5173/index.html', mediaTypes: ['video'] }, dev)).toBe(true);
    expect(decidePermission('display-capture', { url }, { camera: true })).toBe(false);
  });
});

describe('ipc-validate: images with a turn', () => {
  it('accepts up to two JPEG / PNG / WebP images and passes nothing else on', () => {
    expect(validateTurnOptions(undefined)).toEqual({});
    expect(validateTurnOptions(null)).toEqual({});
    expect(validateTurnOptions({})).toEqual({});
    expect(validateTurnOptions({ images: [] })).toEqual({});
    expect(validateTurnOptions({ images: [{ mediaType: 'image/jpeg', data: JPEG, extra: 1 }], other: true })).toEqual({ images: [{ mediaType: 'image/jpeg', data: JPEG }] });
    expect(validateTurnOptions({ images: [{ mediaType: 'image/png', data: PNG }, { mediaType: 'image/webp', data: WEBP }] }).images).toHaveLength(2);
    expect(IMAGE_MEDIA_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(MAX_TURN_IMAGES).toBe(2);
  });
  it('rejects bad shapes, types, prefixes, sizes, base64 and content that is not the claimed type', () => {
    const img = (o) => ({ images: [{ mediaType: 'image/jpeg', data: JPEG, ...o }] });
    expect(() => validateTurnOptions('x')).toThrow(/object/);
    expect(() => validateTurnOptions({ images: 'x' })).toThrow(/list/);
    expect(() => validateTurnOptions({ images: [1] })).toThrow(/object/);
    expect(() => validateTurnOptions({ images: [img().images[0], img().images[0], img().images[0]] })).toThrow(/at most 2/);
    expect(() => validateTurnOptions(img({ mediaType: 'image/gif' }))).toThrow(/JPEG, PNG or WebP/);
    expect(() => validateTurnOptions(img({ mediaType: 'text/html' }))).toThrow(/JPEG, PNG or WebP/);
    expect(() => validateTurnOptions(img({ data: '' }))).toThrow(/no data/);
    expect(() => validateTurnOptions(img({ data: 42 }))).toThrow(/no data/);
    expect(() => validateTurnOptions(img({ data: `data:image/jpeg;base64,${JPEG}` }))).toThrow(/data: prefix/);
    expect(() => validateTurnOptions(img({ data: 'A'.repeat(MAX_IMAGE_BASE64 + 4) }))).toThrow(/too large/);
    expect(() => validateTurnOptions(img({ data: `${JPEG.slice(0, -4)}!!!!` }))).toThrow(/base64/);
    expect(() => validateTurnOptions(img({ data: `${JPEG}A` }))).toThrow(/base64/);
    expect(() => validateTurnOptions(img({ data: PNG }))).toThrow(/not really image\/jpeg/);
    expect(() => validateTurnOptions({ images: [{ mediaType: 'image/png', data: JPEG }] })).toThrow(/not really image\/png/);
  });
});

describe('ClaudeSession: images go after the text block', () => {
  it('userMessageContent', () => {
    expect(userMessageContent('hi')).toEqual([{ type: 'text', text: 'hi' }]);
    expect(userMessageContent('look', [{ mediaType: 'image/jpeg', data: JPEG }])).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } },
    ]);
  });

  const sessions = [];
  afterEach(async () => {
    while (sessions.length) {
      const h = sessions.pop();
      await h.session.stop().catch(() => {});
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  });
  function harness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-cam-claude-'));
    const settings = { cliPath: '', model: '', effort: '', mode: 'chat', workdir: path.join(dir, 'w'), persona: '', resumeLastSession: false, lastSessionId: '' };
    const events = [];
    const logs = [];
    const session = new ClaudeSession({
      getSettings: () => settings,
      personaDir: path.join(dir, 'p'),
      cliPath: path.resolve('tests/fixtures/fake-claude.mjs'),
      env: { ...process.env, FAKE_CLAUDE_STATE_DIR: path.join(dir, 'state') },
      log: (level, msg) => logs.push(`${level} ${msg}`),
    });
    session.on('event', (e) => events.push(e));
    const h = { dir, session, events, logs };
    sessions.push(h);
    const waitEnd = async (turnId) => {
      for (let i = 0; i < 400; i++) {
        const ev = events.find((e) => e.type === 'turn_end' && e.turnId === turnId);
        if (ev) return ev;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`no turn_end for ${turnId}: ${events.map((e) => e.type).join(',')}`);
    };
    const text = (turnId) => events.filter((e) => e.type === 'text_delta' && e.turnId === turnId).map((e) => e.text).join('');
    return { ...h, waitEnd, text };
  }

  it('the fake CLI receives and acknowledges an image; turns queue in order with and without images', async () => {
    const h = harness();
    const a = await h.session.send('first, with a picture', { images: [{ mediaType: 'image/jpeg', data: JPEG }] });
    const b = await h.session.send('second, plain');
    const c = await h.session.send('third, two pictures', { images: [{ mediaType: 'image/jpeg', data: JPEG }, { mediaType: 'image/png', data: PNG }] });
    expect(h.session.status().queuedTurnIds.length + (h.session.status().activeTurnId ? 1 : 0)).toBe(3);
    const ea = await h.waitEnd(a.turnId);
    expect(ea.isError).toBe(false);
    expect(h.text(a.turnId)).toBe(`You said: first, with a picture [saw 1 image: image/jpeg 640x480, ${Buffer.from(JPEG, 'base64').length} bytes]`);
    await h.waitEnd(b.turnId);
    expect(h.text(b.turnId)).toBe('You said: second, plain');
    await h.waitEnd(c.turnId);
    expect(h.text(c.turnId)).toMatch(/\[saw 2 images: image\/jpeg 640x480, \d+ bytes; image\/png 2x3, \d+ bytes\]$/);
    const starts = h.events.filter((e) => e.type === 'turn_start').map((e) => e.turnId);
    expect(starts).toEqual([a.turnId, b.turnId, c.turnId]);
    // image data never reaches the log
    expect(h.logs.join('\n')).not.toContain(JPEG.slice(0, 16));
  });

  it('a queued turn with an image can be cancelled before it starts; send() rejects malformed images', async () => {
    const h = harness();
    const slow = await h.session.send('slow count');
    const queued = await h.session.send('queued', { images: [{ mediaType: 'image/jpeg', data: JPEG }] });
    expect(await h.session.cancel(queued.turnId)).toEqual({ cancelled: true, interrupted: false });
    await h.session.interrupt();
    await h.waitEnd(slow.turnId);
    expect(h.events.some((e) => e.type === 'turn_start' && e.turnId === queued.turnId)).toBe(false);
    expect(h.events.some((e) => e.type === 'turn_cancelled' && e.turnId === queued.turnId)).toBe(true);
    await expect(h.session.send('x', { images: [{ mediaType: 'image/gif', data: JPEG }] })).rejects.toThrow(/Invalid image/);
    await expect(h.session.send('x', { images: 'nope' })).rejects.toThrow(/array/);
    await expect(h.session.send('x', { images: [1, 2, 3] })).rejects.toThrow(/at most 2/);
  });
});

describe('persona and tray', () => {
  it('every mode tells Claude it may receive webcam snapshots and should not narrate them', () => {
    expect(SPEECH_RULES).toMatch(/webcam/);
    for (const mode of ['chat', 'assistant', 'agent']) {
      const p = buildPersona(mode, { platform: 'win32' });
      expect(p).toMatch(/snapshot of them/);
      expect(p).toMatch(/do not describe or narrate the picture unless they ask/);
    }
    // a custom persona keeps it (it is part of the speech rules)
    expect(buildPersona('chat', { custom: 'Be a pirate.' })).toMatch(/webcam/);
  });

  it('the tray has a Camera checkbox wired to setCamera', () => {
    const setCamera = vi.fn();
    const st = { visible: true, settings: cloneSettings(DEFAULT_SETTINGS), claudeStatus: 'ready', voiceStatus: 'disabled' };
    const items = buildTrayTemplate(/** @type {any} */ (st), /** @type {any} */ ({ setCamera }));
    const cam = items.find((i) => i.label === 'Camera');
    expect(cam).toMatchObject({ type: 'checkbox', checked: false });
    cam.click({ checked: true });
    expect(setCamera).toHaveBeenCalledWith(true);
    const on = { ...st, settings: { ...st.settings, camera: { ...st.settings.camera, enabled: true } } };
    expect(buildTrayTemplate(/** @type {any} */ (on), /** @type {any} */ ({ setCamera })).find((i) => i.label === 'Camera').checked).toBe(true);
  });
});
