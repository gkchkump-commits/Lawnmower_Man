// System-voice lip-sync end to end in the browser app (mock bridge): a fake speechSynthesis
// speaks the reply with word-boundary events, and the hologram's mouth must follow the words —
// the real WebSpeechTTS → AudioPlayer → LipSync → controller.tick → avatar path.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { boot, expect, send, test, waitIdle } from './helpers.js';

/**
 * Replace the page's speechSynthesis with a timer-driven fake voice: onstart after 60 ms, a
 * 'word' boundary (charIndex) every `gapMs`, onend after the last word.
 * @param {{ gapMs: number, boundaries: boolean }} o
 */
function fakeVoice(o) {
  const voices = [{ name: 'Microsoft David - English (United States)', lang: 'en-US', voiceURI: 'david', localService: true, default: true }];
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); };
  const synth = {
    paused: false,
    speaking: false,
    spoken: [],
    getVoices: () => voices,
    addEventListener() {},
    removeEventListener() {},
    resume() {},
    cancel() { for (const id of timers) clearTimeout(id); timers.clear(); this.speaking = false; },
    speak(u) {
      this.spoken.push(u.text);
      this.speaking = true;
      const starts = [...u.text.matchAll(/\S+/g)].map((m) => m.index);
      later(() => u.onstart?.({}), 60);
      if (o.boundaries) starts.forEach((ci, i) => later(() => u.onboundary?.({ name: 'word', charIndex: ci, charLength: 0 }), 60 + i * o.gapMs));
      later(() => { this.speaking = false; u.onend?.({}); }, 60 + starts.length * o.gapMs + 80);
    },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  // sample the avatar every frame once speaking starts
  window.__mouth = [];
  const tick = () => {
    const a = window.__app?.avatar?.animState?.();
    if (a && document.body.dataset.state === 'speaking') {
      window.__mouth.push({ t: performance.now(), jaw: a.jawOpen, press: a.mouthPress, tuck: a.mouthTuck, round: a.mouthRound, pitch: a.headPitch });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

for (const boundaries of [true, false]) {
  test(`system voice ${boundaries ? 'with' : 'without'} word boundaries: the mouth follows the words`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(fakeVoice, { gapMs: 230, boundaries });
    // no particles / bloom: more frames per second on software WebGL (CI runners can drop to a few fps)
    await boot(page, { mockDelay: 8, mockFirst: 50 }, { avatar: { quality: 'low', particles: 0, bloom: 0 } });
    await expect.poll(() => page.evaluate(() => window.__app.controller.tts.mode())).toBe('browser');
    await send(page, 'hello');
    await page.waitForFunction(() => document.body.dataset.state === 'speaking', null, { timeout: 30_000 });
    // Let the whole greeting play — it has "I'm", "hologram", "me" (closures) and "floating" (f).
    // Wait on the voice, not on a frame count: how many frames fit into it depends on the machine.
    await page.waitForFunction(() => window.speechSynthesis.spoken.length >= 4 && !window.speechSynthesis.speaking, null, { timeout: 60_000 });
    await waitIdle(page);
    // ...then Settings › Voice › Test lip-sync, a line full of m / b / p: at least once, and again
    // until 60 frames of speech were drawn. A sealed closure lasts ~0.1 s (about 1 frame in 7 of
    // this line lands on one, 1 in 13 of the greeting) and software WebGL may draw only a frame or
    // two a second, so judge enough frames, whatever the machine.
    await page.locator('#btn-settings').click();
    for (let i = 0; i < 8 && (i === 0 || (await page.evaluate(() => window.__mouth.length)) < 60); i++) {
      const before = await page.evaluate(() => window.speechSynthesis.spoken.length);
      await page.getByRole('button', { name: 'Test lip-sync' }).click();
      await page.waitForFunction((n) => {
        const s = window.speechSynthesis;
        return s.spoken.length > n && /muffins/.test(s.spoken.at(-1)) && !s.speaking;
      }, before, { timeout: 60_000 });
      await waitIdle(page);
    }
    await page.keyboard.press('Escape');
    const m = await page.evaluate(() => window.__mouth);
    expect(m.length).toBeGreaterThan(15); // sampled while speaking, even at a few fps
    const max = (k) => Math.max(...m.map((x) => x[k]));
    expect(max('jaw')).toBeGreaterThan(0.3);                    // it opens...
    expect(max('press')).toBeGreaterThan(0.75);                 // ...closes for m / b / p...
    expect(max('round')).toBeGreaterThan(0.3);                  // ...and rounds (o, oo)
    // ...and actually moves: many open/close cycles, not one held shape
    let cycles = 0;
    for (let i = 1; i < m.length; i++) if (m[i - 1].jaw < 0.12 && m[i].jaw >= 0.12) cycles++;
    expect(cycles).toBeGreaterThan(4);
    const spoken = await page.evaluate(() => window.speechSynthesis.spoken);
    expect(spoken[0]).toMatch(/^Hello!/);
    expect(spoken.join(' ')).toContain('Bob, pop by at five.');
    // at rest after the reply
    await expect.poll(() => page.evaluate(() => window.__app.avatar.animState().jawOpen)).toBeLessThan(0.02);

    // interrupted mid-reply: the mouth closes too
    await send(page, 'hello');
    await page.waitForFunction(() => document.body.dataset.state === 'speaking', null, { timeout: 30_000 });
    await page.waitForFunction((n) => window.speechSynthesis.spoken.length >= n + 2, spoken.length, { timeout: 30_000 });
    await page.keyboard.press('Escape');
    await waitIdle(page);
    await expect.poll(() => page.evaluate(() => window.__app.avatar.animState().jawOpen)).toBeLessThan(0.02);
  });
}

// Local voice on REAL speech in the browser: the avatar harness plays a Kokoro clip (the voice
// server's /tts output, tests/fixtures/kokoro) through the real LipSync, director and relief head
// (its new face rig compiled by Chromium): the lips close on m / b / p, the jaw opens with the
// syllables, the face regions and the head move, and it all rests afterwards.
test('local voice on a real Kokoro clip (avatar harness): mouth, face and head follow the audio', async ({ page }) => {
  test.setTimeout(120_000);
  const dir = path.resolve('tests/fixtures/kokoro');
  const json = JSON.parse(readFileSync(path.join(dir, 'maybe_af_heart.json'), 'utf8'));
  json.audioB64 = readFileSync(path.join(dir, 'maybe_af_heart.wav')).toString('base64');
  await page.route('**/__clips/0.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) }));
  await page.goto('/dev/avatar.html?ui=0&particles=0&quality=low&w=196&h=292&clip=__clips/0.json&t=0');
  await page.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 60_000 });
  expect(await page.evaluate(() => window.__error || null)).toBeNull();
  const track = await page.evaluate((dur) => {
    const out = [];
    for (let t = 0.02; t < dur + 0.8; t += 1 / 30) {
      window.__seek(t);
      const a = window.__avatar.animState();
      out.push({ t, jaw: a.jawOpen, press: a.mouthPress, cheek: a.cheekRaise, chin: a.chinRaise, nostril: a.nostrilFlare, pitch: a.headPitch, state: window.__avatar.state });
    }
    return out;
  }, json.durationSec);
  const max = (k) => Math.max(...track.map((x) => x[k]));
  expect(max('jaw')).toBeGreaterThan(0.45);
  expect(max('press')).toBeGreaterThan(0.75);
  expect(max('cheek')).toBeGreaterThan(0.2);
  expect(max('chin')).toBeGreaterThan(0.5);
  expect(max('nostril')).toBeGreaterThan(0.2);
  let cycles = 0;
  for (let i = 1; i < track.length; i++) if (track[i - 1].jaw < 0.15 && track[i].jaw >= 0.15) cycles++;
  expect(cycles).toBeGreaterThan(8);
  const pitches = track.filter((x) => x.state === 'speaking').map((x) => x.pitch);
  expect(Math.max(...pitches) - Math.min(...pitches)).toBeGreaterThan(0.02);
  const end = track[track.length - 1];
  expect(end.jaw).toBeLessThan(0.02);
  expect(end.state).toBe('idle');
});

// Settings › Voice › Lip-sync timing reaches the lip-sync, and Test lip-sync speaks its line, whose
// sound the acoustic analysis worker (src/audio/acoustics-worker.js) analyses in the browser.
test('lip-sync timing setting and test line; the clip\'s sound is analysed in the worker', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page, { voice: 'fake', mockDelay: 20 }, { avatar: { quality: 'low', particles: 0, bloom: 0 } });
  await page.locator('#btn-settings').click();
  const drawer = page.locator('#drawer');
  await expect(drawer.locator('[data-path="voice.lipSyncOffsetMs"] output')).toHaveText('0 ms');
  const slider = drawer.locator('#set-voice-lipSyncOffsetMs');
  await slider.fill('60');
  await slider.dispatchEvent('change');
  await expect.poll(() => page.evaluate(() => window.__app.settings().voice.lipSyncOffsetMs)).toBe(60);
  await expect.poll(() => page.evaluate(() => window.__app.controller.lipsync.offset)).toBeCloseTo(0.06, 9);
  await expect(drawer.locator('[data-path="voice.lipSyncOffsetMs"] output')).toHaveText('+60 ms (mouth later)');
  await drawer.locator('[data-action="testLipSync"]').click();
  await page.waitForFunction(() => window.__app.player.current?.kind === 'audio', null, { timeout: 30_000 });
  const done = await page.waitForFunction(() => {
    const lp = window.__app.controller.lipsync;
    const a = lp.analysis(window.__app.player.current?.clip);
    return a && a.final ? { ...a, failed: a.failed || lp.acoustics.failed } : null;
  }, null, { timeout: 20_000 });
  const a = await done.jsonValue();
  expect(a.failed).toBe(false);
  expect(a.frames).toBeGreaterThan(20);
  expect(a.frames).toBe(a.of);
  await expect(page.locator('#transcript')).toContainText('Bob, pop by at five');
  await waitIdle(page);
});
