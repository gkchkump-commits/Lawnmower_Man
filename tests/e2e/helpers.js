// Shared helpers for the Playwright specs: app URL (mock bridge, low quality), a fixture that
// fails every test on console errors, boot/send/wait helpers, head-area pixel statistics and
// screenshots (written to $LM_SHOTS_DIR, default test-results/screenshots).
/* global URLSearchParams, MutationObserver */

import { test as base, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export { expect };

const SHOTS = path.resolve(process.env.LM_SHOTS_DIR || 'test-results/screenshots');
export const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];

/** @param {Record<string, string|number>} [params] @param {object} [settings] */
export function appUrl(params = {}, settings = {}) {
  const s = { avatar: { quality: 'low' }, ...settings };
  const q = new URLSearchParams({ mock: '1', mockDelay: '18', mockFirst: '250', ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  q.set('settings', JSON.stringify(s));
  return `/index.html?${q}`;
}

// Every test fails on console errors or uncaught exceptions.
export const test = base.extend({
  consoleErrors: [async ({ page }, use) => {
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await use(errors);
    expect(errors, 'no console errors').toEqual([]);
  }, { auto: true }],
});

/** Open the app and wait until it is wired and the hologram exists. */
export async function boot(page, params, settings) {
  await page.goto(appUrl(params, settings));
  await page.waitForFunction(() => window.__app?.ready && window.__app?.avatarReady, null, { timeout: 45_000 });
  // record every body[data-state] change
  await page.evaluate(() => {
    window.__states = [document.body.dataset.state];
    new MutationObserver(() => {
      const s = document.body.dataset.state;
      if (window.__states[window.__states.length - 1] !== s) window.__states.push(s);
    }).observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
  });
}

export async function send(page, text) {
  await page.locator('#input').fill(text);
  await page.locator('#input').press('Enter');
}

export const waitIdle = (page, timeout = 30_000) => page.waitForFunction(() => document.body.dataset.state === 'idle' && !window.__app.controller.speech.busy && !window.__app.controller.activeTurnId, null, { timeout });

/** Brightness statistics of the head area of the avatar stage (decoded in the page). */
export async function headStats(page) {
  const png = await page.locator('#stage').screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    g.drawImage(img, 0, 0);
    const x0 = Math.round(img.width * 0.3);
    const x1 = Math.round(img.width * 0.7);
    const y0 = Math.round(img.height * 0.18);
    const y1 = Math.round(img.height * 0.62);
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let sum = 0;
    let bright = 0;
    let warm = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += l;
      if (l > 40) bright++;
      if (d[i] > 150 && d[i] > d[i + 2] + 30) warm++; // amber eyes / gold lines
    }
    const n = d.length / 4;
    return { mean: sum / n, bright: bright / n, warm: warm / n };
  }, png.toString('base64'));
}

export async function shot(page, testInfo, name) {
  mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
  return file;
}

