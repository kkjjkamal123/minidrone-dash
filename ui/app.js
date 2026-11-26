"use strict";
/* Minidrone Ground Station UI: live telemetry, recorded flights, simulation replays, safety controls. */

const STATES = ["TAKEOFF", "FOLLOW", "COAST", "SETTLE", "LAND"];
const STATE_LABEL = ["Takeoff", "Follow", "Coast", "Settle", "Land"];
const CAM = { W: 160, H: 120, RC: 60.5, CC: 80.5, RIN: 35, R1: 48, R2: 58 };
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const stateColor = (s) => css(`--s${s}`) || css("--muted");

const S = {
  mode: "live",                // live | replay
  page: "main",
  live: { frames: [], source: null, sender: null, track: null },
  replay: null,                // { flight, idx, playing, speed, playT }
  status: null,
  fc: null,                    // flight controller (MAVLink) state
  cmd: null,                   // last safety command: { name, ok, text, at }
  landWatch: null,             // { at, alt0, fail } while checking that LAND makes the drone descend
  dirty: true,
};

/* ---------- helpers ---------- */
const fmtT = (t) => {
  if (t == null || isNaN(t)) return "--";
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};
const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtAgo = (t) => (t == null ? "a while" : t < 90 ? `${Math.round(t)} s` : t < 5400 ? `${Math.round(t / 60)} min` : `${Math.round(t / 3600)} h`);
const wrap360 = (deg) => ((deg % 360) + 360) % 360;
const dec64 = (() => {
  const cache = new Map();
  return (b64) => {
    if (!b64) return null;
    let v = cache.get(b64);
    if (!v) {
      const s = atob(b64);
      v = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) v[i] = s.charCodeAt(i);
      if (cache.size > 400) cache.clear();
      cache.set(b64, v);
    }
    return v;
  };
})();
function toast(msg, action, onAction, bad) {
  const el = $("toast");
  el.innerHTML = "";
  el.className = "toast" + (bad ? " bad" : "");
  el.append(msg);
  if (action) {
    const b = document.createElement("button");
    b.className = "btn"; b.textContent = action;
    b.onclick = () => { el.hidden = true; onAction(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), action ? 8000 : bad ? 6000 : 3500);
}
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json", "X-Ground-Station": "1" }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const r = c.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

/* ---------- current view ---------- */
function view() {
  if (S.mode === "replay" && S.replay) {
    const f = S.replay.flight;
    return { frames: f.frames, idx: S.replay.idx, track: f.track, kind: f.kind };
  }
  const fr = S.live.frames;
  return { frames: fr, idx: fr.length - 1, track: S.live.track, kind: "live" };
}

/* ---------- map ---------- */
function drawMap() {
  const c = $("map");
  const { ctx, w, h } = fitCanvas(c);
  ctx.clearRect(0, 0, w, h);
  const v = view();
  const fr = v.frames.slice(0, v.idx + 1);
  const cur = fr[fr.length - 1];

  // world bounds (x = north/forward, y = east/right)
  let xs = [], ys = [];
  if (v.track) {
    v.track.pts.forEach((p) => { xs.push(p[0]); ys.push(p[1]); });
    xs.push(v.track.circle[0] - .2, v.track.circle[0] + .2); ys.push(v.track.circle[1] - .2, v.track.circle[1] + .2);
    v.frames.forEach((f) => { if (f.x != null) { xs.push(f.x); ys.push(f.y); } });
  } else {
    v.frames.forEach((f) => { if (f.x != null) { xs.push(f.x); ys.push(f.y); } if (f.tx != null) { xs.push(f.tx); ys.push(f.ty); } });
  }
  if (!xs.length) { xs = [-1, 1]; ys = [-1, 1]; }
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const span = Math.max(x1 - x0, y1 - y0, 1.6) + 0.5;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const pad = 26;
  if (w < 60 || h < 60) return;
  const sc = Math.max(1, Math.min((w - 2 * pad) / span, (h - 2 * pad) / span));
  const P = (x, y) => [w / 2 + (y - cy) * sc, h / 2 - (x - cx) * sc];

  // grid every 0.5 m
  const gx0 = Math.floor((cx - h / 2 / sc) * 2) / 2, gx1 = cx + h / 2 / sc;
  const gy0 = Math.floor((cy - w / 2 / sc) * 2) / 2, gy1 = cy + w / 2 / sc;
  ctx.lineWidth = 1;
  for (let x = gx0; x <= gx1; x += 0.5) {
    const [, py] = P(x, 0);
    ctx.strokeStyle = Math.abs(x % 1) < 1e-6 ? css("--grid-2") : css("--grid");
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke();
  }
  for (let y = gy0; y <= gy1; y += 0.5) {
    const [px] = P(0, y);
    ctx.strokeStyle = Math.abs(y % 1) < 1e-6 ? css("--grid-2") : css("--grid");
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }
  // 1 m scale bar
  ctx.strokeStyle = css("--muted"); ctx.fillStyle = css("--muted"); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(12, h - 18); ctx.lineTo(12, h - 12); ctx.lineTo(12 + sc, h - 12); ctx.lineTo(12 + sc, h - 18); ctx.stroke();
  ctx.font = "11px " + css("--font"); ctx.textAlign = "center"; ctx.fillText("1 m", 12 + sc / 2, h - 17); ctx.textAlign = "left";
  // north arrow
  ctx.save(); ctx.translate(w - 20, 24); ctx.fillStyle = css("--muted"); ctx.strokeStyle = css("--muted"); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(5, 4); ctx.lineTo(0, 1); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(-5, 4); ctx.lineTo(0, 1); ctx.closePath(); ctx.stroke();
  ctx.textAlign = "center"; ctx.font = "11px " + css("--font"); ctx.fillText(v.track ? "N" : "Fwd", 0, 17); ctx.restore();

  // track
  if (v.track) {
    ctx.strokeStyle = css("--track"); ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(3, 0.1 * sc);
    ctx.beginPath();
    v.track.pts.forEach((p, i) => { const [a, b] = P(p[0], p[1]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
    ctx.stroke();
    const [ca, cb] = P(v.track.circle[0], v.track.circle[1]);
    ctx.fillStyle = css("--track"); ctx.beginPath(); ctx.arc(ca, cb, v.track.r * sc, 0, 7); ctx.fill();
    const [sa, sb] = P(v.track.pts[0][0], v.track.pts[0][1]);
    ctx.fillStyle = css("--muted"); ctx.font = "11px " + css("--font"); ctx.fillText("start", sa + 9, sb + 4);
  }

  // ghost of the whole flight (replay), then flown path by state
  if (S.mode === "replay") {
    ctx.strokeStyle = css("--line-2"); ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]);
    ctx.beginPath(); let first = true;
    v.frames.forEach((f) => { if (f.x == null) return; const [a, b] = P(f.x, f.y); first ? ctx.moveTo(a, b) : ctx.lineTo(a, b); first = false; });
    ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.lineWidth = 2.6; ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (let i = 1; i < fr.length; i++) {
    const a = fr[i - 1], b = fr[i];
    if (a.x == null || b.x == null) continue;
    ctx.strokeStyle = stateColor(b.st ?? 0);
    const [p, q] = P(a.x, a.y), [r, s] = P(b.x, b.y);
    ctx.beginPath(); ctx.moveTo(p, q); ctx.lineTo(r, s); ctx.stroke();
  }

  if (!cur || cur.x == null) { $("mapFoot").textContent = "0.5 m grid"; return; }
  const [dx, dy] = P(cur.x, cur.y);
  // carrot / setpoint
  if (cur.tx != null && cur.ty != null) {
    const [tx, ty] = P(cur.tx, cur.ty);
    ctx.strokeStyle = css("--text"); ctx.globalAlpha = .55; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(dx, dy); ctx.lineTo(tx, ty); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.strokeStyle = css("--text"); ctx.beginPath(); ctx.arc(tx, ty, 5, 0, 7); ctx.stroke();
  }
  // drone glyph
  const yaw = cur.yaw ?? 0;
  ctx.save(); ctx.translate(dx, dy); ctx.rotate(yaw);
  const col = stateColor(cur.st ?? 0);
  ctx.strokeStyle = css("--text"); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-8, -8); ctx.lineTo(8, 8); ctx.moveTo(8, -8); ctx.lineTo(-8, 8); ctx.stroke();
  [[-8, -8], [8, -8], [-8, 8], [8, 8]].forEach(([a, b]) => { ctx.beginPath(); ctx.arc(a, b, 5, 0, 7); ctx.stroke(); });
  ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(5, -12); ctx.lineTo(-5, -12); ctx.closePath(); ctx.fill();
  ctx.restore();

  $("mapFoot").textContent = v.track ? "arena frame, north up" : "relative to arming heading";
}

/* ---------- camera ---------- */
const camBuf = document.createElement("canvas");
camBuf.width = CAM.W; camBuf.height = CAM.H;
const CAMV = { want: (() => { try { return localStorage.getItem("camView") || "live"; } catch { return "live"; } })(), on: false };
function camLiveShown() { return S.mode === "live" && CAMV.want === "live" && S.status?.camera?.state === "live"; }
function renderCamLive() {
  const st = S.status?.camera, img = $("camLive"), show = camLiveShown();
  if (show && !CAMV.on) { img.src = "/api/cam.mjpg?t=" + Date.now(); CAMV.on = true; }
  if (!show && CAMV.on) { img.removeAttribute("src"); CAMV.on = false; }
  img.hidden = !show; $("camBadge").hidden = !show;
  document.querySelectorAll("#camSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === CAMV.want));
  if (show) { $("camEmpty").hidden = true; $("camInfo").textContent = `Pi camera · ${st.fps.toFixed(0)} fps`; }
  else S.dirty = true;
}
const CAM_MSG = {
  off: "Live camera is off", no_pi: "Pi not connected", connecting: "Connecting to the Pi camera…",
  busy: "Flight model is using the camera, showing its mask", auth: "SSH login refused", error: "Camera link error",
  camfail: "Camera not responding",
};
$("camSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  CAMV.want = b.dataset.v; try { localStorage.setItem("camView", CAMV.want); } catch {}
  renderCamLive(); S.dirty = true;
});
function drawCam() {
  if (camLiveShown()) return;
  const v = view();
  const c = $("cam"), ctx = c.getContext("2d");
  const cur = v.frames[v.idx];
  let k = v.idx, m = null;
  while (k >= 0 && k > v.idx - 3) { if (v.frames[k] && v.frames[k].m) { m = v.frames[k].m; break; } k--; }
  const cs = S.status?.camera;
  const liveNote = S.mode === "live" && CAMV.want === "live" && cs && cs.state !== "live"
    ? (CAM_MSG[cs.state] || "") + (cs.detail && !["no_pi", "connecting", "busy"].includes(cs.state) ? `: ${cs.detail}` : "") : "";
  $("camEmpty").hidden = !!m;
  $("camEmpty").textContent = liveNote && !m ? liveNote
    : v.frames.length && v.kind === "sim" ? "Simulation logs keep camera frames for the first 12 s only"
    : v.frames.length ? "No camera image in this frame" : "No image yet";
  ctx.clearRect(0, 0, c.width, c.height);
  if (!m) { $("camInfo").textContent = liveNote ? "" : "160×120"; return; }
  const bits = dec64(m);
  const bctx = camBuf.getContext("2d");
  const img = bctx.createImageData(CAM.W, CAM.H);
  let red = 0;
  for (let c0 = 0; c0 < CAM.W; c0++) {
    for (let r = 0; r < CAM.H; r++) {
      const i = c0 * CAM.H + r;
      const on = (bits[i >> 3] >> (i & 7)) & 1;
      const o = (r * CAM.W + c0) * 4;
      if (on) { img.data[o] = 228; img.data[o + 1] = 62; img.data[o + 2] = 58; red++; }
      else { img.data[o] = 20; img.data[o + 1] = 20; img.data[o + 2] = 20; }
      img.data[o + 3] = 255;
    }
  }
  bctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(camBuf, 0, 0, c.width, c.height);
  const s = c.width / CAM.W, ox = (CAM.CC - .5) * s, oy = (CAM.RC - .5) * s;
  // look-ahead ring band and centre disk
  ctx.fillStyle = "rgba(120,170,220,.10)";
  ctx.beginPath(); ctx.arc(ox, oy, CAM.R2 * s, 0, 7); ctx.arc(ox, oy, CAM.R1 * s, 0, 7, true); ctx.fill();
  ctx.strokeStyle = "rgba(150,190,230,.55)"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(ox, oy, CAM.R1 * s, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.arc(ox, oy, CAM.R2 * s, 0, 7); ctx.stroke();
  ctx.setLineDash([6, 6]); ctx.strokeStyle = "rgba(255,255,255,.35)";
  ctx.beginPath(); ctx.arc(ox, oy, CAM.RIN * s, 0, 7); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(ox - 10, oy); ctx.lineTo(ox + 10, oy); ctx.moveTo(ox, oy - 10); ctx.lineTo(ox, oy + 10); ctx.stroke();
  // chosen line direction, relative to the nose (image up = forward)
  if (cur && cur.dw != null && cur.yaw != null) {
    const rel = cur.dw - cur.yaw, L = CAM.R2 * s;
    const ex = ox + Math.sin(rel) * L, ey = oy - Math.cos(rel) * L;
    ctx.strokeStyle = "#f2f2f2"; ctx.lineWidth = 3; ctx.lineCap = "butt";
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.fillStyle = "#f2f2f2"; ctx.fillRect(ex - 6, ey - 6, 12, 12);
  }
  ctx.fillStyle = "rgba(255,255,255,.6)"; ctx.font = "20px " + css("--font"); ctx.textAlign = "center";
  ctx.fillText("nose", ox, 26);
  $("camInfo").textContent = `${red} px red · 160×120`;
}

/* ---------- guidance timeline (command bar) and telemetry rail ---------- */
function stateRuns(frames, idx) {
  // time spent in each state up to idx, and when the current state started
  const per = [0, 0, 0, 0, 0];
  let since = frames.length ? frames[0].t : 0;
  for (let i = 0; i <= idx; i++) {
    const f = frames[i];
    if (i > 0 && f.st !== frames[i - 1].st) since = f.t;
    if (i < idx && f.st != null) per[f.st] += frames[i + 1].t - f.t;
  }
  return { per, since };
}
function drawTimeline() {
  const v = view(), cur = v.frames[v.idx];
  const st = cur ? cur.st : null;
  const { per, since } = stateRuns(v.frames, v.idx);
  const reached = Math.max(-1, ...v.frames.slice(0, v.idx + 1).map((f) => f.st ?? -1));
  const chev = `<svg class="chev" viewBox="0 0 8 8"><use href="#i-chev"/></svg>`;
  $("timeline").innerHTML = STATES.map((_, i) => {
    const cls = i === st ? "on" : i <= reached ? "done" : "";
    const tt = i === st ? (cur.t - since) : per[i];
    return `${i ? chev : ""}<span class="st ${cls}" style="--c:${stateColor(i)}">${STATE_LABEL[i]}${tt > 0 ? ` <small>${tt.toFixed(1)} s</small>` : ""}</span>`;
  }).join("") + `<span class="stepn">${st != null ? `step ${st + 1} of ${STATES.length}` : "guidance: no data"}</span>`;
  // narrow window: show only the current step rather than letting the row run under the buttons
  const tlEl = $("timeline");
  tlEl.classList.remove("compact");
  if (tlEl.scrollWidth > tlEl.parentElement.clientWidth) tlEl.classList.add("compact");
  $("stateFor").textContent = cur ? `frame ${cur.f ?? v.idx + 1}` : "";
  return { st, inState: cur ? cur.t - since : 0 };
}

const RAIL = [
  { id: "alt", title: "Altitude", icon: "i-alt", unit: "m" },
  { id: "hdg", title: "Heading", icon: "i-hdg", unit: "" },
  { id: "spd", title: "Speed", icon: "i-spd", unit: "m/s" },
  { id: "red", title: "Red below", icon: "i-red", unit: "px" },
  { id: "time", title: "Flight time", icon: "i-time", unit: "" },
  { id: "link", title: "Link", icon: "i-link", unit: "Hz" },
  { id: "bat", title: "Battery", icon: "i-bat", unit: "V" },
];
$("rail").innerHTML = RAIL.map((c) => `<div class="cell" id="c-${c.id}">
  <div class="eb"><svg viewBox="0 0 24 24"><use href="#${c.icon}"/></svg>${c.title}</div>
  <div class="val"><b class="none">--</b><small>${c.unit}</small></div>
  <div class="gauge empty"><i></i></div><div class="fn">&nbsp;</div></div>`).join("");
function cell(id, value, foot, gauge, tint) {
  const el = $("c-" + id);
  const b = el.querySelector("b");
  b.textContent = value ?? "--";
  b.className = value == null ? "none" : "";
  b.style.color = value != null && tint ? tint : "";
  el.querySelector(".fn").textContent = foot || " ";
  const g = el.querySelector(".gauge");
  g.classList.toggle("empty", gauge == null);
  if (gauge != null) {
    g.firstElementChild.style.width = `${Math.max(2, Math.min(100, gauge.f * 100))}%`;
    g.firstElementChild.style.setProperty("--g", gauge.c || css("--signal"));
  }
}
function drawRail(tl) {
  const v = view(), cur = v.frames[v.idx];
  if (!cur) {
    cell("alt", null, "guidance altitude"); cell("hdg", null, ""); cell("spd", null, "");
    cell("red", null, ""); cell("time", null, "");
    $("tPos").textContent = "--"; $("tSet").textContent = "--";
  } else {
    const alt = cur.z != null ? Math.max(0, -cur.z) : null;
    cell("alt", alt?.toFixed(2), cur.tz != null ? `setpoint ${Math.max(0, -cur.tz).toFixed(2)} m` : "guidance altitude",
      alt != null ? { f: alt / 1.5 } : null);
    cell("hdg", cur.yaw != null ? `${Math.round(wrap360(cur.yaw * 180 / Math.PI))}°` : null, "from arming heading");
    const back = v.frames[Math.max(0, v.idx - 5)], dt = cur.t - back.t;
    const spd = dt > 0 && cur.x != null && back.x != null ? Math.hypot(cur.x - back.x, cur.y - back.y) / dt : 0;
    cell("spd", spd.toFixed(2), "over the last second", { f: spd / 0.5 });
    cell("red", cur.nc != null ? String(cur.nc) : null, "in the camera mask");
    cell("time", fmtT(cur.t), tl.st != null ? `${STATE_LABEL[tl.st]} for ${tl.inState.toFixed(1)} s` : "");
    $("tPos").textContent = cur.x != null ? `${cur.x.toFixed(2)}, ${cur.y.toFixed(2)}` : "--";
    $("tSet").textContent = cur.tx != null ? `${cur.tx.toFixed(2)}, ${cur.ty.toFixed(2)}` : "--";
  }
  const st = S.status;
  if (S.mode === "replay") cell("link", null, "replay");
  else if (st && st.session) cell("link", st.rate.toFixed(1), `${st.packets} packets · ${st.dropped} lost`,
    { f: st.rate / 5, c: st.since_rx < 1.5 ? css("--ok") : css("--caution") });
  else cell("link", null, "waiting for the Pi");
  const fc = S.fc;
  if (fc && fc.connected && fc.volt != null) {
    const cells = Math.max(1, Math.round(fc.volt / 3.85)), per = fc.volt / cells;
    const tint = per < 3.5 ? css("--critical") : per < 3.65 ? css("--caution") : null;
    cell("bat", fc.volt.toFixed(1), (fc.pct != null ? `${fc.pct}% · ` : "") + `${per.toFixed(2)} V/cell`,
      fc.pct != null ? { f: fc.pct / 100, c: tint || css("--ok") } : null, tint);
  } else cell("bat", null, "from the flight controller");
}
/* ---------- altitude / state chart ---------- */
function drawChart() {
  const c = $("chart");
  const { ctx, w, h } = fitCanvas(c);
  ctx.clearRect(0, 0, w, h);
  const v = view(), fr = v.frames;
  const L = 44, R = 14, T = 10, B = 30, band = 8;
  const tEnd = S.mode === "replay" ? (fr.length ? fr[fr.length - 1].t : 1) : Math.max(30, fr.length ? fr[fr.length - 1].t + 2 : 30);
  const amax = Math.max(1, ...fr.map((f) => (f.z != null ? -f.z : 0))) * 1.1;
  const X = (t) => L + (t / tEnd) * (w - L - R);
  const Y = (a) => T + (1 - a / amax) * (h - T - B - band - 6);
  ctx.font = "11px " + css("--font"); ctx.fillStyle = css("--faint"); ctx.strokeStyle = css("--grid-2"); ctx.lineWidth = 1;
  for (let a = 0; a <= amax; a += 0.25) {
    const y = Y(a);
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
    if (Math.abs(a % 0.5) < 1e-6) { ctx.textAlign = "right"; ctx.fillText(a.toFixed(1) + " m", L - 6, y + 4); }
  }
  const step = tEnd > 120 ? 20 : tEnd > 60 ? 10 : 5;
  ctx.textAlign = "center";
  for (let t = 0; t <= tEnd; t += step) ctx.fillText(t + " s", X(t), h - 6);
  // state band
  const by = h - B - band + 2;
  for (let i = 0; i < fr.length - 1; i++) {
    ctx.fillStyle = stateColor(fr[i].st ?? 0);
    ctx.fillRect(X(fr[i].t), by, Math.max(1, X(fr[i + 1].t) - X(fr[i].t)), band);
  }
  // altitude line (played part solid)
  const n = S.mode === "replay" ? fr.length : fr.length;
  const drawLine = (from, to, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); let first = true;
    for (let i = from; i < to; i++) {
      const f = fr[i]; if (f.z == null) continue;
      const x = X(f.t), y = Y(-f.z); first ? ctx.moveTo(x, y) : ctx.lineTo(x, y); first = false;
    }
    ctx.stroke();
  };
  if (S.mode === "replay") {
    drawLine(0, n, css("--line-2"), 1.5);
    drawLine(0, v.idx + 1, css("--signal"), 2);
    const cur = fr[v.idx];
    if (cur) {
      ctx.strokeStyle = css("--accent"); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(X(cur.t), T); ctx.lineTo(X(cur.t), by + band); ctx.stroke();
    }
  } else drawLine(0, n, css("--signal"), 2);
}

/* ---------- events ---------- */
function buildEvents(frames) {
  const ev = [];
  let touched = false;
  frames.forEach((f, i) => {
    if (i === 0 || f.st !== frames[i - 1].st) {
      if (f.st != null) ev.push({ t: f.t, i, st: f.st, text: i === 0 ? `Started in ${STATE_LABEL[f.st]}` : `${STATE_LABEL[frames[i - 1].st] ?? "?"} → ${STATE_LABEL[f.st]}` });
    }
    if (!touched && f.st === 4 && f.z != null && f.z > -0.06) {
      touched = true; ev.push({ t: f.t, i, st: 4, text: "Touchdown" });
    }
  });
  return ev;
}
function drawEvents() {
  const v = view();
  const replay = S.mode === "replay";
  const ev = buildEvents(v.frames).filter((e) => replay || e.i <= v.idx);
  const ul = $("events");
  if (!ev.length) { ul.innerHTML = `<li class="empty">State changes appear here.</li>`; return; }
  let cur = -1;
  ev.forEach((e, k) => { if (e.i <= v.idx) cur = k; });
  ul.innerHTML = ev.map((e, k) => `<li class="${replay ? "click" : ""}${k === cur ? " now" : ""}${replay && e.i > v.idx ? " later" : ""}" data-i="${e.i}">
      <time>${e.t.toFixed(1)} s</time><span class="dot" style="background:${stateColor(e.st)}"></span>${e.text}</li>`).join("");
  if (!replay) ul.scrollTop = ul.scrollHeight;
  else if (cur >= 0) {
    const li = ul.children[cur];
    if (li.offsetTop < ul.scrollTop || li.offsetTop + li.offsetHeight > ul.scrollTop + ul.clientHeight)
      ul.scrollTop = li.offsetTop - ul.clientHeight / 2;
  }
}
$("events").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li && S.mode === "replay") seek(+li.dataset.i);
});
/* ---------- replay ---------- */
function setPlaying(p) {
  S.replay.playing = p;
  $("icoPlay").innerHTML = p ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  S.replay.wall = performance.now();
}
function tickReplay() {
  const r = S.replay, fr = r.flight.frames;
  const now = performance.now();
  r.playT += (now - r.wall) / 1000 * r.speed; r.wall = now;
  let i = r.idx;
  while (i + 1 < fr.length && fr[i + 1].t <= r.playT) i++;
  if (i !== r.idx) { r.idx = i; S.dirty = true; }
  if (i >= fr.length - 1) { setPlaying(false); S.dirty = true; }
}
function seek(i) {
  const r = S.replay; if (!r) return;
  r.idx = Math.max(0, Math.min(r.flight.frames.length - 1, i));
  r.playT = r.flight.frames[r.idx].t;
  S.dirty = true;
}
async function openFlight(id) {
  let f;
  try { f = await api("/api/flight?id=" + encodeURIComponent(id)); }
  catch (e) { toast("Could not open flight: " + e.message); return; }
  if (!f.frames.length) { toast("That flight has no data"); return; }
  S.replay = { flight: f, idx: 0, playing: false, speed: 1, playT: f.frames[0].t, wall: performance.now() };
  S.mode = "replay";
  showPage("main");
  $("replayKind").textContent = f.kind === "sim" ? "Simulation" : "Drone flight";
  $("replayName").textContent = f.name;
  const s = f.summary;
  $("replayMeta").textContent = `${fmtT(s.duration)}, ${s.distance} m flown, ${s.landed ? "landed" : "ended in " + (STATE_LABEL[STATES.indexOf(s.reached)] || "?").toLowerCase()}`;
  $("player").hidden = false; $("scrub").hidden = false;
  $("scrub").max = f.frames.length - 1;
  renderSpeed();
  setPlaying(true);
  S.dirty = true;
}
function goLive() {
  S.mode = "live"; S.replay = null;
  $("player").hidden = true; $("scrub").hidden = true;
  showPage("main"); S.dirty = true;
}
function renderSpeed() {
  $("speedSeg").innerHTML = [0.5, 1, 2, 4].map((s) => `<button data-s="${s}" class="${S.replay && S.replay.speed === s ? "on" : ""}">${s}×</button>`).join("");
}
$("speedSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b || !S.replay) return;
  S.replay.speed = +b.dataset.s; renderSpeed();
});
$("btnPlay").onclick = () => {
  if (!S.replay) return;
  if (S.replay.idx >= S.replay.flight.frames.length - 1) seek(0);
  setPlaying(!S.replay.playing);
};
$("scrub").addEventListener("input", (e) => { setPlaying(false); seek(+e.target.value); });
$("chart").addEventListener("pointerdown", (e) => {
  if (S.mode !== "replay") return;
  const pick = (ev) => {
    const r = $("chart").getBoundingClientRect(), fr = S.replay.flight.frames;
    const t = ((ev.clientX - r.left - 44) / (r.width - 58)) * fr[fr.length - 1].t;
    let i = fr.findIndex((f) => f.t >= t); if (i < 0) i = fr.length - 1;
    setPlaying(false); seek(i);
  };
  pick(e);
  const move = (ev) => pick(ev);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", () => window.removeEventListener("pointermove", move), { once: true });
});
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.closest(".hold")) return;
  if (e.key === "Escape") { if (S.page !== "main") showPage("main"); else if (S.mode === "replay") goLive(); }
  if (S.mode !== "replay") return;
  if (e.key === " ") { e.preventDefault(); $("btnPlay").click(); }
  if (e.key === "ArrowRight") { setPlaying(false); seek(S.replay.idx + (e.shiftKey ? 10 : 1)); }
  if (e.key === "ArrowLeft") { setPlaying(false); seek(S.replay.idx - (e.shiftKey ? 10 : 1)); }
});
$("btnBackLive").onclick = goLive;
/* ---------- flights page ---------- */
function flightRow(f) {
  const tis = f.time_in_state || [];
  const tot = tis.reduce((a, b) => a + b, 0) || 1;
  const prof = tis.map((x, i) => `<i style="width:${(x / tot) * 100}%;background:var(--s${i})" title="${STATE_LABEL[i]} ${x.toFixed(1)} s"></i>`).join("");
  const when = new Date(f.when).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const res = f.error ? `<span class="res-warn">Unreadable</span>`
    : f.landed ? `<span class="res-ok">Landed</span>`
    : `<span class="res-warn">Stopped in ${(STATE_LABEL[STATES.indexOf(f.reached)] || "?").toLowerCase()}</span>`;
  const act = f.kind === "flight" ? `<button class="btn danger" data-del="${encodeURIComponent(f.id)}">Delete</button>` : "";
  return `<tr class="row" data-id="${encodeURIComponent(f.id)}">
      <td>${esc(f.name)}</td><td>${when}</td>
      <td class="num">${f.error ? "" : fmtT(f.duration)}</td><td class="num">${f.error ? "" : Number(f.distance ?? 0).toFixed(2) + " m"}</td>
      <td>${res}</td><td><div class="prof">${prof}</div></td><td>${act}</td></tr>`;
}
async function refreshFlights() {
  let list = [];
  try { list = await api("/api/flights"); } catch { /* keep empty */ }
  const rec = list.filter((f) => f.kind === "flight"), sim = list.filter((f) => f.kind === "sim");
  const group = (title, rows, empty) => `<tr class="group"><td colspan="7">${title} (${rows.length})</td></tr>` +
    (rows.length ? rows.map(flightRow).join("") : `<tr class="none"><td colspan="7">${empty}</td></tr>`);
  $("flightRows").innerHTML =
    group("Drone flights", rec, "None yet. Flights are saved here automatically while the drone sends telemetry.") +
    group("Simulation runs", sim, "No <code>track_*.mat</code> logs found. Run <code>track_tests.m</code> to create them.");
  $("flightCount").textContent = rec.length ? rec.length : "";
  $("flightSummary").textContent = `${rec.length} drone flight${rec.length === 1 ? "" : "s"}, ${sim.length} simulation run${sim.length === 1 ? "" : "s"}. Click a row to replay it.`;
}
$("flightRows").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    if (!confirmDelete(del)) return;
    await api("/api/flight/delete", { id: decodeURIComponent(del.dataset.del) });
    refreshFlights(); return;
  }
  const row = e.target.closest("tr.row");
  if (row) openFlight(decodeURIComponent(row.dataset.id));
});
function confirmDelete(el) {
  // two-step delete without a blocking dialog
  if (el.dataset.armed) return true;
  el.dataset.armed = "1"; el.textContent = "Confirm";
  setTimeout(() => { delete el.dataset.armed; el.textContent = "Delete"; }, 3000);
  return false;
}
$("btnFolder").onclick = () => api("/api/open-folder", {});

