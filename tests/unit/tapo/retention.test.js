import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RETENTION_RE, planDeletions, runRetention } from '../../../electron/tapo/retention.js';

const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();
const DAY = 86400000;
const f = (rel, size = 1000, mtimeMs = NOW) => ({ rel, size, mtimeMs });

describe('planDeletions', () => {
  it('deletes whole events older than the retention, never anything else', () => {
    const entries = [
      f('2026-10-01/080000-person-aaaa.mp4'), f('2026-10-01/080000-person-aaaa.jpg'), f('2026-10-01/080000-person-aaaa.json'),
      f('2026-10-09/080000-motion-bbbb.mp4'), f('2026-10-09/080000-motion-bbbb.json'),
      f('2026-10-01/notes.txt'), f('2026-10-01/080000-person-AAAA.mp4'), f('../etc/passwd'),
    ];
    expect(planDeletions(entries, { now: NOW, retentionDays: 7, maxBytes: 1e12 }).sort()).toEqual([
      '2026-10-01/080000-person-aaaa.jpg', '2026-10-01/080000-person-aaaa.json', '2026-10-01/080000-person-aaaa.mp4',
    ]);
  });

  it('then the oldest events while over the byte cap', () => {
    const entries = [
      f('2026-10-08/080000-person-aaaa.mp4', 400), f('2026-10-08/080000-person-aaaa.json', 1),
      f('2026-10-09/080000-person-bbbb.mp4', 400),
      f('2026-10-10/080000-person-cccc.mp4', 400),
    ];
    expect(planDeletions(entries, { now: NOW, retentionDays: 30, maxBytes: 900 }).sort()).toEqual(['2026-10-08/080000-person-aaaa.json', '2026-10-08/080000-person-aaaa.mp4']);
    expect(planDeletions(entries, { now: NOW, retentionDays: 30, maxBytes: 300 })).toHaveLength(4);
  });

  it('stale .part files after an hour; the clip being recorded is kept', () => {
    const entries = [
      f('2026-10-10/100000-person-aaaa.mp4.part', 10, NOW - 2 * 3600000),
      f('2026-10-10/115900-person-bbbb.mp4.part', 10, NOW - 60000),
      f('2026-09-01/115900-person-cccc.mp4', 10, NOW - 40 * DAY),
    ];
    expect(planDeletions(entries, { now: NOW, retentionDays: 7, maxBytes: 1e12, keep: new Set(['2026-09-01/115900-person-cccc']) })).toEqual(['2026-10-10/100000-person-aaaa.mp4.part']);
  });

  it('the pattern', () => {
    expect(RETENTION_RE.test('2026-10-10/140312-person-a1b2.mp4')).toBe(true);
    expect(RETENTION_RE.test('2026-10-10/140312-tamper-a1b2.mp4.part')).toBe(true);
    expect(RETENTION_RE.test('2026-10-10/140312-car-a1b2.mp4')).toBe(false);
    expect(RETENTION_RE.test('2026-10-10/140312-person-a1b2.exe')).toBe(false);
  });
});

describe('runRetention', () => {
  it('deletes on disk, removes emptied day folders, ignores foreign files and links', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ret-'));
    const put = (rel, size = 100) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), Buffer.alloc(size));
    };
    put('2026-09-01/080000-person-aaaa.mp4');
    put('2026-09-01/080000-person-aaaa.json');
    put('2026-09-02/080000-person-bbbb.mp4');
    put('2026-09-02/my-own-video.mp4');
    put('2026-10-10/080000-person-cccc.mp4', 300);
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-outside-')), 'precious.mp4');
    fs.writeFileSync(outside, 'keep me');
    fs.symlinkSync(outside, path.join(dir, '2026-09-02', '080000-motion-dddd.mp4'));
    const logs = [];
    const r = await runRetention({ dir, settings: { retentionDays: 7, maxStorageGB: 5 }, now: NOW, log: (l, m) => logs.push(m) });
    expect(r.deleted.sort()).toEqual(['2026-09-01/080000-person-aaaa.json', '2026-09-01/080000-person-aaaa.mp4', '2026-09-02/080000-person-bbbb.mp4']);
    expect(fs.existsSync(path.join(dir, '2026-09-01'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '2026-09-02', 'my-own-video.mp4'))).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep me');
    expect(r).toMatchObject({ bytes: 300, clips: 1 });
    expect(await runRetention({ dir: path.join(dir, 'missing'), settings: { retentionDays: 7, maxStorageGB: 5 } })).toEqual({ deleted: [], bytes: 0, clips: 0 });
  });
});
