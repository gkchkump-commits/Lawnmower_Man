// The voice character in the browser app (mock bridge + in-page fake voice server): the drawer's
// Character and Intensity controls reach the effect on the audio thread, a spoken reply really
// goes through it (and the lip-sync still moves), and 'natural' bypasses it.
import { VOICE_FX_HINT } from '../../src/ui/settings-drawer.js';
import { boot, expect, send, test, waitIdle } from './helpers.js';

/** The effect's own report from the AudioWorklet. */
const stats = (page) => page.evaluate(() => window.__app.player.fxStats());

test.describe('voice character (fake voice server)', () => {
  test('the drawer control changes the preset on the audio thread; replies go through it; natural bypasses it', async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page, { voice: 'fake', mockDelay: 20 }, { avatar: { quality: 'low', particles: 0, bloom: 0 } });
    await expect(page.locator('.status-voice')).toHaveText('Voice · GPU');
    // the default character loads at start-up, off the critical path
    await expect.poll(() => page.evaluate(() => window.__app.player.voiceFx)).toEqual({ character: 'synth', amount: 0.6, state: 'ready', active: true });

    await page.locator('#btn-settings').click();
    const drawer = page.locator('#drawer');
    const character = drawer.locator('#set-voice-character');
    await expect(character).toHaveValue('synth');
    await expect(drawer.locator('[data-path="voice.character"] .field-hint')).toHaveText(VOICE_FX_HINT.server);
    await expect(drawer.locator('[data-path="voice.fxAmount"] output')).toHaveText('60%');

    // Robot: saved, handed to the player, and confirmed by the processor itself
    await character.selectOption('robot');
    await expect.poll(() => page.evaluate(() => window.__app.settings().voice.character)).toBe('robot');
    await expect.poll(() => page.evaluate(() => window.__app.player.voiceFx.character)).toBe('robot');
    await expect.poll(async () => (await stats(page))?.character).toBe('robot');

    // Intensity
    const amount = drawer.locator('#set-voice-fxAmount');
    await amount.fill('0.85');
    await amount.dispatchEvent('change');
    await expect.poll(() => page.evaluate(() => window.__app.settings().voice.fxAmount)).toBeCloseTo(0.85, 5);
    await expect.poll(async () => (await stats(page))?.amount).toBeCloseTo(0.85, 5);
    await drawer.locator('.drawer-close').click();

    // a spoken reply is processed on the audio thread: changed audio, pitch from the clip analysis
    const before = await stats(page);
    await send(page, 'tell me about holograms');
    await page.waitForFunction(() => document.body.dataset.state === 'speaking' && window.__app.player.current?.kind === 'audio', null, { timeout: 30_000 });
    let maxJaw = 0;
    for (let i = 0; i < 25; i++) {
      maxJaw = Math.max(maxJaw, await page.evaluate(() => window.__app.avatar.animState().jawOpen));
      await page.waitForTimeout(40);
    }
    expect(maxJaw).toBeGreaterThan(0.12); // the lip-sync (dry analyser) is unaffected
    const buffer = await page.evaluate(() => {
      const b = window.__app.player.current?.buffer;
      return b ? { rate: b.sampleRate, length: b.length } : null;
    });
    expect(buffer?.rate).toBe(24000);
    expect(buffer?.length).toBeGreaterThan(1000);
    await waitIdle(page, 60_000);
    const during = await stats(page);
    expect(during.blocks - before.blocks).toBeGreaterThan(100);
    // the robot changed the voice: the difference is as large as the voice itself
    const rel = (during.diffSq - before.diffSq) / (during.inSq - before.inSq);
    expect(rel).toBeGreaterThan(0.3);
    expect(during.failed).toBe(false);
    // the carrier's pitch came from the clip's look-ahead analysis, not the lagging live tracker
    expect((during.clipBlocks - before.clipBlocks) / (during.blocks - before.blocks)).toBeGreaterThan(0.8);

    // Natural: the intensity means nothing; the next reply bypasses the effect
    await page.locator('#btn-settings').click();
    await character.selectOption('natural');
    await expect(drawer.locator('[data-path="voice.fxAmount"]')).toHaveClass(/disabled/);
    await expect(amount).toBeDisabled();
    await expect.poll(() => page.evaluate(() => window.__app.player.voiceFx.active)).toBe(false);
    await drawer.locator('.drawer-close').click();
    // let the robot's tail die away (the processor counts blocks with input only)
    await page.waitForTimeout(400);
    const quiet = await stats(page);
    await send(page, 'tell me about holograms');
    await page.waitForFunction(() => document.body.dataset.state === 'speaking' && window.__app.player.current?.kind === 'audio', null, { timeout: 30_000 });
    await page.waitForTimeout(600);
    expect((await stats(page)).blocks).toBe(quiet.blocks);
    await page.keyboard.press('Escape');
    await waitIdle(page);
  });

  test('with the system voice the drawer says the character applies to the local voice', async ({ page }) => {
    await boot(page); // no local voice: the browser's speech synthesis speaks
    await expect.poll(() => page.evaluate(() => window.__app.controller.tts.mode())).not.toBe('server');
    await page.locator('#btn-settings').click();
    await expect(page.locator('#drawer [data-path="voice.character"] .field-hint')).toHaveText(VOICE_FX_HINT.system);
    // choosing a character still works (it is used once the local voice runs)
    await page.locator('#set-voice-character').selectOption('vocoder');
    await expect.poll(() => page.evaluate(() => window.__app.player.voiceFx.character)).toBe('vocoder');
  });
});
