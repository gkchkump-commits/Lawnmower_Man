// The mock bridge (browser preview, Playwright) takes images like main does, and the settings
// drawer has the Camera section.
import { describe, expect, it } from 'vitest';
import { MOCK_REPLIES, createMockBridge, mockTurnImages } from '../../../src/bridge/mock.js';
import { SECTIONS } from '../../../src/ui/settings-drawer.js';

const JPEG = '/9j/4AAQSkZJRgABAQ==';

describe('mock bridge: images with a turn', () => {
  it('validates like main (lighter) and records what arrived', async () => {
    expect(mockTurnImages(undefined)).toEqual([]);
    expect(mockTurnImages({ images: [{ mediaType: 'image/jpeg', data: JPEG, x: 1 }] })).toEqual([{ mediaType: 'image/jpeg', data: JPEG }]);
    expect(() => mockTurnImages('x')).toThrow(/object/);
    expect(() => mockTurnImages({ images: {} })).toThrow(/list/);
    expect(() => mockTurnImages({ images: [1, 2, 3] })).toThrow(/at most 2/);
    expect(() => mockTurnImages({ images: [{ mediaType: 'image/gif', data: JPEG }] })).toThrow(/JPEG, PNG or WebP/);
    expect(() => mockTurnImages({ images: [{ mediaType: 'image/jpeg', data: `data:image/jpeg;base64,${JPEG}` }] })).toThrow(/data: prefix/);
    expect(() => mockTurnImages({ images: [{ mediaType: 'image/jpeg', data: 'not base64!' }] })).toThrow(/base64/);
  });

  it('a turn with a picture is acknowledged; without one it behaves as before', async () => {
    const b = createMockBridge({ wordDelayMs: 0, firstTokenMs: 0, startupMs: 0 });
    const events = [];
    b.claude.onEvent((e) => events.push(e));
    const { turnId } = await b.claude.send('can you see me?', { images: [{ mediaType: 'image/jpeg', data: JPEG }] });
    for (let i = 0; i < 200 && !events.some((e) => e.type === 'turn_end' && e.turnId === turnId); i++) await new Promise((r) => setTimeout(r, 5));
    const end = events.find((e) => e.type === 'turn_end' && e.turnId === turnId);
    expect(end.result).toBe(MOCK_REPLIES.image);
    expect(b.__mock.images()).toEqual([{ turnId, text: 'can you see me?', mediaType: 'image/jpeg', data: JPEG }]);
    expect(b.__mock.calls).toContainEqual(['claude.send', { text: 'can you see me?', images: [{ mediaType: 'image/jpeg', chars: JPEG.length }] }]);
    await expect(b.claude.send('x', { images: [{ mediaType: 'text/html', data: JPEG }] })).rejects.toThrow();
    const plain = await b.claude.send('hello');
    for (let i = 0; i < 400 && !events.some((e) => e.type === 'turn_end' && e.turnId === plain.turnId); i++) await new Promise((r) => setTimeout(r, 5));
    expect(events.find((e) => e.type === 'turn_end' && e.turnId === plain.turnId).result).toBe(MOCK_REPLIES.greeting);
    expect(b.__mock.images()).toHaveLength(1);
    b.__mock.dispose();
  });

  it('camera settings go through the mock settings store', async () => {
    const b = createMockBridge({ startupMs: 0 });
    const s = await b.settings.set({ camera: { enabled: true, deviceId: 'abc', shareWithClaude: 'yes' } });
    expect(s.camera).toMatchObject({ enabled: true, deviceId: 'abc', shareWithClaude: false });
    b.__mock.dispose();
  });
});

describe('settings drawer: Camera section', () => {
  it('has every camera setting, the device picker and an info block', () => {
    const cam = SECTIONS.find((s) => s.id === 'camera');
    expect(cam.title).toBe('Camera');
    const paths = cam.fields.map((f) => f.path).filter(Boolean);
    expect(paths).toEqual(['camera.enabled', 'camera.deviceId', 'camera.followFace', 'camera.presence', 'camera.mirrorExpressions', 'camera.shareWithClaude', 'camera.greeting', 'camera.lookToTalk']);
    expect(cam.fields.find((f) => f.path === 'camera.deviceId').type).toBe('select');
    expect(cam.fields.find((f) => f.path === 'camera.shareWithClaude').label).toBe('Let Claude see me');
    expect(cam.fields.some((f) => f.type === 'info' && f.id === 'cameraInfo')).toBe(true);
  });
});
