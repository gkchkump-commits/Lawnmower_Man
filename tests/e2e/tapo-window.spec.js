// The Home camera window in the browser preview (contract §12.2), on the pretend camera of
// src/bridge/mock-tapo.js: real security worker, real stub detector, real shift estimator. Plus
// the avatar window's side: the drawer section, an alert, a local "camera left".
// Every test fails on console errors (helpers.js) and on any request that leaves 127.0.0.1.
/* global Element, Image, URLSearchParams, VideoDecoder */

import { appUrl, boot, expect, send, shot, test as base } from './helpers.js';

const test = base.extend({
  // nothing may leave the PC: every request is checked, the test fails on the first that does not
  // go to 127.0.0.1 (data: and blob: URLs never reach the network)
  blockedRequests: [async ({ page }, use) => {
    const blocked = [];
    await page.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if ((u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ws:' || u.protocol === 'wss:') && u.hostname !== '127.0.0.1') {
        blocked.push(u.href);
        return route.abort();
      }
      return route.continue();
    });
    await use(blocked);
    expect(blocked, 'requests that left the PC').toEqual([]);
  }, { auto: true }],
});

/** @param {Record<string, string>} [params] @param {object} [settings] tapo/security */
function camUrl(params = {}, settings) {
  const q = new URLSearchParams({ mock: '1', ...params });
  if (settings) q.set('settings', JSON.stringify(settings));
  return `/tapo/index.html?${q}`;
}

/** @param {import('@playwright/test').Page} page */
async function openCamera(page, params = {}, settings = undefined) {
  await page.setViewportSize({ width: 1100, height: 680 });
  await page.goto(camUrl(params, settings));
  await page.waitForFunction(() => document.body.dataset.boot === 'ready' && window.__tapoMock, null, { timeout: 30_000 });
}

/** The mock's PTZ log. @param {import('@playwright/test').Page} page */
const calls = (page) => page.evaluate(() => window.__tapoMock.calls.map((c) => ({ ...c, at: undefined })));
const clearCalls = (page) => page.evaluate(() => { window.__tapoMock.calls.length = 0; });

/** Mean brightness of the middle of the live view (decoded from a screenshot). */
async function liveBrightness(page) {
  const png = await page.locator('#live').screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    g.drawImage(img, 0, 0);
    const d = g.getImageData(Math.round(img.width * 0.2), Math.round(img.height * 0.3), Math.round(img.width * 0.4), Math.round(img.height * 0.3)).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (d.length / 4);
  }, png.toString('base64'));
}

/** Wait until the live view shows the camera's picture. */
async function waitLive(page) {
  await expect(page.locator('.live-placeholder')).toBeHidden({ timeout: 15_000 });
  await expect.poll(() => liveBrightness(page), { timeout: 15_000 }).toBeGreaterThan(30);
}

