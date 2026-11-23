"use strict";
/* Minidrone Ground Station UI: live telemetry, recorded flights, simulation replays. */

const STATES = ["TAKEOFF", "FOLLOW", "COAST", "SETTLE", "LAND"];
const STATE_LABEL = ["Takeoff", "Follow", "Coast", "Settle", "Land"];
const CAM = { W: 160, H: 120, RC: 60.5, CC: 80.5, RIN: 35, R1: 48, R2: 58 };
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const stateColor = (s) => css(`--s${s}`) || css("--muted");

const S = {
  mode: "live",                // live | replay
  live: { frames: [], source: null, sender: null, track: null },
  replay: null,                // { flight, idx, playing, speed, playT }
  status: null,
  dirty: true,
};

/* ---------- helpers ---------- */
const fmtT = (t) => {
  if (t == null || isNaN(t)) return "--";
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};
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
function toast(msg, action, onAction) {
  const el = $("toast");
  el.innerHTML = "";
  el.append(msg);
  if (action) {
    const b = document.createElement("button");
    b.className = "ghost sm"; b.style.marginLeft = "12px"; b.textContent = action;
    b.onclick = () => { el.hidden = true; onAction(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), action ? 8000 : 3500);
}
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
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
  const sc = Math.min((w - 2 * pad) / span, (h - 2 * pad) / span);
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
  ctx.strokeStyle = css("--muted"); ctx.fillStyle = css("--muted"); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(16, h - 16); ctx.lineTo(16 + sc, h - 16); ctx.stroke();
  ctx.font = "11px " + css("--font"); ctx.fillText("1 m", 18, h - 22);
  // north arrow
  ctx.save(); ctx.translate(w - 22, 30); ctx.fillStyle = css("--muted");
  ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(6, 4); ctx.lineTo(0, 0); ctx.lineTo(-6, 4); ctx.closePath(); ctx.fill();
  ctx.textAlign = "center"; ctx.fillText(v.track ? "N" : "FWD", 0, 18); ctx.restore();

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
    ctx.fillStyle = css("--text"); ctx.font = "600 11px " + css("--font"); ctx.fillText("START", sa + 8, sb + 4);
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

  if (!cur || cur.x == null) { $("mapFoot").textContent = ""; return; }
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
  ctx.fillStyle = col; ctx.globalAlpha = .18; ctx.beginPath(); ctx.arc(0, 0, 22, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
  ctx.strokeStyle = css("--text"); ctx.lineWidth = 2.2;
  ctx.beginPath(); ctx.moveTo(-8, -8); ctx.lineTo(8, 8); ctx.moveTo(8, -8); ctx.lineTo(-8, 8); ctx.stroke();
  [[-8, -8], [8, -8], [-8, 8], [8, 8]].forEach(([a, b]) => { ctx.beginPath(); ctx.arc(a, b, 5, 0, 7); ctx.stroke(); });
  ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(5, -12); ctx.lineTo(-5, -12); ctx.closePath(); ctx.fill();
  ctx.restore();

  const frame = v.track ? "north / east, arena metres" : "forward / right from the arming heading";
  $("mapFoot").textContent = `${cur.x.toFixed(2)} m, ${cur.y.toFixed(2)} m  ·  ${frame}`;
}

/* ---------- camera ---------- */
const camBuf = document.createElement("canvas");
camBuf.width = CAM.W; camBuf.height = CAM.H;
function drawCam() {
  const v = view();
  const c = $("cam"), ctx = c.getContext("2d");
  const cur = v.frames[v.idx];
  let k = v.idx, m = null;
  while (k >= 0 && k > v.idx - 3) { if (v.frames[k] && v.frames[k].m) { m = v.frames[k].m; break; } k--; }
  $("camEmpty").hidden = !!m;
  $("camEmpty").textContent = v.frames.length && v.kind === "sim" ? "Simulation runs log the camera for the first 12 s only"
    : v.frames.length ? "No camera image in this frame" : "No image yet";
  ctx.clearRect(0, 0, c.width, c.height);
  if (!m) { $("camInfo").textContent = "red mask · 160×120"; return; }
  const bits = dec64(m);
  const bctx = camBuf.getContext("2d");
  const img = bctx.createImageData(CAM.W, CAM.H);
  let red = 0;
  for (let c0 = 0; c0 < CAM.W; c0++) {
    for (let r = 0; r < CAM.H; r++) {
      const i = c0 * CAM.H + r;
      const on = (bits[i >> 3] >> (i & 7)) & 1;
      const o = (r * CAM.W + c0) * 4;
      if (on) { img.data[o] = 255; img.data[o + 1] = 70; img.data[o + 2] = 72; red++; }
      else { img.data[o] = 16; img.data[o + 1] = 20; img.data[o + 2] = 27; }
      img.data[o + 3] = 255;
    }
  }
  bctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(camBuf, 0, 0, c.width, c.height);
  const s = c.width / CAM.W, ox = (CAM.CC - .5) * s, oy = (CAM.RC - .5) * s;
  // look-ahead ring band and centre disk
  ctx.fillStyle = "rgba(76,158,255,.10)";
  ctx.beginPath(); ctx.arc(ox, oy, CAM.R2 * s, 0, 7); ctx.arc(ox, oy, CAM.R1 * s, 0, 7, true); ctx.fill();
  ctx.strokeStyle = "rgba(76,158,255,.55)"; ctx.lineWidth = 1.5;
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
    ctx.strokeStyle = "#4C9EFF"; ctx.lineWidth = 4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.fillStyle = "#4C9EFF"; ctx.beginPath(); ctx.arc(ex, ey, 7, 0, 7); ctx.fill();
  }
  ctx.fillStyle = "rgba(255,255,255,.6)"; ctx.font = "600 20px " + css("--font"); ctx.textAlign = "center";
  ctx.fillText("▲ nose", ox, 26);
  $("camInfo").textContent = `${red} red px · ring = look-ahead`;
}

