"""MAVLink link to the PX4 flight controller: armed state, mode, battery, and ARM / LAND / DISARM.

Only the handful of messages the safety controls need are implemented (MAVLink v2 out, v1 + v2 in),
so the app needs no pymavlink. The link is either UDP (PX4 over Wi-Fi / Ethernet, or a MAVLink
router / QGroundControl forwarding to this laptop) or a serial port (USB cable or telemetry radio).
"""
from __future__ import annotations

import math
import socket
import struct
import threading
import time

# msgid: (crc_extra, minimum payload length used for unpacking)
MSG = {
    0: (50, 9),      # HEARTBEAT
    1: (124, 31),    # SYS_STATUS
    32: (185, 28),   # LOCAL_POSITION_NED
    76: (152, 33),   # COMMAND_LONG
    77: (143, 3),    # COMMAND_ACK
    245: (130, 2),   # EXTENDED_SYS_STATE
    253: (83, 51),   # STATUSTEXT
}
GCS_SYSID, GCS_COMPID = 255, 190
UDP_PORTS = (14550, 14551)
FORCE_DISARM = 21196.0

PX4_MAIN = {1: "Manual", 2: "Altitude", 3: "Position", 4: "Auto", 5: "Acro", 6: "Offboard", 7: "Stabilized", 8: "Rattitude"}
PX4_AUTO = {1: "Ready", 2: "Takeoff", 3: "Hold", 4: "Mission", 5: "Return", 6: "Land", 8: "Follow", 9: "Precision land"}
LANDED = {0: None, 1: "on ground", 2: "in air", 3: "taking off", 4: "landing"}
ACK = {0: "accepted", 1: "temporarily rejected", 2: "denied", 3: "unsupported", 4: "failed", 5: "in progress", 6: "cancelled"}

# name: (MAV_CMD, params 1..7)
COMMANDS = {
    "arm": (400, (1, 0, 0, 0, 0, 0, 0)),                    # MAV_CMD_COMPONENT_ARM_DISARM
    "disarm": (400, (0, FORCE_DISARM, 0, 0, 0, 0, 0)),      # forced: motors stop even in the air
    "land": (176, (1, 4, 6, 0, 0, 0, 0)),                   # MAV_CMD_DO_SET_MODE: custom, AUTO, LAND
}


def crc16(data: bytes, crc: int = 0xFFFF) -> int:
    for b in data:
        t = (b ^ crc) & 0xFF
        t = (t ^ (t << 4)) & 0xFF
        crc = ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xFFFF
    return crc


def pack(msgid: int, payload: bytes, seq: int, sysid: int = GCS_SYSID, compid: int = GCS_COMPID) -> bytes:
    """One MAVLink v2 frame (trailing zero bytes of the payload are dropped, as v2 requires)."""
    p = payload.rstrip(b"\0") or b"\0"
    hdr = bytes((len(p), 0, 0, seq & 0xFF, sysid, compid, msgid & 0xFF, (msgid >> 8) & 0xFF, msgid >> 16))
    crc = crc16(hdr + p + bytes((MSG[msgid][0],)))
    return b"\xfd" + hdr + p + struct.pack("<H", crc)


def heartbeat_payload(mav_type=6, autopilot=8, base_mode=0, custom_mode=0, status=4) -> bytes:
    return struct.pack("<IBBBBB", custom_mode, mav_type, autopilot, base_mode, status, 3)


def command_payload(cmd: int, params, target_sys: int, target_comp: int, confirmation: int = 0) -> bytes:
    return struct.pack("<7fHBBB", *[float(x) for x in params], cmd, target_sys, target_comp, confirmation)


class Parser:
    """Splits a byte stream (serial) or datagrams (UDP) into checked MAVLink frames."""

    def __init__(self):
        self.buf = bytearray()
        self.bad = 0

    def feed(self, data: bytes) -> list[tuple[int, int, int, bytes]]:
        b = self.buf
        b += data
        out = []
        while b:
            if b[0] not in (0xFD, 0xFE):
                i = min((x for x in (b.find(b"\xfd"), b.find(b"\xfe")) if x >= 0), default=len(b))
                del b[:i]
                continue
            if b[0] == 0xFD:
                if len(b) < 12:
                    break
                n = b[1]
                total = 12 + n + (13 if b[2] & 1 else 0)
                if len(b) < total:
                    break
                sysid, compid = b[5], b[6]
                msgid = b[7] | (b[8] << 8) | (b[9] << 16)
                body, hdr = bytes(b[10:10 + n]), bytes(b[1:10])
                crc_got = b[10 + n] | (b[11 + n] << 8)
            else:
                if len(b) < 8:
                    break
                n = b[1]
                total = 8 + n
                if len(b) < total:
                    break
                sysid, compid, msgid = b[3], b[4], b[5]
                body, hdr = bytes(b[6:6 + n]), bytes(b[1:6])
                crc_got = b[6 + n] | (b[7 + n] << 8)
            spec = MSG.get(msgid)
            if spec is None:
                # a message we do not use (its checksum can't be verified): skip it whole only if
                # another frame starts right after it, otherwise this was a false start byte
                del b[:total if len(b) == total or b[total] in (0xFD, 0xFE) else 1]
                continue
            if crc16(hdr + body + bytes((spec[0],))) != crc_got:
                self.bad += 1
                del b[:1]             # false start byte: resynchronise
                continue
            out.append((sysid, compid, msgid, body.ljust(spec[1], b"\0")))
            del b[:total]
        if len(b) > 4096:
            del b[:-300]
        return out


