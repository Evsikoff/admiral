"""Replace the rules narration with Gemini TTS and rebuild Admiral.

Run `python tools/generate_rules.py --model 3.8` to synthesize missing cues
with Gemini 3.8 Flash TTS. Without --model, new cues use Gemini 3.1 Flash TTS.
Requires FFmpeg on PATH and the Python packages httpx and Pillow.
The key comes from the `gemini` file in the project root.
Completed cues from either model are reused from the system temp directory.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections import Counter

try:
    import httpx
except ModuleNotFoundError:
    raise SystemExit("httpx is required. Install dependencies with python -m pip install httpx Pillow.") from None

from generate_commentator import BASE_URL, build_payload, is_daily_quota_error, parse_retry_delay, plausible
from commentator_data import MODEL_31, MODEL_38
from rules_audio import LEAD_IN, PAUSE, RATE, ROOT, publish_rules, snapshot, stage_narration

MODELS = {"3.1": MODEL_31, "3.8": MODEL_38}
VOICE = "Charon"
PROMPT = """Read only the Russian text under TRANSCRIPT, exactly. Do not speak the directions.
Audio profile: a veteran navigator with a low, warm, resonant voice and standard Russian pronunciation.
Scene: a calm briefing in the captain's cabin before the fleet sails.
Performance: confident and quietly cinematic, with crisp diction. Keep a natural storytelling pace.
Clean dry studio recording, no music or sound effects.

