// Window layout. In Electron the window is the avatar area (W × 1.5W, 2:3) plus — when the
// chat panel is shown — a full-width strip below it (electron/window-manager.js), so the strip
// height is simply what is left under the 2:3 avatar area. In a plain browser (dev, tests)
// the page can be any size: the strip gets about a third of the height.

/**
 * @param {{ width: number, height: number, showChat: boolean, electron: boolean }} o
 * @returns {{ mode: 'full'|'minimal', chatHeight: number }}
 */
export function computeLayout(o) {
  if (!o.showChat) return { mode: 'minimal', chatHeight: 0 };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  if (o.electron) {
    const avatarH = Math.round(o.width * 1.5);
    const rest = o.height - avatarH;
    // just after toggling, the window may not have been resized yet
    if (rest >= 120) return { mode: 'full', chatHeight: rest };
    return { mode: 'full', chatHeight: Math.round(clamp(o.height * 0.3, 120, 280)) };
  }
  return { mode: 'full', chatHeight: Math.round(clamp(o.height * 0.34, 190, 300)) };
}
