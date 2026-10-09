// Window geometry for the avatar overlay: size presets (contract §4), the chat panel extra,
// default placement, persistence clamping to visible displays and anchored resizing.
// Pure functions (no Electron import); main.js feeds them screen.getAllDisplays().
//
// Layout contract with the renderer: the window is the avatar area (W×H, always 2:3) on top,
// plus a chat panel strip of `chat.height` pixels BELOW it, full width. With
// settings.window.showChat the panel always fills the strip; without it (minimal mode) the
// panel drops down into the strip only when needed and the strip is transparent and
// click-through otherwise — so the chat never covers the face and the window never resizes
// when the mode changes. The renderer can derive this from window.innerWidth/innerHeight
// (avatarHeight = innerWidth * 1.5; chat = the rest) or read it from app.info().layout.

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {{ id?: number, bounds: Rect, workArea: Rect }} DisplayLike */
/** @typedef {'small'|'medium'|'large'} SizePreset */

export const SIZE_PRESETS = Object.freeze({
  small: Object.freeze({ width: 300, height: 450 }),
  medium: Object.freeze({ width: 400, height: 600 }),
  large: Object.freeze({ width: 560, height: 840 }),
});

/** Chat panel height per preset (added below the avatar area). */
export const CHAT_PANEL_HEIGHT = Object.freeze({ small: 200, medium: 240, large: 280 });
export const MIN_CHAT_PANEL_HEIGHT = 140;
/** The avatar area never shrinks below this when fitting a short screen (2:3 → 200 × 300). */
export const MIN_AVATAR_HEIGHT = 300;
/** Gap kept from the work-area edge for the default position. */
export const EDGE_MARGIN = 24;
/** At least this much of the window must stay on a display when restoring a position. */
export const MIN_VISIBLE = 80;

/** @param {unknown} p @returns {SizePreset} */
export function normalizePreset(p) {
  return p === 'small' || p === 'large' ? p : 'medium';
}

/**
 * Window size for a preset: the avatar area plus the chat strip below it (always reserved: in
 * minimal mode the panel drops down into it when needed). If a work area is given and the
 * window would not fit vertically, the chat strip shrinks first (down to MIN_CHAT_PANEL_HEIGHT).
 * @param {unknown} preset @param {boolean} showChat  panel always shown (false: drop-down)
 * @param {Rect} [workArea]
 */
export function windowLayout(preset, showChat, workArea) {
  const p = normalizePreset(preset);
  let avatar = { ...SIZE_PRESETS[p] };
  let chatHeight = CHAT_PANEL_HEIGHT[p];
  if (workArea) {
    if (avatar.height + chatHeight > workArea.height) {
      chatHeight = Math.max(MIN_CHAT_PANEL_HEIGHT, workArea.height - avatar.height);
    }
    // Still too tall (short screens, high display scaling: a 1080p laptop at 150% has ~670 px):
    // shrink the avatar area too, keeping 2:3 exactly (height a multiple of 3), so the whole
    // window — and the message box at its bottom — stays above the taskbar.
    const room = workArea.height - chatHeight;
    if (avatar.height > room) {
      const h = Math.max(MIN_AVATAR_HEIGHT, Math.floor(room / 3) * 3);
      avatar = { width: (h / 3) * 2, height: h };
    }
  }
  return {
    preset: p,
    width: avatar.width,
    height: avatar.height + chatHeight,
    avatar,
    chat: {
      position: /** @type {'bottom'} */ ('bottom'),
      width: avatar.width,
      height: chatHeight,
      mode: /** @type {'full'|'dropdown'} */ (showChat ? 'full' : 'dropdown'),
    },
  };
}

/** @param {Rect} a @param {Rect} b */
export function intersectionArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** @param {Rect} r */
const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/**
 * The display a rect belongs to: largest overlap, else nearest centre.
 * @param {Rect} rect @param {DisplayLike[]} displays
 * @returns {DisplayLike|null}
 */
