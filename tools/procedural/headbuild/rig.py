"""Per-vertex rig weights (0..1) and rig anchors for the procedural head.

Channels (must match src/avatar/heads/procedural/format.js RIG_CHANNELS):
  0 jaw        rotation about the TMJ hinge (lower lip, chin, lower cheeks, under-chin)
  1 upperLip   upper lip region (lift / push)
  2 lowerLip   lower lip region (extra drop / push)
  3 cornerL    screen-left mouth corner (smile / wide / round)
  4 cornerR    screen-right mouth corner
  5 browL      screen-left brow
  6 browR      screen-right brow
  7 cheek      cheeks (smile raise)
"""

from __future__ import annotations

import numpy as np
import scipy.sparse as sp
import scipy.sparse.csgraph as csgraph

from . import mesh_ops as mo
from .landmarks import LM

RIG_CHANNELS = ["jaw", "upperLip", "lowerLip", "cornerL", "cornerR", "browL", "browR", "cheek"]


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def graph_dist(V, F, sources, limit=0.08):
    n = len(V)
    e = mo.edges_unique(F)
    w = np.linalg.norm(V[e[:, 0]] - V[e[:, 1]], axis=1)
    G = sp.coo_matrix((w, (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    G = G + G.T
    d = csgraph.dijkstra(G, directed=False, indices=np.asarray(sources), min_only=True, limit=limit)
    d[~np.isfinite(d)] = limit
    return d


def anchors(V, lm, seam_path):
    """Rig geometry in world units (rest pose)."""
    S = V[seam_path]
    cL, cR = S[0], S[-1]
    mouth_c = S.mean(0)
    hw = 0.5 * abs(cR[0] - cL[0])
    eye_y = 0.5 * (lm[LM["eyeL_out"], 1] + lm[LM["eyeR_out"], 1])
    # temporomandibular joint: just in front of the ear canal, a little below eye level
    from .shading import ear_centers
    ear_z = float(np.mean([c[2] for c in ear_centers(V)]))
    tmj = np.array([0.0, eye_y - 0.085, ear_z + 0.045])
    chin = lm[LM["chin"]].copy()
    return {
        "mouthCenter": mouth_c, "cornerL": cL, "cornerR": cR, "mouthHalfWidth": hw,
        "jawPivot": tmj, "chin": chin, "eyeY": eye_y,
        "noseTip": lm[LM["noseTip"]].copy(), "subnasale": lm[LM["subnasale"]].copy(),
        "lipBottom": lm[LM["lipBottom"]].copy(), "lipTop": lm[LM["lipTop"]].copy(),
    }


def compute_weights(V, F, skin_n, seam, lm, A):
    """Weights for the first `skin_n` vertices (skin). Returns (skin_n, 8) float array."""
    Vs = V[:skin_n]
    x, y, z = Vs[:, 0], Vs[:, 1], Vs[:, 2]
    W = np.zeros((skin_n, len(RIG_CHANNELS)))
    mc, hw = A["mouthCenter"], A["mouthHalfWidth"]
    cL, cR = A["cornerL"], A["cornerR"]
    path, lower = seam.path, seam.lower
    sx = V[path, 0]
    sy = V[path, 1]
    o = np.argsort(sx)
    lat = np.abs(x - mc[0])

    # --- jaw ------------------------------------------------------------------------------------
    # geometric split: the seam inside the mouth, then a line rising from the corners toward the
    # TMJ; the transition widens with the distance from the corners (soft cheeks, crisp lips)
    corner_y = 0.5 * (cL[1] + cR[1])
    split = np.where(lat <= hw, np.interp(x, sx[o], sy[o]), corner_y + (lat - hw) * 0.55)
    h = 0.004 + 0.32 * np.clip(lat - 0.75 * hw, 0, None)
    w_geo = smoothstep(h, -h, y - split)
    # topological side near the seam (the split mesh only connects upper and lower lip at the
    # corners): compare graph distances to the upper and lower rim
    interior_up = path[1:-1]
    interior_lo = lower[1:-1]
    d_up = graph_dist(V[:skin_n], F_skin(F, skin_n), interior_up, 0.05)
    d_lo = graph_dist(V[:skin_n], F_skin(F, skin_n), interior_lo, 0.05)
    side = d_up / np.maximum(d_up + d_lo, 1e-9)                    # 1 near the lower rim
    w_topo = smoothstep(0.42, 0.58, side)
    near = smoothstep(0.03, 0.012, np.minimum(d_up, d_lo)) * smoothstep(1.15 * hw, 0.85 * hw, lat)
    w = w_geo * (1 - near) + w_topo * near
    w[interior_up] = 0.0
    w[interior_lo] = 1.0
    # fade out behind the jaw (toward the ears / back of the neck) and down the neck
    tmj = A["jawPivot"]
    w *= smoothstep(tmj[2] - 0.02, tmj[2] + 0.1, z)
    chin_y = A["chin"][1]
    under = y < chin_y + 0.02
    w = np.where(under, w * (0.25 + 0.75 * smoothstep(chin_y - 0.16, chin_y + 0.0, y)) *
                 smoothstep(-0.05, 0.12, z - (tmj[2] - 0.02)), w)
    W[:, 0] = np.clip(w, 0, 1)

    # --- lips -----------------------------------------------------------------------------------
    lipx = np.exp(-(((x - mc[0]) / (1.15 * hw)) ** 4))
    up_extent = max(0.012, A["lipTop"][1] - mc[1] + 0.012)
    lo_extent = max(0.012, mc[1] - A["lipBottom"][1] + 0.012)
    front = smoothstep(mc[2] - 0.08, mc[2] - 0.02, z)
    upper_side = W[:, 0] < 0.5
    W[:, 1] = np.where(upper_side, lipx * smoothstep(up_extent, 0.0, y - mc[1]) * front, 0)
    W[:, 2] = np.where(~upper_side, lipx * smoothstep(-lo_extent, 0.0, y - mc[1]) * front, 0)
    W[interior_up, 1] = 1.0 * lipx[interior_up]
    W[interior_lo, 2] = 1.0 * lipx[interior_lo]

    # --- corners --------------------------------------------------------------------------------
    for ch, c in ((3, cL), (4, cR)):
        d = np.linalg.norm(Vs - c, axis=1)
        W[:, ch] = np.exp(-(d / 0.03) ** 2) * front

    # --- brows ----------------------------------------------------------------------------------
    for ch, ids in ((5, LM["browL"]), (6, LM["browR"])):
        b = lm[ids]
        bc = b.mean(0)
        # broad band over the brow ridge, falling off up the forehead and above the eye
        d = (x - bc[0]) / 0.075
        dy = (y - (bc[1] + 0.012)) / 0.045
        # (kept off the eyelids: the shader-drawn eyes are attached to the lid skin)
        W[:, ch] = (np.exp(-(d ** 2) - dy ** 2) * smoothstep(bc[2] - 0.12, bc[2] - 0.04, z)
                    * smoothstep(A["eyeY"] + 0.018, A["eyeY"] + 0.05, y))

    # --- cheeks ---------------------------------------------------------------------------------
    for c, sgn in ((cL, -1), (cR, 1)):
        cc = np.array([c[0] + sgn * 0.035, c[1] + 0.06, c[2] - 0.02])
        d = np.linalg.norm((Vs - cc) / np.array([0.05, 0.045, 0.06]), axis=1)
        W[:, 7] = np.maximum(W[:, 7], np.exp(-d ** 2))
    return np.clip(W, 0, 1)


def F_skin(F, skin_n):
    return F[(F < skin_n).all(1)]


def inner_mouth_mask(V, F, N, path, lower, A, reach=0.01):
    """1 on the inner (wet) walls of the lips: close to the seam and facing away from the
    front. These become visible when the mouth opens and are shaded like the cavity."""
    skin_n = len(V)
    Fs = F_skin(F, skin_n)
    d = graph_dist(V, Fs, np.r_[path[1:-1], lower[1:-1]], reach * 2)
    lat = np.abs(V[:, 0] - A["mouthCenter"][0])
    facing = N[:, 2]
    m = smoothstep(reach, reach * 0.35, d) * smoothstep(0.6, 0.25, facing)
    m *= smoothstep(1.08 * A["mouthHalfWidth"], 0.9 * A["mouthHalfWidth"], lat)
    return np.clip(m, 0, 1)
