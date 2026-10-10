// The camera in the browser preview (mock bridge) with Chromium's fake camera playing a frame of
// the reference video (docs/reference/neutral.jpg): the privacy card, the indicator, MediaPipe
// really finding the face, and the pictures that go to Claude ("Let Claude see me", the composer
// camera button). The fake-media flags are set for this file only (an extended launchOptions),
// so the other specs are unchanged.
/* global Image, localStorage, getComputedStyle */

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { QUICK_GREETINGS, quickGreeting } from '../../src/vision/index.js';
import { GL_ARGS, appUrl, boot, expect, send, shot, test as base, waitIdle } from './helpers.js';

const CONSENT_KEY = 'lawnmower.camera.consent.v1';
const REFERENCE = path.resolve('docs/reference/neutral.jpg');

/** A pattern for any of these exact lines, wherever they sit in the element's text. */
const anyLine = (lines) => new RegExp(lines.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
/** Every line of the first-sight hello, whatever the time of day. */
const FIRST_SIGHT = ['morning', 'afternoon', 'evening', 'night'].flatMap((k) => QUICK_GREETINGS[k]);
/** The first-sight lines of the time of day at these hours (the app picks one at random). */
const helloLines = (...hours) => [...new Set(hours.flatMap((hour) =>
  Object.values(QUICK_GREETINGS).find((list) => list.includes(quickGreeting({ first: true, awayMs: 0, hour, pick: () => 0 })))))];

/**
 * A one-frame 640x480 Y4M (what --use-file-for-fake-video-capture plays, looped) of the
 * reference frame, letterboxed on black like a person in front of a dark wall. Decoded and
 * converted in Chromium + Node, so no ffmpeg is needed.
 * @param {string} out
 */
async function makeFakeCamera(out) {
  const W = 640;
  const H = 480;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const jpeg = fs.readFileSync(REFERENCE).toString('base64');
    const rgba = await page.evaluate(async ({ jpeg, W, H }) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${jpeg}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
      const w = Math.round((img.width * H) / img.height);
      g.drawImage(img, Math.round((W - w) / 2), 0, w, H);
      return Array.from(g.getImageData(0, 0, W, H).data);
    }, { jpeg, W, H });
    // BT.601 limited range, 4:2:0
    const y = Buffer.alloc(W * H);
    const u = Buffer.alloc((W / 2) * (H / 2));
    const v = Buffer.alloc((W / 2) * (H / 2));
    for (let i = 0; i < W * H; i++) {
      const [r, g, b] = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
      y[i] = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
    }
    for (let cy = 0; cy < H / 2; cy++) {
      for (let cx = 0; cx < W / 2; cx++) {
        let r = 0, g = 0, b = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const i = ((cy * 2 + dy) * W + cx * 2 + dx) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2];
        }
        r /= 4; g /= 4; b /= 4;
        u[cy * (W / 2) + cx] = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
        v[cy * (W / 2) + cx] = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
      }
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F15:1 Ip A1:1 C420jpeg XCOLORRANGE=LIMITED\nFRAME\n`), y, u, v]));
  } finally {
    await browser.close();
  }
}

const test = base.extend({
  // worker-scoped, so the file exists before this worker's browser is launched with it
  fakeCamera: [async ({}, use, workerInfo) => {
    const file = path.join(workerInfo.project.outputDir, 'fake-camera', `neutral-${workerInfo.workerIndex}.y4m`);
    await makeFakeCamera(file);
    await use(file);
  }, { scope: 'worker' }],
  launchOptions: [async ({ launchOptions, fakeCamera }, use) => {
    await use({
      ...launchOptions,
      args: [...(launchOptions.args || GL_ARGS), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${fakeCamera}`],
    });
  }, { scope: 'worker' }],
});

/** The privacy card was accepted before (it is stored per PC). */
async function preConsent(page) {
  await page.addInitScript((key) => localStorage.setItem(key, 'yes'), CONSENT_KEY);
}

const faceSeen = (page) => page.waitForFunction(() => ['present', 'looking'].includes(document.body.dataset.face), null, { timeout: 45_000 });

