"""Speech to text with faster-whisper (CTranslate2).

Device plan for ``--device auto`` on a CUDA machine (each step only if the previous failed
to load *or* to run its first inference)::

    cuda float16  ->  cuda int8_float16  ->  cpu int8 (with the small CPU model, e.g. base.en)

A failure during a later request that looks like a CUDA error (``no kernel image``,
``CUBLAS_STATUS_*``, out of memory, ...) also moves to the next step and retries once.
"""

from __future__ import annotations

import gc
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np

from . import cuda_libs
from .config import VoiceConfig, cpu_model_for
from .device import DeviceReport, resolve_device
from .engines import INSTALL_HINT, Engine, EngineUnavailable, is_cuda_error

log = logging.getLogger("lawnmower_voice.stt")


class ModelMissing(EngineUnavailable):
    """The Whisper model is neither cached nor downloadable (a smaller fallback model may be)."""

# Phrases Whisper is known to hallucinate on near-silent input.
_HALLUCINATIONS = frozenset(
    s.lower()
    for s in (
        "Thank you.",
        "Thanks for watching!",
        "Thank you for watching.",
        "Thanks for watching.",
        "you",
        "Bye.",
        "Subtitles by the Amara.org community",
    )
)


@dataclass(frozen=True)
class Attempt:
    device: str
    compute_type: str
    model: str

    def label(self) -> str:
        return f"{self.model} on {self.device} ({self.compute_type})"


