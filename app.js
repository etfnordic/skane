import { TRIP_TO_LINE } from "./data/trip_to_line.js";

/**
 * Skånetrafiken live-map
 * - Reads the SAME vehicle feed as the Stockholm version (API_URL)
 * - Uses TRIP_TO_LINE to enrich vehicles with: line, headsign, type, desc
 * - Label format: "<desc> <line> → <headsign>"
 * - Colors (both arrow marker and label) are based on desc:
 *   - Stadsbuss + Spårvagn: green
 *   - Regionbuss + SkåneExpressen: yellow
 *   - Pågatåg + PågatågExpress: purple
 *   - Öresundståg: grey
 *   - Närtrafik + Plusresor: red
 *   - TEB planerad: orange
 *   - Färjor: blue
 */

const API_URL = "https://metro.etfnordic.workers.dev";

/* --- Poll + animation tuning --- */
const POLL_MS = 3000;
const ANIM_MIN_MS = 350;
const ANIM_MAX_MS = Math.min(POLL_MS * 0.85, 2500);

/* --- Map (Skåne) --- */
const map = L.map("map").setView([55.6050, 13.0038], 9); // Malmö-ish
L.tileLayer("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
    'Tiles style by <a href="https://www.hotosm.org/">Humanitarian OpenStreetMap Team</a>',
}).addTo(map);

/* --- State --- */
const markers = new Map(); // id -> { group, arrowMarker, lastV, lastPos, hasBearing, anim, iconKey }
const lastPos = new Map(); // id -> {lat, lon, ts}
const lastBearing = new Map(); // id -> bearing
const bearingEstablished = new Map(); // id -> boolean

let timer = null;
let isRefreshing = false;

/* ----------------------------
   Hover/Pin label-state
----------------------------- */
let hoverVehicleId = null;
let hoverLabelMarker = null;

let pinnedVehicleId = null;
let pinnedLabelMarker = null;

let isPointerOverVehicle = false;

/* ----------------------------
   Utilities
----------------------------- */
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function computeAnimMs(fromLatLng, toLatLng) {
  const p1 = map.latLngToLayerPoint(fromLatLng);
  const p2 = map.latLngToLayerPoint(toLatLng);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const distPx = Math.sqrt(dx * dx + dy * dy);
  const ms = distPx * 7;
  return clamp(ms, ANIM_MIN_MS, ANIM_MAX_MS);
}

function animateTo(m, toPos, durationMs, onFrame) {
  if (m.anim?.raf) cancelAnimationFrame(m.anim.raf);

  const from = m.arrowMarker.getLatLng();
  const to = L.latLng(toPos[0], toPos[1]);

  const dLat = Math.abs(from.lat - to.lat);
  const dLng = Math.abs(from.lng - to.lng);
  if (dLat < 1e-8 && dLng < 1e-8) {
    m.arrowMarker.setLatLng(to);
    onFrame?.(to);
    m.anim = null;
    return;
  }

  const start = performance.now();
  const anim = { raf: null };
  m.anim = anim;

  const step = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    const e = easeInOutCubic(t);

    const lat = from.lat + (to.lat - from.lat) * e;
    const lng = from.lng + (to.lng - from.lng) * e;
    const cur = L.latLng(lat, lng);

    m.arrowMarker.setLatLng(cur);
    onFrame?.(cur);

    if (t < 1) anim.raf = requestAnimationFrame(step);
    else {
      anim.raf = null;
      m.anim = null;
    }
  };

  anim.raf = requestAnimationFrame(step);
}

function normalizeLine(rawLine) {
  const s = String(rawLine ?? "").trim();
  const m = s.match(/(\d+\s*[A-Z]+|\d+)/i);
  return (m ? m[1] : s).replace(/\s+/g, "").toUpperCase();
}

function normalizeDesc(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function headingFromPoints(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  const θ = Math.atan2(y, x);
  return (toDeg(θ) + 360) % 360;
}

function fmtSpeed(speedKmh) {
  if (speedKmh == null || Number.isNaN(speedKmh) || speedKmh < 0) return "";
  return ` • ${Math.round(speedKmh)} km/h`;
}

function clamp255(v) {
  return Math.max(0, Math.min(255, v));
}

function darkenHex(hex, amount = 0.08) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const dr = clamp255(Math.round(r * (1 - amount)));
  const dg = clamp255(Math.round(g * (1 - amount)));
  const db = clamp255(Math.round(b * (1 - amount)));
  return `#${dr.toString(16).padStart(2, "0")}${dg
    .toString(16)
    .padStart(2, "0")}${db.toString(16).padStart(2, "0")}`;
}

