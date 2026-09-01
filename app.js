"use strict";

const $ = (s) => document.querySelector(s);
const MI = 1609.344;
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const STORE_KEY = "runpath.runs";

const state = {
  tracking: false,
  paused: false,
  demo: false,
  watchId: null,
  timerId: null,
  demoId: null,
  startTime: 0,
  pausedAt: 0,
  simNow: 0,
  distance: 0,        // meters
  segments: [],       // array of arrays of {lat, lng, t}
  runMap: null,
  runLine: null,
  runMarker: null,
  detailMap: null,
  currentRun: null,   // run object shown on detail screen
  wakeLock: null,
};

const now = () => (state.demo ? state.simNow : Date.now());

/* ---------- geometry & formatting ---------- */

function haversine(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtPace(ms, meters) {
  const miles = meters / MI;
  if (ms <= 0 || miles < 0.05) return "--:--";
  const paceSec = ms / 1000 / miles;
  if (paceSec > 3600) return "--:--";
  const m = Math.floor(paceSec / 60), s = Math.round(paceSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

/* ---------- screens ---------- */

function show(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  $(`#screen-${id}`).classList.add("active");
}

/* ---------- storage ---------- */

function loadRuns() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}

function saveRuns(runs) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(runs)); }
  catch (e) { alert("Could not save run (storage full?)"); }
}

/* ---------- home / history ---------- */

/* Runs saved before smoothing existed keep their raw GPS wobble, so clean them
   once. Imported runs are left alone — the recording device already filtered
   them, and re-simplifying would only lose detail. */
function migrateRuns() {
  const runs = loadRuns();
  let changed = false;
  for (const run of runs) {
    if (run.cleaned || run.imported) continue;
    run.segments = cleanSegments(run.segments);
    run.distanceM = Math.round(pathDistance(run.segments));
    run.cleaned = true;
    changed = true;
  }
  if (changed) saveRuns(runs);
}

function renderHistory() {
  const runs = loadRuns();
  const list = $("#history-list");
  list.innerHTML = "";
  $("#history-empty").style.display = runs.length ? "none" : "block";
  for (const run of runs) {
    const el = document.createElement("div");
    el.className = "history-item";
    el.innerHTML = `
      <div>
        <div class="hi-main">${(runDistance(run) / MI).toFixed(2)} mi</div>
        <div class="hi-sub">${fmtDate(run.date)} &middot; ${fmtTime(run.durationMs)}</div>
      </div>
      <div class="hi-pace">${fmtPace(run.durationMs, runDistance(run))} /mi</div>`;
    el.addEventListener("click", () => showDetail(run));
    list.appendChild(el);
  }
}

/* ---------- path smoothing ----------
   GPS wanders a few metres either side of where you actually are, which makes
   a straight street look like a wobbly line and inflates the distance. A short
   centred moving average pulls the trace back toward the real line. */

function smoothSegment(seg, window = 5) {
  if (seg.length < 3) return seg;
  const half = Math.floor(window / 2);
  return seg.map((p, i) => {
    const lo = Math.max(0, i - half), hi = Math.min(seg.length - 1, i + half);
    let lat = 0, lng = 0;
    for (let j = lo; j <= hi; j++) { lat += seg[j].lat; lng += seg[j].lng; }
    const n = hi - lo + 1;
    return { lat: lat / n, lng: lng / n, t: p.t };
  });
}

function pathDistance(segments) {
  let d = 0;
  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) d += haversine(seg[i - 1], seg[i]);
  }
  return d;
}

/* Ramer-Douglas-Peucker: drop points that sit within `eps` metres of the line
   between their neighbours. Residual wobble along a straight street collapses
   into an actual straight line, while real corners exceed the tolerance and
   survive. Run after smoothing, and measure distance on the result. */

