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

import base64
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
import uuid
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


RETURNS_CHAT_ID = -1004213842576
RETURNS_THREAD_ID = 2
CLOCK_RE = re.compile(r"(?:[01]\d|2[0-3]):[0-5]\d")
RETURN_KINDS = (
    ("returns", "возвраты"),
    ("zasyl", "засылы"),
    ("tare", "Тарные ящики"),
)


def drivers_for_point(point: str) -> list[str]:
    if not BOT_DB.exists():
        return []
    with sqlite3.connect(BOT_DB) as con:
        rows = con.execute(
            """SELECT courier_name FROM courier_stops
               WHERE pp_number = ?
               GROUP BY courier_name
               ORDER BY MIN(stop_order)""",
            (point,),
        ).fetchall()
    return [str(row[0]).strip() for row in rows if row[0] and str(row[0]).strip()]


def telegram_form(method: str, fields: dict[str, str], files: list[tuple[str, str, bytes]]) -> dict:
    token = os.environ.get("BOT_TOKEN", "")
    if not token:
        raise PublishError("Автоотправка в чат не настроена: у API нет токена бота.", 500)
    boundary = "----Turbo" + uuid.uuid4().hex
    chunks: list[bytes] = []
    for key, value in fields.items():
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
        )
    for name, filename, blob in files:
        chunks.append(
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                "Content-Type: image/jpeg\r\n\r\n"
            ).encode()
            + blob
            + b"\r\n"
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=b"".join(chunks),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
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


def decode_return_photos(raw) -> list[bytes]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise PublishError("Фото нужно прислать списком.", 400)
    if len(raw) > 10:
        raise PublishError("Не больше 10 фото.", 400)
    photos = []
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            raise PublishError("Одно из фото повреждено.", 400)
        payload = item.split(",", 1)[-1]
        try:
            blob = base64.b64decode(payload)
        except ValueError as exc:
            raise PublishError("Одно из фото повреждено.", 400) from exc
        if not blob.startswith(b"\xff\xd8"):
            raise PublishError("Нужны фото JPEG.", 400)
        if len(blob) > 4_000_000:
            raise PublishError("Слишком большое фото. Уберите лишние или снимите заново.", 400)
        photos.append(blob)
    return photos


def publish_returns(payload: dict) -> str:
    sender = username_from_link(str(payload.get("link_token") or ""))
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", sender):
        raise PublishError("Отправка доступна только после привязки Telegram в расширении.", 403)
    point = re.sub(r"\D", "", str(payload.get("point_number") or ""))
    if not re.fullmatch(r"\d{3,6}", point):
        raise PublishError("Нужен номер ПП из шапки Турбо.", 400)
    day = str(payload.get("date") or "").strip()
    if not re.fullmatch(r"\d{2}\.\d{2}\.\d{2}", day):
        raise PublishError("Дата нужна в виде ДД.ММ.ГГ, например 07.11.26.", 400)
    driver = " ".join(str(payload.get("driver") or "").split())
    if not driver or len(driver) > 80:
        raise PublishError("Напишите фамилию и имя водителя.", 400)
    selected = payload.get("kinds")
    if not isinstance(selected, list):
        selected = []
    labels = [label for key, label in RETURN_KINDS if key in selected]
    if not labels:
        raise PublishError("Отметьте, что отдали: возвраты, засылы или тарные ящики.", 400)
    formed_from = str(payload.get("formed_from") or "").strip()
    formed_to = str(payload.get("formed_to") or "").strip()
    handed = str(payload.get("handed_at") or "").strip()
    if not CLOCK_RE.fullmatch(formed_from) or not CLOCK_RE.fullmatch(formed_to):
        raise PublishError("Время формирования нужно в виде ЧЧ:ММ-ЧЧ:ММ.", 400)
    if not CLOCK_RE.fullmatch(handed):
        raise PublishError("Время передачи нужно в виде ЧЧ:ММ.", 400)
    photos = decode_return_photos(payload.get("photos"))
    photos.extend(session_photos(str(payload.get("photo_token") or "")))
    if len(photos) > 10:
        raise PublishError("Не больше 10 фото.", 400)
    if not photos:
        raise PublishError("Прикрепите фото подписанных актов.", 400)
    text = "\n".join(
        [
            f"ПП_{point}",
            day,
            f"Водитель {driver}",
            "Отдали " + ", ".join(labels),
            f"Время формирования: {formed_from}-{formed_to}",
            f"Время передачи водителю: {handed}",
        ]
    )
    target = {
        "chat_id": str(RETURNS_CHAT_ID),
        "message_thread_id": str(RETURNS_THREAD_ID),
    }
    if len(photos) == 1:
        telegram_form(
            "sendPhoto",
            {**target, "caption": text},
            [("photo", "act.jpg", photos[0])],
        )
    else:
        media = []
        files = []
        for index, blob in enumerate(photos):
            item = {"type": "photo", "media": f"attach://p{index}"}
            if index == 0:
                item["caption"] = text
            media.append(item)
            files.append((f"p{index}", f"act{index + 1}.jpg", blob))
        telegram_form("sendMediaGroup", {**target, "media": json.dumps(media, ensure_ascii=False)}, files)
    return text


