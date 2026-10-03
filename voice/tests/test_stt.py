from __future__ import annotations

import sys
from types import SimpleNamespace

import numpy as np
import pytest

from lawnmower_voice.config import VoiceConfig
from lawnmower_voice.device import DeviceReport, GpuInfo
from lawnmower_voice.engines import EngineUnavailable, is_cuda_error
from lawnmower_voice.stt import Attempt, FasterWhisperSTT, ModelMissing

GPU = DeviceReport(cuda=True, gpus=[GpuInfo(0, "NVIDIA GeForce RTX 5070 Laptop GPU", "12.0", 8151, 7000)], sources=["nvml"])
SMALL_GPU = DeviceReport(cuda=True, gpus=[GpuInfo(0, "GTX 1650", "7.5", 4096, 3500)], sources=["nvml"])
NO_GPU = DeviceReport()


class FakeModel:
    """Mimics faster_whisper.WhisperModel.transcribe (generator of segments + info)."""

    def __init__(self, path, device, compute_type, cpu_threads, fail_on=None, text="hello world"):
        self.path, self.device, self.compute_type, self.cpu_threads = path, device, compute_type, cpu_threads
        self.calls = []
        self.fail_on = fail_on or {}
        self.text = text

    def transcribe(self, audio, **kw):
        self.calls.append(kw)
        n = len(self.calls)
        if n in self.fail_on:
            raise self.fail_on[n]
        segs = [SimpleNamespace(text=f" {self.text} ", no_speech_prob=0.01, avg_logprob=-0.2),
                SimpleNamespace(text=" junk", no_speech_prob=0.9, avg_logprob=-1.5)]
        return iter(segs), SimpleNamespace(language=kw.get("language") or "en")


def make_engine(cfg, report, behaviour=None, resolve=None):
    """behaviour: {(device, compute_type): exception-at-construction | dict(fail_on=...)}"""
    behaviour = behaviour or {}
    created = []

    def factory(path, device, compute_type, cpu_threads):
        b = behaviour.get((device, compute_type))
        if isinstance(b, BaseException):
            raise b
        m = FakeModel(path, device, compute_type, cpu_threads, **(b or {}))
        created.append(m)
        return m

    eng = FasterWhisperSTT(cfg, report, model_factory=factory, resolve_model=resolve or (lambda name: f"/models/{name}"))
    return eng, created


def audio(seconds=1.0):
    t = np.arange(int(16000 * seconds)) / 16000
    return (0.3 * np.sin(2 * np.pi * 300 * t)).astype(np.float32)


def test_plan_auto_with_gpu():
    eng, _ = make_engine(VoiceConfig(token="t"), GPU)
    assert eng.plan() == [Attempt("cuda", "float16", "large-v3-turbo"), Attempt("cuda", "int8_float16", "large-v3-turbo"), Attempt("cpu", "int8", "base.en")]


def test_plan_variants():
    assert FasterWhisperSTT(VoiceConfig(token="t"), NO_GPU).plan() == [Attempt("cpu", "int8", "base.en")]
    assert FasterWhisperSTT(VoiceConfig(token="t", device="cpu", stt_cpu_model="same"), GPU).plan() == [Attempt("cpu", "int8", "large-v3-turbo")]
    assert FasterWhisperSTT(VoiceConfig(token="t"), SMALL_GPU).plan()[0] == Attempt("cuda", "int8_float16", "large-v3-turbo")
    p = FasterWhisperSTT(VoiceConfig(token="t", stt_compute_type="int8_float16"), GPU).plan()
    assert [a.compute_type for a in p] == ["int8_float16", "float16", "int8"]
    # non-English: the CPU fallback uses the multilingual small model
    assert FasterWhisperSTT(VoiceConfig(token="t", stt_language="de"), NO_GPU).plan() == [Attempt("cpu", "int8", "base")]
    # small models stay as they are on the CPU
    assert FasterWhisperSTT(VoiceConfig(token="t", stt_model="small.en"), NO_GPU).plan() == [Attempt("cpu", "int8", "small.en")]
    assert FasterWhisperSTT(VoiceConfig(token="t", device="cpu", stt_compute_type="float32"), NO_GPU).plan() == [Attempt("cpu", "float32", "base.en")]


def test_loads_on_gpu_with_float16_and_warms_up():
    eng, created = make_engine(VoiceConfig(token="t"), GPU)
    out = eng.transcribe(audio(), "en")
    assert out == {"text": "hello world", "language": "en"}
    m = created[0]
    assert (m.device, m.compute_type, m.path) == ("cuda", "float16", "/models/large-v3-turbo")
    warm, real = m.calls
    assert warm["vad_filter"] is False and warm["beam_size"] == 1
    assert real["vad_filter"] is True and real["condition_on_previous_text"] is False
    assert real["beam_size"] == 5 and real["without_timestamps"] is True and real["language"] == "en"
    st = eng.status()
    assert st == {**st, "backend": "faster-whisper", "loaded": True, "model": "large-v3-turbo", "device": "cuda", "computeType": "float16"}
    assert "note" not in st and "error" not in st


def test_falls_back_when_cuda_load_fails():
    no_kernel = RuntimeError("CUDA failed with error no kernel image is available for execution on the device")
    eng, created = make_engine(VoiceConfig(token="t"), GPU, {("cuda", "float16"): no_kernel})
    assert eng.transcribe(audio())["text"] == "hello world"
    assert created[0].compute_type == "int8_float16"
    st = eng.status()
    assert st["computeType"] == "int8_float16" and "no kernel image" in st["note"]


