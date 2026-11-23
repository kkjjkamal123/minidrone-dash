"""Live link: UDP listener, session handling, demo feed, and connection diagnostics."""
from __future__ import annotations

import json
import os
import queue
import socket
import subprocess
import threading
import time
from pathlib import Path

from . import protocol as P
from . import store

SESSION_GAP = 4.0  # seconds of silence that end a flight
RULE_NAME = "Minidrone Ground Station"
NO_WINDOW = 0x08000000 if os.name == "nt" else 0


class Hub:
    """Fans frames out to UI clients and owns the current live session."""

    def __init__(self):
        self._subs: list[queue.Queue] = []
        self._lock = threading.Lock()
        self.session = None  # dict: start, sender, recorder, source
        self.last_rx = 0.0
        self.packets = 0
        self.bad_packets = 0
        self.last_sender = None
        self.last_frame_no = None
        self.dropped = 0
        self._rate = []
        self.listen_error = None

    # subscribers -------------------------------------------------------
    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=200)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def publish(self, event: str, data: dict):
        msg = (event, json.dumps(data, separators=(",", ":")))
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(msg)
            except queue.Full:  # slow client: drop oldest
                try:
                    q.get_nowait()
                    q.put_nowait(msg)
                except queue.Empty:
                    pass

    # ingest ------------------------------------------------------------
    def ingest(self, raw: bytes, sender: str, source: str = "drone"):
        pkt = P.parse(raw)
        if not pkt:
            self.bad_packets += 1
            return
        now = time.monotonic()
        with self._lock:
            new = self.session is None or self.session["source"] != source
            if new:
                self._end_locked()
                rec = store.Recorder(sender) if source == "drone" else None
                self.session = {"start": now, "sender": sender, "recorder": rec, "source": source}
                self.last_frame_no = None
            s = self.session
        if new:
            self.publish("session", {"state": "start", "source": source, "sender": sender})
        if self.last_frame_no is not None and pkt["frame"] > self.last_frame_no + 1:
            self.dropped += pkt["frame"] - self.last_frame_no - 1
        self.last_frame_no = pkt["frame"]
        t = now - s["start"]
        if s["recorder"]:
            s["recorder"].write(t, raw)
        self.packets += 1
        self.last_rx = now
        self.last_sender = sender
        self._rate = [x for x in self._rate if now - x < 3.0] + [now]
        view = P.to_view(pkt, t)
        view["src"] = source
        self.publish("frame", view)

    def last_sender_ip(self) -> str | None:
        s = self.last_sender
        return s if s and s[0].isdigit() else None

    def rate(self) -> float:
        now = time.monotonic()
        r = [x for x in self._rate if now - x < 3.0]
        return round(len(r) / 3.0, 1)

    def tick(self):
        """Close a session after a silence."""
        with self._lock:
            if self.session and time.monotonic() - self.last_rx > SESSION_GAP:
                ended = self.session
                self._end_locked()
            else:
                ended = None
        if ended:
            rec = ended["recorder"]
            saved = rec is not None and rec.path.exists()
            self.publish("session", {"state": "end", "source": ended["source"],
                                     "saved": ("rec:" + rec.path.name) if saved else None})

    def _end_locked(self):
        if self.session and self.session["recorder"]:
            self.session["recorder"].close()
        self.session = None


