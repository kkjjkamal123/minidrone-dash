"""Local HTTP server: static UI, JSON API, and a Server-Sent Events stream for live frames."""
from __future__ import annotations

import json
import mimetypes
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import link, store
from . import protocol as P

VERSION = "1.0.0"


class App:
    def __init__(self, ui_dir: Path, port: int = P.PORT):
        self.ui_dir = ui_dir
        self.port = port
        self.hub = link.Hub()
        self.settings_path = store.data_dir() / "settings.json"
        self.settings = self._load_settings()
        self.settings["pi_host_matlab"] = link.matlab_pi_address()
        self.listener = link.UdpListener(self.hub, port)
        self.probe = link.PiProbe(self.hub, self.settings)
        self.demo: link.Demo | None = None
        self._fw = {"present": None, "checked": 0.0}

    def start(self):
        self.listener.start()
        self.probe.start()
        threading.Thread(target=self._ticker, daemon=True).start()

    def _ticker(self):
        while True:
            time.sleep(1)
            self.hub.tick()

    def _load_settings(self) -> dict:
        try:
            return json.loads(self.settings_path.read_text())
        except Exception:
            return {}

    def save_settings(self, patch: dict):
        for k in ("pi_host", "theme", "trail"):
            if k in patch:
                self.settings[k] = patch[k]
        keep = {k: v for k, v in self.settings.items() if k != "pi_host_matlab"}
        self.settings_path.write_text(json.dumps(keep, indent=2))

    def firewall(self, refresh=False):
        if refresh or time.time() - self._fw["checked"] > 30:
            self._fw = {"present": link.firewall_rule_present(), "checked": time.time()}
        return self._fw["present"]

    def status(self) -> dict:
        h = self.hub
        s = h.session
        return {
            "version": VERSION,
            "port": self.port,
            "listening": h.listen_error is None,
            "listen_error": h.listen_error,
            "ips": link.local_ips(),
            "firewall": self.firewall(),
            "packets": h.packets,
            "bad_packets": h.bad_packets,
            "dropped": h.dropped,
            "rate": h.rate(),
            "since_rx": round(time.monotonic() - h.last_rx, 1) if h.last_rx else None,
            "sender": h.last_sender,
            "session": {"source": s["source"], "sender": s["sender"]} if s else None,
            "pi": self.probe.status,
            "settings": self.settings,
            "flights_dir": str(store.flights_dir()),
            "sim_dirs": [str(p) for p in store.sim_dirs()],
        }

    def start_demo(self, fid: str | None):
        self.stop_demo()
        sims = [f for f in store.list_flights() if f["kind"] == "sim" and not f.get("error")]
        if not sims:
            raise ValueError("no simulation logs found for the demo")
        pick = next((f for f in sims if f["id"] == fid), None) or next(
            (f for f in sims if f["name"] == "zigzag7"), sims[0])
        self.demo = link.Demo(self.hub, Path(pick["id"][4:]))
        self.demo.start()
        return pick["name"]

    def stop_demo(self):
        if self.demo and self.demo.is_alive():
            self.demo.stop_evt.set()
            self.demo.join(timeout=1)
        self.demo = None


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _json(self, obj, code=200):
            body = json.dumps(obj, separators=(",", ":")).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if not n:
                return {}
            try:
                return json.loads(self.rfile.read(n))
            except Exception:
                return {}

        def do_GET(self):
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                if u.path == "/api/stream":
                    return self._stream()
                if u.path == "/api/status":
                    return self._json(app.status())
                if u.path == "/api/flights":
                    return self._json(store.list_flights())
                if u.path == "/api/flight":
                    return self._json(store.load(q.get("id", "")))
                return self._static(u.path)
            except (ValueError, FileNotFoundError) as e:
                return self._json({"error": str(e)}, 404)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def do_POST(self):
            u = urlparse(self.path)
            b = self._body()
            try:
                if u.path == "/api/settings":
                    app.save_settings(b)
                    return self._json({"ok": True})
                if u.path == "/api/firewall":
                    ok = link.add_firewall_rule(app.port)
                    app.firewall(refresh=True)
                    return self._json({"ok": ok})
                if u.path == "/api/demo/start":
                    return self._json({"ok": True, "name": app.start_demo(b.get("id"))})
                if u.path == "/api/demo/stop":
                    app.stop_demo()
                    return self._json({"ok": True})
                if u.path == "/api/flight/delete":
                    store.delete(b.get("id", ""))
                    return self._json({"ok": True})
                if u.path == "/api/open-folder":
                    import os
                    os.startfile(str(store.flights_dir()))  # noqa: S606 - local folder only
                    return self._json({"ok": True})
                return self._json({"error": "not found"}, 404)
            except ValueError as e:
                return self._json({"error": str(e)}, 400)

        def _static(self, path: str):
            rel = "index.html" if path in ("", "/") else path.lstrip("/")
            f = (app.ui_dir / rel).resolve()
            if app.ui_dir.resolve() not in f.parents or not f.is_file():
                return self._json({"error": "not found"}, 404)
            body = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(f.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)

        def _stream(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            q = app.hub.subscribe()
            try:
                self.wfile.write(b"retry: 1000\n\n")
                self.wfile.flush()
                while True:
                    try:
                        ev, data = q.get(timeout=2.0)
                        self.wfile.write(f"event: {ev}\ndata: {data}\n\n".encode())
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                pass
            finally:
                app.hub.unsubscribe(q)

    return Handler


def serve(app: App, host="127.0.0.1", port=47801) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True, name="http").start()
    return httpd
