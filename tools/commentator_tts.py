"""Gemini speech requests and the audio format used by Admiral's commentators."""
import base64
import http.client
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import wave

from commentator_data import MODEL_31, MODEL_38, PERSONAS

ROOT = Path(__file__).resolve().parents[1]
BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"


def prompt_31(item: dict) -> str:
    """Keep the original prompt layout while accepting the editor's effective settings."""
    persona = PERSONAS[item["nation"]]
    mood = item.get("mood")
    if mood is None:  # Older catalog items carried the event direction at the end of style.
        mood = item["style"].removeprefix(persona["style"]).strip()
    performance = item.get("performance", persona["performance"])
    if mood:
        performance += "\n" + mood
    return (
        "Synthesize speech for the performance defined below. The profile, scene, performance and context "
        "are direction only and must not be spoken. Speak only the Russian lines under TRANSCRIPT, word for word.\n\n"
        f"# AUDIO PROFILE\n{item.get('profile', persona['profile'])}\n\n"
        f"## SCENE\n{item.get('scene', persona['scene'])}\n\n"
        f"### PERFORMANCE\n{performance}\n\n"
        f"### CONTEXT\n{item.get('context', persona['context'])}\n\n"
        f"#### TRANSCRIPT\n{item['voice_text']}"
    )


def build_payload(model: str, item: dict) -> dict:
    if model == MODEL_38:
        part = {"text": item["voice_text"], "speech_metadata": {"style": item["style"]}}
    elif model == MODEL_31:
        part = {"text": prompt_31(item)}
    else:
        raise ValueError("Выберите Gemini 3.8 или Gemini 3.1 Flash TTS.")
    return {
        "contents": [{"role": "user", "parts": [part]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "languageCode": "ru-RU",
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": item["voice"]}},
            },
        },
    }


def pcm_rate(mime: str) -> int:
    match = re.search(r"\brate\s*=\s*(\d+)", mime or "", re.I)
    return int(match[1]) if match else 24000


def audio_seconds(raw: bytes, mime: str) -> float:
    if raw.startswith(b"RIFF"):
        with wave.open(io.BytesIO(raw)) as wav:
            return wav.getnframes() / wav.getframerate()
    return len(raw) / (2 * pcm_rate(mime))


