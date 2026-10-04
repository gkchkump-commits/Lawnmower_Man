"""Baked per-vertex shading attributes: ambient occlusion, feature convexity, shell normals, masks."""

from __future__ import annotations

import numpy as np

from . import mesh_ops as mo
from .raycast import Caster


def _hemisphere(n_dirs: int, seed: int = 7) -> np.ndarray:
    """Cosine-weighted directions around +z (Fibonacci spiral, deterministic)."""
    i = np.arange(n_dirs) + 0.5
    r = np.sqrt(i / n_dirs)
    phi = i * np.pi * (3 - np.sqrt(5)) + seed
    return np.stack([r * np.cos(phi), r * np.sin(phi), np.sqrt(1 - r * r)], 1)


def ambient_occlusion(V, F, N, n_dirs=48, max_dist=0.12, chunk=200_000):
    """Fraction of the cosine hemisphere that is open (1 = unoccluded) per vertex."""
    cast = Caster(V, F)
    H = _hemisphere(n_dirs)
    # orthonormal frame per vertex
    a = np.where(np.abs(N[:, 2:3]) < 0.9, np.array([[0, 0, 1.0]]), np.array([[1.0, 0, 0]]))
    T = np.cross(a, N)
    T /= np.linalg.norm(T, axis=1, keepdims=True)
    B = np.cross(N, T)
    D = (H[None, :, 0:1] * T[:, None] + H[None, :, 1:2] * B[:, None] + H[None, :, 2:3] * N[:, None]).reshape(-1, 3)
    O = np.repeat(V + N * 1e-3, n_dirs, 0)
    occ = np.zeros(len(D), bool)
    for s in range(0, len(D), chunk):
        o, d = O[s:s + chunk], D[s:s + chunk]
        loc, ir, _ = cast.mesh.ray.intersects_location(o, d, multiple_hits=False)
        if len(ir):
            dist = np.linalg.norm(loc - o[ir], axis=1)
            hit = dist < max_dist
            occ[s + ir[hit]] = True
    return 1.0 - occ.reshape(len(V), n_dirs).mean(1)


def convexity(V, F, N, scales=(20, 80)):
    """Multi-scale feature convexity in [-1, 1]: > 0 on features that stick out (nose bridge,
    cheek bones, lips, chin), < 0 in sockets and folds.

    Per scale: offset of each vertex from a Laplacian-smoothed copy along the normal, then
    high-passed (minus a smoothed copy of itself) because plain smoothing also shrinks the
    whole head - a smooth bias that would make the crown read as the biggest "ridge".
    Normalised by the 97th percentile of each scale."""
    W = mo.umbrella(V, F)
    acc = np.zeros(len(V))
    X = V.copy()
    done = 0
    for it in sorted(scales):
        for _ in range(it - done):
            X = X + 0.5 * (W @ X - X)
        done = it
        d = np.einsum("ij,ij->i", V - X, N)
        d = d - mo.smooth_scalar(d, V, F, iterations=4 * it)
        acc += d / (np.percentile(np.abs(d), 97) + 1e-9)
    acc /= len(scales)
    return np.clip(mo.smooth_scalar(acc, V, F, iterations=2), -1, 1)


def shell_normals(V, F, iterations=160):
    """Normals of a heavily smoothed copy of the head: the 'outer shell' direction. Used for the
    hologram edge glow so concave / small features (nose sides, nostrils) don't get a rim."""
    W = mo.umbrella(V, F)
    X = V.copy()
    for _ in range(iterations):
        X = X + 0.6 * (W @ X - X)
    return mo.vertex_normals(X, F)


