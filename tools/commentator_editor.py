"""Local browser editor for Admiral's commentator. Start with commentator-editor.cmd."""
import argparse
import errno
import hashlib
import json
import re
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen

from commentator_store import CommentatorStore, ConflictError
from commentator_tts import synthesize

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PORT = 8784
KEY = re.compile(r"[a-z0-9_]+_(?:ru|en|se|nl)/[0-9]{2,}")
STATIC = {
    "/": ("tools/commentator_editor_ui/index.html", "text/html; charset=utf-8"),
    "/editor.js": ("tools/commentator_editor_ui/editor.js", "text/javascript; charset=utf-8"),
    "/editor.css": ("tools/commentator_editor_ui/editor.css", "text/css; charset=utf-8"),
    "/assets/rules/fleet.webp": ("assets/rules/fleet.webp", "image/webp"),
}
MAX_BODY = 512 * 1024


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def line_key(data):
    bucket = f"{data.get('event')}_{data.get('nation')}"
    variant = data.get("id")
    if not isinstance(variant, str):
        raise ValueError("Выберите вариант реплики.")
    key = variant if "/" in variant else f"{bucket}/{variant}"
    if not KEY.fullmatch(key) or key.split("/")[0] != bucket:
        raise ValueError("Вариант реплики не соответствует событию и нации.")
    return key


def workspace_id(root):
    return hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:16]


class EditorServer(ThreadingHTTPServer):
    # Windows otherwise allows a second launcher to bind the active editor's port.
    allow_reuse_address = sys.platform != "win32"

    def __init__(self, port, root=ROOT, store=None, tts=synthesize):
        self.root = root
        self.store = store if store is not None else CommentatorStore(root)
        self.tts = tts
        self.generating = set()
        self.generating_lock = threading.Lock()
        super().__init__(("127.0.0.1", port), EditorHandler)

    def generate(self, key, revision):
        with self.generating_lock:
            if key in self.generating:
                raise RequestError(409, "Эта реплика уже озвучивается. Дождитесь окончания записи.")
            self.generating.add(key)
        try:
            item, fingerprint = self.store.generation(key, revision)
            try:
                mp3, seconds = self.tts(item, self.root / "gemini")
            except RuntimeError as err:
                raise RequestError(502, str(err)) from err
            return self.store.install_audio(key, fingerprint, mp3, seconds)
        finally:
            with self.generating_lock:
                self.generating.discard(key)


