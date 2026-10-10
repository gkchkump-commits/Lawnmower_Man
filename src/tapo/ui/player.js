// The clip player (contract §9.2): an event's video, stream-copied by main and served from
// app://lawnmower/__clips/… (in the browser preview, a sample WebM). Delete and Open folder.
// Opening an event marks it as seen.

import { h } from '../../ui/dom.js';
import { KIND_LABEL, dayLabel, formatClock, formatDuration } from '../status.js';
import { confirmAction, openDialog } from './dialogs.js';
import { tapoIcon } from './icons.js';

/**
 * @param {any} ev EventSummary
 * @param {{ onDelete: (ev: any) => Promise<void>|void, onOpenFolder: () => void, now?: number }} o
 */
export function openPlayer(ev, o) {
  const kind = /** @type {any} */ (KIND_LABEL)[ev.kind] || ev.kind;
  const when = `${dayLabel(ev.startedAt, o.now ?? Date.now())}, ${formatClock(ev.startedAt)}`;
  const facts = [
    when,
    Number.isFinite(ev.durationSec) ? formatDuration(ev.durationSec) : null,
    ev.preset ? `at ${ev.preset}` : null,
    ev.unconfirmed ? 'seen by the camera only' : null,
  ].filter(Boolean).join(' · ');
  /** @type {HTMLElement} */
  let media;
  if (ev.clipUrl) {
    media = h('video', { class: 'player-video', src: ev.clipUrl, controls: true, autoplay: true, muted: true, playsinline: true, preload: 'auto', poster: ev.snapshotUrl || undefined });
    media.addEventListener('error', () => media.replaceWith(h('div', { class: 'player-missing' }, tapoIcon('warn'), 'The clip could not be played. It may have been deleted or moved.')));
  } else if (ev.snapshotUrl) {
    media = h('div', { class: 'player-still' }, h('img', { src: ev.snapshotUrl, alt: `${kind} at ${when}` }), h('p', { class: 'player-note' }, ev.live ? 'This is happening now. The clip is saved when it ends.' : 'No clip was saved for this event.'));
  } else {
    media = h('div', { class: 'player-missing' }, tapoIcon('camera'), ev.live ? 'This is happening now. The clip is saved when it ends.' : 'No clip or picture was saved for this event.');
  }
  const del = h('button', { type: 'button', class: 'btn ghost danger-text' }, tapoIcon('trash', 'icon tiny'), 'Delete');
  const folder = h('button', { type: 'button', class: 'btn ghost' }, tapoIcon('folder', 'icon tiny'), 'Open folder');
  const close = h('button', { type: 'button', class: 'btn amber' }, 'Close');
  const dlg = openDialog({
    id: 'player',
    title: `${kind}${ev.kind === 'person' && Number.isFinite(ev.maxScore) && ev.maxScore > 0 ? ` (${Math.round(ev.maxScore * 100)}% sure)` : ''}`,
    icon: ev.kind === 'person' ? 'person' : 'motion',
    className: 'dlg-player',
    body: [media, h('p', { class: 'player-facts' }, facts)],
    actions: [del, folder, h('span', { class: 'spacer' }), close],
  });
  dlg.dataset.event = ev.id;
  close.addEventListener('click', () => dlg.close());
  folder.addEventListener('click', () => o.onOpenFolder());
  del.addEventListener('click', async () => {
    const ok = await confirmAction({ title: 'Delete this event?', text: 'The clip and its picture are removed from this PC.', okLabel: 'Delete', danger: true });
    if (!ok) return;
    await o.onDelete(ev);
    dlg.close();
  });
  if (ev.live) del.disabled = true;
  return dlg;
}
