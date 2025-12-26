// Byt till din riktiga worker-URL:
const WORKER_URL = "https://skane-gtfsrt.etfnordic.workers.dev/api/vehicles";

const POLL_MS = 6000;
document.getElementById("interval").textContent = String(POLL_MS / 1000);

const statusEl = document.getElementById("status");

const map = L.map("map").setView([55.7, 13.2], 9); // Skåne-ish
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap-bidragsgivare",
}).addTo(map);

const markers = new Map(); // id -> { marker, lastSeen }

function setStatus(text) {
  statusEl.textContent = text;
}

function keyFor(v) {
  // id kan saknas ibland – då fallback till coords (inte perfekt men funkar)
  return v.id ?? `${v.lat.toFixed(6)},${v.lon.toFixed(6)}`;
}

function upsert(v, now) {
  const id = keyFor(v);
  const pos = [v.lat, v.lon];

  const popup = `
    <b>Fordon</b><br/>
    id: ${v.id ?? "-"}<br/>
    tripId: ${v.tripId ?? "-"}<br/>
    routeId: ${v.routeId ?? "-"}<br/>
    speed: ${v.speed ?? "-"}<br/>
    bearing: ${v.bearing ?? "-"}<br/>
    time: ${v.timestamp ? new Date(v.timestamp * 1000).toLocaleString() : "-"}
  `;

  if (!markers.has(id)) {
    const m = L.circleMarker(pos, {
      radius: 5,
      weight: 1,
      fillOpacity: 0.8,
    }).addTo(map);

    m.bindPopup(popup);
    markers.set(id, { marker: m, lastSeen: now });
  } else {
    const obj = markers.get(id);
    obj.marker.setLatLng(pos);
    obj.marker.setPopupContent(popup);
    obj.lastSeen = now;
  }
}

function prune(now) {
  // Ta bort fordon som inte setts på 30s (minskar "spöken")
  const TTL = 30000;
  for (const [id, obj] of markers.entries()) {
    if (now - obj.lastSeen > TTL) {
      map.removeLayer(obj.marker);
      markers.delete(id);
    }
  }
}

async function tick() {
  const now = Date.now();
  try {
    setStatus("Hämtar…");
    const res = await fetch(WORKER_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const list = data.vehicles ?? [];
    for (const v of list) {
      if (typeof v.lat === "number" && typeof v.lon === "number") {
        upsert(v, now);
      }
    }
    prune(now);

    setStatus(`OK • ${list.length} fordon • ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    console.error(e);
    setStatus(`Fel: ${e.message ?? e}`);
  }
}

tick();
setInterval(tick, POLL_MS);
