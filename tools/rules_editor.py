"""Local editor for the chapters, captions, and narration of Admiral."""
import copy
import json
import math
import subprocess
import tempfile
import tkinter as tk
import wave
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
import winsound

from rules_audio import LEAD_IN, PAUSE, RATE, ROOT, decode_audio, publish_rules, script_hash, sha, snapshot, stage_narration


def as_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


class RulesDraft:
    def __init__(self, root):
        self.root = root
        self.script_path = root / "src" / "rules-script.json"
        self.examples_path = root / "src" / "rules-examples.json"
        self.track = root / "assets" / "rules" / "narration.mp3"
        self.sheet = self.track.with_name("timings.json")
        self.original = snapshot((self.script_path, self.examples_path, self.track, self.sheet))
        self.base_script = json.loads(self.original[self.script_path])
        self.base_examples = json.loads(self.original[self.examples_path])
        self.chapters = copy.deepcopy(self.base_script)
        self.examples = copy.deepcopy(self.base_examples)
        self.uploads = {}
        self.decoded = None
        self.cue_count = sum(len(chapter["cues"]) for chapter in self.chapters)
        self.manifest = self.read_manifest()
        self.ends = self.manifest["ends"] if self.manifest else []
        models = self.manifest.get("cueModels", []) if self.manifest else []
        default = self.manifest.get("model", "imported") if self.manifest else "silent"
        self.models = models if len(models) == self.cue_count else [default] * self.cue_count

    def read_manifest(self):
        audio, timing = self.original[self.track], self.original[self.sheet]
        if not (audio and timing):
            return None
        try:
            manifest = json.loads(timing)
            ends = manifest["ends"]
            if (manifest["audioHash"] == sha(audio)
                    and len(ends) == self.cue_count
                    and all(isinstance(end, (float, int)) and math.isfinite(end) and end > start
                            for start, end in zip([0] + ends, ends))):
                return manifest
        except (ValueError, TypeError, KeyError):
            pass
        return None

    @property
    def dirty(self):
        return bool(self.uploads or self.chapters != self.base_script or self.examples != self.base_examples)

    def cue_index(self, chapter, cue):
        return sum(len(item["cues"]) for item in self.chapters[:chapter]) + cue

    def has_audio(self, index):
        return index in self.uploads or self.models[index] != "silent"

    def bounds(self, index):
        start = self.ends[index - 1] if index else 0
        return round(start * RATE) * 2, round(self.ends[index] * RATE) * 2

    def duration(self, index):
        if index in self.uploads:
            return len(self.uploads[index][1]) / (2 * RATE)
        if self.has_audio(index):
            start, end = self.bounds(index)
            return (end - start) / (2 * RATE)
        return 0

    def cache_path(self, audio_hash):
        return self.root / "tools" / "__pycache__" / f"rules-{audio_hash}.pcm"

    def original_pcm(self, index):
        if not self.manifest:
            return b""
        if self.decoded is None:
            cached = self.cache_path(self.manifest["audioHash"])
            if cached.is_file() and abs(cached.stat().st_size - self.bounds(self.cue_count - 1)[1]) <= 30:
                self.decoded = cached.read_bytes()
            else:
                with tempfile.TemporaryDirectory() as directory:
                    source = Path(directory) / self.track.name
                    source.write_bytes(self.original[self.track])
                    self.decoded = decode_audio(source)
        start, end = self.bounds(index)
        return self.decoded[start:end]

    def preview_pcm(self, index):
        if index in self.uploads:
            return self.uploads[index][1]
        return self.original_pcm(index) if self.has_audio(index) else b""

    def save(self):
        for chapter in self.chapters:
            if not (chapter["title"].strip() and chapter["short"].strip() and all(cue.strip() for cue in chapter["cues"])):
                raise ValueError("Заполните название, короткое название и текст каждой реплики.")
        script = self.original[self.script_path] if self.chapters == self.base_script else as_json(self.chapters)
        self.track.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=self.track.parent) as directory:
            staging = Path(directory)
            replacements = {}

            def stage(path, content):
                if content != self.original[path]:
                    prepared = staging / path.name
                    prepared.write_bytes(content)
                    replacements[path] = prepared

            stage(self.script_path, script)
            if self.examples != self.base_examples:
                stage(self.examples_path, as_json(self.examples))
            manifest = self.manifest
            if self.uploads:
                pcm, ends, models = bytearray(), [], []
                cues = [cue for chapter in self.chapters for cue in chapter["cues"]]
                for index, cue in enumerate(cues):
                    if index in self.uploads:
                        part = LEAD_IN + self.uploads[index][1] + PAUSE
                        model = "imported"
                    elif self.manifest:
                        part, model = self.original_pcm(index), self.models[index]
                    else:
                        part, model = bytes(round(max(4, len(cue) / 15) * RATE) * 2), "silent"
                    if not part:
                        raise ValueError(f"Не удалось извлечь аудио для реплики {index + 1}.")
                    pcm.extend(part)
                    ends.append(round(len(pcm) / (2 * RATE), 3))
                    models.append(model)
                track, sheet, manifest = stage_narration(staging, pcm, ends, models, script)
                replacements.update({self.track: track, self.sheet: sheet})
            elif manifest and manifest.get("scriptHash") != script_hash(script):
                manifest = {**manifest, "scriptHash": script_hash(script)}
                stage(self.sheet, as_json(manifest))
            if replacements:
                publish_rules(self.root, replacements, self.original, staging, manifest)
            if self.uploads:
                # Keep the uncompressed master between edits so surviving clips aren't repeatedly decoded from MP3.
                try:
                    cached = staging / "master.pcm"
                    cached.write_bytes(pcm)
                    cached.replace(self.cache_path(manifest["audioHash"]))
                except OSError:
                    pass


