"""Stage 1: source scan -> cropped, smoothed, subdivided head aligned/warped to the reference."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import mesh_ops as mo
from .landmarks import (EYE_L_LOWER, EYE_L_UPPER, EYE_R_LOWER, EYE_R_UPPER, LIP_INNER_LOWER,
                        LIP_INNER_UPPER, LM, LandmarkCache)
from .raster import OrthoView, ScreenView, render_shaded
from .raycast import Caster
from .reference import ReferenceProfile
from .warp import Controls, rbf_warp

# Camera (must match ProceduralHead.framing()): vertical fov, plate (view) height 1 at z = 0.
FOV_DEG = 12.0
CAMERA_DIST = 0.5 / np.tan(np.radians(FOV_DEG / 2))
NECK_CUT_Y = -0.45         # world y below which the scan (shoulders) is removed


@dataclass
class HeadGeometry:
    V: np.ndarray
    F: np.ndarray
    src_landmarks: np.ndarray     # (478, 3) landmark surface points carried through the warp
    view: ScreenView
    info: dict


def source_landmarks(V, F, cache: LandmarkCache):
    """MediaPipe on a flat-shaded front render of the scan, lifted onto the surface."""
    view = OrthoView(V, size=1024)
    img = render_shaded(V, F, view, light=(0.0, 0.3, 1.0))
    lm_px = cache.get("source_front", img)
    xy = view.from_px(lm_px[:, :2])
    pts, tri = Caster(V, F).front(xy)
    miss = np.isnan(pts[:, 0])
    if miss.any():
        # landmarks on the silhouette may miss: fall back to the nearest vertex in xy
        for i in np.where(miss)[0]:
            j = np.argmin(((V[:, :2] - xy[i]) ** 2).sum(1) - V[:, 2] * 1e-3)
            pts[i] = V[j]
    return pts


def _similarity(A, B):
    ma, mb = A.mean(0), B.mean(0)
    s = np.sqrt(((B - mb) ** 2).sum() / ((A - ma) ** 2).sum())
    return s, mb - s * ma


ALIGN_IDX = [33, 133, 362, 263, 1, 6, 61, 291, 0, 105, 334, 98, 327]


def align(V, src_lm, ref: ReferenceProfile, view: ScreenView):
    """Scale/translate the scan so its face landmarks land on the reference in screen space."""
    target = ref.to_screen(ref.landmarks_px[ALIGN_IDX, :2])
    W, L = V.copy(), src_lm.copy()

    def apply(s, t):
        for X in (W, L):
            X[:, :2] = X[:, :2] * s + t
            X[:, 2] *= s
        # keep the cranium's depth centre at z = 0 (the silhouette plane the aura wraps)
        upper = W[W[:, 1] > 0.15]
        dz = -0.5 * (upper[:, 2].min() + upper[:, 2].max())
        W[:, 2] += dz
        L[:, 2] += dz

    apply(*_similarity(src_lm[ALIGN_IDX, :2], target))
    # perspective makes the (forward) face look bigger: refit on the projected landmarks
    for _ in range(4):
        apply(*_similarity(view.project(L[ALIGN_IDX]), target))
    return W, L


def crop(V, F, lm, y_cut=NECK_CUT_Y):
    keep = (V[F][:, :, 1] > y_cut).all(1)
    V2, F2, _ = mo.compact(V, F, keep)
    V2, F2 = mo.largest_component(V2, F2)
    return V2, F2


def smooth(V, F):
    """Taubin smoothing: strong on the scan-noisy neck / cranium, gentle on facial features."""
    y = V[:, 1]
    z = V[:, 2]
    zf = z.max()
    face = np.clip((z - (zf - 0.25)) / 0.12, 0, 1) * np.clip((y + 0.36) / 0.06, 0, 1) * np.clip((0.3 - y) / 0.06, 0, 1)
    strength = 1.0 - 0.6 * face
    bnd = np.unique(mo.boundary_edges(F))
    V = mo.taubin(V, F, iterations=12, strength=strength, fixed=bnd)
    V = mo.taubin(V, F, iterations=25, strength=np.clip(1 - face * 1.5, 0, 1) * 0.8, fixed=bnd)
    return V


# MediaPipe face-mesh rings that must not drive the warp: the face oval sits inside the
# hologram's glowing silhouette on the reference; the scan's lids are closed while the
# reference's are open; the reference's inner lips are parted; irises are not on the skin.
FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400,
             377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
EYE_CORNERS = [33, 133, 362, 263]


def dense_feature_ids(ref: ReferenceProfile):
    """Landmarks used for the dense feature warp."""
    excl = set(FACE_OVAL) | set(LIP_INNER_UPPER) | set(LIP_INNER_LOWER)
    eyes = (EYE_L_UPPER + EYE_L_LOWER, EYE_R_UPPER + EYE_R_LOWER)
    excl |= (set(eyes[0]) | set(eyes[1])) - set(EYE_CORNERS)
    eye_c = [ref.lm(e) for e in eyes]
    # MediaPipe compresses the hologram's lower face and jaw (its chin point sits ~0.06 above
    # the real chin): keep the central face only - brows, eyes' surroundings, nose, mouth
    chin_limit = ref.lm([61, 291])[1] - 0.006           # mouth corner level
    nose = ref.lm(1)
    ids = []
    for i in range(468):
        if i in excl:
            continue
        s = ref.lm(i)
        if s[1] < chin_limit or ((s[0] - nose[0]) / 0.2) ** 2 + ((s[1] - nose[1] - 0.04) / 0.2) ** 2 > 1:
            continue
        if i not in EYE_CORNERS and min(np.linalg.norm(s - c) for c in eye_c) < 0.04:
            continue                      # lid skin around the (open) reference eyes
        ids.append(i)
    return ids


def warp_to_reference(V, F, lm, ref: ReferenceProfile, view: ScreenView, amount=0.85, dense=True):
    """Gaussian-RBF warp: facial features toward the reference landmarks, outline toward the
    reference silhouette. Displacements are computed in screen space and unprojected.
    dense=True uses ~300 MediaPipe correspondences (whole face layout), else a sparse set."""
    ctrl = Controls()
    D = view.dist

    def screen_disp(p, target_screen, mask=(1, 1)):
        cur = view.project(p[None])[0]
        need = (np.asarray(target_screen) - cur) * np.asarray(mask, float)
        return need * (D - p[2]) / D * amount

    # --- features ---------------------------------------------------------------------------
    ref_lm = ref.landmarks_px
    gap_ref = ref.lm(LIP_INNER_LOWER[1:-1]) - ref.lm(LIP_INNER_UPPER[1:-1])   # (<0: open mouth)
    feats = [
        # (landmark ids on the source, target ids on the reference, sigma, extra screen offset)
        ([33], [33], 0.045), ([133], [133], 0.04), ([362], [362], 0.04), ([263], [263], 0.045),
        ([159, 145], [159, 145], 0.035), ([386, 374], [386, 374], 0.035),
        ([70], [70], 0.05), ([105], [105], 0.05), ([107], [107], 0.05),
        ([300], [300], 0.05), ([334], [334], 0.05), ([336], [336], 0.05),
        ([1], [1], 0.05), ([2], [2], 0.04), ([98], [98], 0.035), ([327], [327], 0.035),
        ([61], [61], 0.04), ([291], [291], 0.04), ([0], [0], 0.035),
        ([37], [37], 0.035), ([267], [267], 0.035),
    ]
    for src_ids, ref_ids, sig in feats:
        p = lm[src_ids].mean(0)
        tgt = ref.to_screen(ref_lm[ref_ids, :2]).mean(0)
        ctrl.add(p, screen_disp(p, tgt), sig, True, f"lm{src_ids}")
    # lower lip: the reference mouth is slightly open; close the gap before matching
    for i in (17, 84, 314):
        p = lm[i]
        tgt = ref.lm(i) - gap_ref
        ctrl.add(p, screen_disp(p, tgt), 0.045, True, f"lowerlip{i}")

    # --- silhouette -------------------------------------------------------------------------
    S = view.project(V)
    cx_ref = (ref.center_x_px - ref.width / 2) / ref.height
    eye_y = 0.5 * (lm[LM["eyeL_out"], 1] + lm[LM["eyeR_out"], 1])
    ear_lo, ear_hi = eye_y - 0.20, eye_y + 0.03          # ear band (ears are not matched)
    ref_rows_y = ref.to_screen(np.c_[np.zeros_like(ref.rows_px), ref.rows_px])[:, 1]
    neck_hw = None
    for y in np.arange(0.46, -0.45, -0.04):
        if ear_lo < y < ear_hi:
            continue
        row = int(np.argmin(np.abs(ref_rows_y - y)))
        hw = ref.half_width_px[row] / ref.height
        if y < -0.31:
            # below the chin the reference neck fades out: keep it a slender cylinder
            hw = neck_hw if neck_hw is not None else 0.155
        elif not np.isfinite(hw) or hw <= 0.02:
            continue
        if -0.31 <= y < -0.25:
            neck_hw = hw
        band = np.abs(S[:, 1] - y) < 0.008
        if band.sum() < 4:
            continue
        for side in (-1, 1):
            idx = np.where(band & (np.sign(S[:, 0]) == side))[0]
            if not len(idx):
                continue
            j = idx[np.argmax(np.abs(S[idx, 0]))]
            tgt = np.array([cx_ref + side * hw, S[j, 1]])
            ctrl.add(V[j], screen_disp(V[j], tgt, (1, 0)), 0.09, False, f"sil{y:.2f}{side:+d}")
    # crown and chin
    j = np.argmax(S[:, 1])
    ctrl.add(V[j], screen_disp(V[j], [S[j, 0], ref.to_screen([[0, ref.top_px]])[0, 1]], (0, 1)), 0.1, False, "crown")
    chin_band = (np.abs(S[:, 0]) < 0.03) & (V[:, 2] > np.percentile(V[:, 2], 70)) & (S[:, 1] < lm[17, 1])
    jc = np.where(chin_band)[0]
    face_below_lip = jc[S[jc, 1] > lm[152, 1] - 0.06]
    j = face_below_lip[np.argmin(S[face_below_lip, 1])]
    ctrl.add(V[j], screen_disp(V[j], [S[j, 0], ref.to_screen([[0, ref.chin_px]])[0, 1]], (0, 1)), 0.06, True, "chin")

    z_face = float(np.percentile(V[:, 2], 99))
    z_ear = float(lm[[234, 454], 2].mean()) - 0.02
    V2, diag = rbf_warp(V, ctrl, z_face=z_face, z_ear=z_ear)
    # landmarks ride along (same field)
    lm2, _ = rbf_warp(lm, ctrl, z_face=z_face, z_ear=z_ear)
    if diag["scale"] < 1:
        lm2 = lm + (lm2 - lm) * diag["scale"]
    diag["controls"] = len(ctrl.points)
    if dense:
        V2, lm2, diag["dense"] = dense_refine(V2, lm2, ref, view, gap_ref, z_face, z_ear, amount)
    return V2, lm2, diag


def dense_refine(V, lm, ref: ReferenceProfile, view: ScreenView, gap_ref, z_face, z_ear, amount,
                 sigma=0.03, reg=0.35, max_grad=0.45):
    """Second warp pass: ~300 MediaPipe correspondences pull the whole facial layout (nose,
    lips, cheeks, brows) toward the reference. Strongly regularised (approximating, not
    interpolating) and separately fold-guarded, so conflicting neighbours only soften it."""
    D = view.dist
    ctrl = Controls()
    mouth_y = ref.lm([13, 14])[1]
    mouth_hw = 0.5 * abs(ref.lm(291)[0] - ref.lm(61)[0])
    for i in dense_feature_ids(ref):
        p = lm[i]
        tgt = ref.lm(i).copy()
        if tgt[1] < mouth_y - 0.002 and abs(tgt[0] - ref.lm(0)[0]) < 1.6 * mouth_hw:
            tgt = tgt - gap_ref           # the reference's slightly open mouth, closed
        need = (tgt - view.project(p[None])[0]) * (D - p[2]) / D * amount
        ctrl.add(p, need, sigma, True, f"lm{i}")
    V2, info = rbf_warp(V, ctrl, z_face=z_face, z_ear=z_ear, reg=reg, max_grad=max_grad)
    lm2, _ = rbf_warp(lm, ctrl, z_face=z_face, z_ear=z_ear, reg=reg, max_grad=max_grad)
    if info["scale"] < 1:
        lm2 = lm + (lm2 - lm) * info["scale"]
    info["controls"] = len(ctrl.points)
    return V2, lm2, info


def tuck_ears(V, amount=0.62, push=0.024):
    """The reference's ears are small and lie flat: shrink the scan's ears toward their root."""
    from .shading import ear_centers
    V = V.copy()
    for side, c in zip((-1, 1), ear_centers(V)):
        root = np.array([c[0] - side * 0.045, c[1], c[2] + 0.005])
        d = np.linalg.norm((V - c) / np.array([0.06, 0.1, 0.07]), axis=1)
        lateral = np.clip((V[:, 0] * side - (abs(root[0]) - 0.01)) / 0.03, 0, 1)
        w = np.exp(-d ** 2 * 1.2) * lateral
        w = w * w * (3 - 2 * w)
        V = root + (V - root) * (1 - amount * w)[:, None]
        V[:, 0] -= side * push * w
    return V


def build_geometry(src_path, ref: ReferenceProfile, cache: LandmarkCache) -> HeadGeometry:
    V0, F0 = mo.load_glb(src_path)
    src_lm = source_landmarks(V0, F0, cache)
    view = ScreenView(CAMERA_DIST, ref.width, ref.height)
    V, lm = align(V0, src_lm, ref, view)
    V, F = crop(V, F0, lm)
    V = smooth(V, F)
    V, F = mo.subdivide_loop(V, F, 1)
    V, lm, diag = warp_to_reference(V, F, lm, ref, view)
    V = tuck_ears(V)
    # landmarks back onto the (smoothed, subdivided, warped) surface: nearest surface point
    cast = Caster(V, F)
    o, d = view.ray(view.project(lm))
    hit, _ = cast.first_hit(o, d)
    ok = ~np.isnan(hit[:, 0]) & (np.linalg.norm(hit - lm, axis=1) < 0.03)
    lm[ok] = hit[ok]
    info = {"verts": int(len(V)), "faces": int(len(F)), "warp": diag}
    return HeadGeometry(V, F, lm, view, info)