/* ---------- render loop ---------- */
function render() {
  if (S.dirty) {
    S.dirty = false;
    const v = view();
    const waiting = S.mode === "live" && v.frames.length === 0;
    $("waiting").hidden = !waiting;
    document.querySelector(".map-chips").hidden = waiting;
    drawMap(); drawCam(); drawChart(); drawEvents();
    drawRail(drawTimeline());
    renderActivity();
    if (S.mode === "replay") {
      $("scrub").value = S.replay.idx;
      const f = v.frames[S.replay.idx];
      const last = v.frames[v.frames.length - 1];
      $("playTime").textContent = f ? `${f.t.toFixed(1)} / ${last.t.toFixed(1)} s` : "";
    }
  }
  if (S.mode === "replay" && S.replay.playing) tickReplay();
  requestAnimationFrame(render);
}
window.addEventListener("resize", () => (S.dirty = true));

/* ---------- live stream ---------- */
function connectStream() {
  const es = new EventSource("/api/stream");
  es.addEventListener("session", (e) => {
    const d = JSON.parse(e.data);
    if (d.state === "start") {
      S.live = { frames: [], source: d.source, sender: d.sender, track: null };
      if (S.mode === "replay" && d.source === "drone") toast("Drone is sending telemetry", "Go live", goLive);
    } else if (d.state === "end") {
      if (d.saved) toast("Flight saved", "Replay it", () => openFlight(d.saved));
      refreshFlights();
    }
    S.dirty = true;
  });
  es.addEventListener("frame", (e) => {
    const f = JSON.parse(e.data);
    const L = S.live.frames;
    if (L.length && f.t < L[L.length - 1].t) L.length = 0;
    L.push(f);
    if (L.length > 20000) L.splice(0, L.length - 20000);
    if (S.mode === "live") S.dirty = true;
  });
  es.addEventListener("fc", (e) => { S.fc = JSON.parse(e.data); renderCmd(); });
  es.addEventListener("fc_text", (e) => {
    const d = JSON.parse(e.data);
    toast(`PX4: ${d.text}`, null, null, d.sev <= 3);
  });
}

