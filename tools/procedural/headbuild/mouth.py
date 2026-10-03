"""Lip seam: find it on the closed-mouth scan, split the mesh along it so the jaw can open,
and build the mouth cavity ("bag") that closes the opening from behind."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import scipy.sparse as sp
import scipy.sparse.csgraph as csgraph

from . import mesh_ops as mo
from .landmarks import LIP_INNER_LOWER, LIP_INNER_UPPER


@dataclass
class Seam:
    path: np.ndarray          # ordered vertex ids corner -> corner (upper-side ids)
    lower: np.ndarray         # lower-side ids (path[0] / path[-1] = shared corners)
    corners: tuple            # (left corner id, right corner id)  (screen left / right)


def _polyline_dist(P: np.ndarray, poly: np.ndarray) -> np.ndarray:
    """Distance from points P (n,3) to a 3D polyline (m,3)."""
    best = np.full(len(P), np.inf)
    for a, b in zip(poly[:-1], poly[1:]):
        ab = b - a
        t = np.clip(((P - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
        d = np.linalg.norm(P - (a + t[:, None] * ab), axis=1)
        best = np.minimum(best, d)
    return best


def find_seam(V, F, lm) -> np.ndarray:
    """Ordered vertex path along the lip seam (groove) between the inner mouth corners."""
    guide = 0.5 * (lm[LIP_INNER_UPPER] + lm[LIP_INNER_LOWER])
    # the mouth corners: inner-lip corners 78 / 308
    c0 = int(np.argmin(np.linalg.norm(V - lm[78], axis=1)))
    c1 = int(np.argmin(np.linalg.norm(V - lm[308], axis=1)))
    n = len(V)
    N = mo.vertex_normals(V, F)
    # The lips meet where the surface stops facing down (upper lip) and starts facing up
    # (lower lip): follow the zero crossing of the normal's y component, close to the guide.
    ny = mo.smooth_scalar(N[:, 1], V, F, iterations=2)
    e = mo.edges_unique(F)
    elen = np.linalg.norm(V[e[:, 0]] - V[e[:, 1]], axis=1)
    mid = 0.5 * (V[e[:, 0]] + V[e[:, 1]])
    d = _polyline_dist(mid, guide)
    nym = 0.5 * (ny[e[:, 0]] + ny[e[:, 1]])
    # local seam direction from the guide polyline: steps across it (row hopping inside the
    # dense crease) are expensive, so the path follows one row instead of saw-toothing
    seg = np.diff(guide, axis=0)
    seg_mid = 0.5 * (guide[1:] + guide[:-1])
    nearest = np.argmin(((mid[:, None, :] - seg_mid[None, :, :]) ** 2).sum(-1), axis=1)
    tang = seg[nearest] / np.linalg.norm(seg[nearest], axis=1, keepdims=True)
    ev = V[e[:, 1]] - V[e[:, 0]]
    along = np.abs(np.einsum("ij,ij->i", ev, tang)) / np.maximum(elen, 1e-12)
    perp2 = np.clip(1 - along ** 2, 0, 1)
    cost = elen * (1 + (d / 0.005) ** 2) * (1 + 6 * perp2) * (1 + (nym / 0.12) ** 2)
    cost[d > 0.03] = np.inf                                     # stay in the mouth
    ok = np.isfinite(cost)
    G = sp.coo_matrix((cost[ok], (e[ok, 0], e[ok, 1])), shape=(n, n)).tocsr()
    G = G + G.T
    dist, pred = csgraph.dijkstra(G, directed=False, indices=c0, return_predecessors=True)
    if not np.isfinite(dist[c1]):
        raise RuntimeError("lip seam: no path between the mouth corners")
    path = [c1]
    while path[-1] != c0:
        path.append(int(pred[path[-1]]))
    path = np.array(path[::-1])
    if V[path[0], 0] > V[path[-1], 0]:
        path = path[::-1]
    return shortcut_path(path, mo.adjacency(V, F))


def shortcut_path(path, A):
    """Remove detours: drop a vertex whenever its two path neighbours share an edge."""
    path = list(path)
    changed = True
    while changed:
        changed = False
        k = 1
        while k < len(path) - 1:
            if A[path[k - 1], path[k + 1]]:
                del path[k]
                changed = True
            else:
                k += 1
    return np.array(path)


def smooth_seam(V, F, path, iterations=12, relax_rings=2):
    """Straighten the seam polyline (scan creases zig-zag between vertex rows) and relax the
    rows next to it so the lips part along a clean curve."""
    V = V.copy()
    P = V[path].copy()
    for _ in range(iterations):
        P[1:-1] = 0.5 * P[1:-1] + 0.25 * (P[:-2] + P[2:])
    delta = np.zeros_like(V)
    delta[path] = P - V[path]
    V[path] = P
    # carry part of the correction to the neighbouring rows (avoids slivers / fold-overs)
    A = mo.adjacency(V, F)
    moved = np.zeros(len(V), bool)
    moved[path] = True
    frontier = moved.copy()
    for ring in range(relax_rings):
        nb = (A @ frontier.astype(float)) > 0
        nb &= ~moved
        if not nb.any():
            break
        # average of the moved neighbours' corrections, attenuated per ring
        cnt = A @ moved.astype(float)
        dsum = A @ (delta * moved[:, None])
        d = dsum[nb] / np.maximum(cnt[nb], 1)[:, None] * (0.5 / (ring + 1))
        V[nb] += d
        delta[nb] = d
        moved |= nb
        frontier = nb
    return V


def split_seam(V, F, path):
    """Duplicate the interior seam vertices; faces below the seam use the copies.
    Returns V, F (modified copies) and the lower-side id array."""
    n0 = len(V)
    V = np.vstack([V, V[path[1:-1]]])          # copies for the interior seam vertices
    F = F.copy()
    vf = [[] for _ in range(n0)]
    for fi, f in enumerate(F):
        for v in f:
            vf[v].append(fi)
    lower = path.copy()
    seam_xy = V[path][:, :2]
    order = np.argsort(seam_xy[:, 0])

    def seam_y(x):
        return np.interp(x, seam_xy[order, 0], seam_xy[order, 1])

    F0 = F.copy()                                   # topology queries use the original ids

    def has_edge(fi, p, q):
        """Face fi contains the oriented edge p -> q (faces wind counter-clockwise outside)."""
        f = F0[fi]
        return any(f[j] == p and f[(j + 1) % 3] == q for j in range(3))

    for k in range(1, len(path) - 1):
        v, a, b = path[k], path[k - 1], path[k + 1]
        faces = vf[v]
        # group incident faces by connectivity across non-seam edges
        parent = {f: f for f in faces}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for i, fi in enumerate(faces):
            for fj in faces[i + 1:]:
                shared = set(F0[fi]) & set(F0[fj])
                if len(shared) == 2:
                    w = (shared - {v}).pop()
                    if w not in (a, b):
                        parent[find(fi)] = find(fj)
        groups = {}
        for fi in faces:
            groups.setdefault(find(fi), []).append(fi)
        dup = n0 + k - 1
        lower[k] = dup
        for g in groups.values():
            # the path runs screen-left -> right: faces left of a->v / v->b (seen from outside)
            # are above it, faces left of v->a / b->v below it
            up = any(has_edge(fi, a, v) or has_edge(fi, v, b) for fi in g)
            down = any(has_edge(fi, v, a) or has_edge(fi, b, v) for fi in g)
            if up == down:      # isolated sliver between the two path edges: use geometry
                cen = V[F0[g]].mean(1)
                down = np.mean(cen[:, 1] - seam_y(cen[:, 0])) < 0
            if down:
                for fi in g:
                    F[fi][F0[fi] == v] = dup
    return V, F, lower


def build_bag(V, path, lower, rings=5, depth=0.075, height=0.022):
    """Mouth cavity: a closed pouch from the upper rim back to the throat and forward to the
    lower rim. Returns (verts, faces, per-vertex jaw weight, (u, v, side) params).

    Vertex layout: upper half rings 0..rings-1 (ring 0 = copy of the upper rim), lower half rings
    0..rings-1 (ring 0 = copy of the lower rim, corners shared with the upper rim), then a shared
    back ring. Triangles are emitted with both windings."""
    U = V[path]
    L = V[lower]
    m = len(path)
    c = U.mean(0)
    t = np.linspace(0, 1, m)
    arch = np.sin(np.pi * t)                                  # 0 at the corners, 1 mid-mouth
    verts, jaw, prm = [], [], []

    def ring(rim, s, side):
        p = rim.copy()
        shrink = 1 - 0.45 * s
        p[:, 0] = c[0] + (rim[:, 0] - c[0]) * shrink
        p[:, 2] = rim[:, 2] - depth * (s ** 0.85) * (0.55 + 0.45 * arch)
        p[:, 1] = rim[:, 1] + side * height * np.sin(np.pi * s) * (0.35 + 0.65 * arch)
        # converge to the mid line at the back
        p[:, 1] = p[:, 1] * (1 - s ** 3) + c[1] * s ** 3
        return p

    idx = {}
    for side, rim in ((1, U), (-1, L)):
        for j in range(rings):
            s = j / rings
            p = ring(rim, s, side)
            for i in range(m):
                if j == 0 and side == -1 and i in (0, m - 1):
                    idx[(side, j, i)] = idx[(1, 0, i)]           # shared corners
                    continue
                idx[(side, j, i)] = len(verts)
                verts.append(p[i])
                w = 0.5 * s * s if side == 1 else 1 - 0.5 * s * s
                if i in (0, m - 1) and j == 0:
                    w = 0.5
                jaw.append(w)
                prm.append((t[i], s, 1.0 if side == 1 else 0.0))
    back = ring(U, 1.0, 1)
    back[:, 1] = c[1]
    for i in range(m):
        idx[("back", i)] = len(verts)
        verts.append(back[i])
        jaw.append(0.5)
        prm.append((t[i], 1.0, 0.5))

    faces = []

    def quad(a, b, cc, d):
        faces.append((a, b, cc))
        faces.append((a, cc, d))

    for side in (1, -1):
        for j in range(rings):
            for i in range(m - 1):
                a = idx[(side, j, i)]
                b = idx[(side, j, i + 1)]
                if j + 1 < rings:
                    cn, dn = idx[(side, j + 1, i + 1)], idx[(side, j + 1, i)]
                else:
                    cn, dn = idx[("back", i + 1)], idx[("back", i)]
                if side == 1:
                    quad(a, dn, cn, b)
                else:
                    quad(a, b, cn, dn)
    verts = np.array(verts)
    faces = np.array(faces, np.int64)
    # drop degenerate triangles (pinched corners)
    t3 = verts[faces]
    area = np.linalg.norm(np.cross(t3[:, 1] - t3[:, 0], t3[:, 2] - t3[:, 0]), axis=1)
    faces = faces[(area > 1e-12) & (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])]
    # the head is drawn with back-face culling: emit the pouch double-sided so it closes the
    # opening from every viewing angle (it is only ~1-2 % of the triangles)
    faces = np.vstack([faces, faces[:, ::-1]])
    return verts, faces, np.array(jaw), np.array(prm)
