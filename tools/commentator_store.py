"""Editable commentator catalog, clip receipts and transactional game builds."""
import datetime
import hashlib
import json
import math
import re
import subprocess
import sys
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path

from commentator_data import (EDITS_PATH, LINES, MODELS, NATIONS, PERSONAS, ROOT, build_catalog, event_mood,
                              original_settings, read_edits, recipe_hash, recording_matches)
from rules_audio import HIDE_WINDOW, publication_lock, snapshot

NATION_NAMES = {"ru": "Россия", "en": "Англия", "se": "Швеция", "nl": "Голландия"}
VOICE_NAMES = ("Achernar Achird Algenib Algieba Alnilam Aoede Autonoe Callirrhoe Charon Despina "
               "Enceladus Erinome Fenrir Gacrux Iapetus Kore Laomedeia Leda Orus Puck Pulcherrima "
               "Rasalgethi Sadachbia Sadaltager Schedar Sulafat Umbriel Vindemiatrix Zephyr Zubenelgenubi").split()

EVENT_GROUPS = {
    "Начало и ход": {"game_start": "Начало партии", "turn_first": "Первый ход игрока", "turn": "Начало хода"},
    "Бросок костей": {"foul_out": "Кость за бортом", "foul_ship": "Кость задела корабль",
                      "foul_cocked": "Кость на ребре", "foul_moving": "Кости не остановились",
                      "roll_double": "Выпал дубль", "double_bonus": "Дополнительный бросок"},
    "Нет хода": {"no_move_empty_first": "Первый ход без шестёрки", "no_move_empty": "В море нет кораблей",
                 "no_move_blocked": "Все пути закрыты", "no_move_with_six": "Шестёрку некуда применить",
                 "unspent_captured": "После захвата нет хода", "unspent_blocked": "Вторую кость некуда применить"},
    "Выбор действия": {"opt_captured_other": "Ход другим кораблём", "opt_move_and_six": "Ход или шестёрка",
                       "opt_repair_only": "Доступен ремонт", "opt_ransom_only": "Доступен выкуп",
                       "opt_sail_first": "Выбор хода", "opt_second_die": "Выбор хода второй костью"},
    "Движение кораблей": {"boarding": "Абордаж", "parade": "Выход на парад", "harbor": "Выход из гавани",
                          "sail": "Корабль в пути", "move_bay": "Вход в бухту", "move_bypass": "Обход по кольцу"},
    "Ремонт и выкуп": {"repair": "Ремонт корабля", "ransom": "Выкуп пленника", "comp_none": "Нет ответного хода",
                       "comp_auto": "Ответный ход без выбора", "comp_choose": "Выбор ответного хода"},
    "Погоня": {"chase_ahead": "Враг впереди", "chase_behind": "Враг за кормой", "chase_ambush": "Вражеская засада"},
    "Финал": {"victory": "Победа"},
}
EVENTS = [{"id": event, "name": name, "group": group, "mood": event_mood(event)}
          for group, names in EVENT_GROUPS.items() for event, name in names.items()]


class ConflictError(RuntimeError):
    pass


