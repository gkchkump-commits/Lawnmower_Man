// Loads the pre-encoded segments (tests/fixtures/tapo/sim, made by make-fixtures.sh) and picks
// the one the virtual camera currently sees.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gridCell, segmentId } from './geometry.mjs';
import { accessUnits, isKeyFrame, parameterSets, profileLevelId, splitAnnexB, spropParameterSets } from './h264.mjs';

export const DEFAULT_FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/tapo/sim');

/**
 * @typedef {{ id: string, frames: Buffer[][], bytes: number }} Segment
 * @typedef {{ name: string, width: number, height: number, segments: Map<string, Segment>,
 *             sprop: string, profileLevelId: string }} StreamFixtures
 */

/** @type {Map<string, Record<string, StreamFixtures>>} */
const cache = new Map();

/**
 * Read every segment of every stream once per directory (≈ 2 MB).
 * @param {string} [dir] @returns {Record<string, StreamFixtures>}
 */
export function loadFixtures(dir = DEFAULT_FIXTURES) {
  const key = path.resolve(dir);
  const hit = cache.get(key);
  if (hit) return hit;
  const manifestFile = path.join(key, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`No simulator fixtures in ${key} (run tools/tapo-sim/make-fixtures.sh)`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  /** @type {Record<string, StreamFixtures>} */
  const out = {};
  for (const [name, info] of Object.entries(manifest.streams)) {
    /** @type {Map<string, Segment>} */
    const segments = new Map();
    let sprop = '';
    let pli = '';
    for (const id of Object.keys(/** @type {any} */ (info).segments)) {
      const data = fs.readFileSync(path.join(key, name, `${id}.h264`));
      const frames = accessUnits(splitAnnexB(data));
      if (!frames.length || !isKeyFrame(frames[0])) throw new Error(`${name}/${id}: does not start with a keyframe`);
      if (!sprop) {
        const ps = parameterSets(frames[0]);
        sprop = spropParameterSets(ps);
        pli = profileLevelId(ps.sps);
      }
      segments.set(id, { id, frames, bytes: data.length });
    }
    out[name] = { name, width: /** @type {any} */ (info).width, height: /** @type {any} */ (info).height, segments, sprop, profileLevelId: pli };
  }
  cache.set(key, out);
  return out;
}

/**
 * The segment for the current view: the grid cell nearest to the lens direction (ONVIF position
 * through the mirrorPan / invertTilt quirks), its person variant while someone is in the room,
 * or the privacy placeholder.
 * @param {StreamFixtures} stream
 * @param {{ x: number, y: number }} pos
 * @param {{ mirrorPan?: boolean, invertTilt?: boolean }} quirks
 * @param {{ person?: boolean, privacy?: boolean }} scenario
 * @returns {Segment}
 */
export function selectSegment(stream, pos, quirks, scenario) {
  if (scenario.privacy) {
    const p = stream.segments.get('privacy');
    if (p) return p;
  }
  const { i, j } = gridCell(quirks.mirrorPan ? -pos.x : pos.x, quirks.invertTilt ? -pos.y : pos.y);
  if (scenario.person) {
    const s = stream.segments.get(segmentId(i, j, true));
    if (s) return s;
  }
  const s = stream.segments.get(segmentId(i, j));
  if (!s) throw new Error(`missing segment ${segmentId(i, j)} in ${stream.name}`);
  return s;
}
