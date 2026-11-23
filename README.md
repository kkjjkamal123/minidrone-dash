# Minidrone Ground Station

Live telemetry, automatic flight recording and replay for the Minidrone 2026 drone.
Windows app; double-click `dist/Minidrone Ground Station.exe` (no Python needed).

## What you see

- **Flight path**: where the drone has flown, coloured by guidance state, with the carrot setpoint.
- **Drone camera**: the red mask `lineGuidance` sees, with the look-ahead ring and the line direction it picked.
- **Mission**: TAKEOFF → FOLLOW → COAST → SETTLE → LAND, with time spent in each.
- **Altitude, heading, speed, red pixels under the drone, flight time, link rate.**
- **Events**: every state change and touchdown, with timestamps.
- **Flights**: every drone flight is saved automatically to `Documents\Minidrone Ground Station\Flights`.
  `track_*.mat` runs from `track_tests.m` show up as simulation runs. Click one to replay it
  (Space play/pause, arrow keys step, drag the chart to seek).

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

**Before flying it in competition, run a desktop sim and a Pi build once to confirm both still pass.**

## Connecting

1. Laptop on the same Wi-Fi / cable as the drone.
2. Open the app. Packets arrive as soon as the drone arms.
3. Nothing arriving? Open **Setup**: it checks the receiver, Windows Firewall (one-click
   **Allow**, needs admin), the laptop's addresses, whether the Pi answers on SSH, and
   packet rate and loss.

To test a laptop without the drone, broadcast a simulation run as if it were the drone:

```
python tools/fake_drone.py ..\track_zigzag7.mat
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
| `gs/store.py` | recordings (`.mdgs`) and `track_*.mat` loading |
| `gs/server.py` | local HTTP API and live event stream |
| `ui/` | the interface (no internet needed) |
| `matlab/` | drone-side sender and the enable / disable scripts |