/* ---------- mission stepper, tiles ---------- */
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
function drawStepper() {
  const v = view(), cur = v.frames[v.idx];
  const st = cur ? cur.st : null;
  const { per, since } = stateRuns(v.frames, v.idx);
  const reached = Math.max(-1, ...v.frames.slice(0, v.idx + 1).map((f) => f.st ?? -1));
  $("stepper").innerHTML = STATES.map((_, i) => {
    const cls = i === st ? "on" : i <= reached ? "done" : "";
    const tt = i === st ? (cur.t - since) : per[i];
    return `<div class="step ${cls}" style="--c:${stateColor(i)}"><b>${STATE_LABEL[i].toUpperCase()}</b><small>${tt > 0 ? tt.toFixed(1) + " s" : "·"}</small></div>`;
  }).join("");
  $("stateFor").textContent = st != null ? `${STATE_LABEL[st]} for ${(cur.t - since).toFixed(1)} s` : "";
}
function drawTiles() {
  const v = view(), cur = v.frames[v.idx];
  const set = (id, val) => ($(id).textContent = val);
  if (!cur) { ["tAlt", "tHdg", "tSpd", "tRed", "tTime"].forEach((id) => set(id, "--")); }
  else {
    set("tAlt", cur.z != null ? Math.max(0, -cur.z).toFixed(2) : "--");
    set("tHdg", cur.yaw != null ? Math.round(wrap360(cur.yaw * 180 / Math.PI)) : "--");
    const back = v.frames[Math.max(0, v.idx - 5)];
    const dt = cur.t - back.t;
    set("tSpd", dt > 0 && cur.x != null && back.x != null ? (Math.hypot(cur.x - back.x, cur.y - back.y) / dt).toFixed(2) : "0.00");
    set("tRed", cur.nc ?? "--");
    set("tTime", fmtT(cur.t));
  }
  const st = S.status;
  if (S.mode === "replay") set("tLink", "REPLAY");
  else set("tLink", st && st.session ? st.rate.toFixed(1) : "--");
  $("tLink").nextElementSibling.textContent = S.mode === "replay" ? "" : "Hz";
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
    drawLine(0, v.idx + 1, css("--text"), 2);
    const cur = fr[v.idx];
    if (cur) {
      ctx.strokeStyle = css("--accent"); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(X(cur.t), T); ctx.lineTo(X(cur.t), by + band); ctx.stroke();
    }
  } else drawLine(0, n, css("--text"), 2);
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
  const fr = S.mode === "replay" ? v.frames : v.frames;
  const ev = buildEvents(fr).filter((e) => S.mode === "replay" || e.i <= v.idx);
  const ul = $("events");
  if (!ev.length) { ul.innerHTML = `<li class="empty">State changes appear here.</li>`; return; }
  ul.innerHTML = ev.map((e) => `<li class="${S.mode === "replay" ? "click" : ""}" data-i="${e.i}" style="${S.mode === "replay" && e.i > v.idx ? "opacity:.45" : ""}">
      <time>${e.t.toFixed(1)} s</time><span class="dot" style="background:${stateColor(e.st)}"></span>${e.text}</li>`).join("");
  if (S.mode === "live") ul.scrollTop = ul.scrollHeight;
}
$("events").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li && S.mode === "replay") seek(+li.dataset.i);
});

