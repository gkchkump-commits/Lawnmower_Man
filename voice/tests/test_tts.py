from __future__ import annotations

import sys
import types
from dataclasses import dataclass

import numpy as np
import pytest

from lawnmower_voice.config import VoiceConfig
from lawnmower_voice.device import DeviceReport, GpuInfo
from lawnmower_voice.engines import EngineInputError, EngineUnavailable
from lawnmower_voice.tts import (
    KOKORO_V1_VOICES,
    KokoroOnnxTTS,
    KokoroTorchTTS,
    create_tts,
    espeak_lang,
    phoneme_timings,
    voice_info,
)
from lawnmower_voice.visemes import VISEMES, kokoro_audio_lead

GPU = DeviceReport(cuda=True, gpus=[GpuInfo(0, "RTX 5070", "12.0", 8151, 7000)])


@dataclass(frozen=True)
class Timing:
    phoneme: str
    start: float
    end: float


class FakeKokoro:
    """Stands in for kokoro_onnx.Kokoro (create_timed variant)."""

    def __init__(self, timed=True, fail=None):
        self.timed = timed
        self.fail = fail
        self.calls = []
        self.tokenizer = types.SimpleNamespace(phonemize=lambda text, lang: "həlˈoʊ")

    def __getattribute__(self, name):
        # an untimed Kokoro (older kokoro-onnx) has no create_timed at all: hasattr() is False
        if name == "create_timed" and not object.__getattribute__(self, "timed"):
            raise AttributeError(name)
        return object.__getattribute__(self, name)

    def get_voices(self):
        return ["af_heart", "am_michael", "bf_emma"]

    def _audio(self):
        sr = 24000
        t = np.arange(int(0.6 * sr)) / sr
        a = (0.4 * np.sin(2 * np.pi * 180 * t)).astype(np.float32)
        a[: int(0.1 * sr)] = 0
        return a, sr

    def create_timed(self, text, voice, speed, lang, is_phonemes=False):
        self.calls.append((text, voice, speed, lang, is_phonemes))
        if self.fail:
            exc, self.fail = self.fail, None
            raise exc
        a, sr = self._audio()
        return a, sr, [Timing("h", 0.1, 0.18), Timing("ə", 0.18, 0.26), Timing("l", 0.26, 0.33), Timing("ˈ", 0.33, 0.34), Timing("o", 0.34, 0.45), Timing("ʊ", 0.45, 0.55)]

    def create(self, text, voice, speed, lang, is_phonemes=False):
        self.calls.append((text, voice, speed, lang, is_phonemes))
        return self._audio()


def make_tts(tmp_path, kokoro=None, device="auto", report=GPU, sessions=None, **cfg):
    models = tmp_path / "models"
    (models / "kokoro").mkdir(parents=True, exist_ok=True)
    (models / "kokoro" / "kokoro-v1.0.onnx").write_bytes(b"onnx")
    (models / "kokoro" / "voices-v1.0.bin").write_bytes(b"npz")
    config = VoiceConfig(token="t", models_dir=models, allow_download=False, device=device, tts_g2p="espeak", **cfg)
    sessions = sessions if sessions is not None else []
    kokoros = [kokoro or FakeKokoro()]

    def session_factory(path, dev):
        sessions.append(dev)
        return object(), dev

    def kokoro_factory(session, model_path, voices_path):
        return kokoros[-1]

    return KokoroOnnxTTS(config, report, session_factory=session_factory, kokoro_factory=kokoro_factory), sessions, kokoros


def test_voice_catalogue():
    assert len(KOKORO_V1_VOICES) == 54 and len(set(KOKORO_V1_VOICES)) == 54
    assert voice_info("af_heart") == {"id": "af_heart", "name": "Heart", "lang": "en-us", "gender": "female"}
    assert voice_info("bm_george") == {"id": "bm_george", "name": "George", "lang": "en-gb", "gender": "male"}
    assert voice_info("zf_xiaoxiao")["lang"] == "zh"
    assert espeak_lang("bf_emma") == "en-gb" and espeak_lang("zm_yunxi") == "cmn" and espeak_lang("ff_siwis") == "fr-fr"
    for v in ("af_heart", "af_bella", "am_michael", "bf_emma", "bm_george"):
        assert v in KOKORO_V1_VOICES


