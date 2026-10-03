"""FastAPI application (contract: docs/ARCHITECTURE.md section 6).

=================  =====================================================================
``GET  /health``   no auth. ``{ok, version, device, stt, tts, ...}``
``POST /stt``      WAV body (any rate/channels) or raw float32 mono + ``X-Sample-Rate``;
                   ``?language=`` optional -> ``{text, language, durationSec, processingMs}``
``POST /tts``      JSON ``{text, voice?, speed?}`` -> ``{sampleRate, audioB64, durationSec,
                   processingMs, visemes}`` (``audioB64`` = 16-bit PCM mono WAV)
``GET  /voices``   ``[{id, name, lang, gender}]``
``POST /warmup``   loads both engines -> ``{ok, stt, tts}``
=================  =====================================================================

Every endpoint except ``/health`` requires ``Authorization: Bearer <token>`` (constant-time
comparison). Errors are JSON ``{"error": "...", "code": "..."}``. Blocking work (decoding,
inference) runs in the threadpool; each engine serialises its own GPU work with a lock, and a
per-engine queue limit turns overload into ``503 busy`` instead of an unbounded backlog.
"""

from __future__ import annotations

import base64
import contextlib
import hmac
import json
import logging
import os
import time
from typing import Any, Iterable

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .audio import WHISPER_RATE, AudioError, encode_wav_pcm16, load_for_whisper
from .config import VoiceConfig
from .device import DeviceMonitor, DeviceReport
from .engines import EngineInputError, EngineUnavailable

log = logging.getLogger("lawnmower_voice.server")

LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1", "[::1]")
ALLOWED_HEADERS = ("authorization", "content-type", "x-sample-rate")
ALLOWED_METHODS = ("GET", "POST", "OPTIONS")
MAX_TTS_BODY = 256 * 1024


class ApiError(Exception):
    def __init__(self, status: int, message: str, code: str = "error", headers: dict | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code
        self.headers = headers or {}


def _error(status: int, message: str, code: str, headers: dict | None = None) -> JSONResponse:
    return JSONResponse({"error": message, "code": code}, status_code=status, headers=headers)


# --------------------------------------------------------------------------------------------
# Middleware


class CorsAndHostMiddleware:
    """CORS for the renderer's origins plus a Host-header check against DNS rebinding.

    * Preflight (``OPTIONS`` + ``Access-Control-Request-Method``) from an allowed origin gets
      204 with the allowed methods/headers (and ``Access-Control-Allow-Private-Network`` when
      Chromium asks for it); from any other origin 403.
    * Actual requests from an allowed origin get ``Access-Control-Allow-Origin: <origin>``.
      Requests carrying a disallowed ``Origin`` are rejected with 403 (browsers only; other
      clients send no Origin and are still subject to the bearer token).
    * When bound to loopback, requests whose ``Host`` is not a loopback name are rejected.
    """

    def __init__(self, app, origins: Iterable[str], allowed_hosts: Iterable[str] | None = LOOPBACK_HOSTS, max_age: int = 600) -> None:
        self.app = app
        self.origins = frozenset(origins)
        self.allowed_hosts = frozenset(h.lower() for h in allowed_hosts) if allowed_hosts else None
        self.max_age = max_age

    @staticmethod
    def _host_name(host: str) -> str:
        host = host.strip().lower()
        if host.startswith("["):
            end = host.find("]")
            return host[: end + 1] if end > 0 else host
        return host.rsplit(":", 1)[0] if host.count(":") == 1 else host

    async def _plain(self, send, status: int, body: dict, extra: list[tuple[bytes, bytes]] | None = None) -> None:
        data = json.dumps(body).encode()
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(data)).encode())] + (extra or [])
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": data})

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        if self.allowed_hosts is not None:
            host = self._host_name(headers.get("host", ""))
            if host not in self.allowed_hosts:
                await self._plain(send, 403, {"error": f"host '{host}' not allowed", "code": "bad_host"})
                return
        origin = headers.get("origin")
        if origin is None:
            await self.app(scope, receive, send)
            return
        allowed = origin in self.origins
        vary = [(b"vary", b"Origin")]
        if scope["method"] == "OPTIONS" and "access-control-request-method" in headers:
            if not allowed:
                await self._plain(send, 403, {"error": "origin not allowed", "code": "cors"}, vary)
                return
            method = headers.get("access-control-request-method", "").upper()
            requested = [h.strip().lower() for h in headers.get("access-control-request-headers", "").split(",") if h.strip()]
            bad = [h for h in requested if h not in ALLOWED_HEADERS]
            if method not in ALLOWED_METHODS or bad:
                await self._plain(send, 400, {"error": f"disallowed CORS request (method {method}, headers {bad})", "code": "cors"}, vary)
                return
            out = [
                (b"access-control-allow-origin", origin.encode("latin-1")),
                (b"access-control-allow-methods", ", ".join(ALLOWED_METHODS).encode()),
                (b"access-control-allow-headers", ", ".join(ALLOWED_HEADERS).encode()),
                (b"access-control-max-age", str(self.max_age).encode()),
                (b"content-length", b"0"),
            ] + vary
            if headers.get("access-control-request-private-network", "").lower() == "true":
                out.append((b"access-control-allow-private-network", b"true"))
            await send({"type": "http.response.start", "status": 204, "headers": out})
            await send({"type": "http.response.body", "body": b""})
            return
        if not allowed:
            await self._plain(send, 403, {"error": "origin not allowed", "code": "cors"}, vary)
            return

        async def send_with_cors(message) -> None:
            if message["type"] == "http.response.start":
                h = MutableHeaders(scope=message)
                h["Access-Control-Allow-Origin"] = origin
                h.add_vary_header("Origin")
            await send(message)

        await self.app(scope, receive, send_with_cors)


