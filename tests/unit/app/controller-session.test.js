// The real ClaudeSession (driving tests/fixtures/fake-claude.mjs) wired into the real Controller,
// the way main + preload connect them, to check cross-process behaviour end to end.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ClaudeSession } from '../../../electron/claude-session.js';
import { Controller } from '../../../src/app/controller.js';
import { DEFAULT_SETTINGS, deepMerge } from '../../../src/app/settings-defaults.js';
import { fakeAvatar, fakeMic, fakePlayer, fakeStt, fakeTts, fakeView, tick, waitFor } from './helpers.js';

const FAKE = path.resolve('tests/fixtures/fake-claude.mjs');
const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function wire({ mode = 'chat' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ctrl-sess-'));
  const settings = { cliPath: '', model: '', effort: '', mode, workdir: path.join(dir, 'w'), persona: '', resumeLastSession: false, lastSessionId: '' };
  const session = new ClaudeSession({
    getSettings: () => settings,
    personaDir: path.join(dir, 'p'),
    cliPath: FAKE,
    env: { ...process.env, FAKE_CLAUDE_STATE_DIR: path.join(dir, 'st') },
    interruptTimeoutMs: 1500,
  });
  // main → renderer IPC: asynchronous, structured-cloned
  const ipc = new EventEmitter();
  const events = [];
  session.on('event', (e) => {
    events.push(e);
    setTimeout(() => ipc.emit('ev', structuredClone(e)), 0);
  });
  const bridge = {
    claude: {
      send: (t) => session.send(t),
      cancel: (id) => session.cancel(id),
      interrupt: () => session.interrupt(),
      reset: () => session.reset(),
      respondPermission: async (id, d) => session.respondPermission(id, d),
      status: async () => structuredClone(session.status()),
      onEvent: (cb) => {
        ipc.on('ev', cb);
        return () => ipc.off('ev', cb);
      },
    },
  };
  const view = fakeView();
  const avatar = fakeAvatar();
  const tts = fakeTts();
  const controller = new Controller({ bridge, view, avatar, tts, player: fakePlayer({ clipMs: 5 }), stt: fakeStt(), mic: fakeMic(), settings: deepMerge(DEFAULT_SETTINGS, {}), sleepAfterMs: 0 });
  cleanup.push(async () => {
    controller.dispose();
    await session.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { session, controller, view, avatar, tts, events, bridge };
}

describe('Controller + ClaudeSession', () => {
  it('tray "New conversation" during a reply is not reported as a failure (F7)', async () => {
    const { session, controller, view, avatar, events } = wire();
    await session.start();
    await controller.start();
    controller.sendText('slow please');
    await waitFor(() => events.some((e) => e.type === 'text_delta'), { timeout: 8000 });
    await session.reset(); // what trayActions.newConversation does — the renderer did not ask
    await tick(50);
    const end = events.find((e) => e.type === 'turn_end');
    expect(end).toMatchObject({ isError: true, interrupted: true });
    expect(view.of('toast').filter(([, level]) => level === 'error')).toEqual([]);
    expect(avatar.states).not.toContain('error');
    expect(view.of('clearTranscript')).toHaveLength(1);
  });

  it('Stop while a message waits behind a stopping turn: it never reaches the CLI (F2)', async () => {
    const { session, controller, view, tts, events } = wire();
    await session.start();
    await controller.start();
    // 'hang': the fake CLI ignores the interrupt, so the turn keeps "stopping" until the 1.5 s
    // fallback restarts it — a deterministic window in which the next message waits in main
    controller.sendText('hang on please');
    await waitFor(() => events.some((e) => e.type === 'text_delta'), { timeout: 8000 });
    controller.sendText('second question'); // pre-empts: interrupt + queued behind the stopping turn
    await waitFor(() => session.status().queue === 1, { timeout: 4000 });
    controller.interrupt(); // Stop
    await waitFor(() => events.some((e) => e.type === 'turn_cancelled'), { timeout: 4000 });
    await waitFor(() => controller.state === 'idle', { timeout: 8000 });
    const second = events.find((e) => e.type === 'turn_cancelled').turnId;
    expect(events.some((e) => e.type === 'turn_start' && e.turnId === second)).toBe(false);
    expect(view.of('markUserMessage')).toContainEqual([2, 'cancelled']);
    expect(tts.texts.join(' ')).not.toMatch(/second question/);
  });
});