/* ---------- sidebar link card, toolbar activity field ---------- */
function dot(el, color, live) {
  el.style.setProperty("--c", color);
  el.classList.toggle("live", !!live);
}
function renderActivity() {
  const st = S.status, v = view(), cur = v.frames[v.idx];
  const src = $("actSrc"), state = $("actState"), ep = $("actEp");
  const stTxt = (c) => (c && c.st != null ? STATE_LABEL[c.st] : null);
  state.style.color = cur && cur.st != null ? stateColor(cur.st) : "";
  if (S.mode === "replay") {
    src.textContent = "REPLAY"; src.className = "act-src replay";
    dot($("actDot"), css("--signal"), false);
    state.textContent = stTxt(cur) || "--";
    ep.textContent = S.replay.flight.name;
    return;
  }
  const s = st && st.session;
  if (s && s.source === "demo") {
    src.textContent = "DEMO"; src.className = "act-src demo";
    dot($("actDot"), css("--signal"), true);
    state.textContent = stTxt(cur) || "Starting"; ep.textContent = "simulation data";
  } else if (s && st.since_rx < 1.5) {
    src.textContent = "LIVE"; src.className = "act-src live";
    dot($("actDot"), css("--ok"), true);
    state.textContent = stTxt(cur) || "Receiving"; ep.textContent = `${st.sender} · ${st.rate.toFixed(1)} Hz`;
  } else if (s) {
    src.textContent = "LIVE"; src.className = "act-src";
    dot($("actDot"), css("--caution"), false);
    state.style.color = css("--caution");
    state.textContent = `No data for ${fmtAgo(st.since_rx)}`; ep.textContent = st.sender || "";
  } else {
    src.textContent = "IDLE"; src.className = "act-src";
    dot($("actDot"), css("--text-3"), false);
    state.textContent = !st ? "App offline" : !st.listening ? "Receiver not running"
      : st.pi && st.pi.reachable ? `Pi ${st.pi.host} online` : "Waiting for drone";
    ep.textContent = st ? `UDP ${st.port}` : "";
  }
}