test.describe('Home camera window', () => {
  test('boots, shows the camera picture, and the worker reports frames', async ({ page }, testInfo) => {
    await openCamera(page);
    await waitLive(page);
    await expect(page.locator('.badge')).toHaveText('Online');
    await expect(page.locator('.arm')).toContainText('Disarmed');
    await expect.poll(() => page.evaluate(() => window.__tapo.workerStats()?.fps || 0), { timeout: 10_000 }).toBeGreaterThan(5);
    await expect(page.locator('#foot-stream')).toContainText('960×540');
    await expect(page.locator('.preset')).toHaveCount(3);
    await expect(page.locator('.event')).toHaveCount(2);
    await shot(page, testInfo, 'tapo-live');
  });

  test('D-pad: a click nudges, holding turns with heartbeats, releasing stops', async ({ page }) => {
    await openCamera(page);
    await waitLive(page);
    await clearCalls(page);
    await page.locator('.dpad-right').click();
    await expect.poll(async () => (await calls(page)).map((c) => c.op)).toEqual(['nudge']);
    expect((await calls(page))[0]).toMatchObject({ op: 'nudge', dir: 'right', amount: 'medium' });

    await clearCalls(page);
    const b = await page.locator('.dpad-up').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1000);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const ops = (await calls(page)).map((c) => c.op);
    expect(ops[0]).toBe('hold');
    expect((await calls(page))[0].dir).toBe('up');
    expect(ops.filter((o) => o === 'heartbeat').length).toBeGreaterThanOrEqual(2);
    expect(ops.at(-1)).toBe('release');
    expect(ops).not.toContain('nudge');

    await clearCalls(page);
    await page.locator('.dpad-home').click();
    await expect.poll(async () => (await calls(page)).map((c) => c.op)).toEqual(['home']);
  });

  test('keyboard: arrows, Shift for a big step, Home, preset keys', async ({ page }) => {
    await openCamera(page);
    await waitLive(page);
    await page.locator('.cam-name').click(); // focus the window, not a control
    await clearCalls(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Alt+ArrowUp');
    await page.keyboard.press('Home');
    await page.keyboard.press('1');
    await expect.poll(async () => (await calls(page)).length).toBe(5);
    expect((await calls(page)).map(({ op, dir, amount, token }) => ({ op, dir, amount, token }))).toEqual([
      { op: 'nudge', dir: 'right', amount: 'medium', token: undefined },
      { op: 'nudge', dir: 'left', amount: 'large', token: undefined },
      { op: 'nudge', dir: 'up', amount: 'small', token: undefined },
      { op: 'home', dir: undefined, amount: undefined, token: undefined },
      { op: 'preset', dir: undefined, amount: undefined, token: '1' },
    ]);
  });

  test('click-to-center: the point inside the letterboxed picture, bars excluded', async ({ page }) => {
    await openCamera(page);
    await waitLive(page);
    await clearCalls(page);
    const box = await page.locator('#live').boundingBox();
    // the mock's frames are 960×540: letterboxed into the view
    const k = Math.min(box.width / 960, box.height / 540);
    const vw = 960 * k;
    const vh = 540 * k;
    const vx = box.x + (box.width - vw) / 2;
    const vy = box.y + (box.height - vh) / 2;
    await page.mouse.click(vx + vw * 0.25, vy + vh * 0.3);
    await expect.poll(async () => (await calls(page)).length).toBe(1);
    const [c] = await calls(page);
    expect(c.op).toBe('center');
    expect(c.u).toBeCloseTo(0.25, 1);
    expect(c.v).toBeCloseTo(0.3, 1);
    expect(Math.abs(c.u - 0.25)).toBeLessThan(0.01);
    expect(Math.abs(c.v - 0.3)).toBeLessThan(0.01);
    // a click on a letterbox bar does nothing
    if (vy - box.y > 10) {
      await page.mouse.click(box.x + box.width / 2, box.y + 4);
      await page.waitForTimeout(400);
      expect(await calls(page)).toHaveLength(1);
    }
  });

  test('arming: Arming… 2 s → Armed; a person while armed: a box, an event, a toast', async ({ page }, testInfo) => {
    await openCamera(page);
    await waitLive(page);
    await page.locator('.arm').click();
    await expect(page.locator('.arm')).toContainText(/Arming… [12] s/);
    await expect(page.locator('.arm')).toContainText('Armed', { timeout: 4000 });
    await expect(page.locator('.arm')).toHaveAttribute('data-mode', 'armed');
    await page.evaluate(() => window.__tapoMock.person(true));
    await expect(page.locator('.live-box')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.live-box-label')).toContainText('Person 90%');
    await expect(page.locator('.event.live')).toBeVisible({ timeout: 8000 });
    // once it is a person, that toast replaces the movement one; the event happening now counts as new
    await expect(page.locator('.toast.warn')).toContainText('A person seen just now', { timeout: 8000 });
    await expect(page.locator('.toast', { hasText: 'Movement seen' })).toHaveCount(0);
    await expect(page.locator('#events .side-count')).toHaveText('2 new');
    await expect(page.locator('.rec')).toBeVisible();
    await shot(page, testInfo, 'tapo-armed-person');
    // the person leaves: the event ends and is listed with its clip
    await page.evaluate(() => window.__tapoMock.person(false));
    await expect(page.locator('.event.live')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.event')).toHaveCount(3);
    // disarm
    await page.locator('.arm').click();
    await expect(page.locator('.arm')).toHaveAttribute('data-mode', 'disarmed');
  });

  test('events: the player plays the clip; opening marks it as seen; delete asks first', async ({ page }) => {
    await openCamera(page);
    await waitLive(page);
    const first = page.locator('.event').first();
    await expect(first).toHaveClass(/unread/);
    await first.click();
    const dlg = page.locator('dialog#player');
    await expect(dlg).toBeVisible();
    const video = dlg.locator('video');
    await expect(video).toHaveAttribute('src', /tapo-sample\.webm$/);
    await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect(await video.evaluate((v) => v.duration)).toBeGreaterThan(3);
    await dlg.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(dlg).toBeHidden();
    await expect(page.locator('.event').first()).not.toHaveClass(/unread/);
    // delete: confirmed, gone
    await page.locator('.event').first().click();
    await page.locator('dialog#player').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).last().click();
    await expect(page.locator('.event')).toHaveCount(1);
  });

  test('setup: checks the form, shows a scripted connection test, saves and connects', async ({ page }, testInfo) => {
    await openCamera(page, { scenario: 'setup' });
    await expect(page.locator('#setup')).toBeVisible();
    await expect(page.locator('.setup-h')).toHaveText('Set up your camera');
    await expect(page.locator('.badge')).toHaveText('Not set up');
    // the checklist is ticked off locally
    await page.locator('#step-account').check();
    await expect(page.locator('.checklist .sec-note')).toHaveText('1 of 7 done');
    // validation
    await page.locator('#setup').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#tapo-set-host-error')).toContainText('Enter the camera’s address');
    await page.locator('#tapo-set-host').fill('http://192.168.1.50/');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.locator('#tapo-set-host-error')).toContainText('not a web link');
    await page.locator('#tapo-set-host').fill('8.8.8.8');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.locator('#tapo-set-host-error')).toContainText('not on your home network');
    // Find cameras fills the address
    await page.getByRole('button', { name: 'Find cameras' }).click();
    await page.locator('.found-cam').click();
    await expect(page.locator('#tapo-set-host')).toHaveValue('192.168.1.50');
    await page.locator('#tapo-set-username').fill('camacct');
    // fewer than 4 characters is refused, as main refuses it (updated on purpose: the UX review
    // found the form accepting what main then dropped)
    await page.locator('#tapo-set-password').fill('abc');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.locator('#tapo-set-password')).toHaveAttribute('aria-invalid', 'true');
    // an unusual password length is a note under the field, not a blocker
    await page.locator('#tapo-set-password').fill('abcd');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.locator('#tapo-set-password-error')).toHaveClass(/warn/);
    await expect(page.locator('#tapo-set-password-error')).toContainText('6 to 32 characters');
    await expect(page.locator('#tapo-set-password')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.report')).not.toHaveClass(/busy/);
    await page.locator('#tapo-set-password').fill('se&cret12');
    await expect(page.locator('#tapo-set-password-error')).toBeHidden();
    // a scripted report: the events step fails with a hint
    await page.evaluate(() => window.__tapoMock.scriptTest({
      ok: false,
      steps: [
        { id: 'host', label: 'Address', ok: true, detail: '192.168.1.50 is on your home network.' },
        { id: 'auth', label: 'Sign in', ok: true, detail: 'Signed in.' },
        { id: 'events', label: 'Motion and person events', ok: false, detail: 'The camera reports no person events.', hint: 'turn on motion and person detection in the Tapo app' },
        { id: 'rtsp', label: 'Video', ok: null, detail: 'Not checked.' },
      ],
    }));
    await page.getByRole('button', { name: 'Test connection' }).click();
    const report = page.locator('.report');
    await expect(report).toHaveClass(/fail/);
    await expect(report.locator('.report-step')).toHaveCount(4);
    await expect(report.locator('[data-step="events"]')).toHaveClass(/fail/);
    await expect(report.locator('[data-step="events"] .report-hint')).toHaveText('turn on motion and person detection in the Tapo app');
    await expect(report.locator('[data-step="rtsp"]')).toHaveClass(/skip/);
    await shot(page, testInfo, 'tapo-setup-report');
    // the password is never sent in a test unless typed; Save stores it and connects
    const test = (await calls(page)).find((c) => c.op === 'test');
    expect(test).toMatchObject({ host: '192.168.1.50', hasPassword: true });
    await page.locator('#setup').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#setup')).toBeHidden();
    await expect(page.locator('.badge')).toHaveText('Online', { timeout: 5000 });
    await waitLive(page);
    expect((await calls(page)).find((c) => c.op === 'set-credentials')).toMatchObject({ username: 'camacct', passwordLength: 9 });
    // the gear reopens it as "Camera settings"; the password field stays empty
    await page.locator('#btn-settings').click();
    await expect(page.locator('.setup-h')).toHaveText('Camera settings');
    await expect(page.locator('#tapo-set-password')).toHaveValue('');
    await expect(page.locator('#tapo-set-password')).toHaveAttribute('placeholder', /Saved/);
    // the saved password belongs to that address: a new address asks for it again
    await page.locator('#tapo-set-host').fill('192.168.1.51');
    await page.locator('#setup').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#tapo-set-password-error')).toContainText('Type the password again');
    expect((await page.evaluate(() => window.__tapo.settings().tapo)).host).toBe('192.168.1.50');
    await page.locator('#tapo-set-host').fill('192.168.1.50');
  });

  test('setup: "Copy diagnostic report" copies a redacted report, the camera does not move', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openCamera(page);
    await waitLive(page);
    await page.locator('#btn-settings').click();
    await clearCalls(page);
    await page.getByRole('button', { name: 'Copy diagnostic report' }).click();
    await expect(page.locator('.toast')).toContainText('diagnostic report was copied', { timeout: 10_000 });
    const text = await page.evaluate(() => navigator.clipboard.readText());
    const rep = JSON.parse(text);
    expect(rep.tool).toBe('lawnmower-diagnostics');
    expect(text).not.toMatch(/se&cret|camacct|192\.168\.1\.50/);
    expect((await calls(page)).map((c) => c.op).filter((op) => !['diagnostics', 'test'].includes(op))).toEqual([]);
  });

  test('calibration: the wizard measures the mirrored pan through the worker', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await openCamera(page);
    await waitLive(page);
    await expect(page.locator('.banner[data-banner="calibrate"]')).toBeVisible();
    await page.locator('.banner').getByRole('button', { name: 'Calibrate…' }).click();
    const dlg = page.locator('dialog#calibrate');
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(dlg).toHaveAttribute('data-step', /pan|tilt|min-step/);
    await expect(dlg).toHaveAttribute('data-step', 'done', { timeout: 60_000 });
    await expect(dlg).toContainText('Left and right are swapped');
    await shot(page, testInfo, 'tapo-calibrated');
    const t = await page.evaluate(() => window.__tapo.settings().tapo);
    expect(t.invertPan).toBe(true);
    expect(t.invertTilt).toBe(false);
    expect(t.viewUnitsX).toBeGreaterThan(0.6 * 0.75);
    expect(t.viewUnitsX).toBeLessThan(0.6 * 1.25);
    expect(t.calibratedAt).not.toBe('');
    await dlg.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(page.locator('.banner[data-banner="calibrate"]')).toHaveCount(0);
  });

  test('calibration: a featureless picture asks the user', async ({ page }) => {
    test.setTimeout(90_000);
    await openCamera(page, { scenario: 'calib-ask' });
    await waitLive(page);
    await page.locator('.banner').getByRole('button', { name: 'Calibrate…' }).click();
    const dlg = page.locator('dialog#calibrate');
    await dlg.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(dlg).toHaveAttribute('data-step', 'ask', { timeout: 30_000 });
    // the question main asks (about the camera), with only the answers for the axis it moved
    await expect(dlg).toContainText('Which way did the camera turn?');
    await expect(dlg.locator('[data-answer="up"], [data-answer="down"]')).toHaveCount(0);
    await expect(dlg.locator('[data-answer="left"]')).toHaveText('The camera turned left');
    // an answer for the other axis is not taken: still asking, the same question
    const st = await page.evaluate(() => window.__tapo.bridge.tapo.calibrate({ action: 'answer', answer: 'up' }));
    expect(st.step).toBe('ask');
    await expect(dlg).toHaveAttribute('data-step', 'ask');
    await dlg.locator('[data-answer="left"]').click(); // told to turn right, it turned left: mirrored
    await expect(dlg).toHaveAttribute('data-step', 'ask', { timeout: 30_000 });
    await expect(dlg).toContainText('Which way did the camera tilt?');
    await expect(dlg.locator('[data-answer="left"], [data-answer="right"]')).toHaveCount(0);
    await dlg.locator('[data-answer="down"]').click(); // told to tilt up, it tilted down: inverted
    await expect(dlg).toHaveAttribute('data-step', 'done', { timeout: 30_000 });
    const t = await page.evaluate(() => window.__tapo.settings().tapo);
    expect(t).toMatchObject({ invertPan: true, invertTilt: true });
  });

  test('offline, sign-in failed, privacy mode and an undecodable stream explain themselves', async ({ page }) => {
    await openCamera(page, { scenario: 'offline' });
    await expect(page.locator('.live-placeholder')).toContainText('The camera is offline');
    await expect(page.locator('.dpad')).toBeHidden();
    await expect(page.locator('.retry')).toBeVisible();
    // a long status line in the footer does not push the arm button (disarm!) out of the window
    await page.setViewportSize({ width: 640, height: 600 });
    await page.evaluate(() => { document.getElementById('foot-stream').textContent = 'x'.repeat(40) + ' The camera stopped answering. '.repeat(6); });
    const fit = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth, arm: document.querySelector('.arm').getBoundingClientRect().right }));
    expect(fit.scroll).toBeLessThanOrEqual(fit.inner);
    expect(fit.arm).toBeLessThanOrEqual(fit.inner);
    await page.setViewportSize({ width: 1100, height: 680 });
    await openCamera(page, { scenario: 'auth' });
    await expect(page.locator('.badge')).toHaveText('Sign-in failed');
    await expect(page.locator('.live-placeholder')).toContainText('does not keep retrying');
    await openCamera(page, { scenario: 'privacy' });
    await expect(page.locator('.badge')).toHaveText('Privacy mode?', { timeout: 5000 });
    await expect(page.locator('.live-placeholder')).toContainText('Turn privacy mode off in the Tapo app');
    // privacy mode is only a guess: the D-pad stays usable (the user may just have turned it off)
    await expect(page.locator('.dpad-right')).toBeEnabled();
    await clearCalls(page);
    await page.locator('.dpad-right').click();
    await expect.poll(async () => (await calls(page)).map((c) => c.op)).toEqual(['nudge']);
    await expect(page.locator('.toast.warn')).toContainText('privacy mode');
    await openCamera(page, { scenario: 'h265' });
    const hevc = await page.evaluate(async () => (await VideoDecoder.isConfigSupported({ codec: 'hvc1.1.6.L120.B0', codedWidth: 2304, codedHeight: 1296 }).catch(() => ({ supported: false }))).supported);
    if (!hevc) await expect(page.locator('.live-placeholder')).toContainText('cannot decode', { timeout: 10_000 });
  });

  test('help and full screen', async ({ page }) => {
    await openCamera(page);
    await waitLive(page);
    await page.locator('.cam-name').click();
    await page.keyboard.press('?');
    await expect(page.locator('dialog#help')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog#help')).toHaveCount(0);
    await page.locator('#live').dblclick({ position: { x: 300, y: 200 } });
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement || document.body.dataset.full === '1')).toBe(true);
    // the double-click did not also turn the camera
    expect((await calls(page)).filter((c) => c.op === 'center')).toHaveLength(0);
    // F leaves it again
    await page.keyboard.press('f');
    await expect.poll(() => page.evaluate(() => !document.fullscreenElement && document.body.dataset.full !== '1')).toBe(true);
  });

  test('full screen that answers late (after the 1 s fallback) is left completely by F', async ({ page }) => {
    await openCamera(page);
    await waitLive(page);
    // the window manager takes 1.5 s to say yes (Electron on a slow desktop)
    await page.evaluate(() => {
      const real = Element.prototype.requestFullscreen;
      Element.prototype.requestFullscreen = function slow(...a) {
        return new Promise((resolve, reject) => setTimeout(() => real.apply(this, a).then(resolve, reject), 1500));
      };
    });
    await page.locator('.cam-name').click();
    await page.keyboard.press('f');
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement), { timeout: 5000 }).toBe(true);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.body.dataset.full)).not.toBe('1'); // the fallback gave way
    await page.keyboard.press('f');
    await expect.poll(() => page.evaluate(() => !document.fullscreenElement && document.body.dataset.full !== '1')).toBe(true);
    await expect(page.locator('.arm')).toBeVisible();
    await page.locator('.arm').click({ trial: true }); // nothing covers the header
  });
});