function rdp(points, eps) {
  if (points.length < 3) return points;
  const mx = 111320 * Math.cos((points[0].lat * Math.PI) / 180), my = 110540;
  const x = points.map((p) => p.lng * mx), y = points.map((p) => p.lat * my);
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b <= a + 1) continue;
    const dx = x[b] - x[a], dy = y[b] - y[a], len = Math.hypot(dx, dy);
    let best = -1, bestD = 0;
    for (let i = a + 1; i < b; i++) {
      const d = len < 1e-9
        ? Math.hypot(x[i] - x[a], y[i] - y[a])
        : Math.abs(dx * (y[a] - y[i]) - (x[a] - x[i]) * dy) / len;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (bestD > eps) { keep[best] = true; stack.push([a, best], [best, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

const RDP_EPS = 5;   // metres

function cleanSegments(segments) {
  return segments.map((s) => rdp(smoothSegment(s), RDP_EPS));
}

// what the detail screen, share card and history should draw/measure
function runPath(run) { return run.segments; }
function runDistance(run) { return run.distanceM; }

function persistRun(run) {
  saveRuns(loadRuns().map((r) => (r.id === run.id ? run : r)));
}

/* ---------- wake lock (keeps iPhone screen on mid-run) ---------- */

async function keepAwake() {
  try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.tracking) keepAwake();
});

/* ---------- active run ---------- */

function ensureRunMap() {
  if (!state.runMap) {
    state.runMap = L.map("run-map", { zoomControl: false, attributionControl: true })
      .setView([37.7749, -122.4194], 13);
    L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(state.runMap);
  }
  if (state.runLine) state.runLine.remove();
  if (state.runMarker) state.runMarker.remove();
  state.runLine = L.polyline([], { color: "#059669", weight: 5, opacity: 0.9 }).addTo(state.runMap);
  state.runMarker = null;
  setTimeout(() => state.runMap.invalidateSize(), 50);
}

function startRun(demo) {
  state.demo = demo;
  state.tracking = true;
  state.paused = false;
  state.distance = 0;
  state.segments = [[]];
  state.simNow = Date.now();
  state.startTime = now();

  show("run");
  ensureRunMap();
  $("#gps-status").textContent = demo ? "Demo run — simulated GPS" : "Waiting for GPS…";
  $("#gps-status").classList.remove("hidden");
  $("#btn-pause").textContent = "Pause";
  $("#btn-pause").classList.remove("resuming");

  keepAwake();
  state.timerId = setInterval(updateStats, 250);

  if (demo) startDemoPlayback();
  else startWatching();
}

function startWatching() {
  if (!navigator.geolocation) {
    alert("This browser has no GPS support. Try the demo run instead.");
    return;
  }
  state.watchId = navigator.geolocation.watchPosition(
    (pos) => onPoint(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.timestamp),
    (err) => { $("#gps-status").textContent = "GPS error — check location permission"; },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

function onPoint(lat, lng, acc, t) {
  if (!state.tracking || state.paused) return;
  if (acc > 40) { $("#gps-status").textContent = "Weak GPS signal…"; return; }

  const seg = state.segments[state.segments.length - 1];
  const p = { lat, lng, t };
  const last = seg[seg.length - 1];

  if (!last) {
    // first fix of this segment
    if (state.segments.length === 1 && seg.length === 0) {
      state.runMap.setView([lat, lng], 16);
      $("#gps-status").classList.add("hidden");
    }
    seg.push(p);
  } else {
    const d = haversine(last, p);
    const dt = (t - last.t) / 1000;
    if (dt <= 0) return;
    if (d / dt > 12.5) return;        // >12.5 m/s: GPS jump, discard
    if (d < 2) { updateMarker(p); return; }  // jitter: don't accumulate
    seg.push(p);
  }

  // measure and draw the cleaned line so live stats match the saved run
  const clean = cleanSegments(state.segments);
  state.distance = pathDistance(clean);
  state.runLine.setLatLngs(clean.map((s) => s.map((q) => [q.lat, q.lng])));
  updateMarker(p);
  state.runMap.panTo([lat, lng], { animate: true });
}

function updateMarker(p) {
  if (!state.runMarker) {
    state.runMarker = L.circleMarker([p.lat, p.lng], {
      radius: 8, color: "#fff", weight: 3, fillColor: "#059669", fillOpacity: 1,
    }).addTo(state.runMap);
  } else {
    state.runMarker.setLatLng([p.lat, p.lng]);
  }
}

function elapsedMs() {
  return state.paused ? state.pausedAt - state.startTime : now() - state.startTime;
}

function updateStats() {
  $("#stat-time").textContent = fmtTime(elapsedMs());
  $("#stat-dist").textContent = (state.distance / MI).toFixed(2);
  $("#stat-pace").textContent = fmtPace(elapsedMs(), state.distance);
}

function togglePause() {
  if (!state.paused) {
    state.paused = true;
    state.pausedAt = now();
    if (state.watchId != null) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; }
    $("#btn-pause").textContent = "Resume";
    $("#btn-pause").classList.add("resuming");
  } else {
    // shift start time forward by the pause length so elapsed excludes it
    state.startTime += now() - state.pausedAt;
    state.paused = false;
    state.segments.push([]);   // new segment: no line across the gap
    if (!state.demo) startWatching();
    $("#btn-pause").textContent = "Pause";
    $("#btn-pause").classList.remove("resuming");
  }
}

function stopRun() {
  if (!confirm("Finish this run?")) return;
  const durationMs = elapsedMs();

  state.tracking = false;
  clearInterval(state.timerId);
  if (state.watchId != null) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; }
  if (state.demoId != null) { clearInterval(state.demoId); state.demoId = null; }
  if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }

  const run = {
    id: Date.now(),
    date: state.demo ? Date.now() : state.startTime,
    demo: state.demo,
    distanceM: Math.round(state.distance),
    durationMs,
    segments: cleanSegments(state.segments.filter((s) => s.length > 1)),
    cleaned: true,
  };
  state.demo = false;

  if (run.distanceM < 20 || run.segments.length === 0) {
    alert("Run was too short to save.");
    renderHistory();
    show("home");
    return;
  }

  const runs = loadRuns();
  runs.unshift(run);
  saveRuns(runs);
  showDetail(run);
}

/* ---------- run detail ---------- */

function showDetail(run) {
  state.currentRun = run;
  show("detail");

  const tag = run.demo ? " · demo" : run.imported ? " · imported" : "";
  $("#detail-date").textContent =
    fmtDate(run.date) + tag;
  $("#d-dist").textContent = (runDistance(run) / MI).toFixed(2);
  $("#d-time").textContent = fmtTime(run.durationMs);
  $("#d-pace").textContent = fmtPace(run.durationMs, runDistance(run));

  if (state.detailMap) { state.detailMap.remove(); state.detailMap = null; }
  state.detailMap = L.map("detail-map", { zoomControl: false });
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(state.detailMap);

  const path = runPath(run);
  const latlngs = path.map((s) => s.map((q) => [q.lat, q.lng]));
  const line = L.polyline(latlngs, { color: "#059669", weight: 5, opacity: 0.95 }).addTo(state.detailMap);

  const first = path[0][0];
  const lastSeg = path[path.length - 1];
  const lastPt = lastSeg[lastSeg.length - 1];
  L.circleMarker([first.lat, first.lng], { radius: 7, color: "#fff", weight: 2, fillColor: "#059669", fillOpacity: 1 }).addTo(state.detailMap);
  L.circleMarker([lastPt.lat, lastPt.lng], { radius: 7, color: "#fff", weight: 2, fillColor: "#f85149", fillOpacity: 1 }).addTo(state.detailMap);

  setTimeout(() => {
    state.detailMap.invalidateSize();
    state.detailMap.fitBounds(line.getBounds(), { padding: [40, 40] });
  }, 50);
}

function deleteCurrentRun() {
  if (!confirm("Delete this run permanently?")) return;
  saveRuns(loadRuns().filter((r) => r.id !== state.currentRun.id));
  renderHistory();
  show("home");
}

/* ---------- share card ---------- */

function drawShareCard(run) {
  const canvas = $("#share-canvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, W, H);

  // project route (equirectangular, good enough at run scale)
  const pts = runPath(run).flat();
  const midLat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const xs = pts.map((p) => p.lng * kx), ys = pts.map((p) => p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const pad = 140, areaW = W - pad * 2, areaH = H - 500;
  const scale = Math.min(areaW / Math.max(maxX - minX, 1e-9), areaH / Math.max(maxY - minY, 1e-9));
  const ox = (W - (maxX - minX) * scale) / 2;
  const oy = 120 + (areaH - (maxY - minY) * scale) / 2;
  const px = (p) => ox + (p.lng * kx - minX) * scale;
  const py = (p) => oy + (maxY - p.lat) * scale;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const seg of runPath(run)) {
    ctx.beginPath();
    seg.forEach((p, i) => (i ? ctx.lineTo(px(p), py(p)) : ctx.moveTo(px(p), py(p))));
    ctx.strokeStyle = "rgba(46, 229, 157, 0.25)";
    ctx.lineWidth = 26;
    ctx.stroke();
    ctx.strokeStyle = "#2ee59d";
    ctx.lineWidth = 10;
    ctx.stroke();
  }

  const sp = runPath(run);
  const first = sp[0][0];
  const lseg = sp[sp.length - 1];
  const last = lseg[lseg.length - 1];
  for (const [p, color] of [[first, "#2ee59d"], [last, "#ffffff"]]) {
    ctx.beginPath();
    ctx.arc(px(p), py(p), 16, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#0d1117";
    ctx.stroke();
  }

  // stats
  const font = '-apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = "#e6edf3";
  ctx.font = `800 130px ${font}`;
  ctx.fillText(`${(runDistance(run) / MI).toFixed(2)} mi`, pad, H - 240);
  ctx.font = `600 52px ${font}`;
  ctx.fillStyle = "#8b949e";
  ctx.fillText(`${fmtTime(run.durationMs)}   ·   ${fmtPace(run.durationMs, runDistance(run))} /mi`, pad, H - 150);
  ctx.font = `600 40px ${font}`;
  ctx.fillText(new Date(run.date).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }), pad, H - 85);
  ctx.textAlign = "right";
  ctx.fillStyle = "#2ee59d";
  ctx.font = `800 44px ${font}`;
  ctx.fillText("RunPath", W - pad, H - 85);
  ctx.textAlign = "left";

  return canvas;
}

async function shareRun() {
  const run = state.currentRun;
  const canvas = drawShareCard(run);
  canvas.toBlob(async (blob) => {
    const file = new File([blob], "runpath.png", { type: "image/png" });
    const text = `${(runDistance(run) / MI).toFixed(2)} mi in ${fmtTime(run.durationMs)} (${fmtPace(run.durationMs, runDistance(run))}/mi)`;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "My run", text });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;   // user closed the sheet
      }
    }
    saveBlob(blob, "runpath.png");   // fallback: download the image
  }, "image/png");
}

