# Minidrone Ground Station

Live telemetry, automatic flight recording and replay for the Minidrone 2026 drone.
Windows app; double-click `dist/Minidrone Ground Station.exe` (no Python needed).

## What you see

Sidebar with Live, Flights and Connection. The safety bar is pinned along the bottom of every page.

- **Live**: telemetry rail (altitude, heading, speed, red pixels under the drone, flight time, link rate,
  battery); map of the flown path coloured by guidance state, with the setpoint; the camera mask
  `lineGuidance` sees, with the look-ahead ring and the direction it picked; altitude over time; and
  every state change.
- **Flights**: every drone flight (saved automatically to `Documents\Minidrone Ground Station\Flights`)
  and every `track_*.mat` run from `track_tests.m`. Click a row to replay it: Space plays/pauses,
  arrow keys step, drag the chart to seek, Esc closes.
- **Connection**: receiver, firewall, network, Raspberry Pi and telemetry checks, with what to fix,
  and the flight controller link for the safety bar.

## Safety bar: ARM, LAND, DISARM

These go straight to PX4 on the Pixhawk over MAVLink, not through the Pi (the Pi only sends
setpoints to the Pixhawk). Each button must be **held** until its ring fills: ARM 1 s, LAND 0.6 s,
DISARM 0.5 s. Releasing early sends nothing. They are disabled with no flight controller link.

| Button | Sends | Effect |
|---|---|---|
| ARM | `MAV_CMD_COMPONENT_ARM_DISARM` 1 | PX4 runs its preflight checks; a refusal shows PX4's reason |
| LAND | `MAV_CMD_DO_SET_MODE` Auto / Land | see the warning below |
| DISARM | `MAV_CMD_COMPONENT_ARM_DISARM` 0 with force code 21196 | motors stop at once, **even in the air** |

**LAND warning.** The MathWorks `flightControlSystem` lands from the RC switch on channel 8
(`RC Failsafe Signal` drives `land_trigger`), and it does not follow PX4's own Land mode. So the app
watches the altitude after LAND: if the drone has not descended 15 cm within 3 s, the bar turns red
and says to use the RC land switch or DISARM. Test this once on the bench before relying on it.
**The RC transmitter stays the primary safety.**

The link: Connection, then *Flight controller*. Choose either:

- **Network (UDP 14550)**: PX4 over Wi-Fi or Ethernet, or QGroundControl forwarding. If
  QGroundControl on this laptop already holds 14550, the app listens on 14551: add the forwarding
  target `127.0.0.1:14551` in QGroundControl.
- **A COM port**: a Pixhawk USB cable or a telemetry radio (usually 57600 baud).

The app sends a ground-station heartbeat once a second. If PX4's `NAV_DLL_ACT` (data-link-loss
failsafe) is enabled, closing the app in flight triggers that failsafe. It is off by default.

## Drone setup (once per build)

The drone sends nothing to a laptop until the sender is added to the Pi model:

```matlab
openProject('minidrone_2026');
addpath('minidrone_2026_tools/groundstation/matlab');
enable_groundstation            % backs up PerceptionAndGuidance.slx, adds groundStationTx
Step_2_Deploy_PerceptionModel   % then Build, Deploy & Start as usual
```

`groundStationTx` sits next to `lineGuidance` and only reads its inputs and outputs. It
replaces the `dbgTerm` terminator; no flight signal changes. In the Raspberry Pi build it
broadcasts one 2460-byte UDP packet per guidance frame (5 Hz) on port 47800 to every
network interface, so no IP address is configured anywhere. In desktop simulation it does
nothing. `disable_groundstation` restores the backup.

Verified on R2026b: desktop simulation of the block, Embedded Coder generation (header found, no
OpenMP), the generated C cross-compiled for 32/64-bit ARM Linux, packets from that C decoded
byte-for-byte by the app, and enable / re-run / disable on a copy of the project.
**Still to do on the real drone: one Pi build and one flight with the laptop on the drone's network.**

## Connecting

1. Laptop on the same Wi-Fi / cable as the drone.
2. Open the app. Packets arrive as soon as the drone arms.
3. Nothing arriving? Open the **Connection** tab: it checks the receiver, Windows Firewall (one-click
   **Allow**, needs admin), the laptop's addresses, whether the Pi answers on SSH, and
   packet rate and loss.

To test a laptop without the drone, broadcast a simulation run as if it were the drone, and
pretend to be PX4 for the safety bar:

```
python tools/fake_drone.py ..\track_zigzag7.mat
python tools/fake_px4.py                 # or --deny-arm, or --ignore-land
```

## Developing

```
pip install -r requirements.txt
python app.py               # window
python app.py --headless    # server only, open http://127.0.0.1:47801
powershell -ExecutionPolicy Bypass -File build.ps1   # rebuild the exe
```

| Path | |
|---|---|
| `app.py` | entry point, opens the window (WebView2, falls back to an Edge app window) |
| `gs/protocol.py` | packet format, shared with `matlab/groundStationTx.m` |
| `gs/link.py` | UDP receiver, sessions, demo feed, firewall / Pi checks |
| `gs/mavlink.py` | flight controller link and the ARM / LAND / DISARM commands |
| `gs/store.py` | recordings (`.mdgs`) and `track_*.mat` loading |
| `gs/server.py` | local HTTP API and live event stream |
| `ui/` | the interface (no internet needed) |
| `matlab/` | drone-side sender and the enable / disable scripts |
