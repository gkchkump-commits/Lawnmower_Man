import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore, clipUrl, eventBase, newEventId, toSummary } from '../../../electron/tapo/event-store.js';

describe('event ids and names', () => {
  it('local time + 4 random characters; base path by kind', () => {
    const at = new Date(2026, 9, 10, 14, 3, 12).getTime();
    expect(newEventId(at, () => 'a1b2')).toBe('20261010-140312-a1b2');
    expect(newEventId(at)).toMatch(/^20261010-140312-[a-z0-9]{4}$/);
    expect(eventBase('20261010-140312-a1b2', 'person')).toBe('2026-10-10/140312-person-a1b2');
    expect(eventBase('20261010-140312-a1b2', 'person', new Date(2026, 9, 10, 14, 5, 0).getTime())).toBe('2026-10-10/140500-person-a1b2');
    expect(() => eventBase('../x', 'person')).toThrow();
    expect(clipUrl('2026-10-10/140312-person-a1b2.mp4')).toBe('app://lawnmower/__clips/2026-10-10/140312-person-a1b2.mp4');
  });
});

describe('EventStore', () => {
  it('writes records next to the clips, lists newest first, filters, acks and removes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-evs-'));
    const s = new EventStore({ getDir: () => dir, now: () => new Date(2026, 9, 10, 18, 0, 0).getTime() });
    const t = (h, m) => new Date(2026, 9, 10, h, m, 0);
    await s.upsert({ id: '20261010-140000-aaaa', kind: 'person', camera: 'front door camera', startedAt: t(14, 0).toISOString(), sources: ['local-person'] });
    await s.upsert({ id: '20261010-150000-bbbb', kind: 'motion', camera: 'front door camera', startedAt: t(15, 0).toISOString(), sources: ['camera-motion'] });
    await s.upsert({ id: '20261010-140000-aaaa', endedAt: t(14, 1).toISOString(), durationSec: 60, clip: '2026-10-10/140000-person-aaaa.mp4', notified: true });
    const file = path.join(dir, '2026-10-10', '140000-person-aaaa.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk).toMatchObject({ v: 1, id: '20261010-140000-aaaa', kind: 'person', durationSec: 60, notified: true, announced: false, described: '', acknowledged: false });
    expect('base' in onDisk).toBe(false);
    let l = await s.list();
    expect(l.total).toBe(2);
    expect(l.events.map((e) => e.id)).toEqual(['20261010-150000-bbbb', '20261010-140000-aaaa']);
    expect(l.events[1]).toMatchObject({ kind: 'person', clipUrl: 'app://lawnmower/__clips/2026-10-10/140000-person-aaaa.mp4', durationSec: 60, notified: true });
    expect((await s.list({ kinds: ['person'] })).events).toHaveLength(1);
    expect((await s.list({ beforeMs: t(15, 0).getTime() })).events.map((e) => e.id)).toEqual(['20261010-140000-aaaa']);
    expect((await s.list({ sinceMs: t(14, 30).getTime() })).events.map((e) => e.id)).toEqual(['20261010-150000-bbbb']);
    expect(s.counts()).toEqual({ todayCount: 2, lastEventAt: t(15, 0).getTime() });
    // snapshot
    const jpg = await s.writeSnapshot('20261010-140000-aaaa', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    expect(fs.existsSync(jpg)).toBe(true);
    expect((await s.list({ kinds: ['person'] })).events[0].snapshotUrl).toBe('app://lawnmower/__clips/2026-10-10/140000-person-aaaa.jpg');
    // a fresh store finds them again by scanning
    const s2 = new EventStore({ getDir: () => dir });
    await s2.scan();
    expect((await s2.list()).total).toBe(2);
    expect(await s2.ack('20261010-150000-bbbb')).toBe(true);
    expect(s2.get('20261010-150000-bbbb')?.acknowledged).toBe(true);
    fs.writeFileSync(path.join(dir, '2026-10-10', '140000-person-aaaa.mp4'), 'clip');
    expect(await s2.remove('20261010-140000-aaaa')).toBe(true);
    expect(fs.readdirSync(path.join(dir, '2026-10-10')).sort()).toEqual(['150000-motion-bbbb.json']);
    expect(await s2.remove('nope')).toBe(false);
  });

  it('a snapshot right after the first record of a fresh store is kept (no race with the first scan)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-evs-'));
    fs.mkdirSync(path.join(dir, '2026-10-09'));
    fs.writeFileSync(path.join(dir, '2026-10-09', '120000-motion-zzzz.json'), JSON.stringify({ v: 1, id: '20261009-120000-zzzz', kind: 'motion', startedAt: '2026-10-09T10:00:00.000Z', sources: [] }));
    const s = new EventStore({ getDir: () => dir });
    const id = '20261010-140000-aaaa';
    const rec = s.upsert({ id, kind: 'person', camera: 'c', startedAt: new Date(2026, 9, 10, 14, 0, 0).toISOString(), sources: [] });
    const jpg = s.writeSnapshot(id, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // not awaiting the upsert
    await rec;
    expect(await jpg).toBe(path.join(dir, '2026-10-10', '140000-person-aaaa.jpg'));
    expect(s.get(id)?.snapshot).toBe('2026-10-10/140000-person-aaaa.jpg');
    expect((await s.list()).total).toBe(2);
  });

  it('a rescan keeps records written or removed while it runs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-evs-'));
    const s = new EventStore({ getDir: () => dir });
    await s.upsert({ id: '20261010-140000-aaaa', kind: 'person', camera: 'c', startedAt: new Date(2026, 9, 10, 14, 0, 0).toISOString(), sources: [] });
    await s.upsert({ id: '20261010-150000-bbbb', kind: 'motion', camera: 'c', startedAt: new Date(2026, 9, 10, 15, 0, 0).toISOString(), sources: [] });
    const scan = s.scan();
    const scan2 = s.scan();
    expect(scan2).toBe(scan); // one shared scan
    const write = s.upsert({ id: '20261010-160000-cccc', kind: 'tamper', camera: 'c', startedAt: new Date(2026, 9, 10, 16, 0, 0).toISOString(), sources: [] });
    const gone = s.remove('20261010-150000-bbbb');
    await Promise.all([scan, write, gone]);
    expect([...(await s.list()).events.map((e) => e.id)].sort()).toEqual(['20261010-140000-aaaa', '20261010-160000-cccc']);
    // a later patch merges with the full record (not a fresh one)
    await s.upsert({ id: '20261010-160000-cccc', bytes: 10 });
    expect(s.get('20261010-160000-cccc')).toMatchObject({ kind: 'tamper', bytes: 10, base: '2026-10-10/160000-tamper-cccc' });
  });

  it('toSummary has no paths, only app:// URLs', () => {
    const sum = toSummary({ v: 1, id: '20261010-140000-aaaa', camera: 'c', kind: 'tamper', startedAt: '2026-10-10T12:00:00.000Z', sources: ['camera-tamper'], unconfirmed: true, notified: false, announced: false, described: '', acknowledged: false, base: '2026-10-10/140000-tamper-aaaa', clip: '2026-10-10/140000-tamper-aaaa.mp4', maxScore: 0.8312 });
    expect(sum).toEqual({ id: '20261010-140000-aaaa', kind: 'tamper', startedAt: Date.parse('2026-10-10T12:00:00.000Z'), sources: ['camera-tamper'], notified: false, announced: false, acknowledged: false, unconfirmed: true, maxScore: 0.83, clipUrl: 'app://lawnmower/__clips/2026-10-10/140000-tamper-aaaa.mp4' });
  });
});
