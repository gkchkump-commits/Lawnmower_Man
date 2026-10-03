"""Basic triangle-mesh operations on (V, F) numpy arrays."""

from __future__ import annotations

import numpy as np
import scipy.sparse as sp
import scipy.sparse.csgraph as csgraph
import trimesh


def load_glb(path) -> tuple[np.ndarray, np.ndarray]:
    """Load a GLB/GLTF/OBJ, flatten the scene and merge duplicate (UV-seam) vertices."""
    s = trimesh.load(str(path))
    m = s.to_geometry() if isinstance(s, trimesh.Scene) else s
    m = trimesh.Trimesh(np.asarray(m.vertices, float), np.asarray(m.faces), process=True)
    V, F = np.asarray(m.vertices, float), np.asarray(m.faces, np.int64)
    # the pipeline relies on counter-clockwise (outward) winding: flip inside-out scans
    t = V[F]
    if np.einsum("ij,ij->i", t[:, 0], np.cross(t[:, 1], t[:, 2])).sum() < 0:
        F = F[:, ::-1].copy()
    return V, F


def compact(V: np.ndarray, F: np.ndarray, keep_faces: np.ndarray):
    """Keep a subset of faces and drop unreferenced vertices. Returns V, F, old->new map."""
    F = F[keep_faces]
    used = np.unique(F)
    remap = -np.ones(len(V), np.int64)
    remap[used] = np.arange(len(used))
    return V[used], remap[F], remap


def largest_component(V, F):
    n = len(V)
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    g = sp.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n))
    _, lab = csgraph.connected_components(g, directed=False)
    face_lab = lab[F[:, 0]]
    best = np.bincount(face_lab).argmax()
    V2, F2, _ = compact(V, F, face_lab == best)
    return V2, F2


def edges_unique(F):
    e = np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1)
    return np.unique(e, axis=0)


def boundary_edges(F):
    e = np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1)
    u, cnt = np.unique(e, axis=0, return_counts=True)
    return u[cnt == 1]


def adjacency(V, F) -> sp.csr_matrix:
    """Symmetric 0/1 vertex adjacency."""
    n = len(V)
    e = edges_unique(F)
    a = sp.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n))
    return (a + a.T).tocsr()


def umbrella(V, F) -> sp.csr_matrix:
    """Row-normalised adjacency: (A @ V) = mean of the neighbours."""
    A = adjacency(V, F)
    d = np.asarray(A.sum(1)).ravel()
    return sp.diags(1.0 / np.maximum(d, 1)) @ A


def vertex_normals(V, F) -> np.ndarray:
    t = V[F]
    fn = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])     # area weighted
    vn = np.zeros_like(V)
    for k in range(3):
        np.add.at(vn, F[:, k], fn)
    return vn / (np.linalg.norm(vn, axis=1, keepdims=True) + 1e-20)


def taubin(V, F, iterations=10, lam=0.5, mu=-0.53, strength=None, fixed=None):
    """Taubin (lambda|mu) smoothing; `strength` (0..1 per vertex) scales the step, `fixed` pins."""
    W = umbrella(V, F)
    s = np.ones(len(V)) if strength is None else np.asarray(strength, float)
    if fixed is not None:
        s = s.copy()
        s[fixed] = 0
    s = s[:, None]
    X = V.copy()
    for _ in range(iterations):
        X = X + lam * s * (W @ X - X)
        X = X + mu * s * (W @ X - X)
    return X


def subdivide_loop(V, F, iterations=1):
    v, f = trimesh.remesh.subdivide_loop(V, F, iterations=iterations)
    return np.asarray(v, float), np.asarray(f, np.int64)


def mean_curvature_proxy(V, F, normals=None) -> np.ndarray:
    """Signed umbrella-Laplacian along the normal: > 0 in valleys / creases, < 0 on ridges."""
    W = umbrella(V, F)
    n = vertex_normals(V, F) if normals is None else normals
    return np.einsum("ij,ij->i", W @ V - V, n)


def smooth_scalar(values, V, F, iterations=5, lam=0.5):
    W = umbrella(V, F)
    x = np.asarray(values, float).copy()
    for _ in range(iterations):
        x = x + lam * (W @ x - x)
    return x


def face_adjacency_dual(F):
    """Pairs of faces sharing an edge, and the shared edge (sorted vertex pair)."""
    m = trimesh.Trimesh(vertices=np.zeros((F.max() + 1, 3)), faces=F, process=False)
    return m.face_adjacency, m.face_adjacency_edges
