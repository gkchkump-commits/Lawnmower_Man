"""Regression tests for the review findings fixed in the voice server (F4, F8, SEC-8, WIN-1/2/4/6/7)."""

from __future__ import annotations

import os
import sys
import types
from pathlib import Path

import pytest

import lawnmower_voice.config as config_mod
from lawnmower_voice import doctor
from lawnmower_voice.__main__ import build_parser, config_from_args
from lawnmower_voice.config import (
    DEFAULT_CORS_ORIGINS,
    MODELS_POINTER_FILE,
    VoiceConfig,
    cpu_model_for,
    is_english,
    is_packaged_layout,
    models_dir_from_pointer,
    prepare_process_env,
)
from lawnmower_voice.engines import Engine
from lawnmower_voice.fake import FakeSTT, FakeTTS
from lawnmower_voice.server import create_app
from lawnmower_voice.stt import FasterWhisperSTT
from lawnmower_voice.device import DeviceReport
from lawnmower_voice import tts as tts_mod

from .conftest import TOKEN, make_client

AUTH = {"Authorization": f"Bearer {TOKEN}"}


# --------------------------------------------------------------------------------------------
# F4: unexpected 500s keep the CORS header (else the renderer only sees "unreachable")


class ExplodingTTS(FakeTTS):
    def synthesize(self, text, voice=None, speed=None):
        raise RuntimeError("misaki exploded")


def test_unexpected_500_carries_cors_and_json(config):
    client = make_client(create_app(config, FakeSTT(config), ExplodingTTS(config)))
    r = client.post("/tts", json={"text": "hi"}, headers={**AUTH, "Origin": "app://lawnmower"})
    assert r.status_code == 500
    assert r.headers["access-control-allow-origin"] == "app://lawnmower"
    assert r.json() == {"error": "internal error: RuntimeError: misaki exploded", "code": "internal"}
    # without an Origin (e.g. the sidecar, curl) Starlette's own 500 handler answers, same body
    from fastapi.testclient import TestClient

    plain = TestClient(create_app(config, FakeSTT(config), ExplodingTTS(config)), base_url="http://127.0.0.1", raise_server_exceptions=False)
    r2 = plain.post("/tts", json={"text": "hi"}, headers=AUTH)
    assert r2.status_code == 500 and r2.json()["code"] == "internal"
    # handled errors still carry the header too
    bad = client.post("/tts", json={"text": 5}, headers={**AUTH, "Origin": "app://lawnmower"})
    assert bad.status_code == 400 and bad.headers["access-control-allow-origin"] == "app://lawnmower"


# --------------------------------------------------------------------------------------------
# SEC-8: the opaque "null" origin is not allowed by default


def test_null_origin_is_rejected_by_default_and_can_be_opted_in(config):
    assert "null" not in DEFAULT_CORS_ORIGINS
    client = make_client(create_app(config, FakeSTT(config), FakeTTS(config)))
    r = client.get("/health", headers={"Origin": "null"})
    assert r.status_code == 403 and "access-control-allow-origin" not in r.headers
    pre = client.options("/tts", headers={"Origin": "null", "Access-Control-Request-Method": "POST", "Access-Control-Request-Private-Network": "true"})
    assert pre.status_code == 403 and "access-control-allow-private-network" not in pre.headers
    # the app's own origin still works
    assert client.get("/health", headers={"Origin": "app://lawnmower"}).status_code == 200
    # explicit opt-in for debugging
    args = build_parser().parse_args(["--cors-origin", "null"])
    cfg, _ = config_from_args(args)
    assert "null" in cfg.cors_origins


# --------------------------------------------------------------------------------------------
# F8: the CPU fallback model follows the user's language; '' / 'auto' mean "detect"


def test_cpu_model_follows_language():
    assert cpu_model_for("large-v3-turbo", "base.en", "en") == "base.en"
    assert cpu_model_for("large-v3-turbo", "base.en", "en-US") == "base.en"
    assert cpu_model_for("large-v3-turbo", "base.en", "de") == "base"
    assert cpu_model_for("large-v3-turbo", "base.en", "auto") == "base"
    assert cpu_model_for("large-v3-turbo", "base.en", "") == "base"
    assert is_english("en_GB") and not is_english("auto") and not is_english(None)


