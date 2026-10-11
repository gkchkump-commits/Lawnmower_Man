// The "Hey Jade" glyph: an ear; slashed when the microphone is off, blocked or muted, so the
// state never depends on colour alone (ux.md A11Y-4). The viewBox is cropped to the ear so it
// stays legible at the status bar's 12 px.

const SVGNS = 'http://www.w3.org/2000/svg';

const EAR = [
  // the helix and the lobe
  'M6.5 8.5a5.5 5.5 0 0 1 11 0c0 5-5 5.5-5 9.5a3 3 0 0 1-6 0',
  // the inner fold and the tragus
  'M14.5 8.5a2.5 2.5 0 0 0-5 0v1.2a1.9 1.9 0 0 1 0 3.8',
];
const SLASH = 'M5.5 4l13 16';

/** @param {boolean} slashed @param {string} [cls] */
export function earIcon(slashed, cls = 'wake-ear') {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '4 2 16 20');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of slashed ? [...EAR, SLASH] : EAR) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
