// The Home camera window (contract §9): bridge → settings + status → the security worker (it
// decodes and draws the video and detects people) → the live view, D-pad, keyboard, presets,
// events, setup and calibration.
//
// Frames never pass through this page: main hands a MessagePort to the preload, the preload
// posts it to this window, and the page transfers it straight to the worker. The canvas is
// transferred to the worker too (it draws there).
//
// Test/dev hooks: window.__tapo (bridge, status(), settings(), worker stats, components);
// body[data-boot] becomes "ready" once everything is wired.
/* global ClipboardItem, createImageBitmap, Worker */

import { withDefaults } from '../app/settings-defaults.js';
import { h, clear } from '../ui/dom.js';
import { getCameraBridge } from './bridge.js';
import { capitalize, footerText, formatBytes, ptzMessage, viewPlaceholder } from './status.js';
import { CalibrationDialog } from './ui/calibrate.js';
import { openHelp } from './ui/dialogs.js';
import { DPad, PressHold } from './ui/dpad.js';
import { EventsPanel } from './ui/events.js';
import { Header } from './ui/header.js';
import { tapoIcon } from './ui/icons.js';
import { arrowDir, keyCommand } from './ui/keyboard.js';
import { LiveView } from './ui/live-view.js';
import { openPlayer } from './ui/player.js';
import { PresetsPanel } from './ui/presets.js';
import { promptText, confirmAction } from './ui/dialogs.js';
import { SetupPanel } from './ui/setup.js';
import { Toasts } from './ui/toasts.js';

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const SIDE_KEY = 'lawnmower.tapo.side.v1';
const HINT_KEY = 'lawnmower.tapo.hint-seen.v1';
/** Boxes disappear when the worker has not confirmed them for this long. */
const BOX_TTL_MS = 2500;

