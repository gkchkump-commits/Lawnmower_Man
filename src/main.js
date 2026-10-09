// Renderer bootstrap: bridge → settings → speech/audio → UI → avatar → conversation controller,
// plus hotkeys (global ones from main, Space-to-talk and Esc in the window), cursor follow and
// click-through for the transparent overlay window.
//
// Test/dev hooks: window.__app (controller, view, bridge, avatar, …); body[data-boot] becomes
// "ready" once wired and window.__app.avatarReady once the hologram has been created.
/* global URLSearchParams, location, innerWidth, innerHeight */

import { ClickThroughGate, probeAvatar } from './app/click-through.js';
import { WindowDrag, nextSizePreset } from './app/window-drag.js';
import { Controller } from './app/controller.js';
import { gazeFromPoint } from './app/gaze.js';
import { getPath, withDefaults } from './app/settings-defaults.js';
import { voiceSetupDiagnostics } from './app/setup-help.js';
import { Mic } from './audio/mic.js';
import { AudioPlayer } from './audio/player.js';
import { getBridge } from './bridge/index.js';
import { VOICE_SETUP_HINT, createSpeechServices } from './speech/index.js';
import { VoiceClient } from './speech/voice-client.js';
import { WebSpeechTTS } from './speech/web-speech.js';
import { formatAccelerator } from './ui/accelerator.js';
import { AppView } from './ui/app-view.js';
import { AvatarHost } from './ui/avatar-host.js';
import { Composer } from './ui/composer.js';
import { h, isControlTarget } from './ui/dom.js';
import { computeLayout } from './ui/layout.js';
import { SettingsDrawer } from './ui/settings-drawer.js';
import { setupTailView } from './ui/setup-cards.js';
import { copyText } from './ui/transcript.js';
import { CameraFeature } from './vision/index.js';
import { GazeArbiter } from './vision/gaze.js';
import { CameraUi, cameraInfoLines } from './vision/ui.js';

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

