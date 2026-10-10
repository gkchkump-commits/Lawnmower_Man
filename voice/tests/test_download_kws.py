"""The "Hey Jade" wake word's zh-en keyword model (download.py --kws; contract-wake §5.3).

A loopback HTTP server serves a small .tar.bz2 with the real member names; the pins are swapped
for the test archive's hashes. No network.
"""

from __future__ import annotations

import hashlib
import http.server
import io
import json
import tarfile
import threading

import pytest

import lawnmower_voice.download as dl

PREFIX = "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/"
NAMES = {
    PREFIX + "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx": "encoder.int8.onnx",
    PREFIX + "decoder-epoch-13-avg-2-chunk-16-left-64.onnx": "decoder.onnx",
    PREFIX + "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx": "joiner.int8.onnx",
    PREFIX + "tokens.txt": "tokens.txt",
}


def make_archive(contents: dict[str, bytes], extra: dict[str, bytes] | None = None) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:bz2") as tf:
        for name, data in {**contents, **(extra or {})}.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


@pytest.fixture
def kws_server(tmp_path, monkeypatch):
    """Serves the test archive; patches the pins to it. Yields (root, hits, contents, pin)."""
    root = tmp_path / "srv"
    root.mkdir()
    contents = {member: f"{name} test bytes ".encode() * (i + 3) for i, (member, name) in enumerate(NAMES.items())}
    archive = make_archive(contents, extra={PREFIX + "en.phone": b"not installed"})
    (root / dl.KWS_ZHEN["archive"]).write_bytes(archive)
    pin = {
        "archive": dl.KWS_ZHEN["archive"],
        "sha256": hashlib.sha256(archive).hexdigest(),
        "size": len(archive),
        "members": {m: (NAMES[m], hashlib.sha256(d).hexdigest(), len(d)) for m, d in contents.items()},
    }
    monkeypatch.setattr(dl, "KWS_ZHEN", pin)
    hits: list[str] = []

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(root), **k)

        def log_message(self, *a):
            pass

        def do_GET(self):
            hits.append(self.path)
            super().do_GET()

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setenv("LAWNMOWER_VOICE_KWS_URL", f"http://127.0.0.1:{srv.server_address[1]}")
    yield root, hits, contents, pin
    srv.shutdown()


def test_real_pins_match_the_release():
    """The shipped pins (the same as electron/wake/config.js)."""
    assert dl.KWS_ZHEN["sha256"] == "68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6"
    assert dl.KWS_ZHEN["size"] == 32_885_699
    assert sorted(n for n, _, _ in dl.KWS_ZHEN["members"].values()) == ["decoder.onnx", "encoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]
    assert dl.KWS_BASE_URL == "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/"


def test_downloads_verifies_and_installs_the_four_members(kws_server, tmp_path):
    _, hits, contents, _ = kws_server
    models = tmp_path / "models"
    r = dl.download_kws(models, quiet=True)
    d = models / "kws" / "zh-en-3m"
    assert r == {"dir": str(d), "present": True, "downloaded": True}
    assert sorted(p.name for p in d.iterdir()) == ["decoder.onnx", "encoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]
    for member, data in contents.items():
        assert (d / NAMES[member]).read_bytes() == data
    # the archive and temp folders are gone; en.phone was not installed
    assert sorted(p.name for p in (models / "kws").iterdir()) == ["zh-en-3m"]
    assert hits == ["/" + dl.KWS_ZHEN["archive"]]


def test_skips_verified_files(kws_server, tmp_path):
    _, hits, _, _ = kws_server
    models = tmp_path / "models"
    dl.download_kws(models, quiet=True)
    r = dl.download_kws(models, quiet=True)
    assert r["present"] and not r["downloaded"]
    assert len(hits) == 1


def test_archive_hash_mismatch_writes_nothing(kws_server, tmp_path, monkeypatch):
    _, _, _, pin = kws_server
    monkeypatch.setattr(dl, "KWS_ZHEN", {**pin, "sha256": "0" * 64})
    models = tmp_path / "models"
    with pytest.raises(OSError, match="SHA-256 mismatch"):
        dl.download_kws(models, quiet=True)
    assert not (models / "kws" / "zh-en-3m").exists()
    assert list((models / "kws").iterdir()) == []  # no archive, no .part left behind


def test_member_hash_mismatch_writes_nothing(kws_server, tmp_path, monkeypatch):
    _, _, _, pin = kws_server
    members = dict(pin["members"])
    first = next(iter(members))
    name, _, size = members[first]
    members[first] = (name, "f" * 64, size)
    monkeypatch.setattr(dl, "KWS_ZHEN", {**pin, "members": members})
    models = tmp_path / "models"
    with pytest.raises(OSError, match="unexpected"):
        dl.download_kws(models, quiet=True)
    assert not (models / "kws" / "zh-en-3m").exists()


def test_check_reports_and_writes_nothing(kws_server, tmp_path, capsys):
    _, hits, _, _ = kws_server
    models = tmp_path / "models"
    assert dl.main(["--models-dir", str(models), "--kws-only", "--check", "--json"]) == 0
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["kws"]["zh-en-3m"] == {"dir": str(models / "kws" / "zh-en-3m"), "present": False, "downloaded": False}
    assert out["modelsDir"] == str(models)
    assert hits == [] and not (models / "kws").exists()


def test_cli_kws_only_downloads_then_check_sees_it(kws_server, tmp_path, capsys):
    models = tmp_path / "models"
    assert dl.main(["--models-dir", str(models), "--kws-only", "--json"]) == 0
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["ok"] and out["items"] == [] and out["kws"]["zh-en-3m"]["present"] and out["kws"]["zh-en-3m"]["downloaded"]
    assert dl.main(["--models-dir", str(models), "--kws-only", "--check", "--json"]) == 0
    again = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert again["kws"]["zh-en-3m"]["present"] and not again["kws"]["zh-en-3m"]["downloaded"]


def test_cli_kws_only_failure_exits_1(kws_server, tmp_path, capsys, monkeypatch):
    _, _, _, pin = kws_server
    monkeypatch.setattr(dl, "KWS_ZHEN", {**pin, "sha256": "0" * 64})
    assert dl.main(["--models-dir", str(tmp_path / "m"), "--kws-only", "--json"]) == 1
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["ok"] is False and "SHA-256 mismatch" in out["kws"]["zh-en-3m"]["error"]


def test_full_run_includes_kws_by_default_and_a_kws_failure_does_not_fail_it(kws_server, tmp_path, capsys, monkeypatch):
    _, _, _, pin = kws_server
    monkeypatch.setattr(dl, "KWS_ZHEN", {**pin, "sha256": "0" * 64})
    # STT/TTS skipped here (no network); the wake-word model is fetched by default and its failure is a warning
    assert dl.main(["--models-dir", str(tmp_path / "m"), "--skip-stt", "--skip-tts", "--quiet"]) == 0
    captured = capsys.readouterr()
    out = json.loads(captured.out.strip().splitlines()[-1])
    assert out["ok"] is True and out["kws"]["zh-en-3m"]["present"] is False
    assert "WARNING: the wake-word model could not be downloaded" in captured.err


def test_skip_kws_leaves_it_out(tmp_path, capsys):
    assert dl.main(["--models-dir", str(tmp_path / "m"), "--skip-stt", "--skip-tts", "--skip-kws", "--quiet"]) == 0
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert "kws" not in out


def test_kws_flags_are_exclusive():
    with pytest.raises(SystemExit):
        dl.main(["--kws-only", "--skip-kws"])
