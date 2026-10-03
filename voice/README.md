# lawnmower_voice

The local speech server for Lawnmower Man. It uses faster-whisper for speech to text and
Kokoro-82M for text to speech, and serves both over 127.0.0.1 with a bearer token.

The Electron app starts it automatically. To install it:

* **Windows:** `powershell -ExecutionPolicy Bypass -File scripts\setup-voice.ps1`
* **Linux:** `scripts/setup-voice.sh`

Useful commands:

```bash
python -m lawnmower_voice --fake --port 8765 --token dev   # run without models (tests, UI work)
python -m lawnmower_voice.doctor --smoke --human           # environment report and GPU smoke test
python -m pytest -q                                        # tests (engines mocked; no downloads)
```

For the design, the RTX 50-series notes, the VRAM budget and troubleshooting, see
[docs/VOICE.md](../docs/VOICE.md).
