from __future__ import annotations

import http.server
import json
import threading
from pathlib import Path

import numpy as np
import pytest

from lawnmower_voice import config as config_mod
from lawnmower_voice.__main__ import build_parser, config_from_args
from lawnmower_voice.config import VoiceConfig, cpu_model_for
from lawnmower_voice.doctor import collect, tiny_onnx_model
from lawnmower_voice.download import download_file, download_kokoro


@pytest.fixture
def http_files(tmp_path):
    root = tmp_path / "srv"
    root.mkdir()
    hits = []

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(root), **k)

        def log_message(self, *a):
            pass

        def do_GET(self):
            hits.append(self.path)
            super().do_GET()

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield root, f"http://127.0.0.1:{srv.server_address[1]}/", hits
    srv.shutdown()


def test_download_file_atomic_and_skips_existing(http_files, tmp_path):
    root, base, hits = http_files
    (root / "model.bin").write_bytes(b"x" * 5000)
    dest = tmp_path / "out" / "model.bin"
    download_file(base + "model.bin", dest, min_bytes=1000, quiet=True)
    assert dest.read_bytes() == b"x" * 5000 and not (dest.parent / "model.bin.part").exists()
    download_file(base + "model.bin", dest, min_bytes=1000, quiet=True)
    assert hits == ["/model.bin"]  # second call did not download again


def test_download_rejects_short_files(http_files, tmp_path):
    root, base, _ = http_files
    (root / "tiny.bin").write_bytes(b"<html>error</html>")
    dest = tmp_path / "tiny.bin"
    with pytest.raises(OSError, match="too small"):
        download_file(base + "tiny.bin", dest, min_bytes=1000, quiet=True, retries=1)
    assert not dest.exists() and not (tmp_path / "tiny.bin.part").exists()


def test_download_404(http_files, tmp_path):
    _, base, _ = http_files
    with pytest.raises(OSError, match="could not download"):
        download_file(base + "missing.bin", tmp_path / "m.bin", quiet=True, retries=1)


def test_download_kokoro_uses_mirror(http_files, tmp_path, monkeypatch):
    root, base, hits = http_files
    import lawnmower_voice.download as dl

    monkeypatch.setattr(dl, "KOKORO_MIN_SIZES", {"kokoro-v1.0.onnx": 10, "voices-v1.0.bin": 10})
    (root / "kokoro-v1.0.onnx").write_bytes(b"m" * 100)
    (root / "voices-v1.0.bin").write_bytes(b"v" * 100)
    monkeypatch.setenv("LAWNMOWER_VOICE_KOKORO_URL", base.rstrip("/"))
    cfg = VoiceConfig(models_dir=tmp_path / "models")
    paths = download_kokoro(cfg, quiet=True)
    assert [p.name for p in paths] == ["kokoro-v1.0.onnx", "voices-v1.0.bin"]
    assert all(p.parent == tmp_path / "models" / "kokoro" for p in paths)
    assert sorted(hits) == ["/kokoro-v1.0.onnx", "/voices-v1.0.bin"]


def test_cli_defaults_and_token(monkeypatch, tmp_path):
    monkeypatch.delenv("LAWNMOWER_VOICE_TOKEN", raising=False)
    args = build_parser().parse_args(["--models-dir", str(tmp_path)])
    cfg, generated = config_from_args(args)
    assert generated and len(cfg.token) == 48
    assert (cfg.host, cfg.port, cfg.device, cfg.stt_model, cfg.tts_voice) == ("127.0.0.1", 0, "auto", "large-v3-turbo", "af_heart")
    assert cfg.models_dir == tmp_path and cfg.allow_download and not cfg.fake
    monkeypatch.setenv("LAWNMOWER_VOICE_TOKEN", "from-env")
    cfg, generated = config_from_args(build_parser().parse_args([]))
    assert cfg.token == "from-env" and not generated
    cfg, _ = config_from_args(build_parser().parse_args(["--token", "flag", "--device", "cpu", "--stt-model", "small.en", "--tts-voice", "bm_george", "--cors-origin", "http://x:1"]))
    assert cfg.token == "flag" and cfg.device == "cpu" and cfg.stt_model == "small.en" and cfg.tts_voice == "bm_george"
    assert "http://x:1" in cfg.cors_origins and "app://lawnmower" in cfg.cors_origins


def test_sidecar_launch_flags_are_accepted():
    """The exact argv electron/voice-sidecar.js builds must parse."""
    args = build_parser().parse_args(["--host", "127.0.0.1", "--port", "5555", "--device", "auto", "--stt-model", "large-v3-turbo", "--tts-voice", "af_heart", "--token", "abc"])
    assert args.port == 5555


def test_models_dir_resolution(monkeypatch, tmp_path):
    monkeypatch.setenv("LAWNMOWER_VOICE_MODELS", str(tmp_path / "env"))
    assert config_mod.default_models_dir() == tmp_path / "env"
    monkeypatch.delenv("LAWNMOWER_VOICE_MODELS")
    d = config_mod.default_models_dir()
    assert d.name == "models"
    cfg = VoiceConfig(models_dir=tmp_path, tts_model="kokoro-v1.0.fp16.onnx")
    assert cfg.kokoro_model_path() == tmp_path / "kokoro" / "kokoro-v1.0.fp16.onnx"
    abs_model = tmp_path / "custom" / "k.onnx"
    assert VoiceConfig(models_dir=tmp_path, tts_model=str(abs_model)).kokoro_model_path() == abs_model


def test_cpu_model_choice():
    assert cpu_model_for("large-v3-turbo", "base.en", "en") == "base.en"
    assert cpu_model_for("large-v3-turbo", "base.en", "fr") == "base"
    assert cpu_model_for("large-v3-turbo", "same", "en") == "large-v3-turbo"
    assert cpu_model_for("small", "base.en", "en") == "small"


def test_tiny_onnx_model_runs_on_cpu():
    ort = pytest.importorskip("onnxruntime")
    sess = ort.InferenceSession(tiny_onnx_model(), providers=["CPUExecutionProvider"])
    a = np.eye(64, dtype=np.float32)
    b = np.arange(64 * 64, dtype=np.float32).reshape(64, 64)
    x = np.ones((1, 4, 64), np.float32)
    w = np.ones((8, 4, 3), np.float32)
    y, z = sess.run(["Y", "Z"], {"A": a, "B": b, "X": x, "W": w})
    assert np.array_equal(y, b) and z.shape == (1, 8, 62) and np.allclose(z, 12.0)


def test_doctor_collect_runs_without_gpu():
    rep = collect(smoke=False, device="auto")
    json.dumps(rep, default=str)
    assert {"version", "python", "device", "checks", "summary"} <= set(rep)
    assert rep["summary"]["cuda"] in (True, False)


def test_doctor_cli_prints_json(capsys):
    from lawnmower_voice.doctor import main

    assert main(["--device", "cpu"]) == 0
    out = capsys.readouterr().out.strip().splitlines()[-1]
    assert json.loads(out)["version"]


def test_voice_dir_layout_for_sidecar():
    """electron/voice-sidecar.js requires <voiceDir>/lawnmower_voice to exist."""
    voice_dir = Path(__file__).resolve().parent.parent
    assert (voice_dir / "lawnmower_voice" / "__main__.py").is_file()
    assert (voice_dir / "pyproject.toml").is_file()
