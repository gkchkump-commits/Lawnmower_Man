import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLIP_MAX_HITS, WAKE_UI_STATES, checkWav, validateNoArgs, validateSaveClip, validateUiState } from '../../../electron/wake/validate.js';
import { clipStamp, saveTestClip, testClipsDir } from '../../../electron/wake/clips.js';
import { micAccessStatus, openMicSettings } from '../../../electron/wake/mic-access.js';
import { POWER_EVENTS, watchPower } from '../../../electron/wake/power.js';
import { EventEmitter } from 'node:events';

/** A RIFF/WAVE PCM16 file. */
function wav({ seconds = 1, rate = 16000, channels = 1, bits = 16, format = 1, extraChunk = false } = {}) {
  const align = (channels * bits) / 8;
  const dataBytes = Math.round(seconds * rate) * align;
  const extra = extraChunk ? Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')]) : Buffer.alloc(0);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + extra.length + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(format, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * align, 28);
  h.writeUInt16LE(align, 32);
  h.writeUInt16LE(bits, 34);
  const fmt = h.subarray(0, 36);
  const dataHdr = Buffer.alloc(8);
  dataHdr.write('data', 0);
  dataHdr.writeUInt32LE(dataBytes, 4);
  return Buffer.concat([fmt, extra, dataHdr, Buffer.alloc(dataBytes)]);
}

describe('wake IPC validation (contract §6.1)', () => {
  it('lm:wake:state: a known state and a short reason', () => {
    expect(validateUiState({ state: 'waiting' })).toEqual({ state: 'waiting', reason: '' });
    expect(validateUiState({ state: 'unavailable', reason: ` needs the local voice\n${'x'.repeat(300)}` }).reason).toHaveLength(120);
    expect(validateUiState({ state: 'blocked', reason: 'a\u0000b' }).reason).toBe('a b');
    for (const bad of [null, 'waiting', { state: 'sleeping' }, { state: 'waiting', reason: 5 }, []]) expect(() => validateUiState(bad), JSON.stringify(bad)).toThrow();
    expect(WAKE_UI_STATES).toEqual(['off', 'unavailable', 'starting', 'paused', 'locked', 'blocked', 'muted', 'waiting', 'attention', 'listening', 'followup', 'look', 'busy', 'barge']);
  });

  it('no-argument channels refuse arguments', () => {
    expect(() => validateNoArgs([])).not.toThrow();
    expect(() => validateNoArgs([undefined])).not.toThrow();
    expect(() => validateNoArgs([1])).toThrow(/no arguments/);
  });

  it('save-clip: RIFF/WAVE PCM16 mono 16 kHz, consistent sizes, ≤ 60 s', () => {
    expect(checkWav(wav({ seconds: 30 }))).toMatchObject({ dataOffset: 44, durationSec: 30 });
    expect(checkWav(wav({ seconds: 2, extraChunk: true })).durationSec).toBe(2);
    expect(() => checkWav(wav({ rate: 48000 }))).toThrow(/16 kHz/);
    expect(() => checkWav(wav({ channels: 2 }))).toThrow(/mono/);
    expect(() => checkWav(wav({ bits: 8 }))).toThrow(/16-bit/);
    expect(() => checkWav(wav({ format: 3, bits: 16 }))).toThrow(/PCM/);
    expect(() => checkWav(wav({ seconds: 61 }))).toThrow(/longer than 60 s/);
    expect(() => checkWav(Buffer.from('not a wav file at all, nope, nothing here....'))).toThrow(/RIFF/);
    const truncated = wav({ seconds: 1 }).subarray(0, 1000);
    expect(() => checkWav(truncated)).toThrow(/size/);
    const lying = Buffer.from(wav({ seconds: 1 }));
    lying.writeUInt32LE(10, 40); // the data chunk claims 10 bytes
    lying.writeUInt32LE(lying.length - 8 - (32000 - 10), 4);
    expect(() => checkWav(lying)).toThrow();
  });

  it('save-clip: ≤ 200 hits with known keywords and short outcomes', () => {
    const ok = validateSaveClip({ wav: wav().buffer.slice(0), hits: [{ atSec: 1.23456, keyword: 'HEY_JADE', outcome: 'woke' }] });
    expect(ok.hits).toEqual([{ atSec: 1.235, keyword: 'HEY_JADE', outcome: 'woke' }]);
    expect(validateSaveClip({ wav: new Uint8Array(wav()) }).hits).toEqual([]);
    const many = Array.from({ length: CLIP_MAX_HITS + 1 }, () => ({ atSec: 0, keyword: 'JADE', outcome: 'x' }));
    expect(() => validateSaveClip({ wav: wav(), hits: many })).toThrow(/at most 200/);
    expect(() => validateSaveClip({ wav: wav(), hits: [{ atSec: -1, keyword: 'JADE', outcome: 'x' }] })).toThrow(/atSec/);
    expect(() => validateSaveClip({ wav: wav(), hits: [{ atSec: 1, keyword: 'HEY_SIRI', outcome: 'x' }] })).toThrow(/keyword/);
    expect(() => validateSaveClip({ wav: wav(), hits: [{ atSec: 1, keyword: 'JADE', outcome: '../../evil' }] })).toThrow(/outcome/);
    expect(() => validateSaveClip({ wav: 'base64…' })).toThrow(/ArrayBuffer/);
  });
});

