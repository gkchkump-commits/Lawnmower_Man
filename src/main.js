// Renderer bootstrap: bridge → settings → speech/audio → UI → avatar → conversation controller,
// plus hotkeys (global ones from main, Space-to-talk and Esc in the window), cursor follow and
// click-through for the transparent overlay window.
//
// Test/dev hooks: window.__app (controller, view, bridge, avatar, …); body[data-boot] becomes
// "ready" once wired and window.__app.avatarReady once the hologram has been created.
/* global URLSearchParams, location, innerWidth, innerHeight */

import { ClickThroughGate, probeAvatar } from './app/click-through.js';
import { Controller } from './app/controller.js';
import { getPath, withDefaults } from './app/settings-defaults.js';
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
  const player = new AudioPlayer({ speech: webSpeech });
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
    { composer, onPermission: (id, allow) => controller.respondPermission(id, allow) },
  );

  const gate = new ClickThroughGate({ apply: (ignore) => bridge.window.setIgnoreMouse(ignore) });
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
      if (open) refreshInfo();
    },
  });
  if (appInfo.clickThroughSupported === false && !isMock) {
    drawer.disable('window.clickThrough', 'Not available on this platform (Linux cannot forward mouse moves to a click-through window).');
  }

  // ---------------------------------------------------------------- avatar
  const app = /** @type {any} */ ({ bridge, isMock, view, drawer, player, mic, voiceClient, services, avatarReady: false, ready: false });
  window.__app = app;
  const avatarHost = new AvatarHost($('stage'), {
    onCreating: () => {
      app.avatarReady = false;
      controller?.setAvatar(avatarHost.nullAvatar);
    },
    onCreated: (a) => {
      controller?.setAvatar(a);
      app.avatarReady = true;
      body.dataset.avatar = a.renderer || 'none';
    },
    onError: (err) => view.toast(`The 3D avatar could not start (${err?.message || err}). Check that hardware acceleration / WebGL 2 is available.`, 'error'),
    extraOptions: q.has('seed') ? { seed: Number(q.get('seed')) || 1 } : {},
  });
  app.avatarHost = avatarHost;
  Object.defineProperty(app, 'avatar', { get: () => avatarHost.avatar });

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
    if (prev.voice.enabled !== settings.voice.enabled || prev.voice.speakReplies !== settings.voice.speakReplies) updateVoiceStatus();
    if (!settings.avatar.followCursor) avatarHost.avatar.lookAt(null);
    if (prev.voice.ttsVoice !== settings.voice.ttsVoice) drawer.setVoiceOptions(voiceList);
  };

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
    }
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
  /** @param {any} info  bridge.voice.info() / onStatus payload */
  const applyVoice = async (info) => {
    const seq = ++voiceSeq;
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
    line('Replies spoken with', c.tts === 'server' ? 'local voice' : c.tts === 'browser' ? `browser voice${webSpeech.voice ? ` (${webSpeech.voice.name})` : ''}` : 'nothing (text only)');
    if (info.detail && info.status !== 'ready') lines.push(h('div', null, info.detail));
    if (!c.stt) lines.push(h('div', { class: 'warn' }, VOICE_SETUP_HINT));
    drawer.setInfo('voiceInfo', lines);

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
      hk.push(h('div', { class: 'warn' }, `Could not register ${formatAccelerator(String(acc), platform)} — another app uses it.`));
    }
    drawer.setInfo('hotkeyInfo', hk);
  }

  // ---------------------------------------------------------------- start
  await controller.start();
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
  window.addEventListener('pointermove', (e) => {
    view.notePointer();
    controller.noteActivity();
    const av = avatarHost.avatar;
    if (settings.avatar.followCursor) {
      const r = stage.getBoundingClientRect();
      if (r.width && r.height) {
        av.lookAt(clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1), clamp(1 - ((e.clientY - r.top) / r.height) * 2, -1, 1));
        clearTimeout(releaseGaze);
        releaseGaze = /** @type {any} */ (setTimeout(() => av.lookAt(null), 5000));
      }
    }
    if (gate.enabled) {
      const t = /** @type {HTMLElement} */ (e.target);
      const overUi = !!t?.closest?.('.panel, .toolbar, .perm-card, .toast, .drawer, button, input, textarea, select, a');
      gate.update(overUi || probeAvatar((x, y) => av.hitTest(x, y), e.clientX, e.clientY, gate.interactive));
    }
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => {
    view.pointerLeft();
    gate.leave();
    clearTimeout(releaseGaze);
    releaseGaze = /** @type {any} */ (setTimeout(() => avatarHost.avatar.lookAt(null), 1200));
  });
  window.addEventListener('pointerdown', () => {
    gate.hold('pointer', true);
    player.unlock(); // browsers start audio suspended until a gesture
  }, true);
  window.addEventListener('pointerup', () => gate.hold('pointer', false), true);
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
