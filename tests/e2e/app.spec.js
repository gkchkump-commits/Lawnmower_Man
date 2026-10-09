/* global PointerEvent, getComputedStyle */
// End-to-end tests of the renderer app against `vite preview` with the mock bridge
// (src/bridge/mock.js). Chromium renders WebGL with SwiftShader (software), so the avatar runs
// at quality=low and viewports stay small. Screenshots go to $LM_SHOTS_DIR.

import { MOCK_REPLIES } from '../../src/bridge/mock.js';
import { boot, expect, headStats, send, shot, test, waitIdle } from './helpers.js';

test.describe('app (mock bridge)', () => {
  test('boots and renders the hologram', async ({ page }, testInfo) => {
    await boot(page);
    await expect(page.locator('body')).toHaveAttribute('data-env', 'browser');
    await expect(page.locator('body')).toHaveAttribute('data-boot', 'ready');
    await expect(page.locator('body')).toHaveAttribute('data-state', 'idle');
    await expect(page.locator('#stage canvas')).toHaveCount(1);
    expect(await page.evaluate(() => window.__app.avatar.renderer)).toBe('relief');
    await expect(page.locator('.status-claude')).toContainText('Claude');
    const stats = await headStats(page);
    expect(stats.mean, JSON.stringify(stats)).toBeGreaterThan(18);
    expect(stats.bright).toBeGreaterThan(0.15);
    expect(stats.warm).toBeGreaterThan(0.002);
    await page.waitForTimeout(600);
    await shot(page, testInfo, 'app-idle');
  });

  test('typing a message streams a reply; state goes thinking → speaking → idle', async ({ page }, testInfo) => {
    await boot(page, { mockDelay: 45 });
    await send(page, 'Hello there!');
    await expect(page.locator('.msg-user .msg-text')).toHaveText('Hello there!');
    await expect(page.locator('#input')).toHaveValue('');
    await expect(page.locator('body')).toHaveAttribute('data-state', 'thinking');
    // mid-reply
    await page.waitForFunction(() => document.querySelector('.msg-claude .md')?.textContent.split(' ').length > 8);
    await expect(page.locator('body')).toHaveAttribute('data-state', 'speaking');
    await expect(page.locator('.msg-claude')).toHaveClass(/streaming/);
    await shot(page, testInfo, 'app-mid-reply');
    await waitIdle(page);
    await expect(page.locator('.msg-claude .md')).toHaveText(MOCK_REPLIES.greeting);
    await expect(page.locator('.msg-claude')).not.toHaveClass(/streaming/);
    const states = await page.evaluate(() => window.__states);
    expect(states).toEqual(['idle', 'thinking', 'speaking', 'idle']);
  });

  test('renders Markdown safely and copies code', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page);
    const evil = '<img src=x onerror="window.__pwned=1"> **not bold** <script>window.__pwned=2</script>';
    await send(page, evil);
    await expect(page.locator('.msg-user .msg-text')).toHaveText(evil);
    await waitIdle(page);
    await send(page, 'show me some code');
    const block = page.locator('.msg-claude').last().locator('.code-block');
    await expect(block.locator('pre code')).toContainText('export function debounce', { timeout: 20_000 });
    await waitIdle(page);
    await expect(block.locator('.code-lang')).toHaveText('js');
    await expect(page.locator('.msg-claude').last().locator('.md p code')).toHaveText('debounce(save, 500)');
    expect(await page.locator('#transcript img, #transcript script').count()).toBe(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    await block.locator('.code-copy').click();
    await expect(block.locator('.code-copy')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('clearTimeout(timer);');
  });

  test('permission cards: allow and deny', async ({ page }, testInfo) => {
    await boot(page);
    await send(page, 'please run the tests');
    const card = page.locator('.perm-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator('.perm-tool')).toHaveText('Bash');
    await expect(card.locator('.perm-target')).toHaveText('npm test -- --reporter=dot');
    await expect(page.locator('body')).toHaveAttribute('data-attention', 'permission');
    await expect(page.locator('.tool-chip.running')).toBeVisible();
    await shot(page, testInfo, 'app-permission');
    await card.locator('.perm-allow').click();
    await expect(card).toHaveCount(0);
    await waitIdle(page);
    await expect(page.locator('.msg-claude').last()).toContainText(MOCK_REPLIES.toolAllowed);
    await expect(page.locator('.tool-chip.done')).toHaveCount(1);
    await expect(page.locator('.turn-note')).toHaveText('Allowed: Bash');
    await expect(page.locator('body')).toHaveAttribute('data-attention', '');

    await send(page, 'use a tool again');
    await expect(page.locator('.perm-card')).toBeVisible({ timeout: 20_000 });
    await page.locator('.perm-deny').click();
    await waitIdle(page);
    await expect(page.locator('.msg-claude').last()).toContainText(MOCK_REPLIES.toolDenied);
    await expect(page.locator('.tool-chip.failed')).toHaveCount(1);
  });

  test('interrupt: the stop button ends a long reply', async ({ page }) => {
    await boot(page, { mockDelay: 60 });
    await send(page, 'tell me a long story');
    await page.waitForFunction(() => (document.querySelector('.msg-claude .md')?.textContent || '').length > 20);
    await expect(page.locator('#send')).toHaveAttribute('data-mode', 'stop');
    await page.locator('#send').click();
    await waitIdle(page);
    await expect(page.locator('.msg-claude')).toHaveClass(/interrupted/);
    const text = await page.locator('.msg-claude .md').textContent();
    expect(text.length).toBeLessThan(MOCK_REPLIES.long.length);
  });

  test('errors show a toast and the app recovers', async ({ page }) => {
    await boot(page);
    await send(page, 'please simulate error');
    await expect(page.locator('.toast.error')).toContainText('Simulated failure', { timeout: 20_000 });
    await waitIdle(page);
    await expect(page.locator('.toast.error')).toHaveCount(1); // one error, one toast
    await expect(page.locator('.msg-claude.error .turn-error')).toContainText('Simulated failure');
    await send(page, 'hi');
    await waitIdle(page);
    await expect(page.locator('.msg-claude').last()).toContainText("I'm Claude");
  });

  test('settings drawer: switching the renderer re-creates the avatar', async ({ page }, testInfo) => {
    await boot(page);
    const gen0 = await page.evaluate(() => window.__app.avatarHost.generation);
    await page.locator('#btn-settings').click();
    const drawer = page.locator('#drawer');
    await expect(drawer).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-drawer', 'open');
    await shot(page, testInfo, 'app-settings');
    await drawer.locator('[data-path="avatar.renderer"] button[data-value="procedural"]').click();
    await page.waitForFunction((g) => window.__app.avatarHost.generation > g && window.__app.avatarReady && window.__app.avatar.renderer !== 'relief', gen0, { timeout: 45_000 });
    const renderer = await page.evaluate(() => window.__app.avatar.renderer);
    expect(['procedural', 'placeholder']).toContain(renderer);
    expect(await page.evaluate(() => window.__app.settings().avatar.renderer)).toBe('procedural');
    await expect(page.locator('#stage canvas')).toHaveCount(1);
    // other settings write through to the bridge
    await drawer.locator('[data-path="voice.speakReplies"] .switch').click();
    await expect.poll(() => page.evaluate(() => window.__app.settings().voice.speakReplies)).toBe(false);
    await drawer.locator('[data-path="window.sizePreset"] button[data-value="small"]').click();
    await expect.poll(() => page.evaluate(() => window.__app.settings().window.sizePreset)).toBe('small');
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    const stats = await headStats(page);
    expect(stats.bright, JSON.stringify(stats)).toBeGreaterThan(0.05);
    // and back to the relief head
    await page.locator('#btn-settings').click();
    await drawer.locator('[data-path="avatar.renderer"] button[data-value="relief"]').click();
    await page.waitForFunction(() => window.__app.avatar.renderer === 'relief', null, { timeout: 45_000 });
  });

  test('minimal mode: the panel drops down below the face when needed, never over it', async ({ page }) => {
    await boot(page);
    const stage = await page.locator('#stage').boundingBox();
    await page.locator('#btn-chat').click();
    await expect(page.locator('body')).toHaveAttribute('data-chat', 'minimal');
    expect(await page.evaluate(() => window.__app.settings().window.showChat)).toBe(false);
    // the avatar area keeps its size and place (no resize, no jump)
    expect(await page.locator('#stage').boundingBox()).toEqual(stage);
    await send(page, 'hi');
    await expect(page.locator('body')).toHaveAttribute('data-panel', 'shown');
    await expect.poll(() => page.locator('#panel').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    const panel = await page.locator('#panel').boundingBox();
    expect(panel.y).toBeGreaterThanOrEqual(stage.y + stage.height - 1); // below the avatar area
    await waitIdle(page);
    await page.locator('#btn-chat').click();
    await expect(page.locator('body')).toHaveAttribute('data-chat', 'full');
  });

  test('minimal mode: the folded strip below the face stays click-through (no unfolding, no click trap)', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 840 });
    await boot(page, { clickThrough: 1, layout: 'electron' }, { window: { showChat: false } });
    await expect(page.locator('body')).toHaveAttribute('data-chat', 'minimal');
    await expect(page.locator('body')).toHaveAttribute('data-panel', 'hidden', { timeout: 10_000 });
    const ignores = () => page.evaluate(() => window.__app.bridge.__mock.calls.filter((c) => c[0] === 'setIgnoreMouse').map((c) => c[1]));
    const box = await page.locator('#stage').boundingBox();
    // empty space beside the head first: click-through
    await page.mouse.move(box.x + 6, box.y + box.height * 0.5);
    await page.mouse.move(box.x + 8, box.y + box.height * 0.5);
    await expect.poll(async () => (await ignores()).at(-1)).toBe(true);
    // (the pointer near the face unfolded the panel: it folds again after its grace period)
    await expect(page.locator('body')).toHaveAttribute('data-panel', 'hidden', { timeout: 10_000 });
    const n = (await ignores()).length;
    // 60 px below the chin, over what looks like empty desktop
    for (let i = 0; i < 4; i++) await page.mouse.move(200 + i * 4, box.y + box.height + 60);
    await page.waitForTimeout(400);
    await expect(page.locator('body')).toHaveAttribute('data-panel', 'hidden');
    expect((await ignores()).slice(n)).not.toContain(false);
    // over the face the panel drops down as before
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4);
    await expect(page.locator('body')).toHaveAttribute('data-panel', 'shown');
  });

  test('hotkeys from main: toggleChat and stopSpeaking', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__app.bridge.__mock.hotkey('toggleChat'));
    await expect(page.locator('body')).toHaveAttribute('data-chat', 'minimal');
    await page.evaluate(() => window.__app.bridge.__mock.hotkey('toggleChat'));
    await expect(page.locator('body')).toHaveAttribute('data-chat', 'full');
    // without voice input, toggleListen explains how to enable it
    await page.evaluate(() => window.__app.bridge.__mock.hotkey('toggleListen'));
    await expect(page.locator('.toast')).toContainText('voice server');
    await expect(page.locator('#mic')).toHaveAttribute('aria-disabled', 'true');
  });

  test('click-through: transparent pixels pass clicks, the head and panel do not', async ({ page }) => {
    await boot(page, { clickThrough: 1 });
    const calls = () => page.evaluate(() => window.__app.bridge.__mock.calls.filter((c) => c[0] === 'setIgnoreMouse').map((c) => c[1]));
    const box = await page.locator('#stage').boundingBox();
    await page.mouse.move(box.x + 6, box.y + box.height * 0.5); // empty space left of the head
    await page.mouse.move(box.x + 8, box.y + box.height * 0.5);
    await expect.poll(calls).toEqual([false, true]);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4); // the face
    await expect.poll(calls).toEqual([false, true, false]);
    await page.mouse.move(box.x + 10, box.y + box.height + 60); // the chat panel
    await page.waitForTimeout(300);
    expect(await calls()).toEqual([false, true, false]);
  });

  test('moving the window: press on the head or the status bar drags; controls, empty space and a lock do not', async ({ page }) => {
    await boot(page, { clickThrough: 1 });
    const drags = () => page.evaluate(() => window.__app.bridge.__mock.calls.filter((c) => c[0] === 'dragStart' || c[0] === 'dragEnd').map((c) => c[0]));
    const ignores = () => page.evaluate(() => window.__app.bridge.__mock.calls.filter((c) => c[0] === 'setIgnoreMouse').map((c) => c[1]));
    const box = await page.locator('#stage').boundingBox();
    const face = { x: box.x + box.width / 2, y: box.y + box.height * 0.4 };

    await page.mouse.move(face.x, face.y);
    await expect(page.locator('body')).toHaveAttribute('data-over-head', '1');
    await page.mouse.down();
    await expect(page.locator('body')).toHaveAttribute('data-dragging', '1');
    // the pointer leaves the page mid-drag (the window moves under it): never click-through
    await page.mouse.move(box.x + 4, box.y + 4, { steps: 4 });
    await page.waitForTimeout(250);
    expect((await ignores()).at(-1)).toBe(false);
    await page.mouse.up();
    await expect.poll(drags).toEqual(['dragStart', 'dragEnd']);
    await expect(page.locator('body')).toHaveAttribute('data-dragging', '');

    // the status bar is a handle too
    const bar = await page.locator('#status').boundingBox();
    await page.mouse.move(bar.x + bar.width - 6, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(drags).toEqual(['dragStart', 'dragEnd', 'dragStart', 'dragEnd']);

    // toolbar buttons and transparent space never start a drag
    await page.locator('#btn-settings').click();
    await page.locator('.drawer-close').click();
    await page.mouse.move(box.x + 6, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.up();
    expect(await drags()).toEqual(['dragStart', 'dragEnd', 'dragStart', 'dragEnd']);

    // locked: pressing on the head does nothing, and the cursor no longer offers to grab
    await page.evaluate(() => window.__app.bridge.settings.set({ window: { lockPosition: true } }));
    await expect(page.locator('body')).toHaveAttribute('data-lock', '1');
    await page.mouse.move(face.x, face.y);
    await page.mouse.down();
    await page.mouse.up();
    expect(await drags()).toEqual(['dragStart', 'dragEnd', 'dragStart', 'dragEnd']);
  });

  test('a cancelled press (a touch scroll) does not keep the window from turning click-through', async ({ page }) => {
    await boot(page, { clickThrough: 1 });
    const ignores = () => page.evaluate(() => window.__app.bridge.__mock.calls.filter((c) => c[0] === 'setIgnoreMouse').map((c) => c[1]));
    const box = await page.locator('#stage').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4); // over the head: interactive
    await page.evaluate(() => {
      window.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0 }));
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 7, pointerType: 'touch', isPrimary: true }));
    });
    await page.mouse.move(box.x + 6, box.y + box.height * 0.5, { steps: 3 }); // transparent space
    await expect.poll(async () => (await ignores()).at(-1)).toBe(true);
  });

  test('Ctrl + mouse wheel over the head changes the size preset', async ({ page }) => {
    await boot(page);
    const sizes = () => page.evaluate(() => window.__app.bridge.__mock.calls.filter((c) => c[0] === 'setSizePreset').map((c) => c[1]));
    const box = await page.locator('#stage').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await expect.poll(sizes).toEqual(['large']);
    await page.mouse.wheel(0, -120); // without Ctrl: nothing
    await page.waitForTimeout(400);
    expect(await sizes()).toEqual(['large']);
  });
});