def polygon_sdf(P2: np.ndarray, poly: np.ndarray) -> np.ndarray:
    """Signed distance (negative inside) from 2D points to a closed polygon."""
    n = len(poly)
    d = np.full(len(P2), np.inf)
    inside = np.zeros(len(P2), bool)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        ab = b - a
        t = np.clip(((P2 - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
        d = np.minimum(d, np.linalg.norm(P2 - (a + t[:, None] * ab), axis=1))
        cond = (a[1] > P2[:, 1]) != (b[1] > P2[:, 1])
        xint = a[0] + (P2[:, 1] - a[1]) * ab[0] / (ab[1] if abs(ab[1]) > 1e-12 else 1e-12)
        inside ^= cond & (P2[:, 0] < xint)
    return np.where(inside, -d, d)


def lips_mask(V, lm, outer_upper, outer_lower, softness=0.004, lower_extend=0.009):
    """1 on the lip vermilion (inside the outer lip contour, front facing).

    MediaPipe places the lower-lip contour of the grey, closed-mouth scan render too high (the
    lower vermilion border has no colour contrast there), so it is pushed down by
    `lower_extend` in the middle of the mouth (not at the corners)."""
    low = lm[outer_lower][:, :2].copy()
    t = np.linspace(-1, 1, len(low))
    low[:, 1] -= lower_extend * (1 - t * t)
    poly = np.concatenate([lm[outer_upper][:, :2], low[::-1][1:-1]])
    sd = polygon_sdf(V[:, :2], poly)
    t = np.clip(0.5 - sd / (2 * softness), 0, 1)
    zf = lm[outer_upper + outer_lower, 2].min() - 0.05     # keep the front of the face only
    return t * np.clip((V[:, 2] - zf) / 0.03, 0, 1)


def ear_centers(V):
    out = []
    for side in (-1, 1):
        sx = V[:, 0] * side
        idx = np.argsort(sx)[-300:]
        out.append(V[idx].mean(0))
    return out


def ear_mask(V, centers=None):
    centers = ear_centers(V) if centers is None else centers
    m = np.zeros(len(V))
    for side, c in zip((-1, 1), centers):
        # the lateral-most vertices sit low on the ear: reach up to the top of the helix too
        c = c + np.array([0.0, 0.02, 0.0])
        d = np.linalg.norm((V - c) / np.array([0.05, 0.105, 0.06]), axis=1)
        lateral = np.clip((V[:, 0] * side - (abs(c[0]) - 0.06)) / 0.025, 0, 1)
        m = np.maximum(m, np.exp(-d ** 2 * 1.5) * lateral)
    return np.clip(m * 1.4, 0, 1)


def neck_mask(V, jaw_line, axis_z=0.0, soft=0.012, lift=0.002, drop=0.12, drop_span=0.45):
    """1 below the jaw line (the under-jaw and the neck), 0 on the face, smooth.

    `jaw_line` is the 3D jaw contour (MediaPipe face-oval landmarks of the warped scan, one jaw
    angle -> chin -> the other). Each vertex is compared with the jaw line's height at the same
    azimuth around a vertical axis through z = `axis_z` (so the sides of the jaw that only show
    when the head turns are classified correctly); beyond its ends the line drops by `drop`
    over `drop_span` radians of azimuth (the mandible's lower border toward the jaw angle).
    The reference's lower face is a narrow V: its neck and under-jaw are dark."""
    J = np.asarray(jaw_line, float)
    phi_j = np.arctan2(J[:, 0], J[:, 2] - axis_z)
    o = np.argsort(phi_j)
    phi = np.arctan2(V[:, 0], V[:, 2] - axis_z)
    cy = np.interp(phi, phi_j[o], J[o, 1])
    # beyond the contour's ends (its last points sit at ear-lobe height on the cheek) the
    # mandible's lower border runs down and back to the angle of the jaw: lower the line there
    lo, hi = phi_j[o][0], phi_j[o][-1]
    beyond = np.clip(np.maximum(lo - phi, phi - hi) / drop_span, 0, 1)
    cy = cy - drop * beyond * beyond * (3 - 2 * beyond)
    t = np.clip((cy - V[:, 1] + lift) / soft, 0, 1)
    return t * t * (3 - 2 * t)


# face-oval landmarks along the sides of the face (temple -> cheek -> jaw angle), per side
SIDE_OVAL = ([162, 127, 234, 93, 132], [389, 356, 454, 323, 361])


def ear_mask_screen(V, side_lines_screen, view, ear_z, margin=0.004, soft=0.014):
    """Ears as seen from the front: whatever lies beyond the side of the face (the face-oval
    contour, temple to jaw angle) at ear depth. The reference's ears are faint; this also catches
    the parts of the ear (helix, root) the ellipsoid mask misses."""
    S = view.project(V)
    m = np.zeros(len(V))
    for line, sgn in zip(side_lines_screen, (-1, 1)):
        L = np.asarray(line, float)
        o = np.argsort(L[:, 1])
        ys, xs = L[o, 1], np.abs(L[o, 0])
        cx = np.interp(S[:, 1], ys, xs)
        beyond = np.clip((S[:, 0] * sgn - cx - margin) / soft, 0, 1)
        band = np.clip((S[:, 1] - ys[0] + 0.01) / 0.02, 0, 1) * np.clip((ys[-1] + 0.03 - S[:, 1]) / 0.03, 0, 1)
        on_side = (S[:, 0] * sgn > 0).astype(float)
        m = np.maximum(m, beyond * band * on_side)
    depth = np.exp(-((V[:, 2] - ear_z) / 0.08) ** 2)
    m = m * depth
    return m * m * (3 - 2 * m)
