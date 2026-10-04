"""Text to speech with Kokoro-82M.

Backends:

* ``onnx`` (primary) - ``kokoro-onnx`` on onnxruntime (``onnxruntime-gpu`` >= 1.27 = CUDA 13 build
  with native RTX 50-series kernels; falls back to the CPU execution provider). With the
  ``model-files-v1.1`` export the model reports per-phoneme durations, so visemes are exact.
* ``torch`` (optional) - the official PyTorch ``kokoro`` package (torch from the cu128 index).
  Per-phoneme timings come from the model's predicted durations.

Both synthesize 24 kHz mono float32; the server encodes 16-bit PCM WAV.
"""

from __future__ import annotations

import contextlib
import importlib.util
import logging
import os
import shutil
import sys
from pathlib import Path
from typing import Any, Callable

import numpy as np

from . import cuda_libs
from .audio import speech_bounds
from .config import VoiceConfig
from .device import DeviceReport, resolve_device
from .engines import INSTALL_HINT, Engine, EngineInputError, EngineUnavailable, TTSResult, is_cuda_error
from .visemes import visemes_from_phonemes, visemes_from_text, visemes_from_timings

log = logging.getLogger("lawnmower_voice.tts")

SAMPLE_RATE = 24000

# --------------------------------------------------------------------------------------------
# Voice catalogue (Kokoro v1.0: 54 voices). id prefix: language letter + gender letter.

KOKORO_V1_VOICES: tuple[str, ...] = (
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova",
    "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
    "am_michael", "am_onyx", "am_puck", "am_santa", "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis", "ef_dora", "em_alex", "em_santa", "ff_siwis",
    "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola", "jf_alpha", "jf_gongitsune",
    "jf_nezumi", "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex", "pm_santa", "zf_xiaobei", "zf_xiaoni",
    "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
)

# prefix letter -> (BCP-47-ish tag reported by /voices, espeak-ng language for kokoro-onnx, KPipeline lang_code)
_LANGS = {
    "a": ("en-us", "en-us", "a"),
    "b": ("en-gb", "en-gb", "b"),
    "e": ("es", "es", "e"),
    "f": ("fr-fr", "fr-fr", "f"),
    "h": ("hi", "hi", "h"),
    "i": ("it", "it", "i"),
    "j": ("ja", "ja", "j"),
    "p": ("pt-br", "pt-br", "p"),
    "z": ("zh", "cmn", "z"),
}


def voice_info(voice_id: str) -> dict:
    """``{id, name, lang, gender}`` for a Kokoro voice id such as ``af_heart``."""
    vid = str(voice_id)
    prefix, _, rest = vid.partition("_")
    lang = _LANGS.get(prefix[:1], ("en-us", "en-us", "a"))[0]
    gender = {"f": "female", "m": "male"}.get(prefix[1:2], "unknown")
    name = (rest or vid).replace("_", " ").title()
    return {"id": vid, "name": name, "lang": lang, "gender": gender}


def espeak_lang(voice_id: str) -> str:
    return _LANGS.get(str(voice_id)[:1], _LANGS["a"])[1]


def pipeline_lang(voice_id: str) -> str:
    return _LANGS.get(str(voice_id)[:1], _LANGS["a"])[2]


def clean_text(text: str) -> str:
    return " ".join(str(text or "").split())


def _clamp_speed(speed: float | None) -> float:
    try:
        s = float(speed if speed is not None else 1.0)
    except (TypeError, ValueError):
        s = 1.0
    if not np.isfinite(s):
        s = 1.0
    return float(min(2.0, max(0.5, s)))


def _silence(duration: float = 0.05) -> np.ndarray:
    return np.zeros(int(SAMPLE_RATE * duration), dtype=np.float32)


