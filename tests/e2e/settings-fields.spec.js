// Settings drawer text fields the README points to: Claude work folder and CLI path, avatar pack.
import { boot, expect, test } from './helpers.js';

test.describe('settings drawer: work folder, CLI path, pack', () => {
  test('text fields write through; a cleared pack falls back to the default pack', async ({ page }) => {
    await boot(page);
    await page.locator('#btn-settings').click();
    const drawer = page.locator('#drawer');
    await expect(drawer).toBeVisible();

    const workdir = drawer.locator('#set-claude-workdir');
    await expect(workdir).toHaveAttribute('placeholder', /LawnmowerMan/);
    await workdir.fill('~/Projects/Hologram');
    await workdir.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__app.settings().claude.workdir)).toBe('~/Projects/Hologram');

    const cli = drawer.locator('#set-claude-cliPath');
    await expect(cli).toHaveAttribute('placeholder', 'Auto-detect');
    await cli.fill('  /opt/claude/bin/claude  ');
    await cli.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__app.settings().claude.cliPath)).toBe('/opt/claude/bin/claude');

    const pack = drawer.locator('#set-avatar-pack');
    await expect(pack).toHaveValue('reference');
    const gen = await page.evaluate(() => window.__app.avatarHost.generation);
    await pack.fill('   ');
    await pack.press('Enter');
    await expect(pack).toHaveValue('reference');
    expect(await page.evaluate(() => window.__app.settings().avatar.pack)).toBe('reference');
    expect(await page.evaluate(() => window.__app.avatarHost.generation)).toBe(gen); // no pointless avatar re-create
    await expect(page.locator('.toast.error')).toHaveCount(0);
  });
});
