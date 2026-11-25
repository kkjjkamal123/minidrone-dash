"""Pretend to be the PX4 flight controller over MAVLink/UDP, to test ARM / LAND / DISARM in the app.

    python tools/fake_px4.py                 # answers like PX4 would
    python tools/fake_px4.py --deny-arm      # refuses to arm, with a reason, like a failed preflight check
    python tools/fake_px4.py --ignore-land   # accepts LAND but keeps flying (custom controller ignores PX4 modes)

Sends to 127.0.0.1:14550 (the app falls back to 14551 if 14550 is taken: pass --port 14551).
"""
from __future__ import annotations

import argparse
import socket
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gs import mavlink as M  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=14550)
ap.add_argument("--deny-arm", action="store_true")
ap.add_argument("--ignore-land", action="store_true")
a = ap.parse_args()

dst = ("127.0.0.1", a.port)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("127.0.0.1", 0))
s.setblocking(False)
parser = M.Parser()
seq = 0
st = {"armed": False, "main": 3, "sub": 0, "alt": 0.0, "vz": 0.0, "landed_at": None, "volt": 12.45}


def send(msgid, payload):
    global seq
    p = payload.rstrip(b"\0") or b"\0"
    hdr = bytes((len(p), 0, 0, seq & 0xFF, 1, 1, msgid & 0xFF, (msgid >> 8) & 0xFF, msgid >> 16))
    crc = M.crc16(hdr + p + bytes((M.MSG[msgid][0],)))
    s.sendto(b"\xfd" + hdr + p + struct.pack("<H", crc), dst)
    seq += 1


def text(sev, msg):
    send(253, struct.pack("<B50s", sev, msg.encode()[:50]))
    print("  text:", msg)


def ack(cmd, result):
    send(77, struct.pack("<HB", cmd, result))


def on_command(cmd, p):
    if cmd == 400 and p[0] == 1:
        if a.deny_arm:
            text(3, "Arming denied: Resolve system health failures")
            return ack(cmd, 4)
        st.update(armed=True, main=6, landed_at=None)
        text(6, "Armed by external command")
        return ack(cmd, 0)
    if cmd == 400 and p[0] == 0:
        if st["alt"] > 0.1 and p[1] != M.FORCE_DISARM:
            text(3, "Disarming denied: not landed")
            return ack(cmd, 4)
        st.update(armed=False, vz=-2.0 if st["alt"] > 0.05 else 0.0)
        text(4, "Disarmed by external command" + (" (forced)" if p[1] == M.FORCE_DISARM else ""))
        return ack(cmd, 0)
    if cmd == 176 and int(p[1]) == 4 and int(p[2]) == 6:
        if not st["armed"]:
            return ack(cmd, 2)
        st.update(main=4, sub=6)
        text(6, "Landing at current position")
        return ack(cmd, 0)
    ack(cmd, 3)


print(f"fake PX4 -> {dst[0]}:{dst[1]}  (Ctrl+C to stop)")
last_hb = last_pos = 0.0
t_prev = time.monotonic()
while True:
    now = time.monotonic()
    dt, t_prev = now - t_prev, now
    try:
        data, _ = s.recvfrom(2048)
        for _sys, _comp, msgid, body in parser.feed(data):
            if msgid == 76:
                *params, cmd, ts, tc, conf = struct.unpack_from("<7fHBBB", body)
                print(f"COMMAND_LONG {cmd} {params[:3]} confirmation={conf}")
                on_command(cmd, params)
    except BlockingIOError:
        pass
    # crude vertical model
    if st["armed"]:
        landing = st["main"] == 4 and st["sub"] == 6 and not a.ignore_land
        target_vz = -0.35 if landing else (0.4 if st["alt"] < 0.8 else 0.0)
        st["vz"] = target_vz
    elif st["alt"] > 0:
        st["vz"] -= 9.8 * dt
    st["alt"] = max(0.0, st["alt"] + st["vz"] * dt)
    if st["alt"] == 0.0 and st["vz"] < 0:
        st["vz"] = 0.0
    if st["armed"] and st["main"] == 4 and st["alt"] < 0.02:
        st["landed_at"] = st["landed_at"] or now
        if now - st["landed_at"] > 1.5:
            st.update(armed=False, main=3, sub=0)
            text(6, "Landing detected, disarmed")
    st["volt"] -= (0.0004 if st["armed"] else 0.00002)
    if now - last_hb > 1:
        last_hb = now
        custom = (st["main"] << 16) | (st["sub"] << 24)
        base = 0x01 | (0x80 if st["armed"] else 0)
        send(0, struct.pack("<IBBBBB", custom, 2, 12, base, 4 if st["armed"] else 3, 3))
        pct = int(max(0, min(100, (st["volt"] / 3 - 3.5) / 0.7 * 100)))
        send(1, struct.pack("<IIIHHhHHHHHHb", 0, 0, 0, 0, int(st["volt"] * 1000), -1, 0, 0, 0, 0, 0, 0, pct))
        landed = 1 if st["alt"] < 0.02 else (4 if st["main"] == 4 else 2)
        send(245, bytes((0, landed)))
    if now - last_pos > 0.1:
        last_pos = now
        send(32, struct.pack("<I6f", int(now * 1000) & 0xFFFFFFFF, 0, 0, -st["alt"], 0, 0, -st["vz"]))
    time.sleep(0.01)