/* ---------- legend ---------- */
$("legend").innerHTML = STATES.map((_, i) => `<span><i style="background:var(--s${i})"></i>${STATE_LABEL[i]}</span>`).join("");
$("mapFrame").remove();

/* ---------- render loop ---------- */
function render() {
  if (S.dirty) {
    S.dirty = false;
    const v = view();
    $("waiting").hidden = !(S.mode === "live" && v.frames.length === 0);
    drawMap(); drawCam(); drawStepper(); drawTiles(); drawChart(); drawEvents();
    if (S.mode === "replay") {
      $("scrub").value = S.replay.idx;
      const f = v.frames[S.replay.idx];
      $("playTime").textContent = f ? f.t.toFixed(1) + " s" : "";
    }
  }
  if (S.mode === "replay" && S.replay.playing) tickReplay();
  requestAnimationFrame(render);
}
window.addEventListener("resize", () => (S.dirty = true));
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => (S.dirty = true));

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
}

/* ---------- status / link pill ---------- */
async function pollStatus() {
  try {
    S.status = await api("/api/status");
  } catch { S.status = null; }
  const st = S.status, pill = $("linkPill"), txt = $("linkText");
  pill.className = "pill idle";
  $("recPill").hidden = true;
  if (!st) { txt.textContent = "App offline"; }
  else if (st.session && st.session.source === "demo") { pill.className = "pill demo"; txt.textContent = "Demo flight"; }
  else if (st.session && st.since_rx < 1.5) {
    pill.className = "pill live"; txt.textContent = `Live · ${st.sender} · ${st.rate.toFixed(1)} Hz`;
    $("recPill").hidden = false;
    const L = S.live.frames; $("recTime").textContent = fmtT(L.length ? L[L.length - 1].t : 0);
  } else if (st.session) { pill.className = "pill stale"; txt.textContent = `Signal lost ${st.since_rx.toFixed(0)} s`; $("recPill").hidden = false; }
  else if (!st.listening) { pill.className = "pill stale"; txt.textContent = "Receiver blocked"; }
  else if (st.pi && st.pi.reachable) { txt.textContent = `Pi online · waiting for arm`; }
  else txt.textContent = "Waiting for drone";
  if (!$("sheet").hidden) renderChecks();
  if (S.mode === "live") S.dirty = true;
}

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
  $("replayBanner").hidden = false;
  $("replayKind").textContent = f.kind === "sim" ? "SIMULATION" : "RECORDED FLIGHT";
  $("replayName").textContent = f.kind === "sim" ? f.name : f.name.replace("flight_", "").replace("_", " ").replace(/(\d\d)(\d\d)(\d\d)$/, "$1:$2:$3");
  const s = f.summary;
  $("replayMeta").textContent = `${fmtT(s.duration)} · ${s.distance} m flown · reached ${STATE_LABEL[STATES.indexOf(s.reached)]}${s.landed ? " · landed" : ""}`;
  $("player").hidden = false; $("scrub").hidden = false;
  $("scrub").max = f.frames.length - 1;
  renderSpeed();
  setPlaying(true);
  S.dirty = true;
}
function goLive() {
  S.mode = "live"; S.replay = null;
  $("replayBanner").hidden = true; $("player").hidden = true; $("scrub").hidden = true;
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
  if (e.target.tagName === "INPUT") return;
  if (e.key === "Escape") closeSheet();
  if (S.mode !== "replay") return;
  if (e.key === " ") { e.preventDefault(); $("btnPlay").click(); }
  if (e.key === "ArrowRight") { setPlaying(false); seek(S.replay.idx + (e.shiftKey ? 10 : 1)); }
  if (e.key === "ArrowLeft") { setPlaying(false); seek(S.replay.idx - (e.shiftKey ? 10 : 1)); }
});
$("btnBackLive").onclick = goLive;

