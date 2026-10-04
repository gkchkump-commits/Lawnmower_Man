// The docs send users to settings by their place in the drawer ("Settings → Claude → Work
// folder"). Every such reference must name a real drawer section and field label, and the
// settings the README tells users to change in the drawer must be there.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SECTIONS } from '../../../src/ui/settings-drawer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const docs = ['README.md', ...readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
// Windows' own Settings app, referenced for GPU selection — not the app's drawer
const OS_SETTINGS = new Set(['System']);

/** @returns {Array<{ file: string, section: string, field?: string }>} */
function references() {
  const out = [];
  for (const file of docs) {
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const m of text.matchAll(/Settings ?[→›] ?([A-Z][A-Za-z]+)(?: ?[→›] ?([A-Za-z][A-Za-z /()-]*[A-Za-z)]))?/g)) {
      out.push({ file, section: m[1], field: m[2] });
    }
  }
  return out;
}

describe('docs ↔ settings drawer', () => {
  it('finds the references (sanity)', () => {
    expect(references().length).toBeGreaterThanOrEqual(5);
  });

  it('every "Settings → Section → Field" in the docs exists in the drawer', () => {
    for (const ref of references()) {
      if (OS_SETTINGS.has(ref.section)) continue;
      const section = SECTIONS.find((s) => s.title === ref.section);
      expect(section, `${ref.file}: no drawer section "${ref.section}"`).toBeTruthy();
      if (ref.field) {
        const labels = section.fields.map((f) => f.label).filter(Boolean);
        expect(labels, `${ref.file}: no field "${ref.field}" in Settings → ${ref.section}`).toContain(ref.field);
      }
    }
  });

  it('offers the work folder, CLI path and avatar pack as text fields', () => {
    const fields = SECTIONS.flatMap((s) => s.fields);
    for (const p of ['claude.workdir', 'claude.cliPath', 'avatar.pack']) {
      expect(fields.find((f) => f.path === p)?.type, p).toBe('text');
    }
    // a cleared pack field saves the default pack (main rejects an empty pack name)
    expect(fields.find((f) => f.path === 'avatar.pack')?.emptyValue).toBe('reference');
  });
});