def _installed(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


# --------------------------------------------------------------------------------------------
# espeak-ng data path
#
# kokoro-onnx (and misaki's fallback) point espeak-ng at <venv>/.../espeakng_loader/espeak-ng-data.
# The Windows espeak-ng DLL opens that folder with narrow ("ANSI") file APIs (fopen, stat,
# FindFirstFileA) and every build has a fixed-size path buffer: a venv under a profile such as
# C:\Users\José\... or a very long path makes espeak_Initialize fail - and it then calls exit(1),
# killing the whole voice server. So hand espeak a path it can open: the path itself when it is
# short (and ASCII on Windows), else its 8.3 short form, else a one-time copy to an ASCII folder.

#: Longest data path we hand to espeak-ng: its path buffer (N_PATH_HOME) is 230 bytes on Windows
#: and 160 elsewhere (measured with espeakng-loader 0.2.4 on Linux: 158 works, 160 exits), so
#: keep some headroom.
ESPEAK_MAX_PATH = {"win32": 220}
ESPEAK_MAX_PATH_DEFAULT = 150


def espeak_path_ok(path: str, platform: str | None = None) -> bool:
    """Can espeak-ng open this data folder path? (length, and ASCII-only on Windows)"""
    platform = platform or sys.platform
    if len(path.encode("utf-8")) > ESPEAK_MAX_PATH.get(platform, ESPEAK_MAX_PATH_DEFAULT):
        return False
    return path.isascii() if platform == "win32" else True


def _windows_short_path(path: str) -> str | None:  # pragma: no cover - Windows only
    try:
        import ctypes
        from ctypes import wintypes

        fn = ctypes.windll.kernel32.GetShortPathNameW
        fn.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
        fn.restype = wintypes.DWORD
        n = fn(path, None, 0)
        if not n:
            return None
        buf = ctypes.create_unicode_buffer(n)
        return buf.value if fn(path, buf, n) else None
    except Exception:
        return None


def _espeak_copy_roots(platform: str) -> list[Path]:
    """Writable, normally ASCII and short folders for a copy of espeak-ng-data."""
    roots: list[Path] = []
    if platform == "win32":
        for var in ("PROGRAMDATA", "PUBLIC"):
            v = os.environ.get(var)
            if v:
                roots.append(Path(v) / "LawnmowerMan")
        roots.append(Path((os.environ.get("SystemDrive") or "C:") + "\\") / "LawnmowerMan")
    else:
        roots.append(Path.home() / ".cache" / "lawnmower-man")
        roots.append(Path("/tmp") / f"lawnmower-man-{os.getuid() if hasattr(os, 'getuid') else 'user'}")
    return roots


def _tree_signature(src: Path) -> str:
    files = 0
    size = 0
    for p in src.rglob("*"):
        if p.is_file():
            files += 1
            size += p.stat().st_size
    return f"{src}|{files}|{size}"


def safe_espeak_data_path(
    data_path: str,
    platform: str | None = None,
    short_path: Callable[[str], str | None] | None = None,
    roots: list[Path] | None = None,
) -> str:
    """A path to espeak-ng-data that espeak-ng can open (see above); copies it once if needed.

    Returns ``data_path`` unchanged when it is fine, or when no usable alternative exists.
    """
    platform = platform or sys.platform
    if espeak_path_ok(data_path, platform):
        return data_path
    if platform == "win32":
        sp = (short_path or _windows_short_path)(data_path)
        if sp and espeak_path_ok(sp, platform):
            log.info("espeak-ng data: using the short path %s", sp)
            return sp
    src = Path(data_path)
    if not src.is_dir():
        return data_path
    signature = _tree_signature(src)
    for root in roots if roots is not None else _espeak_copy_roots(platform):
        dest = root / "espeak-ng-data"
        if not espeak_path_ok(str(dest), platform):
            continue
        marker = dest / ".lawnmower-source"
        try:
            if marker.is_file() and marker.read_text(encoding="utf-8") == signature:
                return str(dest)
            root.mkdir(parents=True, exist_ok=True)
            tmp = root / f"espeak-ng-data.tmp-{os.getpid()}"
            shutil.rmtree(tmp, ignore_errors=True)
            shutil.copytree(src, tmp)
            (tmp / ".lawnmower-source").write_text(signature, encoding="utf-8")
            shutil.rmtree(dest, ignore_errors=True)
            os.replace(tmp, dest)
            log.info("espeak-ng data: copied to %s (its venv path cannot be opened by espeak-ng)", dest)
            return str(dest)
        except OSError as exc:
            log.debug("espeak-ng data: cannot use %s (%s)", root, exc)
            continue
    log.warning("espeak-ng cannot open its data folder %s (non-ASCII or too long path) and no copy could be made", data_path)
    return data_path


def _espeak_data_override() -> str | None:
    """The espeak-ng data path to force, or None when the default one works."""
    try:
        import espeakng_loader  # noqa: PLC0415

        default = espeakng_loader.get_data_path()
    except Exception:
        return None
    safe = safe_espeak_data_path(default)
    return safe if safe != default else None


def _apply_espeak_data_path(path: str | None) -> None:
    """Point phonemizer's (process-global) espeak wrapper at ``path`` - misaki resets it on import."""
    if not path:
        return
    with contextlib.suppress(Exception):
        from phonemizer.backend.espeak.wrapper import EspeakWrapper  # noqa: PLC0415

        EspeakWrapper.set_data_path(path)


class _TTSBase(Engine):
    kind = "tts"

    def __init__(self, config: VoiceConfig, report: DeviceReport) -> None:
        super().__init__()
        self.config = config
        self.report = report
        self.device = resolve_device(config.device, report)
        self._voices: list[str] = []

    def voices(self) -> list[dict]:
        ids = self._voices or list(KOKORO_V1_VOICES)
        return [voice_info(v) for v in ids]

    def _check_voice(self, voice: str | None) -> str:
        """An explicit unknown voice is a client error; no voice means the (valid) default."""
        known = self._voices or list(KOKORO_V1_VOICES)
        v = (voice or "").strip()
        if not v:
            cfg = (self.config.tts_voice or "").strip()
            v = cfg if cfg in known else ("af_heart" if "af_heart" in known else known[0])
        if v not in known:
            raise EngineInputError(f"unknown voice '{v}'. Available: {', '.join(known[:60])}")
        return v

    def status(self) -> dict:
        st = super().status()
        st.update({"device": self.device, "voices": self._voices or list(KOKORO_V1_VOICES), "defaultVoice": self.config.tts_voice})
        return st


# --------------------------------------------------------------------------------------------
# kokoro-onnx


class KokoroOnnxTTS(_TTSBase):
    backend = "kokoro-onnx"

    def __init__(self, config: VoiceConfig, report: DeviceReport, session_factory=None, kokoro_factory=None) -> None:
        """``session_factory(model_path, device) -> (session, active_device)`` and
        ``kokoro_factory(session, model_path, voices_path) -> Kokoro`` are injectable for tests."""
        super().__init__(config, report)
        self._session_factory = session_factory
        self._kokoro_factory = kokoro_factory
        self._kokoro: Any = None
        self._g2p: dict[str, Any] = {}
        self._misaki_ok: bool | None = None
        #: espeak-ng data path forced because the default one cannot be opened (None = default)
        self._espeak_data: str | None = None

    # -- loading ---------------------------------------------------------------------------

    def _ensure_files(self) -> tuple[Path, Path]:
        model, voices = self.config.kokoro_model_path(), self.config.kokoro_voices_path()
        missing = [p for p in (model, voices) if not p.is_file()]
        if missing and self.config.allow_download:
            from .download import download_kokoro  # noqa: PLC0415

            try:
                download_kokoro(self.config, quiet=True)
            except Exception as exc:
                raise EngineUnavailable(f"could not download the Kokoro model files: {exc}") from exc
            missing = [p for p in (model, voices) if not p.is_file()]
        if missing:
            raise EngineUnavailable(
                "Kokoro model files are missing: " + ", ".join(str(p) for p in missing) + ". Run the setup script to download them."
            )
        return model, voices

    def _make_session(self, model_path: Path, device: str):
        if self._session_factory is not None:
            return self._session_factory(model_path, device)
        with contextlib.redirect_stdout(sys.stderr):
            import onnxruntime as ort  # noqa: PLC0415

        so = ort.SessionOptions()
        so.log_severity_level = 3
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        providers: list = []
        if device == "cuda" and "CUDAExecutionProvider" in ort.get_available_providers():
            providers.append(
                (
                    "CUDAExecutionProvider",
                    {
                        "device_id": 0,
                        "arena_extend_strategy": "kSameAsRequested",
                        # EXHAUSTIVE (the default) benchmarks conv algorithms for every new input
                        # length - Kokoro's lengths vary per sentence, so that costs seconds.
                        "cudnn_conv_algo_search": "HEURISTIC",
                        "gpu_mem_limit": int(max(256, self.config.tts_gpu_mem_limit_mb)) * 1024 * 1024,
                    },
                )
            )
        else:
            so.intra_op_num_threads = max(1, min(8, os.cpu_count() or 4))
        providers.append("CPUExecutionProvider")
        sess = ort.InferenceSession(str(model_path), sess_options=so, providers=providers)
        active = sess.get_providers()
        return sess, ("cuda" if active and active[0] == "CUDAExecutionProvider" else "cpu")

    def _make_kokoro(self, session, model_path: Path, voices_path: Path):
        if self._kokoro_factory is not None:
            return self._kokoro_factory(session, model_path, voices_path)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                from kokoro_onnx import Kokoro  # noqa: PLC0415
        except ImportError as exc:
            raise EngineUnavailable(f"kokoro-onnx is not installed ({exc}). {INSTALL_HINT}") from exc
        # phonemizer (re)configures its logger on import and then warns "words count mismatch"
        # for most sentences with punctuation; it is harmless.
        if not log.isEnabledFor(logging.DEBUG):
            logging.getLogger("phonemizer").setLevel(logging.ERROR)
        kwargs: dict = {}
        self._espeak_data = _espeak_data_override()
        if self._espeak_data:
            try:
                from kokoro_onnx.config import EspeakConfig  # noqa: PLC0415

                kwargs["espeak_config"] = EspeakConfig(data_path=self._espeak_data)
            except ImportError:  # very old kokoro-onnx: set the global path instead
                _apply_espeak_data_path(self._espeak_data)
        if hasattr(Kokoro, "from_session"):
            return Kokoro.from_session(session, str(voices_path), **kwargs)
        return Kokoro(str(model_path), str(voices_path), **kwargs)  # older kokoro-onnx: picks providers itself

    def _load(self) -> None:
        if self._kokoro_factory is None and not _installed("kokoro_onnx"):
            raise EngineUnavailable(f"kokoro-onnx is not installed. {INSTALL_HINT}")
        if self._session_factory is None and not _installed("onnxruntime"):
            raise EngineUnavailable(f"onnxruntime is not installed. {INSTALL_HINT}")
        model_path, voices_path = self._ensure_files()
        want = self.device
        if want == "cuda":
            cuda_libs.prepare()
        errors: list[str] = []
        for device in ([want, "cpu"] if want == "cuda" else ["cpu"]):
            try:
                session, active = self._make_session(model_path, device)
                kokoro = self._make_kokoro(session, model_path, voices_path)
                self._kokoro = kokoro
                self._voices = list(kokoro.get_voices()) if hasattr(kokoro, "get_voices") else list(KOKORO_V1_VOICES)
                self.device = active
                if device == "cuda" and active != "cuda":
                    errors.append("onnxruntime could not enable the CUDA execution provider (see /health device warnings)")
                # Warm-up: first CUDA run initialises cuDNN/cuBLAS and kernels.
                self._synthesize(self._default_voice(), "Hello.", 1.0)
                break
            except EngineUnavailable:
                raise
            except Exception as exc:
                errors.append(f"{device}: {type(exc).__name__}: {exc}")
                log.warning("Kokoro on %s failed: %s", device, exc)
                self._kokoro = None
                continue
        if self._kokoro is None:
            raise EngineUnavailable("Kokoro TTS could not start: " + " | ".join(errors))
        if want == "cuda" and self.device != "cuda":
            self._note = "running on CPU: " + (errors[-1] if errors else "CUDA unavailable")
        if self.config.tts_voice not in self._voices:
            log.warning("default voice %s is not in the voices file; using %s", self.config.tts_voice, self._default_voice())

    def _default_voice(self) -> str:
        if self.config.tts_voice in self._voices:
            return self.config.tts_voice
        return "af_heart" if "af_heart" in self._voices else (self._voices[0] if self._voices else "af_heart")

    # -- G2P -------------------------------------------------------------------------------

    def _misaki(self, lang: str):
        """misaki G2P for English when installed (Kokoro's training G2P), else ``None``."""
        if self.config.tts_g2p == "espeak" or lang not in ("en-us", "en-gb"):
            return None
        if self._misaki_ok is False:
            return None
        if lang in self._g2p:
            return self._g2p[lang]
        try:
            from misaki import en, espeak  # noqa: PLC0415

            # misaki's espeak module resets the global espeak data path on import
            _apply_espeak_data_path(self._espeak_data)
            british = lang == "en-gb"
            g2p = en.G2P(trf=False, british=british, fallback=espeak.EspeakFallback(british=british))
            self._g2p[lang] = g2p
            self._misaki_ok = True
            return g2p
        except Exception as exc:
            if self.config.tts_g2p == "misaki":
                log.warning("misaki G2P unavailable (%s); using espeak-ng", exc)
            self._misaki_ok = False
            return None

    # -- synthesis -------------------------------------------------------------------------

    def _synthesize(self, voice: str, text: str, speed: float) -> TTSResult:
        k = self._kokoro
        lang = espeak_lang(voice)
        g2p = self._misaki(lang)
        phonemes: str | None = None
        if g2p is not None:
            phonemes, _tokens = g2p(text)
            src, is_ph = phonemes, True
        else:
            src, is_ph = text, False
        timings: list = []
        try:
            if hasattr(k, "create_timed"):
                audio, sr, timings = k.create_timed(src, voice=voice, speed=speed, lang=lang, is_phonemes=is_ph)
            else:
                audio, sr = k.create(src, voice=voice, speed=speed, lang=lang, is_phonemes=is_ph)
        except ValueError as exc:
            msg = str(exc)
            if "Nothing to synthesize" in msg or "No phonemes" in msg or "produced no phonemes" in msg:
                audio = _silence()
                return TTSResult(audio, SAMPLE_RATE, [{"start": 0.0, "end": round(len(audio) / SAMPLE_RATE, 3), "viseme": "sil"}], "", voice)
            raise
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)
        duration = len(audio) / float(sr)
        if timings:
            visemes = visemes_from_timings(timings, duration)
            if phonemes is None:
                phonemes = "".join(getattr(t, "phoneme", "") for t in timings)
        else:
            if phonemes is None:
                tok = getattr(k, "tokenizer", None)
                with contextlib.suppress(Exception):
                    phonemes = tok.phonemize(text, lang) if tok is not None else None
            s, e = speech_bounds(audio, sr)
            visemes = visemes_from_phonemes(phonemes, duration, s, e) if phonemes else visemes_from_text(text, duration, s, e)
        return TTSResult(audio, int(sr), visemes, phonemes, voice)

    def synthesize(self, text: str, voice: str | None = None, speed: float | None = None) -> TTSResult:
        text = clean_text(text)
        with self._lock:
            self.ensure_loaded()
            v = self._check_voice(voice)
            sp = _clamp_speed(speed if speed is not None else 1.0)
            if not text:
                audio = _silence()
                return TTSResult(audio, SAMPLE_RATE, [{"start": 0.0, "end": 0.05, "viseme": "sil"}], "", v)
            try:
                return self._synthesize(v, text, sp)
            except EngineInputError:
                raise
            except Exception as exc:
                if self.device != "cuda" or not is_cuda_error(exc):
                    raise
                log.warning("Kokoro CUDA inference failed (%s); switching to CPU", exc)
                model_path, voices_path = self._ensure_files()
                session, active = self._make_session(model_path, "cpu")
                self._kokoro = self._make_kokoro(session, model_path, voices_path)
                self.device = active
                self._note = f"switched to CPU after a CUDA error: {exc}"
                return self._synthesize(v, text, sp)


