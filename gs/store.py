"""Flight recordings (live sessions) and simulation logs (track_*.mat from track_tests.m)."""
from __future__ import annotations

import datetime as dt
import math
import os
import struct
import sys
import threading
from pathlib import Path

from . import protocol as P

LOG_MAGIC = b"MDGSLOG1"
REC = struct.Struct("<dH")


def data_dir() -> Path:
    base = Path(os.environ.get("USERPROFILE", Path.home())) / "Documents" / "Minidrone Ground Station"
    (base / "Flights").mkdir(parents=True, exist_ok=True)
    return base


def flights_dir() -> Path:
    return data_dir() / "Flights"


def app_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def sim_dirs() -> list[Path]:
    """Folders that may hold track_*.mat: the tools folder this app ships in, plus GS_SIM_DIR."""
    out = []
    env = os.environ.get("GS_SIM_DIR")
    if env:
        out.append(Path(env))
    here = app_dir()
    for p in (here.parent, here.parent.parent, here.parent / "minidrone_2026_tools"):
        if p.is_dir() and any(p.glob("track_*.mat")):
            out.append(p)
    seen, uniq = set(), []
    for p in out:
        r = p.resolve()
        if r not in seen:
            seen.add(r)
            uniq.append(r)
    return uniq


class Recorder:
    """Raw datagrams with arrival time; replay goes through the same decoder as live."""

    def __init__(self, sender: str):
        stamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M%S")
        self.path = flights_dir() / f"flight_{stamp}.mdgs"
        self._f = open(self.path, "wb")
        self._f.write(LOG_MAGIC)
        hdr = sender.encode()[:255]
        self._f.write(bytes([len(hdr)]) + hdr)
        self._lock = threading.Lock()
        self.frames = 0

    def write(self, t: float, raw: bytes):
        with self._lock:
            self._f.write(REC.pack(t, len(raw)) + raw)
            self.frames += 1
            if self.frames % 25 == 0:
                self._f.flush()

    def close(self):
        with self._lock:
            self._f.close()
        if self.frames < 3:  # a stray packet is not a flight
            try:
                self.path.unlink()
            except OSError:
                pass


def read_recording(path: Path) -> tuple[str, list[dict]]:
    data = path.read_bytes()
    if not data.startswith(LOG_MAGIC):
        raise ValueError("not a ground station recording")
    i = len(LOG_MAGIC)
    n = data[i]
    sender = data[i + 1:i + 1 + n].decode(errors="replace")
    i += 1 + n
    frames = []
    while i + REC.size <= len(data):
        t, ln = REC.unpack_from(data, i)
        i += REC.size
        raw = data[i:i + ln]
        i += ln
        if len(raw) < ln:
            break
        pkt = P.parse(raw)
        if pkt:
            frames.append(P.to_view(pkt, t))
    return sender, frames


def read_sim(path: Path) -> tuple[dict, list[dict]]:
    import numpy as np
    import scipy.io as sio

    m = sio.loadmat(str(path))
    pos, pd, gd = m["pos"], m["pd"], m["gd"]
    masks = m.get("masks")
    nmask = masks.shape[2] if masks is not None and masks.ndim == 3 else 0
    frames = []
    for k in range(pos.shape[0]):
        mk = P.pack_mask(masks[:, :, k]) if k < nmask else b""
        pkt = {"frame": k, "pos": (pos[k, 0], pos[k, 1], pd[k, 2], pd[k, 3]),
               "traj": None, "dbg": tuple(gd[k, :4]), "mask": mk}
        frames.append(P.to_view(pkt, k * P.FRAME_DT))
    ned = np.asarray(m["ned"], float)
    circ = np.asarray(m["circ"], float).ravel()
    track = {"pts": ned.round(4).tolist(), "circle": [round(circ[0], 4), round(circ[1], 4)], "r": 0.1}
    return track, frames


def summarize(frames: list[dict]) -> dict:
    if not frames:
        return {"duration": 0, "frames": 0}
    per = [0.0] * len(P.STATES)
    events = []
    dist = 0.0
    prev = None
    top = 0
    for i, f in enumerate(frames):
        st = f.get("st")
        if st is not None and 0 <= st < len(per):
            top = max(top, st)
            if i + 1 < len(frames):
                per[st] += frames[i + 1]["t"] - f["t"]
            if prev is None or st != prev.get("st"):
                events.append({"t": f["t"], "st": st})
        if prev and None not in (f["x"], f["y"], prev["x"], prev["y"]):
            dist += math.hypot(f["x"] - prev["x"], f["y"] - prev["y"])
        prev = f
    last = frames[-1]
    landed = top == 4 and last.get("z") is not None and last["z"] > -0.08
    return {
        "duration": round(last["t"] - frames[0]["t"], 2),
        "frames": len(frames),
        "distance": round(dist, 2),
        "time_in_state": [round(s, 1) for s in per],
        "events": events,
        "reached": P.STATES[top],
        "landed": bool(landed),
    }


_meta_cache: dict[str, tuple[float, dict]] = {}


def _cached_meta(path: Path, loader):
    key = str(path)
    mtime = path.stat().st_mtime
    hit = _meta_cache.get(key)
    if hit and hit[0] == mtime:
        return hit[1]
    try:
        meta = loader(path)
    except Exception as e:  # unreadable file: show it, flagged
        meta = {"error": str(e)}
    _meta_cache[key] = (mtime, meta)
    return meta


def list_flights() -> list[dict]:
    out = []
    for p in sorted(flights_dir().glob("*.mdgs"), key=lambda p: p.stat().st_mtime, reverse=True):
        meta = _cached_meta(p, lambda q: summarize(read_recording(q)[1]))
        when = dt.datetime.fromtimestamp(p.stat().st_mtime)
        out.append({"id": "rec:" + p.name, "kind": "flight", "name": "Flight at " + when.strftime("%H:%M:%S"),
                    "when": dt.datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="minutes"), **meta})
    for d in sim_dirs():
        for p in sorted(d.glob("track_*.mat")):
            if p.name == "track_results.mat":
                continue
            meta = _cached_meta(p, lambda q: summarize(read_sim(q)[1]))
            out.append({"id": "sim:" + str(p), "kind": "sim", "name": p.stem.replace("track_", ""),
                        "when": dt.datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="minutes"), **meta})
    return out


def load(fid: str) -> dict:
    kind, _, ref = fid.partition(":")
    if kind == "rec":
        p = flights_dir() / Path(ref).name
        sender, frames = read_recording(p)
        return {"id": fid, "kind": "flight", "name": p.stem, "sender": sender, "track": None,
                "frames": frames, "summary": summarize(frames)}
    if kind == "sim":
        p = Path(ref)
        if p.suffix != ".mat" or not p.name.startswith("track_") or p.resolve().parent not in sim_dirs():
            raise ValueError("unknown simulation log")
        track, frames = read_sim(p)
        return {"id": fid, "kind": "sim", "name": p.stem.replace("track_", ""), "track": track,
                "frames": frames, "summary": summarize(frames)}
    raise ValueError("unknown flight id")


def delete(fid: str):
    kind, _, ref = fid.partition(":")
    if kind != "rec":
        raise ValueError("only recorded flights can be deleted")
    (flights_dir() / Path(ref).name).unlink(missing_ok=True)