describe('test clips (contract §7.9)', () => {
  it('writes <Documents>/Lawnmower Man/Hey Jade tests/<stamp>.wav + .json and opens the folder', async () => {
    const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-docs-'));
    const openPath = vi.fn(async () => '');
    const now = () => new Date(2026, 9, 10, 9, 41, 12);
    const r = await saveTestClip({ wav: wav({ seconds: 3 }), hits: [{ atSec: 1, keyword: 'HEY_JADE', outcome: 'woke' }] }, { documentsDir: docs, now, openPath, appVersion: '0.5.0' });
    const dir = testClipsDir(docs);
    expect(r).toEqual({ ok: true, path: path.join(dir, '20261010-094112.wav') });
    expect(fs.readFileSync(r.path).length).toBe(44 + 3 * 32000);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '20261010-094112.json'), 'utf8'));
    expect(meta).toMatchObject({ app: '0.5.0', sampleRate: 16000, durationSec: 3, hits: [{ atSec: 1, keyword: 'HEY_JADE', outcome: 'woke' }] });
    expect(openPath).toHaveBeenCalledWith(dir);
    // the same second again: a new name, never an overwrite
    const r2 = await saveTestClip({ wav: wav() }, { documentsDir: docs, now });
    expect(r2.path).toBe(path.join(dir, '20261010-094112-2.wav'));
    expect(clipStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405');
  });

  it('refuses a bad clip without writing anything', async () => {
    const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-docs-'));
    const r = await saveTestClip({ wav: wav({ rate: 44100 }) }, { documentsDir: docs });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/16 kHz/);
    expect(fs.existsSync(testClipsDir(docs))).toBe(false);
  });
});

describe('mic access and power', () => {
  it('asks systemPreferences on Windows/macOS only, and never throws', () => {
    expect(micAccessStatus({ getMediaAccessStatus: () => 'denied' }, 'win32')).toBe('denied');
    expect(micAccessStatus({ getMediaAccessStatus: () => 'weird' }, 'win32')).toBe('unknown');
    expect(micAccessStatus({ getMediaAccessStatus: () => { throw new Error('x'); } }, 'darwin')).toBe('unknown');
    expect(micAccessStatus({ getMediaAccessStatus: () => 'granted' }, 'linux')).toBe('unknown');
  });

  it('opens ms-settings:privacy-microphone on Windows only', async () => {
    const shell = { openExternal: vi.fn(async () => {}) };
    expect(await openMicSettings(shell, 'win32')).toEqual({ ok: true });
    expect(shell.openExternal).toHaveBeenCalledWith('ms-settings:privacy-microphone');
    expect(await openMicSettings(shell, 'linux')).toEqual({ ok: false });
  });

  it('forwards lock/unlock/suspend/resume; stop() unsubscribes; emit() fakes one', () => {
    const pm = new EventEmitter();
    const sent = [];
    const w = watchPower(pm, (s) => sent.push(s));
    for (const ev of Object.keys(POWER_EVENTS)) pm.emit(ev);
    expect(sent).toEqual(['locked', 'unlocked', 'suspended', 'resumed']);
    w.emit('locked');
    expect(sent.at(-1)).toBe('locked');
    expect(() => w.emit('exploded')).toThrow();
    w.stop();
    pm.emit('lock-screen');
    expect(sent).toHaveLength(5);
    expect(pm.listenerCount('lock-screen')).toBe(0);
  });
});
