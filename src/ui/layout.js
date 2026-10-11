// Window layout. In Electron the window is the avatar area (W × 1.5W, 2:3) plus a full-width
// chat strip below it (electron/window-manager.js), so the strip height is simply what is left
// under the 2:3 avatar area. The strip exists in both modes: 'full' keeps the panel in it,
// 'minimal' drops the panel down into it only when needed (never over the face). In a plain
// browser (dev, tests) the page can be any size: the strip gets about a third of the height.

/**
 * @param {{ width: number, height: number, showChat: boolean, electron: boolean }} o
 * @returns {{ mode: 'full'|'minimal', chatHeight: number }}
 */
export function computeLayout(o) {
  const mode = o.showChat ? 'full' : 'minimal';
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  if (o.electron) {
    const avatarH = Math.round(o.width * 1.5);
    const rest = o.height - avatarH;
    // a window from an older main process (or mid-resize) may not have the strip yet
    if (rest >= 120) return { mode, chatHeight: rest };
    return { mode, chatHeight: Math.round(clamp(o.height * 0.3, 120, 280)) };
  }
  return { mode, chatHeight: Math.round(clamp(o.height * 0.34, 190, 300)) };
}