def px4_mode(custom_mode: int) -> str:
    main, sub = (custom_mode >> 16) & 0xFF, (custom_mode >> 24) & 0xFF
    if main == 4:
        return PX4_AUTO.get(sub, "Auto")
    return PX4_MAIN.get(main, "Unknown")


_ports_cache = {"t": 0.0, "list": []}


def list_serial_ports() -> list[dict]:
    if time.monotonic() - _ports_cache["t"] < 3:
        return _ports_cache["list"]
    try:
        from serial.tools import list_ports
    except ImportError:
        return []
    out = []
    for p in list_ports.comports():
        text = f"{p.description} {p.manufacturer or ''} {p.product or ''}".lower()
        fc = (p.vid in (0x26AC, 0x3162, 0x2DAE, 0x1209) or
              any(k in text for k in ("px4", "pixhawk", "fmu", "holybro", "cubepilot")))
        radio = p.vid in (0x0403, 0x10C4) or "sik" in text or "radio" in text
        out.append({"port": p.device, "name": p.description, "fc": fc, "radio": radio})
    _ports_cache.update(t=time.monotonic(), list=out)
    return out


class FcLink:
    """Owns the transport, tracks the vehicle, and sends commands with retries."""

    def __init__(self, hub, settings: dict):
        self.hub = hub
        self.settings = settings
        self.parser = Parser()
        self.seq = 0
        self.lock = threading.Lock()
        self.ack_cv = threading.Condition()
        self.last_ack: dict | None = None
        self.sock: socket.socket | None = None
        self.serial = None
        self.peer = None                  # UDP address the autopilot talks from
        self.udp_port = None
        self.error = None
        self.source = None                # "udp" | "COMx"
        self.v = self._blank()
        self.texts: list[dict] = []
        self._want = None
        self._stop = threading.Event()

    @staticmethod
    def _blank():
        return {"sysid": None, "compid": None, "hb": 0.0, "armed": False, "mode": None, "autopilot": None,
                "landed": None, "volt": None, "pct": None, "alt": None, "vz": None, "pos_t": 0.0}

    # transport ---------------------------------------------------------
    def start(self):
        self.configure(self.settings.get("fc_port") or "udp")
        threading.Thread(target=self._rx_loop, daemon=True, name="mavlink-rx").start()
        threading.Thread(target=self._hb_loop, daemon=True, name="mavlink-hb").start()

    def configure(self, want: str):
        """want: 'udp' or a serial port name such as 'COM5'."""
        with self.lock:
            self._close_locked()
            self._want = want
            self.v = self._blank()
            self.error = None
            if want == "udp":
                self.source = "udp"
                for port in UDP_PORTS:
                    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                    try:
                        s.bind(("0.0.0.0", port))
                        s.settimeout(0.2)
                        self.sock, self.udp_port = s, port
                        break
                    except OSError:
                        s.close()
                if not self.sock:
                    self.error = "UDP 14550 and 14551 are both in use (QGroundControl open?)"
            else:
                self.source = want
                try:
                    import serial
                    baud = int(self.settings.get("fc_baud") or 57600)
                    self.serial = serial.Serial(want, baud, timeout=0.2, write_timeout=0.5)
                except ImportError:
                    self.error = "Serial support is not installed"
                except Exception as e:  # busy, missing, no permission
                    msg = str(e)
                    self.error = f"{want} could not be opened" + (
                        " (in use by QGroundControl?)" if "denied" in msg.lower() or "busy" in msg.lower() else f": {msg}")

    def _close_locked(self):
        for h in (self.sock, self.serial):
            try:
                h and h.close()
            except Exception:
                pass
        self.sock = self.serial = self.peer = self.udp_port = None

    def _send(self, msgid: int, payload: bytes) -> bool:
        with self.lock:
            frame = pack(msgid, payload, self.seq)
            self.seq = (self.seq + 1) & 0xFF
            try:
                if self.sock and self.peer:
                    self.sock.sendto(frame, self.peer)
                    return True
                if self.serial:
                    self.serial.write(frame)
                    return True
            except Exception as e:
                self.error = f"send failed: {e}"
        return False

    def _rx_loop(self):
        while not self._stop.is_set():
            sock, ser = self.sock, self.serial
            try:
                if sock:
                    data, addr = sock.recvfrom(4096)
                elif ser:
                    data, addr = ser.read(ser.in_waiting or 1), None
                else:
                    time.sleep(0.3)
                    if self._want and self._want != "udp" and not self.serial:
                        self.configure(self._want)    # retry a port that was busy or unplugged
                        time.sleep(1.7)
                    continue
            except socket.timeout:
                continue
            except Exception as e:
                if ser:
                    self.error = f"{self.source} disconnected"
                    with self.lock:
                        self._close_locked()
                time.sleep(0.5)
                continue
            for sysid, compid, msgid, body in self.parser.feed(data):
                self._handle(sysid, compid, msgid, body, addr)

    def _hb_loop(self):
        while not self._stop.is_set():
            time.sleep(1)
            if (self.sock and self.peer) or self.serial:
                self._send(0, heartbeat_payload())
            self.hub.publish("fc", self.status())

    # incoming ----------------------------------------------------------
    def _handle(self, sysid, compid, msgid, body, addr):
        v = self.v
        if msgid == 0:
            custom, mtype, autopilot, base, _st, _ver = struct.unpack_from("<IBBBBB", body)
            if mtype == 6 or autopilot == 8 or sysid == GCS_SYSID:
                return                     # another ground station, not the drone
            if compid != 1 and v["sysid"] == sysid:
                return                     # camera / companion on the same vehicle
            was = v["armed"]
            v.update(sysid=sysid, compid=compid, hb=time.monotonic(), armed=bool(base & 0x80),
                     mode=px4_mode(custom) if autopilot == 12 else f"mode {custom}", autopilot=autopilot)
            if addr:
                self.peer = addr
            if was != v["armed"]:
                self.hub.publish("fc", self.status())
            return
        if v["sysid"] is not None and sysid != v["sysid"]:
            return
        if msgid == 1:
            mv, = struct.unpack_from("<H", body, 14)
            pct, = struct.unpack_from("<b", body, 30)
            v["volt"] = mv / 1000 if mv not in (0, 0xFFFF) else None
            v["pct"] = pct if pct >= 0 else None
        elif msgid == 32:
            _t, _x, _y, z, _vx, _vy, vz = struct.unpack_from("<I6f", body)
            if math.isfinite(z):
                v.update(alt=-z, vz=-vz, pos_t=time.monotonic())
        elif msgid == 245:
            v["landed"] = LANDED.get(body[1])
        elif msgid == 77:
            cmd, result = struct.unpack_from("<HB", body)
            with self.ack_cv:
                self.last_ack = {"cmd": cmd, "result": result, "t": time.monotonic()}
                self.ack_cv.notify_all()
        elif msgid == 253:
            text = body[1:51].split(b"\0", 1)[0].decode("utf-8", "replace").strip()
            if text:
                self.texts.append({"t": time.monotonic(), "sev": body[0], "text": text})
                del self.texts[:-30]
                if body[0] <= 4:  # warning or worse: show it right away
                    self.hub.publish("fc_text", {"sev": body[0], "text": text})

    # status / commands -------------------------------------------------
    def connected(self) -> bool:
        return self.v["sysid"] is not None and time.monotonic() - self.v["hb"] < 2.5

    def status(self) -> dict:
        v, now = self.v, time.monotonic()
        alive = self.connected()
        return {
            "source": self.source,
            "port": self.udp_port,
            "peer": f"{self.peer[0]}:{self.peer[1]}" if self.peer else None,
            "error": self.error,
            "connected": alive,
            "seen": round(now - v["hb"], 1) if v["hb"] else None,
            "sysid": v["sysid"],
            "px4": v["autopilot"] == 12,
            "armed": v["armed"] if alive else None,
            "mode": v["mode"] if alive else None,
            "landed": v["landed"] if alive else None,
            "volt": v["volt"] if alive else None,
            "pct": v["pct"] if alive else None,
            "alt": round(v["alt"], 2) if alive and v["alt"] is not None and now - v["pos_t"] < 2 else None,
            "vz": round(v["vz"], 2) if alive and v["vz"] is not None and now - v["pos_t"] < 2 else None,
            "ports": list_serial_ports(),
            "want": self._want,
        }

    def command(self, name: str) -> dict:
        if name not in COMMANDS:
            raise ValueError(f"unknown command {name}")
        if not self.connected():
            return {"ok": False, "result": "no flight controller link"}
        cmd, params = COMMANDS[name]
        sysid, compid = self.v["sysid"], self.v["compid"] or 1
        tries = 6 if name == "disarm" else 3
        started = time.monotonic()
        result = None
        for conf in range(tries):
            with self.ack_cv:
                self.last_ack = None
            self._send(76, command_payload(cmd, params, sysid, compid, conf))
            deadline = time.monotonic() + (0.25 if name == "disarm" else 0.5)
            with self.ack_cv:
                while time.monotonic() < deadline:
                    a = self.last_ack
                    if a and a["cmd"] == cmd and a["result"] != 5:
                        result = a["result"]
                        break
                    self.ack_cv.wait(max(0.01, deadline - time.monotonic()))
            if result is not None:
                break
        # what the autopilot said about it (e.g. "Arming denied: ...")
        said = [t["text"] for t in self.texts if t["t"] >= started - 0.05][-2:]
        ok = result == 0
        self.hub.publish("fc", self.status())
        return {"ok": ok, "result": ACK.get(result, "no reply") if result is not None else "no reply",
                "text": " · ".join(said)}

    def stop(self):
        self._stop.set()
        with self.lock:
            self._close_locked()
