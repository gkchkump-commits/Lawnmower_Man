// The real local voice server (voice/, Python) in --fake mode — real HTTP, bearer auth, CORS
// from the preview origin, WAV + viseme payloads — driven by the app through the mock Claude
// bridge: fake microphone → /stt → reply → /tts → Web Audio → lip-sync.
// Skipped when Python or the server's dependencies (fastapi, uvicorn, numpy) are missing.
// LAWNMOWER_TEST_PYTHON overrides the interpreter.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav } from '../../src/audio/wav.js';
import { GL_ARGS, boot, expect, send, test, waitIdle } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VOICE_DIR = path.resolve(here, '../../voice');
const TOKEN = `e2e-${Math.random().toString(36).slice(2)}`;
const PYTHON = process.env.LAWNMOWER_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
// the server's FakeSTT answers this for any non-silent audio (voice/lawnmower_voice/fake.py)
const SERVER_FAKE_TEXT = 'Hello Claude, this is a test of the fake voice server.';

const SPEECH_WAV = path.join(os.tmpdir(), 'lawnmower-e2e-speech-server.wav');
{
  const rate = 48000;
  const x = new Float32Array(rate * 4);
  for (let i = 0; i < x.length; i++) {
    const t = i / rate;
    if (t < 0.4 || t > 3.4) continue;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    x[i] = (0.35 * env * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 720 * t))) / 1.5;
  }
  writeFileSync(SPEECH_WAV, Buffer.from(encodeWav(x, rate)));
}

test.use({
  launchOptions: { args: [...GL_ARGS, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${SPEECH_WAV}`] },
  permissions: ['microphone'],
});

/** @type {import('node:child_process').ChildProcess|null} */
let server = null;
let url = '';
let skipReason = '';

test.beforeAll(async () => {
  try {
    url = await new Promise((resolve, reject) => {
      const child = spawn(PYTHON, ['-m', 'lawnmower_voice', '--fake', '--host', '127.0.0.1', '--port', '0', '--no-exit-with-parent'], {
        cwd: VOICE_DIR,
        env: { ...process.env, LAWNMOWER_VOICE_TOKEN: TOKEN, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      server = child;
      let buf = '';
      let err = '';
      const timer = setTimeout(() => reject(new Error(`no ready line within 40 s${err ? `: ${err.slice(-300)}` : ''}`)), 40_000);
      child.stderr.on('data', (d) => { err += String(d); });
      child.stdout.on('data', (d) => {
        buf += String(d);
        for (const line of buf.split('\n')) {
          try {
            const m = JSON.parse(line);
            if (m.event === 'ready' && m.port) {
              clearTimeout(timer);
              resolve(`http://127.0.0.1:${m.port}`);
            }
          } catch { /* not JSON */ }
        }
      });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`voice server exited (${code}): ${err.slice(-300)}`)); });
    });
  } catch (e) {
    skipReason = `voice server unavailable: ${e.message}`;
  }
});

test.afterAll(() => {
  if (server && server.exitCode === null) server.kill();
});

test.describe('real voice server (--fake engines)', () => {
  test('push-to-talk → /stt, reply → /tts with visemes → lip-sync', async ({ page }) => {
    test.skip(!!skipReason, skipReason);
    await boot(page, { voice: url, voiceToken: TOKEN, mockDelay: 25 });
    await expect(page.locator('.status-voice')).toHaveText(/^Voice · (GPU|CPU)$/);
    await expect(page.locator('#mic')).toHaveAttribute('aria-disabled', 'false');

    // spoken input through the real /stt
    await page.mouse.click(240, 120);
    await page.keyboard.down('Space');
    await page.waitForTimeout(2000);
    await page.keyboard.up('Space');
    await expect(page.locator('.msg-user.from-voice .msg-text')).toHaveText(SERVER_FAKE_TEXT, { timeout: 30_000 });

    // the reply is synthesized by the real /tts; visemes drive the mouth
    await page.waitForFunction(() => window.__app.player.current?.kind === 'audio', null, { timeout: 30_000 });
    const clip = await page.evaluate(() => {
      const c = window.__app.player.current.clip;
      return { visemes: c.visemes?.length || 0, first: c.visemes?.[0], text: c.text };
    });
    expect(clip.visemes).toBeGreaterThan(3);
    expect(clip.first).toMatchObject({ start: 0 });
    let maxJaw = 0;
    for (let i = 0; i < 20; i++) {
      maxJaw = Math.max(maxJaw, await page.evaluate(() => window.__app.avatar.animState().jawOpen));
      await page.waitForTimeout(40);
    }
    expect(maxJaw).toBeGreaterThan(0.1);
    await waitIdle(page, 60_000);
    // typed text is spoken too
    await send(page, 'hi');
    await page.waitForFunction(() => document.body.dataset.state === 'speaking', null, { timeout: 30_000 });
    await page.keyboard.press('Escape');
    await waitIdle(page);
  });
});