# --------------------------------------------------------------------------------------------
# PyTorch kokoro (optional)


class KokoroTorchTTS(_TTSBase):
    backend = "kokoro-torch"
    repo_id = "hexgrad/Kokoro-82M"

    def __init__(self, config: VoiceConfig, report: DeviceReport) -> None:
        super().__init__(config, report)
        self._model: Any = None
        self._pipelines: dict[str, Any] = {}
        self._voice_files: dict[str, str] = {}
        self._torch: Any = None

    def _hf(self, filename: str) -> str:
        from huggingface_hub import hf_hub_download  # noqa: PLC0415

        cache = str(Path(self.config.models_dir) / "hf")
        try:
            return hf_hub_download(self.repo_id, filename, cache_dir=cache, local_files_only=True)
        except Exception:
            if not self.config.allow_download:
                raise EngineUnavailable(f"{self.repo_id}/{filename} is not downloaded and downloads are disabled")
            return hf_hub_download(self.repo_id, filename, cache_dir=cache)

    def _load(self) -> None:
        if not _installed("kokoro") or not _installed("torch"):
            raise EngineUnavailable(
                "the PyTorch Kokoro backend needs 'torch' (CUDA 12.8 build) and 'kokoro'. "
                "Run the setup script with -TorchTts / --torch-tts, or use --tts-backend onnx."
            )
        with contextlib.redirect_stdout(sys.stderr):
            import torch  # noqa: PLC0415
            from kokoro import KModel  # noqa: PLC0415
        self._torch = torch
        dev = "cuda" if self.device == "cuda" and torch.cuda.is_available() else "cpu"
        if self.device == "cuda" and dev == "cpu":
            self._note = "torch.cuda is not available; running on CPU"
        config_path = self._hf("config.json")
        weights = self._hf("kokoro-v1_0.pth")
        model = KModel(repo_id=self.repo_id, config=config_path, model=weights).eval()
        try:
            model = model.to(dev)
            self._model = model
            self.device = dev
            self._voices = list(KOKORO_V1_VOICES)
            self._synthesize(self.config.tts_voice if self.config.tts_voice in KOKORO_V1_VOICES else "af_heart", "Hello.", 1.0)
        except Exception as exc:
            if dev != "cuda":
                raise
            log.warning("Kokoro (torch) on CUDA failed (%s); using CPU", exc)
            self._model = model.to("cpu")
            self._pipelines.clear()
            self.device = "cpu"
            self._note = f"running on CPU after a CUDA error: {exc}"
            self._synthesize("af_heart", "Hello.", 1.0)

    def _pipeline(self, voice: str):
        code = pipeline_lang(voice)
        if code not in self._pipelines:
            from kokoro import KPipeline  # noqa: PLC0415

            # kokoro → misaki points espeak-ng at the venv's data folder; make it a safe path
            _apply_espeak_data_path(_espeak_data_override())
            with contextlib.redirect_stdout(sys.stderr):
                self._pipelines[code] = KPipeline(lang_code=code, repo_id=self.repo_id, model=self._model)
        return self._pipelines[code]

    def _voice_path(self, voice: str) -> str:
        if voice not in self._voice_files:
            self._voice_files[voice] = self._hf(f"voices/{voice}.pt")
        return self._voice_files[voice]

    def _synthesize(self, voice: str, text: str, speed: float) -> TTSResult:
        pipe = self._pipeline(voice)
        vocab = getattr(self._model, "vocab", None) or {}
        parts: list[np.ndarray] = []
        timings: list[tuple[str, float, float]] = []
        all_ph: list[str] = []
        offset = 0
        for res in pipe(text, voice=self._voice_path(voice), speed=speed, split_pattern=r"\n+"):
            audio = getattr(res, "audio", None)
            if audio is None:
                continue
            a = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
            a = np.asarray(a, dtype=np.float32).reshape(-1)
            ps = getattr(res, "phonemes", "") or ""
            all_ph.append(ps)
            dur = getattr(res, "pred_dur", None)
            if dur is not None and len(a):
                d = dur.detach().cpu().numpy() if hasattr(dur, "detach") else np.asarray(dur)
                known = [p for p in ps if p in vocab] if vocab else list(ps)
                timings += phoneme_timings(known, np.asarray(d).reshape(-1), len(a), SAMPLE_RATE, offset)
            parts.append(a)
            offset += len(a)
        audio = np.concatenate(parts) if parts else _silence()
        duration = len(audio) / SAMPLE_RATE
        phonemes = " ".join(all_ph)
        if timings:
            vis = visemes_from_timings(timings, duration)
        else:
            s, e = speech_bounds(audio, SAMPLE_RATE)
            vis = visemes_from_phonemes(phonemes, duration, s, e)
        return TTSResult(audio, SAMPLE_RATE, vis, phonemes, voice)

    def synthesize(self, text: str, voice: str | None = None, speed: float | None = None) -> TTSResult:
        text = clean_text(text)
        with self._lock:
            self.ensure_loaded()
            v = self._check_voice(voice)
            if not text:
                audio = _silence()
                return TTSResult(audio, SAMPLE_RATE, [{"start": 0.0, "end": 0.05, "viseme": "sil"}], "", v)
            return self._synthesize(v, text, _clamp_speed(speed))