/* ---------- flights page ---------- */
function flightCard(f) {
  const s = f;
  const tot = (s.time_in_state || []).reduce((a, b) => a + b, 0) || 1;
  const bar = (s.time_in_state || []).map((x, i) => `<i style="width:${(x / tot) * 100}%;background:var(--s${i})"></i>`).join("");
  const chips = f.error ? `<span class="chip warn">unreadable</span>` : [
    `<span class="chip">${fmtT(s.duration)}</span>`,
    `<span class="chip">${s.distance ?? 0} m</span>`,
    s.landed ? `<span class="chip ok">landed</span>` : `<span class="chip warn">ended in ${(s.reached || "?").toLowerCase()}</span>`,
  ].join("");
  return `<button class="fcard" data-id="${encodeURIComponent(f.id)}">
      <h4>${f.kind === "sim" ? f.name : f.name}</h4>
      <div class="when">${new Date(f.when).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</div>
      <div class="chips">${chips}</div><div class="bar5">${bar}</div>
      ${f.kind === "flight" ? `<span class="del" data-del="${encodeURIComponent(f.id)}" role="button">Delete</span>` : ""}
    </button>`;
}
async function refreshFlights() {
  let list = [];
  try { list = await api("/api/flights"); } catch { /* keep empty */ }
  const rec = list.filter((f) => f.kind === "flight"), sim = list.filter((f) => f.kind === "sim");
  $("listRec").innerHTML = rec.length ? rec.map(flightCard).join("") :
    `<div class="none">No drone flights yet. They are saved here automatically when the drone flies.</div>`;
  $("listSim").innerHTML = sim.length ? sim.map(flightCard).join("") :
    `<div class="none">No simulation logs found. Run <code>track_tests.m</code> to create <code>track_*.mat</code> files.</div>`;
}
["listRec", "listSim"].forEach((id) => $(id).addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    if (!confirmDelete(del)) return;
    await api("/api/flight/delete", { id: decodeURIComponent(del.dataset.del) });
    refreshFlights(); return;
  }
  const card = e.target.closest(".fcard");
  if (card) openFlight(decodeURIComponent(card.dataset.id));
}));
function confirmDelete(el) {
  // two-step delete without a blocking dialog
  if (el.dataset.armed) return true;
  el.dataset.armed = "1"; el.textContent = "Click again to delete"; el.style.opacity = 1;
  setTimeout(() => { delete el.dataset.armed; el.textContent = "Delete"; el.style.opacity = ""; }, 3000);
  return false;
}
$("btnFolder").onclick = () => api("/api/open-folder", {});

function showPage(p) {
  $("main").hidden = p !== "main";
  $("flights").hidden = p !== "flights";
  $("tabLive").classList.toggle("on", p === "main");
  $("tabFlights").classList.toggle("on", p === "flights");
  $("tabLive").textContent = S.mode === "replay" ? "Replay" : "Live";
  if (p === "flights") refreshFlights();
  S.dirty = true;
}
$("tabLive").onclick = () => showPage("main");
$("tabFlights").onclick = () => showPage("flights");

