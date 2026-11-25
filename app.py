"""Minidrone Ground Station: double-click to start.

Opens its own window, listens for drone telemetry on UDP 47800, records every flight,
and replays recorded flights and track_tests.m simulation logs.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

if getattr(sys, "frozen", False):
    BASE = Path(sys._MEIPASS)  # type: ignore[attr-defined]
else:
    BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from gs import server  # noqa: E402

UI_PORT = 47801
TITLE = "Minidrone Ground Station"


def already_running() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{UI_PORT}/api/status", timeout=1) as r:
            return b'"version"' in r.read(200)
    except Exception:
        return False


def free_port(preferred: int) -> int:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", preferred))
        return preferred
    except OSError:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def edge_window(url: str) -> bool:
    for exe in (shutil.which("msedge"),
                r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"):
        if exe and Path(exe).exists():
            subprocess.Popen([exe, f"--app={url}", "--window-size=1440,900"])
            return True
    return False


def main():
    url = f"http://127.0.0.1:{UI_PORT}/"
    if already_running():
        if not edge_window(url):
            import webbrowser
            webbrowser.open(url)
        return

    app = server.App(BASE / "ui")
    app.start()
    port = free_port(UI_PORT)
    server.serve(app, port=port)
    url = f"http://127.0.0.1:{port}/"

    if "--headless" in sys.argv:
        print(f"{TITLE} running at {url}  (telemetry on UDP {app.port})", flush=True)
        while True:
            time.sleep(3600)

    try:
        import webview

        webview.create_window(TITLE, url, width=1440, height=900, min_size=(1000, 640), maximized=True,
                              background_color="#1A1A1A")
        webview.start(gui="edgechromium" if os.name == "nt" else None)
    except Exception:
        # No WebView2: fall back to an Edge app window, then the default browser.
        if not edge_window(url):
            import webbrowser
            webbrowser.open(url)
        while True:
            time.sleep(3600)


if __name__ == "__main__":
    main()