const storage = {
  get(/** @type {string} */ k) {
    try {
      return globalThis.localStorage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  },
  set(/** @type {string} */ k, /** @type {string} */ v) {
    try {
      globalThis.localStorage?.setItem(k, v);
    } catch { /* not remembered */ }
  },
};

async function boot() {
  const { bridge, isMock } = getCameraBridge();
  const body = document.body;
  body.dataset.env = isMock ? 'browser' : 'electron';
  const tapo = bridge.tapo;

  const [rawSettings, firstStatus] = await Promise.all([
    bridge.settings.get().catch((/** @type {any} */ err) => {
      console.warn('[tapo] settings.get failed; using defaults', err);
      return null;
    }),
    tapo.status().catch((/** @type {any} */ err) => {
      console.warn('[tapo] status failed', err);
      return null;
    }),
  ]);
  let settings = withDefaults(rawSettings);
  /** @type {any} */
  let status = firstStatus;
  /** @type {any} the worker's last stats */
  let workerStats = null;
  let boxesAt = 0;

  const toasts = new Toasts($('toasts'));
  const toast = (/** @type {string} */ m, /** @type {any} */ level = 'info') => toasts.show(m, level);

  // ---------------------------------------------------------------- the security worker
  /** @type {Worker|null} */
  let worker = null;
  let snapSeq = 0;
  /** @type {Map<string, (m: any) => void>} */
  const snaps = new Map();
  const toWorker = (/** @type {any} */ m, /** @type {Transferable[]} */ tr = []) => worker?.postMessage(m, tr);
  const canvas = /** @type {HTMLCanvasElement} */ ($('live-canvas'));
  try {
    worker = new Worker(new URL('./worker/security-worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (e) => onWorker(e.data));
    worker.addEventListener('error', (e) => {
      console.warn('[tapo] security worker failed', e.message || e);
      toast('The video and local detection stopped. Close and reopen the camera window.', 'error');
    });
    const off = canvas.transferControlToOffscreen();
    worker.postMessage({ t: 'canvas', canvas: off }, [off]);
  } catch (err) {
    console.warn('[tapo] no security worker', err);
    toast('This window cannot show video (no worker / OffscreenCanvas).', 'error');
  }
  // main's frame port: the preload posts it to this window (it cannot cross contextBridge)
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.type !== 'lm:tapo:port' || !ev.ports?.[0]) return;
    toWorker({ t: 'port' }, [ev.ports[0]]);
  });

  /** @param {any} m */
  function onWorker(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'video') live.setVideoSize(m.width, m.height);
    else if (m.t === 'det-view') {
      live.setPersons(m.persons);
      boxesAt = performance.now();
    } else if (m.t === 'stats') {
      workerStats = m;
      refresh();
    } else if (m.t === 'snap-ok' || m.t === 'snap-err') {
      const cb = snaps.get(m.id);
      if (cb) {
        snaps.delete(m.id);
        cb(m);
      }
    }
  }

  /** A picture from the worker, for the clipboard. @param {number} maxSide @returns {Promise<any>} */
  const workerSnap = (maxSide) => new Promise((resolve) => {
    const id = `page-${++snapSeq}`;
    const timer = setTimeout(() => {
      snaps.delete(id);
      resolve({ t: 'snap-err', message: 'No answer from the video worker.' });
    }, 4000);
    snaps.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    toWorker({ t: 'snap', id, maxSide, quality: 0.9 });
  });

  // ---------------------------------------------------------------- pan and tilt
  /** @param {any} cmd @param {{ quiet?: boolean }} [o] */
  const ptz = async (cmd, o = {}) => {
    try {
      const r = await tapo.ptz(cmd);
      if (r && !r.ok && !o.quiet) toast(ptzMessage(r), r.code === 'privacy' ? 'warn' : 'info');
      return r;
    } catch (err) {
      if (!o.quiet) toast(`The camera command failed: ${/** @type {any} */ (err)?.message || err}`, 'error');
      return null;
    }
  };
  const hold = new PressHold({
    onNudge: (dir, amount) => ptz({ op: 'nudge', dir, amount }),
    onHold: (dir) => ptz({ op: 'hold', dir }),
    onHeartbeat: () => ptz({ op: 'heartbeat' }, { quiet: true }),
    onRelease: () => ptz({ op: 'release' }, { quiet: true }),
  });

  // ---------------------------------------------------------------- UI
  const header = new Header($('cam-head'), {
    onArm: () => toggleArm(),
    onSettings: () => (setup.shown ? closeSetup() : openSetup()),
    onHelp: () => openHelp(),
    onToggleSide: () => setSide(body.dataset.side !== 'open'),
    onRetry: () => retry(),
  });
  const live = new LiveView($('live'), {
    onCenter: (uv) => {
      storage.set(HINT_KEY, '1');
      ptz({ op: 'center', u: round3(uv.u), v: round3(uv.v) });
    },
    onToggleFullscreen: () => toggleFullscreen(),
    onResize: (s) => toWorker({ t: 'resize', ...s }),
  });
  const dpad = new DPad($('dpad'), { hold, onHome: () => ptz({ op: 'home' }) });
  /** @type {any[]} */
  let presetList = [];
  const presets = new PresetsPanel($('presets'), {
    onGo: (p) => ptz({ op: 'preset', token: p.token }),
    onSave: () => savePreset(),
    onRefresh: () => loadPresets(true),
    onSetHome: (p) => saveSettings({ tapo: { homePreset: settings.tapo.homePreset === p.token ? '' : p.token } }).then(() => loadPresets(false)),
    onRemove: (p) => removePreset(p),
  });
  const events = new EventsPanel($('events'), {
    load: (q) => tapo.events.list(q),
    onOpen: (ev) => openEvent(ev),
    onOpenFolder: () => openFolder(),
  });
  const setup = new SetupPanel($('setup'), {
    bridge,
    saveSettings: (p) => saveSettings(p),
    toast,
    onCalibrate: () => {
      closeSetup(true);
      calib.show();
    },
    onClose: () => closeSetup(true),
  });
  const calib = new CalibrationDialog({ calibrate: (req) => tapo.calibrate(req), toast });

  /** @param {any} patch @returns {Promise<any>} */
  async function saveSettings(patch) {
    const next = await bridge.settings.set(patch);
    if (next && typeof next === 'object') applySettings(next);
    return next;
  }

  /** @param {any} next */
  function applySettings(next) {
    settings = withDefaults(next);
    setup.update(status, settings);
    toWorker({ t: 'overlay', show: !!settings.tapo.showDetections });
    refresh();
  }

  async function loadPresets(refreshFromCamera = false) {
    try {
      presetList = await tapo.presets(refreshFromCamera ? { refresh: true } : {});
      presets.setPresets(presetList, settings.tapo.homePreset);
    } catch (err) {
      if (refreshFromCamera) toast(`Could not read the saved positions: ${/** @type {any} */ (err)?.message || err}`, 'warn');
    }
  }

  async function savePreset() {
    const name = await promptText({ title: 'Save this position', label: 'Name', placeholder: 'Door, window, garden…', okLabel: 'Save', maxLength: 40 });
    if (!name) return;
    try {
      const r = await tapo.savePreset({ name });
      if (r?.ok) toast(`Saved “${name}”.`, 'success');
      else toast(r?.error || 'Save positions in the Tapo app, then press Refresh.', 'warn');
    } catch (err) {
      toast(`Could not save the position: ${/** @type {any} */ (err)?.message || err}`, 'error');
    }
    loadPresets(false);
  }

  /** @param {any} p */
  async function removePreset(p) {
    const ok = await confirmAction({ title: `Remove “${p.name}”?`, text: 'The camera forgets this position.', okLabel: 'Remove', danger: true });
    if (!ok) return;
    try {
      const r = await tapo.removePreset({ token: p.token });
      if (!r?.ok) toast(r?.error || 'The camera did not remove it. Remove it in the Tapo app, then press Refresh.', 'warn');
    } catch (err) {
      toast(`Could not remove it: ${/** @type {any} */ (err)?.message || err}`, 'error');
    }
    loadPresets(false);
  }

  /** @param {any} ev */
  function openEvent(ev) {
    if (!ev) return;
    if (!ev.acknowledged && !ev.live) {
      tapo.events.ack({ id: ev.id }).catch(() => {});
      events.markRead(ev.id);
    }
    openPlayer(ev, {
      onDelete: async (e) => {
        try {
          await tapo.events.remove({ id: e.id });
          events.remove(e.id);
          toast('Deleted.', 'success');
        } catch (err) {
          toast(`Could not delete it: ${/** @type {any} */ (err)?.message || err}`, 'error');
        }
      },
      onOpenFolder: () => openFolder(),
    });
  }

  async function openFolder() {
    try {
      const r = await tapo.events.openFolder();
      if (r && r.ok === false) toast(r.error || 'Could not open the clips folder.', 'warn');
    } catch (err) {
      toast(`Could not open the clips folder: ${/** @type {any} */ (err)?.message || err}`, 'warn');
    }
  }

  async function toggleArm() {
    const sec = status?.security || {};
    const arm = !(sec.armed || sec.arming);
    if (arm && !status?.configured) {
      toast('Set the camera up first.', 'info');
      openSetup();
      return;
    }
    try {
      const r = await tapo.arm({ armed: arm });
      if (status) status = { ...status, security: { ...status.security, armed: !!r?.armed, arming: !!r?.arming, armingEndsAt: r?.armingEndsAt } };
      refresh();
      if (!arm) toast('Disarmed.', 'info');
    } catch (err) {
      toast(`Could not ${arm ? 'arm' : 'disarm'}: ${/** @type {any} */ (err)?.message || err}`, 'error');
    }
  }

  async function retry() {
    if (typeof tapo.retry === 'function') {
      tapo.retry().catch((/** @type {any} */ err) => toast(String(err?.message || err), 'warn'));
      return;
    }
    if (status?.connection === 'auth-failed') {
      openSetup({ focus: 'password' });
      toast('Type the Camera Account password again, then press Save.', 'info');
    } else {
      openSetup();
    }
  }

  // ---------------------------------------------------------------- layout
  /** @param {boolean} open @param {boolean} [remember] the user's choice (kept for next time) */
  function setSide(open, remember = true) {
    body.dataset.side = open ? 'open' : 'closed';
    header.setSideOpen(open);
    if (remember) storage.set(SIDE_KEY, open ? 'open' : 'closed');
  }
  // narrow windows: the panel would cover the picture, so it starts closed there
  const savedSide = storage.get(SIDE_KEY);
  setSide(savedSide ? savedSide === 'open' : window.innerWidth >= 760, false);

  /** opened by itself because the camera is not set up (closes by itself once it is) */
  let setupAuto = false;
  /** @param {{ focus?: 'password'|'host', auto?: boolean }} [o] */
  function openSetup(o = {}) {
    setupAuto = !!o.auto;
    setup.update(status, settings);
    setup.show(o);
    body.dataset.view = 'setup';
    syncView();
  }
  /** @param {boolean} [force] also when the camera is not set up yet (right after Save) */
  function closeSetup(force = false) {
    if (!status?.configured && !force) return; // nothing else to show yet
    setupAuto = false;
    setup.hide();
    body.dataset.view = 'live';
    syncView();
  }

  let pseudoFull = false;
  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      return;
    }
    if (pseudoFull) {
      pseudoFull = false;
      body.dataset.full = '';
      return;
    }
    try {
      await $('live').requestFullscreen();
    } catch {
      // full screen refused (permissions): fill the window instead
      pseudoFull = true;
      body.dataset.full = '1';
    }
  }

  let lastVisible = /** @type {boolean|null} */ (null);
  /** Tell main and the worker whether the live view can be seen (the stream runs only then, unless armed). */
  function syncView() {
    const visible = document.visibilityState === 'visible' && !setup.shown;
    if (visible === lastVisible) return;
    lastVisible = visible;
    toWorker({ t: 'view', visible });
    try {
      tapo.setViewVisible?.(visible);
    } catch (err) {
      console.warn('[tapo] setViewVisible failed', err);
    }
  }
  document.addEventListener('visibilitychange', syncView);

  // ---------------------------------------------------------------- banners
  /** @type {Set<string>} */
  const dismissed = new Set();
  function renderBanners() {
    const root = $('banners');
    /** @type {Array<{ id: string, text: string, tone: string, action?: { label: string, onClick: () => void } }>} */
    const list = [];
    const st = status;
    if (st?.configured && st.connection === 'online') {
      if (st.ptz?.available && !st.ptz.calibrated && !settings.tapo.calibratedAt) {
        list.push({ id: 'calibrate', tone: 'info', text: 'The arrows may turn the wrong way until the camera is calibrated (about 30 seconds).', action: { label: 'Calibrate…', onClick: () => calib.show() } });
      }
      if (st.clock?.warn) list.push({ id: 'clock', tone: 'warn', text: `The camera’s clock is ${Math.round(Math.abs(st.clock.offsetSec))} s off. The app makes up for it; if sign-in fails later, let the camera reach the internet or restart it.` });
    }
    if (st?.hasPassword && st.persistence === 'memory') list.push({ id: 'memory', tone: 'warn', text: 'This PC cannot encrypt the camera password, so you will be asked for it again after Lawnmower Man restarts.' });
    for (const w of st?.security?.warnings || []) list.push({ id: `w:${w}`, tone: 'warn', text: String(w) });
    const key = JSON.stringify(list.filter((b) => !dismissed.has(b.id)).map((b) => [b.id, b.text]));
    if (root.dataset.key === key) return;
    root.dataset.key = key;
    clear(root);
    for (const b of list) {
      if (dismissed.has(b.id)) continue;
      const close = h('button', { type: 'button', class: 'icon-btn tiny', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: () => {
        dismissed.add(b.id);
        renderBanners();
      } }, tapoIcon('close', 'icon tiny'));
      root.append(h('div', { class: `banner tone-${b.tone}`, dataset: { banner: b.id } },
        tapoIcon(b.tone === 'warn' ? 'warn' : 'info', 'icon tiny'), h('span', { class: 'banner-text' }, b.text),
        b.action ? h('button', { type: 'button', class: 'btn subtle-inline', onclick: b.action.onClick }, b.action.label) : null, close));
    }
  }

  // ---------------------------------------------------------------- refresh
  let lastConnection = '';
  function refresh() {
    const st = status;
    const now = Date.now();
    header.update(st, now);
    const name = st?.name || settings.tapo.name || 'camera';
    document.title = `Home camera — ${name}`;
    const ph = viewPlaceholder(st, workerStats);
    live.setPlaceholder(ph, ph?.kind === 'setup' ? { label: 'Set up the camera', onClick: () => openSetup() }
      : ph?.kind === 'auth' ? { label: 'Check the password', onClick: () => retry() } : null);
    const ptzOk = !!st?.ptz?.available && st.connection === 'online' && !st.ptz.privacySuspected;
    const why = !st?.configured ? 'Set the camera up first' : st?.ptz?.privacySuspected ? 'The camera seems to be in privacy mode' : st?.connection !== 'online' ? 'The camera is offline' : 'Pan and tilt are not available on this camera';
    dpad.setEnabled(ptzOk, why);
    live.setCenterEnabled(ptzOk && !ph, why);
    presets.setEnabled(ptzOk);
    live.setMoving(!!st?.ptz?.moving && ptzOk);
    live.showHint(ptzOk && !ph && storage.get(HINT_KEY) !== '1');
    if (st?.stream?.width && !workerStats?.video?.width) live.setVideoSize(st.stream.width, st.stream.height);
    $('foot-stream').textContent = st?.connection === 'online' ? footerText(st, workerStats) : capitalize(String(st?.detail || ''));
    const storageInfo = st?.security?.storage;
    $('foot-store').textContent = storageInfo ? `${storageInfo.clips} clip${storageInfo.clips === 1 ? '' : 's'} · ${formatBytes(storageInfo.bytes)}` : '';
    body.dataset.armed = st?.security?.armed ? 'armed' : st?.security?.arming ? 'arming' : '';
    renderBanners();
    if (st?.connection === 'online' && lastConnection !== 'online') loadPresets(false);
    lastConnection = st?.connection || '';
  }

  // the arming countdown and stale person boxes
  setInterval(() => {
    if (status?.security?.arming) header.tick(Date.now());
    if (boxesAt && performance.now() - boxesAt > BOX_TTL_MS) {
      boxesAt = 0;
      live.setPersons([]);
    }
  }, 250);

  // ---------------------------------------------------------------- keyboard
  window.addEventListener('keydown', (e) => {
    const c = keyCommand(e);
    if (!c) return;
    if (c.type === 'escape') {
      // a dialog closes itself; otherwise stop the camera and leave full screen
      if (document.querySelector('dialog[open]')) return;
      hold.cancel();
      if (pseudoFull) toggleFullscreen();
      else if (setup.shown) closeSetup();
      else ptz({ op: 'stop' }, { quiet: true });
      return;
    }
    if (document.querySelector('dialog[open]') || setup.shown) return;
    e.preventDefault();
    switch (c.type) {
      case 'arrow':
        if (!e.repeat) hold.press(c.dir, c.amount);
        break;
      case 'home': ptz({ op: 'home' }); break;
      case 'preset': {
        const p = presetList[c.index];
        if (p) ptz({ op: 'preset', token: p.token });
        else toast(`There is no position ${c.index + 1} yet.`, 'info');
        break;
      }
      case 'snapshot': copySnapshot(); break;
      case 'arm': toggleArm(); break;
      case 'events':
        setSide(body.dataset.side !== 'open');
        break;
      case 'fullscreen': toggleFullscreen(); break;
      case 'help': openHelp(); break;
      default:
    }
  });
  window.addEventListener('keyup', (e) => {
    const dir = arrowDir(e.key);
    if (dir && hold.active?.dir === dir) hold.release();
  });
  window.addEventListener('blur', () => hold.cancel());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hold.cancel();
  });

  async function copySnapshot() {
    const m = await workerSnap(1280);
    if (m.t !== 'snap-ok') {
      toast(m.message || 'There is no picture to copy yet.', 'info');
      return;
    }
    try {
      // the clipboard takes PNG
      const bmp = await createImageBitmap(new Blob([m.jpeg], { type: 'image/jpeg' }));
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).drawImage(bmp, 0, 0);
      bmp.close();
      const png = await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('encoding failed'))), 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': /** @type {Blob} */ (png) })]);
      toast('Picture copied. Paste it anywhere with Ctrl+V.', 'success');
    } catch (err) {
      toast(`Could not copy the picture: ${/** @type {any} */ (err)?.message || err}`, 'warn');
    }
  }

  // ---------------------------------------------------------------- main's events
  tapo.onStatus((/** @type {any} */ st) => {
    status = st;
    setup.update(status, settings);
    if (!st?.configured && !setup.shown) openSetup({ auto: true });
    else if (st?.configured && setup.shown && setupAuto) closeSetup();
    refresh();
  });
  /** @type {Map<string, string>} the kind each live event was last announced as */
  const toasted = new Map();
  tapo.onEvent?.((/** @type {any} */ m) => {
    events.onEvent(m);
    const ev = m?.event;
    if (!ev?.id) return;
    if (m.phase === 'end') {
      toasted.delete(ev.id);
      return;
    }
    // a new event, or one that turned out to be a person
    if (toasted.get(ev.id) === ev.kind || (toasted.has(ev.id) && ev.kind !== 'person')) return;
    toasted.set(ev.id, ev.kind);
    const what = ev.kind === 'person' ? 'A person' : ev.kind === 'tamper' ? 'Tampering' : 'Movement';
    toast(`${what} seen just now${status?.security?.recording ? ' — recording' : ''}.`, ev.kind === 'person' ? 'warn' : 'info');
  });
  tapo.onOpenEvent?.(async (/** @type {any} */ m) => {
    const id = m?.id;
    if (!id) return;
    setSide(true, false);
    let ev = events.find(id);
    if (!ev) {
      await events.reload();
      ev = events.find(id);
    }
    if (ev) openEvent(ev);
  });
  tapo.onCalibration?.((/** @type {any} */ s) => {
    if (!calib.open && s && !['idle', 'done', 'failed'].includes(s.step)) calib.show();
    calib.update(s);
  });
  bridge.settings.onChange?.((/** @type {any} */ s) => applySettings(s));

  // ---------------------------------------------------------------- start
  const app = /** @type {any} */ ({ bridge, isMock, live, dpad, hold, presets, events, setup, calib, header, toasts, ready: false });
  app.status = () => status;
  app.settings = () => settings;
  app.workerStats = () => workerStats;
  app.presetList = () => presetList;
  window.__tapo = app;

  setup.update(status, settings);
  toWorker({ t: 'overlay', show: !!settings.tapo.showDetections });
  if (!status?.configured) openSetup({ auto: true });
  else body.dataset.view = 'live';
  syncView();
  refresh();
  events.reload();
  try {
    await tapo.requestPort();
  } catch (err) {
    console.warn('[tapo] requestPort failed', err);
  }
  app.ready = true;
  body.dataset.boot = 'ready';
}

/** @param {number} v */
const round3 = (v) => Math.round(v * 1000) / 1000;

boot().catch((err) => {
  console.error('[tapo] the camera window failed to start', err);
  document.body.dataset.boot = 'failed';
  const msg = document.createElement('div');
  msg.className = 'toast error shown';
  msg.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;';
  msg.textContent = `The Home camera window could not start: ${err?.message || err}`;
  document.body.appendChild(msg);
});
