// Words for the Home camera's state (pure): the connection badge, the arm control, the live
// view's placeholders, the footer line, event labels, and the one-line summary the avatar's
// settings drawer shows. Plain language for someone who is not a network engineer.

/** @typedef {Record<string, any>} TapoStatus  contract §6.3 */

/** @typedef {'ok'|'busy'|'warn'|'error'|'off'} Tone */

/**
 * @param {TapoStatus|null|undefined} st
 * @returns {{ text: string, tone: Tone, title: string }}
 */
export function connectionBadge(st) {
  if (!st) return { text: 'Starting…', tone: 'busy', title: '' };
  const detail = String(st.detail || '');
  if (!st.enabled) return { text: 'Off', tone: 'off', title: 'The Home camera is turned off in Settings.' };
  if (!st.configured || st.connection === 'not-configured') return { text: 'Not set up', tone: 'off', title: detail || 'Enter the camera’s address and Camera Account.' };
  if (st.ptz?.privacySuspected) return { text: 'Privacy mode?', tone: 'warn', title: 'The camera seems to be in privacy mode. Turn privacy mode off in the Tapo app.' };
  switch (st.connection) {
    case 'online': return { text: 'Online', tone: 'ok', title: detail || 'Connected to the camera.' };
    case 'connecting': return { text: 'Connecting…', tone: 'busy', title: detail || 'Connecting to the camera…' };
    case 'auth-failed': return { text: 'Sign-in failed', tone: 'error', title: detail || 'The camera did not accept the Camera Account.' };
    case 'unreachable': return { text: 'Offline', tone: 'error', title: detail || 'The camera does not answer.' };
    case 'error': return { text: 'Problem', tone: 'error', title: detail || 'Something went wrong.' };
    case 'off': return { text: 'Off', tone: 'off', title: detail };
    default: return { text: 'Connecting…', tone: 'busy', title: detail };
  }
}

/**
 * The arm control. `nowMs` is Date.now().
 * @param {TapoStatus|null|undefined} st @param {number} nowMs
 * @returns {{ mode: 'disarmed'|'arming'|'armed', label: string, action: string, secondsLeft: number }}
 */
export function armState(st, nowMs) {
  const sec = st?.security || {};
  if (sec.arming) {
    const left = Number.isFinite(sec.armingEndsAt) ? Math.max(0, Math.ceil((sec.armingEndsAt - nowMs) / 1000)) : 0;
    return { mode: 'arming', label: `Arming… ${left} s`, action: 'Cancel', secondsLeft: left };
  }
  if (sec.armed) return { mode: 'armed', label: 'Armed', action: 'Disarm', secondsLeft: 0 };
  return { mode: 'disarmed', label: 'Disarmed', action: 'Arm', secondsLeft: 0 };
}

/**
 * What the live view shows instead of (or over) the picture; null = the picture.
 * @param {TapoStatus|null|undefined} st
 * @param {{ hasFrame?: boolean, configSupported?: boolean, lastFrameAgoMs?: number|null }|null} [w]  the worker's stats
 * @returns {{ kind: string, title: string, detail: string, tone: Tone }|null}
 */
export function viewPlaceholder(st, w = null) {
  if (!st) return { kind: 'starting', title: 'Starting…', detail: '', tone: 'busy' };
  if (!st.enabled) return { kind: 'off', title: 'The Home camera is off', detail: 'Turn it on in the avatar’s Settings › Home camera.', tone: 'off' };
  if (!st.configured || st.connection === 'not-configured') return { kind: 'setup', title: 'The camera is not set up yet', detail: 'Open Settings (the gear) and enter the camera’s address and Camera Account.', tone: 'off' };
  if (w && w.configSupported === false) {
    return { kind: 'codec', title: 'This PC cannot show this video', detail: 'This camera stream uses a format this PC cannot decode. Switch to stream2 in Settings, or set the Tapo app’s video quality to a lower setting.', tone: 'error' };
  }
  if (st.ptz?.privacySuspected) return { kind: 'privacy', title: 'Privacy mode seems to be on', detail: 'The camera seems to be in privacy mode. Turn privacy mode off in the Tapo app.', tone: 'warn' };
  switch (st.connection) {
    case 'auth-failed': return { kind: 'auth', title: 'Sign-in failed', detail: `${st.detail || 'The camera did not accept the Camera Account.'} Check the user name and password in Settings, then press Retry. (The app does not keep retrying, so the camera does not lock you out.)`, tone: 'error' };
    case 'unreachable': return { kind: 'offline', title: 'The camera is offline', detail: st.detail || 'It does not answer. Is it switched on and on the same network as this PC?', tone: 'error' };
    case 'error': return { kind: 'error', title: 'Something went wrong', detail: st.detail || '', tone: 'error' };
    case 'connecting': return { kind: 'connecting', title: 'Connecting to the camera…', detail: st.detail || '', tone: 'busy' };
    default:
  }
  if (st.go2rtc?.state === 'missing') return { kind: 'missing', title: 'The video component is missing', detail: st.go2rtc.detail || 'Reinstall Lawnmower Man.', tone: 'error' };
  if (st.go2rtc?.state === 'error') return { kind: 'video-error', title: 'The video could not start', detail: st.go2rtc.detail || 'Pan, tilt and alerts still work.', tone: 'error' };
  const stream = st.stream?.state;
  if (stream === 'error') return { kind: 'video-error', title: 'The video could not start', detail: st.detail || 'Pan, tilt and alerts still work.', tone: 'error' };
  if (stream === 'stalled') return { kind: 'stalled', title: 'The video stopped', detail: 'Reconnecting… If the Tapo app or another viewer is open, close it: the camera allows only two at a time.', tone: 'warn' };
  if (!w?.hasFrame) return { kind: 'starting', title: 'Starting the video…', detail: '', tone: 'busy' };
  return null;
}

