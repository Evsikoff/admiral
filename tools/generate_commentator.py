"""Voices the commentator lines (tools/commentator_data.py) with Gemini TTS.

Each fleet has its own voice and is voiced by one model only (NATION_MODEL), so its narrator sounds
the same in every clip. Each model may make DAILY_LIMIT clips a day: the count is kept in
tools/tts_usage.json by the Pacific date (Gemini quotas reset at midnight Pacific time).
Clips are made variant by variant (every bucket's 01 first, then 02 ...), so a partial run still
gives every event a voice. Run it again the next day to finish; finished clips are kept.

  python tools/generate_commentator.py            # as many clips as today's limits allow
  python tools/generate_commentator.py --max 2    # a probe: at most two new clips
  python tools/generate_commentator.py --dry-run  # what would be made, no requests

The key comes from the GEMINI_API_KEY (or GOOGLE_API_KEY) environment variable, else from the
file `gemini` in the project root (one line), else from the user or system environment in the registry.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import threading
import time
import wave
from zoneinfo import ZoneInfo

import httpx

from commentator_data import MODEL_31, MODEL_38, MODELS, PERSONAS, build_catalog

DAILY_LIMIT = 100
BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_ROOT = ROOT / "assets" / "sound" / "commentator"
USAGE_FILE = ROOT / "tools" / "tts_usage.json"
CLIPS_FILE = ROOT / "tools" / "tts_clips.json"     # bucket/id -> text, model, voice, seconds


def find_api_key() -> str:
    names = ("GEMINI_API_KEY", "GOOGLE_API_KEY")
    for name in names:
        if os.environ.get(name):
            return os.environ[name]
    key_file = ROOT / "gemini"                      # one line: the key
    if key_file.is_file():
        key = key_file.read_text(encoding="utf-8").strip()
        if key:
            return key
    if sys.platform == "win32":                      # set after this shell started: read the registry
        import winreg
        places = [
            (winreg.HKEY_CURRENT_USER, r"Environment"),
            (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        ]
        for hive, path in places:
            for name in names:
                try:
                    with winreg.OpenKey(hive, path) as key:
                        value, _ = winreg.QueryValueEx(key, name)
                        if value:
                            return str(value)
                except OSError:
                    pass
    return ""


def pacific_today() -> str:
    return datetime.datetime.now(ZoneInfo("America/Los_Angeles")).date().isoformat()


def is_daily_quota_error(err_text: str) -> bool:
    low = err_text.lower()
    return any(m in low for m in ("perday", "per_day", "per day", "daily", "requestsperday", "dayperproject"))


def parse_retry_delay(err_text: str) -> float:
    m = re.search(r'"retryDelay"\s*:\s*"([0-9.]+)s"', err_text)
    return min(65.0, max(3.0, float(m.group(1)) + 1.5)) if m else 12.0


def prompt_31(item: dict[str, str]) -> str:
    """Gemini 3.1 takes its direction in the text: short labels, transcript last."""
    p = PERSONAS[item["nation"]]
    mood = item["style"][len(p["style"]):].strip()
    performance = p["performance"] + (f"\n{mood}" if mood else "")
    return (
        "Synthesize speech for the performance defined below. The profile, scene, performance and context "
        "are direction only and must not be spoken. Speak only the Russian lines under TRANSCRIPT, word for word.\n\n"
        f"# AUDIO PROFILE\n{p['profile']}\n\n"
        f"## SCENE\n{p['scene']}\n\n"
        f"### PERFORMANCE\n{performance}\n\n"
        f"### CONTEXT\n{p['context']}\n\n"
        f"#### TRANSCRIPT\n{item['voice_text']}"
    )


def build_payload(model: str, item: dict[str, str]) -> dict:
    if model == MODEL_38:
        part = {"text": item["voice_text"], "speech_metadata": {"style": item["style"]}}
    else:
        part = {"text": prompt_31(item)}
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


def audio_seconds(raw: bytes, mime: str) -> float:
    if raw[:4] == b"RIFF":
        with wave.open(io.BytesIO(raw)) as w:
            return w.getnframes() / float(w.getframerate())
    m = re.search(r"rate=(\d+)", mime or "")
    rate = int(m.group(1)) if m else 24000
    return len(raw) / 2 / rate


def plausible(seconds: float, text: str) -> bool:
    """Russian speech runs at roughly 12-16 characters a second; much longer means the
    direction was read aloud, much shorter means the line was cut."""
    return len(text) / 40 <= seconds <= 3.0 + len(text) / 6


class Ledger:
    """Clips made per model per Pacific day, plus what every finished clip says and who made it."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.lock = threading.Lock()
        self.usage = self._load(USAGE_FILE)
        self.clips = self._load(CLIPS_FILE)
        self.reserved = {m: 0 for m in MODELS}

    @staticmethod
    def _load(path: pathlib.Path) -> dict:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save(self) -> None:
        USAGE_FILE.write_text(json.dumps(self.usage, indent=1, sort_keys=True), encoding="utf-8")
        CLIPS_FILE.write_text(json.dumps(self.clips, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")

    def used(self, model: str) -> int:
        return self.usage.get(pacific_today(), {}).get(model, 0)

    def left(self, model: str) -> int:
        with self.lock:
            return self.limit - self.used(model) - self.reserved[model]

    def reserve(self, model: str) -> bool:
        with self.lock:
            if self.used(model) + self.reserved[model] >= self.limit:
                return False
            self.reserved[model] += 1
            return True

    def release(self, model: str, spent: bool) -> None:
        with self.lock:
            self.reserved[model] -= 1
            if spent:
                day = self.usage.setdefault(pacific_today(), {})
                day[model] = day.get(model, 0) + 1
                self._save()

    def exhaust(self, model: str) -> None:
        with self.lock:
            day = self.usage.setdefault(pacific_today(), {})
            day[model] = max(day.get(model, 0), self.limit)
            self._save()

    def record(self, key: str, info: dict) -> None:
        with self.lock:
            self.clips[key] = info
            self._save()

    def is_current(self, key: str, item: dict, path: pathlib.Path) -> bool:
        info = self.clips.get(key)
        return (path.exists() and path.stat().st_size > 1024 and info is not None
                and info.get("text") == item["voice_text"] and info.get("voice") == item["voice"])


class Generator:
    def __init__(self, api_key: str, ledger: Ledger) -> None:
        self.api_key = api_key
        self.ledger = ledger
        self.client = httpx.Client(transport=httpx.HTTPTransport(retries=4),
                                   timeout=httpx.Timeout(60.0, connect=18.0))
        self.lock = threading.Lock()
        self.cooldown_until = {m: 0.0 for m in MODELS}
        self.dead: dict[str, str] = {}               # model -> why it is not used any more this run
        self.suspect_streak = {m: 0 for m in MODELS}
        self.made = {m: 0 for m in MODELS}
        self.problems: list[str] = []

    def wait_cooldown(self, model: str) -> None:
        while True:
            with self.lock:
                wait = self.cooldown_until[model] - time.monotonic()
            if wait <= 0:
                return
            time.sleep(min(wait, 1.0))

    def encode_mp3(self, raw: bytes, mime: str, out_mp3: pathlib.Path) -> None:
        out_mp3.parent.mkdir(parents=True, exist_ok=True)
        tmp = out_mp3.with_suffix(f".{threading.get_ident()}.tmp.mp3")
        m = re.search(r"rate=(\d+)", mime or "")
        rate = m.group(1) if m else "24000"
        input_args = ["-i", "pipe:0"] if raw[:4] == b"RIFF" else ["-f", "s16le", "-ar", rate, "-ac", "1", "-i", "pipe:0"]
        cmd = ["ffmpeg", "-y", "-loglevel", "error", *input_args,
               "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "24000", "-ac", "1", "-b:a", "80k", str(tmp)]
        proc = subprocess.run(cmd, input=raw, capture_output=True)
        if proc.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 512:
            raise RuntimeError(f"ffmpeg failed ({proc.returncode}): {proc.stderr.decode('utf-8', 'ignore')[-300:]}")
        os.replace(tmp, out_mp3)

    def make(self, bucket: str, item: dict[str, str]) -> str:
        model = item["model"]
        key = f"{bucket}/{item['id']}"
        out_mp3 = OUT_ROOT / bucket / f"{item['id']}.mp3"
        attempts = 0
        while True:
            if model in self.dead:
                return "skipped"
            if not self.ledger.reserve(model):
                return "no-quota"
            self.wait_cooldown(model)
            spent = False
            try:
                resp = self.client.post(f"{BASE_URL}/{model}:generateContent",
                                        headers={"x-goog-api-key": self.api_key, "Content-Type": "application/json"},
                                        json=build_payload(model, item))
            except Exception as exc:                  # network trouble: nothing was spent
                self.ledger.release(model, False)
                attempts += 1
                if attempts > 6:
                    self.problems.append(f"{key}: network error {exc}")
                    return "failed"
                time.sleep(2.0 * attempts)
                continue

            if resp.status_code == 200:
                spent = True
                self.ledger.release(model, True)
                try:
                    inline = resp.json()["candidates"][0]["content"]["parts"][0]["inlineData"]
                    raw, mime = base64.b64decode(inline["data"]), inline.get("mimeType", "")
                except Exception:
                    attempts += 1
                    if attempts > 2:
                        self.problems.append(f"{key}: no audio in the answer: {resp.text[:200]}")
                        return "failed"
                    continue
                seconds = audio_seconds(raw, mime)
                if not plausible(seconds, item["voice_text"]):
                    with self.lock:
                        self.suspect_streak[model] += 1
                        streak = self.suspect_streak[model]
                    self.problems.append(f"{key}: {seconds:.1f} s for {len(item['voice_text'])} characters ({model})")
                    if streak >= 3:
                        self.dead[model] = "three clips in a row had an implausible length"
                        print(f"[STOP] {model}: {self.dead[model]}", flush=True)
                        return "failed"
                    attempts += 1
                    if attempts > 1:
                        return "failed"
                    continue
                with self.lock:
                    self.suspect_streak[model] = 0
                    self.made[model] += 1
                self.encode_mp3(raw, mime, out_mp3)
                self.ledger.record(key, {"text": item["voice_text"], "voice": item["voice"], "model": model,
                                         "seconds": round(seconds, 2), "made": pacific_today()})
                print(f"OK {key} {seconds:.1f}s via {model} (left today: {self.ledger.left(model)})", flush=True)
                return "made"

            self.ledger.release(model, spent)
            body = resp.text
            if resp.status_code == 429:
                if is_daily_quota_error(body):
                    self.ledger.exhaust(model)
                    print(f"[QUOTA] {model}: daily quota reached", flush=True)
                    return "no-quota"
                delay = parse_retry_delay(body)
                with self.lock:
                    self.cooldown_until[model] = max(self.cooldown_until[model], time.monotonic() + delay)
                print(f"[RATE] {model}: waiting {delay:.0f}s", flush=True)
                attempts += 1
                if attempts > 12:
                    self.problems.append(f"{key}: rate limited too long")
                    return "failed"
                continue
            if resp.status_code in (500, 502, 503, 504):
                attempts += 1
                if attempts > 5:
                    self.problems.append(f"{key}: server error {resp.status_code}")
                    return "failed"
                time.sleep(2.5 * attempts)
                continue
            self.dead[model] = f"HTTP {resp.status_code}: {body[:300]}"
            print(f"[STOP] {model}: {self.dead[model]}", flush=True)
            return "failed"


def pending_tasks(catalog: dict, ledger: Ledger) -> list[tuple[str, dict]]:
    """Every bucket's first variant, then every second one, and so on."""
    tasks = []
    longest = max(len(v) for v in catalog.values())
    for i in range(longest):
        for bucket, items in catalog.items():
            if i < len(items):
                item = items[i]
                if not ledger.is_current(f"{bucket}/{item['id']}", item, OUT_ROOT / bucket / f"{item['id']}.mp3"):
                    tasks.append((bucket, item))
    return tasks


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max", type=int, default=0, help="at most this many new clips (0: no cap)")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--daily-limit", type=int, default=DAILY_LIMIT)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    ledger = Ledger(args.daily_limit)
    catalog = build_catalog()
    tasks = pending_tasks(catalog, ledger)
    left = {m: ledger.left(m) for m in MODELS}
    print(f"{len(tasks)} clips to make; left today: {left}", flush=True)

    # only what today's limits allow, keeping the variant-by-variant order within each model
    chosen, room = [], dict(left)
    for bucket, item in tasks:
        if room[item["model"]] > 0:
            chosen.append((bucket, item))
            room[item["model"]] -= 1
        if args.max and len(chosen) >= args.max:
            break
    if args.max:                                      # a probe: one clip of each model first
        firsts = {}
        for bucket, item in tasks:
            firsts.setdefault(item["model"], (bucket, item))
        probe = [t for t in firsts.values() if left[t[1]["model"]] > 0]
        chosen = (probe + [t for t in chosen if t not in probe])[:args.max]

    if args.dry_run:
        for bucket, item in chosen:
            print(f"  {bucket}/{item['id']} [{item['model']}, {item['voice']}] {item['voice_text']}")
        print(f"{len(chosen)} clips would be made now, {len(tasks) - len(chosen)} later.")
        return

    api_key = find_api_key()
    if not api_key:
        print("No API key: set GEMINI_API_KEY or put the key into the file `gemini` in the project root.", file=sys.stderr)
        sys.exit(1)

    gen = Generator(api_key, ledger)
    t0 = time.monotonic()
    results: dict[str, int] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(gen.make, b, it) for b, it in chosen]
        for fut in concurrent.futures.as_completed(futures):
            r = fut.result()
            results[r] = results.get(r, 0) + 1

    remaining = len(pending_tasks(catalog, ledger))
    print(f"Done in {time.monotonic() - t0:.0f}s: {results}; made per model: {gen.made}", flush=True)
    print(f"Left today: { {m: ledger.left(m) for m in MODELS} }; clips still to make: {remaining}", flush=True)
    for why in gen.problems:
        print(f"[PROBLEM] {why}", flush=True)
    for model, why in gen.dead.items():
        print(f"[STOPPED] {model}: {why}", flush=True)


if __name__ == "__main__":
    main()
