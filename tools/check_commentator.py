"""Listens to the voiced commentator clips: a Gemini text model transcribes each one and the result is
compared with the script, so a clip that misreads the line or speaks the direction aloud shows up.

  python tools/check_commentator.py                  # every clip in tools/tts_clips.json
  python tools/check_commentator.py --made today     # only clips made today (Pacific date)
  python tools/check_commentator.py turn_ru/01 ...   # these clips
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import difflib
import json
import pathlib
import re
import time

import httpx

from generate_commentator import CLIPS_FILE, OUT_ROOT, find_api_key, pacific_today

MODEL = "gemini-3.8-flash"
PROMPT = ("Transcribe this Russian speech exactly, word for word, with no comments. Then on a new line starting with "
          "'VOICE:' describe in English in under 15 words the speaker's gender, pitch, pace and mood.")


def words(t: str) -> str:
    return " ".join(re.sub(r"[^а-яё ]", " ", t.lower().replace("ё", "е")).split())


def check(key: str, text: str, api_key: str) -> tuple[float, str, str]:
    mp3 = OUT_ROOT / f"{key}.mp3"
    body = {
        "contents": [{"role": "user", "parts": [
            {"inlineData": {"mimeType": "audio/mp3", "data": base64.b64encode(mp3.read_bytes()).decode()}},
            {"text": PROMPT},
        ]}],
        "generationConfig": {"temperature": 0},
    }
    status = "no answer"
    for attempt in range(6):
        try:
            r = httpx.post(f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
                           headers={"x-goog-api-key": api_key}, json=body, timeout=90)
        except httpx.HTTPError as exc:               # network trouble: wait and try again
            status = f"network error {exc}"
            time.sleep(3 * (attempt + 1))
            continue
        candidates = r.json().get("candidates") if r.status_code == 200 else None
        if candidates and candidates[0].get("content", {}).get("parts"):
            break
        status = f"HTTP {r.status_code}: {r.text[:200]}"
        time.sleep(3 * (attempt + 1))
    else:
        return 0.0, status, ""
    answer = "".join(p.get("text", "") for p in candidates[0]["content"]["parts"])
    heard, _, voice = answer.partition("VOICE:")
    return difflib.SequenceMatcher(None, words(text), words(heard)).ratio(), heard.strip(), voice.strip()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("keys", nargs="*")
    parser.add_argument("--made", help="'today' or a date: only clips made then")
    parser.add_argument("--threshold", type=float, default=0.9)
    args = parser.parse_args()

    clips = json.loads(CLIPS_FILE.read_text(encoding="utf-8"))
    day = pacific_today() if args.made == "today" else args.made
    keys = args.keys or sorted(k for k, v in clips.items() if not day or v.get("made") == day)
    api_key = find_api_key()
    bad = []
    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        futures = {k: pool.submit(check, k, clips[k]["text"], api_key) for k in keys}
        for k in keys:
            ratio, heard, voice = futures[k].result()
            ok = ratio >= args.threshold
            if not ok:
                bad.append(k)
            print(f"{'OK ' if ok else 'BAD'} {ratio:.2f} {k} [{clips[k]['model']}, {clips[k]['seconds']}s] {voice}")
            if not ok:
                print(f"     script: {clips[k]['text']}\n     heard:  {heard}")
    print(f"\n{len(keys) - len(bad)} of {len(keys)} clips match the script.")
    if bad:
        print("To redo a clip, delete its mp3 and run tools/generate_commentator.py again: " + " ".join(bad))


if __name__ == "__main__":
    main()