def json_bytes(data):
    return (json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n").encode()


def validate_text(text):
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError("Введите текст реплики длиной от 1 до 4000 символов.")
    return text.strip()


def validate_settings(settings, *, line=False):
    allowed = set(original_settings("ru"))
    if line:
        allowed.add("mood")
    if not isinstance(settings, dict) or settings.keys() - allowed:
        raise ValueError("Неизвестные настройки озвучки.")
    if any(not isinstance(value, str) or len(value) > 8000 for value in settings.values()):
        raise ValueError("Поле настроек должно содержать до 8000 символов.")
    if "voice" in settings and settings["voice"] not in VOICE_NAMES:
        raise ValueError("Выберите голос из списка Gemini.")
    if "model" in settings and settings["model"] not in MODELS:
        raise ValueError("Выберите модель Gemini Flash TTS.")
    return {k: v.strip() for k, v in settings.items()}


def lookup(catalog, key):
    bucket, _, number = key.partition("/") if isinstance(key, str) else ("", "", "")
    if bucket in catalog and re.fullmatch(r"[0-9]{2,9}", number):
        index = int(number) - 1
        if 0 <= index < len(catalog[bucket]) and catalog[bucket][index]["id"] == number:
            return catalog[bucket][index]
    raise ValueError("Реплика не найдена.")


def version(path):
    try:
        stat = path.stat()
        return f"{stat.st_mtime_ns:x}-{stat.st_size:x}" if stat.st_size else None
    except FileNotFoundError:
        return None


class CommentatorStore:
    def __init__(self, root=ROOT, rebuild=True):
        self.root = Path(root)
        self.edits_path = self.root / EDITS_PATH
        self.receipts_path = self.root / "tools/tts_clips.json"
        self.audio_dir = self.root / "assets/sound/commentator"
        self.rebuild = rebuild
        self.lock = threading.RLock()

    def _load(self, revision=None):
        edits = read_edits(self.root)
        try:
            receipts = json.loads(self.receipts_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            receipts = {}
        current = hashlib.sha256(json_bytes([edits, receipts])).hexdigest()[:24]
        if revision is not None and revision != current:
            raise ConflictError("Каталог изменился. Обновите страницу и повторите действие.")
        return edits, receipts, current

    @contextmanager
    def _writing(self):
        (self.root / "tools/__pycache__").mkdir(parents=True, exist_ok=True)
        with self.lock, publication_lock(self.root, wait=True):
            yield

    def _state(self, edits, receipts, revision):
        nations = [{"id": n, "name": NATION_NAMES[n], "persona": PERSONAS[n]["name"],
                    "settings": {**original_settings(n), **edits["nations"].get(n, {})}} for n in NATIONS]
        defaults = {n["id"]: n["settings"] for n in nations}
        lines = []
        for bucket, variants in build_catalog(edits).items():
            for item in variants:
                key = f"{bucket}/{item['id']}"
                overrides = edits["lines"].get(key, {}).get("overrides", {})
                receipt = receipts.get(key, {})
                stamp = version(self.audio_dir / f"{key}.mp3")
                status = "ready" if recording_matches(item, receipt) else "stale"
                lines.append({"id": key, "event": item["event"], "nation": item["nation"], "variant": int(item["id"]),
                              "text": item["voice_text"], "overrides": overrides,
                              "settings": {**defaults[item["nation"]], "mood": item["mood"], **overrides},
                              "status": status if stamp else "missing", "seconds": receipt.get("seconds") if stamp else None,
                              "audioUrl": f"/audio/{key}.mp3?v={stamp}" if stamp else None})
        return {"revision": revision, "events": EVENTS, "nations": nations, "lines": lines,
                "models": list(MODELS), "voices": VOICE_NAMES}

    def state(self):
        with self.lock:
            return self._state(*self._load())

    def audio_path(self, key):
        if not isinstance(key, str) or not re.fullmatch(r"[a-z_]+_(ru|en|se|nl)/[0-9]{2,9}", key):
            return None
        event = key.split("/")[0].rsplit("_", 1)[0]
        return self.audio_dir / f"{key}.mp3" if event in LINES else None

    def _commit(self, files, build):
        """Replace on the same filesystem; restore previous source and clip if building fails."""
        previous = snapshot(files)
        changed = {path: data for path, data in files.items() if previous[path] != data}
        if not changed:
            return
        with tempfile.TemporaryDirectory(dir=self.root / "tools") as temp:
            staged = {}
            for n, (path, data) in enumerate(changed.items()):
                path.parent.mkdir(parents=True, exist_ok=True)
                prepared = Path(temp) / f"{n}.new"
                prepared.write_bytes(data)
                staged[path] = prepared
            installed = []
            try:
                for path, prepared in staged.items():
                    prepared.replace(path)
                    installed.append(path)
                if build and self.rebuild:
                    result = subprocess.run([sys.executable, str(self.root / "tools/build.py")], cwd=self.root,
                                            capture_output=True, timeout=120, creationflags=HIDE_WINDOW)
                    if result.returncode:
                        reason = result.stderr.decode("utf-8", "replace").strip().splitlines()
                        raise RuntimeError("Не удалось пересобрать игру. " + (reason[-1] if reason else ""))
            except BaseException:
                for path in reversed(installed):
                    if previous[path] is None:
                        path.unlink(missing_ok=True)
                    else:
                        backup = Path(temp) / "restore"
                        backup.write_bytes(previous[path])
                        backup.replace(path)
                raise

    def add_line(self, event, nation, text, overrides, revision):
        text, overrides = validate_text(text), validate_settings(overrides, line=True)
        if not isinstance(event, str) or event not in LINES or nation not in NATIONS:
            raise ValueError("Выберите событие и нацию из каталога.")
        with self._writing():
            edits, _, _ = self._load(revision or "")
            bucket = f"{event}_{nation}"
            key = f"{bucket}/{len(build_catalog(edits)[bucket]) + 1:02d}"
            edits["lines"][key] = {"text": text, "overrides": overrides}
            self._commit({self.edits_path: json_bytes(edits)}, build=True)
            return self.state(), key

    def save_line(self, key, text, overrides, revision):
        text, overrides = validate_text(text), validate_settings(overrides, line=True)
        with self._writing():
            edits, _, _ = self._load(revision or "")
            item = lookup(build_catalog(edits), key)
            edit = edits["lines"].setdefault(key, {})
            edit.update(text=text, overrides=overrides)
            self._commit({self.edits_path: json_bytes(edits)}, build=text != item["voice_text"])
            return self.state()

    def save_nation(self, nation, settings, revision):
        if nation not in NATIONS:
            raise ValueError("Выберите нацию из каталога.")
        settings = validate_settings(settings)
        with self._writing():
            edits, _, _ = self._load(revision or "")
            edits["nations"][nation] = settings
            self._commit({self.edits_path: json_bytes(edits)}, build=False)
            return self.state()

    def _generation(self, key, revision=None):
        edits, receipts, _ = self._load(revision)
        item = lookup(build_catalog(edits), key)
        stamp = version(self.audio_path(key))
        token = hashlib.sha256(json_bytes([recipe_hash(item), stamp, receipts.get(key)])).hexdigest()
        return item, token

    def generation(self, key, revision):
        with self.lock:
            return self._generation(key, revision or "")

    def batch_generation(self, key, item):
        with self.lock:
            current, token = self._generation(key)
            if recipe_hash(current) != recipe_hash(item):
                raise ConflictError("Текст или настройки реплики изменились после запуска генератора.")
            return token

    def install_audio(self, key, fingerprint, mp3, seconds, *, made=None, return_state=True):
        if not isinstance(mp3, bytes) or len(mp3) < 512 or not math.isfinite(seconds) or seconds <= 0:
            raise ValueError("Запись не содержит звука.")
        with self._writing():
            item, token = self._generation(key)
            if fingerprint != token:
                raise ConflictError("Во время озвучки изменились реплика, запись или настройки. Повторите озвучку.")
            edits, receipts, _ = self._load()
            receipt = {"text": item["voice_text"], "model": item["model"], "voice": item["voice"],
                       "recipe": recipe_hash(item), "seconds": round(seconds, 2),
                       "made": made or datetime.date.today().isoformat()}
            receipts[key] = receipt
            edit = edits["lines"].setdefault(key, {})
            edit["recordedText"] = item["voice_text"]
            self._commit({self.audio_path(key): mp3, self.edits_path: json_bytes(edits),
                          self.receipts_path: json_bytes(receipts)}, build=True)
            return self.state() if return_state else receipt
