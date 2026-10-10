// "Hey Jade" in the browser (contract-wake §11.5): the mock bridge's wake namespace with its mock
// spotter (src/bridge/mock-wake.js), the fake voice server answering /stt from a queue (the wake
// segment first, then the command), the app's real Mic, controller, state machine and UI.
// Speech comes from a scripted microphone (tests/e2e/wake-helpers.js) where the timing matters,
// and from Chromium's fake capture device where the device itself is under test. Every test
// checks that no request leaves 127.0.0.1.

/* global MutationObserver */

import { GL_ARGS, appUrl, expect, shot, test } from './helpers.js';
import { fakeCaptureFile, loadClips, loopbackOnly, scriptedMicInit } from './wake-helpers.js';

const WAKE_ON = { wake: { enabled: true, explained: true } };

/**
 * Open the app with the wake word on (by default) and the scripted microphone.
 * @param {import('@playwright/test').Page} page
 * @param {{ params?: Record<string, string>, settings?: object, scripted?: boolean, micFail?: string }} [o]
 */
async function bootWake(page, o = {}) {
  const blocked = await loopbackOnly(page);
  await page.addInitScript(scriptedMicInit);
  if (o.scripted === false) await page.addInitScript(() => { window.__mic.scripted = false; });
  if (o.micFail) await page.addInitScript((f) => { window.__mic.fail = f; }, o.micFail);
  await page.goto(appUrl({ voice: 'fake', ...(o.params || {}) }, o.settings || WAKE_ON));
  await page.waitForFunction(() => window.__app?.ready && window.__app?.avatarReady, null, { timeout: 45_000 });
  await page.evaluate(() => {
    window.__wakes = [document.body.dataset.wake];
    window.__wakeAt = [[document.body.dataset.wake, performance.now()]];
    new MutationObserver(() => {
      const s = document.body.dataset.wake;
      if (window.__wakes.at(-1) !== s) {
        window.__wakes.push(s);
        window.__wakeAt.push([s, performance.now()]);
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['data-wake'] });
  });
  if (o.scripted !== false) await loadClips(page);
  return blocked;
}

const wakeIs = (page, state, timeout = 10_000) => expect(page.locator('body')).toHaveAttribute('data-wake', state, { timeout });
const userTexts = (page) => page.evaluate(() => [...document.querySelectorAll('.msg-user .msg-text')].map((e) => e.textContent));
const sttCalls = (page) => page.evaluate(() => window.__app.bridge.__mock.voiceStats().stt);
const say = (page, clip) => page.evaluate((c) => window.__mic.say(c), clip);
const queue = (page, list) => page.evaluate((l) => window.__app.bridge.__mock.sttQueue(l), list);
const logTexts = (page) => page.evaluate(() => window.__app.wake.log.map((e) => e.text));
const idleAgain = (page, timeout = 60_000) => page.waitForFunction(() => document.body.dataset.state === 'idle' && !window.__app.controller.speech.busy && !window.__app.controller.activeTurnId, null, { timeout });

// Chromium's fake capture device plays FILE (looped) for the tests that use the real
// getUserMedia(); the scripted ones never reach it
const FILE = fakeCaptureFile();
test.use({
  launchOptions: { args: [...GL_ARGS, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${FILE}`] },
  permissions: ['microphone'],
});

test.describe('Hey Jade (scripted microphone)', () => {
  test('2 · "Hey Jade, what time is it?": attention → listening, one chime, one message, a reply, the follow-up window, waiting', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const blocked = await bootWake(page);
    await wakeIs(page, 'waiting');
    await queue(page, ['Hey Jade.', 'what time is it?']);
    await page.evaluate(() => window.__wakeMock.arm());
    await say(page, 'oneBreath');
    await expect.poll(() => userTexts(page), { timeout: 15_000 }).toEqual(['what time is it?']);
    expect(await page.evaluate(() => window.__wakes.slice(0, 4))).toEqual(['waiting', 'attention', 'listening', 'busy']);
    const w = await page.evaluate(() => window.__wakeAt);
    console.log(`[measure] attention → listening (the check of the wake segment, fake /stt): ${Math.round(w[2][1] - w[1][1])} ms`);
    expect(await page.evaluate(() => window.__app.player.cues)).toBe(1);
    await expect(page.locator('.msg-claude').last()).toContainText('what time is it?', { timeout: 20_000 });
    // her reply ends → the follow-up window (no chime at open) → about 6 s → waiting
    await wakeIs(page, 'followup', 60_000);
    await shot(page, testInfo, 'wake-followup');
    await wakeIs(page, 'waiting', 10_000);
    // how long it lasted, from the page's own clock (the polling above is coarse)
    const at = await page.evaluate(() => window.__wakeAt);
    const i = at.findLastIndex((x) => x[0] === 'followup');
    expect(at[i + 1]?.[0]).toBe('waiting');
    const lasted = at[i + 1][1] - at[i][1];
    console.log(`[measure] follow-up window: ${Math.round(lasted)} ms (followUpSec 6)`);
    expect(lasted).toBeGreaterThan(5500);
    expect(lasted).toBeLessThan(6600);
    expect(await page.evaluate(() => window.__app.player.cues)).toBe(1);
    expect(await userTexts(page)).toEqual(['what time is it?']);
    expect(blocked).toEqual([]);
  });

  test('3 · "Hey Jade." … 1.5 s … "What\'s the weather tomorrow?": exactly one message, the command (END-2)', async ({ page }) => {
    const blocked = await bootWake(page);
    await wakeIs(page, 'waiting');
    await queue(page, ['Hey Jade.', "What's the weather tomorrow?"]);
    await page.evaluate(() => window.__wakeMock.arm());
    await say(page, 'pause');
    await expect.poll(() => userTexts(page), { timeout: 15_000 }).toEqual(["What's the weather tomorrow?"]);
    await page.waitForTimeout(1500);
    expect(await userTexts(page)).toEqual(["What's the weather tomorrow?"]);
    expect(await sttCalls(page)).toBe(2); // the wake segment and the command, nothing else
    expect(blocked).toEqual([]);
  });

  test('4 · "Hey Jade." and then silence: no message, no toast, back to waiting, "no command" (END-3)', async ({ page }) => {
    test.setTimeout(60_000);
    const blocked = await bootWake(page);
    await wakeIs(page, 'waiting');
    await queue(page, ['Hey Jade.']);
    await page.evaluate(() => window.__wakeMock.arm());
    await say(page, 'heyJade');
    await wakeIs(page, 'listening');
    await wakeIs(page, 'waiting', 12_000);
    expect(await userTexts(page)).toEqual([]);
    await expect(page.locator('.toast')).toHaveCount(0);
    expect(await logTexts(page)).toContain('no command after 8 s');
    expect(blocked).toEqual([]);
  });

  test('5 · "Hey Jude, don\'t make it bad.": no chime, no message, waiting ≤ 300 ms after the check (ACK-3)', async ({ page }) => {
    const blocked = await bootWake(page);
    await wakeIs(page, 'waiting');
    await queue(page, ["Hey Jude, don't make it bad."]);
    await page.evaluate(() => window.__wakeMock.arm());
    await say(page, 'oneBreath');
    await expect.poll(() => logTexts(page), { timeout: 10_000 }).toContain('ignored · sounded like “Hey Jude”');
    const at = await page.evaluate(() => window.__wakeAt);
    const att = at.find((x) => x[0] === 'attention');
    const back = at.find((x, i) => i > 0 && x[0] === 'waiting' && att && x[1] > att[1]);
    expect(att).toBeTruthy();
    expect(back).toBeTruthy();
    // the fake /stt answers after 60 ms; the attention lasted that, plus at most 300 ms
    console.log(`[measure] attention → waiting after a rejected check: ${Math.round(back[1] - att[1])} ms (the fake /stt takes 60 ms)`);
    expect(back[1] - att[1]).toBeLessThan(60 + 300 + 150);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__app.player.cues)).toBe(0);
    expect(await userTexts(page)).toEqual([]);
    await expect(page.locator('.toast')).toHaveCount(0);
    expect(blocked).toEqual([]);
  });

  test('6 · "Hey Jude" three times in a minute: the strict mode (TV-3)', async ({ page }) => {
    const blocked = await bootWake(page);
    await wakeIs(page, 'waiting');
    await page.evaluate(() => {
      for (let i = 0; i < 3; i++) window.__wakeMock.arm({ keyword: 'HEY_JUDE' });
    });
    for (let i = 0; i < 3; i++) {
      await say(page, 'heyJade');
      await page.waitForTimeout(900);
    }
    await expect(page.locator('body')).toHaveAttribute('data-wake-strict', '1', { timeout: 5000 });
    expect(await page.evaluate(() => window.__wakeMock.strict)).toBe(true); // the engine was told
    expect(await sttCalls(page)).toBe(0); // HEY_JUDE labels are not even checked
    expect(blocked).toEqual([]);
  });

  test('7 · a follow-up 2 s after her reply is sent without her name; at 6.5 s it is not (FUP-2)', async ({ page }) => {
    test.setTimeout(150_000);
    const blocked = await bootWake(page);
    await wakeIs(page, 'waiting');
    await queue(page, ['Hey Jade.', 'what time is it?']);
    await page.evaluate(() => window.__wakeMock.arm());
    await say(page, 'oneBreath');
    await wakeIs(page, 'followup', 60_000);
    await page.waitForTimeout(2000);
    await queue(page, ['And tomorrow?']);
    await say(page, 'followUp');
    await expect.poll(() => userTexts(page), { timeout: 15_000 }).toEqual(['what time is it?', 'And tomorrow?']);
    // that reply opens a new window (FUP-5); this time the user speaks too late
    await wakeIs(page, 'followup', 60_000);
    await page.waitForTimeout(6500);
    await queue(page, ['And the day after?']);
    await say(page, 'followUp');
    await page.waitForTimeout(2500);
    expect(await userTexts(page)).toEqual(['what time is it?', 'And tomorrow?']);
    await wakeIs(page, 'waiting');
    expect(blocked).toEqual([]);
  });

  test('8 · after a typed message no follow-up window opens (FUP-1)', async ({ page }) => {
    test.setTimeout(90_000);
    const blocked = await bootWake(page);
    await wakeIs(page, 'waiting');
    await page.locator('#input').fill('hello there');
    await page.locator('#input').press('Enter');
    await idleAgain(page);
    await page.waitForTimeout(600);
    await say(page, 'command');
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => window.__wakes)).not.toContain('followup');
    expect(await userTexts(page)).toEqual(['hello there']);
    expect(await sttCalls(page)).toBe(0); // speech without her name is never transcribed (PWR-2)
    expect(blocked).toEqual([]);
  });

  test('9 · her own voice saying "I\'m Jade" does not wake her (SELF-2)', async ({ page }) => {
    test.setTimeout(90_000);
    const blocked = await bootWake(page);
    await wakeIs(page, 'waiting');
    await page.locator('#input').fill('hello');
    await page.locator('#input').press('Enter');
    // the reply "Hello! I'm Jade, floating on your desktop…" is playing
    await page.waitForFunction(() => {
      const c = window.__app.player.current;
      return !!c && /\bJade\b/.test(c.clip?.text || '') && c.time > 0.7;
    }, null, { timeout: 30_000 });
    await page.evaluate(() => window.__wakeMock.hit());
    await expect.poll(() => logTexts(page), { timeout: 5000 }).toContain('ignored · my own voice');
    expect(await page.evaluate(() => window.__app.player.duckDb)).toBe(0);
    expect(await page.evaluate(() => window.__wakes)).not.toContain('barge');
    expect(await sttCalls(page)).toBe(0);
    expect(blocked).toEqual([]);
  });

  test('10 · "Hey Jade" during a long reply ducks her, stops her (the reply goes on in the chat), "stop" interrupts (BRG-2..4)', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    // the reply streams slowly (250 ms a word, ~25 s), so the turn is still running at "stop"
    const blocked = await bootWake(page, { params: { mockDelay: '250' } });
    await wakeIs(page, 'waiting');
    await page.locator('#input').fill('explain holograms');
    await page.locator('#input').press('Enter');
    await page.waitForFunction(() => {
      const c = window.__app.player.current;
      return !!c && c.time > 0.5 && !/\bJade\b/.test(c.clip?.text || '');
    }, null, { timeout: 30_000 });
    await queue(page, ['Hey Jade.', 'stop']);
    // the check of the wake segment takes 700 ms here, so the duck can be measured before it
    await page.evaluate(() => window.__app.bridge.__mock.sttDelay(700));
    const t0 = await page.evaluate(() => {
      window.__gain = [];
      const t = performance.now();
      const timer = setInterval(() => {
        window.__gain.push([performance.now() - t, window.__app.player.masterGainDb]);
        if (performance.now() - t > 1500) clearInterval(timer);
      }, 5);
      window.__wakeMock.hit();
      return t;
    });
    expect(t0).toBeGreaterThan(0);
    await expect(page.locator('body')).toHaveAttribute('data-wake', 'barge', { timeout: 1000 });
    await shot(page, testInfo, 'wake-barge');
    await page.waitForTimeout(1600);
    await page.evaluate(() => window.__app.bridge.__mock.sttDelay(0));
    const gain = await page.evaluate(() => window.__gain);
    // ≥ 10 dB down within 100 ms of the hit (LAT-4; the ramp is 60 ms to -15 dB)
    const ducked = gain.find(([, db]) => db < -10);
    expect(ducked, JSON.stringify(gain.slice(0, 30))).toBeTruthy();
    console.log(`[measure] her voice ≥ 10 dB down ${Math.round(ducked[0])} ms after the hit; at ${Math.round(gain.find(([, db]) => db <= -14.5)?.[0] ?? -1)} ms -15 dB`);
    expect(ducked[0]).toBeLessThan(100);
    // verified: she stops speaking; the reply keeps streaming into the chat
    await wakeIs(page, 'listening', 5000);
    expect(await page.evaluate(() => window.__app.controller.speech.busy)).toBe(false);
    expect(await page.evaluate(() => window.__app.player.cues)).toBe(1);
    const before = await page.locator('.msg-claude').last().innerText();
    await page.waitForTimeout(400);
    const after = await page.locator('.msg-claude').last().innerText();
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    // "stop": the turn is interrupted, nothing new for Claude
    expect(await page.evaluate(() => !!window.__app.controller.activeTurnId)).toBe(true);
    await say(page, 'heyJade');
    await page.waitForFunction(() => !window.__app.controller.activeTurnId, null, { timeout: 15_000 });
    expect(await userTexts(page)).toEqual(['explain holograms']);
    expect(await logTexts(page)).toContain('stopped her');
    await expect.poll(() => page.evaluate(() => window.__app.player.masterGainDb), { timeout: 3000 }).toBeGreaterThan(-1);
    expect(blocked).toEqual([]);
  });

  test('11 · the hotkey while waiting: listening now, with the chime (T13)', async ({ page }) => {
    const blocked = await bootWake(page);
    await wakeIs(page, 'waiting');
    await page.evaluate(() => window.__app.bridge.__mock.hotkey('toggleListen'));
    await wakeIs(page, 'listening', 3000);
    expect(await page.evaluate(() => window.__app.player.cues)).toBe(1);
    await expect(page.locator('.toast')).toHaveCount(0); // not the hands-free toast
    expect(await sttCalls(page)).toBe(0); // no verification for a key
    expect(blocked).toEqual([]);
  });

  test('13 · without the local voice: unavailable with the setup hint, and the mic is never opened', async ({ page }) => {
    const blocked = await bootWake(page, { params: { voice: 'off' } });
    await wakeIs(page, 'unavailable');
    await expect(page.locator('.status-wake')).toContainText('needs the local voice');
    await page.locator('#btn-settings').click();
    const info = page.locator('[data-info="wakeInfo"]');
    await expect(info).toBeVisible();
    await expect(info.locator('button[data-action="setupVoice"]')).toHaveText('Set up local voice…');
    expect(await page.evaluate(() => window.__mic.calls)).toBe(0);
    expect(await page.evaluate(() => window.__wakeMock.frames)).toBe(0);
    expect(blocked).toEqual([]);
  });

  test('13b · Windows blocks the microphone: a slashed chip, the reason and the settings button; quiet retries (WIN-1, WIN-2)', async ({ page }) => {
    test.setTimeout(60_000);
    const blocked = await bootWake(page, { params: { wake: 'blocked' }, micFail: 'NotReadableError' });
    await wakeIs(page, 'blocked');
    const chip = page.locator('.status-wake');
    await expect(chip).toContainText('Microphone blocked');
    await expect(chip).toHaveAttribute('data-tone', 'error');
    await expect(chip.locator('svg path')).toHaveCount(3); // the ear and its slash
    await page.locator('#btn-settings').click();
    const info = page.locator('[data-info="wakeInfo"]');
    await expect(info).toContainText('Windows is blocking the microphone for desktop apps');
    await expect(info.locator('button[data-action="wakeMicSettings"]')).toHaveText('Open Windows microphone settings');
    // the first quiet retry comes after 5 s; the mic works again → listening for her name
    const calls = await page.evaluate(() => window.__mic.calls);
    await page.evaluate(() => { window.__mic.fail = ''; });
    await wakeIs(page, 'waiting', 10_000);
    expect(await page.evaluate(() => window.__mic.calls)).toBe(calls + 1);
    await expect(page.locator('.toast')).toHaveCount(0); // retries are silent
    expect(blocked).toEqual([]);
  });

  test('14 · first boot: the offer card; Turn on sets wake.enabled and wake.explained', async ({ page }, testInfo) => {
    const blocked = await bootWake(page, { settings: {} });
    const card = page.locator('.wake-card');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('New: talk hands-free');
    await expect(card).toContainText('nothing is recorded or sent anywhere until you say my name');
    await shot(page, testInfo, 'wake-offer');
    await card.locator('button[data-wake-offer="on"]').click();
    await expect.poll(() => page.evaluate(() => window.__app.settings().wake)).toMatchObject({ enabled: true, explained: true });
    await expect(card).toHaveCount(0);
    await wakeIs(page, 'waiting');
    await expect(page.locator('.toast')).toHaveCount(0); // the card said it already
    expect(blocked).toEqual([]);
  });

  test('14b · "Not now" only remembers that it was explained', async ({ page }) => {
    const blocked = await bootWake(page, { settings: {} });
    await page.locator('.wake-card button[data-wake-offer="later"]').click();
    await expect.poll(() => page.evaluate(() => window.__app.settings().wake)).toMatchObject({ enabled: false, explained: true });
    await wakeIs(page, 'off');
    expect(await page.evaluate(() => window.__mic.calls)).toBe(0);
    expect(blocked).toEqual([]);
  });
});

test.describe('Hey Jade (Chromium fake microphone)', () => {
  test('1 · waiting: the engine gets the audio, nothing is transcribed (PWR-2)', async ({ page }) => {
    const blocked = await bootWake(page, { scripted: false });
    await wakeIs(page, 'waiting');
    const f0 = await page.evaluate(() => window.__wakeMock.frames);
    await page.waitForTimeout(6000);
    const f1 = await page.evaluate(() => window.__wakeMock.frames);
    // ~23 frames a second (2048 samples at 48 kHz → 683 at 16 kHz); speech in the file too
    expect(f1 - f0).toBeGreaterThan(100);
    expect(await page.evaluate(() => window.__wakeMock.onsets)).toBeGreaterThan(0);
    expect(await sttCalls(page)).toBe(0);
    expect(await page.evaluate(() => window.__wakeMock.badFrames)).toBe(0);
    // the all-apps echo canceller was asked for (Windows 11; elsewhere Chromium uses its own)
    expect(await page.evaluate(() => window.__mic.constraints[0].audio.echoCancellation)).toEqual({ ideal: 'all' });
    expect(blocked).toEqual([]);
  });

  test('12 · turning the wake word off ends the mic track within 1 s (PRIV-5)', async ({ page }) => {
    const blocked = await bootWake(page, { scripted: false });
    await wakeIs(page, 'waiting');
    await page.evaluate(() => { window.__track = window.__app.mic._stream.getAudioTracks()[0]; });
    expect(await page.evaluate(() => window.__track.readyState)).toBe('live');
    const t0 = Date.now();
    await page.evaluate(() => window.__app.bridge.settings.set({ wake: { enabled: false } }));
    await page.waitForFunction(() => window.__track.readyState === 'ended', null, { timeout: 1000 });
    expect(Date.now() - t0).toBeLessThan(1000);
    await wakeIs(page, 'off');
    expect(await page.evaluate(() => window.__app.player.cues)).toBe(1); // the micOff earcon
    expect(blocked).toEqual([]);
  });
});