async function pollStatus() {
  try { S.status = await api("/api/status"); } catch { S.status = null; }
  const st = S.status;
  if (st) S.fc = st.fc;
  renderCamLive();
  const s = st && st.session, rx = s && st.since_rx < 1.5;
  $("recPill").hidden = !(s && s.source === "drone");
  if (s) $("recTime").textContent = fmtT(s.elapsed);
  dot($("navDot"), rx ? css("--ok") : css("--text-3"), rx);
  $("navDot").style.visibility = s ? "visible" : "hidden";
  dot($("lcDot"), rx ? css("--ok") : s ? css("--caution") : css("--text-3"), rx);
  const host = (st && (st.sender || (st.pi && st.pi.host))) || null;
  $("lcName").textContent = s && s.source === "demo" ? "Demo flight" : host ? "Minidrone" : "No drone yet";
  $("lcEndpoint").textContent = host || "Pi not seen yet";
  $("sbVer").textContent = st ? `Version ${st.version}` : "";
  $("connFlag").hidden = !!(st && st.listening);
  if (S.page === "conn") renderChecks();
  renderCmd();
  if (S.mode === "live") S.dirty = true;
}

/* ---------- safety controls: ARM / LAND / DISARM over MAVLink ---------- */
const CMD_LABEL = { arm: "ARM", land: "LAND", disarm: "DISARM" };
function currentAlt() {
  const fc = S.fc;
  if (fc && fc.alt != null) return fc.alt;
  const L = S.live.frames, f = L[L.length - 1];
  return S.status && S.status.session && S.status.since_rx < 1.5 && f && f.z != null ? -f.z : null;
}
function renderCmd() {
  const fc = S.fc, on = !!(fc && fc.connected), armed = on && fc.armed;
  const now = performance.now();
  if (on) S.wasArmed = armed;
  const lostArmed = !on && S.wasArmed;

  // LAND watchdog: the custom controller may ignore PX4's Land mode, so check that the drone descends
  const w = S.landWatch;
  if (w) {
    if (!armed && on) S.landWatch = null;
    else if (!w.fail && !w.ok && now - w.at > 3000) {
      const alt = currentAlt();
      if (w.alt0 != null && alt != null && w.alt0 - alt >= 0.15) w.ok = true;
      else if (w.alt0 != null && alt != null && alt < 0.08) w.ok = true;
      else w.fail = true;
    }
  }
  const v = $("vState");
  v.textContent = !on ? (lostArmed ? "Link lost" : "No link") : armed ? "ARMED" : "Disarmed";
  v.className = !on ? (lostArmed ? "armed" : "") : armed ? "armed" : "disarmed";
  dot($("vDot"), armed || lostArmed ? css("--accent") : on ? css("--ok") : css("--text-3"), armed);

  const line = $("statusLine");
  const recent = S.cmd && now - S.cmd.at < 5000;
  let cls = "", text;
  if (S.landWatch && S.landWatch.fail) {
    cls = "bad"; text = "Not descending after LAND. Flip the RC land switch (channel 8) or hold DISARM.";
  } else if (lostArmed) {
    cls = "bad"; text = "Flight controller link lost while ARMED. Use the RC transmitter.";
  } else if (recent) {
    cls = S.cmd.ok ? "ok" : "bad"; text = S.cmd.text;
  } else if (S.landWatch && !S.landWatch.ok) {
    cls = "info"; text = "LAND sent. Checking that the drone descends…";
  } else if (on) {
    cls = "info";
    const bits = [fc.px4 ? "PX4" : "Autopilot", fc.mode, fc.landed, fc.peer || fc.source].filter(Boolean);
    text = bits.join(" · ");
  } else {
    text = `No PX4 link${fc && fc.error ? ` (${fc.error})` : ""}. Commands off: use the RC.`;
  }
  line.className = "status-line " + cls;
  line.textContent = text;
  $("cmdbar").classList.toggle("alarm", cls === "bad");

  $("btnArm").disabled = !on || armed;
  $("btnLand").disabled = !on || !armed;
  $("btnKill").disabled = !on || !armed;

  // sidebar flight controller line and battery badge
  $("lcFc").textContent = on ? `PX4 ${armed ? "armed" : "disarmed"} · ${fc.mode || "?"}` : "PX4 not connected";
  const b = $("lcBatt");
  b.hidden = !(on && fc.volt != null);
  if (on && fc.volt != null) {
    const per = fc.volt / Math.max(1, Math.round(fc.volt / 3.85));
    b.textContent = fc.pct != null ? `${fc.pct}%` : `${fc.volt.toFixed(1)} V`;
    b.className = "badge " + (per < 3.5 ? "bad" : per < 3.65 ? "warn" : "ok");
  }
  if (S.page === "conn") renderFcConn();
}
async function sendCmd(name) {
  const label = CMD_LABEL[name];
  let r;
  try { r = await api("/api/fc/command", { cmd: name }); }
  catch (e) { r = { ok: false, result: e.message, text: "" }; }
  const said = r.text ? `: ${r.text}` : "";
  S.cmd = {
    ok: r.ok, at: performance.now(),
    text: r.ok ? `${label} accepted${said}` : `${label} ${r.result}${said}. Use the RC${name === "disarm" ? " kill switch" : ""}.`,
  };
  if (name === "land" && r.ok) S.landWatch = { at: performance.now(), alt0: currentAlt(), fail: false, ok: false };
  if (name !== "land") S.landWatch = null;
  if (!r.ok) toast(S.cmd.text, null, null, true);
  renderCmd();
}
document.querySelectorAll(".hold").forEach((b) => {
  const ms = +b.dataset.ms;
  let raf = 0, firing = false;
  const set = (p) => b.style.setProperty("--p", p);
  const cancel = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0; b.classList.remove("holding");
    if (!firing) set(0);
  };
  const start = (e) => {
    if (b.disabled || raf || firing) return;
    if (e.pointerId != null) b.setPointerCapture(e.pointerId);
    const t0 = performance.now();
    b.classList.add("holding");
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      set(p);
      if (p < 1) { raf = requestAnimationFrame(step); return; }
      raf = 0; b.classList.remove("holding");
      firing = true; b.classList.add("done");
      sendCmd(b.dataset.cmd).finally(() => { firing = false; b.classList.remove("done"); set(0); });
    };
    raf = requestAnimationFrame(step);
  };
  b.addEventListener("pointerdown", (e) => { if (e.button === 0) start(e); });
  b.addEventListener("pointerup", cancel);
  b.addEventListener("pointercancel", cancel);
  b.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!e.repeat) start(e); }
  });
  b.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") cancel(); });
});
setInterval(renderCmd, 250);