def phoneme_timings(phonemes: list[str], durations: np.ndarray, n_samples: int, sample_rate: int, offset: int = 0) -> list[tuple[str, float, float]]:
    """Per-phoneme ``(phoneme, start, end)`` from Kokoro's predicted durations.

    ``durations`` covers ``[pad, *phonemes, pad]``; frame counts are scaled to the real audio
    length (the same approach kokoro-onnx uses).
    """
    d = np.asarray(durations, dtype=np.float64).reshape(-1)
    if len(d) < 2 or n_samples <= 0 or d.sum() <= 0:
        return []
    edges = np.concatenate([[0.0], np.cumsum(d)])
    edges = edges * (n_samples / edges[-1])
    out = []
    for i, ph in enumerate(phonemes):
        j = i + 1  # skip the leading pad token
        if j + 1 >= len(edges):
            break
        out.append((ph, (offset + edges[j]) / sample_rate, (offset + edges[j + 1]) / sample_rate))
    return out


def create_tts(config: VoiceConfig, report: DeviceReport) -> _TTSBase:
    """Pick the TTS backend: ``onnx`` | ``torch`` | ``auto`` (onnx if installed, else torch if installed, else onnx)."""
    b = (config.tts_backend or "auto").lower()
    if b == "torch":
        return KokoroTorchTTS(config, report)
    if b == "onnx":
        return KokoroOnnxTTS(config, report)
    if not _installed("kokoro_onnx") and _installed("kokoro") and _installed("torch"):
        return KokoroTorchTTS(config, report)
    return KokoroOnnxTTS(config, report)


__all__ = [
    "KOKORO_V1_VOICES",
    "KokoroOnnxTTS",
    "KokoroTorchTTS",
    "SAMPLE_RATE",
    "create_tts",
    "espeak_lang",
    "phoneme_timings",
    "voice_info",
]

