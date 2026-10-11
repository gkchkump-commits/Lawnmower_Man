// LIVE check of ClaudeSession against the real, logged-in Claude CLI (chat mode).
// Skipped by default; run with:  npm run test:live-claude   (or LIVE_CLAUDE=1 npx vitest run <this file>)
// Costs a couple of very short turns on the user's Claude account.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeSession } from '../../../electron/claude-session.js';
import { SERVER, cameraServer } from './camera-mcp-double.js';
import { tmpDir } from '../helpers/tmp.js';

const LIVE = !!process.env.LIVE_CLAUDE;

describe.skipIf(!LIVE)('ClaudeSession × real Claude CLI (LIVE_CLAUDE=1)', () => {
  // (the body is collected even when skipped: no folder then, nothing would remove it)
  const dir = LIVE ? tmpDir('lm-live-') : '';
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

// LIVE gate for the home camera tools (contract §3.1 step 4 / §10.4): does this CLI offer the
// app's in-process MCP server ("G1", initialize.sdkMcpServers) to the model in CHAT mode, with
// --tools "" and --strict-mcp-config? If not, ClaudeSession must switch to the loopback HTTP
// route ("G2") by itself and the second turn must reach the tool there. One or two short turns.
//   LIVE_CLAUDE=1 npx vitest run tests/unit/systems/claude-live.test.js -t "camera tools"
// LIVE_CLAUDE_REPORT=<file> also writes the findings there as JSON (vitest hides the console
// output of a passing test). Result on 2026-10-10 with Claude Code 2.1.296: G1 works in chat
// mode; the model called mcp__lawnmower-camera__camera_status in the first turn.
describe.skipIf(!LIVE)('camera tools × real Claude CLI in chat mode (LIVE_CLAUDE=1)', () => {
  it('the camera tools reach the model (in-process, or over loopback HTTP after one turn)', async () => {
    const dir = tmpDir('lm-live-mcp-');
    const word = `OKAPI-${Math.floor(Math.random() * 900 + 100)}`;
    const cam = cameraServer({ http: true, statusText: `Front door camera: online, disarmed. Status code word: ${word}.` });
    const settings = { cliPath: process.env.LIVE_CLAUDE_CLI || '', model: process.env.LIVE_CLAUDE_MODEL || '', effort: '', mode: 'chat', workdir: path.join(dir, 'work'), persona: '', resumeLastSession: false, lastSessionId: '' };
    const events = [];
    const logs = [];
    const session = new ClaudeSession({
      getSettings: () => settings,
      personaDir: path.join(dir, 'persona'),
      onSessionId: (id) => { settings.lastSessionId = id; },
      getSdkMcpServers: () => [cam.server],
      getToolPermissions: () => ({ allow: [`mcp__${SERVER}__camera_status`, `mcp__${SERVER}__camera_events`], deny: [] }),
      getPersonaContext: () => ({ camera: { name: 'front door camera', canSee: true, canMove: true } }),
      log: (level, msg) => { logs.push(`${level} ${msg}`); if (level !== 'debug') console.log(`[${level}] ${msg}`); },
    });
    session.on('event', (e) => events.push(e));
    const turn = async (/** @type {string} */ text) => {
      const { turnId } = await session.send(text);
      const t0 = Date.now();
      let end;
      while (!(end = events.find((e) => e.type === 'turn_end' && e.turnId === turnId))) {
        if (Date.now() - t0 > 150000) throw new Error(`timeout: ${JSON.stringify(events.slice(-5))}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      return { end, text: events.filter((e) => e.type === 'text_delta' && e.turnId === turnId).map((e) => e.text).join('') };
    };
    const ask = 'Please call the camera_status tool once and tell me the status code word it reports, in one short sentence.';
    try {
      await session.start();
      const first = await turn(ask);
      const sessionEv = events.filter((e) => e.type === 'session').at(-1);
      const g1 = (sessionEv?.tools || []).includes(`mcp__${SERVER}__camera_status`);
      console.log(`CLI ${session.status().cliVersion}: in-process tools offered in chat mode: ${g1}; tools=${JSON.stringify(sessionEv?.tools)}`);
      console.log(`TURN 1 (${first.end.durationMs} ms): ${JSON.stringify(first.text)}`);
      console.log(`mcp calls: ${cam.calls.map((m) => m.method + (m.params?.name ? `:${m.params.name}` : '')).join(', ')}`);
      if (process.env.LIVE_CLAUDE_REPORT) {
        fs.writeFileSync(process.env.LIVE_CLAUDE_REPORT, JSON.stringify({
          cliVersion: session.status().cliVersion, inProcessToolsInChatMode: g1, tools: sessionEv?.tools, reply: first.text,
          answeredWithWord: first.text.toUpperCase().includes(word), mcpCalls: cam.calls.map((m) => m.method + (m.params?.name ? `:${m.params.name}` : '')),
        }, null, 1));
      }
      if (g1) {
        expect(first.end.isError).toBe(false);
        expect(first.text.toUpperCase()).toContain(word);
        expect(cam.state.starts).toBe(0);
        return;
      }
      // G2: ClaudeSession noticed and restarts with --mcp-config after this turn
      expect(logs.some((l) => /serving them over loopback HTTP/.test(l))).toBe(true);
      const second = await turn(ask);
      const after = events.filter((e) => e.type === 'session').at(-1);
      console.log(`TURN 2 over HTTP (${second.end.durationMs} ms): ${JSON.stringify(second.text)}; tools=${JSON.stringify(after?.tools)}`);
      expect(cam.state.starts).toBeGreaterThan(0);
      expect(after.tools).toContain(`mcp__${SERVER}__camera_status`);
      expect(second.text.toUpperCase()).toContain(word);
    } finally {
      await session.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 360000);
});
