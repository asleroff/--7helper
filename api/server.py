#!/usr/bin/env python3
"""Minimal draft API for Turbo PVZ Chrome extension.

Endpoints:
  GET  /health
  POST /api/drafts              — save draft (latest wins per point_number)
  GET  /api/drafts/{point}      — get latest draft for PP
  GET  /api/drafts/{point}/text — rendered closing text preview

Auth: Authorization: Bearer <EXTENSION_API_TOKEN>
No Telegram bot token here.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

TTL_SECONDS = int(os.environ.get("DRAFT_TTL_SECONDS", str(48 * 3600)))
HOST = os.environ.get("API_HOST", "127.0.0.1")
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
API_TOKEN = os.environ.get("EXTENSION_API_TOKEN", "dev-extension-token-change-me")

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

    nedovoz = c.get("nedovoz")
    nedovoz_s = "(вручную)" if nedovoz is None else nedovoz
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
            f"ТЯ: {dash(c.get('tya'))}",
            "",
            f"КТЯ: {dash(c.get('ktya'))}",
            "",
            f"Недостачи: {dash(c.get('shortage'))}",
            "",
            f"Излишки: {dash(c.get('excess'))}",
            "",
            f"Засылы: {dash(c.get('zasyl'))}",
            "",
            f"Недовоз: {nedovoz_s}",
            "",
            f"Выдано: {dash(c.get('issued'))} ед.",
            "",
            f"Остатки на складе: {dash(c.get('leftover'))} ед.",
            "",
            "ПП - закрыто.",
        ]
    )


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

    def do_POST(self) -> None:  # noqa: N802
        path = unquote(self.path.split("?", 1)[0])
        if path != "/api/drafts":
            self._json(404, {"error": "not found"})
            return
        if not self._auth():
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            draft = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return

        point = str(draft.get("point_number") or "").strip()
        if not re.fullmatch(r"\d{3,6}", point):
            self._json(400, {"error": "point_number required (3–6 digits)"})
            return
        if draft.get("source") != "turbo-pvz":
            draft["source"] = "turbo-pvz"
        if "closing" not in draft or not isinstance(draft["closing"], dict):
            self._json(400, {"error": "closing object required"})
            return
        # Force nedovoz null from extension path (bot fills later)
        if draft["closing"].get("nedovoz") is None:
            draft["closing"]["nedovoz"] = None
        draft.setdefault("collected_at", datetime.now(timezone.utc).isoformat())
        draft["point_number"] = point

        saved_at = datetime.now(timezone.utc).isoformat()
        doc = {"saved_at": saved_at, "draft": draft}
        with _lock:
            draft_path(point).write_text(
                json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8"
            )

        self._json(
            200,
            {
                "ok": True,
                "point_number": point,
                "saved_at": saved_at,
                "preview_text": render_text(draft),
            },
        )


def main() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Turbo draft API on http://{HOST}:{PORT}")
    print(f"Token configured: {'yes' if API_TOKEN else 'no'} | TTL={TTL_SECONDS}s | data={DATA_DIR}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