/* ---------- demo ---------- */
$("btnDemo").onclick = async () => {
  try { const r = await api("/api/demo/start", {}); toast(`Demo: simulated flight on ${r.name}`); }
  catch (e) { toast(e.message); }
};

/* ---------- setup sheet ---------- */
function openSheet() { $("sheet").hidden = false; renderChecks(); const h = S.status?.settings?.pi_host; $("piHost").value = h || ""; }
function closeSheet() { $("sheet").hidden = true; }
$("btnConnect").onclick = openSheet; $("btnSetup2").onclick = openSheet; $("btnClose").onclick = closeSheet;
$("sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
function check(state, title, detail, action) {
  const mark = { ok: "✓", bad: "!", wait: "…" }[state];
  return `<li><span class="st ${state}">${mark}</span><div class="txt"><b>${title}</b><span>${detail}</span></div>${action || ""}</li>`;
}
function renderChecks() {
  const st = S.status;
  if (!st) { $("checks").innerHTML = check("bad", "Ground station not responding", "Restart the app."); return; }
  const rows = [];
  rows.push(st.listening ? check("ok", "Telemetry receiver", `Listening on UDP ${st.port}`)
    : check("bad", "Telemetry receiver", st.listen_error || "Not listening"));
  if (st.firewall === true) rows.push(check("ok", "Windows Firewall", "Telemetry is allowed through"));
  else if (st.firewall === false) rows.push(check(st.packets ? "ok" : "bad", "Windows Firewall",
    st.packets ? "Packets are arriving, so no rule is needed on this network" : "Telemetry may be blocked. Allow it once (needs admin).",
    `<button class="ghost sm" id="btnFw">Allow</button>`));
  rows.push(check(st.ips.length ? "ok" : "bad", "This laptop", st.ips.length ? st.ips.join(" · ") : "No network connection"));
  const pi = st.pi || {};
  const src = st.settings.pi_host ? "set by you" : st.sender ? "from telemetry" : st.settings.pi_host_matlab ? "from MATLAB settings" : "";
  if (!pi.host) rows.push(check("wait", "Raspberry Pi", "Address unknown until the drone sends telemetry. You can enter it below."));
  else if (pi.reachable) rows.push(check("ok", "Raspberry Pi", `${pi.host} (${src}) · SSH answers in ${pi.ms} ms`));
  else if (pi.reachable === false) rows.push(check("bad", "Raspberry Pi", `${pi.host} (${src}) is not reachable. Same Wi-Fi? Drone powered?`));
  else rows.push(check("wait", "Raspberry Pi", `${pi.host} · checking…`));
  if (st.session && st.since_rx < 3) rows.push(check("ok", "Drone telemetry", `${st.rate.toFixed(1)} Hz from ${st.sender} · ${st.packets} packets · ${st.dropped} lost`));
  else if (st.packets) rows.push(check("wait", "Drone telemetry", `Last packet ${st.since_rx}s ago from ${st.sender}. Telemetry stops when the drone disarms.`));
  else rows.push(check("wait", "Drone telemetry", "Nothing yet. Packets start when the drone arms (guidance running)."));
  $("checks").innerHTML = rows.join("");
  const fw = $("btnFw");
  if (fw) fw.onclick = async () => {
    fw.disabled = true; fw.textContent = "Waiting for Windows…";
    try { const r = await api("/api/firewall", {}); toast(r.ok ? "Firewall rule added" : "Firewall rule not added"); }
    catch (e) { toast(e.message); }
    pollStatus();
  };
  $("piHint").textContent = st.settings.pi_host_matlab ? `MATLAB last used ${st.settings.pi_host_matlab}` : "";
  $("sheetFoot").innerHTML = `Version ${st.version} · flights saved to <code>${st.flights_dir}</code>`;
}
$("btnSaveHost").onclick = async () => {
  await api("/api/settings", { pi_host: $("piHost").value.trim() });
  toast("Saved"); pollStatus();
};

/* ---------- boot ---------- */
connectStream();
pollStatus();
setInterval(pollStatus, 1000);
refreshFlights();
requestAnimationFrame(render);
