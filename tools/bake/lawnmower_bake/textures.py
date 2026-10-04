"""Plate, silhouette alpha, closed-eye texture, mouth cavity texture and effect masks."""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from . import align as A
from . import landmarks as LM
from .util import (disk, feather, fill_holes, largest_component, log, luminance, polygon_mask,
                   smoothstep, to_float)


@dataclass
class Textures:
    width: int
    height: int
    plate: np.ndarray            # (H, W, 3) float RGB 0..1 (gamma encoded)
    alpha: np.ndarray            # (H, W) silhouette alpha incl. neck fade
    solid: np.ndarray            # (H, W) bool silhouette before the neck fade (mesh coverage)
    boundary: np.ndarray         # (N, 2) mesh outline polygon (px), counter-clockwise
    visible_outline: np.ndarray  # (M, 2) contour of the visibly lit head (px) for aura / hit test
    eyes_closed: np.ndarray      # (H, W, 3) closed-eye texture aligned to the plate (black outside)
    mouth: np.ndarray            # (h, w, 3) mouth cavity texture
    mouth_rect: tuple            # (x, y, w, h) of the mouth texture in plate pixels
    masks_a: np.ndarray          # (H, W, 3): R alpha, G gold lines, B sparkle/grid
    masks_b: np.ndarray          # (H, W, 3): R eye apertures, G eye regions (blink), B mouth region
    masks_c: np.ndarray          # (H, W, 3): R lid coordinate (0.5 + 0.5 w), G upper lid, B occlusion
    lids: dict                   # per eye: columns + upper / closed / lower lid curves (px)
    lm: np.ndarray               # neutral landmarks (478, 3), inner lips snapped to the slit
    slit_line: np.ndarray        # (K, 2) polyline of the closed-mouth line (px)
    palette: dict
    info: dict = field(default_factory=dict)


# ------------------------------------------------------------------------------------------------
# helpers
# ------------------------------------------------------------------------------------------------

def _gray(rgb):
    return luminance(rgb)


def _eye_polys(lm):
    eL = np.concatenate([lm[LM.EYE_L_UPPER, :2], lm[LM.EYE_L_LOWER[::-1], :2]])
    eR = np.concatenate([lm[LM.EYE_R_UPPER, :2], lm[LM.EYE_R_LOWER[::-1], :2]])
    return eL, eR


def _ellipse_mask(shape, center, rx, ry, soft):
    H, W = shape[:2]
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    r = np.sqrt(((xx - center[0]) / rx) ** 2 + ((yy - center[1]) / ry) ** 2)
    return 1.0 - smoothstep(1.0 - soft, 1.0, r)


def _register(ref_rgb, img_rgb, frames, ref_i, img_i, mask, search=12):
    """Translation aligning frame img_i to frame ref_i inside ``mask`` -> (2x3 matrix, info)."""
    s_ref, s_img = np.array(frames[ref_i].shift), np.array(frames[img_i].shift)
    init = tuple((s_ref - s_img).tolist())  # per-frame rigid shifts are relative to frame 0
    tx, ty, ncc = A.register_translation(_gray(ref_rgb), _gray(img_rgb), mask, init=init, search=search)
    return A.translation(tx, ty), {"tx": round(tx, 2), "ty": round(ty, 2), "ncc": round(ncc, 3)}


# ------------------------------------------------------------------------------------------------
# plate + silhouette
# ------------------------------------------------------------------------------------------------

def build_plate(imgs, sel, frames):
    """Single sharp neutral frame + an aligned temporal median of near-neutral frames."""
    neutral = to_float(imgs[sel.neutral])
    H, W = neutral.shape[:2]
    lm = frames[sel.neutral].lm
    up = lm[LM.UPPER_RIGID + LM.FACE_OVAL, :2]
    x0, y0 = np.maximum(np.floor(up.min(0) - 20), 0).astype(int)
    x1, y1 = np.minimum(np.ceil(up.max(0) + 20), [W, H]).astype(int)
    ref_g = _gray(neutral)[y0:y1, x0:x1]
    stack = []
    for j in sel.median:
        img = to_float(imgs[j])
        if j == sel.neutral:
            stack.append(img)
            continue
        dx, dy = A.phase_shift(ref_g, _gray(img)[y0:y1, x0:x1])
        stack.append(A.warp(img, A.translation(-dx, -dy), (W, H)))
    median = np.median(np.stack(stack), axis=0).astype(np.float32)
    return neutral, median