def test_falls_back_to_cpu_when_warmup_fails_on_gpu():
    cublas = RuntimeError("cuBLAS failed with status CUBLAS_STATUS_NOT_SUPPORTED")
    eng, created = make_engine(
        VoiceConfig(token="t"), GPU, {("cuda", "float16"): {"fail_on": {1: cublas}}, ("cuda", "int8_float16"): {"fail_on": {1: cublas}}}
    )
    assert eng.transcribe(audio())["text"] == "hello world"
    assert [(m.device, m.compute_type) for m in created] == [("cuda", "float16"), ("cuda", "int8_float16"), ("cpu", "int8")]
    st = eng.status()
    assert st["device"] == "cpu" and st["model"] == "base.en" and st["requestedModel"] == "large-v3-turbo"
    assert eng._beam_size() == 1


def test_cuda_error_during_inference_moves_to_next_attempt():
    oom = RuntimeError("CUDA failed with error out of memory")
    eng, created = make_engine(VoiceConfig(token="t"), GPU, {("cuda", "float16"): {"fail_on": {2: oom}}})
    assert eng.transcribe(audio())["text"] == "hello world"
    assert [(m.device, m.compute_type) for m in created] == [("cuda", "float16"), ("cuda", "int8_float16")]
    assert "failed during inference" in eng._failures[-1]


def test_non_cuda_errors_propagate():
    eng, _ = make_engine(VoiceConfig(token="t"), GPU, {("cuda", "float16"): {"fail_on": {2: ValueError("bad input shape")}}})
    with pytest.raises(ValueError, match="bad input"):
        eng.transcribe(audio())


def test_all_attempts_fail_gives_engine_unavailable():
    err = RuntimeError("CUDA driver version is insufficient")
    eng, _ = make_engine(VoiceConfig(token="t"), GPU, {("cuda", "float16"): err, ("cuda", "int8_float16"): err, ("cpu", "int8"): OSError("illegal instruction")})
    with pytest.raises(EngineUnavailable, match="could not start"):
        eng.transcribe(audio())
    st = eng.status()
    assert st["loaded"] is False and "illegal instruction" in st["error"]
    # a cached failure is reported immediately without retrying
    with pytest.raises(EngineUnavailable):
        eng.ensure_loaded()


def test_missing_large_model_falls_back_to_cached_small_model():
    def resolve(name):
        if name == "large-v3-turbo":
            raise ModelMissing("Whisper model 'large-v3-turbo' is not downloaded")
        return f"/models/{name}"

    eng, created = make_engine(VoiceConfig(token="t"), GPU, resolve=resolve)
    assert eng.transcribe(audio())["text"] == "hello world"
    assert created[0].device == "cpu" and created[0].path == "/models/base.en"
    assert "not downloaded" in eng.status()["note"]


def test_language_handling():
    eng, created = make_engine(VoiceConfig(token="t", stt_language="en"), NO_GPU)
    eng.transcribe(audio(), "en-US")
    eng.transcribe(audio(), "auto")
    eng.transcribe(audio(), None)
    langs = [c["language"] for c in created[0].calls[1:]]
    assert langs == ["en", None, "en"]


def test_initial_prompt_and_hotwords_are_passed():
    eng, created = make_engine(VoiceConfig(token="t", stt_initial_prompt="Claude, Anthropic", stt_hotwords="Claude"), NO_GPU)
    eng.transcribe(audio())
    kw = created[0].calls[-1]
    assert kw["initial_prompt"] == "Claude, Anthropic" and kw["hotwords"] == "Claude"


def test_hallucination_on_silence_is_dropped():
    eng, _ = make_engine(VoiceConfig(token="t"), NO_GPU, {("cpu", "int8"): {"text": "Thank you."}})
    assert eng.transcribe(np.zeros(16000, np.float32) + 1e-4)["text"] == ""
    assert eng.transcribe(audio())["text"] == "Thank you."  # real speech keeps it


def test_not_installed_message(monkeypatch):
    monkeypatch.setitem(sys.modules, "faster_whisper", None)
    monkeypatch.setitem(sys.modules, "faster_whisper.utils", None)
    eng = FasterWhisperSTT(VoiceConfig(token="t", stt_model="base.en"), NO_GPU)
    with pytest.raises(EngineUnavailable, match="faster-whisper is not installed"):
        eng.ensure_loaded()
    assert "setup-voice" in eng.status()["error"]


def test_is_cuda_error():
    assert is_cuda_error(RuntimeError("cuBLAS failed with status CUBLAS_STATUS_NOT_SUPPORTED"))
    assert is_cuda_error(RuntimeError("CUDA failed with error no kernel image is available"))
    assert is_cuda_error(OSError("Library cublas64_12.dll is not found or cannot be loaded"))
    assert not is_cuda_error(ValueError("invalid literal for int()"))


def test_real_faster_whisper_api_matches_our_calls():
    """When faster-whisper is installed, check the keyword arguments we pass still exist."""
    fw = pytest.importorskip("faster_whisper")
    import inspect

    params = inspect.signature(fw.WhisperModel.transcribe).parameters
    for name in ("language", "beam_size", "vad_filter", "vad_parameters", "condition_on_previous_text", "without_timestamps", "temperature", "initial_prompt", "hotwords"):
        assert name in params, name
    init = inspect.signature(fw.WhisperModel.__init__).parameters
    for name in ("device", "compute_type", "cpu_threads"):
        assert name in init
    from faster_whisper.utils import download_model

    assert {"local_files_only", "cache_dir"} <= set(inspect.signature(download_model).parameters)
