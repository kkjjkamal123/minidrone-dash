"""Save Pi camera frames from the live preview: single photos, and recordings as numbered JPEGs.

Everything goes under Documents\\Minidrone Ground Station\\Captures. A recording is a folder of
frame_00001.jpg ... plus a .mjpeg file of the same frames (plays in VLC / ffplay). In MATLAB:
    f = dir(fullfile(folder, 'frame_*.jpg')); img = imread(fullfile(folder, f(1).name));
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

from . import store


def captures_dir() -> Path:
    d = store.data_dir() / "Captures"
    d.mkdir(parents=True, exist_ok=True)
    return d


class Capture:
    def __init__(self, camera):
        self.cam = camera
        self.rec_dir: Path | None = None
        self.rec_frames = 0
        self.rec_start = 0.0
        self._stop = threading.Event()
        self._thr: threading.Thread | None = None

    def _need_live(self):
        if self.cam.state != "live" or self.cam.jpeg is None:
            raise ValueError("Live camera is not running (Pi connected? model stopped? camera on?)")

    def photo(self) -> str:
        self._need_live()
        p = captures_dir() / time.strftime("photo_%Y%m%d_%H%M%S.jpg")
        n = 1
        while p.exists():
            p = p.with_name(p.stem + f"_{n}.jpg"); n += 1
        p.write_bytes(self.cam.jpeg)
        return str(p)

    def start(self) -> str:
        if self._thr and self._thr.is_alive():
            return str(self.rec_dir)
        self._need_live()
        self.rec_dir = captures_dir() / time.strftime("video_%Y%m%d_%H%M%S")
        self.rec_dir.mkdir(parents=True, exist_ok=True)
        self.rec_frames, self.rec_start = 0, time.time()
        self._stop.clear()
        self._thr = threading.Thread(target=self._run, daemon=True, name="record")
        self._thr.start()
        return str(self.rec_dir)

    def stop(self) -> dict:
        self._stop.set()
        if self._thr:
            self._thr.join(timeout=3)
        out = {"dir": str(self.rec_dir) if self.rec_dir else None, "frames": self.rec_frames,
               "seconds": round(time.time() - self.rec_start, 1) if self.rec_start else 0}
        self._thr = None
        return out

    def _run(self):
        seq = -1
        d = self.rec_dir
        with open(d / (d.name + ".mjpeg"), "wb") as mj:
            while not self._stop.is_set():
                with self.cam.cond:
                    self.cam.cond.wait_for(lambda: self.cam.seq != seq or self._stop.is_set(), timeout=1.0)
                    jpg, s2 = self.cam.jpeg, self.cam.seq
                if self._stop.is_set():
                    break
                if jpg is None or s2 == seq:
                    if self.cam.state != "live":
                        break           # camera went away (model started, Pi lost): end the recording
                    continue
                seq = s2
                self.rec_frames += 1
                (d / f"frame_{self.rec_frames:05d}.jpg").write_bytes(jpg)
                mj.write(jpg)

    def status(self) -> dict:
        rec = bool(self._thr and self._thr.is_alive())
        return {"recording": rec, "frames": self.rec_frames,
                "seconds": round(time.time() - self.rec_start, 1) if rec else 0,
                "dir": str(self.rec_dir) if self.rec_dir else None, "folder": str(captures_dir())}
