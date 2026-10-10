// Alerts (contract §8.11): the Windows notification and the avatar's announcement. The texts are
// pure functions; AlertManager shows Electron Notifications (injected), keeps them referenced
// (a collected Notification loses its click handler) and, for the e2e run, records them.

/** "front door camera" / "the front door camera" → "front door camera". @param {string} name */
export function cameraLabel(name) {
  const n = String(name || '').trim().replace(/^the\s+/i, '');
  return n || 'camera';
}

/** @param {number} at */
function hhmm(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * What the avatar says.
 * @param {'person'|'motion'|'tamper'} kind @param {string} name
 */
export function alertLine(kind, name) {
  const n = cameraLabel(name);
  if (kind === 'person') return `Someone is at the ${n}.`;
  if (kind === 'tamper') return `The ${n} may have been covered or moved.`;
  return `I noticed movement on the ${n}.`;
}

/**
 * @param {{ event: { id: string, kind: 'person'|'motion'|'tamper', startedAt: number }, cameraName: string, snapshotPath?: string|null, silent?: boolean }} o
 * @returns {{ title: string, body: string, icon?: string, silent: boolean, urgency: 'critical', timeoutType: 'default' }}
 */
export function buildNotificationOptions(o) {
  const n = cameraLabel(o.cameraName);
  const title = o.event.kind === 'person' ? `Person at the ${n}` : o.event.kind === 'tamper' ? 'Camera tamper alert' : `Movement at the ${n}`;
  const body = o.event.kind === 'tamper'
    ? `${hhmm(o.event.startedAt)} · The ${n} may have been covered or moved. Click to see it.`
    : `${hhmm(o.event.startedAt)} · Click to see the clip`;
  /** @type {any} */
  const opts = { title, body, silent: !!o.silent, urgency: 'critical', timeoutType: 'default' };
  if (o.snapshotPath) opts.icon = o.snapshotPath;
  return opts;
}

/**
 * The lm:tapo:alert payload for the avatar (§8.11).
 * @param {{ event: { id: string, kind: 'person'|'motion'|'tamper', startedAt: number }, cameraName: string, quiet: boolean, describe: boolean,
 *   snapshot?: { mediaType: 'image/jpeg', data: string }|null }} o
 */
export function buildAvatarAlert(o) {
  /** @type {any} */
  const a = {
    id: o.event.id,
    kind: o.event.kind,
    at: o.event.startedAt,
    cameraName: cameraLabel(o.cameraName),
    line: alertLine(o.event.kind, o.cameraName),
    quiet: !!o.quiet,
    describe: !!(o.describe && o.snapshot),
  };
  if (a.describe) a.snapshot = o.snapshot;
  return a;
}

export class AlertManager {
  /**
   * @param {{ Notification?: any, nativeImage?: any, onClick?: (eventId: string) => void, log?: (level: string, msg: string) => void, record?: boolean }} o
   */
  constructor(o) {
    this._N = o.Notification;
    this._img = o.nativeImage;
    this._onClick = o.onClick || (() => {});
    this._log = o.log || (() => {});
    this._record = !!o.record;
    /** @type {any[]} */
    this._live = [];
    /** what was shown (titles, bodies, times) — the e2e hook @type {Array<{ title: string, body: string, at: number, eventId: string, silent: boolean, icon: boolean }>} */
    this.shown = [];
  }

  supported() {
    try {
      return !!this._N && (typeof this._N.isSupported !== 'function' || this._N.isSupported());
    } catch {
      return false;
    }
  }

  /**
   * The armed camera stopped watching (offline, no video): one notification; a click shows the
   * camera window.
   * @param {{ title: string, body: string, silent?: boolean }} o
   */
  notifyTrouble(o) {
    return this._show({ title: o.title, body: o.body, silent: !!o.silent, urgency: 'critical', timeoutType: 'default' }, '');
  }

  /**
   * @param {{ event: { id: string, kind: 'person'|'motion'|'tamper', startedAt: number }, cameraName: string, snapshotPath?: string|null, silent?: boolean }} o
   */
  notify(o) {
    return this._show(buildNotificationOptions(o), o.event.id);
  }

  /** @param {any} opts @param {string} eventId '' = no event (the click opens the camera window) */
  _show(opts, eventId) {
    if (this._record) this.shown.push({ title: opts.title, body: opts.body, at: Date.now(), eventId, silent: opts.silent, icon: !!opts.icon });
    if (!this.supported()) {
      this._log('info', '[tapo] notifications are not supported here');
      return false;
    }
    /** @type {any} */
    const nopts = { ...opts };
    if (opts.icon && this._img) {
      try {
        const img = this._img.createFromPath(opts.icon);
        if (img && !img.isEmpty()) nopts.icon = img;
        else delete nopts.icon;
      } catch {
        delete nopts.icon;
      }
    }
    try {
      const n = new this._N(nopts);
      n.on('click', () => this._onClick(eventId));
      n.on('close', () => { this._live = this._live.filter((x) => x !== n); });
      n.on('failed', (/** @type {any} */ _e, /** @type {string} */ err) => this._log('warn', `[tapo] notification failed: ${err}`));
      n.show();
      this._live = [...this._live.slice(-19), n];
      this._log('info', `[tapo] notification: ${opts.title}`);
      return true;
    } catch (err) {
      this._log('warn', `[tapo] could not show a notification: ${/** @type {Error} */ (err).message}`);
      return false;
    }
  }
}
