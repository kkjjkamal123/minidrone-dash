"""Pretend to be the drone: broadcast a track_tests.m simulation log over UDP, packet for packet
in the format groundStationTx.m sends. Use it to check a laptop's network and firewall setup.

    python tools/fake_drone.py ../track_zigzag7.mat            # broadcast, real time
    python tools/fake_drone.py ../track_zigzag7.mat --to 127.0.0.1 --speed 4
"""
import argparse
import socket
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from gs import protocol as P  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mat")
    ap.add_argument("--to", default="255.255.255.255")
    ap.add_argument("--port", type=int, default=P.PORT)
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--frames", type=int, default=0, help="stop after N frames")
    a = ap.parse_args()

    import scipy.io as sio

    m = sio.loadmat(a.mat)
    pos, pd, gd, masks = m["pos"], m["pd"], m["gd"], m.get("masks")
    n = masks.shape[2] if masks is not None else 0
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    total = pos.shape[0] if not a.frames else min(a.frames, pos.shape[0])
    t0 = time.monotonic()
    for k in range(total):
        mk = P.pack_mask(masks[:, :, k]) if k < n else None
        # live packets carry the carrot setpoint; fake one 0.15 m ahead along the heading
        import math
        tr = (pos[k, 0] + 0.15 * math.cos(pd[k, 3]), pos[k, 1] + 0.15 * math.sin(pd[k, 3]), -0.8, pd[k, 3])
        s.sendto(P.build(k + 1, (pos[k, 0], pos[k, 1], pd[k, 2], pd[k, 3]), tr, gd[k, :4], mk), (a.to, a.port))
        time.sleep(max(0.0, t0 + (k + 1) * P.FRAME_DT / a.speed - time.monotonic()))
    print(f"sent {total} frames to {a.to}:{a.port}")


if __name__ == "__main__":
    main()