/* ---------- pages ---------- */
function showPage(p) {
  S.page = p;
  $("main").hidden = p !== "main";
  $("flights").hidden = p !== "flights";
  $("conn").hidden = p !== "conn";
  $("mission").hidden = p !== "mission";
  $("navMission").classList.toggle("on", p === "mission");
  $("replayBanner").hidden = !(S.mode === "replay" && p === "main");
  $("navLive").classList.toggle("on", p === "main");
  $("navFlights").classList.toggle("on", p === "flights");
  $("navConn").classList.toggle("on", p === "conn");
  $("navLiveText").textContent = S.mode === "replay" ? "Replay" : "Live";
  $("pageTitle").textContent = p === "mission" ? "Mission" : p === "flights" ? "Flights" : p === "conn" ? "Connection" : S.mode === "replay" ? "Replay" : "Live";
  if (p === "flights") refreshFlights();
  if (p === "conn") { renderChecks(); renderFcConn(true); $("piHost").value = S.status?.settings?.pi_host || ""; }
  S.dirty = true;
}
$("navLive").onclick = () => showPage("main");
$("navFlights").onclick = () => showPage("flights");
$("navConn").onclick = () => showPage("conn");
$("navMission").onclick = () => showPage("mission");

/* ---------- demo ---------- */
$("btnDemo").onclick = $("btnDemoTop").onclick = async () => {
  if (S.mode === "replay") goLive();
  showPage("main");
  try { const r = await api("/api/demo/start", {}); toast(`Demo: simulated flight on ${r.name}`); }
  catch (e) { toast(e.message, null, null, true); }
};