/* ----------------------------
   Skånetrafiken color rules
----------------------------- */
const COLORS = {
  green: "#1FAE4B",   // stadsbuss + spårvagn
  yellow: "#F4C430",  // regionbuss + skåneexpress
  purple: "#7C3AED",  // pågatåg (+ express)
  grey: "#6B7280",    // öresundståg
  red: "#D11B2D",     // närtrafik + plusresor
  orange: "#F28C28",  // TEB planerad
  blue: "#1E4ED8",    // färjor
  fallback: "#111827" // unknown
};

function styleForVehicle(v) {
  const d = normalizeDesc(v?.desc);
  let bg = COLORS.fallback;

  if (d.includes("stadsbuss") || d.includes("sparvagn") || d.includes("spårvagn")) {
    bg = COLORS.green;
  } else if (d.includes("regionbuss") || d.includes("skaneexpressen") || d.includes("skåneexpressen")) {
    bg = COLORS.yellow;
  } else if (d.includes("pagatag") || d.includes("pågatåg")) {
    bg = COLORS.purple;
  } else if (d.includes("oresundstag") || d.includes("öresundståg")) {
    bg = COLORS.grey;
  } else if (d.includes("nartrafik") || d.includes("närtrafik") || d.includes("plusresor") || d.includes("plusresa")) {
    bg = COLORS.red;
  } else if (d.includes("teb planerad")) {
    bg = COLORS.orange;
  } else if (d.includes("farja") || d.includes("färja") || d.includes("ferry")) {
    bg = COLORS.blue;
  }

  return {
    bg,
    stroke: darkenHex(bg, 0.12),
    text: "#fff",
    border: "1px solid rgba(0,0,0,0.25)",
  };
}

/* ----------------------------
   Icons (same for all modes)
----------------------------- */
function arrowSvg(fillColor, strokeColor, sizePx = 24) {
  return `
    <svg width="${sizePx}" height="${sizePx}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M10 50 L92 10 L62 50 L92 90 Z"
        fill="${fillColor}"
        stroke="${strokeColor}"
        stroke-width="4"
        stroke-linejoin="round"
      />
    </svg>
  `;
}

