"""Mission control: run the flight model on the Pi over SSH, and drive MATLAB through gs_bridge.m.

Pi actions (paramiko, one at a time): prepare, start, stop, status, fetch log, reboot, shut down.
MATLAB actions: the dashboard queues one command; gs_bridge.m (running in the user's MATLAB) polls
/api/matlab/poll every second, runs it, and posts the result. While a command runs, MATLAB writes a
diary file that this module tails so the build output appears live.
"""
from __future__ import annotations

import itertools
import re
import threading
import time
from pathlib import Path

from . import store

ELF = "~/MATLAB_ws/R2026b/PerceptionAndGuidance.elf"
RUNLOG = "~/pg_run.log"
# Bracket trick: the pattern never matches the shell command line that carries it.
PAT = "'[P]erceptionAndGuidance.elf'"
ENV = "export XDG_RUNTIME_DIR=/run/user/$(id -u); "

PI_ACTIONS = {
    "status": ENV + (
        "echo \"model: $(pgrep -f " + PAT + " >/dev/null && echo RUNNING pid $(pgrep -f " + PAT + " | head -1) || echo stopped)\"; "
        "echo \"uptime: $(uptime -p)\"; "
        "echo \"power: $(vcgencmd get_throttled 2>/dev/null) (0x0 = never under-voltage)\"; "
        "echo \"temp: $(vcgencmd measure_temp 2>/dev/null)\"; "
        "echo \"cpu governor: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)\"; "
        "echo \"wifi power save: $(iw dev wlan0 get power_save 2>/dev/null | cut -d: -f2)\"; "
        "echo \"pipewire: $(systemctl --user is-active pipewire 2>/dev/null) / wireplumber: $(systemctl --user is-active wireplumber 2>/dev/null) (want inactive)\"; "
        "echo \"camera users: $(pgrep -l 'rpicam|libcamera' | tr '\\n' ' ')\"; "
        "echo \"pixhawk serial: $(ls /dev/ttyACM0 2>/dev/null || echo MISSING)\"; "
        "echo \"model file: $(ls -l --time-style=+%m-%d_%H:%M " + ELF + " 2>/dev/null | awk '{print $6, $5\" bytes\"}' || echo NOT DEPLOYED)\"; "
        "echo \"--- last lines of the run log ---\"; tail -n 6 " + RUNLOG + " 2>/dev/null || echo '(no run log yet)'"
    ),
    "prepare": ENV + (
        "systemctl --user stop wireplumber pipewire pipewire.socket 2>&1; "
        "pkill -f '[r]picam-vid' ; "
        "sudo iw dev wlan0 set power_save off 2>&1; "
        "echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor >/dev/null; "
        "echo \"pipewire: $(systemctl --user is-active pipewire) / wireplumber: $(systemctl --user is-active wireplumber)\"; "
        "echo \"wifi power save: $(iw dev wlan0 get power_save | cut -d: -f2)\"; "
        "echo \"cpu governor: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)\"; "
        "echo \"pixhawk serial: $(ls /dev/ttyACM0 2>/dev/null || echo MISSING - check the USB cable to the Pixhawk)\"; "
        "echo 'Pi prepared.'"
    ),
    "start": ENV + (
        "if pgrep -f " + PAT + " >/dev/null; then echo 'Model is already running.'; exit 0; fi; "
        "if [ ! -f " + ELF + " ]; then echo 'Model not deployed: run Build & Deploy first.'; exit 1; fi; "
        "systemctl --user stop wireplumber pipewire pipewire.socket 2>/dev/null; pkill -f '[r]picam-vid'; "
        "[ -f " + RUNLOG + " ] && mv " + RUNLOG + " ~/pg_run_$(date +%m%d_%H%M%S).log; "
        "nohup sudo nice -n -10 " + ELF + " > " + RUNLOG + " 2>&1 < /dev/null & "
        "sleep 3; if pgrep -f " + PAT + " >/dev/null; then echo \"Model RUNNING (pid $(pgrep -f " + PAT + " | head -1)).\"; "
        "else echo 'Model exited right away:'; fi; tail -n 8 " + RUNLOG
    ),
    "stop": (
        "if ! pgrep -f " + PAT + " >/dev/null; then echo 'Model was not running.'; exit 0; fi; "
        "sudo pkill -INT -f " + PAT + "; sleep 2; "
        "pgrep -f " + PAT + " >/dev/null && { sudo pkill -KILL -f " + PAT + "; sleep 1; }; "
        "pgrep -f " + PAT + " >/dev/null && echo 'Still running!' || echo 'Model stopped.'"
    ),
    "log": "tail -n 40 " + RUNLOG + " 2>/dev/null || echo '(no run log yet)'",
    "reboot": "sudo systemctl reboot; echo 'Pi rebooting (about 40 s).'",
    "shutdown": "sudo systemctl poweroff; echo 'Pi shutting down. Wait for the green LED to stop before unplugging.'",
}