_photo_lock = threading.Lock()
_photo_sessions: dict[str, dict] = {}
PHOTO_TTL_SECONDS = 30 * 60
UPLOAD_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{8,40}")


def phone_host() -> str:
    ips = lan_ips()
    for prefix in ("192.168.", "192.168"):
        for ip in ips:
            if ip.startswith("192.168."):
                return ip
        break
    for ip in ips:
        if ip.startswith("10.") and not ip.startswith("10.8."):
            return ip
    return ips[0] if ips else "127.0.0.1"


def _live_session(token: str) -> dict | None:
    session = _photo_sessions.get(token)
    if not session or session["expires"] < time.time():
        _photo_sessions.pop(token, None)
        return None
    return session


def create_photo_session() -> dict:
    import qrcode
    import qrcode.image.svg

    token = secrets.token_urlsafe(9)
    with _photo_lock:
        _photo_sessions[token] = {"expires": time.time() + PHOTO_TTL_SECONDS, "photos": [], "next_id": 1}
    url = f"http://{phone_host()}:{PORT}/u/{token}"
    image = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, border=2, box_size=6)
    buffer = __import__("io").BytesIO()
    image.save(buffer)
    return {"token": token, "url": url, "qr_svg": buffer.getvalue().decode("utf-8")}


def add_session_photos(token: str, raw) -> int:
    photos = decode_return_photos(raw)
    if not photos:
        raise PublishError("Выберите хотя бы одно фото.", 400)
    with _photo_lock:
        session = _live_session(token)
        if session is None:
            raise PublishError("Ссылка устарела. В расширении нажмите «Добавить фото» ещё раз.", 404)
        if len(session["photos"]) + len(photos) > 10:
            raise PublishError("Не больше 10 фото.", 400)
        for blob in photos:
            photo_id = session.get("next_id", 1)
            session["photos"].append({"id": photo_id, "blob": blob})
            session["next_id"] = photo_id + 1
        return len(session["photos"])


def session_photos(token: str) -> list[bytes]:
    if not token or not UPLOAD_TOKEN_RE.fullmatch(token):
        return []
    with _photo_lock:
        session = _live_session(token)
        if not session:
            return []
        blobs = []
        for item in session["photos"]:
            blobs.append(item["blob"] if isinstance(item, dict) else item)
        return blobs


def session_photo_files(token: str) -> list[dict] | None:
    with _photo_lock:
        session = _live_session(token)
        if session is None:
            return None
        return [
            {"id": item["id"], "data": base64.b64encode(item["blob"]).decode("ascii")}
            for item in session["photos"]
            if isinstance(item, dict)
        ]


def remove_session_photo(token: str, photo_id: int) -> int:
    with _photo_lock:
        session = _live_session(token)
        if session is None:
            raise PublishError("Ссылка на фото устарела.", 404)
        session["photos"] = [
            item for item in session["photos"]
            if not isinstance(item, dict) or item["id"] != photo_id
        ]
        return len(session["photos"])


def session_count(token: str) -> int | None:
    with _photo_lock:
        session = _live_session(token)
        return len(session["photos"]) if session else None


