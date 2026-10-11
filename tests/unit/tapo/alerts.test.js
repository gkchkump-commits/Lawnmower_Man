import { describe, it, expect } from 'vitest';
import { alertLine, buildAvatarAlert, buildNotificationOptions, cameraLabel, AlertManager } from '../../../electron/tapo/alerts.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString('base64');

describe('alerts', () => {
  const ev = (kind) => ({ id: '20261010-140312-a1b2', kind, startedAt: new Date(2026, 9, 10, 14, 3, 12).getTime() });
  it('notification texts', () => {
    expect(buildNotificationOptions({ event: ev('person'), cameraName: 'front door camera', snapshotPath: '/c/x.jpg' })).toEqual({ title: 'Person at the front door camera', body: '14:03 · Click to see the clip', icon: '/c/x.jpg', silent: false, urgency: 'critical', timeoutType: 'default' });
    expect(buildNotificationOptions({ event: ev('motion'), cameraName: 'The garden cam', silent: true })).toMatchObject({ title: 'Movement at the garden cam', silent: true });
    expect(buildNotificationOptions({ event: ev('tamper'), cameraName: 'camera' }).title).toBe('Camera tamper alert');
    expect('icon' in buildNotificationOptions({ event: ev('person'), cameraName: 'camera' })).toBe(false);
  });

  it('spoken lines and the avatar alert', () => {
    expect(alertLine('person', 'camera')).toBe('Someone is at the camera.');
    expect(alertLine('motion', 'front door camera')).toBe('I noticed movement on the front door camera.');
    expect(alertLine('tamper', 'camera')).toBe('The camera may have been covered or moved.');
    expect(cameraLabel('  ')).toBe('camera');
    const a = buildAvatarAlert({ event: ev('person'), cameraName: 'camera', quiet: false, describe: true, snapshot: { mediaType: 'image/jpeg', data: JPEG } });
    expect(a).toEqual({ id: '20261010-140312-a1b2', kind: 'person', at: ev('person').startedAt, cameraName: 'camera', line: 'Someone is at the camera.', quiet: false, describe: true, snapshot: { mediaType: 'image/jpeg', data: JPEG } });
    expect(buildAvatarAlert({ event: ev('person'), cameraName: 'camera', quiet: true, describe: true, snapshot: null })).toMatchObject({ describe: false, quiet: true });
  });

  it('AlertManager shows a Notification, keeps it referenced and records it for the e2e hook', () => {
    const shown = [];
    class FakeNotification {
      static isSupported() { return true; }
      constructor(o) { this.o = o; this.handlers = {}; shown.push(this); }
      on(e, f) { this.handlers[e] = f; }
      show() { this.shownAt = 1; }
    }
    const clicks = [];
    const m = new AlertManager({ Notification: FakeNotification, nativeImage: { createFromPath: () => ({ isEmpty: () => false, tag: 'img' }) }, onClick: (id) => clicks.push(id), record: true });
    expect(m.notify({ event: ev('person'), cameraName: 'camera', snapshotPath: '/x.jpg' })).toBe(true);
    expect(shown[0].o).toMatchObject({ title: 'Person at the camera', icon: { tag: 'img' } });
    shown[0].handlers.click();
    expect(clicks).toEqual(['20261010-140312-a1b2']);
    expect(m.shown).toEqual([{ title: 'Person at the camera', body: '14:03 · Click to see the clip', at: expect.any(Number), eventId: '20261010-140312-a1b2', silent: false, icon: true }]);
    const none = new AlertManager({ Notification: { isSupported: () => false } });
    expect(none.notify({ event: ev('person'), cameraName: 'camera' })).toBe(false);
  });
});
