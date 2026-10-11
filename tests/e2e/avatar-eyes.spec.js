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

/** Luminance of the eye region (both eyes) of a settled render at this gaze, decoded in the page. */
async function eyes(page, q) {
  await page.goto(`/dev/avatar.html?ui=0&particles=0&w=392&h=584&fixedTime=1&idle=0&${q}`);
  await page.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 60_000 });
  expect(await page.evaluate(() => window.__error || null)).toBeNull();
  const b = await page.locator('#avatarView').boundingBox();
  const png = await page.screenshot({ clip: { x: b.x + 75, y: b.y + 212, width: 240, height: 50 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const L = [];
    for (let i = 0; i < d.length; i += 4) L.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    return { w: c.width, h: c.height, L };
  }, png.toString('base64'));
}

/** Mean SSIM over 8 x 8 windows (luminance, 0..255) and the largest pixel difference. */
function compareEyes(a, b) {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let sum = 0, n = 0, maxD = 0;
  for (let i = 0; i < a.L.length; i++) maxD = Math.max(maxD, Math.abs(a.L[i] - b.L[i]));
  for (let y = 0; y + 8 <= a.h; y += 4) {
    for (let x = 0; x + 8 <= a.w; x += 4) {
      let ma = 0, mb = 0;
      for (let j = 0; j < 8; j++) for (let k = 0; k < 8; k++) { const i = (y + j) * a.w + x + k; ma += a.L[i]; mb += b.L[i]; }
      ma /= 64; mb /= 64;
      let va = 0, vb = 0, cv = 0;
      for (let j = 0; j < 8; j++) {
        for (let k = 0; k < 8; k++) {
          const i = (y + j) * a.w + x + k;
          va += (a.L[i] - ma) ** 2; vb += (b.L[i] - mb) ** 2; cv += (a.L[i] - ma) * (b.L[i] - mb);
        }
      }
      va /= 63; vb /= 63; cv /= 63;
      sum += ((2 * ma * mb + C1) * (2 * cv + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      n++;
    }
  }
  return { ssim: sum / n, maxD };
}

test('relief head: no pop as the gaze leaves zero; the irises do move with it', async ({ page }) => {
  const rest = await eyes(page, '');
  // a hair off zero (a micro-saccade, the eye controller settling): the eyes look as at rest
  for (const q of ['gazeX=0.001', 'gazeX=0.01', 'gazeY=-0.01']) {
    const s = compareEyes(rest, await eyes(page, q));
    expect(s.ssim, q).toBeGreaterThan(0.99);
    expect(s.maxD, q).toBeLessThan(40);
  }
  // a real look: the irises have moved
  expect(compareEyes(rest, await eyes(page, 'gazeX=0.4')).ssim).toBeLessThan(0.95);
});
