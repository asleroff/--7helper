#!/usr/bin/env python3
"""Minimal draft API for Turbo PVZ Chrome extension.

Endpoints:
  GET  /health
  POST /api/drafts              — save draft (latest wins per point_number)
                                publish=true also sends the report to the point chat
  GET  /api/drafts/{point}      — get latest draft for PP
  GET  /api/drafts/{point}/text — rendered closing text preview

Auth: Authorization: Bearer <EXTENSION_API_TOKEN>
The bot token is read only on this server, never sent to the extension.
"""

from __future__ import annotations

import html
import json
import os
import re
import secrets
import socket
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

TTL_SECONDS = int(os.environ.get("DRAFT_TTL_SECONDS", str(48 * 3600)))
HOST = os.environ.get("API_HOST", "0.0.0.0")
PORT = int(os.environ.get("API_PORT", "8787"))


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key, val = key.strip(), val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


load_dotenv(ROOT / ".env")
SEVEN_BOT = ROOT.parent.parent / "sevenBot"
load_dotenv(SEVEN_BOT / ".env")
API_TOKEN = os.environ.get("EXTENSION_API_TOKEN", "dev-extension-token-change-me")
BOT_DB = SEVEN_BOT / "bot_database.db"
_bot_username: str | None = None

REQUIRED_CLOSING = (
    ("transport_number", "номер перевозки"),
    ("transport_date", "дата перевозки"),
    ("closing_time", "время закрытия"),
    ("accepted_total", "принято"),
    ("tya", "ТЯ"),
    ("ktya", "КТЯ"),
    ("shortage", "недостачи"),
    ("excess", "излишки"),
    ("zasyl", "засылы"),
    ("issued", "выдано"),
    ("leftover", "остатки"),
)

_lock = threading.Lock()


def draft_path(point: str) -> Path:
    safe = re.sub(r"[^\d]", "", point)
    if not safe:
        raise ValueError("invalid point")
    return DATA_DIR / f"pp_{safe}.json"


