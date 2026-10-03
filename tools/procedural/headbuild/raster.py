"""Tiny software rasterizer (OpenCV painter's algorithm) for landmark detection and previews.

Good enough for a single closed head seen from the front: triangles are sorted back to front
and filled with flat Lambert shading. Not a general renderer.
"""

from __future__ import annotations

import cv2
import numpy as np


class OrthoView:
    """Orthographic front view: maps mesh xy into an image of `size` pixels."""

    def __init__(self, vertices: np.ndarray, size: int = 1024, margin: float = 0.05,
                 center=None, extent: float | None = None):
        lo, hi = vertices.min(0), vertices.max(0)
        self.center = np.asarray(center if center is not None else (lo + hi) / 2, float)
        ext = extent if extent is not None else max(hi[0] - lo[0], hi[1] - lo[1])
        self.size = size
        self.scale = size * (1 - 2 * margin) / ext

    def to_px(self, v: np.ndarray) -> np.ndarray:
        v = np.atleast_2d(v)
        return np.stack([(v[:, 0] - self.center[0]) * self.scale + self.size / 2,
                         self.size / 2 - (v[:, 1] - self.center[1]) * self.scale], 1)

    def from_px(self, p: np.ndarray) -> np.ndarray:
        p = np.atleast_2d(p)
        return np.stack([(p[:, 0] - self.size / 2) / self.scale + self.center[0],
                         (self.size / 2 - p[:, 1]) / self.scale + self.center[1]], 1)


class ScreenView:
    """The app camera: perspective, looking down -z from (0, 0, dist); the z = 0 plane is
    1 world unit tall on screen. Images are `width` x `height` px like the reference plate."""

    def __init__(self, dist: float, width: int = 784, height: int = 1168):
        self.dist = float(dist)
        self.width = width
        self.height = height
        self.size = height  # for render_* helpers (square buffer cropped later)

    def project(self, v: np.ndarray) -> np.ndarray:
        """World -> screen-plane world units (x, y at z = 0)."""
        v = np.atleast_2d(v)
        k = self.dist / (self.dist - v[:, 2])
        return np.stack([v[:, 0] * k, v[:, 1] * k], 1)

    def unproject(self, s: np.ndarray, z: np.ndarray) -> np.ndarray:
        """Screen-plane xy + depth z -> world xy."""
        s = np.atleast_2d(s)
        k = (self.dist - np.asarray(z, float)) / self.dist
        return s * np.reshape(k, (-1, 1))

    def to_px(self, v: np.ndarray) -> np.ndarray:
        s = self.project(v)
        return np.stack([s[:, 0] * self.height + self.width / 2, self.height / 2 - s[:, 1] * self.height], 1)

    def px_to_screen(self, p: np.ndarray) -> np.ndarray:
        p = np.atleast_2d(p)
        return np.stack([(p[:, 0] - self.width / 2) / self.height, (self.height / 2 - p[:, 1]) / self.height], 1)

    def ray(self, screen_xy: np.ndarray):
        """Origins / directions of the camera rays through screen-plane points."""
        s = np.atleast_2d(screen_xy)
        o = np.tile([0.0, 0.0, self.dist], (len(s), 1))
        d = np.concatenate([s, np.full((len(s), 1), -self.dist)], 1)
        return o, d / np.linalg.norm(d, axis=1, keepdims=True)


def render_view(V, F, view, light=(0.0, 0.3, 1.0), ambient=0.1, colors=None):
    """render_shaded for any view with to_px (crops ScreenView renders to width x height)."""
    img = render_shaded(V, F, view, light, ambient, colors)
    w = getattr(view, "width", view.size)
    return img[:, :w].copy() if w <= img.shape[1] else img


def face_normals(V: np.ndarray, F: np.ndarray) -> np.ndarray:
    t = V[F]
    n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    return n / (np.linalg.norm(n, axis=1, keepdims=True) + 1e-20)


def render_shaded(V: np.ndarray, F: np.ndarray, view: OrthoView, light=(0.0, 0.3, 1.0),
                  ambient: float = 0.1, colors: np.ndarray | None = None) -> np.ndarray:
    """Flat-shaded grey render (BGR uint8). `colors` (per face, 0..1 grey or BGR) overrides."""
    size = view.size
    img = np.zeros((size, size, 3), np.uint8)
    n = face_normals(V, F)
    L = np.asarray(light, float)
    L /= np.linalg.norm(L)
    shade = np.clip(n @ L, 0, 1) * (1 - ambient) + ambient
    P = view.to_px(V)
    cen = V[F].mean(1)
    if hasattr(view, "dist"):   # perspective: cull against the ray to the camera
        facing = np.einsum("ij,ij->i", n, np.array([0, 0, view.dist]) - cen) > 0
    else:
        facing = n[:, 2] > 0
    order = np.argsort(cen[:, 2])
    for i in order:
        if not facing[i]:
            continue
        pts = np.round(P[F[i]] * 16).astype(np.int32)
        if colors is None:
            g = int(shade[i] * 255)
            c = (g, g, g)
        else:
            c = colors[i]
            c = tuple(int(x * 255) for x in (np.broadcast_to(c, 3) * shade[i]))
        cv2.fillConvexPoly(img, pts, c, lineType=cv2.LINE_AA, shift=4)
    return img


def render_mask(V: np.ndarray, F: np.ndarray, view: OrthoView) -> np.ndarray:
    """Binary silhouette (uint8 0/255) of all triangles."""
    size = view.size
    img = np.zeros((size, size), np.uint8)
    P = np.round(view.to_px(V) * 16).astype(np.int32)
    for f in F:
        cv2.fillConvexPoly(img, P[f], 255, lineType=cv2.LINE_8, shift=4)
    return img
