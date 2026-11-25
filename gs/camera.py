"""Live camera: whenever the Raspberry Pi answers on SSH, stream its camera to the UI.

The laptop opens SSH to the Pi and runs a small watcher there that starts `rpicam-vid`
(MJPEG to stdout). The JPEG frames come back over the SSH channel, so no port, firewall
rule or service is needed on the Pi.

The flight model owns the camera while it runs. The watcher therefore never starts the
camera while any PerceptionAndGuidance process exists (Pi-side build, or the model itself),
and stops it at once if one appears or if files change under ~/MATLAB_ws (a deploy is
copying code). The stream goes away before the model needs the camera.
"""
from __future__ import annotations

import threading
import time

# Runs on the Pi via "python3 -u -" (script on stdin, so its own command line never
# contains the model name it searches for).
REMOTE = r'''
import os, subprocess, sys, time, signal
# Any MATLAB/Simulink model or its on-Pi build: the model name, the deploy folder, or an .elf
NAMES = (b"PerceptionAnd" + b"Guidance", b"MATLAB" + b"_ws", b".e" + b"lf")
ME = os.getpid()
WS = os.path.expanduser("~/MATLAB_ws")
W, H, FPS, Q = %(w)d, %(h)d, %(fps)d, %(q)d

def model_running():
    for p in os.listdir("/proc"):
        if not p.isdigit() or int(p) == ME:
            continue
        try:
            with open("/proc/%%s/cmdline" %% p, "rb") as f:
                c = f.read()
            if any(n in c for n in NAMES):
                return True
        except OSError:
            pass
    return False

def ws_stamp():
    # newest directory change anywhere under the deploy folder (a deploy adds files)
    s = 0.0
    try:
        for root, dirs, files in os.walk(WS):
            s = max(s, os.stat(root).st_mtime)
    except OSError:
        pass
    return s

def say(msg):
    sys.stderr.write(msg + "\n"); sys.stderr.flush()

if model_running():
    say("BUSY model"); sys.exit(3)
subprocess.call(["pkill", "-x", "rpicam-vid"], stderr=subprocess.DEVNULL)
time.sleep(0.3)
stamp = ws_stamp()
cam = subprocess.Popen(["rpicam-vid", "-t", "0", "-n", "--codec", "mjpeg",
                        "--width", str(W), "--height", str(H), "--framerate", str(FPS),
                        "-q", str(Q), "--hflip", "--vflip", "--flush", "-o", "-"],
                       stdout=subprocess.PIPE, stderr=open("/tmp/gs_camera.log", "wb"), bufsize=0)
os.set_blocking(cam.stdout.fileno(), False)
out = sys.stdout.buffer
last_check, last_ws, last_data, rc = 0.0, 0.0, time.time(), 0
try:
    while True:
        now = time.time()
        if now - last_check > 0.2:
            last_check = now
            if model_running():
                say("BUSY model"); rc = 3; break
        if now - last_ws > 1.0:
            last_ws = now
            if ws_stamp() != stamp:
                say("BUSY deploy"); rc = 3; break
        if cam.poll() is not None:
            try:
                lines = open("/tmp/gs_camera.log", "rb").read().decode("utf-8", "replace").splitlines()
            except OSError:
                lines = []
            bad = [l.strip() for l in lines if "ERROR" in l] or lines[-1:] or ["rpicam-vid exited"]
            say("CAMFAIL " + bad[-1][:300]); rc = 4; break
        if now - last_data > 6:
            say("CAMFAIL no frames from the camera (sensor or ribbon cable)"); rc = 4; break
        try:
            d = cam.stdout.read(65536)
        except BlockingIOError:
            d = None
        if d:
            last_data = now
            out.write(d); out.flush()
        else:
            time.sleep(0.01)
except (BrokenPipeError, OSError):
    rc = 0
finally:
    try:
        cam.send_signal(signal.SIGINT); cam.wait(1.5)
    except Exception:
        cam.kill()
sys.exit(rc)
'''