def test_phoneme_timings_scale_durations_to_audio():
    # pad, a, b, c, pad -> 10 frames total mapped onto 1000 samples
    t = phoneme_timings(["a", "b", "c"], np.array([1, 2, 3, 2, 2]), 1000, 1000)
    assert t == [("a", 0.1, 0.3), ("b", 0.3, 0.6), ("c", 0.6, 0.8)]
    assert phoneme_timings(["a"], np.array([0, 0]), 100, 100) == []
    off = phoneme_timings(["a"], np.array([1, 1, 1]), 300, 100, offset=100)
    assert off == [("a", pytest.approx(2.0), pytest.approx(3.0))]


def test_synthesize_with_timings(tmp_path):
    tts, sessions, kokoros = make_tts(tmp_path)
    res = tts.synthesize("  Hello\n world ", "am_michael", 1.25)
    assert sessions == ["cuda"]
    text, voice, speed, lang, is_ph = kokoros[0].calls[-1]
    assert (text, voice, speed, lang, is_ph) == ("Hello world", "am_michael", 1.25, "en-us", False)
    assert res.sample_rate == 24000 and res.audio.dtype == np.float32
    vis = [s["viseme"] for s in res.visemes]
    assert vis[:5] == ["sil", "kk", "E", "DD", "O"]
    assert res.visemes[-1]["end"] == pytest.approx(0.6)
    # the timeline is moved onto the audio: Kokoro speaks ~50 ms before its durations say ("h" at 0.1)
    assert res.visemes[1]["start"] == pytest.approx(0.1 - kokoro_audio_lead(1.25), abs=0.001)
    st = tts.status()
    assert st["loaded"] and st["device"] == "cuda" and st["voices"] == ["af_heart", "am_michael", "bf_emma"]


def test_synthesize_without_timings_distributes_phonemes(tmp_path):
    tts, _, _ = make_tts(tmp_path, kokoro=FakeKokoro(timed=False))
    res = tts.synthesize("Hello", "af_heart", None)
    assert res.phonemes == "həlˈoʊ"
    assert res.visemes[0]["viseme"] == "sil" and res.visemes[0]["end"] == pytest.approx(0.1, abs=0.02)
    assert all(s["viseme"] in VISEMES for s in res.visemes)


def test_speed_is_clamped_and_voice_checked(tmp_path):
    tts, _, kokoros = make_tts(tmp_path)
    tts.synthesize("Hi", "af_heart", 9.0)
    assert kokoros[0].calls[-1][2] == 2.0
    tts.synthesize("Hi", "af_heart", 0.1)
    assert kokoros[0].calls[-1][2] == 0.5
    with pytest.raises(EngineInputError, match="unknown voice 'nope'"):
        tts.synthesize("Hi", "nope", 1.0)


def test_nothing_to_say_returns_short_silence(tmp_path):
    tts, _, _ = make_tts(tmp_path)
    for text in ("", "   "):
        res = tts.synthesize(text, "af_heart", 1.0)
        assert len(res.audio) == 1200 and not res.audio.any()
        assert res.visemes == [{"start": 0.0, "end": 0.05, "viseme": "sil"}]
    tts2, _, _ = make_tts(tmp_path / "b", kokoro=FakeKokoro(fail=ValueError("Nothing to synthesize, '...' produced no phonemes")))
    res = tts2.synthesize("...", "af_heart", 1.0)  # warm-up consumed the failure? ensure graceful anyway
    assert res.sample_rate == 24000


