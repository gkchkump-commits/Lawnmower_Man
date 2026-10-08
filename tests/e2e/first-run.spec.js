// First run on a clean PC (mock bridge): the Claude CLI is missing or not logged in → a setup
// card with the official install commands, Copy buttons and Retry; "Set up local voice…" in
// the drawer; the system-voice picker while the local voice is not running.
import { MOCK_NOT_LOGGED_IN, MOCK_SETUP_TAIL } from '../../src/bridge/mock.js';
import { CLAUDE_INSTALL } from '../../src/app/setup-help.js';
import { boot, expect, send, shot, test, waitIdle } from './helpers.js';

/** Fake Web Speech voices (headless Chromium has none on Linux). */
const FAKE_VOICES = [
  { name: 'Microsoft David - English (United States)', lang: 'en-US', voiceURI: 'Microsoft David - English (United States)', localService: true, default: true },
  { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US', voiceURI: 'Microsoft Aria Online (Natural) - English (United States)', localService: false, default: false },
  { name: 'Microsoft Hedda - German (Germany)', lang: 'de-DE', voiceURI: 'Microsoft Hedda - German (Germany)', localService: true, default: false },
];

/** @param {import('@playwright/test').Page} page @param {{ late?: boolean }} [o] */
async function fakeSpeech(page, o = {}) {
  await page.addInitScript(({ voices, late }) => {
    const listeners = new Set();
    let list = late ? [] : voices;
    const synth = {
      paused: false,
      speaking: false,
      getVoices: () => list,
      addEventListener: (t, cb) => { if (t === 'voiceschanged') listeners.add(cb); },
      removeEventListener: (t, cb) => listeners.delete(cb),
      speak: (u) => { window.__spoken = [...(window.__spoken || []), { text: u.text, voice: u.voice?.name }]; setTimeout(() => u.onend?.(), 5); },
      cancel: () => {},
      resume: () => {},
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
    // voices arrive asynchronously, like in Chromium
    if (late) setTimeout(() => { list = voices; for (const cb of listeners) cb(); }, 700);
  }, { voices: FAKE_VOICES, late: !!o.late });
}

test.describe('first run: Claude CLI', () => {
  test('missing CLI: card with the install commands, Copy, and Retry finds it', async ({ page, context }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page, { claude: 'missing', claudeRetries: 1 });
    const card = page.locator('.setup-card[data-setup="cli-missing"]');
    await expect(card).toBeVisible();
    await expect(card.locator('.setup-title')).toHaveText('Install Claude Code');
    await expect(page.locator('.status-claude')).toHaveText('Claude not installed');
    const platform = await page.evaluate(() => window.__app.bridge.__mock && navigator.userAgent.includes('Windows') ? 'win32' : 'linux');
    const methods = CLAUDE_INSTALL[platform];
    const codes = card.locator('.setup-code');
    await expect(codes.first()).toHaveText(methods[0].command);
    await expect(card).toContainText('never runs these commands');
    await expect(card.locator('.setup-link')).toHaveAttribute('href', 'https://code.claude.com/docs/en/setup');
    // the login step and the other install methods
    await expect(card.locator('.setup-steps .setup-code').nth(1)).toHaveText('claude');
    await card.locator('.setup-more summary').click();
    for (const m of methods.slice(1)) await expect(card.locator('.setup-more .setup-code', { hasText: m.command })).toBeVisible();

    // Copy puts the command on the clipboard
    await card.locator('.setup-copy').first().click();
    await expect(page.locator('.toast.success')).toContainText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(methods[0].command);
    await expect(card).toHaveCSS('opacity', '1');
    await shot(page, testInfo, 'first-run-cli-missing');

    // a message cannot be sent yet, and says why
    await send(page, 'hello?');
    await expect(page.locator('.toast.error')).toContainText('not installed yet');

    // Retry #1: still missing (the card stays), Retry #2: found
    const retry = card.locator('.setup-retry');
    await retry.click();
    await expect(page.locator('.toast.warn')).toContainText('Still not found');
    await expect(card).toBeVisible();
    await retry.click();
    await expect(page.locator('.setup-card')).toHaveCount(0);
    await expect(page.locator('.status-claude')).not.toHaveText(/not installed/);
    await expect(page.locator('.toast.success', { hasText: 'Claude Code is ready' })).toBeVisible();
    expect(await page.evaluate(() => window.__app.bridge.__mock.calls.filter((c) => c[0] === 'claude.retry').length)).toBe(2);
    await send(page, 'hello again');
    await waitIdle(page);
    await expect(page.locator('.msg-claude .md').last()).toContainText('Hello!');
  });

  test('not logged in: the sign-in card instead of an error toast; Retry after login', async ({ page }, testInfo) => {
    await boot(page, { claude: 'auth' });
    await expect(page.locator('.setup-card')).toHaveCount(0); // only a turn reveals it, like the real CLI
    await send(page, 'hi');
    const card = page.locator('.setup-card[data-setup="auth"]');
    await expect(card).toBeVisible();
    await expect(card.locator('.setup-title')).toHaveText('Sign in to Claude Code');
    await expect(card.locator('.setup-detail')).toContainText(MOCK_NOT_LOGGED_IN);
    await expect(card.locator('.setup-code')).toHaveText('claude');
    await expect(card).toContainText('ANTHROPIC_API_KEY');
    await expect(page.locator('.status-claude')).toHaveText('Claude: sign in');
    await waitIdle(page);
    await expect(page.locator('.toast.error')).toHaveCount(0);
    await expect(card).toHaveCSS('opacity', '1'); // fade-in done (slow under SwiftShader)
    await shot(page, testInfo, 'first-run-not-logged-in');

    await card.locator('.setup-retry').click();
    await expect(page.locator('.setup-card')).toHaveCount(0);
    await send(page, 'hello');
    await waitIdle(page);
    await expect(page.locator('.msg-claude .md').last()).toContainText('Hello!');
  });
});

test.describe('first run: local voice', () => {
  test('"Set up local voice…" in the drawer and in the voice hint shows the command when no window can be opened', async ({ page, context }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page);
    await page.locator('#btn-settings').click();
    const drawer = page.locator('#drawer');
    const button = drawer.locator('[data-action="setupVoice"]');
    await expect(button).toHaveText('Set up local voice…');
    // the hint under the voice status offers the same action
    await expect(drawer.locator('[data-info="voiceInfo"] .setup-voice-inline')).toBeVisible();
    await button.click();
    await expect(drawer).toBeHidden();
    const card = page.locator('.setup-card[data-setup="voice-manual"]');
    await expect(card).toBeVisible();
    await expect(card.locator('.setup-code')).toHaveText(/setup-voice\.(sh|ps1)$/);
    await expect(card).toHaveCSS('opacity', '1');
    await card.locator('.setup-copy').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/setup-voice/);
    expect(await page.evaluate(() => window.__app.bridge.__mock.calls.some((c) => c[0] === 'voice.setup'))).toBe(true);
    await shot(page, testInfo, 'first-run-voice-manual');
    await card.getByRole('button', { name: 'Close' }).last().click();
    await expect(card).toHaveCount(0);
    // the voice status repeats the setup state (health polls): a closed card stays closed …
    await page.evaluate(async () => {
      const b = window.__app.bridge;
      b.__mock.emitVoice(await b.voice.info());
    });
    await page.waitForTimeout(300);
    await expect(card).toHaveCount(0);
    // … until the user asks for the setup again
    await page.locator('#btn-settings').click();
    await drawer.locator('[data-action="setupVoice"]').click();
    await expect(card).toBeVisible();
  });

  test('a failed setup: the drawer shows pip\'s last lines (monospace, scrollable, copyable), "Open setup log" and "Set up local voice again…"', async ({ page, context }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page, { voiceSetup: 'failed' });
    await page.locator('#btn-settings').click();
    const drawer = page.locator('#drawer');
    const info = drawer.locator('[data-info="voiceInfo"]');
    await expect(info).toContainText('Local voice is not fully installed (missing: uvicorn)');
    await expect(info).toContainText('— ERROR: No matching distribution found for example-wheel>=1.0'); // the one-line summary
    const box = info.locator('.setup-tail');
    const pre = box.locator('pre');
    await expect(pre).toHaveText(MOCK_SETUP_TAIL.join('\n'));
    expect(await pre.evaluate((el) => window.getComputedStyle(el).fontFamily)).toMatch(/mono|Consolas/i);
    expect(await pre.evaluate((el) => window.getComputedStyle(el).userSelect)).toBe('text');
    // about 12 lines high at most; with more lines it scrolls and opens at the end (pip's ERROR line)
    await page.evaluate(async () => {
      const b = window.__app.bridge;
      const v = await b.voice.info();
      v.setup.errorTail = Array.from({ length: 20 }, (_, i) => (i === 19 ? 'ERROR: the last line of the output' : `line ${i + 1} of the output`));
      b.__mock.emitVoice(v);
    });
    await expect(pre).toContainText('line 1 of the output');
    const geo = await box.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const t = el.querySelector('pre').firstChild;
      const range = document.createRange();
      const i = t.data.indexOf('ERROR: the last line');
      range.setStart(t, i);
      range.setEnd(t, i + 6);
      const last = range.getBoundingClientRect();
      return { height: r.height, scrollable: el.scrollHeight > el.clientHeight + 20, lastVisible: last.top >= r.top && last.bottom <= r.bottom + 1 };
    });
    expect(geo.height).toBeLessThanOrEqual(12 * 14 + 12);
    expect(geo.scrollable).toBe(true);
    expect(geo.lastVisible).toBe(true);
    await expect(info.locator('.setup-log-path')).toContainText(/Setup log: .*setup\.log/);
    await shot(page, testInfo, 'voice-setup-failed-tail');

    // "Open setup log": main opens it; the renderer passes nothing
    await info.locator('.open-setup-log').click();
    await expect.poll(() => page.evaluate(() => window.__app.bridge.__mock.calls.filter((c) => c[0] === 'voice.openSetupLog'))).toEqual([['voice.openSetupLog']]);
    // "Copy": the summary, the lines and where the log is, for a bug report
    await info.locator('.copy-setup-tail').click();
    await expect(page.locator('.toast.success', { hasText: 'Copied the setup error' })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/^The voice setup failed: Command failed \(exit 1\)/);
    expect(copied).toContain('ERROR: the last line of the output');
    expect(copied).toMatch(/Setup log: .*setup\.log$/);
    // and the way out is still there
    await expect(drawer.locator('[data-action="setupVoice"]')).toHaveText('Set up local voice again…');
    await expect(drawer.locator('[data-action="setupVoice"]')).toBeEnabled();
  });

  test('no setup log and no failure: no output box, no "Open setup log"', async ({ page }) => {
    await boot(page);
    await page.locator('#btn-settings').click();
    const info = page.locator('#drawer [data-info="voiceInfo"]');
    await expect(info).toBeVisible();
    await expect(info.locator('.setup-tail')).toHaveCount(0);
    await expect(info.locator('.open-setup-log')).toHaveCount(0);
  });

  test('system voice picker: lists the Web Speech voices (loaded late), saves the choice, falls back when it is gone', async ({ page }) => {
    await fakeSpeech(page, { late: true });
    await boot(page);
    await page.locator('#btn-settings').click();
    const drawer = page.locator('#drawer');
    const sys = drawer.locator('#set-voice-systemVoice');
    await expect(sys).toBeVisible();
    await expect(drawer.locator('[data-path="voice.ttsVoice"]')).toBeHidden(); // the Kokoro list needs the server
    await expect(sys.locator('option')).toHaveCount(4); // Automatic + 3, after voiceschanged
    const labels = await sys.locator('option').allTextContents();
    expect(labels[0]).toMatch(/^Automatic/);
    expect(labels[1]).toMatch(/Aria/); // English, most natural first
    expect(labels[3]).toMatch(/Hedda/); // other languages last
    await expect.poll(() => page.evaluate(() => window.__app.webSpeech.voice?.name)).toMatch(/Aria/);

    await sys.selectOption(FAKE_VOICES[0].voiceURI);
    await expect.poll(() => page.evaluate(() => window.__app.settings().voice.systemVoice)).toBe(FAKE_VOICES[0].voiceURI);
    await expect.poll(() => page.evaluate(() => window.__app.webSpeech.voice?.name)).toBe(FAKE_VOICES[0].name);
    await expect(drawer.locator('[data-info="voiceInfo"]')).toContainText('Replies spoken with: system voice (Microsoft David');

    // a saved voice that is not installed: listed as such, the automatic choice speaks
    await page.evaluate(() => window.__app.bridge.settings.set({ voice: { systemVoice: 'Gone Voice' } }));
    await expect(sys).toHaveValue('Gone Voice');
    await expect(sys.locator('option', { hasText: 'Gone Voice (not installed)' })).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.__app.webSpeech.voice?.name)).toMatch(/Aria/);
    await expect(drawer.locator('[data-info="voiceInfo"]')).toContainText('is not installed; using the most natural one');
  });
});

test.describe('first run on Windows (user agent)', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' });

  test('the install card shows the PowerShell installer first, then WinGet, CMD and npm', async ({ page }, testInfo) => {
    await boot(page, { claude: 'missing' });
    const card = page.locator('.setup-card[data-setup="cli-missing"]');
    await expect(card).toBeVisible();
    await expect(card.locator('.setup-steps li').first()).toContainText('Open PowerShell and run:');
    await expect(card.locator('.setup-code').first()).toHaveText('irm https://claude.ai/install.ps1 | iex');
    await card.locator('.setup-more summary').click();
    await expect(card.locator('.setup-more .setup-code')).toHaveText([
      'winget install Anthropic.ClaudeCode',
      'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd',
      'npm install -g @anthropic-ai/claude-code',
    ]);
    await expect(card).toHaveCSS('opacity', '1');
    await shot(page, testInfo, 'first-run-cli-missing-windows');
  });
});
