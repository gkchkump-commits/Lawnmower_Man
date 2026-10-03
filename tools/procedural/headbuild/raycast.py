"""Ray casting helpers (trimesh; uses Embree via `embreex` when installed, else rtree)."""

from __future__ import annotations

import numpy as np
import trimesh


class Caster:
    def __init__(self, V: np.ndarray, F: np.ndarray):
        self.mesh = trimesh.Trimesh(V, F, process=False)

    def first_hit(self, origins: np.ndarray, dirs: np.ndarray):
        """Nearest hit per ray: (points (n,3) NaN where missed, face index (n,) -1 where missed)."""
        origins = np.atleast_2d(origins).astype(float)
        dirs = np.atleast_2d(dirs).astype(float)
        if len(dirs) == 1 and len(origins) > 1:
            dirs = np.repeat(dirs, len(origins), 0)
        pts = np.full((len(origins), 3), np.nan)
        tri = -np.ones(len(origins), np.int64)
        loc, ir, it = self.mesh.ray.intersects_location(origins, dirs, multiple_hits=True)
        if len(ir):
            d = np.einsum("ij,ij->i", loc - origins[ir], dirs[ir])
            order = np.lexsort((d, ir))          # by ray, then distance
            ir, it, loc, d = ir[order], it[order], loc[order], d[order]
            first = np.r_[True, ir[1:] != ir[:-1]]
            pts[ir[first]] = loc[first]
            tri[ir[first]] = it[first]
        return pts, tri

    def any_hit(self, origins: np.ndarray, dirs: np.ndarray) -> np.ndarray:
        return self.mesh.ray.intersects_any(np.atleast_2d(origins), np.atleast_2d(dirs))

    def front(self, xy: np.ndarray, z0: float = 10.0):
        """Orthographic front hits for (x, y) points (ray toward -z)."""
        xy = np.atleast_2d(xy)
        o = np.concatenate([xy, np.full((len(xy), 1), z0)], 1)
        return self.first_hit(o, np.array([[0.0, 0.0, -1.0]]))