def test_stt_plan_uses_the_language_from_the_sidecar(tmp_path):
    for lang, cpu_model in (("de", "base"), ("en", "base.en"), ("auto", "base")):
        args = build_parser().parse_args(["--device", "cpu", "--stt-language", lang, "--models-dir", str(tmp_path)])
        cfg, _ = config_from_args(args)
        plan = FasterWhisperSTT(cfg, DeviceReport()).plan()
        assert plan[-1].model == cpu_model, lang


def test_sidecar_launch_flags_with_language_and_preload():
    """The exact argv electron/voice-sidecar.js builds now (incl. --stt-language and --preload)."""
    args = build_parser().parse_args([
        "--host", "127.0.0.1", "--port", "5555", "--device", "auto", "--stt-model", "large-v3-turbo",
        "--stt-language", "auto", "--tts-voice", "af_heart", "--preload",
    ])
    assert args.preload is True and args.stt_language == "auto"


# --------------------------------------------------------------------------------------------
# WIN-1 / WIN-6: models folder recorded by the setup script; packaged layout


def test_models_dir_pointer_file(tmp_path, monkeypatch):
    monkeypatch.delenv("LAWNMOWER_VOICE_MODELS", raising=False)
    prefix = tmp_path / "venv"
    prefix.mkdir()
    assert models_dir_from_pointer(prefix) is None
    (prefix / MODELS_POINTER_FILE).write_text('"D:\\AI Models"\n', encoding="utf-8")
    assert models_dir_from_pointer(prefix) == Path("D:\\AI Models")
    # default_models_dir() reads the pointer of the running venv (sys.prefix)
    (prefix / MODELS_POINTER_FILE).write_text(str(tmp_path / "chosen"), encoding="utf-8")
    monkeypatch.setattr(sys, "prefix", str(prefix))
    assert config_mod.default_models_dir() == tmp_path / "chosen"
    # the environment variable still wins
    monkeypatch.setenv("LAWNMOWER_VOICE_MODELS", str(tmp_path / "env"))
    assert config_mod.default_models_dir() == tmp_path / "env"


def test_packaged_layout_keeps_models_out_of_the_install_dir(tmp_path, monkeypatch):
    monkeypatch.delenv("LAWNMOWER_VOICE_MODELS", raising=False)
    monkeypatch.setattr(sys, "prefix", str(tmp_path / "no-pointer"))
    resources = tmp_path / "resources"
    (resources / "voice").mkdir(parents=True)
    assert not is_packaged_layout(resources / "voice")
    (resources / "app.asar").write_bytes(b"")
    assert is_packaged_layout(resources / "voice")
    monkeypatch.setattr(config_mod, "package_root", lambda: resources / "voice")
    monkeypatch.setattr(config_mod, "user_cache_dir", lambda: tmp_path / "per-user")
    assert config_mod.default_models_dir() == tmp_path / "per-user"


# --------------------------------------------------------------------------------------------
# WIN-4: Intel OpenMP duplicate runtime


def test_prepare_process_env_sets_kmp_only_on_windows():
    env: dict = {}
    prepare_process_env("win32", env)
    assert env == {"KMP_DUPLICATE_LIB_OK": "TRUE"}
    env = {"KMP_DUPLICATE_LIB_OK": "FALSE"}
    prepare_process_env("win32", env)
    assert env["KMP_DUPLICATE_LIB_OK"] == "FALSE"  # the user's choice wins
    env = {}
    prepare_process_env("linux", env)
    assert env == {}


# --------------------------------------------------------------------------------------------
# WIN-2: espeak-ng must get a data path it can open


def test_espeak_path_rules():
    assert tts_mod.espeak_path_ok("C:\\Users\\Ada\\voice\\espeak-ng-data", "win32")
    assert not tts_mod.espeak_path_ok("C:\\Users\\José\\voice\\espeak-ng-data", "win32")
    assert tts_mod.espeak_path_ok("/home/josé/voice/espeak-ng-data", "linux")  # UTF-8 bytes work on Linux
    assert not tts_mod.espeak_path_ok("/" + "x" * 200, "linux")


def _fake_data(tmp_path: Path, name: str) -> Path:
    src = tmp_path / name / "espeak-ng-data"
    (src / "voices").mkdir(parents=True)
    (src / "phontab").write_bytes(b"ph")
    (src / "voices" / "en").write_bytes(b"v")
    return src


def test_safe_espeak_path_prefers_the_windows_short_path(tmp_path):
    src = _fake_data(tmp_path, "José")
    out = tts_mod.safe_espeak_data_path(str(src), "win32", short_path=lambda p: "C:\\Users\\JOS~1\\espeak-ng-data", roots=[])
    assert out == "C:\\Users\\JOS~1\\espeak-ng-data"


