// Bridge selection: the real preload API (window.lawnmower, contract §3) inside Electron,
// otherwise — or with ?mock=1 — the in-browser mock (src/bridge/mock.js).
//
// Mock URL parameters (browser dev / Playwright):
//   ?mock=1                      force the mock even inside Electron
//   &voice=fake                  in-page fake voice server (TTS with visemes, canned STT)
//   &voice=http://127.0.0.1:P&voiceToken=T   use a real voice server (e.g. --fake mode)
//   &mockDelay=<ms>              delay between streamed words (default 28)
//   &mockFirst=<ms>              delay before the first word (default 450)
//   &settings=<json>             initial settings patch, e.g. {"avatar":{"quality":"low"}}
//   &claude=missing|auth         simulate a missing / logged-out Claude CLI (setup cards)
//   &claudeRetries=<n>           that many Retry clicks fail before the mock "finds" the CLI
//   &voiceSetup=failed           start after a failed local-voice setup (output tail, "Open setup log")
/* global URLSearchParams */

import { createMockBridge } from './mock.js';

const REQUIRED = ['claude', 'voice', 'settings', 'window', 'app'];

/** @param {any} b */
function looksLikeBridge(b) {
  return !!b && typeof b === 'object' && REQUIRED.every((k) => b[k] && typeof b[k] === 'object') && typeof b.onHotkey === 'function';
}

/**
 * @param {{ search?: string, win?: any }} [o]
 * @returns {{ bridge: any, isMock: boolean }}
 */
export function getBridge(o = {}) {
  const win = o.win ?? globalThis.window ?? globalThis;
  const q = new URLSearchParams(o.search ?? win.location?.search ?? '');
  const forceMock = ['1', 'true', 'yes'].includes(String(q.get('mock') || '').toLowerCase());
  if (!forceMock && looksLikeBridge(win.lawnmower)) return { bridge: win.lawnmower, isMock: false };
  if (!forceMock && win.lawnmower) console.warn('[bridge] window.lawnmower is incomplete; using the mock bridge');
  /** @type {import('./mock.js').MockOptions} */
  const opts = {};
  const voice = q.get('voice');
  if (voice) opts.voice = voice;
  if (q.get('voiceToken')) opts.voiceToken = q.get('voiceToken') || '';
  const num = (k) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined);
  if (num('mockDelay') !== undefined) opts.wordDelayMs = num('mockDelay');
  if (num('mockFirst') !== undefined) opts.firstTokenMs = num('mockFirst');
  const claude = q.get('claude');
  if (claude === 'missing' || claude === 'auth') opts.claude = claude;
  if (num('claudeRetries') !== undefined) opts.claudeRetries = num('claudeRetries');
  if (q.get('voiceSetup') === 'failed') opts.voiceSetup = 'failed';
  if (q.get('settings')) {
    try {
      opts.settings = JSON.parse(q.get('settings') || '{}');
    } catch {
      console.warn('[bridge] ignoring invalid ?settings= JSON');
    }
  }
  const ua = String(win.navigator?.userAgent || '');
  opts.platform = /Windows/.test(ua) ? 'win32' : /Mac/.test(ua) ? 'darwin' : /Linux/.test(ua) ? 'linux' : 'browser';
  return { bridge: createMockBridge(opts), isMock: true };
}
