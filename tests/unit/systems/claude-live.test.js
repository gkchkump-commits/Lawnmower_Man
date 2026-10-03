// LIVE check of ClaudeSession against the real, logged-in Claude CLI (chat mode).
// Skipped by default; run with:  npm run test:live-claude   (or LIVE_CLAUDE=1 npx vitest run <this file>)
// Costs a couple of very short turns on the user's Claude account.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeSession } from '../../../electron/claude-session.js';

const LIVE = !!process.env.LIVE_CLAUDE;

describe.skipIf(!LIVE)('ClaudeSession × real Claude CLI (LIVE_CLAUDE=1)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-live-'));
  const settings = {
    cliPath: process.env.LIVE_CLAUDE_CLI || '', model: process.env.LIVE_CLAUDE_MODEL || '', effort: '', mode: 'chat',
    workdir: path.join(dir, 'work'), persona: '', resumeLastSession: false, lastSessionId: '',
  };
  const events = [];
  const session = new ClaudeSession({
    getSettings: () => settings,
    personaDir: path.join(dir, 'persona'),
    onSessionId: (id) => { settings.lastSessionId = id; },
    log: (level, msg) => { if (level !== 'debug') console.log(`[${level}] ${msg}`); },
  });
  session.on('event', (e) => events.push(e));
  const turnEnd = (turnId, timeout = 150000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const e = events.find((x) => x.type === 'turn_end' && x.turnId === turnId);
        if (e) return resolve(e);
        if (Date.now() - t0 > timeout) return reject(new Error(`timeout: ${JSON.stringify(events.slice(-5))}`));
        setTimeout(tick, 100);
      };
      tick();
    });
  const textOf = (turnId) => events.filter((e) => e.type === 'text_delta' && e.turnId === turnId).map((e) => e.text).join('');

  afterAll(async () => {
    await session.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says hi, then remembers the first turn in the second', async () => {
    const t0 = Date.now();
    await session.start();
    const startedMs = Date.now() - t0;
    const st = session.status();
    console.log(`CLI: ${st.cliPath} (${st.cliVersion}); ready in ${startedMs} ms`);

    const a = await session.send('Hi! Please remember this code word for later: PINEAPPLE-42. Just say hi back briefly.');
    const endA = await turnEnd(a.turnId);
    const textA = textOf(a.turnId);
    console.log(`TURN 1 (${endA.durationMs} ms, $${endA.costUsd}): ${JSON.stringify(textA)}`);
    expect(endA.isError).toBe(false);
    expect(textA.length).toBeGreaterThan(0);
    expect(textA.trim()).toBe(endA.result.trim());
    expect(textA).not.toMatch(/^#|\n[-*] /); // spoken style: no markdown headings/bullets

    const b = await session.send('What was the code word I asked you to remember? Answer in one short sentence.');
    const endB = await turnEnd(b.turnId);
    const textB = textOf(b.turnId);
    console.log(`TURN 2 (${endB.durationMs} ms, $${endB.costUsd}): ${JSON.stringify(textB)}`);
    expect(endB.isError).toBe(false);
    expect(textB.toUpperCase()).toContain('PINEAPPLE-42');
    expect(endB.sessionId).toBe(endA.sessionId);

    const types = new Set(events.map((e) => e.type));
    for (const t of ['status', 'session', 'turn_start', 'text_delta', 'message_end', 'turn_end']) expect(types.has(t)).toBe(true);
    const sessionEv = events.find((e) => e.type === 'session');
    console.log(`session: ${JSON.stringify(sessionEv)}`);
    expect(sessionEv.tools).toEqual([]); // chat mode: no tools
    // Our own conversation, not one inherited from a parent Claude Code process.
    if (process.env.CLAUDE_CODE_SESSION_ID) expect(sessionEv.sessionId).not.toBe(process.env.CLAUDE_CODE_SESSION_ID);

    // Restart the process: a new ClaudeSession resumes the persisted session id (--resume).
    await session.stop();
    expect(settings.lastSessionId).toBe(endB.sessionId);
    const resumed = new ClaudeSession({
      getSettings: () => ({ ...settings, resumeLastSession: true }),
      personaDir: path.join(dir, 'persona'),
    });
    const evs2 = [];
    resumed.on('event', (e) => evs2.push(e));
    try {
      const c = await resumed.send('After a restart: what was that code word again? One short sentence.');
      const t0r = Date.now();
      let endC;
      while (!(endC = evs2.find((e) => e.type === 'turn_end' && e.turnId === c.turnId))) {
        if (Date.now() - t0r > 150000) throw new Error('timeout (resume)');
        await new Promise((r) => setTimeout(r, 100));
      }
      const textC = evs2.filter((e) => e.type === 'text_delta' && e.turnId === c.turnId).map((e) => e.text).join('');
      console.log(`TURN 3 after restart with --resume (${endC.durationMs} ms): ${JSON.stringify(textC)}`);
      expect(endC.isError).toBe(false);
      expect(endC.sessionId).toBe(endB.sessionId);
      expect(textC.toUpperCase()).toContain('PINEAPPLE-42');
    } finally {
      await resumed.stop();
    }
  }, 300000);
});