def _default_cpu_threads() -> int:
    n = os.cpu_count() or 4
    return max(1, min(8, n // 2 if n > 4 else n))


class FasterWhisperSTT(Engine):
    kind = "stt"
    backend = "faster-whisper"

    def __init__(
        self,
        config: VoiceConfig,
        report: DeviceReport,
        model_factory: Callable[..., Any] | None = None,
        resolve_model: Callable[[str], str] | None = None,
    ) -> None:
        """``model_factory(path, device=, compute_type=, cpu_threads=)`` and ``resolve_model(name)``
        are injectable for tests; by default faster-whisper's ``WhisperModel``/``download_model``."""
        super().__init__()
        self.config = config
        self.report = report
        self._factory = model_factory
        self._resolve = resolve_model
        self._model: Any = None
        self._attempts = self.plan()
        self._index = 0
        self._active: Attempt | None = None
        self._failures: list[str] = []

    # -- planning --------------------------------------------------------------------------

    def plan(self) -> list[Attempt]:
        cfg = self.config
        device = resolve_device(cfg.device, self.report)
        cpu_model = cpu_model_for(cfg.stt_model, cfg.stt_cpu_model, cfg.stt_language)
        ct = (cfg.stt_compute_type or "auto").lower()
        attempts: list[Attempt] = []
        if device == "cuda":
            if ct == "auto":
                g = self.report.primary
                small_gpu = bool(g and g.vram_total_mb and g.vram_total_mb < 5000)
                types = ["int8_float16", "int8"] if small_gpu else ["float16", "int8_float16"]
            else:
                types = [ct] + [t for t in ("float16", "int8_float16") if t != ct]
            attempts += [Attempt("cuda", t, cfg.stt_model) for t in types]
        cpu_ct = ct if (device == "cpu" and ct not in ("auto", "float16", "int8_float16", "bfloat16")) else "int8"
        attempts.append(Attempt("cpu", cpu_ct, cpu_model))
        return attempts

    # -- loading ---------------------------------------------------------------------------

    def _resolve_path(self, name: str) -> str:
        if self._resolve is not None:
            return self._resolve(name)
        p = Path(name).expanduser()
        if p.is_dir():
            return str(p)
        try:
            from faster_whisper.utils import download_model  # noqa: PLC0415
        except ImportError as exc:
            raise EngineUnavailable(f"faster-whisper is not installed ({exc}). {INSTALL_HINT}") from exc
        cache = str(self.config.whisper_dir())
        try:
            return download_model(name, local_files_only=True, cache_dir=cache)
        except Exception as local_exc:
            if not self.config.allow_download:
                raise ModelMissing(
                    f"Whisper model '{name}' is not downloaded in {cache} and downloads are disabled. "
                    "Run the setup script (it pre-downloads models) or start without --no-download."
                ) from local_exc
        log.info("downloading Whisper model %s into %s (first run only)", name, cache)
        try:
            return download_model(name, cache_dir=cache)
        except Exception as exc:
            raise ModelMissing(f"could not download Whisper model '{name}': {exc}") from exc

    def _create(self, attempt: Attempt) -> Any:
        if attempt.device == "cuda":
            cuda_libs.prepare()
        path = self._resolve_path(attempt.model)
        threads = self.config.stt_cpu_threads or _default_cpu_threads()
        if self._factory is not None:
            return self._factory(path, device=attempt.device, compute_type=attempt.compute_type, cpu_threads=threads)
        try:
            from faster_whisper import WhisperModel  # noqa: PLC0415
        except ImportError as exc:
            raise EngineUnavailable(f"faster-whisper is not installed ({exc}). {INSTALL_HINT}") from exc
        return WhisperModel(path, device=attempt.device, compute_type=attempt.compute_type, cpu_threads=threads)

    @staticmethod
    def _warmup_audio() -> np.ndarray:
        # 1 s of a quiet vowel-like buzz: the encoder and a few decoder steps run, which
        # triggers cuBLAS loading and (on RTX 50-series) the one-time PTX JIT compile.
        t = np.arange(16000, dtype=np.float32) / 16000.0
        sig = 0.05 * np.sin(2 * np.pi * 220 * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 3 * t))
        return sig.astype(np.float32)

    def _warmup(self, model: Any) -> None:
        segments, _info = model.transcribe(
            self._warmup_audio(),
            language="en",
            beam_size=1,
            vad_filter=False,
            without_timestamps=True,
            condition_on_previous_text=False,
            temperature=0.0,
        )
        for _ in segments:
            pass

    def _free(self) -> None:
        self._model = None
        gc.collect()

    def _load(self) -> None:
        errors: list[str] = []
        while self._index < len(self._attempts):
            attempt = self._attempts[self._index]
            t0 = time.perf_counter()
            try:
                if attempt.device == "cuda":
                    log.info("loading %s (first run on an RTX 50-series GPU JIT-compiles CUDA kernels; this is cached)", attempt.label())
                else:
                    log.info("loading %s", attempt.label())
                model = self._create(attempt)
                self._warmup(model)
            except ModelMissing as exc:
                # A later attempt may use a different (smaller, already cached) model.
                errors.append(f"{attempt.label()}: {exc}")
                self._failures.append(errors[-1])
                later = [i for i in range(self._index + 1, len(self._attempts)) if self._attempts[i].model != attempt.model]
                if not later:
                    raise
                self._index = later[0]
                continue
            except EngineUnavailable:
                raise  # not installed: another device will not help
            except Exception as exc:
                msg = f"{attempt.label()}: {type(exc).__name__}: {exc}"
                log.warning("STT attempt failed - %s", msg)
                errors.append(msg)
                self._failures.append(msg)
                self._free()
                self._index += 1
                continue
            self._model = model
            self._active = attempt
            if self._index > 0 or errors:
                self._note = f"fell back to {attempt.label()} after: {errors[-1] if errors else self._failures[-1]}"
            log.info("STT ready: %s (%.0f ms incl. warm-up)", attempt.label(), (time.perf_counter() - t0) * 1000)
            return
        raise EngineUnavailable("speech recognition could not start: " + " | ".join(errors or self._failures or ["no device"]))

    # -- inference -------------------------------------------------------------------------

    def _beam_size(self) -> int:
        b = int(self.config.stt_beam_size or 0)
        if b <= 0:
            b = 5 if self._active and self._active.device == "cuda" else 1
        return max(1, min(10, b))

    def _language(self, language: str | None) -> str | None:
        lang = (language if language is not None else self.config.stt_language) or ""
        lang = lang.strip().lower()
        if lang in ("", "auto", "detect"):
            return None
        return lang.split("-")[0]  # "en-US" -> "en"

    def _run(self, audio: np.ndarray, language: str | None) -> dict:
        kwargs: dict = dict(
            language=self._language(language),
            beam_size=self._beam_size(),
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
            condition_on_previous_text=False,
            without_timestamps=True,
            temperature=[0.0, 0.2, 0.4, 0.6, 0.8],
        )
        if self.config.stt_initial_prompt:
            kwargs["initial_prompt"] = self.config.stt_initial_prompt
        if self.config.stt_hotwords:
            kwargs["hotwords"] = self.config.stt_hotwords
        segments, info = self._model.transcribe(audio, **kwargs)
        parts: list[str] = []
        for seg in segments:
            no_speech = float(getattr(seg, "no_speech_prob", 0.0) or 0.0)
            logprob = float(getattr(seg, "avg_logprob", 0.0) or 0.0)
            if no_speech > 0.6 and logprob < -1.0:
                continue
            t = (getattr(seg, "text", "") or "").strip()
            if t:
                parts.append(t)
        text = " ".join(" ".join(parts).split())
        if text.lower() in _HALLUCINATIONS and float(np.sqrt(np.mean(audio.astype(np.float64) ** 2))) < 0.01:
            text = ""
        return {"text": text, "language": getattr(info, "language", None) or (kwargs["language"] or "")}

    def transcribe(self, audio: np.ndarray, language: str | None = None) -> dict:
        """Transcribe 16 kHz mono float32 audio. Returns ``{text, language}``."""
        with self._lock:
            self.ensure_loaded()
            try:
                return self._run(audio, language)
            except Exception as exc:
                if not (self._active and self._active.device == "cuda" and is_cuda_error(exc)):
                    raise
                msg = f"{self._active.label()} failed during inference: {type(exc).__name__}: {exc}"
                log.warning("%s - falling back", msg)
                self._failures.append(msg)
                self._free()
                self._loaded = False
                self._index += 1
                self.ensure_loaded(force=True)
                return self._run(audio, language)

    def status(self) -> dict:
        st = super().status()
        a = self._active or (self._attempts[self._index] if self._index < len(self._attempts) else self._attempts[-1])
        st.update({"model": a.model, "device": a.device, "computeType": a.compute_type})
        if a.model != self.config.stt_model:
            st["requestedModel"] = self.config.stt_model
        return st
