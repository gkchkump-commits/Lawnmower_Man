import { describe, expect, it } from 'vitest';
import { SpeechQueue } from '../../../src/app/speech-queue.js';
import { fakePlayer, fakeTts, tick, waitFor } from './helpers.js';

describe('SpeechQueue', () => {
  it('plays in order even when synthesis finishes out of order', async () => {
    // the second sentence synthesizes much faster than the first
    const tts = fakeTts({ delayMs: (t) => (t === 'one' ? 40 : 2) });
    const player = fakePlayer({ clipMs: 5 });
    const q = new SpeechQueue({ tts, player, maxParallel: 2, maxAhead: 2 });
    let idle = 0;
    q.on('idle', () => idle++);
    q.push('one');
    q.push('two');
    q.push('three');
    expect(q.busy).toBe(true);
    await waitFor(() => idle === 1);
    expect(player.played.map((c) => c.text)).toEqual(['one', 'two', 'three']);
    expect(q.busy).toBe(false);
  });

  it('limits parallel synthesis and prefetch distance', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const started = [];
    const tts = {
      synthesize: (text) => new Promise((resolve) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started.push(text);
        setTimeout(() => { inFlight--; resolve({ kind: 'audio', text }); }, 10);
      }),
    };
    const player = fakePlayer({ clipMs: 30 });
    const q = new SpeechQueue({ tts, player, maxParallel: 2, maxAhead: 2 });
    for (const t of ['a', 'b', 'c', 'd', 'e', 'f']) q.push(t);
    expect(started).toEqual(['a', 'b']); // only two at once
    await waitFor(() => player.played.length === 1);
    // while "a" plays, at most 2 sentences beyond it are prepared
    expect(started.length).toBeLessThanOrEqual(3);
    await waitFor(() => !q.busy, { timeout: 3000 });
    expect(maxInFlight).toBe(2);
    expect(player.played.map((c) => c.text)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('skips sentences that fail to synthesize and reports them', async () => {
    const tts = fakeTts({ fail: (t) => t === 'bad' });
    const player = fakePlayer({ clipMs: 2 });
    const q = new SpeechQueue({ tts, player });
    const errors = [];
    q.on('error', (e, item) => errors.push(item.text));
    q.push('good');
    q.push('bad');
    q.push('fine');
    await waitFor(() => !q.busy);
    expect(player.played.map((c) => c.text)).toEqual(['good', 'fine']);
    expect(errors).toEqual(['bad']);
  });

  it('clear() aborts synthesis, stops the player and emits idle once', async () => {
    const tts = fakeTts({ delayMs: 50 });
    const player = fakePlayer({ clipMs: 50 });
    const q = new SpeechQueue({ tts, player });
    let idle = 0;
    q.on('idle', () => idle++);
    q.push('x');
    q.push('y');
    q.clear();
    expect(q.busy).toBe(false);
    expect(player.stops).toBe(1);
    expect(tts.aborted).toBe(2);
    expect(idle).toBe(1);
    await tick(80);
    expect(player.played).toHaveLength(0); // late results are ignored
    expect(idle).toBe(1);
  });

  it('emits ready as soon as a clip is synthesized, before it plays (the lip-sync analyses it then)', async () => {
    const tts = fakeTts({ delayMs: (t) => (t === 'one' ? 2 : 4) });
    const player = fakePlayer({ clipMs: 30 });
    const q = new SpeechQueue({ tts, player, maxParallel: 2, maxAhead: 2 });
    const log = [];
    q.on('ready', (item) => log.push(`ready ${item.text} ${item.clip ? 'clip' : '-'}`));
    q.on('playing', (item) => log.push(`playing ${item.text}`));
    q.push('one');
    q.push('two');
    await waitFor(() => !q.busy);
    // the second sentence is ready while the first one plays
    expect(log.indexOf('ready two clip')).toBeLessThan(log.indexOf('playing two'));
    expect(log.indexOf('ready two clip')).toBeGreaterThan(log.indexOf('ready one clip'));
    expect(log.filter((x) => x.startsWith('ready'))).toHaveLength(2);
  });

  it('emits playing when the player starts one of its clips; ignores empty text', async () => {
    const tts = fakeTts();
    const player = fakePlayer({ clipMs: 2 });
    const q = new SpeechQueue({ tts, player });
    const playing = [];
    q.on('playing', (item) => playing.push(item.text));
    expect(q.push('   ')).toBeNull();
    q.push('hello');
    await waitFor(() => !q.busy);
    expect(playing).toEqual(['hello']);
  });
});