/* ---------- GPX export (importable into Strava) ---------- */

function buildGpx(run) {
  const segs = run.segments.map((seg) =>
    "    <trkseg>\n" +
    seg.map((p) =>
      `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"><time>${new Date(p.t).toISOString()}</time></trkpt>`
    ).join("\n") +
    "\n    </trkseg>"
  ).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RunPath" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Run ${new Date(run.date).toISOString().slice(0, 10)}</name>
    <type>running</type>
${segs}
  </trk>
</gpx>`;
}

function saveBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function exportGpx() {
  const run = state.currentRun;
  const gpx = buildGpx(run);
  const d = new Date(run.date);
  const pad = (n) => String(n).padStart(2, "0");
  // local date + time, so two runs on the same day don't collide in a folder
  const name = `runpath-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
               `-${pad(d.getHours())}${pad(d.getMinutes())}.gpx`;

  // iOS ignores <a download> inside a home-screen app, so go through the share
  // sheet — that is what offers "Save to Files" and lets you pick the folder.
  // Some iOS versions reject the gpx MIME type, so retry as plain text (the
  // .gpx filename still decides how the file is saved).
  for (const type of ["application/gpx+xml", "text/plain"]) {
    const file = new File([gpx], name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;   // user closed the sheet
      }
    }
  }

  saveBlob(new Blob([gpx], { type: "application/gpx+xml" }), name);
}