def encode_mp3(raw: bytes, mime: str, path: Path) -> None:
    """Stage and normalize each clip with the same settings as the original recordings."""
    inputs = [] if raw.startswith(b"RIFF") else ["-f", "s16le", "-ar", str(pcm_rate(mime)), "-ac", "1"]
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=path.parent) as directory:
        staged = Path(directory) / "clip.mp3"
        command = [
            "ffmpeg", "-nostdin", "-v", "error", "-xerror", *inputs, "-i", "pipe:0",
            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "24000", "-ac", "1",
            "-c:a", "libmp3lame", "-b:a", "80k", str(staged),
        ]
        try:
            subprocess.run(command, input=raw, capture_output=True, check=True, timeout=120,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except FileNotFoundError:
            raise RuntimeError("Установите FFmpeg и добавьте его в PATH для записи MP3.") from None
        except (subprocess.SubprocessError, OSError):
            raise RuntimeError("FFmpeg не смог преобразовать ответ Gemini в MP3.") from None
        if staged.stat().st_size < 512:
            raise RuntimeError("FFmpeg вернул пустую запись.")
        os.replace(staged, path)


def gemini_error(status: int, body: bytes, key: str) -> str:
    """Return a short actionable message. Never expose a credential to the browser."""
    try:
        detail = json.loads(body)["error"]["message"]
        detail = detail.replace(key, "[скрыто]") if isinstance(detail, str) else ""
    except (ValueError, KeyError, TypeError):
        detail = ""
    if "user location is not supported" in detail.lower():
        return "Gemini API недоступен в регионе, из которого отправлен запрос."
    if status in (401, 403) or "api key" in detail.lower():
        return f"Gemini отклонил запрос (HTTP {status}). Проверьте ключ в файле gemini и доступ к модели."
    if status == 404:
        return "Выбранная модель Gemini недоступна для этого ключа. Выберите другую модель озвучки."
    if status == 429:
        return "Gemini отклонил запрос из-за лимита. Проверьте квоту в Google AI Studio и повторите позже."
    if status >= 500:
        return f"Gemini временно недоступен (HTTP {status}). Повторите озвучку позже."
    return f"Gemini отклонил запрос (HTTP {status}). {detail[:300]}".strip()


def _pcm_chunk(inline: dict) -> tuple[tuple[int, int, int], bytes]:
    mime = inline["mimeType"]
    raw = base64.b64decode(inline["data"], validate=True)
    if raw.startswith(b"RIFF"):
        with wave.open(io.BytesIO(raw)) as wav:
            channels, width, rate, count = wav.getparams()[:4]
            frames = wav.readframes(count)
            if len(frames) != channels * width * count:
                raise ValueError
            return (channels, width, rate), frames
    if mime.partition(";")[0].lower() not in ("audio/l16", "audio/pcm") or len(raw) % 2:
        raise ValueError
    rate = pcm_rate(mime)
    if not 0 < rate <= 384000:
        raise ValueError
    return (1, 2, rate), raw


def read_audio(response: dict) -> tuple[bytes, str, float]:
    """Keep all audio parts in order; normalize WAV headers before joining their frames."""
    try:
        candidate = response["candidates"][0]
        if candidate.get("finishReason", "STOP") != "STOP":
            raise RuntimeError("Gemini прервал озвучку. Проверьте текст реплики и актёрское задание.")
        audio_format = None
        frames = bytearray()
        for part in candidate["content"]["parts"]:
            inline = part.get("inlineData", {})
            if not inline.get("mimeType", "").lower().startswith("audio/"):
                continue
            part_format, samples = _pcm_chunk(inline)
            if audio_format is not None and audio_format != part_format:
                raise ValueError
            audio_format = part_format
            frames.extend(samples)
        if frames:
            channels, width, rate = audio_format
            with io.BytesIO() as data:
                with wave.open(data, "wb") as wav:
                    wav.setparams((channels, width, rate, 0, "NONE", "not compressed"))
                    wav.writeframes(frames)
                return data.getvalue(), "audio/wav", len(frames) / (channels * width * rate)
    except (KeyError, AttributeError, IndexError, TypeError, ValueError, wave.Error, EOFError):
        pass
    raise RuntimeError("Ответ Gemini не содержит пригодной аудиозаписи. Повторите озвучку.")


def synthesize(item: dict, key_path: Path = ROOT / "gemini") -> tuple[bytes, float]:
    """Return a complete MP3 and its source duration, without modifying an existing take."""
    model = item["model"]
    payload = build_payload(model, item)
    if not shutil.which("ffmpeg"):
        raise RuntimeError("Установите FFmpeg и добавьте его в PATH для записи MP3.")
    try:
        key = key_path.read_text(encoding="utf-8-sig").strip()
    except (OSError, UnicodeError):
        key = ""
    if not key or not key.isascii() or any(c.isspace() for c in key):
        raise RuntimeError("Сохраните API-ключ Gemini одной строкой в файле gemini в папке игры.")
    request = Request(f"{BASE_URL}/{model}:generateContent", json.dumps(payload).encode(),
                      {"Content-Type": "application/json", "x-goog-api-key": key}, method="POST")
    try:
        with urlopen(request, timeout=120) as answer:
            response = json.load(answer)
    except HTTPError as exc:
        with exc:
            message = gemini_error(exc.code, exc.read(16384), key)
        raise RuntimeError(message) from None
    except (URLError, OSError, http.client.HTTPException):
        raise RuntimeError("Не удалось связаться с Gemini API. Проверьте подключение и повторите озвучку.") from None
    except (ValueError, UnicodeError):
        raise RuntimeError("Сервис Gemini вернул нечитаемый ответ. Повторите озвучку.") from None
    raw, mime, seconds = read_audio(response)
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "take.mp3"
        encode_mp3(raw, mime, path)
        return path.read_bytes(), round(seconds, 3)