function makeVehicleIcon(v, bearingDeg, pop = false) {
  const st = styleForVehicle(v);

  // No bearing yet => colored dot
  if (!Number.isFinite(bearingDeg)) {
    const html = `
      <div class="trainMarker" style="filter: drop-shadow(0 2px 2px rgba(0,0,0,.35));">
        <div class="trainDot" style="
          width: 16px; height: 16px;
          border-radius: 999px;
          background: ${st.bg};
          border: 2px solid ${st.stroke};
        "></div>
      </div>
    `;
    return L.divIcon({
      className: "trainIconWrap",
      html,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  const rot = bearingDeg + 90;
  const popWrapClass = pop ? "trainMarkerPopWrap" : "";

  const html = `
    <div class="${popWrapClass}" style="filter: drop-shadow(0 2px 2px rgba(0,0,0,.35));">
      <div class="trainMarker" style="transform: rotate(${rot}deg);">
        ${arrowSvg(st.bg, st.stroke, 24)}
      </div>
    </div>
  `;

  return L.divIcon({
    className: "trainIconWrap",
    html,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function buildLabelText(v) {
  const desc = String(v?.desc ?? "").trim();
  const line = String(v?.line ?? "").trim();
  const headsign = String(v?.headsign ?? "").trim();

  const left = [desc, line].filter(Boolean).join(" ").trim();

  if (headsign) return `${left} → ${headsign}`.trim();
  return left || line || desc || "";
}

function makeLabelIcon(v, speedKmh, pinned = false) {
  const st = styleForVehicle(v);
  const text = `${buildLabelText(v)}${fmtSpeed(speedKmh)}`;

  const cls = pinned
    ? "trainLabel trainLabelPos trainLabelPinned"
    : "trainLabel trainLabelPos trainLabelHover";

  return L.divIcon({
    className: "trainLabelWrap",
    html: `
      <div class="${cls}" style="background:${st.bg}; color:${st.text}; border:${st.border};">
        ${text}
      </div>
    `,
    iconAnchor: [0, 0],
  });
}

/* ----------------------------
   enrich: line + headsign + type + desc
----------------------------- */
function enrich(v) {
  if (!v?.tripId) return null;
  const info = TRIP_TO_LINE[v.tripId];
  if (!info?.line) return null;

  return {
    ...v,
    line: normalizeLine(info.line),
    headsign: info.headsign ?? null,
    type: info.type ?? null,
    desc: info.desc ?? null,
  };
}

/* ----------------------------
   Hover + pinned label helpers
----------------------------- */
function hideHoverLabel(vehicleId) {
  if (hoverVehicleId !== vehicleId) return;
  if (pinnedVehicleId === vehicleId) return;

  if (hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
  }
  hoverVehicleId = null;
}

function showHoverLabel(v, pos) {
  if (pinnedVehicleId === v.id) return;

  if (hoverVehicleId && hoverVehicleId !== v.id && hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
  }

  hoverVehicleId = v.id;
  const icon = makeLabelIcon(v, v.speedKmh, false);

  if (!hoverLabelMarker) {
    hoverLabelMarker = L.marker(pos, {
      icon,
      interactive: false,
      zIndexOffset: 2000,
    }).addTo(map);
  } else {
    hoverLabelMarker.setLatLng(pos);
    hoverLabelMarker.setIcon(icon);
  }
}

function togglePinnedLabel(v, pos) {
  if (hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
    hoverVehicleId = null;
  }
  isPointerOverVehicle = false;

  if (pinnedVehicleId === v.id) {
    if (pinnedLabelMarker) map.removeLayer(pinnedLabelMarker);
    pinnedLabelMarker = null;
    pinnedVehicleId = null;
    return;
  }

  if (pinnedLabelMarker) map.removeLayer(pinnedLabelMarker);

  const icon = makeLabelIcon(v, v.speedKmh, true);

  pinnedVehicleId = v.id;
  pinnedLabelMarker = L.marker(pos, {
    icon,
    interactive: false,
    zIndexOffset: 2500,
  }).addTo(map);
}

map.on("click", () => {
  if (pinnedLabelMarker) {
    map.removeLayer(pinnedLabelMarker);
    pinnedLabelMarker = null;
    pinnedVehicleId = null;
  }
  if (hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
    hoverVehicleId = null;
  }
  isPointerOverVehicle = false;
});

map.on("mousemove", () => {
  if (
    !isPointerOverVehicle &&
    hoverVehicleId &&
    hoverLabelMarker &&
    pinnedVehicleId !== hoverVehicleId
  ) {
    hideHoverLabel(hoverVehicleId);
  }
});

/* ----------------------------
   Marker lifecycle helpers
----------------------------- */
function removeVehicleCompletely(id) {
  const m = markers.get(id);
  if (!m) return;

  if (m.anim?.raf) cancelAnimationFrame(m.anim.raf);

  map.removeLayer(m.group);
  markers.delete(id);

  lastPos.delete(id);
  lastBearing.delete(id);
  bearingEstablished.delete(id);

  if (hoverVehicleId === id) hideHoverLabel(id);

  if (pinnedVehicleId === id) {
    if (pinnedLabelMarker) map.removeLayer(pinnedLabelMarker);
    pinnedLabelMarker = null;
    pinnedVehicleId = null;
  }
}

function iconKeyFor(v, bearingDeg, pop) {
  const st = styleForVehicle(v);
  const hasBearing = Number.isFinite(bearingDeg);
  return `${st.bg}|${hasBearing ? "b" : "d"}|${pop ? "p" : "n"}`;
}

/* ----------------------------
   Upsert vehicle (with smooth movement)
----------------------------- */
function upsertVehicle(v) {
  const pos = [v.lat, v.lon];

  let bearing = null;
  let establishedNow = false;

  if (Number.isFinite(v.bearing) && v.bearing > 0) {
    bearing = v.bearing;
    establishedNow = true;
  }

  const prev = lastPos.get(v.id);
  if (bearing == null && prev && prev.lat != null && prev.lon != null) {
    const moved =
      Math.abs(v.lat - prev.lat) > 0.00002 ||
      Math.abs(v.lon - prev.lon) > 0.00002;

    if (moved) {
      bearing = headingFromPoints(prev.lat, prev.lon, v.lat, v.lon);
      establishedNow = true;
    }
  }

  if (establishedNow) {
    bearingEstablished.set(v.id, true);
    lastBearing.set(v.id, bearing);
  }

  if (
    bearing == null &&
    bearingEstablished.get(v.id) === true &&
    lastBearing.has(v.id)
  ) {
    bearing = lastBearing.get(v.id);
  }

  lastPos.set(v.id, { lat: v.lat, lon: v.lon, ts: v.ts ?? Date.now() });

  const hasBearingNow = Number.isFinite(bearing);

  if (!markers.has(v.id)) {
    const icon = makeVehicleIcon(v, hasBearingNow ? bearing : NaN, false);

    const group = L.layerGroup();
    const arrowMarker = L.marker(pos, {
      icon,
      interactive: true,
      zIndexOffset: 500,
    });

    arrowMarker.on("mouseover", () => {
      isPointerOverVehicle = true;
      const m = markers.get(v.id);
      if (m?.lastV) showHoverLabel(m.lastV, m.lastPos);
    });

    arrowMarker.on("mouseout", () => {
      isPointerOverVehicle = false;
      hideHoverLabel(v.id);
    });

    arrowMarker.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      const m = markers.get(v.id);
      if (m?.lastV) togglePinnedLabel(m.lastV, m.lastPos);
    });

    group.addLayer(arrowMarker);
    group.addTo(map);

    markers.set(v.id, {
      group,
      arrowMarker,
      lastV: v,
      lastPos: pos,
      hasBearing: hasBearingNow,
      anim: null,
      iconKey: iconKeyFor(v, hasBearingNow ? bearing : NaN, false),
    });
    return;
  }

  const m = markers.get(v.id);
  const hadBearingBefore = m.hasBearing === true;
  const pop = !hadBearingBefore && hasBearingNow;

  m.lastV = v;
  m.lastPos = pos;
  m.hasBearing = hasBearingNow;

  const nextKey = iconKeyFor(v, hasBearingNow ? bearing : NaN, pop);
  if (m.iconKey !== nextKey) {
    m.arrowMarker.setIcon(makeVehicleIcon(v, hasBearingNow ? bearing : NaN, pop));
    m.iconKey = nextKey;
  }

  const from = m.arrowMarker.getLatLng();
  const to = L.latLng(pos[0], pos[1]);
  const dur = computeAnimMs(from, to);

  animateTo(m, pos, dur, (curLatLng) => {
    if (hoverVehicleId === v.id && hoverLabelMarker && pinnedVehicleId !== v.id) {
      hoverLabelMarker.setLatLng(curLatLng);
    }
    if (pinnedVehicleId === v.id && pinnedLabelMarker) {
      pinnedLabelMarker.setLatLng(curLatLng);
    }
  });

  if (pinnedVehicleId === v.id && pinnedLabelMarker) {
    pinnedLabelMarker.setIcon(makeLabelIcon(v, v.speedKmh, true));
  }
  if (hoverVehicleId === v.id && hoverLabelMarker && pinnedVehicleId !== v.id) {
    hoverLabelMarker.setIcon(makeLabelIcon(v, v.speedKmh, false));
  }
}

/* ----------------------------
   refreshLive
----------------------------- */
async function refreshLive() {
  if (isRefreshing) return;
  if (document.visibilityState !== "visible") return;

  isRefreshing = true;
  try {
    const res = await fetch(API_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`API error: ${res.status}`);

    const data = await res.json();
    const seen = new Set();

    for (const raw of data) {
      if (!raw?.id || raw.lat == null || raw.lon == null) continue;

      const v = enrich(raw);
      if (!v) continue;

      seen.add(v.id);
      upsertVehicle(v);
    }

    for (const [id] of markers.entries()) {
      if (!seen.has(id)) removeVehicleCompletely(id);
    }
  } finally {
    isRefreshing = false;
  }
}

/* ----------------------------
   polling
----------------------------- */
function startPolling() {
  stopPolling();
  timer = setInterval(() => refreshLive().catch(console.error), POLL_MS);
}
function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

startPolling();
refreshLive().catch(console.error);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    startPolling();
    refreshLive().catch(console.error);
  } else {
    stopPolling();
  }
});