def test_cuda_failure_during_synthesis_switches_to_cpu(tmp_path):
    k = FakeKokoro()
    tts, sessions, _ = make_tts(tmp_path, kokoro=k)
    tts.ensure_loaded()
    k.fail = RuntimeError("CUDA error cudaErrorNoKernelImageForDevice: no kernel image is available")
    res = tts.synthesize("Hello", "af_heart", 1.0)
    assert sessions == ["cuda", "cpu"]
    assert tts.status()["device"] == "cpu" and "CUDA error" in tts.status()["note"]
    assert res.visemes


def test_cuda_failure_at_load_falls_back_to_cpu(tmp_path):
    k = FakeKokoro(fail=RuntimeError("CUDA failure 209: no kernel image"))
    tts, sessions, _ = make_tts(tmp_path, kokoro=k)
    tts.ensure_loaded()
    assert sessions == ["cuda", "cpu"] and tts.status()["device"] == "cpu"
    assert "running on CPU" in tts.status()["note"]


def test_cpu_only_device(tmp_path):
    tts, sessions, _ = make_tts(tmp_path, device="cpu")
    tts.ensure_loaded()
    assert sessions == ["cpu"]


def test_missing_model_files(tmp_path):
    cfg = VoiceConfig(token="t", models_dir=tmp_path / "empty", allow_download=False)
    tts = KokoroOnnxTTS(cfg, GPU, session_factory=lambda p, d: (object(), d), kokoro_factory=lambda *a: FakeKokoro())
    with pytest.raises(EngineUnavailable, match="Kokoro model files are missing"):
        tts.ensure_loaded()
    assert tts.voices()[0]["id"] == "af_alloy"  # catalogue is available without loading


def test_not_installed(monkeypatch, tmp_path):
    import lawnmower_voice.tts as tts_mod

    monkeypatch.setattr(tts_mod, "_installed", lambda m: False)
    cfg = VoiceConfig(token="t", models_dir=tmp_path, allow_download=False)
    with pytest.raises(EngineUnavailable, match="kokoro-onnx is not installed"):
        KokoroOnnxTTS(cfg, GPU).ensure_loaded()
    assert isinstance(create_tts(cfg, GPU), KokoroOnnxTTS)
    assert isinstance(create_tts(VoiceConfig(token="t", tts_backend="torch"), GPU), KokoroTorchTTS)
    with pytest.raises(EngineUnavailable, match="PyTorch Kokoro backend needs"):
        KokoroTorchTTS(cfg, GPU).ensure_loaded()


# --- real kokoro-onnx with a fake ONNX session --------------------------------------------------


class _Arg:
    def __init__(self, name, type_):
        self.name, self.type = name, type_


class FakeOrtSession:
    """Behaves like an onnxruntime session of the Kokoro v1.0 export with a duration output."""

    _model_path = "fake.onnx"

    def get_inputs(self):
        return [_Arg("input_ids", "tensor(int64)"), _Arg("style", "tensor(float)"), _Arg("speed", "tensor(float)")]

    def get_outputs(self):
        return [_Arg("waveform", "tensor(float)"), _Arg("duration", "tensor(int64)")]

    def get_modelmeta(self):
        return types.SimpleNamespace(custom_metadata_map={})

    def get_providers(self):
        return ["CPUExecutionProvider"]

    def run(self, _names, inputs):
        ids = inputs["input_ids"][0]
        dur = np.full(len(ids), 3, dtype=np.int64)
        audio = []
        for i, tok in enumerate(ids):
            n = int(dur[i]) * 600
            t = np.arange(n) / 24000
            amp = 0.0 if tok == 0 else 0.3
            audio.append((amp * np.sin(2 * np.pi * (150 + tok) * t)).astype(np.float32))
        return [np.concatenate(audio)[None, :], dur]


