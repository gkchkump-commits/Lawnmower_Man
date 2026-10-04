// Palette helpers (pure). Colours are CSS hex strings until converted by the engine.

/** Glow colours sampled from the reference video (tools/bake writes the same keys). */
export const DEFAULT_PALETTE = Object.freeze({
  eye: '#ffce9a',   // amber eye glow
  line: '#ffcf9b',  // gold contour / circuit lines
  rim: '#63c6ff',   // cyan rim light
  grid: '#c9d4e6',  // blue-white grid
  wisp: '#1ec5ff',  // cyan particles / wisps
  mote: '#ffc394',  // amber particles
});

export const PALETTE_KEYS = Object.freeze(['eye', 'line', 'rim', 'grid', 'wisp', 'mote']);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** @param {unknown} c */
export function isHexColor(c) {
  return typeof c === 'string' && HEX.test(c);
}

/**
 * Merge palettes: defaults <- pack palette (its *Glow variants win for emissive use) <- overrides.
 * Invalid entries are ignored.
 * @param {Record<string, string>|undefined} pack  pack.json palette
 * @param {Record<string, string>|undefined} overrides  options.colors
 * @returns {Record<'eye'|'line'|'rim'|'grid'|'wisp'|'mote', string>}
 */
export function mergePalette(pack, overrides) {
  /** @type {any} */
  const out = { ...DEFAULT_PALETTE };
  if (pack) {
    for (const k of PALETTE_KEYS) {
      const glow = pack[`${k}Glow`];
      if (isHexColor(glow)) out[k] = glow;
      else if (isHexColor(pack[k]) && (k === 'wisp' || k === 'mote' || k === 'grid')) out[k] = pack[k];
    }
  }
  if (overrides) {
    for (const k of PALETTE_KEYS) if (isHexColor(overrides[k])) out[k] = overrides[k];
  }
  return out;
}