class EditorHandler(BaseHTTPRequestHandler):
    server_version = "AdmiralEditor/1"

    def send_bytes(self, status, body, content_type, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; "
                         "media-src 'self' blob:; img-src 'self' data:; object-src 'none'; "
                         "base-uri 'none'; frame-ancestors 'none'")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_bytes(status, body, "application/json; charset=utf-8")

    def validate_origin(self):
        port = self.server.server_port
        host = self.headers.get("Host", "").lower()
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if port == 80:
            allowed.update(("127.0.0.1", "localhost"))
        if host not in allowed:
            raise RequestError(403, "Откройте редактор по локальному адресу.")
        origin = self.headers.get("Origin")
        if origin is not None and origin.lower() != f"http://{host}":
            raise RequestError(403, "Запрос должен исходить из редактора.")

    def read_json(self):
        if self.headers.get_content_type() != "application/json":
            raise RequestError(415, "Ожидается запрос в формате JSON.")
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise RequestError(400, "Неверная длина запроса.") from None
        if not 0 < size <= MAX_BODY:
            raise RequestError(413, "Пустой или слишком большой запрос.")
        try:
            data = json.loads(self.rfile.read(size).decode("utf-8"))
        except (ValueError, RecursionError):
            raise RequestError(400, "Не удалось прочитать JSON.") from None
        if not isinstance(data, dict) or not isinstance(data.get("revision"), str):
            raise RequestError(400, "Требуется версия открытого каталога.")
        return data

    def post(self, path):
        if path not in {"/api/line", "/api/nation", "/api/generate"}:
            raise RequestError(404, "Страница не найдена.")
        data = self.read_json()
        store = self.server.store
        revision = data["revision"]
        nation = data.get("nation")
        if not isinstance(nation, str):
            raise ValueError("Выберите нацию.")
        if path == "/api/nation":
            settings = data.get("settings")
            if not isinstance(settings, dict):
                raise ValueError("Требуются настройки комментатора.")
            state = store.save_nation(nation, settings, revision)
        else:
            event = data.get("event")
            if not isinstance(event, str):
                raise ValueError("Выберите игровое событие.")
            if path == "/api/generate":
                key = line_key(data)
                state = self.server.generate(key, revision)
            else:
                text, overrides = data.get("text"), data.get("overrides")
                if not isinstance(text, str) or not isinstance(overrides, dict):
                    raise ValueError("Требуются текст и настройки реплики.")
                if data.get("id") is None:
                    state, key = store.add_line(event, nation, text, overrides, revision)
                else:
                    key = line_key(data)
                    state = store.save_line(key, text, overrides, revision)
            state = {**state, "selectedId": key}
        self.send_json(200, state)

    def send_audio(self, key):
        if not KEY.fullmatch(key):
            raise RequestError(404, "Запись не найдена.")
        path = self.server.store.audio_path(key)
        if not path or not path.is_file():
            raise RequestError(404, "У реплики пока нет записи.")
        body = path.read_bytes()
        size = len(body)
        headers = {"Accept-Ranges": "bytes"}
        requested = self.headers.get("Range")
        if requested is None:
            self.send_bytes(200, body, "audio/mpeg", headers)
            return
        match = re.fullmatch(r"bytes=([0-9]{0,16})-([0-9]{0,16})", requested)
        if match and any(match.groups()):
            first, last = match.groups()
            start = int(first) if first else max(0, size - int(last))
            end = min(int(last), size - 1) if first and last else size - 1
            if start <= end:
                headers["Content-Range"] = f"bytes {start}-{end}/{size}"
                self.send_bytes(206, body[start:end + 1], "audio/mpeg", headers)
                return
        self.send_bytes(416, b"", "audio/mpeg", {"Content-Range": f"bytes */{size}"})

    def get(self, path):
        if path == "/api/catalog":
            self.send_json(200, self.server.store.state())
        elif path == "/api/health":
            self.send_json(200, {"editor": "admiral-commentator", "workspace": workspace_id(self.server.root)})
        elif path in STATIC:
            filename, content_type = STATIC[path]
            self.send_bytes(200, (self.server.root / filename).read_bytes(), content_type)
        elif path.startswith("/audio/") and path.endswith(".mp3"):
            self.send_audio(path[len("/audio/"):-len(".mp3")])
        elif path == "/favicon.ico":
            self.send_bytes(204, b"", "image/x-icon")
        else:
            raise RequestError(404, "Страница не найдена.")

    def dispatch(self):
        try:
            self.validate_origin()
            path = urlsplit(self.path).path
            if self.command == "POST":
                self.post(path)
            else:
                self.get(path)
        except RequestError as err:
            self.send_json(err.status, {"error": str(err)})
        except ConflictError as err:
            self.send_json(409, {"error": str(err)})
        except ValueError as err:
            self.send_json(400, {"error": str(err)})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except RuntimeError as err:
            self.send_json(500, {"error": str(err)})
        except Exception as err:
            self.log_error("Ошибка обработки запроса: %s", type(err).__name__)
            self.send_json(500, {"error": "Не удалось обработать запрос. Проверьте файлы проекта и права записи."})

    do_GET = do_HEAD = do_POST = dispatch


def open_existing(port):
    url = f"http://127.0.0.1:{port}/"
    try:
        with urlopen(url + "api/health", timeout=1) as response:
            health = json.loads(response.read(1024))
        if health == {"editor": "admiral-commentator", "workspace": workspace_id(ROOT)}:
            webbrowser.open(url)
            return True
    except (OSError, ValueError):
        pass
    return False


def main():
    parser = argparse.ArgumentParser(description="Браузерный редактор реплик комментатора «Адмирала»")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true", help="только запустить сервер")
    args = parser.parse_args()
    try:
        server = EditorServer(args.port)
    except OSError as err:
        if err.errno in (errno.EADDRINUSE, 10048) and not args.no_browser and open_existing(args.port):
            return
        parser.exit(1, f"Не удалось открыть локальный порт {args.port}. Можно указать другой через --port.\n")
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"Редактор комментатора: {url}\nДля остановки нажмите Ctrl+C.", flush=True)
    with server:
        if not args.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