def build_silhouette(median, lm, face_h):
    """Silhouette of cranium + ears + face + neck; returns (alpha, solid, boundary polygon)."""
    H, W = median.shape[:2]
    L = cv2.GaussianBlur(_gray(median), (0, 0), 3)
    b = (L > 0.03).astype(np.uint8)
    b = cv2.morphologyEx(b, cv2.MORPH_CLOSE, disk(5))
    b = cv2.morphologyEx(b, cv2.MORPH_OPEN, disk(16))       # cut off particle clumps / wisps
    b = fill_holes(largest_component(b))

    chin_y = float(lm[LM.CHIN, 1])
    ear_y = float(max(lm[132, 1], lm[361, 1])) + 0.03 * face_h      # bottom of the ears
    jaw_y = float((lm[LM.JAW_ANGLE_L, 1] + lm[LM.JAW_ANGLE_R, 1]) / 2)
    yy = np.arange(H)[:, None].astype(np.float32)

    # 1) cranium + ears from the threshold, above the ear bottom
    upper = b & (yy < ear_y)
    # 2) face oval (jaw line) slightly dilated to keep the rim glow
    face = polygon_mask((H, W), lm[LM.FACE_OVAL, :2]) > 0.5
    face = cv2.dilate(face.astype(np.uint8), disk(int(round(0.012 * face_h)))).astype(bool)
    # 3) neck column: robust straight edges fitted to the threshold mask below the jaw
    ys, ls, rs = [], [], []
    for y in range(int(jaw_y), min(H, int(chin_y + 0.16 * face_h))):
        xs = np.nonzero(b[y])[0]
        if len(xs) > 10:
            ys.append(y)
            ls.append(xs.min())
            rs.append(xs.max())
    neck = np.zeros((H, W), bool)
    neck_info = {}
    if len(ys) > 20:
        ys = np.array(ys, np.float32)
        lft = np.percentile(ls, 70)       # neck edges, ignoring particle bumps sticking out
        rgt = np.percentile(rs, 30)
        cx = 0.5 * (lft + rgt)
        half = 0.5 * (rgt - lft)
        flare = 0.12                       # widens slightly toward the shoulders
        xx = np.arange(W)[None, :].astype(np.float32)
        hw = half + np.maximum(0.0, yy - chin_y) * flare
        neck = (np.abs(xx - cx) <= hw) & (yy >= jaw_y - 0.02 * face_h)
        neck_info = {"centerX": float(cx), "halfWidth": float(half), "top": float(jaw_y)}

    solid = upper | face | neck
    solid = cv2.morphologyEx(solid.astype(np.uint8), cv2.MORPH_CLOSE, disk(int(0.04 * face_h))).astype(bool)
    solid = fill_holes(largest_component(solid))
    solid = cv2.GaussianBlur(solid.astype(np.float32), (0, 0), 6) > 0.5

    edge = feather(solid.astype(np.float32), 2.2)
    # The neck has no hard outline in the reference: below the jaw (outside the face) the alpha
    # ramps in from the sides over ~6% of the face height...
    dist = cv2.distanceTransform(solid.astype(np.uint8), cv2.DIST_L2, 5)
    side = smoothstep(0.0, 0.065 * face_h, dist)
    zone = (~face) & (yy >= jaw_y - 0.02 * face_h)
    zone = feather(zone.astype(np.float32), 0.02 * face_h)
    edge = edge * (1.0 - zone + zone * side)
    # ...and it dissolves toward the bottom of the frame.
    fade0 = chin_y + 0.03 * face_h
    fade1 = min(H - 4.0, chin_y + 0.34 * face_h)
    fade = 1.0 - smoothstep(fade0, fade1, yy)
    fade = fade * (0.55 + 0.45 * fade)   # ease: dims early, lingers faintly
    alpha = np.clip(edge * fade, 0, 1).astype(np.float32)

    # Mesh outline: contour of the visible region (alpha > ~0) dilated 2px so edges never clip.
    cover = cv2.dilate((alpha > 0.004).astype(np.uint8), disk(2))
    cnts, _ = cv2.findContours(cover, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cnt = max(cnts, key=cv2.contourArea)[:, 0, :].astype(np.float32)
    info = {"chinY": chin_y, "earBottomY": ear_y, "jawY": jaw_y, "neckFade": [fade0, fade1], "neck": neck_info}
    return alpha, solid, cnt, info


# ------------------------------------------------------------------------------------------------
# mouth slit
# ------------------------------------------------------------------------------------------------

def find_slit(plate, lm):
    """Locate the dark line between the closed lips; returns polyline + snapped inner-lip points."""
    g = cv2.GaussianBlur(_gray(plate), (0, 0), 1.2)
    up = lm[LM.LIPS_INNER_UPPER, :2]
    lo = lm[LM.LIPS_INNER_LOWER, :2]
    cl, cr = up[0], up[-1]
    xs = np.arange(int(np.ceil(cl[0])) + 2, int(np.floor(cr[0])) - 1)
    upper_y = np.interp(xs, up[:, 0], up[:, 1])
    lower_y = np.interp(xs, lo[:, 0], lo[:, 1])
    found = []
    for x, yu, yl in zip(xs, upper_y, lower_y):
        a = int(np.floor(min(yu, yl) - 6))
        b = int(np.ceil(max(yu, yl) + 6))
        col = g[a:b + 1, x]
        k = int(np.argmin(col))
        # parabolic sub-pixel refinement
        if 0 < k < len(col) - 1:
            d = col[k - 1] - 2 * col[k] + col[k + 1]
            off = 0.5 * (col[k - 1] - col[k + 1]) / d if abs(d) > 1e-6 else 0.0
        else:
            off = 0.0
        found.append(a + k + float(np.clip(off, -1, 1)))
    found = np.array(found, np.float32)
    # Robust smooth fit: polynomial in x through the detections + both corners.
    X = np.concatenate([[cl[0]], xs, [cr[0]]]).astype(np.float64)
    Y = np.concatenate([[cl[1]], found, [cr[1]]]).astype(np.float64)
    wts = np.concatenate([[8.0], np.ones(len(xs)), [8.0]])
    for _ in range(3):  # iteratively down-weight outliers
        coef = np.polyfit(X, Y, 4, w=wts)
        res = np.abs(np.polyval(coef, X) - Y)
        wts = np.where(res > 2.5, wts * 0.2, wts)
    line_x = np.linspace(cl[0], cr[0], 48)
    line = np.stack([line_x, np.polyval(coef, line_x)], 1).astype(np.float32)

    lm2 = lm.copy()
    half_gap = 1.1  # px; the slit must be a proper (non-degenerate) hole
    n = len(LM.LIPS_INNER_UPPER)
    for k in range(n):
        iu, il = LM.LIPS_INNER_UPPER[k], LM.LIPS_INNER_LOWER[k]
        # keep the landmark's x spacing (corner to corner), snap y to the detected line
        x = float(np.interp(k / (n - 1), [0, 1], [cl[0], cr[0]])) if k in (0, n - 1) else \
            float(0.5 * (lm[iu, 0] + lm[il, 0]))
        y = float(np.polyval(coef, x))
        t = 1.0 - abs(2.0 * k / (n - 1) - 1.0)          # 0 at corners, 1 at the centre
        gap = half_gap * max(0.4, min(1.0, 3.0 * t))
        lm2[iu, :2] = (x, y - gap)
        lm2[il, :2] = (x, y + gap)
    lm2[LM.MOUTH_CORNER_INNER_L, :2] = (cl[0], np.polyval(coef, cl[0]))
    lm2[LM.MOUTH_CORNER_INNER_R, :2] = (cr[0], np.polyval(coef, cr[0]))
    return line, lm2


# ------------------------------------------------------------------------------------------------
# closed eyes
# ------------------------------------------------------------------------------------------------

def eye_geometry(lm):
    out = {}
    for key, upper, lower, iris in (("L", LM.EYE_L_UPPER, LM.EYE_L_LOWER, LM.IRIS_L),
                                    ("R", LM.EYE_R_UPPER, LM.EYE_R_LOWER, LM.IRIS_R)):
        pts = lm[upper + lower, :2]
        c_iris = lm[iris[0], :2]
        ring = lm[iris[1:], :2]
        iris_r = float(np.mean(np.linalg.norm(ring - c_iris, axis=1)))
        x0, x1 = float(pts[:, 0].min()), float(pts[:, 0].max())
        top = float(lm[upper, 1].min())
        bot = float(lm[lower, 1].max())
        out[key] = {"center": [float(c_iris[0]), float(c_iris[1])],
                    "box": [x0, top, x1, bot],
                    "width": x1 - x0, "height": bot - top, "irisRadius": iris_r,
                    "corners": [lm[upper[0], :2].tolist(), lm[upper[-1], :2].tolist()]}
    return out


def register_closed_eyes(plate, imgs, sel, frames, eyes):
    """The blink frame registered to the plate, once per eye (full frames, not yet matched)."""
    H, W = plate.shape[:2]
    blink = to_float(imgs[sel.blink])
    warped, shifts = {}, {}
    for key, e in eyes.items():
        cx = 0.5 * (e["box"][0] + e["box"][2])
        cy = 0.5 * (e["box"][1] + e["box"][3])
        rx, ry = 1.05 * e["width"], 1.55 * e["height"]
        # Register on the ring around the eye (lids/brow/cheek), excluding the aperture itself.
        ring = _ellipse_mask((H, W), (cx, cy), rx * 1.25, ry * 1.25, 0.05) * \
            (1 - _ellipse_mask((H, W), (cx, cy), 0.62 * e["width"], 0.9 * e["height"], 0.05))
        Mk, d = _register(plate, blink, frames, sel.neutral, sel.blink, ring)
        shifts[key] = d
        # bicubic: the closed lid line is thin, bilinear resampling would soften it
        warped[key] = np.clip(cv2.warpAffine(blink, Mk, (W, H), flags=cv2.INTER_CUBIC,
                                             borderMode=cv2.BORDER_REFLECT), 0, 1)
    log(f"  closed eyes from frame {sel.blink}, registration {shifts}")
    return warped, shifts


def _ridge_rows(L, xs, lo, hi):
    """Per column: sub-pixel row of the brightest pixel of ``L`` in [lo, hi) and its prominence."""
    H = L.shape[0]
    rows = np.full(len(xs), np.nan, np.float64)
    prom = np.zeros(len(xs), np.float64)
    for k, (x, a, b) in enumerate(zip(xs, lo, hi)):
        a, b = int(max(1, np.floor(a))), int(min(H - 2, np.ceil(b)))
        if b - a < 3:
            continue
        col = L[a:b, x]
        i = int(np.argmax(col))
        off = 0.0
        if 0 < i < len(col) - 1:
            d = col[i - 1] - 2 * col[i] + col[i + 1]
            off = float(np.clip(0.5 * (col[i - 1] - col[i + 1]) / d, -0.5, 0.5)) if abs(d) > 1e-6 else 0.0
        rows[k] = a + i + off
        r = a + i
        prom[k] = float(L[r, x] - 0.5 * (L[max(0, r - 7), x] + L[min(H - 1, r + 7), x]))
    return rows, prom


def _robust_poly(xs, ys, w, deg=4, iters=4, tol=2.0):
    ok = np.isfinite(ys) & (w > 0)
    x = (xs - xs.mean()) / max(1.0, np.ptp(xs) / 2)
    ww = np.where(ok, w, 0.0)
    ys0 = np.where(ok, ys, 0.0)
    coef = np.polyfit(x[ok], ys0[ok], deg, w=ww[ok])
    for _ in range(iters):
        res = np.abs(np.polyval(coef, x) - ys0)
        ww = np.where(ok & (res < tol * 2.5), ww, ww * 0.1)
        coef = np.polyfit(x[ok], ys0[ok], deg, w=ww[ok] + 1e-6)
    return np.polyval(coef, x)


def detect_lids(plate, closed_by_eye, lm, eyes):
    """Visible eye "almond" per eye, as per-column curves in plate px (y down).

    MediaPipe's lid landmarks are much tighter than the hologram's glowing eye (its upper lid
    runs through the iris, its outer corner sits ~25% inside the visible tip), so the curves are
    measured in the images:
      closed: the bright closed-lid line of the (registered) blink frame; its extent gives the
              eye's tips (corners);
      upper:  the bright upper lid margin of the open eye (ridge above the MediaPipe lid),
              ramped down to the tips outside MediaPipe's corners;
      lower:  MediaPipe's lower lid (it matches the visible margin) + 2 px, ramped to the tips.
    Returns {key: {"x": int columns, "upper", "closed", "lower": float arrays}}.
    """
    out = {}
    Lp = cv2.GaussianBlur(_gray(plate), (0, 0), 1.0)
    tophat = Lp - cv2.morphologyEx(Lp, cv2.MORPH_OPEN, disk(3))
    tophat = cv2.GaussianBlur(tophat, (0, 0), 1.2)
    for key, upper_idx, lower_idx, iris in (("L", LM.EYE_L_UPPER, LM.EYE_L_LOWER, LM.IRIS_L),
                                            ("R", LM.EYE_R_UPPER, LM.EYE_R_LOWER, LM.IRIS_R)):
        e = eyes[key]
        U = lm[upper_idx, :2].astype(np.float64)
        Lw = lm[lower_idx, :2].astype(np.float64)
        xa, xb = float(U[0, 0]), float(U[-1, 0])            # MediaPipe corners (screen left, right)
        ew = xb - xa
        ic_y, ir = e["center"][1], e["irisRadius"]
        Lc = cv2.GaussianBlur(_gray(closed_by_eye[key]), (0, 0), 1.5)

        # --- closed lid line + tips -----------------------------------------------------------
        xs = np.arange(int(np.floor(xa - 0.6 * ew)), int(np.ceil(xb + 0.6 * ew)) + 1)
        lo_mp = np.interp(xs, Lw[:, 0], Lw[:, 1])                  # flat beyond the corners
        rows, prom = _ridge_rows(Lc, xs, lo_mp - 22, lo_mp + 8)
        val = np.array([Lc[int(round(r)), x] if np.isfinite(r) else 0.0 for x, r in zip(xs, rows)])
        centre = (xs > xa + 0.25 * ew) & (xs < xb - 0.25 * ew)
        thr = 0.82 * float(np.median(val[centre]))
        mid = int(np.argmin(np.abs(xs - e["center"][0])))

        def walk(step):
            # follow the line outward while it stays bright and continuous (the row of the
            # brightest pixel jumps once the search runs past the tip)
            k, last, bad, end = mid, rows[mid], 0, mid
            while 0 < k < len(xs) - 1:
                k += step
                ok = val[k] > thr and abs(rows[k] - last) <= 3.0
                if ok:
                    last, bad, end = rows[k], 0, k
                else:
                    bad += 1
                    if bad > 2:
                        break
            return end
        tip_a = float(np.clip(xs[walk(-1)], xa - 0.5 * ew, xa + 0.05 * ew))
        tip_b = float(np.clip(xs[walk(1)], xb - 0.05 * ew, xb + 0.5 * ew))
        cols = np.arange(int(np.ceil(tip_a)), int(np.floor(tip_b)) + 1)
        sel_c = (xs >= tip_a) & (xs <= tip_b)
        closed = np.interp(cols, xs[sel_c], _robust_poly(xs[sel_c].astype(np.float64), rows[sel_c],
                                                         np.maximum(prom[sel_c], 0.02)))

        # --- upper margin of the open eye -----------------------------------------------------
        inside = (cols > xa + 1) & (cols < xb - 1)
        u_mp = np.interp(cols, U[:, 0], U[:, 1])
        # Trace the margin outward from above the iris centre, one column at a time, staying on
        # the same ridge (it only descends toward the corners). A per-column search would jump to
        # the brow crease / orbit loop next to the corners or to the iris rim below the margin.
        c0 = int(np.argmin(np.abs(cols - e["center"][0])))
        r0, _ = _ridge_rows(tophat, cols[c0:c0 + 1], [ic_y - 1.9 * ir], [ic_y - 0.7 * ir])
        urow = np.full(len(cols), np.nan)
        urow[c0] = r0[0]
        for step in (-1, 1):
            k, last = c0, r0[0]
            while 0 <= k + step < len(cols) and inside[k + step]:
                k += step
                hi = min(last + 3.5, closed[k] - 1.0, u_mp[k])
                r, _ = _ridge_rows(tophat, cols[k:k + 1], [last - 1.5], [max(hi, last + 0.5)])
                last = r[0] if np.isfinite(r[0]) else last
                urow[k] = last
        ok = inside & np.isfinite(urow)
        ci = cols[ok].astype(np.float64)
        from scipy.ndimage import gaussian_filter1d
        fit = gaussian_filter1d(urow[ok], 2.0)
        k_a, k_b = np.nonzero(ok)[0][[0, -1]]
        upper = np.interp(cols, ci, fit)
        # outside MediaPipe's corners: ramp toward the tips (where the lids meet the closed line)
        for k in range(0, k_a):
            t = (cols[k] - tip_a) / max(1.0, cols[k_a] - tip_a)
            upper[k] = closed[k] + (upper[k_a] - closed[k_a]) * np.sin(0.5 * np.pi * t)
        for k in range(k_b + 1, len(cols)):
            t = (tip_b - cols[k]) / max(1.0, tip_b - cols[k_b])
            upper[k] = closed[k] + (upper[k_b] - closed[k_b]) * np.sin(0.5 * np.pi * t)
        upper = np.minimum(gaussian_filter1d(upper, 1.5) - 2.0, closed - 1.0)   # generous: margin inside

        # --- lower margin ---------------------------------------------------------------------
        lower = np.interp(cols, Lw[:, 0], Lw[:, 1]) + 2.0
        for k in range(len(cols)):
            if cols[k] < xa:
                t = (cols[k] - tip_a) / max(1.0, xa - tip_a)
                lower[k] = closed[k] + (np.interp(xa, Lw[:, 0], Lw[:, 1]) + 2.0 - closed[k]) * t
            elif cols[k] > xb:
                t = (tip_b - cols[k]) / max(1.0, tip_b - xb)
                lower[k] = closed[k] + (np.interp(xb, Lw[:, 0], Lw[:, 1]) + 2.0 - closed[k]) * t
        lower = np.maximum(gaussian_filter1d(lower, 1.5), closed + 1.0)
        out[key] = {"x": cols.astype(np.int32), "upper": upper.astype(np.float32),
                    "closed": closed.astype(np.float32), "lower": lower.astype(np.float32)}
        log(f"  lids {key}: tips {tip_a:.1f}..{tip_b:.1f} (MediaPipe {xa:.1f}..{xb:.1f}), "
            f"upper apex {upper.min():.1f}, closed {closed.min():.1f}..{closed.max():.1f}")
    return out


def lid_maps(shape, lids):
    """Per-pixel lid coordinate for the blink wipe.

    w = min((y - upper) / (closed - upper), (lower - y) / (lower - closed)) inside each eye's
    almond: 0 on the open lid margins, 1 on the closed-lid line, negative outside (falling to -1
    about 3 px past the tips / a lid height above and below). The engine shows the closed-eye
    frame where w < blink and the open plate where w > blink, so the upper lid edge sweeps from
    the open margin down to the closed line and the lower one rises a little to meet it.
    Returns (w in [-1, 1], upper-branch indicator 0..1, almond mask bool).
    """
    H, W = shape[:2]
    w = np.full((H, W), -1.0, np.float32)
    up = np.zeros((H, W), np.float32)
    for key, d in lids.items():
        xs, U, C, Lo = d["x"], d["upper"], d["closed"], d["lower"]
        x0, x1 = int(xs[0]) - 40, int(xs[-1]) + 40
        y0, y1 = int(np.floor(U.min())) - 70, int(np.ceil(Lo.max())) + 60
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(W - 1, x1), min(H - 1, y1)
        yy = np.arange(y0, y1 + 1, dtype=np.float32)[:, None]
        xx = np.arange(x0, x1 + 1, dtype=np.float32)[None, :]
        u = np.interp(xx[0], xs, U)[None, :]
        c = np.interp(xx[0], xs, C)[None, :]
        lo = np.interp(xx[0], xs, Lo)[None, :]
        t_up = (yy - u) / np.maximum(c - u, 3.0)
        t_lo = (lo - yy) / np.maximum(lo - c, 2.0)
        ww = np.minimum(t_up, t_lo)
        # beyond the tips the almond has no height: fall off with the distance to the tip point
        for tip_x, tip_y, sgn in ((float(xs[0]), float(C[0]), -1.0), (float(xs[-1]), float(C[-1]), 1.0)):
            beyond = (xx - tip_x) * sgn > 0
            dist = np.hypot(xx - tip_x, yy - tip_y)
            ww = np.where(beyond, np.minimum(ww, -dist / 3.0), ww)
        ww = np.clip(ww, -1.0, 1.0)
        sub = w[y0:y1 + 1, x0:x1 + 1]
        w[y0:y1 + 1, x0:x1 + 1] = np.maximum(sub, ww)
        upi = np.clip(c - yy + 0.5, 0.0, 1.0) * ((xx >= xs[0] - 2) & (xx <= xs[-1] + 2))
        up[y0:y1 + 1, x0:x1 + 1] = np.maximum(up[y0:y1 + 1, x0:x1 + 1], upi)
    return w, up, w >= 0.0


def eye_regions(shape, almond_by_eye, core_px=14.0, fall_px=26.0):
    """Soft region per eye that the closed-eye frame replaces at full closure: the almond grown
    by ``core_px`` (covers the open eye's glow halo) with a ``fall_px`` soft edge on the lid skin."""
    regions = {}
    for key, almond in almond_by_eye.items():
        dist = cv2.distanceTransform((~almond).astype(np.uint8), cv2.DIST_L2, 5)
        regions[key] = (1.0 - smoothstep(core_px, core_px + fall_px, dist)).astype(np.float32)
    return regions


def compose_closed_eyes(plate, closed_by_eye, regions):
    """Closed-eye texture: each registered blink frame inside its eye region (full strength where
    the region is > 0, black elsewhere), brightness-matched to the plate on the soft edge of the
    region, which is the only place where the two frames are blended at full closure."""
    out = np.zeros_like(plate)
    region = np.zeros(plate.shape[:2], np.float32)
    for key, reg in regions.items():
        warped = closed_by_eye[key].copy()
        ring = (reg > 0.05) & (reg < 0.9)
        for c in range(3):
            a, b = plate[..., c][ring], warped[..., c][ring]
            gain = np.clip(a.std() / max(b.std(), 1e-4), 0.8, 1.25)
            warped[..., c] = (warped[..., c] - b.mean()) * gain + a.mean()
        support = cv2.dilate((reg > 0.001).astype(np.uint8), disk(3)).astype(bool)
        out[support] = np.clip(warped[support], 0, 1)
        region = np.maximum(region, reg)
    return out.astype(np.float32), region


def occlusion_mask(alpha, lm, face_h, plate):
    """Where the head may darken the desktop behind it (masks_c B): the face and the cranium,
    where they visibly glow. Ears, the dim gap between ear and cranium, the dim fringe and the
    dissolving neck are 0, so on a light desktop they add light instead of painting grey. The
    brightness gate uses a blurred luminance: a per-pixel gate would let the desktop through
    between the grid lines (speckles)."""
    H, W = alpha.shape
    face = polygon_mask((H, W), lm[LM.FACE_OVAL, :2])
    face = feather(cv2.dilate(face, disk(int(round(0.012 * face_h)))), 6.0)
    brow_y = float(np.mean(lm[LM.BROW_L + LM.BROW_R, 1]))
    eye_y = float(np.mean(lm[LM.EYE_L_UPPER + LM.EYE_R_UPPER, 1]))
    ear_top = 0.5 * (brow_y + eye_y)
    yy = np.arange(H, dtype=np.float32)[:, None]
    cranium = 1.0 - smoothstep(ear_top - 0.04 * face_h, ear_top + 0.04 * face_h, yy)
    glow = smoothstep(0.03, 0.12, cv2.GaussianBlur(_gray(plate), (0, 0), 6.0))
    # the outermost few px of the silhouette (dim outer glow / fringe) never occlude: on a light
    # desktop they would draw a dark outline around the head
    inner = cv2.distanceTransform((alpha > 0.5).astype(np.uint8), cv2.DIST_L2, 5)
    edge = smoothstep(1.5, 8.0, inner)
    occ = np.maximum(face, np.broadcast_to(cranium, (H, W))) * glow * edge * (alpha > 0.0)
    return np.clip(occ, 0, 1).astype(np.float32)


def suppress_neck_motes(plate, alpha, lm, chin_y, neck_fade_y, face_h):
    """Inpaint the source video's bokeh motes baked into the neck (static motes next to the live
    neck particles): small bright blobs (white top-hat, thin grid lines excluded) outside the face
    oval, from just above where the neck starts to dissolve."""
    H, W = plate.shape[:2]
    L = _gray(plate)
    th = L - cv2.morphologyEx(L, cv2.MORPH_OPEN, disk(7))
    blobs = cv2.morphologyEx(th, cv2.MORPH_OPEN, disk(2))
    face = feather(cv2.dilate(polygon_mask((H, W), lm[LM.FACE_OVAL, :2]), disk(3)), 3.0)
    yy = np.arange(H, dtype=np.float32)[:, None]
    zone = (1.0 - face) * smoothstep(neck_fade_y - 0.04 * face_h, neck_fade_y, yy) * (alpha > 0.0)
    m = ((blobs > 0.02) & (zone > 0.2)).astype(np.uint8)
    m = cv2.dilate(m, disk(3))
    u8 = (np.clip(plate, 0, 1) * 255 + 0.5).astype(np.uint8)
    inp = cv2.inpaint(u8, m * 255, 6, cv2.INPAINT_TELEA).astype(np.float32) / 255.0
    inp = cv2.GaussianBlur(inp, (0, 0), 1.2)
    k = (zone * feather(m.astype(np.float32), 2.0) * 1.5).clip(0, 1)[..., None]
    out = plate * (1 - k) + inp * k
    log(f"  neck motes: {int(m.sum())} px inpainted")
    return out.astype(np.float32)


# ------------------------------------------------------------------------------------------------
# mouth cavity
# ------------------------------------------------------------------------------------------------

def _mouth_opening(img, lm_up, lm_lo, x_range):
    """Per-column top/bottom of the visible mouth opening (teeth + cavity) between the lip rims.

    MediaPipe's inner-lip landmarks sit on the lips, so the opening is found from the image:
    the glowing lip rim is the warmest/brightest row near each inner-lip curve; walking from it
    toward the mouth centre, the opening starts at the first pixel that is no longer warm lip
    glow (teeth are neutral grey-white, the cavity is dark).
    """
    sm = cv2.GaussianBlur(img, (0, 0), 0.8)
    L = _gray(sm)
    warm = sm[..., 0] - sm[..., 2]
    is_lip = (warm > 0.165) | (L > 0.86)
    score = L + 2.0 * warm
    xs = np.arange(int(x_range[0]), int(x_range[1]) + 1)
    yu = np.interp(xs, lm_up[:, 0], lm_up[:, 1])
    yl = np.interp(xs, lm_lo[:, 0], lm_lo[:, 1])
    top = np.full(len(xs), np.nan)
    bot = np.full(len(xs), np.nan)
    H = L.shape[0]
    for k, (x, a, b) in enumerate(zip(xs, yu, yl)):
        if b - a < 4:
            continue
        ya0, ya1 = int(max(0, a - 4)), int(min(H - 1, a + 14))
        yb0, yb1 = int(max(0, b - 14)), int(min(H - 1, b + 4))
        pu = ya0 + int(np.argmax(score[ya0:ya1 + 1, x]))
        pl = yb0 + int(np.argmax(score[yb0:yb1 + 1, x]))
        if pl - pu < 4:
            continue
        i = pu
        while i < pl and is_lip[i, x]:
            i += 1
        j = pl
        while j > i and is_lip[j, x]:
            j -= 1
        if j > i:
            top[k], bot[k] = i, j
    good = ~np.isnan(top)
    if good.sum() < 5:
        return xs, yu, yl
    from scipy.ndimage import gaussian_filter1d, median_filter
    top = np.interp(xs, xs[good], top[good])
    bot = np.interp(xs, xs[good], bot[good])
    # Teeth occasionally read as lip glow, which pushes the edges toward the centre of the mouth.
    # The rims are smooth curves, so fit the outer envelope: top = upper envelope, bottom = lower.
    top = _envelope_fit(xs, top, side=-1)
    bot = _envelope_fit(xs, bot, side=0)
    top = gaussian_filter1d(median_filter(top, 5, mode="nearest"), 1.5)
    bot = gaussian_filter1d(median_filter(bot, 5, mode="nearest"), 1.5)
    return xs, top, bot


def _envelope_fit(xs, ys, side, deg=4, iters=6):
    """Robust polynomial fit of ``ys``.

    side=-1 hugs the smallest-y envelope, +1 the largest-y envelope, 0 is a symmetric robust
    fit (outliers on either side are down-weighted).
    """
    x = (xs - xs.mean()) / max(1.0, np.ptp(xs) / 2)
    w = np.ones_like(ys, dtype=np.float64)
    for _ in range(iters):
        coef = np.polyfit(x, ys, deg, w=w)
        res = ys - np.polyval(coef, x)
        if side == 0:
            w = np.where(np.abs(res) > 2.0, 0.05, 1.0)
        else:
            w = np.where(res * side < -1.0, 0.05, 1.0)   # wrong side of the envelope
    fit = np.polyval(coef, x)
    if side == 0:
        return fit
    # Keep genuine detail on the envelope side, clamp the rest to the fit.
    return np.where((ys - fit) * side > 0, ys, fit)


def build_mouth(plate, imgs, sel, frames, lm_slit, slit_line, face_h):
    """Two-layer mouth interior atlas from the teeth frame.

    Layer 0 (top half of the atlas) is attached to the upper jaw: the dark cavity with the upper
    teeth hanging from the closed-mouth slit, so opening the jaw reveals them first.
    Layer 1 (bottom half) holds the lower teeth in *jaw space* (shifted so the lower lip rim sits
    on the slit line); the engine draws it on a strip that moves with the lower lip.
    Both layers share the same plate-pixel rectangle ``rect`` (x, y, w, h).
    """
    H, W = plate.shape[:2]
    lmN = frames[sel.neutral].lm
    lmT = frames[sel.teeth].lm
    T = to_float(imgs[sel.teeth])
    # Register on the nose + upper lip (rigid with the upper jaw).
    nose_poly = np.concatenate([lmN[[98, 64, 48, 115, 220, 45, 4, 275, 440, 344, 278, 294, 327], :2],
                                lmN[LM.LIPS_OUTER_UPPER[::-1], :2]])
    mask = polygon_mask((H, W), nose_poly)
    M, d = _register(plate, T, frames, sel.neutral, sel.teeth, mask)
    Tw = A.warp(T, M, (W, H))

    def tf(idx):
        return (np.c_[lmT[idx, :2], np.ones(len(idx))] @ M.T).astype(np.float32)

    up_t, lo_t = tf(LM.LIPS_INNER_UPPER), tf(LM.LIPS_INNER_LOWER)
    xs, top, bot = _mouth_opening(Tw, up_t, lo_t, (up_t[0, 0] + 3, up_t[-1, 0] - 3))
    slit_y = np.interp(xs, slit_line[:, 0], slit_line[:, 1])
    centre = (xs > np.percentile(xs, 30)) & (xs < np.percentile(xs, 70))
    # Upper layer: lift so the opening's top edge (where the teeth start) lies on the slit.
    lift = float(np.median((slit_y - top)[centre]))

    corner_l, corner_r = slit_line[0], slit_line[-1]
    mw = float(corner_r[0] - corner_l[0])
    max_drop = 0.10 * face_h
    x0 = int(np.floor(corner_l[0] - 0.06 * mw))
    x1 = int(np.ceil(corner_r[0] + 0.06 * mw))
    y0 = int(np.floor(slit_line[:, 1].min() - 0.035 * face_h))
    y1 = int(np.ceil(slit_line[:, 1].max() + max_drop + 0.03 * face_h))
    rect = (x0, y0, x1 - x0, y1 - y0)
    hh, ww = y1 - y0, x1 - x0

    opening = bot - top
    split = top + 0.5 * opening                      # upper teeth above, lower teeth below
    shifted = A.warp(Tw, A.translation(0, lift), (W, H))
    poly_up = np.concatenate([np.stack([xs, top + lift], 1), np.stack([xs[::-1], split[::-1] + lift], 1)])
    m_up = feather(polygon_mask((H, W), poly_up), 1.0)[y0:y1, x0:x1]
    interior = shifted[y0:y1, x0:x1]

    vals = Tw[polygon_mask((H, W), np.concatenate([np.stack([xs, top], 1),
                                                    np.stack([xs[::-1], bot[::-1]], 1)])) > 0.9]
    if len(vals) > 30:
        lum = luminance(vals)
        dark = np.median(vals[lum < np.percentile(lum, 30)], axis=0)
    else:
        dark = np.array([0.05, 0.03, 0.03], np.float32)
    # Cavity: dark, slightly darker deeper inside the mouth.
    gy = np.linspace(0, 1, hh, dtype=np.float32)[:, None, None]
    base = dark[None, None, :] * (1.0 - 0.5 * gy)
    # Upper teeth fade out downward into the cavity (they recede behind the lower lip line).
    fade_up = np.ones((hh, ww), np.float32)
    layer0 = np.clip(interior * (m_up * fade_up)[..., None] + base * (1 - m_up * fade_up)[..., None], 0, 1)

    # Lower layer, in jaw space: per-column shift so the teeth frame's lower rim maps to the slit.
    xs_full = np.arange(x0, x1)
    drop_t = np.interp(xs_full, xs, bot - slit_y, left=0.0, right=0.0)     # per-column jaw drop
    sp = np.interp(xs_full, xs, split, left=np.nan, right=np.nan)
    bt = np.interp(xs_full, xs, bot, left=np.nan, right=np.nan)
    layer1 = np.zeros((hh, ww, 3), np.float32)
    yy = np.arange(y0, y1, dtype=np.float32)
    for c, x in enumerate(xs_full):
        if np.isnan(sp[c]):
            continue
        src_y = yy + drop_t[c]                      # jaw space -> teeth-frame rows
        col = np.stack([np.interp(src_y, np.arange(H), Tw[:, x, k]) for k in range(3)], 1)
        w = smoothstep(sp[c] - 1.5, sp[c] + 2.5, src_y) * (1.0 - smoothstep(bt[c] - 3.0, bt[c], src_y))
        layer1[:, c] = col * w[:, None]
    layer1 = cv2.GaussianBlur(layer1, (0, 0), 0.5)
    atlas = np.concatenate([layer0, layer1], 0).astype(np.float32)
    # Lower teeth band in jaw space (rows relative to the slit) for the strip geometry.
    band = [float(np.nanmin(sp - bt)) - 2.0, 1.0]
    info = {"frame": int(sel.teeth), "registration": d, "liftPx": round(lift, 2),
            "darkColor": [round(float(c), 4) for c in dark], "maxDropPx": round(float(max_drop), 2),
            "teethFrameDropPx": round(float(np.median((bot - slit_y)[centre])), 2),
            "lowerBandPx": [round(b, 2) for b in band]}
    return atlas, rect, info


# ------------------------------------------------------------------------------------------------
# masks + palette
# ------------------------------------------------------------------------------------------------

def build_masks(plate, alpha, lm, eyes, eye_region):
    H, W = plate.shape[:2]
    R, G, B = plate[..., 0], plate[..., 1], plate[..., 2]
    V = plate.max(axis=2)
    eL, eR = _eye_polys(lm)
    aperture = np.maximum(polygon_mask((H, W), eL), polygon_mask((H, W), eR))
    aperture = np.clip(feather(cv2.dilate(aperture, disk(2)), 1.2), 0, 1)

    warm = np.clip((R - B) * 2.4, 0, 1) * np.clip((V - 0.25) * 1.6, 0, 1)
    tophat = warm - cv2.morphologyEx(warm, cv2.MORPH_OPEN, disk(3))
    gold = smoothstep(0.05, 0.22, tophat) * (1.0 - aperture)
    gold = np.clip(cv2.GaussianBlur(gold, (0, 0), 0.6) * 1.15, 0, 1)

    L = luminance(plate)
    th = L - cv2.morphologyEx(L, cv2.MORPH_OPEN, disk(2))
    sparkle = smoothstep(0.10, 0.32, th) * (1.0 - aperture)

    outer = np.concatenate([lm[LM.LIPS_OUTER_UPPER, :2], lm[LM.LIPS_OUTER_LOWER[::-1], :2]])
    mouth = feather(cv2.dilate(polygon_mask((H, W), outer), disk(4)), 3.0)

    inside = alpha > 0.0
    masks_a = np.stack([alpha, gold * inside, sparkle * inside], -1).astype(np.float32)
    masks_b = np.stack([aperture, eye_region, np.clip(mouth, 0, 1)], -1).astype(np.float32)
    return masks_a, masks_b, aperture


def _saturated_median(img, mask, top=0.3, fallback=(1.0, 1.0, 1.0)):
    """Median colour of the most saturated ``top`` fraction of the pixels under ``mask``."""
    px = img[mask]
    if len(px) < 20:
        return np.array(fallback, np.float32)
    mx, mn = px.max(1), px.min(1)
    sat = (mx - mn) / np.maximum(mx, 1e-4)
    keep = sat >= np.quantile(sat, 1.0 - top)
    return np.median(px[keep], axis=0)


def _glow(c):
    """Normalise a sampled colour to full brightness (emissive colour for the engine's effects)."""
    c = np.asarray(c, np.float32)
    return c / max(float(c.max()), 1e-4)


def sample_palette(plate, alpha, gold, aperture, wisp_frame=None):
    from .util import hex_color

    V = plate.max(axis=2)
    eye = _saturated_median(plate, (aperture > 0.8) & (V > 0.55))
    line = _saturated_median(plate, (gold > 0.6) & (V > 0.45))
    inner = cv2.erode((alpha > 0.95).astype(np.uint8), disk(10)).astype(bool)
    band = (alpha > 0.6) & ~inner
    rim = _saturated_median(plate, band & (plate[..., 2] > plate[..., 0] + 0.08) & (V > 0.3))
    grid = np.median(plate[inner & (V > 0.5) & (np.abs(plate[..., 0] - plate[..., 2]) < 0.08)], axis=0)
    out = {"eye": hex_color(eye), "line": hex_color(line), "rim": hex_color(rim), "grid": hex_color(grid),
           "background": "#000000"}
    if wisp_frame is not None:
        f = wisp_frame
        outside = alpha < 0.01
        cyan = outside & (f[..., 2] > f[..., 0] + 0.15) & (f[..., 1] > f[..., 0] + 0.1) & (f.max(2) > 0.35)
        warm = outside & (f[..., 0] > f[..., 2] + 0.15) & (f.max(2) > 0.35)
        out["wisp"] = hex_color(_glow(_saturated_median(f, cyan, 0.5, (0.3, 0.85, 1.0))))
        out["mote"] = hex_color(_glow(_saturated_median(f, warm, 0.5, (1.0, 0.7, 0.35))))
    out["eyeGlow"] = hex_color(_glow(eye))
    out["lineGlow"] = hex_color(_glow(line))
    out["rimGlow"] = hex_color(_glow(rim))
    return out


def visible_outline(plate, alpha, thr=0.07):
    """Contour of the head pixels that visibly glow (inside the silhouette), smoothed."""
    L = cv2.GaussianBlur(luminance(plate) * alpha, (0, 0), 2.0)
    b = (L > thr).astype(np.uint8)
    b = cv2.morphologyEx(b, cv2.MORPH_OPEN, disk(3))
    b = cv2.morphologyEx(b, cv2.MORPH_CLOSE, disk(9))
    b = fill_holes(largest_component(b))
    b = cv2.GaussianBlur(b.astype(np.float32), (0, 0), 4) > 0.5
    cnts, _ = cv2.findContours(b.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cnt = max(cnts, key=cv2.contourArea)[:, 0, :].astype(np.float32)
    return cnt[::4]


def build_textures(info, frames, sel, imgs, debug_dir=None) -> Textures:
    log("building textures")
    plate_single, median = build_plate(imgs, sel, frames)
    H, W = plate_single.shape[:2]
    lm = frames[sel.neutral].lm.copy()
    alpha, solid, boundary, sil_info = build_silhouette(median, lm, sel.face_height)

    # Keep the face crisp (single frame) and use the median only near the edge / neck, where
    # background particles drift through the silhouette.
    dist = cv2.distanceTransform(solid.astype(np.uint8), cv2.DIST_L2, 5)
    face = feather(polygon_mask((H, W), lm[LM.FACE_OVAL, :2]), 4)
    w_single = np.maximum(smoothstep(6, 26, dist), face)
    w_single *= 1.0 - smoothstep(sil_info["chinY"] + 0.02 * sel.face_height,
                                 sil_info["chinY"] + 0.10 * sel.face_height,
                                 np.arange(H)[:, None].astype(np.float32)) * (1 - face)
    plate = plate_single * w_single[..., None] + median * (1 - w_single[..., None])
    plate = suppress_neck_motes(plate, alpha, lm, sil_info["chinY"], sil_info["neckFade"][0], sel.face_height)

    slit_line, lm_slit = find_slit(plate, lm)
    eyes = eye_geometry(lm)
    closed_by_eye, eye_reg = register_closed_eyes(plate, imgs, sel, frames, eyes)
    lids = detect_lids(plate, closed_by_eye, lm, eyes)
    lid_w, lid_up, _ = lid_maps(plate.shape, lids)
    almonds = {k: lid_maps(plate.shape, {k: v})[2] for k, v in lids.items()}
    regions = eye_regions(plate.shape, almonds)
    eyes_closed, eye_region = compose_closed_eyes(plate, closed_by_eye, regions)
    mouth, mouth_rect, mouth_info = build_mouth(plate, imgs, sel, frames, lm_slit, slit_line, sel.face_height)
    masks_a, masks_b, aperture = build_masks(plate, alpha, lm, eyes, eye_region)
    occ = occlusion_mask(alpha, lm, sel.face_height, plate)
    masks_c = np.stack([0.5 + 0.5 * lid_w, lid_up, occ], -1).astype(np.float32)
    palette = sample_palette(plate, alpha, masks_a[..., 1], aperture, to_float(imgs[sel.aura]))
    log(f"  palette {palette}")

    if debug_dir is not None:
        def save(name, img):
            img = np.clip(img, 0, 1)
            if img.ndim == 2:
                img = np.repeat(img[..., None], 3, -1)
            cv2.imwrite(str(debug_dir / name), cv2.cvtColor((img * 255).astype(np.uint8), cv2.COLOR_RGB2BGR))
        save("plate_single.png", plate_single)
        save("plate_median.png", median)
        save("plate.png", plate)
        save("alpha.png", alpha)
        save("eyes_closed.png", eyes_closed)
        save("mouth.png", mouth)
        save("masks_a.png", masks_a)
        save("masks_b.png", masks_b)
        save("masks_c.png", masks_c)
        save("plate_cutout.png", plate * alpha[..., None])

    visible = visible_outline(plate, alpha)
    return Textures(width=W, height=H, plate=plate, alpha=alpha, solid=solid, boundary=boundary,
                    visible_outline=visible,
                    eyes_closed=eyes_closed, mouth=mouth, mouth_rect=mouth_rect, masks_a=masks_a,
                    masks_b=masks_b, masks_c=masks_c, lids=lids, lm=lm_slit, slit_line=slit_line,
                    palette=palette,
                    info={"silhouette": sil_info, "eyes": eyes, "mouth": mouth_info,
                          "eyesClosedRegistration": eye_reg})
