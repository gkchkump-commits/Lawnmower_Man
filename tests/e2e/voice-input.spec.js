// Voice input end to end: Chromium's fake microphone plays a generated "speech-like" WAV and
// the mock voice server's STT returns a canned transcript for it. Launch options force a new
// browser, so this lives in its own file.

import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeWav } from '../../src/audio/wav.js';
import { FAKE_TRANSCRIPT } from '../../src/bridge/mock-voice.js';
import { GL_ARGS, boot, expect, test } from './helpers.js';

// an amplitude-modulated tone after 0.4 s of silence (looped by Chromium)
const SPEECH_WAV = path.join(os.tmpdir(), 'lawnmower-e2e-speech.wav');
{
  const rate = 48000;
  const x = new Float32Array(rate * 4);
  for (let i = 0; i < x.length; i++) {
    const t = i / rate;
    if (t < 0.4 || t > 3.4) continue;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    x[i] = (0.35 * env * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 720 * t) + 0.25 * Math.sin(2 * Math.PI * 1500 * t))) / 1.75;
  }
  writeFileSync(SPEECH_WAV, Buffer.from(encodeWav(x, rate)));
}

test.use({
  launchOptions: { args: [...GL_ARGS, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${SPEECH_WAV}`] },
  permissions: ['microphone'],
});

test.describe('voice input (fake microphone)', () => {
  test('hold Space to talk: listening → transcribing → thinking → reply', async ({ page }) => {
    await boot(page, { voice: 'fake' });
    await page.mouse.click(200, 120); // focus the page (not the input)
    await page.keyboard.down('Space');
    await expect(page.locator('body')).toHaveAttribute('data-state', 'listening');
    await expect(page.locator('body')).toHaveAttribute('data-listen', 'ptt');
    await page.waitForTimeout(2200);
    expect(await page.evaluate(() => window.__app.mic.level)).toBeGreaterThan(0.2);
    await page.keyboard.up('Space');
    await expect(page.locator('.msg-user.from-voice .msg-text')).toHaveText(FAKE_TRANSCRIPT, { timeout: 20_000 });
    await page.waitForFunction(() => document.body.dataset.state === 'speaking', null, { timeout: 30_000 });
    const states = await page.evaluate(() => window.__states);
    expect(states.slice(0, 5)).toEqual(['idle', 'listening', 'transcribing', 'thinking', 'speaking']);
  });
});
