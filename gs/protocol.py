"""Wire format shared by the drone (groundStationTx.m) and the ground station.

One UDP datagram per guidance frame (5 Hz), little-endian, 2460 bytes:

    offset  size  field
    0       4     magic  b"MDGS"
    4       1     version (1)
    5       3     reserved
    8       4     uint32 frame counter
    12      48    float32 x 12: pos[x y z yaw], traj[x y z yaw], dbg[state heading nCentre dirW]
    60      2400  camera mask, 120x160 bits, MATLAB column-major order, LSB first
"""
from __future__ import annotations

import base64
import math
import struct

MAGIC = b"MDGS"
VERSION = 1
PORT = 47800
ROWS, COLS = 120, 160
MASK_BYTES = ROWS * COLS // 8
HEADER = 60
SIZE = HEADER + MASK_BYTES
FRAME_DT = 0.2  # lineGuidance runs at 5 Hz

STATES = ["TAKEOFF", "FOLLOW", "COAST", "SETTLE", "LAND"]
NO_DIR = 99.0  # lineGuidance writes 99 when no line direction is known


def parse(buf: bytes) -> dict | None:
    """Decode one datagram, or None if it is not ours."""
    if len(buf) < HEADER or buf[:4] != MAGIC:
        return None
    (frame,) = struct.unpack_from("<I", buf, 8)
    v = struct.unpack_from("<12f", buf, 12)
    mask = bytes(buf[HEADER:HEADER + MASK_BYTES]) if len(buf) >= SIZE else b""
    return {"frame": frame, "pos": v[0:4], "traj": v[4:8], "dbg": v[8:12], "mask": mask}


def build(frame: int, pos, traj, dbg, mask: bytes | None = None) -> bytes:
    """Encode a datagram. mask=None sends the header only (no camera image)."""
    vals = [float(a) for a in (*pos[:4], *traj[:4], *dbg[:4])]
    head = MAGIC + bytes([VERSION, 0, 0, 0]) + struct.pack("<I12f", frame & 0xFFFFFFFF, *vals)
    if mask is None:
        return head
    return head + mask.ljust(MASK_BYTES, b"\0")[:MASK_BYTES]


def pack_mask(mask2d) -> bytes:
    """120x160 array -> 2400 bytes in the same bit order the drone uses."""
    import numpy as np

    bits = np.asarray(mask2d).astype(bool).flatten(order="F")
    return np.packbits(bits, bitorder="little").tobytes()


def _num(x):
    x = float(x)
    return None if math.isnan(x) or math.isinf(x) else round(x, 5)


def to_view(pkt: dict, t: float) -> dict:
    """Compact JSON-ready frame for the UI."""
    pos, traj, dbg = pkt["pos"], pkt["traj"], pkt["dbg"]
    d = dbg[3] if dbg is not None else NO_DIR
    return {
        "t": round(t, 3),
        "f": pkt.get("frame", 0),
        "x": _num(pos[0]), "y": _num(pos[1]), "z": _num(pos[2]), "yaw": _num(pos[3]),
        "tx": _num(traj[0]) if traj else None, "ty": _num(traj[1]) if traj else None,
        "tz": _num(traj[2]) if traj else None,
        "st": int(dbg[0]) if dbg is not None and not math.isnan(dbg[0]) else None,
        "hc": _num(dbg[1]) if dbg is not None else None,
        "nc": int(dbg[2]) if dbg is not None and not math.isnan(dbg[2]) else None,
        "dw": None if d is None or math.isnan(d) or abs(d - NO_DIR) < 1e-3 else _num(d),
        "m": base64.b64encode(pkt["mask"]).decode("ascii") if pkt.get("mask") else None,
    }