def is_expired(doc: dict) -> bool:
    saved = doc.get("saved_at") or doc.get("draft", {}).get("collected_at")
    if not saved:
        return False
    try:
        ts = datetime.fromisoformat(saved.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return False
    return (time.time() - ts) > TTL_SECONDS


def render_text(draft: dict) -> str:
    c = draft.get("closing") or {}
    point = draft.get("point_number", "?")

    def dash(v):
        return "—" if v is None or v == "" else v

    return "\n".join(
        [
            f"ПП-{point}",
            "",
            f"Закрыли перевозку #{dash(c.get('transport_number'))} от {dash(c.get('transport_date'))}.",
            "",
            f"Закрыли перевозку в {dash(c.get('closing_time'))}",
            "",
            f"Принято всего: {dash(c.get('accepted_total'))} ед.",
            "",
            f"1) ТЯ: {dash(c.get('tya'))}",
            f"2) КТЯ: {dash(c.get('ktya'))}",
            f"3) Недостачи: {dash(c.get('shortage'))}",
            f"4) Излишки: {dash(c.get('excess'))}",
            f"5) Засылы: {dash(c.get('zasyl'))}",
            "",
            f"Выдано: {dash(c.get('issued'))} ед.",
            "",
            f"Остатки на складе: {dash(c.get('leftover'))} ед.",
            "",
            "ПП - закрыто.",
        ]
    )


class PublishError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def missing_closing(draft: dict) -> list[str]:
    closing = draft.get("closing") or {}
    missing = []
    for key, label in REQUIRED_CLOSING:
        value = closing.get(key)
        if value is None or value == "":
            missing.append(label)
    return missing


def report_for_chat(draft: dict, sender_username: str) -> str:
    who = sender_username.strip().lstrip("@")
    sender = f"@{who}" if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", who) else "автоотправка"
    return f"{render_text(draft)}\nОтчет от: {sender}\nС помощью @{bot_username()}"


def bot_username() -> str:
    global _bot_username
    if _bot_username:
        return _bot_username
    token = os.environ.get("BOT_TOKEN", "")
    if not token:
        raise PublishError("Автоотправка в чат не настроена: у API нет токена бота.", 500)
    payload = telegram_call("getMe", {})
    name = str((payload.get("result") or {}).get("username") or "").strip()
    if not name:
        raise PublishError("Telegram не вернул имя бота.", 502)
    _bot_username = name
    return name


def telegram_call(method: str, payload: dict) -> dict:
    token = os.environ.get("BOT_TOKEN", "")
    if not token:
        raise PublishError("Автоотправка в чат не настроена: у API нет токена бота.", 500)
    url = f"https://api.telegram.org/bot{token}/{method}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw).get("description") or raw[:200]
        except json.JSONDecodeError:
            detail = raw[:200]
        raise PublishError(f"Telegram: {detail}", 502) from exc
    except urllib.error.URLError as exc:
        raise PublishError(f"Telegram недоступен: {exc.reason}", 502) from exc
    if not body.get("ok"):
        raise PublishError(f"Telegram: {body.get('description') or 'ошибка'}", 502)
    return body


def point_chat_id(point: str) -> int:
    if not BOT_DB.exists():
        raise PublishError("База бота не найдена. Сначала запустите бота и привяжите пункт.", 500)
    with sqlite3.connect(BOT_DB) as con:
        row = con.execute(
            "SELECT chat_id FROM points WHERE point_number = ?",
            (point,),
        ).fetchone()
    if not row or row[0] is None:
        raise PublishError(
            f"ПП {point} не привязан к чату. В боте выполните /add_chat_to_pp.",
            409,
        )
    return int(row[0])


def remember_report(point: str, text: str, closing: dict, report_type: str = "closing") -> None:
    if not BOT_DB.exists():
        return
    with sqlite3.connect(BOT_DB) as con:
        con.execute(
            """INSERT INTO reports
               (point_number, report_type, user_id, data, accepted, issued, leftover, created_at)
               VALUES (?, ?, 0, ?, ?, ?, ?, ?)""",
            (
                point,
                report_type,
                text,
                closing.get("accepted_total"),
                closing.get("issued"),
                closing.get("leftover"),
                datetime.now().isoformat(),
            ),
        )


LINKS_PATH = DATA_DIR / "telegram_links.json"
_pending_links: dict[str, dict] = {}
_link_requested_at: dict[str, float] = {}


def clean_username(value: str) -> str:
    name = str(value or "").strip().lstrip("@")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", name):
        raise PublishError("Нужен username Telegram без @, например petyunyka.", 400)
    return name


def find_telegram_user(username: str) -> tuple[int, str]:
    if not BOT_DB.exists():
        raise PublishError("База бота не найдена. Сначала запустите бота.", 500)
    with sqlite3.connect(BOT_DB) as con:
        row = con.execute(
            "SELECT user_id, username FROM users WHERE username = ? COLLATE NOCASE",
            (username,),
        ).fetchone()
    if not row or row[0] is None or not row[1]:
        raise PublishError(
            "Этот username не найден. Откройте бота в Telegram, нажмите /start и запросите код снова.",
            404,
        )
    return int(row[0]), str(row[1])


def request_link_code(username: str) -> None:
    canonical_input = clean_username(username)
    user_id, canonical = find_telegram_user(canonical_input)
    key = canonical.lower()
    now = time.time()
    with _lock:
        last = _link_requested_at.get(key, 0)
        if now - last < 60 and key in _pending_links:
            raise PublishError("Код уже отправлен. Подождите минуту и проверьте сообщения бота.", 429)
        code = f"{secrets.randbelow(100000):05d}"
        _pending_links[key] = {
            "code": code,
            "user_id": user_id,
            "username": canonical,
            "expires": now + 600,
            "attempts": 0,
        }
    try:
        telegram_call(
            "sendMessage",
            {
                "chat_id": user_id,
                "text": (
                    f"Код привязки расширения: {code}\n"
                    "Никому его не сообщайте. Код действует 10 минут."
                ),
            },
        )
    except PublishError as exc:
        with _lock:
            _pending_links.pop(key, None)
        detail = str(exc).lower()
        if "forbidden" in detail or "chat not found" in detail or "initiate conversation" in detail:
            raise PublishError(
                "Бот не смог написать вам. Откройте его в Telegram и нажмите /start.",
                409,
            ) from exc
        raise
    with _lock:
        _link_requested_at[key] = time.time()


def _load_links() -> dict:
    if not LINKS_PATH.exists():
        return {}
    try:
        data = json.loads(LINKS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _save_links(data: dict) -> None:
    LINKS_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def confirm_link_code(username: str, code: str) -> dict:
    name = clean_username(username)
    digits = re.sub(r"\D", "", str(code or ""))
    if not re.fullmatch(r"\d{5}", digits):
        raise PublishError("Код — это 5 цифр из сообщения бота.", 400)
    key = name.lower()
    with _lock:
        pending = _pending_links.get(key)
        if not pending or pending["expires"] < time.time():
            _pending_links.pop(key, None)
            raise PublishError("Код устарел или не запрашивался. Запросите новый.", 400)
        if pending["code"] != digits:
            pending["attempts"] = int(pending["attempts"]) + 1
            if pending["attempts"] >= 5:
                _pending_links.pop(key, None)
                raise PublishError("Слишком много попыток. Запросите новый код.", 400)
            raise PublishError("Неверный код.", 400)
        token = secrets.token_urlsafe(24)
        links = _load_links()
        links[token] = {
            "user_id": pending["user_id"],
            "username": pending["username"],
            "linked_at": datetime.now(timezone.utc).isoformat(),
        }
        _save_links(links)
        linked_name = pending["username"]
        _pending_links.pop(key, None)
    return {"username": linked_name, "link_token": token}


def username_from_link(token: str) -> str:
    token = str(token or "").strip()
    if not token:
        return ""
    with _lock:
        row = _load_links().get(token)
    if not isinstance(row, dict):
        return ""
    return str(row.get("username") or "")


def publish_report(point: str, draft: dict, link_token: str) -> str:
    gaps = missing_closing(draft)
    if gaps:
        raise PublishError("Нельзя отправить в чат. Не хватает: " + ", ".join(gaps), 400)
    sender = username_from_link(link_token)
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", sender):
        raise PublishError(
            "Отправка в чат доступна только после привязки Telegram в расширении.",
            403,
        )
    text = report_for_chat(draft, sender)
    telegram_call(
        "sendMessage",
        {
            "chat_id": point_chat_id(point),
            "text": html.escape(text),
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
    )
    try:
        remember_report(point, text, draft.get("closing") or {})
    except sqlite3.Error as exc:
        print(f"report save failed: {exc}")
    return text


def publish_machine(point: str, when: str, link_token: str) -> str:
    sender = username_from_link(link_token)
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", sender):
        raise PublishError("Отправка доступна только после привязки Telegram в расширении.", 403)
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", when):
        raise PublishError("Время нужно в виде ЧЧ:ММ, например 14:30.", 400)
    text = (
        f"ПП_{point}\n"
        "Приехала машина\n"
        f"Время: {when}\n"
        f"Отчет от: @{sender}\n"
        f"С помощью @{bot_username()}"
    )
    telegram_call(
        "sendMessage",
        {
            "chat_id": point_chat_id(point),
            "text": html.escape(text),
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
    )
    try:
        remember_report(point, text, {}, "machine")
    except sqlite3.Error as exc:
        print(f"report save failed: {exc}")
    return text


class Handler(BaseHTTPRequestHandler):
    server_version = "TurboDraftAPI/0.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

    def _cors(self) -> None:
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _text(self, code: int, text: str) -> None:
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _auth(self) -> bool:
        auth = self.headers.get("Authorization", "")
        if auth == f"Bearer {API_TOKEN}":
            return True
        self._json(401, {"error": "unauthorized"})
        return False

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = unquote(self.path.split("?", 1)[0])
        if path == "/health":
            self._json(200, {"ok": True, "ttl_seconds": TTL_SECONDS})
            return
        if not self._auth():
            return

        m = re.fullmatch(r"/api/drafts/(\d+)(/text)?", path)
        if not m:
            self._json(404, {"error": "not found"})
            return
        point, as_text = m.group(1), m.group(2)
        path_file = draft_path(point)
        with _lock:
            if not path_file.exists():
                self._json(404, {"error": "draft not found", "point_number": point})
                return
            doc = json.loads(path_file.read_text(encoding="utf-8"))
            if is_expired(doc):
                path_file.unlink(missing_ok=True)
                self._json(404, {"error": "draft expired", "point_number": point})
                return
        draft = doc.get("draft") or doc
        if as_text:
            self._text(200, render_text(draft))
            return
        self._json(
            200,
            {
                "point_number": point,
                "saved_at": doc.get("saved_at"),
                "draft": draft,
                "preview_text": render_text(draft),
            },
        )

    def _read_body(self) -> dict | None:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return None
        if not isinstance(data, dict):
            self._json(400, {"error": "invalid json"})
            return None
        return data

    def do_POST(self) -> None:  # noqa: N802
        path = unquote(self.path.split("?", 1)[0])
        if path not in {"/api/drafts", "/api/link/request", "/api/link/confirm", "/api/machine"}:
            self._json(404, {"error": "not found"})
            return
        if not self._auth():
            return
        payload = self._read_body()
        if payload is None:
            return
        if path == "/api/link/request":
            try:
                request_link_code(str(payload.get("username") or ""))
            except PublishError as exc:
                self._json(exc.status, {"error": str(exc)})
                return
            self._json(200, {"ok": True})
            return
        if path == "/api/link/confirm":
            try:
                linked = confirm_link_code(
                    str(payload.get("username") or ""),
                    str(payload.get("code") or ""),
                )
            except PublishError as exc:
                self._json(exc.status, {"error": str(exc)})
                return
            self._json(200, {"ok": True, **linked})
            return
        if path == "/api/machine":
            point = re.sub(r"\D", "", str(payload.get("point_number") or ""))
            if not re.fullmatch(r"\d{3,6}", point):
                self._json(400, {"error": "Нужен номер ПП из шапки Турбо."})
                return
            try:
                text = publish_machine(
                    point,
                    str(payload.get("time") or "").strip(),
                    str(payload.get("link_token") or ""),
                )
            except PublishError as exc:
                self._json(exc.status, {"error": str(exc)})
                return
            self._json(200, {"ok": True, "point_number": point, "text": text})
            return

        draft = payload

        point = str(draft.get("point_number") or "").strip()
        if not re.fullmatch(r"\d{3,6}", point):
            self._json(400, {"error": "point_number required (3–6 digits)"})
            return
        if draft.get("source") != "turbo-pvz":
            draft["source"] = "turbo-pvz"
        if "closing" not in draft or not isinstance(draft["closing"], dict):
            self._json(400, {"error": "closing object required"})
            return
        draft["closing"].pop("nedovoz", None)
        publish = bool(draft.pop("publish", False))
        link_token = str(draft.pop("link_token", "") or "")
        draft.pop("sender_username", None)
        draft.setdefault("collected_at", datetime.now(timezone.utc).isoformat())
        draft["point_number"] = point

        saved_at = datetime.now(timezone.utc).isoformat()
        doc = {"saved_at": saved_at, "draft": draft}
        with _lock:
            draft_path(point).write_text(
                json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8"
            )

        if not publish:
            self._json(
                200,
                {
                    "ok": True,
                    "point_number": point,
                    "saved_at": saved_at,
                    "published": False,
                    "preview_text": render_text(draft),
                },
            )
            return

        try:
            sent_text = publish_report(point, draft, link_token)
        except PublishError as exc:
            self._json(exc.status, {"error": str(exc), "saved": True, "point_number": point})
            return

        self._json(
            200,
            {
                "ok": True,
                "point_number": point,
                "saved_at": saved_at,
                "published": True,
                "preview_text": sent_text,
            },
        )


def lan_ips() -> list[str]:
    found: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.add(info[4][0])
    except OSError:
        pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        found.add(probe.getsockname()[0])
        probe.close()
    except OSError:
        pass
    return sorted(ip for ip in found if ip and not ip.startswith("127."))


def main() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Turbo draft API on http://{HOST}:{PORT}")
    print("Этот компьютер: http://127.0.0.1:{0}".format(PORT))
    for ip in lan_ips():
        print(f"Другие ПК пунктов: http://{ip}:{PORT}")
    print("В расширении на других компьютерах в Base URL вставьте адрес «Другие ПК», токен тот же.")
    print(
        f"Token configured: {'yes' if API_TOKEN else 'no'} | "
        f"bot token: {'yes' if os.environ.get('BOT_TOKEN') else 'no'} | "
        f"TTL={TTL_SECONDS}s | data={DATA_DIR}"
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