TRANSCRIPT
"""
STYLE_38 = (
    "A veteran navigator giving a calm briefing in the captain's cabin. Low, warm, resonant voice, "
    "standard Russian pronunciation, confident and quietly cinematic delivery, crisp diction, "
    "and a natural storytelling pace. Clean dry studio recording, no music or sound effects."
)


def encode_pcm(raw, mime):
    rate = re.search(r"rate=(\d+)", mime)
    args = [] if raw.startswith(b"RIFF") else ["-f", "s16le", "-ar", rate[1] if rate else str(RATE), "-ac", "1"]
    trim = "silenceremove=start_periods=1:start_duration=0.04:start_threshold=-43dB:start_silence=0.10"
    return subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", *args, "-i", "pipe:0",
        "-af", f"{trim},areverse,{trim},areverse,loudnorm=I=-17:TP=-2:LRA=9",
        "-ar", str(RATE), "-ac", "1", "-f", "s16le", "pipe:1"
    ], input=raw, stdout=subprocess.PIPE, check=True).stdout


def record(client, text, model):
    if model == MODEL_38:
        payload = build_payload(model, {"voice_text": text, "style": STYLE_38, "voice": VOICE})
    else:
        payload = {
            "contents": [{"parts": [{"text": PROMPT + text}]}],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "languageCode": "ru-RU",
                    "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": VOICE}},
                },
            },
        }
    error = "No usable audio returned"
    for attempt in range(4):
        try:
            response = client.post(f"{BASE_URL}/{model}:generateContent", json=payload)
        except httpx.TransportError as exc:
            error = f"Connection to Gemini failed ({type(exc).__name__})"
            if attempt < 3:
                time.sleep(2 ** attempt)
            continue
        if response.status_code == 429 and is_daily_quota_error(response.text):
            raise RuntimeError("Gemini daily quota exceeded (HTTP 429). "
                               "Run the same command after the quota resets.")
        if response.status_code in (429, 500, 502, 503, 504):
            error = f"Gemini HTTP {response.status_code}"
            if attempt < 3:
                print(f"  {error}. Waiting to retry.", flush=True)
                time.sleep(parse_retry_delay(response.text))
            continue
        if not response.is_success:
            raise RuntimeError(f"Gemini rejected the request (HTTP {response.status_code}).")
        candidates = response.json().get("candidates") or [{}]
        parts = candidates[0].get("content", {}).get("parts", [])
        inline = next((part["inlineData"] for part in parts if "inlineData" in part), None)
        if not inline:
            continue
        pcm = encode_pcm(base64.b64decode(inline["data"]), inline.get("mimeType", ""))
        seconds = len(pcm) / (RATE * 2)
        if plausible(seconds, text):
            return pcm
        error = f"Unexpected audio length: {seconds:.2f} seconds"
    raise RuntimeError(error)


def write_recording(audio, timings, script, cue_models, expected):
    out = ROOT / "assets" / "rules"
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out) as directory:
        staged = pathlib.Path(directory)
        track, sheet, manifest = stage_narration(staged, audio, timings, cue_models, script)
        output = publish_rules(ROOT, {out / track.name: track, out / sheet.name: sheet}, expected, staged, manifest)
        print(output.decode(errors="replace"), end="")
    models = ", ".join(f"{model}: {count}" for model, count in Counter(cue_models).items())
    print(f"Replaced rules narration: {len(timings)} cues, {timings[-1]:.1f} s ({models}).")


def cache_path(cache, model, text):
    # Keep the original Gemini 3.1 keys so interrupted runs still find their recordings.
    directions = PROMPT if model == MODEL_31 else STYLE_38
    digest = hashlib.sha256((model + VOICE + directions + text).encode()).hexdigest()
    return cache / f"{digest}.pcm"


def main(model):
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("FFmpeg was not found on PATH.")
    if importlib.util.find_spec("PIL") is None:
        raise RuntimeError("Pillow is required to rebuild the game. Install it with python -m pip install Pillow.")

    script_path = ROOT / "src" / "rules-script.json"
    out = ROOT / "assets" / "rules"
    expected = snapshot((script_path, out / "narration.mp3", out / "timings.json"))
    script_bytes = expected[script_path]
    if script_bytes is None:
        raise RuntimeError(f"Rules script not found: {script_path}")
    script = json.loads(script_bytes)
    key = (ROOT / "gemini").read_text(encoding="utf-8-sig").strip()
    if not key:
        raise RuntimeError("The Gemini API key file is empty")
    cache = pathlib.Path(tempfile.gettempdir()) / "admiral-rules-tts"
    cache.mkdir(exist_ok=True)
    audio = bytearray()
    timings = []
    cue_models = []
    with (
        httpx.Client(headers={"x-goog-api-key": key}, timeout=httpx.Timeout(90, connect=15)) as client,
        tempfile.TemporaryDirectory(dir=cache) as pending,
    ):
        for chapter in script:
            for index, cue in enumerate(chapter["cues"], 1):
                label = f"{chapter['id']}/{index}"
                for cue_model in MODELS.values():
                    path = cache_path(cache, cue_model, cue)
                    pcm = path.read_bytes() if path.is_file() else b""
                    if len(pcm) % 2 == 0 and plausible(len(pcm) / (RATE * 2), cue):
                        print(f"  {label}: {len(pcm) / (RATE * 2):.2f} s (cached, {cue_model})", flush=True)
                        break
                else:
                    cue_model = model
                    path = cache_path(cache, cue_model, cue)
                    print(f"Recording {label} with {cue_model} ...", flush=True)
                    try:
                        pcm = record(client, cue, cue_model)
                    except RuntimeError as exc:
                        raise RuntimeError(f"{label}: {exc}") from exc
                    clip = pathlib.Path(pending) / path.name
                    clip.write_bytes(pcm)
                    clip.replace(path)
                    print(f"  {label}: {len(pcm) / (RATE * 2):.2f} s", flush=True)
                audio.extend(LEAD_IN)
                audio.extend(pcm)
                audio.extend(PAUSE)
                timings.append(round(len(audio) / (RATE * 2), 3))
                cue_models.append(cue_model)
    write_recording(audio, timings, script_bytes, cue_models, expected)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate missing rules narration and rebuild Admiral.")
    parser.add_argument(
        "--model", choices=MODELS, default="3.1",
        help="Gemini Flash TTS model for missing cues (default: %(default)s). Saved cues are reused.",
    )
    args = parser.parse_args()
    try:
        main(MODELS[args.model])
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        sys.exit(f"Could not replace rules narration: {exc}")
    except KeyboardInterrupt:
        sys.exit("Interrupted. Run the same command again to resume from the saved clips.")