MATLAB_ACTIONS = ("check", "deploy", "deploy_start", "enable_tx", "disable_tx", "set_ip", "sim")


class Mission:
    def __init__(self, probe, settings: dict, camera=None):
        self.probe, self.settings, self.camera = probe, settings, camera
        self.lines: list[tuple[int, float, str, str]] = []   # (seq, time, source, text)
        self._seq = itertools.count(1)
        self._lock = threading.Lock()
        self.pi_busy: str | None = None
        # MATLAB bridge
        self._ids = itertools.count(1)
        self.ml_pending: dict | None = None
        self.ml_running: dict | None = None
        self.ml_last_poll = 0.0
        self.ml_info: dict = {}
        self.ml_diary: str | None = None
        self._diary_pos = 0

    # ---- console ----
    def say(self, src: str, text: str):
        with self._lock:
            for ln in str(text).replace("\r", "").split("\n"):
                if ln.strip():
                    self.lines.append((next(self._seq), time.time(), src, ln.rstrip()))
            del self.lines[:-1500]

    def since(self, n: int) -> list:
        self._tail_diary()
        with self._lock:
            return [{"n": a, "t": b, "src": c, "text": d} for a, b, c, d in self.lines if a > n]

    # ---- Pi over SSH ----
    def pi_host(self) -> str | None:
        return self.probe.host()[0]

    def run_pi(self, action: str) -> dict:
        if action not in PI_ACTIONS and action != "fetch_log":
            raise ValueError(f"unknown Pi action {action}")
        if self.pi_busy:
            raise ValueError(f"Pi is busy: {self.pi_busy}")
        host = self.pi_host()
        if not host:
            raise ValueError("No Raspberry Pi address. Set it on the Connection page.")
        self.pi_busy = action
        if action in ("start", "prepare") and self.camera:
            self.camera.hold(25)          # the model needs the camera: drop the live preview first
        threading.Thread(target=self._pi_job, args=(action, host), daemon=True).start()
        return {"ok": True}

    def _pi_job(self, action: str, host: str):
        self.say("pi", f"> {action} on {host}")
        if action in ("start", "prepare") and self.camera:
            time.sleep(2)
        try:
            import paramiko
            c = paramiko.SSHClient()
            c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect(host, username=self.settings.get("pi_user") or "rpi",
                      password=self.settings.get("pi_password") or "rpib",
                      timeout=8, banner_timeout=8, auth_timeout=8, look_for_keys=False, allow_agent=False)
            try:
                if action == "fetch_log":
                    self._fetch_log(c)
                else:
                    _, o, e = c.exec_command(PI_ACTIONS[action], timeout=40)
                    self.say("pi", o.read().decode(errors="replace") + e.read().decode(errors="replace"))
            finally:
                c.close()
        except Exception as ex:   # noqa: BLE001 - every failure goes to the console
            if action in ("reboot", "shutdown") and "closed" in str(ex).lower():
                self.say("pi", "Pi went down as asked.")
            else:
                self.say("pi", f"FAILED: {type(ex).__name__}: {ex}")
        finally:
            self.pi_busy = None

    def _fetch_log(self, c):
        out = store.data_dir() / "PiLogs"
        out.mkdir(parents=True, exist_ok=True)
        sftp = c.open_sftp()
        try:
            home = sftp.normalize(".")
            names = sorted(n for n in sftp.listdir(home) if re.fullmatch(r"pg_.*\.log", n))
            if not names:
                self.say("pi", "No run logs on the Pi.")
                return
            for n in names:
                dst = out / n
                if n != "pg_run.log" and dst.exists():
                    continue
                sftp.get(f"{home}/{n}", str(dst))
                self.say("pi", f"saved {dst}")
            self.say("pi", self._summarise(out / names[-1] if "pg_run.log" not in names else out / "pg_run.log"))
        finally:
            sftp.close()

    @staticmethod
    def _summarise(p: Path) -> str:
        try:
            txt = p.read_text(errors="replace")
        except OSError:
            return ""
        errs = [ln for ln in txt.splitlines() if re.search(r"error|fail|timed out|in use", ln, re.I)]
        head = f"{p.name}: {len(txt.splitlines())} lines, {len(errs)} error lines"
        return head + ("".join("\n  " + e for e in errs[-8:]) if errs else "")

    # ---- MATLAB bridge ----
    def ml_connected(self) -> bool:
        return time.time() - self.ml_last_poll < 4 or self.ml_running is not None

    def ml_queue(self, cmd: str, arg: str = "") -> dict:
        if cmd not in MATLAB_ACTIONS:
            raise ValueError(f"unknown MATLAB action {cmd}")
        if not self.ml_connected():
            raise ValueError("MATLAB is not connected. In MATLAB run:  gs_bridge")
        if self.ml_running or self.ml_pending:
            raise ValueError(f"MATLAB is busy: {(self.ml_running or self.ml_pending)['cmd']}")
        if cmd == "set_ip" and not re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", arg or ""):
            raise ValueError("Enter an IPv4 address like 192.168.137.36")
        if cmd in ("deploy", "deploy_start") and self.camera:
            self.camera.hold(600)          # building on the Pi and starting the model: keep the preview off
        self.ml_pending = {"id": next(self._ids), "cmd": cmd, "arg": arg or "", "queued": time.time()}
        self.say("matlab", f"> {cmd} {arg}".rstrip())
        return {"ok": True}

    def ml_poll(self, body: dict) -> dict:
        self.ml_last_poll = time.time()
        if isinstance(body.get("info"), dict):
            self.ml_info = body["info"]
        if self.ml_pending and not self.ml_running:
            job, self.ml_pending = self.ml_pending, None
            self.ml_running = dict(job, started=time.time())
            return job
        return {"id": 0, "cmd": ""}

    def ml_started(self, body: dict):
        d = body.get("diary")
        self.ml_diary, self._diary_pos = (d if isinstance(d, str) and d.endswith(".txt") else None), 0

    def ml_result(self, body: dict):
        self._tail_diary()
        job = self.ml_running or {}
        took = time.time() - job.get("started", time.time())
        ok = bool(body.get("ok"))
        self.say("matlab", f"{'DONE' if ok else 'FAILED'}: {job.get('cmd', '?')} ({took:.0f} s)"
                 + (f" - {body.get('error')}" if body.get("error") else ""))
        if isinstance(body.get("info"), dict):
            self.ml_info = body["info"]
        if job.get("cmd") in ("deploy", "deploy_start") and self.camera:
            self.camera.hold(5 if job.get("cmd") == "deploy" else 600)
        self.ml_running, self.ml_diary = None, None
        self.ml_last_poll = time.time()

    def _tail_diary(self):
        p = self.ml_diary
        if not p:
            return
        try:
            with open(p, "rb") as f:
                f.seek(self._diary_pos)
                chunk = f.read()
        except OSError:
            return
        cut = chunk.rfind(b"\n")
        if cut < 0:
            return
        self._diary_pos += cut + 1
        self.say("matlab", chunk[:cut].decode(errors="replace"))

    def status(self) -> dict:
        run = self.ml_running
        return {
            "pi_busy": self.pi_busy,
            "pi_host": self.pi_host(),
            "matlab": {
                "connected": self.ml_connected(),
                "since_poll": round(time.time() - self.ml_last_poll, 1) if self.ml_last_poll else None,
                "running": {"cmd": run["cmd"], "elapsed": round(time.time() - run["started"])} if run else None,
                "pending": self.ml_pending["cmd"] if self.ml_pending else None,
                "info": self.ml_info,
            },
        }