/** "1.8 Mbit/s" / "640 kbit/s" @param {number} kbps */
export function formatBitrate(kbps) {
  if (!Number.isFinite(kbps) || kbps <= 0) return '';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${Math.round(kbps)} kbit/s`;
}

/** "84 MB" / "1.2 GB" @param {number} bytes */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/**
 * The footer: "2304×1296 · 15 fps · 1.8 Mbit/s · hardware decode · person detector 1 Hz / 24 ms".
 * @param {TapoStatus|null|undefined} st @param {any} [w] the worker's stats
 */
export function footerText(st, w = null) {
  const parts = [];
  const s = st?.stream || {};
  const width = w?.video?.width || s.width;
  const height = w?.video?.height || s.height;
  if (width && height) parts.push(`${width}×${height}`);
  const fps = Number.isFinite(w?.fps) && w.fps > 0 ? w.fps : s.fps;
  if (fps) parts.push(`${Math.round(fps)} fps`);
  const rate = formatBitrate(s.kbps);
  if (rate) parts.push(rate);
  if (w?.decoding && w.hasFrame) parts.push(`${w.decoding} decode`);
  const det = w?.detector || st?.detector || {};
  if (det.state === 'on' || det.state === 'stub') {
    const hz = Number(det.rateHz) || 0;
    // no detections while disarmed (unless person boxes are shown): "ready", not a rate of 0
    parts.push(`${det.state === 'stub' ? 'test detector' : 'person detector'} ${hz ? `${hz % 1 ? hz.toFixed(1) : hz} Hz${Math.round(det.lastMs) > 0 ? ` / ${Math.round(det.lastMs)} ms` : ''}` : 'ready'}`);
  } else if (det.state === 'loading') {
    parts.push('person detector loading…');
  } else if (det.state === 'failed') {
    parts.push('person detector unavailable');
  }
  return parts.join(' · ');
}

/** Short, user-presentable words for a PTZ failure. @param {any} r PtzResult */
export function ptzMessage(r) {
  if (!r || r.ok) return '';
  switch (r.code) {
    case 'privacy': return 'The camera seems to be in privacy mode. Turn privacy mode off in the Tapo app.';
    case 'unsupported': return r.error || 'This camera cannot do that.';
    case 'offline': return 'The camera is offline.';
    case 'auth': return 'The camera did not accept the sign-in. Check the Camera Account in Settings.';
    case 'not-configured': return 'Set the camera up first (the gear).';
    case 'busy': return 'The camera is busy; try again in a moment.';
    case 'no-preset': return r.error || 'There is no saved position by that name.';
    default: return r.error || 'The camera did not move.';
  }
}

export const KIND_LABEL = Object.freeze({ person: 'Person', motion: 'Motion', tamper: 'Tamper' });

/** "23 s" / "2 min 5 s" @param {number} sec */
export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/** Local "14:03" @param {number} ms */
export function formatClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Today", "Yesterday" or "Sat 10 Oct" (local) for an event time. @param {number} ms @param {number} nowMs */
export function dayLabel(ms, nowMs) {
  const d = new Date(ms);
  const n = new Date(nowMs);
  const day = (/** @type {Date} */ x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}${d.getFullYear() !== n.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

/**
 * The avatar's settings drawer: one line about the camera.
 * @param {TapoStatus|null|undefined} st @param {number} [nowMs]
 */
export function drawerStatusLine(st, nowMs = Date.now()) {
  if (!st || !st.enabled) return 'Off. Turn it on to use a Tapo pan/tilt camera as a home security camera.';
  const b = connectionBadge(st);
  const a = armState(st, nowMs);
  const name = st.name || 'camera';
  if (b.text === 'Not set up') return `Not set up yet: open the camera window and enter the ${name}’s address.`;
  const today = Number(st.security?.todayCount) || 0;
  const events = today ? ` · ${today} event${today === 1 ? '' : 's'} today` : '';
  return `${capitalize(name)}: ${b.text.toLowerCase()} · ${a.mode === 'arming' ? a.label.toLowerCase() : a.label.toLowerCase()}${events}`;
}

/** @param {string} s */
export function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