/* ---------- GPX import (runs recorded on a watch or another app) ---------- */

function importGpxText(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("not a valid GPX file");

  const segments = [];
  for (const segEl of doc.querySelectorAll("trkseg")) {
    const pts = [];
    for (const ptEl of segEl.querySelectorAll("trkpt")) {
      const lat = parseFloat(ptEl.getAttribute("lat"));
      const lng = parseFloat(ptEl.getAttribute("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const timeEl = ptEl.querySelector("time");
      const t = timeEl ? Date.parse(timeEl.textContent) : NaN;
      pts.push({ lat, lng, t });
    }
    if (pts.length > 1) segments.push(pts);
  }
  if (!segments.length) throw new Error("no track points found");

  const hasTimes = segments.every((s) => s.every((p) => Number.isFinite(p.t)));
  let distance = 0, duration = 0;
  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) distance += haversine(seg[i - 1], seg[i]);
    // per-segment sums exclude paused gaps between segments
    if (hasTimes) duration += seg[seg.length - 1].t - seg[0].t;
  }
  if (!hasTimes) {
    let t = Date.now();
    for (const seg of segments) for (const p of seg) { p.t = t; t += 1000; }
  }

  // cap stored points so long watch recordings don't blow past localStorage limits
  const total = segments.reduce((n, s) => n + s.length, 0);
  const step = Math.ceil(total / 1500);
  const slim = step > 1
    ? segments.map((s) => s.filter((_, i) => i % step === 0 || i === s.length - 1))
    : segments;

  const run = {
    id: Date.now(),
    date: hasTimes ? segments[0][0].t : Date.now(),
    imported: true,
    distanceM: Math.round(distance),
    durationMs: Math.max(0, duration),
    segments: slim,
  };
  const runs = loadRuns();
  runs.unshift(run);
  saveRuns(runs);
  showDetail(run);
}

