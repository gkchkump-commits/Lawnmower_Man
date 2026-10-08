// System-voice lip-sync end to end in the browser app (mock bridge): a fake speechSynthesis
// speaks the reply with word-boundary events, and the hologram's mouth must follow the words —
// the real WebSpeechTTS → AudioPlayer → LipSync → controller.tick → avatar path.
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
    await page.addInitScript(fakeVoice, { gapMs: 230, boundaries });
    await boot(page, { mockDelay: 8, mockFirst: 50 });
    await expect.poll(() => page.evaluate(() => window.__app.controller.tts.mode())).toBe('browser');
    await send(page, 'hello');
    await page.waitForFunction(() => document.body.dataset.state === 'speaking', null, { timeout: 30_000 });
    // speak for a while: the greeting has "I'm", "hologram", "me" (closures) and "floating" (f)
    await page.waitForFunction(() => window.__mouth.length > 60 && window.speechSynthesis.spoken.length >= 2, null, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => window.__mouth);
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
    await page.keyboard.press('Escape');
    await waitIdle(page);
    // at rest again
    await expect.poll(() => page.evaluate(() => window.__app.avatar.animState().jawOpen)).toBeLessThan(0.02);
  });
}