test.describe('voice (fake voice server)', () => {
  test('replies are spoken with lip-sync; Esc stops speaking', async ({ page }) => {
    await boot(page, { voice: 'fake', mockDelay: 30 });
    await expect(page.locator('.status-voice')).toHaveText('Voice · GPU');
    await expect(page.locator('#mic')).toHaveAttribute('aria-disabled', 'false');
    await send(page, 'tell me about holograms');
    await page.waitForFunction(() => document.body.dataset.state === 'speaking' && window.__app.player.current?.kind === 'audio', null, { timeout: 30_000 });
    let maxJaw = 0;
    for (let i = 0; i < 25; i++) {
      maxJaw = Math.max(maxJaw, await page.evaluate(() => window.__app.avatar.animState().jawOpen));
      await page.waitForTimeout(40);
    }
    expect(maxJaw).toBeGreaterThan(0.12);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__app.player.busy)).toBe(false);
    await waitIdle(page);
    const states = await page.evaluate(() => window.__states);
    expect(states.slice(0, 3)).toEqual(['idle', 'thinking', 'speaking']);
  });
});


test.describe('touch (mock bridge)', () => {
  test.use({ hasTouch: true });

  test('a finger on the head drags the window until it lifts; the handles take no pan gesture', async ({ page }) => {
    await boot(page);
    const drags = () => page.evaluate(() => window.__app.bridge.__mock.calls.filter((c) => c[0] === 'dragStart' || c[0] === 'dragEnd').map((c) => c[0]));
    expect(await page.evaluate(() => ['#avatar', '#status'].map((q) => getComputedStyle(document.querySelector(q)).touchAction))).toEqual(['none', 'none']);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#transcript')).touchAction)).toBe('auto');
    const box = await page.locator('#stage').boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height * 0.4;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 6, y: y + i * 4 }] });
    await page.waitForTimeout(150);
    expect(await drags()).toEqual(['dragStart']); // not cut short by a pointercancel
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(drags).toEqual(['dragStart', 'dragEnd']);
  });
});