def test_safe_espeak_path_copies_once_to_an_ascii_folder(tmp_path):
    src = _fake_data(tmp_path, "José")
    root = tmp_path / "ascii"
    out = tts_mod.safe_espeak_data_path(str(src), "win32", short_path=lambda p: None, roots=[root])
    assert out == str(root / "espeak-ng-data")
    assert (root / "espeak-ng-data" / "phontab").read_bytes() == b"ph"
    assert (root / "espeak-ng-data" / "voices" / "en").is_file()
    stamp = (root / "espeak-ng-data" / ".lawnmower-source").stat().st_mtime_ns
    # second start: reused, not copied again
    assert tts_mod.safe_espeak_data_path(str(src), "win32", short_path=lambda p: None, roots=[root]) == out
    assert (root / "espeak-ng-data" / ".lawnmower-source").stat().st_mtime_ns == stamp
    # a good path is used as is
    good = _fake_data(tmp_path, "ok")
    assert tts_mod.safe_espeak_data_path(str(good), "linux", roots=[root]) == str(good)


def test_kokoro_gets_the_safe_espeak_path(monkeypatch, tmp_path):
    seen = {}

    class EspeakConfig:
        def __init__(self, lib_path=None, data_path=None):
            self.data_path = data_path

    class Kokoro:
        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None):
            seen["espeak_config"] = espeak_config
            return cls()

    monkeypatch.setitem(sys.modules, "kokoro_onnx", types.SimpleNamespace(Kokoro=Kokoro))
    monkeypatch.setitem(sys.modules, "kokoro_onnx.config", types.SimpleNamespace(EspeakConfig=EspeakConfig))
    monkeypatch.setattr(tts_mod, "_espeak_data_override", lambda: "C:\\LawnmowerMan\\espeak-ng-data")
    engine = tts_mod.KokoroOnnxTTS(VoiceConfig(token="t", models_dir=tmp_path), DeviceReport())
    engine._make_kokoro(object(), tmp_path / "m.onnx", tmp_path / "v.bin")
    assert seen["espeak_config"].data_path == "C:\\LawnmowerMan\\espeak-ng-data"
    # and no override when the default path works
    monkeypatch.setattr(tts_mod, "_espeak_data_override", lambda: None)
    engine._make_kokoro(object(), tmp_path / "m.onnx", tmp_path / "v.bin")
    assert seen["espeak_config"] is None


# --------------------------------------------------------------------------------------------
# WIN-6 / WIN-2 / WIN-7: doctor


def test_doctor_passes_the_stt_model_to_the_smoke_test(monkeypatch, capsys):
    got = {}

    def fake_collect(smoke=False, device="auto", models_dir=None, stt_model=None):
        got.update(smoke=smoke, stt_model=stt_model, models_dir=models_dir)
        return {"summary": {"warnings": []}}

    monkeypatch.setattr(doctor, "collect", fake_collect)
    assert doctor.main(["--smoke", "--stt-model", "small.en", "--models-dir", "D:\\m"]) == 0
    assert got == {"smoke": True, "stt_model": "small.en", "models_dir": "D:\\m"}


def test_doctor_warns_about_clashing_cudnn_wheels(monkeypatch):
    from importlib import metadata

    installed = {"nvidia-cudnn-cu12", "nvidia-cudnn-cu13"}

    def version(dist):
        if dist in installed:
            return "9.0"
        raise metadata.PackageNotFoundError(dist)

    monkeypatch.setattr(metadata, "version", version)
    assert "nvidia-cudnn-cu12" in (doctor.cudnn_clash() or "")
    installed.discard("nvidia-cudnn-cu12")
    assert doctor.cudnn_clash() is None


def test_doctor_espeak_check(monkeypatch):
    monkeypatch.setitem(sys.modules, "espeakng_loader", types.SimpleNamespace(get_data_path=lambda: "/" + "y" * 300))
    r = doctor.espeak_data_check()
    assert r["ok"] is False and "cannot open" in r["error"]
    monkeypatch.setitem(sys.modules, "espeakng_loader", types.SimpleNamespace(get_data_path=lambda: "/short/espeak-ng-data"))
    assert doctor.espeak_data_check()["ok"] is True


def test_engine_base_still_reports_loading():
    class Slow(Engine):
        kind = "stt"

        def _load(self):
            raise AssertionError("not called")

    e = Slow()
    e._loading = True
    assert e.status()["loading"] is True