def test_real_kokoro_onnx_pipeline(tmp_path):
    pytest.importorskip("kokoro_onnx")
    pytest.importorskip("espeakng_loader")
    from kokoro_onnx import Kokoro

    voices = tmp_path / "models" / "kokoro" / "voices-v1.0.bin"
    voices.parent.mkdir(parents=True)
    style = np.random.default_rng(0).standard_normal((510, 1, 256)).astype(np.float32)
    with open(voices, "wb") as fh:
        np.savez(fh, af_heart=style, bm_george=style)
    model = voices.parent / "kokoro-v1.0.onnx"
    model.write_bytes(b"x")
    session = FakeOrtSession()
    session._model_path = str(model)  # kokoro-onnx checks that the model file exists
    cfg = VoiceConfig(token="t", models_dir=tmp_path / "models", allow_download=False, device="cpu", tts_g2p="espeak")
    tts = KokoroOnnxTTS(
        cfg,
        DeviceReport(),
        session_factory=lambda p, d: (session, "cpu"),
        kokoro_factory=lambda s, m, v: Kokoro.from_session(s, str(v)),
    )
    res = tts.synthesize("Hello there, I am Claude.", "af_heart", 1.0)
    assert tts.status()["voices"] == ["af_heart", "bm_george"]
    assert "klˈɔːd" in (res.phonemes or "")
    duration = len(res.audio) / res.sample_rate
    assert res.visemes[-1]["end"] == pytest.approx(duration, abs=1e-3)
    vis = [s["viseme"] for s in res.visemes]
    assert {"kk", "E", "DD", "O", "U", "TH", "RR", "aa", "PP"} <= set(vis)
    assert "sil" in vis[1:-1]  # the comma pause
    res_gb = tts.synthesize("Hello.", "bm_george", 1.0)
    assert "əʊ" in (res_gb.phonemes or "")


# --- PyTorch kokoro backend with stand-in modules ----------------------------------------------


def test_torch_backend_with_fake_modules(monkeypatch, tmp_path):
    import lawnmower_voice.tts as tts_mod

    class FakeTensor:
        def __init__(self, a):
            self.a = np.asarray(a)

        def detach(self):
            return self

        def cpu(self):
            return self

        def numpy(self):
            return self.a

    class KModel:
        vocab = {c: i for i, c in enumerate("həlˈoʊ ")}

        def __init__(self, repo_id, config, model):
            self.args = (repo_id, config, model)

        def eval(self):
            return self

        def to(self, dev):
            self.dev = dev
            return self

    class KPipeline:
        def __init__(self, lang_code, repo_id, model):
            self.lang_code = lang_code

        def __call__(self, text, voice, speed, split_pattern):
            ps = "həlˈoʊ"
            dur = np.array([4] + [4] * len(ps) + [2])  # the leading pad: 0.1 s of silence
            n = int(dur.sum()) * 600
            yield types.SimpleNamespace(audio=FakeTensor(0.3 * np.ones(n, np.float32)), phonemes=ps, pred_dur=FakeTensor(dur))

    fake_torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "kokoro", types.SimpleNamespace(KModel=KModel, KPipeline=KPipeline))
    monkeypatch.setattr(tts_mod, "_installed", lambda m: True)
    monkeypatch.setattr(KokoroTorchTTS, "_hf", lambda self, f: f"/hf/{f}")
    tts = KokoroTorchTTS(VoiceConfig(token="t", models_dir=tmp_path), GPU)
    res = tts.synthesize("Hello", "af_heart", 1.0)
    st = tts.status()
    assert st["device"] == "cpu" and "not available" in st["note"]
    assert [s["viseme"] for s in res.visemes][:4] == ["sil", "kk", "E", "DD"]
    assert res.visemes[1]["start"] == pytest.approx(0.1 - kokoro_audio_lead(1.0), abs=1e-3)
    assert res.visemes[-1]["end"] == pytest.approx(len(res.audio) / 24000, abs=1e-3)


def test_missing_voice_uses_a_valid_default(tmp_path):
    tts, _, kokoros = make_tts(tmp_path, tts_voice="zz_not_in_file")
    res = tts.synthesize("Hi", None, 1.0)
    assert res.voice == "af_heart" and kokoros[0].calls[-1][1] == "af_heart"
    with pytest.raises(EngineInputError):
        tts.synthesize("Hi", "zz_not_in_file", 1.0)  # explicit unknown voice is still an error