test.describe('camera (fake camera, mock bridge)', () => {
  test('off by default; the privacy card comes first; MediaPipe finds the reference face', async ({ page }, testInfo) => {
    await boot(page);
    await expect(page.locator('body')).toHaveAttribute('data-camera', 'off');
    await expect(page.locator('#cam-live')).toBeHidden();
    await expect(page.locator('#shot')).toBeHidden();

    // toolbar button → the card explains before anything is opened
    await page.locator('#btn-camera').click();
    const card = page.locator('.camera-card[data-camera="consent"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('runs only on this PC');
    await expect(card).toContainText('Let Claude see me');
    await expect(page.locator('body')).toHaveAttribute('data-camera', 'consent');
    expect(await page.evaluate(() => window.__app.camera.camera.running)).toBe(false);
    await page.waitForTimeout(300); // the card fades in
    await shot(page, testInfo, 'camera-consent');

    const pageHour = () => page.evaluate(() => new Date().getHours());
    const hourBefore = await pageHour();
    await card.locator('.camera-accept').click();
    await expect(page.locator('body')).toHaveAttribute('data-camera', 'on', { timeout: 20_000 });
    await expect(page.locator('#cam-live')).toBeVisible(); // visible without hovering the toolbar
    await expect(page.locator('#btn-camera')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#shot')).toBeVisible();

    // the reference frame comes from a real face video: the landmarker finds it, in the worker
    await faceSeen(page);
    const st = await page.evaluate(() => window.__app.camera.status);
    expect(st).toMatchObject({ state: 'on', tracking: 'on', mode: 'worker', present: true });
    expect(st.frames).toBeGreaterThan(1);
    expect(st.rate).toBe(12);
    // eye contact: the gaze goes to the face (or one of its short glances away)
    await page.waitForFunction(() => ['face', 'glance'].includes(window.__app.gaze.source));
    // it sees you for the first time: a quick spoken hello (no Claude turn), one of the lines for
    // the time of day, picked at random (an hour boundary may pass while the camera starts)
    const hello = page.locator('#transcript .msg').last();
    await expect(hello).toContainText(anyLine(FIRST_SIGHT));
    await expect(hello).toContainText(anyLine(helloLines(hourBefore, await pageHour())));
    expect(await page.evaluate(() => window.__app.bridge.__mock.calls.filter((c) => c[0] === 'claude.send').length)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('lawnmower.camera.consent.v1'))).toBe('yes');
    await page.waitForTimeout(400);
    await shot(page, testInfo, 'camera-on');

    // Settings › Camera: live status and the camera in the device picker
    await page.locator('#btn-settings').click();
    // the drawer covers the light; its header shows that the camera runs
    const headerLight = () => page.evaluate(() => getComputedStyle(document.querySelector('.drawer-head h2'), '::after').content);
    expect(await headerLight()).toContain('camera');
    await page.waitForTimeout(300); // the drawer slides in
    await shot(page, testInfo, 'camera-drawer');
    const info = page.locator('[data-info="cameraInfo"]');
    await expect(info).toContainText('Face tracking: on this PC (worker');
    await expect(info).toContainText('You:');
    const devices = page.locator('#set-camera-deviceId option');
    await expect(devices.first()).toHaveText('Default camera');
    expect(await devices.count()).toBeGreaterThanOrEqual(2);
    await page.locator('.drawer-close').click();

    // the indicator turns it off; the camera is released
    await page.locator('#cam-live').click();
    await expect(page.locator('body')).toHaveAttribute('data-camera', 'off');
    await expect(page.locator('#cam-live')).toBeHidden();
    expect(await page.evaluate(() => window.__app.camera.camera.running)).toBe(false);
    expect(await page.evaluate(() => window.__app.bridge.__mock.settings().camera.enabled)).toBe(false);
  });

  test('"Not now" leaves the camera off', async ({ page }) => {
    await boot(page, {}, { camera: { enabled: true } });
    await page.locator('.camera-card .camera-decline').click();
    await expect(page.locator('body')).toHaveAttribute('data-camera', 'off');
    await expect(page.locator('.camera-card')).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.bridge.__mock.settings().camera.enabled)).toBe(false);
  });

  test('"Let Claude see me" sends a JPEG with every message; the camera button for one message', async ({ page }, testInfo) => {
    await preConsent(page);
    await boot(page, {}, { camera: { enabled: true, shareWithClaude: true } });
    await expect(page.locator('body')).toHaveAttribute('data-camera', 'on', { timeout: 20_000 });
    await expect(page.locator('#shot')).toHaveAttribute('aria-pressed', 'true'); // always on
    await faceSeen(page);

    await send(page, 'Can you see me?');
    await page.waitForFunction(() => window.__app.bridge.__mock.images().length === 1);
    const img = await page.evaluate(async () => {
      const [i] = window.__app.bridge.__mock.images();
      const el = new Image();
      el.src = `data:${i.mediaType};base64,${i.data}`;
      await el.decode();
      return { mediaType: i.mediaType, text: i.text, head: i.data.slice(0, 4), chars: i.data.length, w: el.naturalWidth, h: el.naturalHeight };
    });
    expect(img).toMatchObject({ mediaType: 'image/jpeg', text: 'Can you see me?', head: '/9j/', w: 640, h: 480 });
    expect(img.chars).toBeLessThan(1.5 * 1024 * 1024);
    // the transcript shows what was sent
    const user = page.locator('.msg-user').last();
    await expect(user.locator('.msg-shot')).toBeVisible();
    await expect(user.locator('.msg-shots figcaption')).toHaveText('sent to Claude');
    await waitIdle(page);
    await shot(page, testInfo, 'camera-sent');

    // "Let Claude see me" off: no picture any more…
    await page.evaluate(() => window.__app.bridge.settings.set({ camera: { shareWithClaude: false } }));
    await expect(page.locator('#shot')).toHaveAttribute('aria-pressed', 'false');
    await send(page, 'hello');
    await waitIdle(page);
    expect(await page.evaluate(() => window.__app.bridge.__mock.images().length)).toBe(1);
    await expect(page.locator('.msg-user').last().locator('.msg-shot')).toHaveCount(0);

    // …until the camera button arms one for the next message only
    await page.locator('#shot').click();
    await expect(page.locator('#shot')).toHaveAttribute('aria-pressed', 'true');
    await send(page, 'this one with a picture');
    await page.waitForFunction(() => window.__app.bridge.__mock.images().length === 2);
    await expect(page.locator('#shot')).toHaveAttribute('aria-pressed', 'false');
    await waitIdle(page);
    await send(page, 'and this one without');
    await waitIdle(page);
    const texts = await page.evaluate(() => window.__app.bridge.__mock.images().map((i) => i.text));
    expect(texts).toEqual(['Can you see me?', 'this one with a picture']);
  });

  test('camera settings appear in the drawer and the device picker keeps the default', async ({ page }) => {
    await page.goto(appUrl());
    await page.waitForFunction(() => window.__app?.ready);
    await page.locator('#btn-settings').click();
    const section = page.locator('[data-section="camera"]');
    await expect(section).toBeVisible();
    for (const label of ['Camera', 'Device', 'Eye contact', 'Notice when I leave', 'Smile back', 'Let Claude see me', 'Greet me', 'Listen only when I look']) {
      await expect(section.locator('.field-label', { hasText: label }).first()).toBeVisible();
    }
    await expect(section.locator('[data-path="camera.enabled"] .switch')).toHaveAttribute('aria-checked', 'false');
    // the greeting is on by default: the quick spoken hello
    await expect(section.locator('[data-path="camera.greeting"] button[data-value="hello"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#set-camera-deviceId')).toHaveValue('');
    // no camera light in the header while the camera is off
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.drawer-head h2'), '::after').content)).toBe('none');
  });

  test('a saved camera missing from the list: "Saved camera" while the camera is off, "(not connected)" once it is on', async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, 'yes'), CONSENT_KEY);
    await page.goto(appUrl({}, { camera: { deviceId: 'desk-camera-unplugged' } }));
    await page.waitForFunction(() => window.__app?.ready);
    await page.locator('#btn-settings').click();
    const saved = page.locator('#set-camera-deviceId option[value="desk-camera-unplugged"]');
    await expect(saved).toHaveText('Saved camera');
    await expect(page.locator('#set-camera-deviceId')).toHaveValue('desk-camera-unplugged');
    await page.locator('.drawer-close').click();
    await page.locator('#btn-camera').click();
    await expect(page.locator('body')).toHaveAttribute('data-camera', 'on', { timeout: 20_000 });
    await page.locator('#btn-settings').click();
    await expect(saved).toHaveText('Saved camera (not connected)');
  });
});
