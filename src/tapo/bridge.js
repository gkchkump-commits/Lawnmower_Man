// The Home camera window's bridge: window.lawnmowerCamera from electron/preload-camera.cjs in
// the app (contract §6.2), otherwise — or with ?mock=1 — the pretend camera of
// src/bridge/mock-tapo.js, so the window runs in a plain browser (vite dev, Playwright).
//
// Every tapo method takes the IPC payload of contract §6.1 as is: arm({ armed, immediate? }),
// savePreset({ name, token? }), removePreset({ token }), calibrate({ action, answer? }),
// events.remove({ id }), events.ack({ id }), ptz(PtzCommand), test(overrides?), …
//
// Mock URL parameters: ?scenario=online|setup|offline|auth|privacy|noptz|h265|calib-ask,
// &settings=<json> (tapo/security groups only) and &detector=mediapipe (the real person detector
// instead of the green-figure stub; in a plain browser MediaPipe's usage logger then tries to
// reach the internet, which the app's CSP blocks).
/* global URLSearchParams */

import { createMockCameraBridge } from '../bridge/mock-tapo.js';

const REQUIRED_TAPO = ['status', 'onStatus', 'ptz', 'presets', 'arm', 'requestPort'];

/** @param {any} b */
export function looksLikeCameraBridge(b) {
  return !!b && typeof b === 'object' && !!b.settings && !!b.tapo && REQUIRED_TAPO.every((k) => typeof b.tapo[k] === 'function');
}

/**
 * @param {{ search?: string, win?: any }} [o]
 * @returns {{ bridge: any, isMock: boolean }}
 */
export function getCameraBridge(o = {}) {
  const win = o.win ?? globalThis.window;
  const q = new URLSearchParams(o.search ?? win?.location?.search ?? '');
  const forceMock = ['1', 'true', 'yes'].includes(String(q.get('mock') || '').toLowerCase());
  if (!forceMock && looksLikeCameraBridge(win?.lawnmowerCamera)) return { bridge: win.lawnmowerCamera, isMock: false };
  if (!forceMock && win?.lawnmowerCamera) console.warn('[tapo] window.lawnmowerCamera is incomplete; using the mock camera');
  let settings = {};
  if (q.get('settings')) {
    try {
      settings = JSON.parse(q.get('settings') || '{}');
    } catch {
      console.warn('[tapo] ignoring invalid ?settings= JSON');
    }
  }
  const detector = q.get('detector') === 'mediapipe' ? 'mediapipe' : 'stub';
  return { bridge: createMockCameraBridge({ scenario: q.get('scenario') || 'online', win, settings, detector }), isMock: true };
}
