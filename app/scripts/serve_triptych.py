#!/usr/bin/env python3
"""
=============================================================================
SCRIPT NAME: serve_triptych.py
=============================================================================

INPUT FILES:
- /Users/arjundivecha/Dropbox/AAA Backup/A Working/Triptych/app/  (static root)
  All static frontend files served to the browser (triptych.html, assets/,
  data/t2_master.json, etc.).
- /Users/arjundivecha/Dropbox/AAA Backup/A Complete/T2 Factor Timing Fuzzy/T2 Master.xlsx
  Source workbook, read when a data refresh runs (via extract_t2_master.py).
- /Users/arjundivecha/Dropbox/AAA Backup/A Working/Triptych/app/data/t2_master.json
  Current dataset; its embedded metadata is compared against the workbook
  mtime to detect staleness.

OUTPUT FILES:
- /Users/arjundivecha/Dropbox/AAA Backup/A Working/Triptych/app/data/t2_master.json
  Rewritten (atomically) when a refresh runs.
- /Users/arjundivecha/Dropbox/AAA Backup/A Working/Triptych/app/data/backups/t2_master_YYYY_MM_DD_HHMMSS.json.gz
  Gzipped timestamped backup of the previous JSON, written before each
  refresh overwrites it.

VERSION: 1.0
LAST UPDATED: 2026-06-10
AUTHOR: Arjun Divecha

DESCRIPTION:
Local web server for the Triptych app. Pure Python stdlib (no Flask, no
dependencies). It does three things:

1. Serves the static frontend from the app/ directory, gzip-compressing
   JSON/JS/CSS/HTML responses when the browser accepts gzip (the dataset
   is ~6 MB raw, ~1.5 MB gzipped).
2. GET /api/status -> JSON with the dataset's generated_at, the source
   workbook's current mtime, and a "stale" flag (workbook newer than the
   extraction), plus whether a refresh is currently running.
3. POST /api/refresh -> backs up the current JSON (gzipped, timestamped),
   re-runs the extractor against the source workbook, and atomically
   replaces data/t2_master.json. A lock ensures only one refresh runs at
   a time; concurrent calls return 409.

With --auto-refresh, the server checks staleness at startup and, if the
workbook is newer than the dataset, kicks off a refresh in a background
thread so the UI is reachable immediately (the frontend polls /api/status
and reloads when the refresh completes).

DEPENDENCIES:
- Python 3 stdlib only (http.server, threading, gzip, json)
- extract_t2_master.py (same directory) and its openpyxl dependency

USAGE:
python3 serve_triptych.py                     # port 8123
python3 serve_triptych.py --port 9000
python3 serve_triptych.py --auto-refresh      # refresh on launch if stale
=============================================================================
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import shutil
import threading
import traceback
from datetime import UTC, datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import extract_t2_master as extractor

APP_DIR = Path(__file__).resolve().parent.parent
DATA_JSON = APP_DIR / "data" / "t2_master.json"
BACKUP_DIR = APP_DIR / "data" / "backups"
SOURCE_XLSX = Path(extractor.DEFAULT_INPUT)

DEFAULT_PORT = 8123
GZIP_TYPES = {".json", ".js", ".css", ".html", ".svg"}

refresh_lock = threading.Lock()
refresh_state = {
    "running": False,
    "last_result": None,   # "ok" | "error"
    "last_error": None,
    "last_finished": None,
}


def read_dataset_meta() -> dict:
    """Read just the metadata fields from the head of the dataset JSON."""
    if not DATA_JSON.exists():
        return {}
    try:
        with DATA_JSON.open("r", encoding="utf-8") as fh:
            head = fh.read(2048)
        meta = {}
        for key in ("generated_at", "source_file", "source_mtime", "format"):
            marker = f'"{key}":'
            idx = head.find(marker)
            if idx < 0:
                continue
            rest = head[idx + len(marker):]
            if rest.lstrip().startswith('"'):
                start = rest.find('"') + 1
                end = rest.find('"', start)
                meta[key] = rest[start:end]
            else:
                num = ""
                for ch in rest.lstrip():
                    if ch.isdigit():
                        num += ch
                    else:
                        break
                if num:
                    meta[key] = int(num)
        return meta
    except OSError:
        return {}


def get_status() -> dict:
    meta = read_dataset_meta()
    source_mtime = None
    if SOURCE_XLSX.exists():
        source_mtime = datetime.fromtimestamp(
            SOURCE_XLSX.stat().st_mtime, UTC
        ).isoformat(timespec="seconds")

    stale = False
    extracted_source_mtime = meta.get("source_mtime")
    if source_mtime and extracted_source_mtime:
        stale = source_mtime > extracted_source_mtime
    elif source_mtime and not extracted_source_mtime:
        stale = True

    return {
        "dataset_generated_at": meta.get("generated_at"),
        "dataset_source_mtime": extracted_source_mtime,
        "source_file": str(SOURCE_XLSX),
        "source_exists": SOURCE_XLSX.exists(),
        "source_mtime": source_mtime,
        "stale": stale,
        "refresh_running": refresh_state["running"],
        "last_refresh_result": refresh_state["last_result"],
        "last_refresh_error": refresh_state["last_error"],
        "last_refresh_finished": refresh_state["last_finished"],
    }


def backup_current_json() -> None:
    """Gzip the current dataset into a timestamped backup before overwrite."""
    if not DATA_JSON.exists():
        return
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y_%m_%d_%H%M%S")
    backup_path = BACKUP_DIR / f"t2_master_{stamp}.json.gz"
    with DATA_JSON.open("rb") as src, gzip.open(backup_path, "wb") as dst:
        shutil.copyfileobj(src, dst)
    # Keep the 10 most recent backups.
    backups = sorted(BACKUP_DIR.glob("t2_master_*.json.gz"))
    for old in backups[:-10]:
        old.unlink()


def run_refresh() -> None:
    """Backup, extract, atomically replace the dataset. Sets refresh_state."""
    try:
        if not SOURCE_XLSX.exists():
            raise FileNotFoundError(f"Source workbook not found: {SOURCE_XLSX}")
        backup_current_json()
        payload = extractor.extract_workbook(SOURCE_XLSX)
        extractor.write_atomic(payload, DATA_JSON)
        refresh_state["last_result"] = "ok"
        refresh_state["last_error"] = None
        print(f"[refresh] dataset rebuilt: {len(payload['sheets'])} sheets")
    except Exception as exc:  # surface the real error to /api/status
        refresh_state["last_result"] = "error"
        refresh_state["last_error"] = f"{type(exc).__name__}: {exc}"
        traceback.print_exc()
    finally:
        refresh_state["last_finished"] = datetime.now(UTC).isoformat(
            timespec="seconds"
        )
        refresh_state["running"] = False
        refresh_lock.release()


def start_refresh_async() -> bool:
    """Start a refresh in a background thread. False if one is running."""
    if not refresh_lock.acquire(blocking=False):
        return False
    refresh_state["running"] = True
    threading.Thread(target=run_refresh, daemon=True).start()
    return True


class TriptychHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] == "/api/status":
            self.send_json(200, get_status())
            return
        super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] == "/api/refresh":
            if start_refresh_async():
                self.send_json(202, {"started": True})
            else:
                self.send_json(409, {"started": False, "reason": "refresh already running"})
            return
        self.send_json(404, {"error": "unknown endpoint"})

    def send_json(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- static files with gzip + no-cache for the dataset ---
    def send_head(self):
        path = Path(self.translate_path(self.path.split("?")[0]))
        accepts_gzip = "gzip" in self.headers.get("Accept-Encoding", "")

        if (
            path.is_file()
            and path.suffix in GZIP_TYPES
            and accepts_gzip
        ):
            try:
                raw = path.read_bytes()
            except OSError:
                self.send_error(404, "File not found")
                return None
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
                gz.write(raw)
            body = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(str(path)))
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            if path.name == "t2_master.json":
                self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return io.BytesIO(body)

        return super().send_head()

    def log_message(self, fmt, *args):
        # Quiet: only log API and errors, not every asset request.
        if "/api/" in (args[0] if args else "") or (args and str(args[1]).startswith(("4", "5"))):
            super().log_message(fmt, *args)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the Triptych app")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--auto-refresh",
        action="store_true",
        help="refresh the dataset in the background at startup if stale",
    )
    args = parser.parse_args()

    if args.auto_refresh:
        status = get_status()
        if status["stale"]:
            print("[startup] dataset stale -> starting background refresh")
            start_refresh_async()
        else:
            print("[startup] dataset is current")

    handler = partial(TriptychHandler, directory=str(APP_DIR))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"Triptych serving {APP_DIR} at http://127.0.0.1:{args.port}/triptych.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