/* ---------- connection page ---------- */
$("btnSetup2").onclick = () => showPage("conn");
function check(state, title, detail, action) {
  const word = { ok: "OK", bad: "FAIL", wait: "WAIT" }[state];
  return `<tr><td class="c-name">${title}</td><td class="c-st st-${state}">${word}</td><td class="c-det">${detail}</td><td class="c-act">${action || ""}</td></tr>`;
}
function renderChecks() {
  const st = S.status;
  if (!st) { $("checks").innerHTML = check("bad", "Ground station", "Not responding. Restart the app."); return; }
  const rows = [];
  rows.push(st.listening ? check("ok", "Receiver", `Listening on UDP ${st.port}`)
    : check("bad", "Receiver", st.listen_error || "Not listening"));
  if (st.firewall === true) rows.push(check("ok", "Windows Firewall", "Telemetry is allowed through"));
  else if (st.firewall === false) rows.push(st.packets
    ? check("ok", "Windows Firewall", "Packets are arriving, so no rule is needed on this network")
    : check("bad", "Windows Firewall", "Telemetry and PX4 MAVLink may be blocked. Allow them once (needs admin).", `<button class="btn" id="btnFw">Allow</button>`));
  rows.push(check(st.ips.length ? "ok" : "bad", "This laptop", st.ips.length ? st.ips.join(" · ") : "No network connection"));
  const pi = st.pi || {};
  const src = pi.src || "";
  if (!pi.host) rows.push(check("wait", "Raspberry Pi", "Address unknown until the drone sends telemetry. You can enter it on the right."));
  else if (pi.reachable) rows.push(check("ok", "Raspberry Pi", `${esc(pi.host)} (${src}) · SSH answers in ${pi.ms} ms`));
  else if (pi.reachable === false) rows.push(check("bad", "Raspberry Pi", `${esc(pi.host)} (${src}) is not reachable. Same Wi-Fi? Drone powered?`));
  else rows.push(check("wait", "Raspberry Pi", `${esc(pi.host)} · checking…`));
  const cam = st.camera || {};
  if (cam.state === "live") rows.push(check("ok", "Pi camera", `Streaming ${cam.fps.toFixed(0)} fps over SSH`));
  else if (cam.state === "busy") rows.push(check("ok", "Pi camera", "In use by the flight model. Live view returns when the model stops; the mask is shown meanwhile."));
  else if (["camfail", "auth", "error"].includes(cam.state)) rows.push(check("bad", "Pi camera", esc(cam.detail || CAM_MSG[cam.state])));
  else if (cam.state === "off") rows.push(check("wait", "Pi camera", "Live camera switched off"));
  else rows.push(check("wait", "Pi camera", cam.state === "connecting" ? "Connecting…" : "Starts when the Pi answers on SSH"));
  const self = st.sender && st.ips.includes(st.sender) ? " (this laptop: test sender)" : "";
  if (st.session && st.since_rx < 3) rows.push(check("ok", "Telemetry", `${st.rate.toFixed(1)} Hz from ${esc(st.sender)}${self} · ${st.packets} packets · ${st.dropped} lost`));
  else if (st.packets) rows.push(check("wait", "Telemetry", `Last packet ${fmtAgo(st.since_rx)} ago from ${esc(st.sender)}${self}. Telemetry stops when the drone disarms.`));
  else rows.push(check("wait", "Telemetry", "Nothing yet. Packets start when the drone arms (guidance running)."));
  $("checks").innerHTML = rows.join("");
  const fw = $("btnFw");
  if (fw) fw.onclick = async () => {
    fw.disabled = true; fw.textContent = "Waiting…";
    try { const r = await api("/api/firewall", {}); toast(r.ok ? "Firewall rule added" : "Firewall rule not added", null, null, !r.ok); }
    catch (e) { toast(e.message, null, null, true); }
    pollStatus();
  };
  $("piHint").textContent = "Leave empty to use the address the drone sends from." +
    (st.settings.pi_host_matlab ? ` MATLAB last connected to ${st.settings.pi_host_matlab}.` : "");
  $("sheetFoot").innerHTML = `Flights are saved to <code>${esc(st.flights_dir)}</code>.`;
}
let fcPortsKey = "";
function renderFcConn(force) {
  const fc = S.fc;
  if (!fc) return;
  const sel = $("fcPort");
  const opts = [{ v: "udp", t: "Network (UDP 14550): Wi-Fi, Ethernet or forwarded from QGroundControl" }]
    .concat(fc.ports.map((p) => ({ v: p.port, t: `${p.port}: ${p.name}${p.fc ? " (Pixhawk USB)" : p.radio ? " (telemetry radio?)" : ""}` })));
  if (fc.want && !opts.some((o) => o.v === fc.want)) opts.push({ v: fc.want, t: `${fc.want} (not plugged in)` });
  const key = opts.map((o) => o.v + o.t).join("|");
  if ((force || key !== fcPortsKey) && document.activeElement !== sel) {
    fcPortsKey = key;
    sel.innerHTML = opts.map((o) => `<option value="${esc(o.v)}">${esc(o.t)}</option>`).join("");
    sel.value = fc.want || "udp";
    $("fcBaud").value = String(S.status?.settings?.fc_baud || 57600);
  }
  $("fcBaud").disabled = sel.value === "udp";
  const on = fc.connected;
  $("fcState").innerHTML = on ? `<span class="st-ok">CONNECTED</span>` : fc.error ? `<span class="st-bad">ERROR</span>` : `<span class="st-wait">WAITING</span>`;
  let hint;
  if (on) hint = `PX4 system ${fc.sysid} via ${fc.peer || fc.source}. ${fc.armed ? "Armed" : "Disarmed"}, ${fc.mode || "unknown mode"}${fc.landed ? ", " + fc.landed : ""}.`;
  else if (fc.error) hint = fc.error + ".";
  else if (fc.source === "udp") hint = `Listening on UDP ${fc.port}. Nothing heard yet.` +
    (fc.port === 14551 ? " 14550 is taken (QGroundControl?): in QGroundControl add a MAVLink forwarding target 127.0.0.1:14551." :
      " With QGroundControl on this laptop, close it or forward its MAVLink to this port. Otherwise pick the radio's COM port.");
  else hint = `Opened ${fc.source}, waiting for the Pixhawk's heartbeat. Wrong baud rate? Radios are usually 57600.`;
  $("fcHint").textContent = hint;
}
$("btnFcConnect").onclick = async () => {
  try {
    const r = await api("/api/fc/source", { port: $("fcPort").value, baud: +$("fcBaud").value });
    S.fc = r.fc; renderFcConn(true); renderCmd();
    toast(r.fc.error ? r.fc.error : `Listening on ${r.fc.source === "udp" ? "UDP " + r.fc.port : r.fc.source}`, null, null, !!r.fc.error);
  } catch (e) { toast(e.message, null, null, true); }
};
$("fcPort").onchange = () => ($("fcBaud").disabled = $("fcPort").value === "udp");
$("btnSaveHost").onclick = async () => {
  await api("/api/settings", { pi_host: $("piHost").value.trim() });
  toast("Saved"); pollStatus();
};