def upload_page(token: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Фото актов</title>
<style>
body {{ margin: 0; font-family: sans-serif; background: #f2f5f9; color: #001a34; }}
main {{ max-width: 420px; margin: 0 auto; padding: 24px 16px; }}
h1 {{ font-size: 22px; margin: 0 0 8px; }}
p {{ color: #5c6b80; }}
button, label.pick {{ display: block; width: 100%; box-sizing: border-box; margin-top: 12px;
  padding: 14px; border: 0; border-radius: 12px; background: #005bff; color: #fff;
  font-size: 16px; text-align: center; }}
label.pick input {{ display: none; }}
#status {{ min-height: 1.4em; }}
</style>
</head>
<body>
<main>
  <h1>Фото актов</h1>
  <p>Снимите или выберите подписанные акты. Они появятся в расширении на компьютере.</p>
  <label class="pick">Выбрать фото
    <input id="files" type="file" accept="image/*" multiple />
  </label>
  <p id="status"></p>
</main>
<script>
const status = document.getElementById('status');
function word(n) {{
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return 'файл';
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return 'файла';
  return 'файлов';
}}
function shrink(file) {{
  return new Promise((resolve, reject) => {{
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {{
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {{
        if (!blob) return reject(new Error('фото'));
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      }}, 'image/jpeg', 0.72);
    }};
    image.onerror = () => {{ URL.revokeObjectURL(url); reject(new Error('фото')); }};
    image.src = url;
  }});
}}
document.getElementById('files').addEventListener('change', async (event) => {{
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;
  status.textContent = 'Отправляю…';
  try {{
    const photos = [];
    for (const file of files) photos.push(await shrink(file));
    const res = await fetch('/u/{token}', {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify({{ photos }})
    }});
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Не отправилось');
    status.textContent = 'Прикреплено ' + body.count + ' ' + word(body.count) + '. Можно добавить ещё.';
  }} catch (error) {{
    status.textContent = error.message || 'Не отправилось';
  }}
}});
</script>
</body>
</html>"""


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

    def _html(self, code: int, text: str) -> None:
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
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
        upload = re.fullmatch(r"/u/(" + UPLOAD_TOKEN_RE.pattern + ")", path)
        if upload:
            token = upload.group(1)
            if session_count(token) is None:
                self._html(404, "<p>Ссылка устарела. В расширении нажмите «Добавить фото» ещё раз.</p>")
                return
            self._html(200, upload_page(token))
            return
        if path == "/health":
            self._json(200, {"ok": True, "ttl_seconds": TTL_SECONDS})
            return
        if not self._auth():
            return

        files_match = re.fullmatch(
            r"/api/returns/photos/(" + UPLOAD_TOKEN_RE.pattern + ")/files",
            path,
        )
        if files_match:
            files = session_photo_files(files_match.group(1))
            if files is None:
                self._json(404, {"error": "Ссылка на фото устарела."})
                return
            self._json(200, {"ok": True, "photos": files})
            return

        photos_match = re.fullmatch(r"/api/returns/photos/(" + UPLOAD_TOKEN_RE.pattern + ")", path)
        if photos_match:
            count = session_count(photos_match.group(1))
            if count is None:
                self._json(404, {"error": "Ссылка на фото устарела."})
                return
            self._json(200, {"ok": True, "count": count})
            return

        driver_match = re.fullmatch(r"/api/driver/(\d{3,6})", path)
        if driver_match:
            point = driver_match.group(1)
            self._json(200, {"ok": True, "point_number": point, "drivers": drivers_for_point(point)})
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
        upload = re.fullmatch(r"/u/(" + UPLOAD_TOKEN_RE.pattern + ")", path)
        if upload:
            payload = self._read_body()
            if payload is None:
                return
            try:
                count = add_session_photos(upload.group(1), payload.get("photos"))
            except PublishError as exc:
                self._json(exc.status, {"error": str(exc)})
                return
            self._json(200, {"ok": True, "count": count})
            return
        if path not in {
            "/api/drafts",
            "/api/link/request",
            "/api/link/confirm",
            "/api/machine",
            "/api/returns",
            "/api/returns/photos/session",
        } and not re.fullmatch(
            r"/api/returns/photos/(" + UPLOAD_TOKEN_RE.pattern + ")/delete",
            path,
        ):
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
        delete_match = re.fullmatch(
            r"/api/returns/photos/(" + UPLOAD_TOKEN_RE.pattern + ")/delete",
            path,
        )
        if delete_match:
            try:
                photo_id = int(payload.get("id"))
                count = remove_session_photo(delete_match.group(1), photo_id)
            except (TypeError, ValueError):
                self._json(400, {"error": "Не указано фото."})
                return
            except PublishError as exc:
                self._json(exc.status, {"error": str(exc)})
                return
            self._json(200, {"ok": True, "count": count})
            return
        if path == "/api/returns/photos/session":
            sender = username_from_link(str(payload.get("link_token") or ""))
            if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", sender):
                self._json(403, {"error": "Сначала привяжите Telegram в расширении."})
                return
            try:
                created = create_photo_session()
            except Exception as exc:
                self._json(500, {"error": f"Не удалось сделать QR: {exc}"})
                return
            self._json(200, {"ok": True, **created})
            return
        if path == "/api/returns":
            try:
                text = publish_returns(payload)
            except PublishError as exc:
                self._json(exc.status, {"error": str(exc)})
                return
            self._json(200, {"ok": True, "text": text})
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
