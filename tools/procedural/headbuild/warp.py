"""Smooth landmark-driven warp (Gaussian RBF) of the head toward the reference proportions.

Controls are surface points with a desired xy displacement; each control has its own radius
(features: small, silhouette: large) and an optional "front only" flag so face corrections do
not drag the back of the head along.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class Controls:
    points: list = field(default_factory=list)     # (3,) source positions
    disp: list = field(default_factory=list)       # (3,) displacement
    sigma: list = field(default_factory=list)
    front: list = field(default_factory=list)      # bool: fade out behind the face
    names: list = field(default_factory=list)

    def add(self, p, d, sigma, front=True, name=""):
        self.points.append(np.asarray(p, float))
        d = np.asarray(d, float)
        if d.shape == (2,):
            d = np.array([d[0], d[1], 0.0])
        self.disp.append(d)
        self.sigma.append(float(sigma))
        self.front.append(bool(front))
        self.names.append(name)

    def arrays(self):
        return (np.array(self.points), np.array(self.disp), np.array(self.sigma), np.array(self.front))


def front_weight(z: np.ndarray, z_face: float, z_ear: float) -> np.ndarray:
    """1 on the face, 0 behind the ears (smooth)."""
    t = np.clip((z - z_ear) / max(1e-6, z_face - z_ear), 0, 1)
    return t * t * (3 - 2 * t)


def rbf_warp(V: np.ndarray, ctrl: Controls, z_face: float, z_ear: float, reg: float = 1e-3,
             max_grad: float = 0.6) -> tuple[np.ndarray, dict]:
    """Return warped vertices and diagnostics. Displacements are scaled down if the warp's
    Jacobian would get too steep (fold-over guard)."""
    P, D, S, FR = ctrl.arrays()
    n = len(P)

    def kernel(X):
        d2 = ((X[:, None, :] - P[None, :, :]) ** 2).sum(-1)
        return np.exp(-d2 / (S[None, :] ** 2))

    K = kernel(P)
    W = np.linalg.solve(K + reg * np.eye(n), D)            # (n, 3)

    def field_at(X):
        k = kernel(X)
        fw = front_weight(X[:, 2], z_face, z_ear)
        k = k * np.where(FR[None, :], fw[:, None], 1.0)
        return k @ W

    disp = field_at(V)
    # fold-over guard: estimate the largest displacement gradient along mesh-scale steps
    rng = np.random.default_rng(0)
    probe = V[rng.choice(len(V), size=min(4000, len(V)), replace=False)]
    eps = 0.004
    g = 0.0
    for ax in range(3):
        off = np.zeros(3)
        off[ax] = eps
        g = max(g, float(np.abs(field_at(probe + off) - field_at(probe - off)).max() / (2 * eps)))
    scale = 1.0 if g <= max_grad else max_grad / g
    return V + disp * scale, {"maxGrad": g, "scale": scale, "maxDisp": float(np.abs(disp).max())}