/* ---------- boot ---------- */
$("legend").innerHTML = STATES.map((_, i) => `<span><i style="background:var(--s${i})"></i>${STATE_LABEL[i]}</span>`).join("");
connectStream();
pollStatus();
setInterval(pollStatus, 1000);
refreshFlights();
requestAnimationFrame(render);


/* ---------- mission page: MATLAB bridge + Pi control ---------- */
const M = { since: 0, st: null, armed: {} };
function mEsc(t) { return String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function mAppend(lines) {
  if (!lines.length) return;
  const con = $("mConsole");
  const atEnd = con.scrollTop + con.clientHeight >= con.scrollHeight - 30;
  const html = lines.map((l) => {
    const tm = new Date(l.t * 1000).toTimeString().slice(0, 8);
    const bad = /error|fail|missing|not running|does not|exited|still running|check:|not reachable/i.test(l.text);
    const good = !bad && /\b(ok|done|deployed|running|pass|prepared|stopped)\b/i.test(l.text);
    const cls = l.text.startsWith(">") ? "m-cmd" : bad ? "m-bad" : good ? "m-ok" : "";
    return `<span class="m-t">${tm}</span> <span class="m-src m-${l.src}">${l.src === "pi" ? "PI " : "ML "}</span><span class="${cls}">${mEsc(l.text)}</span>\n`;
  }).join("");
  con.insertAdjacentHTML("beforeend", html);
  while (con.childNodes.length > 9000) con.removeChild(con.firstChild);
  if (atEnd) con.scrollTop = con.scrollHeight;
}
function mRender() {
  const st = M.st; if (!st) return;
  const ml = st.matlab;
  const run = ml.running ? `running ${ml.running.cmd} (${ml.running.elapsed} s)` : ml.pending ? `queued ${ml.pending}` : null;
  $("mlState").textContent = ml.launching != null ? `starting MATLAB (${ml.launching} s)${ml.pending ? ", then " + ml.pending : ""}`
    : ml.connected ? (run || "MATLAB ready") : ml.matlab_exe ? "MATLAB not running (starts on first click)" : "MATLAB NOT FOUND";
  $("mlState").className = "ch-r " + (ml.connected ? "st-ok" : ml.launching != null ? "" : ml.matlab_exe ? "" : "st-bad");
  $("mlExe").textContent = ml.matlab_exe ? "" : "MATLAB was not found on this laptop.";
  $("navMlDot").classList.toggle("on", !!ml.connected);
  const mlBusy = !!ml.running || !!ml.pending || !ml.matlab_exe;
  document.querySelectorAll("[data-ml]").forEach((b) => (b.disabled = mlBusy));
  $("btnMlIp").disabled = mlBusy;
  $("btnMlQuit").disabled = !ml.connected || !!ml.running;
  const pi = (S.status && S.status.pi) || {};
  const piTxt = st.pi_busy ? `busy: ${st.pi_busy}` : !st.pi_host ? "no address (Connection page)" :
    pi.reachable ? `${st.pi_host} reachable (${pi.ms} ms)` : `${st.pi_host} NOT reachable`;
  $("piState").textContent = piTxt;
  $("piState").className = "ch-r " + (pi.reachable ? "st-ok" : "st-bad");
  document.querySelectorAll("[data-pi]").forEach((b) => (b.disabled = !!st.pi_busy || !st.pi_host));
  const i = ml.info || {};
  const rows = [["Pi target", i.pi], ["Simulation flag", i.simulation === undefined ? "" : String(i.simulation), i.simulation === 0],
    ["Stop time", i.tfinal, i.tfinal === "Inf"], ["External mode", i.extmode, i.extmode === "off"],
    ["Guidance", i.guidance, /HARDWARE = true/.test(i.guidance || "")],
    ["Camera", i.camera], ["Telemetry sender", i.tx], ["Unsaved changes", i.dirty]];
  $("mlInfo").innerHTML = i.loaded
    ? rows.map(([k, v, ok]) => `<tr><td class="c-name">${k}</td><td class="${ok === undefined ? "" : ok ? "st-ok" : "st-bad"}">${mEsc(v ?? "")}</td></tr>`).join("")
    : `<tr><td class="hint">Model details appear after Check model.</td></tr>`;
}
async function mPoll() {
  try {
    const r = await fetch(`/api/mission/log?since=${M.since}`);
    const j = await r.json();
    if (j.lines.length) { M.since = j.lines[j.lines.length - 1].n; mAppend(j.lines); }
    M.st = j.status; mRender();
  } catch (e) { /* server restarting */ }
}
setInterval(mPoll, 1000); mPoll();
function mConfirm(b) {
  if (!b.dataset.confirm) return true;
  const k = b.dataset.pi || b.dataset.ml;
  if (M.armed[k]) { clearTimeout(M.armed[k].t); b.textContent = M.armed[k].label; b.classList.remove("armed"); delete M.armed[k]; return true; }
  const label = b.textContent;
  b.textContent = "Click again to confirm"; b.classList.add("armed");
  M.armed[k] = { label, t: setTimeout(() => { b.textContent = label; b.classList.remove("armed"); delete M.armed[k]; }, 4000) };
  return false;
}
document.querySelectorAll("[data-pi]").forEach((b) => (b.onclick = async () => {
  if (!mConfirm(b)) return;
  try { await api("/api/pi/action", { action: b.dataset.pi }); mPoll(); } catch (e) { toast(e.message, null, null, true); }
}));
document.querySelectorAll("[data-ml]").forEach((b) => (b.onclick = async () => {
  try { await api("/api/matlab/command", { cmd: b.dataset.ml }); mPoll(); } catch (e) { toast(e.message, null, null, true); }
}));
$("btnMlIp").onclick = async () => {
  try { await api("/api/matlab/command", { cmd: "set_ip", arg: $("mlIp").value.trim() }); mPoll(); } catch (e) { toast(e.message, null, null, true); }
};
$("btnConClear").onclick = () => { $("mConsole").textContent = ""; };
if (location.hash === "#mission") showPage("mission");

/* ---------- mission page: camera capture + red threshold tuning ---------- */
const TUNE = { on: false, thr: (() => { try { return +localStorage.getItem("tuneThr") || 40; } catch { return 40; } })() };
const tuneBuf = document.createElement("canvas"); tuneBuf.width = 160; tuneBuf.height = 120;
$("tuneThr").value = TUNE.thr; $("tuneThrV").textContent = TUNE.thr;
$("tuneThr").oninput = () => {
  TUNE.thr = +$("tuneThr").value; $("tuneThrV").textContent = TUNE.thr;
  try { localStorage.setItem("tuneThr", TUNE.thr); } catch {}
};
function tuneTick() {
  const cs = S.status && S.status.camera, live = S.page === "mission" && cs && cs.state === "live";
  const img = $("tuneImg");
  if (live && !TUNE.on) { img.src = "/api/cam.mjpg?t=" + Date.now(); TUNE.on = true; }
  if (!live && TUNE.on) { img.removeAttribute("src"); TUNE.on = false; }
  const cap = (S.status && S.status.capture) || {};
  $("tuneState").textContent = cap.recording ? `REC ${cap.frames} frames, ${cap.seconds} s`
    : live ? `live, ${cs.fps.toFixed(0)} fps` : cs ? (CAM_MSG[cs.state] || cs.state) : "";
  $("tuneState").className = "ch-r " + (cap.recording ? "st-bad" : live ? "st-ok" : "");
  $("btnRec").textContent = cap.recording ? "Stop recording" : "Record video";
  $("btnRec").classList.toggle("armed", !!cap.recording);
  $("btnPhoto").disabled = !live; $("btnRec").disabled = !live && !cap.recording;
  if (!live || !img.naturalWidth) return;
  const b = tuneBuf.getContext("2d", { willReadFrequently: true });
  b.drawImage(img, 0, 0, 160, 120);
  const d = b.getImageData(0, 0, 160, 120), px = d.data, m = $("tuneMask").getContext("2d"), out = m.createImageData(160, 120);
  let n = 0, nC = 0;
  for (let i = 0, k = 0; i < px.length; i += 4, k++) {
    const red = px[i] - Math.max(px[i + 1], px[i + 2]) > TUNE.thr;
    if (red) {
      n++;
      const x = k % 160 - 80, y = Math.floor(k / 160) - 60;
      if (x * x + y * y < 35 * 35) nC++;
    }
    out.data[i] = red ? 255 : 0; out.data[i + 1] = red ? 60 : 0; out.data[i + 2] = red ? 60 : 0; out.data[i + 3] = 255;
  }
  m.putImageData(out, 0, 0);
  $("tuneCount").textContent = `${n} red px (${(100 * n / 19200).toFixed(1)}%), ${nC} under drone`;
}
setInterval(tuneTick, 200);
$("btnPhoto").onclick = async () => {
  try { const r = await api("/api/cam/photo", {}); toast("Saved " + r.path); } catch (e) { toast(e.message, null, null, true); }
};
$("btnRec").onclick = async () => {
  const on = !(S.status && S.status.capture && S.status.capture.recording);
  try {
    const r = await api("/api/cam/record", { on });
    toast(on ? "Recording to " + r.dir : `Saved ${r.frames} frames (${r.seconds} s) to ${r.dir}`);
    if (S.status) { S.status.capture = Object.assign({}, S.status.capture, { recording: on, frames: 0, seconds: 0 }); }
  } catch (e) { toast(e.message, null, null, true); }
};
$("btnCapFolder").onclick = async () => { try { await api("/api/cam/folder", {}); } catch (e) { toast(e.message, null, null, true); } };
