"""Common engine machinery: lazy loading, a per-engine lock and status reporting."""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field

import numpy as np

log = logging.getLogger("lawnmower_voice.engine")

INSTALL_HINT = (
    "Install the voice stack with scripts\\setup-voice.ps1 (Windows) or scripts/setup-voice.sh (Linux)."
)


class EngineUnavailable(RuntimeError):
    """The engine cannot serve requests (not installed, model missing, failed to load) -> HTTP 503."""


class EngineInputError(ValueError):
    """The request is invalid for this engine (unknown voice, ...) -> HTTP 400."""


CUDA_ERROR_MARKERS = (
    "cuda",
    "cublas",
    "cudnn",
    "cudart",
    "nvrtc",
    "kernel image",
    "out of memory",
    "device-side",
    "driver version",
    "invalid device function",
    "ptx",
    "no cuda gpus",
    "gpu",
)


def is_cuda_error(exc: BaseException) -> bool:
    """Heuristic: does this exception come from the CUDA stack (so a CPU retry may help)?"""
    msg = f"{type(exc).__name__}: {exc}".lower()
    return any(m in msg for m in CUDA_ERROR_MARKERS)


@dataclass
class TTSResult:
    audio: np.ndarray  # float32 mono in [-1, 1]
    sample_rate: int
    visemes: list[dict] | None = None
    phonemes: str | None = None
    voice: str = ""
    extra: dict = field(default_factory=dict)


class Engine:
    """Base class: ``ensure_loaded()``/inference run under one lock so GPU work is serialised.

    Subclasses implement ``_load()`` (raise :class:`EngineUnavailable` with a helpful message)
    and use ``self._lock`` around inference.
    """

    kind = "engine"
    backend = "none"
    #: After a failed load, requests get the cached error for this long instead of re-trying
    #: (a retry may mean another multi-second CUDA init or download attempt). /warmup forces one.
    retry_after_sec = 30.0

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._loaded = False
        self._loading = False
        self._error: str | None = None
        self._note: str | None = None
        self._load_ms: float | None = None
        self._failed_at: float | None = None

    # -- lifecycle -------------------------------------------------------------------------

    def _load(self) -> None:  # pragma: no cover - abstract
        raise NotImplementedError

    def ensure_loaded(self, force: bool = False) -> None:
        """Load the engine once. Raises :class:`EngineUnavailable` if it cannot be loaded."""
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            if (
                not force
                and self._failed_at is not None
                and self._error
                and time.monotonic() - self._failed_at < self.retry_after_sec
            ):
                raise EngineUnavailable(self._error)
            self._loading = True
            t0 = time.perf_counter()
            try:
                self._load()
                self._loaded = True
                self._error = None
                self._failed_at = None
                self._load_ms = (time.perf_counter() - t0) * 1000.0
                log.info("%s engine ready (%s) in %.0f ms", self.kind, self.backend, self._load_ms)
            except EngineUnavailable as exc:
                self._error = str(exc)
                self._failed_at = time.monotonic()
                log.error("%s engine unavailable: %s", self.kind, exc)
                raise
            except Exception as exc:  # unexpected: report it, keep the server alive
                self._error = f"{type(exc).__name__}: {exc}"
                self._failed_at = time.monotonic()
                log.exception("%s engine failed to load", self.kind)
                raise EngineUnavailable(self._error) from exc
            finally:
                self._loading = False

    def try_load(self, force: bool = False) -> bool:
        try:
            self.ensure_loaded(force=force)
            return True
        except EngineUnavailable:
            return False

    @property
    def loaded(self) -> bool:
        return self._loaded

    def status(self) -> dict:
        """Status for ``/health``; must not block on the lock."""
        st: dict = {"backend": self.backend, "loaded": self._loaded}
        if self._loading:
            st["loading"] = True
        if self._error:
            st["error"] = self._error
        if self._note:
            st["note"] = self._note
        if self._load_ms is not None:
            st["loadMs"] = round(self._load_ms)
        return st
