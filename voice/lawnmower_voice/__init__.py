"""Lawnmower Man local voice server (contract: docs/ARCHITECTURE.md section 6).

A small FastAPI app that exposes speech-to-text (faster-whisper) and text-to-speech
(Kokoro-82M) to the Electron renderer over 127.0.0.1 with a bearer token.

Importing this package never imports the heavy engines (faster-whisper, CTranslate2,
onnxruntime, kokoro, torch); they are loaded lazily on first use, so the server starts
and reports a clear error even when they are not installed.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
