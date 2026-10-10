// Icons for the Home camera window: the app's stroke icons (src/ui/dom.js) plus a few of its
// own, drawn the same way (24×24, round caps, currentColor).

import { ICONS } from '../../ui/dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const TAPO_ICONS = Object.freeze({
  ...ICONS,
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  home: 'M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-5h4v5',
  armed: 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6zM8.5 12l2.5 2.5 4.5-5',
  disarmed: 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z',
  folder: 'M3 7h6l2 2h10v10H3z',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4',
  star: 'M12 4l2.4 5 5.6.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.6-.8z',
  sidebar: 'M4 5h16v14H4zM15 5v14',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  help: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  target: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  play: 'M8 5v14l11-7z',
  person: 'M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 20c.8-3.6 3.6-6 7-6s6.2 2.4 7 6',
  motion: 'M3 12h3l2-5 4 10 2-5h7',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l4 4',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  keyboard: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8',
  calibrate: 'M12 3a9 9 0 1 0 9 9M12 7v5l3 2M17 3l4 4M21 3l-4 4',
});

/**
 * @param {keyof typeof TAPO_ICONS} name @param {string} [cls]
 */
export function tapoIcon(name, cls = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', TAPO_ICONS[name] || '');
  svg.appendChild(p);
  return svg;
}
