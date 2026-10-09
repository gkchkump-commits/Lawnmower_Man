// The relief head's gaze on the real reference plate: the painted irises are located (the pack's
// landmark eye centres sit ~25 px off them), the plate is painted over beneath them and the gaze
// moves them as discs; the mouth region is refined.
import { expect, test } from '@playwright/test';

test('relief head: irises located on the plate, gaze layer on, mouth mesh refined', async ({ page }) => {
  await page.goto('/dev/avatar.html?ui=0&particles=0&quality=low&w=196&h=292&fixedTime=1&idle=0&gazeX=0.6&gazeY=0.3');
  await page.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 60_000 });
  expect(await page.evaluate(() => window.__error || null)).toBeNull();
  const info = await page.evaluate(() => window.__avatar.headInfo());
  expect(info.irisLayer).toBe(true);
  // measured offline on public/assets/avatars/reference/plate.webp (pupil inside the bright iris)
  const ref = { L: [243.6, 474.7, 28.7], R: [542.1, 474.8, 29.1] };
  for (const k of ['L', 'R']) {
    const e = info.iris[k];
    expect(e.found).toBe(true);
    expect(Math.abs(e.cx - ref[k][0])).toBeLessThan(1.5);
    expect(Math.abs(e.cy - ref[k][1])).toBeLessThan(1.5);
    expect(Math.abs(e.r - ref[k][2])).toBeLessThan(1.5);
    expect(e.disc).toBeGreaterThan(e.r);
  }
  expect(info.mesh.vertices).toBeGreaterThan(2 * info.mesh.baked);
});