/* ---------- demo mode ---------- */

function demoRoute() {
  // squiggly ~2.2 mi loop around Golden Gate Park
  const lat0 = 37.7689, lng0 = -122.483;
  const rLat = 0.0052;
  const pts = [];
  const N = 240;
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * 2 * Math.PI;
    const wob = 1 + 0.18 * Math.sin(3 * th) + 0.09 * Math.sin(7 * th + 1.3);
    const lat = lat0 + rLat * wob * Math.sin(th);
    const lng = lng0 + (rLat * wob * Math.cos(th)) / Math.cos((lat0 * Math.PI) / 180);
    pts.push({ lat, lng });
  }
  return pts;
}

function startDemoPlayback() {
  const route = demoRoute();
  const speed = 3.13; // m/s ≈ 8:34 /mi
  let i = 0;
  state.demoId = setInterval(() => {
    if (state.paused) return;
    if (i >= route.length) { clearInterval(state.demoId); state.demoId = null; return; }
    const p = route[i];
    if (i > 0) {
      const d = haversine(route[i - 1], p);
      state.simNow += (d / speed) * 1000;
    }
    onPoint(p.lat, p.lng, 5, state.simNow);
    i++;
  }, 120);
}

/* ---------- wire up ---------- */

$("#btn-start").addEventListener("click", () => startRun(false));
$("#btn-demo").addEventListener("click", () => startRun(true));
$("#btn-import").addEventListener("click", () => $("#gpx-input").click());
$("#gpx-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try { importGpxText(reader.result); renderHistory(); }
    catch (err) { alert(`Couldn't import: ${err.message}`); }
  };
  reader.readAsText(file);
});
$("#btn-pause").addEventListener("click", togglePause);
$("#btn-stop").addEventListener("click", stopRun);
$("#btn-back").addEventListener("click", () => { renderHistory(); show("home"); });
$("#btn-share").addEventListener("click", shareRun);
$("#btn-gpx").addEventListener("click", exportGpx);
$("#btn-delete").addEventListener("click", deleteCurrentRun);

migrateRuns();
renderHistory();

if ("serviceWorker" in navigator &&
    (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