test.describe('the avatar and the Home camera', () => {
  const settings = { tapo: { enabled: true, host: '192.168.1.50', username: 'camacct' } };

  test('drawer section, arming through main, an alert said and looked at, "camera left" handled locally', async ({ page }, testInfo) => {
    await boot(page, {}, settings);
    await page.locator('#btn-settings').click();
    const sec = page.locator('[data-section="tapo"]');
    await sec.scrollIntoViewIfNeeded();
    await expect(sec.locator('h3')).toHaveText('Home camera');
    await expect(sec.locator('[data-info="tapoInfo"]')).toContainText('Camera: online · disarmed', { timeout: 5000 });
    // arming goes through tapo.arm (the exit delay), not a plain settings change
    await sec.locator('[data-path="security.armed"] button[data-value="true"]').click();
    await expect(sec.locator('[data-info="tapoInfo"]')).toContainText('arming');
    expect(await page.evaluate(() => window.__app.bridge.__mock.tapo.calls.filter((c) => c.op === 'arm').map((c) => c.armed))).toEqual([true]);
    // describing alerts asks first; "Not now" leaves it off
    await sec.locator('#set-security-describe').click();
    await page.locator('.tapo-consent').getByRole('button', { name: 'Not now' }).click();
    expect(await page.evaluate(() => window.__app.settings().security.describe)).toBe(false);
    await page.locator('#btn-settings').click();
    await page.locator('[data-section="tapo"]').getByRole('button', { name: 'Open camera window…' }).click();
    expect(await page.evaluate(() => window.__app.bridge.__mock.calls.some((c) => c[0] === 'tapo.openWindow'))).toBe(true);
    await expect(page.locator('.status-armed')).toBeVisible({ timeout: 5000 });

    // an alert: the line in the transcript, the eyes turn toward the camera window (left)
    await page.evaluate(() => window.__app.bridge.__mock.tapoAlert({ kind: 'person' }));
    await expect(page.locator('#transcript')).toContainText('Someone is at the camera.');
    const gaze = await page.evaluate(() => ({ source: window.__app.gaze.source, target: window.__app.gaze.target }));
    expect(gaze.source).toBe('cursor');
    expect(gaze.target[0]).toBeLessThan(-0.5);
    await shot(page, testInfo, 'tapo-avatar-alert');

    // "camera left": the user's bubble, the confirmation, no Claude turn
    await send(page, 'camera left');
    await expect(page.locator('#transcript')).toContainText('Turning left.');
    expect(await page.evaluate(() => window.__app.bridge.__mock.tapo.calls.filter((c) => c.op === 'nudge').map((c) => c.dir))).toEqual(['left']);
    expect(await page.evaluate(() => window.__app.controller.turns.size)).toBe(0);
    await expect(page.locator('#transcript')).not.toContainText('You said');
    // anything else still goes to Claude
    await send(page, 'hello there');
    await expect(page.locator('#transcript')).toContainText("I'm Claude", { timeout: 15_000 });
  });

  test('without the Home camera turned on, the commands go to Claude and the section is short', async ({ page }) => {
    await page.goto(appUrl());
    await page.waitForFunction(() => window.__app?.ready, null, { timeout: 45_000 });
    await page.locator('#btn-settings').click();
    const sec = page.locator('[data-section="tapo"]');
    await expect(sec.locator('[data-path="security.armed"]')).toBeHidden();
    await expect(sec.locator('[data-info="tapoInfo"]')).toContainText('Off');
    await page.locator('.drawer-close').click();
    await send(page, 'camera left');
    await expect(page.locator('#transcript')).toContainText('You said', { timeout: 15_000 });
  });
});