class CameraLink(threading.Thread):
    """Keeps the latest JPEG from the Pi camera; state tells the UI what is going on."""

    W, H, FPS, Q = 640, 480, 12, 70

    def __init__(self, probe, settings: dict):
        super().__init__(daemon=True, name="camera")
        self.probe, self.settings = probe, settings
        self.cond = threading.Condition()
        self.jpeg: bytes | None = None
        self.seq = 0
        self.state = "idle"   # off | no_pi | connecting | live | busy | camfail | auth | error
        self.detail = ""
        self._rate: list[float] = []
        self.kick = threading.Event()
        self.hold_until = 0.0   # Mission sets this so the preview lets go of the camera before the model starts

    # ------------------------------------------------------------------
    def hold(self, seconds: float):
        self.hold_until = time.monotonic() + seconds
        self.kick.set()

    def enabled(self) -> bool:
        return self.settings.get("camera", True) is not False and time.monotonic() > self.hold_until

    def fps(self) -> float:
        now = time.monotonic()
        self._rate = [t for t in self._rate if now - t < 2.0]
        return round(len(self._rate) / 2.0, 1)

    def status(self) -> dict:
        age = time.monotonic() - self._last if self.jpeg and getattr(self, "_last", 0) else None
        return {"state": self.state, "detail": self.detail, "fps": self.fps(), "seq": self.seq,
                "age": round(age, 1) if age is not None else None}

    def _set(self, state: str, detail: str = ""):
        self.state, self.detail = state, detail

    def _frame(self, jpg: bytes):
        with self.cond:
            self.jpeg = jpg
            self.seq += 1
            self._last = time.monotonic()
            self._rate.append(self._last)
            self.cond.notify_all()

    # ------------------------------------------------------------------
    def run(self):
        import paramiko

        client = None
        while True:
            if not self.enabled():
                self._set("off")
                if client:
                    client.close(); client = None
                self.kick.wait(1.0); self.kick.clear()
                continue
            host, _ = self.probe.host()
            if not host or not self.probe.status.get("reachable"):
                self._set("no_pi", host or "")
                if client:
                    client.close(); client = None
                self.kick.wait(1.0); self.kick.clear()
                continue
            try:
                if client is None or not client.get_transport() or not client.get_transport().is_active():
                    self._set("connecting", host)
                    client = paramiko.SSHClient()
                    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                    client.connect(host, username=self.settings.get("pi_user") or "rpi",
                                   password=self.settings.get("pi_password") or "rpib",
                                   timeout=5, banner_timeout=5, auth_timeout=5,
                                   allow_agent=False, look_for_keys=False)
                    client.get_transport().set_keepalive(2)
                wait = self._stream(client, host)
            except paramiko.AuthenticationException:
                self._set("auth", "SSH login refused: check the Pi user and password in Connection")
                client = None
                wait = 5.0
            except Exception as e:  # network drop, Pi rebooting
                self._set("error", str(e)[:200])
                try:
                    client and client.close()
                except Exception:
                    pass
                client = None
                wait = 2.0
            self.kick.wait(wait); self.kick.clear()

    def _stream(self, client, host) -> float:
        """Run one camera session; returns how long to wait before the next try."""
        ch = client.get_transport().open_session()
        ch.exec_command("python3 -u -")
        ch.sendall((REMOTE % {"w": self.W, "h": self.H, "fps": self.FPS, "q": self.Q}).encode())
        ch.shutdown_write()
        ch.settimeout(0.5)
        buf = bytearray()
        err = b""
        started = time.monotonic()
        if self.state not in ("busy", "camfail"):
            self._set("connecting", host)
        try:
            while self.enabled():
                if ch.recv_stderr_ready():
                    err += ch.recv_stderr(4096)
                try:
                    d = ch.recv(131072)
                except TimeoutError:
                    d = None
                except Exception as e:
                    if "timed out" in str(e):
                        d = None
                    else:
                        raise
                if d == b"":
                    break
                if d:
                    buf += d
                    while True:
                        a = buf.find(b"\xff\xd8")
                        if a < 0:
                            buf.clear(); break
                        b = buf.find(b"\xff\xd9", a + 2)
                        if b < 0:
                            if a:
                                del buf[:a]
                            break
                        self._frame(bytes(buf[a:b + 2]))
                        del buf[:b + 2]
                        if self.state != "live":
                            self._set("live", host)
                    if len(buf) > 4 << 20:
                        buf.clear()
                elif self.state == "connecting" and time.monotonic() - started > 8:
                    self._set("camfail", "Camera started but sent no image")
        finally:
            try:
                while ch.recv_stderr_ready():
                    err += ch.recv_stderr(4096)
            except Exception:
                pass
            ch.close()
        msg = err.decode("utf-8", "replace")
        if "BUSY" in msg:
            self._set("busy", "Flight model is using the camera" if "model" in msg
                      else "Deploy in progress: camera released for the flight model")
            return 3.0
        if "CAMFAIL" in msg:
            line = msg[msg.find("CAMFAIL") + 8:].strip()
            if "acquire camera" in line:
                self._set("camfail", "Camera is held by another program on the Pi (pipewire/wireplumber or a running model)")
            elif any(k in line for k in ("Device timeout", "queue buffer", "no frames", "-5")):
                self._set("camfail", "Camera does not respond: power off, reseat the camera ribbon cable")
            else:
                self._set("camfail", line[:200] or "Camera failed to start")
            return 5.0
        if not self.enabled():
            return 0.5
        self._set("error", msg.strip()[-200:] or "camera session ended")
        return 2.0
