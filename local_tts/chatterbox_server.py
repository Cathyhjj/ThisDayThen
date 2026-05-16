#!/usr/bin/env python3
"""Tiny localhost TTS server for Chatterbox.

Install Chatterbox in a Python environment, run this script, then start the app
with LOCAL_TTS_URL=http://127.0.0.1:7861/synthesize.
"""

from __future__ import annotations

import inspect
import json
import os
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HOST = os.environ.get("CHATTERBOX_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHATTERBOX_PORT", "7861"))
DEFAULT_REFERENCE_AUDIO = os.environ.get("CHATTERBOX_REFERENCE_AUDIO", "")
MODEL = None


def infer_device() -> str:
    configured_device = os.environ.get("CHATTERBOX_DEVICE")
    if configured_device:
        return configured_device

    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass

    return "cpu"


def model():
    global MODEL
    if MODEL is None:
        from chatterbox.tts import ChatterboxTTS

        MODEL = ChatterboxTTS.from_pretrained(device=infer_device())
    return MODEL


def synthesize(payload: dict) -> bytes:
    text = str(payload.get("text", "")).strip()
    if not text:
        raise ValueError("Text is required.")

    reference_audio = (
        str(payload.get("reference_audio") or "").strip()
        or DEFAULT_REFERENCE_AUDIO
    )
    exaggeration = float(payload.get("exaggeration") or 0.45)

    generator = model()
    generate_signature = inspect.signature(generator.generate)
    generate_kwargs = {"text": text}
    if reference_audio and "audio_prompt_path" in generate_signature.parameters:
        generate_kwargs["audio_prompt_path"] = reference_audio
    if "exaggeration" in generate_signature.parameters:
        generate_kwargs["exaggeration"] = exaggeration

    wav = generator.generate(**generate_kwargs)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
        temp_path = temp_file.name

    try:
        import torchaudio

        torchaudio.save(temp_path, wav, generator.sr)
        with open(temp_path, "rb") as audio_file:
            return audio_file.read()
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002
        return

    def do_GET(self):  # noqa: N802
        if self.path != "/health":
            self.send_error(404)
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode("utf-8"))

    def do_POST(self):  # noqa: N802
        if self.path != "/synthesize":
            self.send_error(404)
            return

        try:
            content_length = int(self.headers.get("content-length") or "0")
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            audio = synthesize(payload)
        except Exception as error:
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(error)}).encode("utf-8"))
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(audio)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Chatterbox TTS listening on http://{HOST}:{PORT}")
    server.serve_forever()
