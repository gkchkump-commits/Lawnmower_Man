"""MediaPipe face landmarks (478 points) with an on-disk cache.

MediaPipe is only needed when the cache is missing or stale: the committed cache
(tools/procedural/data/landmarks.json) lets the build run without it.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

# Landmark indices (MediaPipe face mesh topology) used throughout the pipeline.
LM = {
    # eyes: outer / inner corners, upper / lower lid midpoints. "L" = SCREEN left (subject's right)
    "eyeL_out": 33, "eyeL_in": 133, "eyeL_top": 159, "eyeL_bot": 145,
    "eyeR_in": 362, "eyeR_out": 263, "eyeR_top": 386, "eyeR_bot": 374,
    "browL": [70, 63, 105, 66, 107], "browR": [336, 296, 334, 293, 300],
    "noseTip": 1, "noseBridge": 6, "subnasale": 2, "alaL": 98, "alaR": 327, "alaOutL": 129, "alaOutR": 358,
    "mouthL": 61, "mouthR": 291, "lipTop": 0, "lipUpperInner": 13, "lipLowerInner": 14, "lipBottom": 17,
    "chin": 152, "forehead": 10,
}
# Inner lip contour, corner to corner (upper and lower), and the outer lip contour.
LIP_INNER_UPPER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]
LIP_INNER_LOWER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
LIP_OUTER_UPPER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291]
LIP_OUTER_LOWER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291]
# lower face oval (jaw line), screen-left jaw angle -> chin -> screen-right jaw angle
JAW_OVAL = [132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361]
EYE_L_UPPER = [33, 246, 161, 160, 159, 158, 157, 173, 133]
EYE_L_LOWER = [33, 7, 163, 144, 145, 153, 154, 155, 133]
EYE_R_UPPER = [362, 398, 384, 385, 386, 387, 388, 466, 263]
EYE_R_LOWER = [362, 382, 381, 380, 374, 373, 390, 249, 263]


def _digest(img: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(img).tobytes()).hexdigest()[:16]


class LandmarkCache:
    """JSON cache: {key: {"digest": str, "size": [w,h], "points": [[x,y,z], ...]}}."""

    def __init__(self, path: Path, model: Path | None):
        self.path = Path(path)
        self.model = Path(model) if model else None
        self.data = json.loads(self.path.read_text()) if self.path.exists() else {}
        self._det = None
        self.dirty = False

    def _detector(self):
        if self._det is None:
            if not self.model or not self.model.exists():
                raise RuntimeError(
                    "landmark cache miss and no MediaPipe model: pass --landmarker <face_landmarker.task> "
                    "(https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task)")
            # imported lazily: MediaPipe is only needed on a cache miss
            from mediapipe.tasks import python as mpt
            from mediapipe.tasks.python import vision
            opts = vision.FaceLandmarkerOptions(
                base_options=mpt.BaseOptions(model_asset_path=str(self.model),
                                             delegate=mpt.BaseOptions.Delegate.CPU),
                output_face_blendshapes=False, num_faces=1)
            self._det = vision.FaceLandmarker.create_from_options(opts)
        return self._det

    def get(self, key: str, img_bgr: np.ndarray) -> np.ndarray:
        """Landmarks in pixel coordinates (x, y, z*width) for a BGR image."""
        dig = _digest(img_bgr)
        hit = self.data.get(key)
        if hit and hit.get("digest") == dig:
            return np.asarray(hit["points"], float)
        if hit and (not self.model or not self.model.exists()):
            # Same pipeline, slightly different raster (e.g. other OpenCV version): the cached
            # landmarks are still the right correspondences.
            print(f"[landmarks] {key}: image digest changed, using cached landmarks (no MediaPipe model given)")
            return np.asarray(hit["points"], float)
        import mediapipe as mp
        h, w = img_bgr.shape[:2]
        res = self._detector().detect(mp.Image(image_format=mp.ImageFormat.SRGB,
                                               data=cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)))
        if not res.face_landmarks:
            raise RuntimeError(f"MediaPipe found no face in {key}")
        pts = np.array([[p.x * w, p.y * h, p.z * w] for p in res.face_landmarks[0]], float)
        self.data[key] = {"digest": dig, "size": [w, h], "points": np.round(pts, 3).tolist()}
        self.dirty = True
        return pts

    def save(self):
        if self.dirty:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.data, separators=(",", ":")))
            self.dirty = False