# --------------------------------------------------------------------------------------------


class _Gate:
    """Counts requests waiting for/using an engine; refuses new ones past ``limit``."""

    def __init__(self, name: str, limit: int) -> None:
        self.name = name
        self.limit = max(1, int(limit))
        self.count = 0

    @contextlib.asynccontextmanager
    async def enter(self):
        if self.count >= self.limit:
            raise ApiError(503, f"{self.name} is busy ({self.count} requests queued); try again shortly", "busy", {"Retry-After": "1"})
        self.count += 1
        try:
            yield
        finally:
            self.count -= 1


async def _read_body(request: Request, limit: int) -> bytes:
    cl = request.headers.get("content-length")
    if cl:
        try:
            declared = int(cl)
        except ValueError:
            raise ApiError(400, "invalid Content-Length", "bad_request") from None
        if declared > limit:
            raise ApiError(413, f"request body too large ({declared} bytes; limit {limit})", "too_large")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise ApiError(413, f"request body too large (limit {limit} bytes)", "too_large")
        chunks.append(chunk)
    return b"".join(chunks)


def create_app(
    config: VoiceConfig,
    stt: Any,
    tts: Any,
    device: DeviceMonitor | DeviceReport | None = None,
    allowed_hosts: Iterable[str] | None | str = "auto",
) -> FastAPI:
    """Build the app. ``stt``/``tts`` are engine objects (real, fake or test doubles) with
    ``status()``, ``ensure_loaded(force=)``, ``transcribe(audio16k, language)``,
    ``synthesize(text, voice, speed)`` and ``voices()``."""
    if not config.token:
        raise ValueError("a bearer token is required")
    monitor = device if isinstance(device, DeviceMonitor) else DeviceMonitor(device or DeviceReport())
    if allowed_hosts == "auto":
        allowed_hosts = LOOPBACK_HOSTS if config.host in ("127.0.0.1", "localhost", "::1") else None

    app = FastAPI(title="Lawnmower Man voice", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(CorsAndHostMiddleware, origins=config.cors_origins, allowed_hosts=allowed_hosts)
    app.state.config = config
    app.state.stt = stt
    app.state.tts = tts
    app.state.started = time.time()
    token = config.token.encode("utf-8")
    stt_gate = _Gate("speech recognition", config.max_queue)
    tts_gate = _Gate("speech synthesis", config.max_queue)

    @app.exception_handler(ApiError)
    async def _api_error(_req: Request, exc: ApiError):
        return _error(exc.status, exc.message, exc.code, exc.headers)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_req: Request, exc: StarletteHTTPException):
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return _error(exc.status_code, str(exc.detail), code, getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_req: Request, exc: RequestValidationError):
        return _error(400, f"invalid request: {exc.errors()}", "bad_request")

    @app.exception_handler(Exception)
    async def _unexpected(_req: Request, exc: Exception):
        log.exception("unhandled error")
        return _error(500, f"internal error: {type(exc).__name__}: {exc}", "internal")

    def require_auth(request: Request) -> None:
        h = request.headers.get("authorization", "")
        scheme, _, value = h.partition(" ")
        ok = scheme.lower() == "bearer" and hmac.compare_digest(value.strip().encode("utf-8"), token)
        if not ok:
            raise ApiError(401, "missing or invalid bearer token", "unauthorized", {"WWW-Authenticate": "Bearer"})

    def engine_status(engine: Any) -> dict:
        try:
            return engine.status()
        except Exception as exc:  # pragma: no cover - defensive
            return {"backend": "unknown", "loaded": False, "error": str(exc)}

    @app.get("/health")
    async def health():
        s, t = engine_status(stt), engine_status(tts)
        return {
            "ok": not (s.get("error") and t.get("error")),
            "version": __version__,
            "device": monitor.health(),
            "stt": s,
            "tts": t,
            "fake": bool(config.fake),
            "uptimeSec": round(time.time() - app.state.started, 1),
            "pid": os.getpid(),
        }

    @app.post("/stt")
    async def speech_to_text(request: Request):
        require_auth(request)
        body = await _read_body(request, config.max_upload_bytes)
        t0 = time.perf_counter()
        try:
            audio, _sr = await run_in_threadpool(load_for_whisper, body, request.headers.get("x-sample-rate"))
        except AudioError as exc:
            raise ApiError(400, str(exc), "bad_audio") from None
        duration = len(audio) / float(WHISPER_RATE)
        if duration > config.max_audio_sec:
            raise ApiError(413, f"audio is {duration:.1f} s long; the limit is {config.max_audio_sec:.0f} s", "too_long")
        language = request.query_params.get("language") or None
        if duration < 0.1:
            return {"text": "", "language": language or config.stt_language or "", "durationSec": round(duration, 3), "processingMs": round((time.perf_counter() - t0) * 1000)}
        async with stt_gate.enter():
            try:
                result = await run_in_threadpool(stt.transcribe, audio, language)
            except EngineUnavailable as exc:
                raise ApiError(503, str(exc), "stt_unavailable") from None
            except EngineInputError as exc:
                raise ApiError(400, str(exc), "bad_request") from None
        ms = (time.perf_counter() - t0) * 1000
        log.info("stt: %.2f s audio -> %d chars in %.0f ms", duration, len(result.get("text", "")), ms)
        return {
            "text": result.get("text", ""),
            "language": result.get("language") or language or "",
            "durationSec": round(duration, 3),
            "processingMs": round(ms),
        }

    @app.post("/tts")
    async def text_to_speech(request: Request):
        require_auth(request)
        body = await _read_body(request, MAX_TTS_BODY)
        try:
            payload = json.loads(body.decode("utf-8") or "null")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"body must be JSON: {exc}", "bad_request") from None
        if not isinstance(payload, dict):
            raise ApiError(400, "body must be a JSON object {text, voice?, speed?}", "bad_request")
        text = payload.get("text")
        if not isinstance(text, str):
            raise ApiError(400, "'text' must be a string", "bad_request")
        if len(text) > config.max_tts_chars:
            raise ApiError(413, f"text is {len(text)} characters; the limit is {config.max_tts_chars} (send one sentence per request)", "too_long")
        voice = payload.get("voice")
        if voice is not None and not isinstance(voice, str):
            raise ApiError(400, "'voice' must be a string", "bad_request")
        speed = payload.get("speed")
        if speed is not None and (isinstance(speed, bool) or not isinstance(speed, (int, float))):
            raise ApiError(400, "'speed' must be a number", "bad_request")
        t0 = time.perf_counter()
        async with tts_gate.enter():
            try:
                res = await run_in_threadpool(tts.synthesize, text, voice or None, speed)
            except EngineUnavailable as exc:
                raise ApiError(503, str(exc), "tts_unavailable") from None
            except EngineInputError as exc:
                raise ApiError(400, str(exc), "bad_request") from None
        wav = await run_in_threadpool(encode_wav_pcm16, res.audio, res.sample_rate)
        ms = (time.perf_counter() - t0) * 1000
        duration = len(res.audio) / float(res.sample_rate)
        log.info("tts: %d chars -> %.2f s audio in %.0f ms", len(text), duration, ms)
        return {
            "sampleRate": int(res.sample_rate),
            "audioB64": base64.b64encode(wav).decode("ascii"),
            "durationSec": round(duration, 3),
            "processingMs": round(ms),
            "visemes": res.visemes if res.visemes else None,
            "voice": res.voice,
        }

    @app.get("/voices")
    async def voices(request: Request):
        require_auth(request)
        return tts.voices()

    @app.post("/warmup")
    async def warmup(request: Request):
        require_auth(request)
        # Sequential: loading both at once would spike VRAM and CPU.
        tts_ok = await run_in_threadpool(tts.try_load, True)
        stt_ok = await run_in_threadpool(stt.try_load, True)
        return {"ok": bool(stt_ok and tts_ok), "stt": engine_status(stt), "tts": engine_status(tts)}

    return app
