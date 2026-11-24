"""Shared audio format and publication for the rules editor and TTS generator."""
import hashlib
import json
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RATE = 24000
LEAD_IN = bytes(round(RATE * 0.14) * 2)
PAUSE = bytes(round(RATE * 0.36) * 2)
HIDE_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def script_hash(data):
    return sha(data.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").encode("utf-8"))


def snapshot(paths):
    return {path: path.read_bytes() if path.is_file() else None for path in paths}


def decode_audio(source, format_name=None):
    """Read the first audio stream as mono, 24 kHz, signed 16-bit little-endian PCM."""
    command = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror"]
    if format_name:
        command += ["-f", format_name]
    return subprocess.run(
        [*command, "-i", str(source), "-map", "0:a:0", "-ar", str(RATE),
         "-ac", "1", "-f", "s16le", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=120, creationflags=HIDE_WINDOW,
    ).stdout


def stage_narration(directory, pcm, ends, models, script):
    track = directory / "narration.mp3"
    sheet = directory / "timings.json"
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "s16le",
        "-ar", str(RATE), "-ac", "1", "-i", "pipe:0", "-c:a", "libmp3lame",
        "-b:a", "80k", str(track),
    ], input=pcm, check=True, timeout=120, creationflags=HIDE_WINDOW)
    manifest = {
        "scriptHash": script_hash(script),
        "audioHash": sha(track.read_bytes()),
        "model": " + ".join(dict.fromkeys(models)),
        "cueModels": models,
        "ends": ends,
    }
    sheet.write_text(json.dumps(manifest, ensure_ascii=False) + "\n", encoding="utf-8")
    return track, sheet, manifest


@contextmanager
def publication_lock(root, wait=False):
    # Closing the descriptor also releases the lock after a forced process exit.
    with (root / "tools" / "__pycache__" / "rules-write.lock").open("a+b") as handle:
        handle.seek(0)
        try:
            if sys.platform == "win32":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK if wait else msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RuntimeError("Файлы игры уже сохраняются в другом процессе. Повторите через несколько секунд.") from None
        yield


def publish_rules(root, replacements, expected, staging, manifest=None):
    """Install staged files and rebuild. Keep the previous set if building fails."""
    page = root / "admiral-3d.html"
    (root / "tools" / "__pycache__").mkdir(exist_ok=True)
    with publication_lock(root):
        if snapshot(expected) != expected:
            raise RuntimeError("Файлы обучения изменились после открытия. Откройте редактор заново, чтобы загрузить свежую версию.")
        previous = snapshot((*replacements, page))
        backups = {}
        for path, content in previous.items():
            if content is not None:
                backup = staging / f"{path.name}.previous"
                backup.write_bytes(content)
                backups[path] = backup
        updated = []
        try:
            for path, prepared in replacements.items():
                prepared.replace(path)
                updated.append(path)
            updated.append(page)
            result = subprocess.run([sys.executable, str(root / "tools" / "build.py")],
                                    cwd=root, check=True, capture_output=True, timeout=120,
                                    creationflags=HIDE_WINDOW)
            if manifest:
                audio_url = f"assets/rules/narration.mp3?v={manifest['audioHash'][:12]}"
                if audio_url not in page.read_text(encoding="utf-8"):
                    raise RuntimeError("Сборка не подхватила новую озвучку.")
        except (Exception, KeyboardInterrupt):
            for path in reversed(updated):
                if path in backups:
                    backups[path].replace(path)
                else:
                    path.unlink(missing_ok=True)
            raise
        return result.stdout