async function boot() {
  const q = new URLSearchParams(location.search);
  const { bridge, isMock } = getBridge();
  const body = document.body;
  body.dataset.env = isMock ? 'browser' : 'electron';
  if (q.get('bg') === 'desk') body.dataset.bg = 'desk';

  const [rawSettings, appInfo] = await Promise.all([
    bridge.settings.get().catch((err) => {
      console.warn('[app] settings.get failed; using defaults', err);
      return null;
    }),
    bridge.app.info().catch(() => ({})),
  ]);
  let settings = withDefaults(rawSettings);
  const platform = appInfo.platform && appInfo.platform !== 'browser'
    ? appInfo.platform
    : /Mac/.test(navigator.userAgent) ? 'darwin' : /Windows/.test(navigator.userAgent) ? 'win32' : 'linux';

  // ---------------------------------------------------------------- speech & audio
  const webSpeech = new WebSpeechTTS();
  const voiceClient = new VoiceClient(bridge.__mock?.voiceFetch ? { fetch: bridge.__mock.voiceFetch } : {});
  // the local voice's character (settings voice.character / fxAmount; later changes arrive
  // through controller.applySettings); the effect starts loading now, off the critical path
  const player = new AudioPlayer({ speech: webSpeech, voiceFx: { character: settings.voice.character, amount: settings.voice.fxAmount } });
  const mic = new Mic();
  /** @type {AppView} */
  let view;
  let fallbackWarned = false;
  const services = createSpeechServices({
    voiceClient,
    webSpeech,
    getSettings: () => settings,
    onFallback: (err) => {
      if (fallbackWarned) return;
      fallbackWarned = true;
      view?.toast(`The local voice failed (${err.message}); using the browser voice for now.`, 'warn');
    },
  });
  const caps = () => ({ tts: services.tts.mode(), stt: services.stt.available() });

  // ---------------------------------------------------------------- UI
  /** @type {Controller} */
  let controller;
  const composer = new Composer(
    { form: /** @type {HTMLFormElement} */ ($('composer')), input: /** @type {HTMLTextAreaElement} */ ($('input')), send: /** @type {HTMLButtonElement} */ ($('send')), mic: /** @type {HTMLButtonElement} */ ($('mic')) },
    {
      onSend: (text) => controller.sendText(text),
      onStop: () => {
        if (!controller.stopSpeaking() || controller.activeTurnId) controller.interrupt();
      },
      onMicPress: () => {
        if (controller.listen) return; // a second click while listening stops (on release)
        micPressStartedListening = true;
        controller.toggleListening();
      },
      onMicRelease: (heldMs) => {
        const started = micPressStartedListening;
        micPressStartedListening = false;
        if (!controller.listen) return;
        // long press = push-to-talk (send on release); short click = keep listening until
        // the end of speech; a click while already listening = stop now
        if (!started || heldMs >= Composer.HOLD_MS) controller.stopListening();
      },
      onMicUnavailable: () => view.toast(services.stt.unavailableReason(), 'info'),
    },
  );
  let micPressStartedListening = false;

  view = new AppView(
    { body, transcript: $('transcript'), cards: $('cards'), toasts: $('toasts'), status: $('status') },
    { composer, platform, onPermission: (id, allow) => controller.respondPermission(id, allow), onRetryClaude: () => retryClaude() },
  );

  const gate = new ClickThroughGate({ apply: (ignore) => bridge.window.setIgnoreMouse(ignore) });
  // Moving the window by the head (wired to pointer events below; created early because settings
  // changes consult it).
  const windowDrag = new WindowDrag({
    win: bridge.window,
    isLocked: () => !!settings.window.lockPosition,
    gate,
    onChange: (on) => { body.dataset.dragging = on ? '1' : ''; },
  });
  const syncLockAttr = () => { body.dataset.lock = settings.window.lockPosition || !windowDrag.supported ? '1' : ''; };
  const clickThroughWanted = () => {
    if (!settings.window.clickThrough) return false;
    if (isMock) return q.get('clickThrough') === '1';
    return appInfo.clickThroughSupported !== false;
  };

  const drawer = new SettingsDrawer($('drawer'), {
    platform,
    onChange: (patch, path, value) => saveSettings(patch, path, value),
    onAction: (a) => runAction(a),
    onToggle: (open) => {
      body.dataset.drawer = open ? 'open' : '';
      gate.hold('drawer', open);
      if (open) {
        refreshInfo();
        refreshAppInfo(); // e.g. hotkey conflicts may have changed since boot
        camera?.refreshDevices();
        refreshCameraInfo();
      }
    },
  });
  if (appInfo.clickThroughSupported === false && !isMock) {
    drawer.disable('window.clickThrough', 'Not available on this platform (Linux cannot forward mouse moves to a click-through window).');
  }

  // ---------------------------------------------------------------- avatar
  const app = /** @type {any} */ ({ bridge, isMock, view, drawer, player, mic, voiceClient, webSpeech, services, avatarReady: false, ready: false });
  window.__app = app;
  const avatarHost = new AvatarHost($('stage'), {
    onCreating: () => {
      app.avatarReady = false;
      controller?.setAvatar(avatarHost.nullAvatar);
    },
    onCreated: (a) => {
      controller?.setAvatar(a);
      gaze.reapply(); // the new avatar starts without a gaze target
      app.avatarReady = true;
      body.dataset.avatar = a.renderer || 'none';
    },
    onError: (err) => view.toast(`The 3D avatar could not start (${err?.message || err}). Check that hardware acceleration / WebGL 2 is available.`, 'error'),
    extraOptions: q.has('seed') ? { seed: Number(q.get('seed')) || 1 } : {},
  });
  app.avatarHost = avatarHost;
  Object.defineProperty(app, 'avatar', { get: () => avatarHost.avatar });
  // where the eyes look: the cursor, or (camera) the user's face — see src/vision/gaze.js
  const gaze = new GazeArbiter({ apply: (t) => (t ? avatarHost.avatar.lookAt(t[0], t[1]) : avatarHost.avatar.lookAt(null)) });
  app.gaze = gaze;
  /** @type {CameraFeature|null} the camera (created after the controller) */
  let camera = null;

  // ---------------------------------------------------------------- controller
  controller = new Controller({
    bridge,
    avatar: avatarHost.avatar,
    player,
    tts: services.tts,
    stt: services.stt,
    mic: mic.supported ? mic : null,
    view,
    settings,
  });
  app.controller = controller;
  app.settings = () => settings;

  // ---------------------------------------------------------------- layout
  const applyLayout = () => {
    // ?layout=electron lets the browser preview use the desktop window's layout rule
    const l = computeLayout({ width: innerWidth, height: innerHeight, showChat: settings.window.showChat, electron: !isMock || q.get('layout') === 'electron' });
    document.documentElement.style.setProperty('--chat-h', `${l.chatHeight}px`);
    view.setMode(l.mode);
  };
  window.addEventListener('resize', applyLayout);
  applyLayout();
  drawer.update(settings);

  // ---------------------------------------------------------------- settings
  /** @param {any} next */
  const onSettings = (next) => {
    const prev = settings;
    settings = withDefaults(next);
    controller.applySettings(settings);
    avatarHost.apply(settings.avatar);
    applyLayout();
    drawer.update(settings);
    gate.setEnabled(clickThroughWanted());
    syncLockAttr();
    if (settings.window.lockPosition) windowDrag.release();
    if (prev.voice.enabled !== settings.voice.enabled || prev.voice.speakReplies !== settings.voice.speakReplies) updateVoiceStatus();
    if (!settings.avatar.followCursor) gaze.releaseCursor();
    camera?.applySettings(settings);
    if (prev.voice.ttsVoice !== settings.voice.ttsVoice) drawer.setVoiceOptions(voiceList);
    if (prev.voice.systemVoice !== settings.voice.systemVoice) {
      webSpeech.setPreferred(settings.voice.systemVoice);
      drawer.setSystemVoiceOptions(webSpeech.allVoices());
      refreshInfo();
    }
    // main re-registers global shortcuts on change: show its fresh conflict list
    if (JSON.stringify(prev.hotkeys) !== JSON.stringify(settings.hotkeys)) refreshAppInfo();
  };

  /** Re-read app.info() (hotkey conflicts, GPU) and redraw the drawer's info blocks. */
  async function refreshAppInfo() {
    try {
      const next = await bridge.app.info();
      if (next && typeof next === 'object') Object.assign(appInfo, next);
    } catch (err) {
      console.warn('[app] app.info failed', err);
    }
    refreshInfo();
  }

  /** @param {object} patch @param {string} path @param {any} value */
  async function saveSettings(patch, path, value) {
    try {
      const result = await bridge.settings.set(patch);
      if (!result || typeof result !== 'object') return;
      const got = getPath(result, path);
      if (typeof value !== 'number' && JSON.stringify(got) !== JSON.stringify(value)) {
        view.toast(`That value was not accepted (${path}).`, 'warn');
      }
      onSettings(result);
    } catch (err) {
      view.toast(`Could not save the setting: ${err?.message || err}`, 'error');
      drawer.update(settings);
    }
  }

  /** @param {string} a */
  function runAction(a) {
    if (a === 'newConversation') {
      controller.newConversation();
      drawer.close();
    } else if (a === 'restartVoice') {
      bridge.voice.restart().catch((err) => view.toast(`Could not restart the voice server: ${err?.message || err}`, 'error'));
      view.toast('Restarting the voice server…', 'info');
    } else if (a === 'setupVoice') {
      setupVoice();
    } else if (a === 'resetPosition') {
      if (typeof bridge.window.resetPosition === 'function') bridge.window.resetPosition();
      else view.toast('Restart Lawnmower Man to reset the position.', 'info');
    }
  }

  /** Setup card "Retry": main looks for the Claude CLI again and restarts it. */
  async function retryClaude() {
    if (typeof bridge.claude.retry !== 'function') {
      view.toast('Restart Lawnmower Man to look for the Claude CLI again.', 'info');
      return;
    }
    const kind = controller.claudeProblem?.kind;
    try {
      await bridge.claude.retry();
      // a login can only be confirmed by the next reply; a found CLI is ready now
      if (!controller.claudeProblem) view.toast(kind === 'auth' ? 'Claude Code restarted. Send a message to check the sign-in.' : 'Claude Code is ready.', 'success');
    } catch (err) {
      view.toast(controller.claudeProblem?.kind === 'cli-missing'
        ? 'Still not found. Finish the installation, open a new terminal and check that "claude --version" works, then retry.'
        : `Retry failed: ${err?.message || err}`, 'warn');
    }
  }

  /** "Set up local voice…" (drawer, the voice hint): main opens the setup script in its own window. */
  async function setupVoice() {
    if (typeof bridge.voice.setup !== 'function') {
      view.toast(VOICE_SETUP_HINT, 'info');
      return;
    }
    try {
      const r = await bridge.voice.setup();
      if (r?.state === 'manual') {
        view.setVoiceSetup(r); // (again, if the user closed it before)
        drawer.close(); // the card with the command is over the avatar
      } else if (r?.already) {
        view.toast('The voice setup is already running in its own window.', 'info');
      }
    } catch (err) {
      view.toast(`Could not start the voice setup: ${err?.message || err}`, 'error');
    }
  }

  /** "Open setup log" (drawer): main opens the log of its voice home in the text editor. */
  async function openSetupLog() {
    try {
      const r = await bridge.voice.openSetupLog();
      if (r && r.ok === false) view.toast(`Could not open the setup log: ${r.error || 'unknown error'}`, 'warn');
    } catch (err) {
      view.toast(`Could not open the setup log: ${err?.message || err}`, 'warn');
    }
  }

  /** "Copy" next to the setup output: the failure, the output tail and where the log is. @param {string} text */
  async function copySetupReport(text) {
    const ok = await copyText(text);
    view.toast(ok ? 'Copied the setup error to the clipboard.' : 'Could not copy to the clipboard.', ok ? 'success' : 'warn');
  }

  // ---------------------------------------------------------------- voice server
  /** @type {any[]} */
  let voiceList = [];
  let voicesUrl = '';
  let voiceSeq = 0;
  const updateVoiceStatus = () => {
    view.setVoiceStatus(voiceClient.info, caps());
    controller.voiceChanged();
    refreshInfo();
  };
  let lastSetupKey = '';
  /**
   * Toasts for the setup window's progress, and the manual-command card — only when the setup
   * state changes (voice status repeats it), so a card the user closed stays closed.
   * @param {any} setup VoiceInfo.setup
   */
  const noteVoiceSetup = (setup) => {
    const st = setup?.state || '';
    const key = st === 'manual' ? `manual:${setup.command || ''}` : st;
    if (key === lastSetupKey) return;
    lastSetupKey = key;
    view.setVoiceSetup(setup || null);
    if (st === 'running') view.toast(setup.detail || 'The voice setup is running in its own window.', 'info');
    else if (st === 'done') view.toast(setup.detail || 'Local voice installed.', 'success');
    else if (st === 'failed') view.toast(setup.detail || 'The voice setup did not finish.', 'warn');
  };

  /** @param {any} info  bridge.voice.info() / onStatus payload */
  const applyVoice = async (info) => {
    const seq = ++voiceSeq;
    noteVoiceSetup(info?.setup);
    voiceClient.configure(info);
    if (voiceClient.ready && !voiceClient.health) {
      // the sidecar normally includes /health; ask the server directly when it did not
      await voiceClient.getHealth().catch((err) => console.warn('[app] voice /health failed', err?.message || err));
      if (seq !== voiceSeq) return; // a newer status arrived meanwhile
    }
    updateVoiceStatus();
    if (!voiceClient.ready) {
      voiceList = [];
      voicesUrl = '';
    } else if (voicesUrl !== voiceClient.info.url || !voiceList.length) {
      // periodic health updates repeat 'ready': only list the voices once per server
      let list = [];
      try {
        list = await voiceClient.voices();
      } catch {
        list = [];
      }
      if (seq !== voiceSeq) return;
      voiceList = list;
      voicesUrl = list.length ? voiceClient.info.url || '' : '';
    }
    drawer.setVoiceOptions(voiceList);
  };

  function refreshInfo() {
    const info = voiceClient.info || {};
    const hl = info.health || {};
    const c = caps();
    const lines = [];
    const line = (k, v, cls = '') => lines.push(h('div', { class: cls }, h('span', { class: 'k' }, `${k}: `), v));
    line('Server', info.status === 'ready' ? 'running' : info.status || 'stopped', info.status === 'error' ? 'err' : '');
    if (hl.device?.name) line('GPU', `${hl.device.name}${hl.device.capability ? ` (sm ${hl.device.capability})` : ''}${hl.device.vramTotalMB ? ` · ${Math.round(hl.device.vramFreeMB ?? 0)} / ${Math.round(hl.device.vramTotalMB)} MB free` : ''}`);
    if (hl.stt) line('Speech-to-text', `${hl.stt.model || ''} on ${hl.stt.device || '?'}${hl.stt.error ? ` — ${hl.stt.error}` : ''}`, hl.stt.error ? 'warn' : '');
    if (hl.tts) line('Text-to-speech', `${hl.tts.backend || 'Kokoro'} on ${hl.tts.device || '?'}${hl.tts.error ? ` — ${hl.tts.error}` : ''}`, hl.tts.error ? 'warn' : '');
    line('Replies spoken with', c.tts === 'server' ? 'local voice' : c.tts === 'browser' ? `system voice${webSpeech.voice ? ` (${webSpeech.voice.name})` : ''}` : 'nothing (text only)');
    if (c.tts !== 'server' && webSpeech.preferredMissing) lines.push(h('div', { class: 'warn' }, `The chosen system voice "${settings.voice.systemVoice}" is not installed; using the most natural one instead.`));
    if (info.detail && info.status !== 'ready') lines.push(h('div', null, info.detail));
    const setup = info.setup || null;
    if (setup && setup.state !== 'manual' && setup.detail && !(setup.state === 'done' && info.status === 'ready')) line('Setup', setup.detail, setup.state === 'failed' ? 'warn' : '');
    // a failed setup: the last lines of the failed step (pip's "ERROR: …"), the log, a Copy button
    const diag = voiceSetupDiagnostics(info, { canOpenLog: typeof bridge.voice.openSetupLog === 'function' });
    lines.push(setupTailView(diag, { onOpenLog: () => openSetupLog(), onCopy: (text) => copySetupReport(text) }));
    const installed = info.installed === true || info.status === 'ready' || info.status === 'starting';
    if (!c.stt && setup?.state !== 'running') {
      lines.push(h('div', { class: 'warn' },
        installed ? 'Voice input needs the local voice server running (see above).' : VOICE_SETUP_HINT,
        installed ? null : h('button', { type: 'button', class: 'btn subtle setup-voice-inline', onclick: () => setupVoice() }, 'Set up local voice…')));
    }
    drawer.setInfo('voiceInfo', lines);
    drawer.setVoiceSource(c.tts === 'server' ? 'server' : 'system');
    drawer.setAction('setupVoice', setup?.state === 'running'
      ? { label: 'Voice setup is running…', disabled: true }
      : { label: installed ? 'Set up local voice again…' : 'Set up local voice…', disabled: false, title: installed ? 'Re-run the setup (repairs or updates the local voice)' : 'Install faster-whisper and Kokoro (opens a window)' });

    const st = controller.claudeStatus || {};
    const about = [];
    const row = (k, v) => v && about.push(h('div', null, h('span', { class: 'k' }, `${k}: `), String(v)));
    row('Lawnmower Man', `${appInfo.version || '?'}${isMock ? ' (browser preview, mock bridge)' : ''}`);
    row('Platform', [appInfo.platform, appInfo.electron && `Electron ${appInfo.electron}`, appInfo.chrome && `Chrome ${appInfo.chrome}`].filter(Boolean).join(' · '));
    row('Claude CLI', [st.cliVersion, st.cliPath].filter(Boolean).join(' · '));
    row('Session', st.sessionId);
    row('Model', st.model);
    const gpu = appInfo.gpu?.active;
    if (gpu) row('Renderer GPU', `${gpu.vendor}${gpu.driver ? ` (driver ${gpu.driver})` : ''}`);
    if (gpu && platform === 'win32' && gpu.vendor !== 'NVIDIA') {
      about.push(h('div', { class: 'warn' }, 'Tip: to render on the RTX GPU, set Windows Settings › System › Display › Graphics › Lawnmower Man › High performance.'));
    }
    row('Avatar', avatarHost.avatar.renderer);
    row('Logs', appInfo.logFile);
    drawer.setInfo('about', about);

    const conflicts = Array.isArray(appInfo.hotkeyConflicts) ? appInfo.hotkeyConflicts : [];
    const hk = [h('div', null, 'In this window: hold Space to talk · Esc stops speaking.')];
    for (const cf of conflicts) {
      const acc = typeof cf === 'string' ? cf : cf?.accelerator || cf?.name || JSON.stringify(cf);
      const reason = typeof cf === 'object' && typeof cf?.reason === 'string' ? cf.reason : '';
      const label = formatAccelerator(String(acc), platform);
      const names = { toggleListen: 'Talk / interrupt', stopSpeaking: 'Stop speaking', toggleChat: 'Show / hide chat' };
      const nameOf = (/** @type {string} */ n) => names[n] || n;
      const msg = reason.startsWith('same as ')
        ? `${label} is set for both “${nameOf(reason.slice(8))}” and “${nameOf(cf.name)}”; only the first works.`
        : reason === 'invalid shortcut'
          ? `${label} is not a valid shortcut.`
          : `Could not register ${label} — another app uses it.`;
      hk.push(h('div', { class: 'warn' }, msg));
    }
    drawer.setInfo('hotkeyInfo', hk);
  }

  // ---------------------------------------------------------------- camera (docs/CAMERA.md)
  let cameraInfoTimer = 0;
  /** The drawer's Camera info block (only while the drawer is open; at most ~4 times a second). */
  function refreshCameraInfo() {
    if (!camera || !drawer.isOpen || cameraInfoTimer) return;
    cameraInfoTimer = /** @type {any} */ (setTimeout(() => {
      cameraInfoTimer = 0;
      if (camera && drawer.isOpen) drawer.setInfo('cameraInfo', cameraInfoLines(camera.status));
    }, 250));
  }
  const cameraUi = new CameraUi(
    { body, cards: $('cards'), button: /** @type {HTMLButtonElement} */ ($('btn-camera')), indicator: /** @type {HTMLButtonElement} */ ($('cam-live')), shot: /** @type {HTMLButtonElement} */ ($('shot')) },
    {
      onToggle: () => camera?.toggle(),
      onShot: () => camera?.toggleShot(),
      toast: (msg, level) => view.toast(msg, /** @type {any} */ (level)),
      setDevices: (cams, o) => drawer.setCameraOptions(cams, o),
      changed: () => refreshCameraInfo(),
    },
  );
  camera = new CameraFeature({
    getSettings: () => settings,
    saveSettings: (patch) => {
      const [group, fields] = Object.entries(patch)[0];
      const [key, value] = Object.entries(/** @type {any} */ (fields))[0];
      return saveSettings(patch, `${group}.${key}`, value);
    },
    controller,
    getAvatar: () => avatarHost.avatar,
    gaze,
    view: cameraUi,
    platform,
    userBusy: () => !!composer.text.trim(),
  });
  app.camera = camera;
  // the camera pauses while the window cannot be seen: main reports it (with backgroundThrottling
  // off, document.visibilityState always says "visible" in Electron); the browser preview uses
  // the Page Visibility API
  if (typeof bridge.window.onVisibility === 'function') {
    // subscribe first, then ask (the boot-time app.info() may predate the window being shown)
    let heard = false;
    bridge.window.onVisibility((v) => {
      heard = true;
      camera?.setVisible(v?.visible !== false);
    });
    bridge.app.info().then((i) => {
      if (!heard && i && typeof i.visible === 'boolean') camera?.setVisible(i.visible);
    }, () => {});
  } else {
    document.addEventListener('visibilitychange', () => camera?.setVisible(document.visibilityState === 'visible'));
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', () => camera?.refreshDevices());

  // ---------------------------------------------------------------- start
  await controller.start();
  camera.applySettings(settings);
  webSpeech.setPreferred(settings.voice.systemVoice);
  webSpeech.onVoicesChanged(() => {
    drawer.setSystemVoiceOptions(webSpeech.allVoices());
    refreshInfo();
  });
  webSpeech.init().then(() => updateVoiceStatus());
  try {
    await applyVoice(await bridge.voice.info());
  } catch (err) {
    console.warn('[app] voice.info failed', err);
    updateVoiceStatus();
  }
  bridge.voice.onStatus((info) => applyVoice(info));
  bridge.settings.onChange((s) => onSettings(s));
  bridge.onHotkey((name) => {
    controller.noteActivity();
    if (name === 'toggleListen') controller.toggleListening();
    else if (name === 'stopSpeaking') {
      if (!controller.stopSpeaking()) controller.interrupt();
    } else if (name === 'toggleChat') {
      const v = !settings.window.showChat;
      saveSettings({ window: { showChat: v } }, 'window.showChat', v);
    }
  });
  gate.setEnabled(clickThroughWanted());

  // toolbar
  $('btn-new').addEventListener('click', () => controller.newConversation());
  $('btn-chat').addEventListener('click', () => {
    const v = !settings.window.showChat;
    saveSettings({ window: { showChat: v } }, 'window.showChat', v);
  });
  $('btn-settings').addEventListener('click', () => drawer.toggle());
  $('btn-min').addEventListener('click', () => bridge.window.minimize());
  $('btn-hide').addEventListener('click', () => bridge.window.hide());
  view.status.voice.addEventListener('click', () => {
    drawer.open();
    document.querySelector('[data-section="voice"]')?.scrollIntoView({ block: 'start' });
  });

  // ---------------------------------------------------------------- keyboard
  let spaceDown = false;
  window.addEventListener('keydown', (e) => {
    controller.noteActivity();
    if (e.key === 'Escape') {
      if (drawer.isOpen) {
        drawer.close();
      } else if (controller.listen || controller.state === 'transcribing') {
        controller.cancelListening();
      } else if (!controller.stopSpeaking()) {
        controller.interrupt();
      }
      e.preventDefault();
      return;
    }
    if (e.code === 'Space' && !e.ctrlKey && !e.altKey && !e.metaKey && !isControlTarget(e.target) && !drawer.isOpen) {
      e.preventDefault();
      if (!e.repeat && !spaceDown) {
        spaceDown = true;
        controller.startListening('ptt');
      }
      return;
    }
    // start typing anywhere → the message box
    if (!drawer.isOpen && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !isControlTarget(e.target)) composer.focus();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && spaceDown) {
      spaceDown = false;
      e.preventDefault();
      controller.stopListening();
    }
  });
  window.addEventListener('blur', () => {
    if (spaceDown) {
      spaceDown = false;
      controller.stopListening();
    }
  });

  // ---------------------------------------------------------------- pointer: gaze + click-through
  const stage = $('stage');
  let releaseGaze = 0;
  /** Point the eyes at (x, y) in window CSS px; they relax again after `releaseMs` without updates. */
  const lookAtPoint = (x, y, releaseMs = 5000) => {
    if (!settings.avatar.followCursor) return;
    const g = gazeFromPoint(x, y, stage.getBoundingClientRect());
    if (!g) return;
    clearTimeout(releaseGaze);
    gaze.cursor(g, releaseMs); // holds for releaseMs, or 1.5 s while the camera sees the user
  };
  // Desktop app: main reports the cursor anywhere on the screen (~30 Hz, only when it moves),
  // so the eyes follow it outside the window and while it is being dragged too. The browser preview
  // (mock bridge) has no such event and falls back to pointer events over the page.
  const globalCursor = typeof bridge.onCursor === 'function';
  if (globalCursor) {
    bridge.onCursor((p) => {
      if (p && typeof p === 'object') lookAtPoint(Number(p.x), Number(p.y));
    });
  }
  // ---------------------------------------------------------------- moving the window
  // Press on the head (its visible silhouette), the chat status bar or the settings header and
  // drag: main moves the window (see src/app/window-drag.js for why not CSS drag regions).
  const DRAG_CONTROLS = 'button, input, textarea, select, a, label, [contenteditable], .toolbar, .perm-card, .setup-card, .toast, .transcript, .composer';
  /** @param {PointerEvent|MouseEvent} e  over the head, away from any control */
  const overHeadAt = (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (!t?.closest || !t.closest('#stage') || t.closest(DRAG_CONTROLS)) return false;
    return !!avatarHost.avatar.hitTest(e.clientX, e.clientY);
  };
  /** @param {PointerEvent} e */
  const dragHandleAt = (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (!t?.closest || t.closest(DRAG_CONTROLS)) return false;
    if (t.closest('.statusbar, .drawer-head')) return true;
    return overHeadAt(e);
  };
  syncLockAttr();
  window.addEventListener('pointerdown', (e) => {
    if (!windowDrag.press(e, dragHandleAt(e))) return;
    e.preventDefault(); // no text selection or focus change while the window moves
    try {
      /** @type {HTMLElement} */ (e.target).setPointerCapture?.(e.pointerId);
    } catch { /* the release still arrives via window listeners */ }
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    window.addEventListener(type, (e) => windowDrag.release(/** @type {PointerEvent} */ (e)), true);
  }
  window.addEventListener('blur', () => windowDrag.release());
  document.addEventListener('visibilitychange', () => { if (document.hidden) windowDrag.release(); });
  // Ctrl + mouse wheel over the head: next size preset (S / M / L)
  let lastWheelSize = 0;
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !overHeadAt(e)) return;
    e.preventDefault(); // never zoom the page
    const now = performance.now();
    if (now - lastWheelSize < 350) return;
    const next = nextSizePreset(settings.window.sizePreset, e.deltaY);
    if (!next) return;
    lastWheelSize = now;
    bridge.window.setSizePreset(next);
  }, { passive: false });

  window.addEventListener('pointermove', (e) => {
    view.notePointer();
    controller.noteActivity();
    const av = avatarHost.avatar;
    if (!windowDrag.active) body.dataset.overHead = overHeadAt(e) ? '1' : '';
    if (!globalCursor) lookAtPoint(e.clientX, e.clientY);
    if (gate.enabled) {
      const t = /** @type {HTMLElement} */ (e.target);
      const overUi = !!t?.closest?.('.panel, .toolbar, .perm-card, .setup-card, .toast, .drawer, button, input, textarea, select, a');
      gate.update(overUi || probeAvatar((x, y) => av.hitTest(x, y), e.clientX, e.clientY, gate.interactive));
    }
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => {
    view.pointerLeft();
    gate.leave();
    if (globalCursor) return; // the global cursor keeps the eyes following outside the window
    clearTimeout(releaseGaze);
    releaseGaze = /** @type {any} */ (setTimeout(() => gaze.releaseCursor(), 1200));
  });
  window.addEventListener('pointerdown', () => {
    gate.hold('pointer', true);
    player.unlock(); // browsers start audio suspended until a gesture
  }, true);
  // a cancelled press (a touch that became a scroll) ends the hold too
  for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, () => gate.hold('pointer', false), true);
  window.addEventListener('keydown', () => player.unlock(), { once: true, capture: true });
  $('input').addEventListener('focus', () => view.refreshPanel());
  $('input').addEventListener('blur', () => view.refreshPanel());

  // ---------------------------------------------------------------- frame loop (lip-sync)
  let last = performance.now();
  const frame = (t) => {
    const dt = clamp((t - last) / 1000, 0, 0.1);
    last = t;
    try {
      controller.tick(dt, t / 1000);
    } catch (err) {
      console.warn('[app] tick failed', err);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  app.ready = true;
  body.dataset.boot = 'ready';

  // the hologram loads last (textures); everything else already works meanwhile
  await avatarHost.apply(settings.avatar);
  refreshInfo();
}

boot().catch((err) => {
  console.error('[app] failed to start', err);
  document.body.dataset.boot = 'failed';
  const msg = document.createElement('div');
  msg.className = 'toast error shown';
  msg.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;';
  msg.textContent = `Lawnmower Man could not start: ${err?.message || err}`;
  document.body.appendChild(msg);
});