class UdpListener(threading.Thread):
    def __init__(self, hub: Hub, port: int = P.PORT):
        super().__init__(daemon=True, name="udp")
        self.hub, self.port = hub, port

    def run(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
            sock.bind(("0.0.0.0", self.port))
        except OSError as e:
            self.hub.listen_error = f"UDP port {self.port} unavailable: {e}"
            return
        sock.settimeout(0.5)
        while True:
            try:
                raw, addr = sock.recvfrom(65535)
            except socket.timeout:
                self.hub.tick()
                continue
            except OSError:
                continue
            self.hub.ingest(raw, addr[0])
            self.hub.tick()


class Demo(threading.Thread):
    """Plays a simulation log through the live pipeline, exactly as the drone would send it."""

    def __init__(self, hub: Hub, sim_path: Path):
        super().__init__(daemon=True, name="demo")
        self.hub, self.sim_path = hub, sim_path
        self.stop_evt = threading.Event()

    def run(self):
        import scipy.io as sio

        m = sio.loadmat(str(self.sim_path))
        pos, pd, gd, masks = m["pos"], m["pd"], m["gd"], m.get("masks")
        n = masks.shape[2] if masks is not None else 0
        t0 = time.monotonic()
        for k in range(pos.shape[0]):
            if self.stop_evt.is_set():
                break
            mk = P.pack_mask(masks[:, :, k]) if k < n else None
            raw = P.build(k + 1, (pos[k, 0], pos[k, 1], pd[k, 2], pd[k, 3]),
                          (float("nan"),) * 4, gd[k, :4], mk)
            self.hub.ingest(raw, "demo", source="demo")
            time.sleep(max(0.0, t0 + (k + 1) * P.FRAME_DT - time.monotonic()))
            if k > 20 and gd[k, 0] == 4 and pd[k, 2] > -0.03:
                break  # touched down


# diagnostics -----------------------------------------------------------

def local_ips() -> list[str]:
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def firewall_rule_present() -> bool | None:
    if os.name != "nt":
        return None
    try:
        r = subprocess.run(["netsh", "advfirewall", "firewall", "show", "rule", f"name={RULE_NAME}"],
                           capture_output=True, text=True, timeout=5, creationflags=NO_WINDOW)
        return r.returncode == 0 and RULE_NAME in r.stdout
    except Exception:
        return None


def add_firewall_rule(port: int = P.PORT) -> bool:
    """Ask Windows (UAC prompt) to allow inbound telemetry on any network profile."""
    if os.name != "nt":
        return False
    args = (f'advfirewall firewall add rule name="{RULE_NAME}" dir=in action=allow '
            f'protocol=UDP localport={port} profile=any')
    ps = f"Start-Process netsh -ArgumentList '{args}' -Verb RunAs -WindowStyle Hidden -Wait"
    try:
        subprocess.run(["powershell", "-NoProfile", "-Command", ps], timeout=120, creationflags=NO_WINDOW)
    except Exception:
        return False
    return bool(firewall_rule_present())


def matlab_pi_address() -> str | None:
    """The Raspberry Pi address MATLAB last connected to, if MATLAB is set up on this laptop."""
    root = Path(os.environ.get("APPDATA", "")) / "MathWorks" / "MATLAB"
    if not root.is_dir():
        return None
    try:
        import scipy.io as sio
    except ImportError:
        return None
    for prefs in sorted(root.glob("R20*/matlabprefs.mat"), reverse=True):
        try:
            m = sio.loadmat(str(prefs), squeeze_me=True, struct_as_record=False)
        except Exception:
            continue
        for key, val in m.items():
            if "RaspberryPi" in key and hasattr(val, "_fieldnames"):
                for f in ("DeviceAddress", "deviceAddress", "IPAddress"):
                    addr = getattr(val, f, None)
                    if isinstance(addr, str) and addr:
                        return addr
    return None


class PiProbe(threading.Thread):
    """Checks every few seconds whether the Raspberry Pi answers on SSH (port 22)."""

    def __init__(self, hub: Hub, settings: dict):
        super().__init__(daemon=True, name="probe")
        self.hub, self.settings = hub, settings
        self.status = {"host": None, "reachable": None, "ms": None, "checked": 0}

    def host(self) -> str | None:
        return self.settings.get("pi_host") or self.hub.last_sender_ip() or self.settings.get("pi_host_matlab")

    def run(self):
        while True:
            h = self.host()
            st = {"host": h, "reachable": None, "ms": None, "checked": time.time()}
            if h:
                t = time.perf_counter()
                try:
                    with socket.create_connection((h, 22), timeout=1.5):
                        st["reachable"] = True
                        st["ms"] = round((time.perf_counter() - t) * 1000)
                except OSError:
                    st["reachable"] = False
            self.status = st
            time.sleep(3)