BG, PANEL, INK, DIM, GOLD, EDGE = "#0d202b", "#152e3b", "#f2ede0", "#b2c4ca", "#e8bd73", "#375461"
CLIPBOARD_KEYS = {
    ord("A"): "<<SelectAll>>",
    ord("C"): "<<Copy>>",
    ord("V"): "<<Paste>>",
    ord("X"): "<<Cut>>",
}


def clipboard_shortcut(event):
    # Tk's default bindings use Latin keysyms. Windows virtual keys also match in the Russian layout.
    if event.state & (0x0008 | 0x20000):  # Alt / AltGr
        return None
    action = CLIPBOARD_KEYS.get(event.keycode)
    if action:
        event.widget.event_generate(action)
        return "break"
    return None


class RulesEditor:
    def __init__(self, window, root=ROOT):
        self.window, self.root = window, root
        self.draft = RulesDraft(root)
        self.chapter = self.cue = 0
        self.loading = True
        self.busy = False
        self.play_timer = None
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.scratch = tempfile.TemporaryDirectory()
        self.window.title("Адмирал · Редактор обучения")
        self.window.geometry("1120x755")
        self.window.minsize(850, 690)
        self.window.configure(background=BG)
        self.window.protocol("WM_DELETE_WINDOW", self.close)
        self.window.bind("<Control-s>", lambda _: self.save())

        self.title = tk.StringVar(window)
        self.short = tk.StringVar(window)
        self.example = tk.StringVar(window)
        self.status = tk.StringVar(window)
        self.audio_info = tk.StringVar(window)
        self.scene_title = tk.StringVar(window)
        self.configure_style()
        self.create_widgets()
        self.load_fields(0, 0)

    def configure_style(self):
        style = ttk.Style(self.window)
        style.theme_use("clam")
        style.configure(".", font=("Segoe UI", 10), background=BG, foreground=INK)
        style.configure("TButton", padding=(13, 8), background=PANEL, bordercolor=EDGE, lightcolor=PANEL, darkcolor=PANEL)
        style.map("TButton", background=[("active", "#23485a")], foreground=[("disabled", "#82949a")])
        style.configure("Accent.TButton", background=GOLD, foreground="#172733", bordercolor=GOLD)
        style.map("Accent.TButton", background=[("disabled", "#3b4146"), ("active", "#f5ce8a")],
                  foreground=[("disabled", DIM)])
        style.configure("Nav.TButton", anchor="w", padding=(12, 10), background=BG, bordercolor=BG)
        style.configure("Selected.TButton", anchor="w", padding=(12, 10), background="#263e46",
                        foreground=GOLD, bordercolor=GOLD)
        style.configure("TEntry", fieldbackground="#0d2430", foreground=INK, insertcolor=INK,
                        bordercolor=EDGE, padding=(8, 6))
        style.map("TEntry", bordercolor=[("focus", GOLD)])

    def label(self, parent, text="", *, variable=None, size=10, bold=False, color=INK, bg=BG):
        return tk.Label(parent, text=text, textvariable=variable, foreground=color, background=bg,
                        anchor="w", font=("Segoe UI", size, "bold" if bold else "normal"))

    def create_widgets(self):
        header = tk.Frame(self.window, bg=BG, padx=24, pady=16)
        header.pack(fill="x")
        self.label(header, "Редактор обучения", size=22, bold=True).pack(side="left")
        self.open_game = ttk.Button(header, text="Открыть игру ↗", command=self.show_game)
        self.open_game.pack(side="right")

        main = tk.Frame(self.window, bg=BG, padx=24)
        main.pack(fill="both", expand=True)
        main.columnconfigure(1, weight=1)
        main.rowconfigure(0, weight=1)
        sidebar = tk.Frame(main, bg=BG)
        sidebar.grid(row=0, column=0, sticky="nsw", padx=(0, 19))
        self.label(sidebar, "Главы", size=11, bold=True, color=GOLD).pack(fill="x", pady=(4, 8))
        self.nav = []
        for index in range(len(self.draft.chapters)):
            button = ttk.Button(sidebar, width=20, style="Nav.TButton", command=lambda i=index: self.select(i, 0))
            button.pack(fill="x", pady=(0, 3))
            self.nav.append(button)

        body = tk.Frame(main, bg=PANEL, padx=20, pady=16, highlightbackground=EDGE, highlightthickness=1)
        body.grid(row=0, column=1, sticky="nsew")
        self.label(body, variable=self.scene_title, size=15, bold=True, color=GOLD, bg=PANEL).pack(fill="x", pady=(0, 9))
        chapter = tk.Frame(body, bg=PANEL)
        chapter.pack(fill="x")
        chapter.columnconfigure(0, weight=3, uniform="fields")
        chapter.columnconfigure(1, weight=2, uniform="fields")
        self.title_entry = self.entry_field(chapter, "Заголовок главы", self.title, 0)
        self.short_entry = self.entry_field(chapter, "Название в навигации", self.short, 1)

        self.tabs = tk.Frame(body, bg=PANEL)
        self.tabs.pack(fill="x", pady=(16, 10))
        self.tab_buttons = []
        self.label(body, "Текст реплики и субтитров", bold=True, bg=PANEL).pack(fill="x", pady=(0, 4))
        text_frame = tk.Frame(body, bg=EDGE, padx=1, pady=1)
        text_frame.pack(fill="both", expand=True)
        self.text = tk.Text(text_frame, height=5, wrap="word", undo=True, padx=9, pady=8, relief="flat",
                            bg="#0d2430", fg=INK, insertbackground=INK, font=("Segoe UI", 11))
        scroll = ttk.Scrollbar(text_frame, orient="vertical", command=self.text.yview)
        self.text.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        self.text.pack(side="left", fill="both", expand=True)
        self.text.bind("<<Modified>>", self.text_changed)
        self.label(body, "Подпись под иллюстрацией", bold=True, bg=PANEL).pack(fill="x", pady=(12, 4))
        self.example_entry = ttk.Entry(body, textvariable=self.example)
        self.example_entry.pack(fill="x")
        for field in (self.text, self.title_entry, self.short_entry, self.example_entry):
            field.bind("<Control-KeyPress>", clipboard_shortcut)
        self.text_menu = tk.Menu(self.text, tearoff=False)
        for label, action in (
            ("Вырезать", "<<Cut>>"),
            ("Копировать", "<<Copy>>"),
            ("Вставить", "<<Paste>>"),
            ("Выделить всё", "<<SelectAll>>"),
        ):
            self.text_menu.add_command(label=label, command=lambda operation=action: self.text.event_generate(operation))
        self.text.bind("<<ContextMenu>>", self.show_text_menu)

        ttk.Separator(body).pack(fill="x", pady=(14, 11))
        self.label(body, "Озвучка реплики", bold=True, bg=PANEL).pack(fill="x")
        audio_status = self.label(body, variable=self.audio_info, color=DIM, bg=PANEL)
        audio_status.pack(fill="x", pady=(3, 8))
        audio_status.bind("<Configure>", lambda e: audio_status.configure(wraplength=e.width))
        controls = tk.Frame(body, bg=PANEL)
        controls.pack(fill="x")
        self.listen = ttk.Button(controls, text="▶ Прослушать", command=self.preview)
        self.listen.pack(side="left")
        self.upload = ttk.Button(controls, text="Загрузить WAV или MP3…", command=self.choose_audio)
        self.upload.pack(side="left", padx=7)
        self.undo = ttk.Button(controls, text="Отменить замену", command=self.undo_audio)
        self.undo.pack(side="left")

        footer = tk.Frame(self.window, bg=BG, padx=24, pady=14)
        footer.pack(fill="x")
        self.label(footer, variable=self.status, color=DIM).pack(side="left", fill="x", expand=True)
        self.save_button = ttk.Button(footer, text="Сохранить в игру", style="Accent.TButton", command=self.save)
        self.save_button.pack(side="right")
        for value in (self.title, self.short, self.example):
            value.trace_add("write", lambda *_: self.changed())

    def entry_field(self, parent, label, variable, column):
        field = tk.Frame(parent, bg=PANEL)
        field.grid(row=0, column=column, sticky="ew", padx=(0, 12) if column == 0 else (0, 0))
        self.label(field, label, bold=True, bg=PANEL).pack(fill="x", pady=(0, 4))
        entry = ttk.Entry(field, textvariable=variable)
        entry.pack(fill="x")
        return entry

    def load_fields(self, chapter, cue):
        self.loading = True
        self.chapter, self.cue = chapter, cue
        item = self.draft.chapters[chapter]
        self.scene_title.set(f"Глава {chapter + 1} из {len(self.draft.chapters)}")
        self.title.set(item["title"])
        self.short.set(item["short"])
        self.text.delete("1.0", "end")
        self.text.insert("1.0", item["cues"][cue])
        self.text.edit_reset()
        self.text.edit_modified(False)
        self.example.set(self.draft.examples[item["id"]][cue])
        for button in self.tab_buttons:
            button.destroy()
        self.tab_buttons = []
        for index in range(len(item["cues"])):
            button = ttk.Button(self.tabs, text=f"Реплика {index + 1}",
                                style="Selected.TButton" if index == cue else "Nav.TButton",
                                command=lambda i=index: self.select(self.chapter, i))
            button.pack(side="left", padx=(0, 5))
            self.tab_buttons.append(button)
        self.loading = False
        self.refresh()

    def select(self, chapter, cue):
        if not self.busy and (chapter, cue) != (self.chapter, self.cue):
            self.changed()
            self.stop_preview()
            self.load_fields(chapter, cue)

    def text_changed(self, _event):
        if self.text.edit_modified():
            self.text.edit_modified(False)
            self.changed()

    def show_text_menu(self, event):
        self.text.focus_set()
        selected = bool(self.text.tag_ranges("sel"))
        editable = self.text.cget("state") == "normal"
        if editable and not selected:
            self.text.mark_set("insert", f"@{event.x},{event.y}")
        self.text_menu.entryconfigure("Вырезать", state="normal" if selected and editable else "disabled")
        self.text_menu.entryconfigure("Копировать", state="normal" if selected else "disabled")
        self.text_menu.entryconfigure("Вставить", state="normal" if editable else "disabled")
        try:
            self.text_menu.tk_popup(event.x_root, event.y_root)
        finally:
            self.text_menu.grab_release()
        return "break"

    def changed(self):
        if self.loading:
            return
        item = self.draft.chapters[self.chapter]
        item["title"], item["short"] = self.title.get(), self.short.get()
        item["cues"][self.cue] = self.text.get("1.0", "end-1c")
        self.draft.examples[item["id"]][self.cue] = self.example.get()
        self.refresh()

    def index(self):
        return self.draft.cue_index(self.chapter, self.cue)

    def refresh(self):
        index = self.index()
        pending = self.draft.uploads.get(index)
        has_audio = self.draft.has_audio(index)
        if pending:
            name = pending[0]
        elif has_audio:
            name = "Текущая запись"
        else:
            name = "Аудиофайл не загружен"
        item = self.draft.chapters[self.chapter]["cues"][self.cue]
        base = self.draft.base_script[self.chapter]["cues"][self.cue]
        suffix = f" · {self.draft.duration(index):.1f} с" if has_audio else ""
        if not pending and has_audio and item != base:
            suffix += " · текст изменён, запись прежняя"
        self.audio_info.set(name + suffix)
        if not self.busy:
            self.status.set("Есть несохранённые изменения" if self.draft.dirty else "Изменения сохранены")
        for i, (button, chapter) in enumerate(zip(self.nav, self.draft.chapters)):
            button.configure(text=f"{i + 1:02d}   {chapter['short'][:22]}", style="Selected.TButton" if i == self.chapter else "Nav.TButton")
        self.listen.configure(state="normal" if has_audio and not self.busy else "disabled")
        self.undo.configure(state="normal" if pending and not self.busy else "disabled")
        self.save_button.configure(state="normal" if self.draft.dirty and not self.busy else "disabled")

    def run(self, status, work, done):
        self.busy = True
        self.status.set(status)
        widgets = (*self.nav, *self.tab_buttons, self.text, self.title_entry, self.short_entry, self.example_entry, self.upload, self.open_game)
        for widget in widgets:
            widget.configure(state="disabled")
        self.refresh()
        future = self.pool.submit(work)

        def poll():
            if not future.done():
                self.window.after(50, poll)
                return
            self.busy = False
            for widget in widgets:
                widget.configure(state="normal")
            self.refresh()
            try:
                done(future.result())
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                if isinstance(error, subprocess.CalledProcessError) and error.stderr:
                    raw = error.stderr
                    info = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
                    description = info.strip().splitlines()[-1] if info.strip() else str(error)
                else:
                    description = str(error)
                messagebox.showerror("Не удалось выполнить действие", description, parent=self.window)

        self.window.after(50, poll)

    def choose_audio(self):
        name = filedialog.askopenfilename(parent=self.window, title="Выберите озвучку для реплики",
                                          filetypes=[("Аудио WAV и MP3", "*.wav *.mp3"), ("WAV", "*.wav"), ("MP3", "*.mp3")])
        if not name:
            return
        path = Path(name)
        format_name = path.suffix.lower().lstrip(".")
        if format_name not in ("wav", "mp3"):
            messagebox.showerror("Формат файла", "Выберите файл WAV или MP3.", parent=self.window)
            return
        self.stop_preview()
        index = self.index()

        def done(pcm):
            if not pcm:
                raise ValueError("В файле нет аудиоданных.")
            self.draft.uploads[index] = (path.name, pcm)
            self.refresh()

        self.run("Читаю аудиофайл…", lambda: decode_audio(path, format_name), done)

    def undo_audio(self):
        self.stop_preview()
        self.draft.uploads.pop(self.index(), None)
        self.refresh()

    def preview(self):
        if self.play_timer is not None:
            self.stop_preview()
            return
        index = self.index()
        target = Path(self.scratch.name) / "preview.wav"

        def work():
            pcm = self.draft.preview_pcm(index)
            if not pcm:
                raise ValueError("В этой реплике нет аудио.")
            with wave.open(str(target), "wb") as output:
                output.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
                output.writeframes(pcm)
            return len(pcm) / (2 * RATE)

        def done(seconds):
            winsound.PlaySound(str(target), winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)
            self.listen.configure(text="■ Остановить")
            self.play_timer = self.window.after(round(seconds * 1000) + 100, self.stop_preview)

        self.run("Готовлю прослушивание…", work, done)

    def stop_preview(self):
        if self.play_timer is not None:
            self.window.after_cancel(self.play_timer)
            self.play_timer = None
            winsound.PlaySound(None, 0)
            self.listen.configure(text="▶ Прослушать")

    def save(self):
        if self.busy:
            return
        self.changed()
        if not self.draft.dirty:
            return
        self.stop_preview()

        def done(_):
            self.draft = RulesDraft(self.root)
            self.load_fields(self.chapter, self.cue)
            self.status.set("Сохранено. Игра пересобрана.")

        self.run("Сохраняю тексты, озвучку и сборку…", self.draft.save, done)

    def show_game(self):
        self.stop_preview()
        webbrowser.open((self.root / "admiral-3d.html").as_uri())

    def close(self):
        if self.busy:
            return
        self.changed()
        if self.draft.dirty and not messagebox.askyesno(
                "Несохранённые изменения", "Закрыть редактор без сохранения?", parent=self.window):
            return
        self.stop_preview()
        self.pool.shutdown(wait=False)
        self.scratch.cleanup()
        self.window.destroy()


if __name__ == "__main__":
    window = tk.Tk()
    window.withdraw()
    try:
        editor = RulesEditor(window)
    except (OSError, ValueError, TypeError, KeyError) as error:
        messagebox.showerror("Не удалось открыть редактор", str(error), parent=window)
        window.destroy()
    else:
        window.deiconify()
        window.mainloop()