export function pickDisplay(rect, displays) {
  if (!displays || !displays.length) return null;
  let best = null;
  let bestArea = 0;
  for (const d of displays) {
    const a = intersectionArea(rect, d.workArea);
    if (a > bestArea) {
      bestArea = a;
      best = d;
    }
  }
  if (best) return best;
  const c = center(rect);
  let bestDist = Infinity;
  for (const d of displays) {
    const dc = center(d.workArea);
    const dist = (dc.x - c.x) ** 2 + (dc.y - c.y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/**
 * Keep a window fully inside a work area (top-left wins when it is larger than the area).
 * @param {Rect} b @param {Rect} wa @returns {Rect}
 */
export function clampToWorkArea(b, wa) {
  // never larger than the work area (a window taller than it would hide under the taskbar)
  const width = Math.min(Math.round(b.width), Math.round(wa.width));
  const height = Math.min(Math.round(b.height), Math.round(wa.height));
  let x = Math.round(b.x);
  let y = Math.round(b.y);
  x = Math.min(x, wa.x + wa.width - width);
  y = Math.min(y, wa.y + wa.height - height);
  x = Math.max(x, wa.x);
  y = Math.max(y, wa.y);
  return { x, y, width, height };
}

/**
 * Default position: bottom-right corner of the work area (where desktop companions live).
 * @param {{ width: number, height: number }} size @param {Rect} wa @returns {Rect}
 */
export function defaultBounds(size, wa) {
  return clampToWorkArea(
    { x: wa.x + wa.width - size.width - EDGE_MARGIN, y: wa.y + wa.height - size.height - EDGE_MARGIN, ...size },
    wa,
  );
}

/**
 * Where to open the window: the saved position if it is still (mostly) on a connected display,
 * clamped fully onto that display; otherwise the default corner of the primary display.
 * @param {{ saved: {x:number,y:number}|null|undefined, size: {width:number,height:number}, displays: DisplayLike[], primary: DisplayLike }} o
 * @returns {Rect}
 */
export function placeWindow({ saved, size, displays, primary }) {
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const rect = { x: saved.x, y: saved.y, ...size };
    const visible = displays.some((d) => {
      const w = Math.min(rect.x + rect.width, d.workArea.x + d.workArea.width) - Math.max(rect.x, d.workArea.x);
      const h = Math.min(rect.y + rect.height, d.workArea.y + d.workArea.height) - Math.max(rect.y, d.workArea.y);
      return w >= Math.min(MIN_VISIBLE, rect.width) && h >= Math.min(MIN_VISIBLE, rect.height);
    });
    if (visible) {
      const d = pickDisplay(rect, displays) || primary;
      return clampToWorkArea(rect, d.workArea);
    }
  }
  return defaultBounds(size, primary.workArea);
}

/**
 * Size and place the window at start: placeWindow, with the layout fitted to the display the
 * window opens on. A saved position on a shorter second screen needs a smaller window (2:3 avatar
 * + chat) than the primary display would give.
 * @param {{ saved: {x:number,y:number}|null|undefined, preset: unknown, showChat: boolean, displays: DisplayLike[], primary: DisplayLike }} o
 * @returns {{ layout: ReturnType<typeof windowLayout>, bounds: Rect }}
 */
export function initialBounds({ saved, preset, showChat, displays, primary }) {
  let layout = windowLayout(preset, showChat, primary.workArea);
  let bounds = placeWindow({ saved, size: layout, displays, primary });
  const d = pickDisplay(bounds, displays) || primary;
  const fitted = windowLayout(preset, showChat, d.workArea);
  if (fitted.width !== layout.width || fitted.height !== layout.height) {
    layout = fitted;
    bounds = placeWindow({ saved, size: layout, displays, primary });
  }
  return { layout, bounds };
}

/**
 * Resize keeping the corner nearest the screen edge fixed (a window docked bottom-right grows
 * up and to the left), then clamp onto the display.
 * @param {Rect} old @param {{ width: number, height: number }} size @param {Rect} wa @returns {Rect}
 */
export function resizeAnchored(old, size, wa) {
  const c = center(old);
  const wc = center(wa);
  const x = c.x > wc.x ? old.x + old.width - size.width : old.x;
  const y = c.y > wc.y ? old.y + old.height - size.height : old.y;
  return clampToWorkArea({ x, y, width: size.width, height: size.height }, wa);
}

/**
 * Re-clamp after displays changed (monitor unplugged, resolution/DPI change).
 * @param {Rect} b @param {DisplayLike[]} displays @param {DisplayLike} primary @returns {Rect}
 */
export function reclamp(b, displays, primary) {
  return placeWindow({ saved: { x: b.x, y: b.y }, size: { width: b.width, height: b.height }, displays, primary });
}

// ---------------------------------------------------------------------------------------------
// Dragging the avatar. CSS drag regions (-webkit-app-region) do not mix with click-through on
// Windows: entering one makes the page see a pointerleave, the click-through gate then turns the
// window transparent to clicks and the mouse-down goes to the desktop. So the window is moved by
// the main process instead: the renderer reports pointer down / up over the head, main polls the
// global cursor and moves the window by the cursor's offset from where the drag started.

/** The cursor must move this far (DIP) before a press on the head becomes a drag (else: a click). */
export const DRAG_THRESHOLD = 3;
/** A drag never lasts longer than this (a lost pointer-up must not glue the window to the cursor). */
export const DRAG_MAX_MS = 120_000;

/**
 * Window bounds while dragging: the start bounds shifted by the cursor's movement, size unchanged.
 * Returns null while the cursor is still within DRAG_THRESHOLD of where the press started.
 * @param {Rect} start window bounds when the press started
 * @param {{x:number,y:number}} from cursor (screen DIP) when the press started
 * @param {{x:number,y:number}} to current cursor (screen DIP)
 * @param {boolean} moving already past the threshold (then every movement counts)
 * @returns {Rect|null}
 */
export function dragBounds(start, from, to, moving) {
  const dx = Math.round(to.x - from.x);
  const dy = Math.round(to.y - from.y);
  if (!moving && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return null;
  return { x: start.x + dx, y: start.y + dy, width: start.width, height: start.height };
}

/** Within this distance (DIP) of a screen edge a dragged window locks flush against it. */
export const SNAP_DISTANCE = 24;

/**
 * Magnetic screen edges, like a normal window on Windows: while dragging, a window that comes
 * within SNAP_DISTANCE of an edge of the work area it is on locks flush against that edge (two
 * edges at once: a corner), and lets go again once the cursor pulls it further away. Stateless:
 * it is applied to the raw drag position on every step, so releasing is just moving on.
 * @param {Rect} b @param {DisplayLike[]} displays @param {number} [dist]
 * @returns {Rect}
 */
export function snapToEdges(b, displays, dist = SNAP_DISTANCE) {
  const d = pickDisplay(b, displays);
  if (!d || !(dist > 0)) return b;
  const wa = d.workArea;
  let { x, y } = b;
  const left = Math.abs(b.x - wa.x);
  const right = Math.abs(wa.x + wa.width - (b.x + b.width));
  if (left <= dist && left <= right) x = wa.x;
  else if (right <= dist) x = wa.x + wa.width - b.width;
  const top = Math.abs(b.y - wa.y);
  const bottom = Math.abs(wa.y + wa.height - (b.y + b.height));
  if (top <= dist && top <= bottom) y = wa.y;
  else if (bottom <= dist) y = wa.y + wa.height - b.height;
  return x === b.x && y === b.y ? b : { ...b, x, y };
}

/**
 * Where a dragged window settles when the button is released: fully on the display it was
 * dropped on (most overlap, else the nearest), so it cannot end up under the taskbar or half
 * off-screen.
 * @param {Rect} b @param {DisplayLike[]} displays @param {DisplayLike} primary @returns {Rect}
 */
export function settleDrop(b, displays, primary) {
  const d = pickDisplay(b, displays) || primary;
  return clampToWorkArea(b, d.workArea);
}
