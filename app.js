// app.js (EUTrans PKP-first v1)
// - Train-only
// - No fake routes: REAL only when PKP proxy works; otherwise clear MOCK banner
// - PLN
// - Map: tile fallback + OpenRailwayMap overlay toggle
// - Stations autocomplete: for now uses cities-eu.js as fallback, later switches to /stations from Worker

(() => {
  const $ = (id) => document.getElementById(id);

  // UI
  const fromEl = $("from");
  const toEl = $("to");
  const dateEl = $("date");
  const searchBtn = $("searchBtn");
  const minTransferEl = $("minTransfer");
  const maxTransfersEl = $("maxTransfers");
  const viasEl = $("vias");
  const currencyEl = $("currency");
  const railOverlayEl = $("railOverlay");
  const providerEl = $("provider");

  const warnBox = $("warnBox");
  const errorBox = $("errorBox");
  const offersEl = $("offers");
  const routeCard = $("routeCard");
  const routeMeta = $("routeMeta");
  const statsPill = $("statsPill");
  const stationsDL = $("stations");
  const modePill = $("modePill");

  const mapEl = $("map");
  const mapOverlay = $("mapOverlay");

  // IMPORTANT: set your Worker URL here after you deploy it
  // Example: https://eutrans-pkp.<your-subdomain>.workers.dev
  const WORKER_URL = ""; // <-- wkleisz później

  // ---------------- Helpers ----------------
  const norm = (s) =>
    (s || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  function hide(el) {
    if (!el) return;
    el.style.display = "none";
    el.textContent = "";
  }
  function show(el, msg) {
    if (!el) return;
    el.style.display = "block";
    el.textContent = msg;
  }
  function showError(msg) {
    hide(warnBox);
    show(errorBox, msg);
  }
  function showWarn(msg) {
    hide(errorBox);
    show(warnBox, msg);
  }
  function clearMsgs() {
    hide(errorBox);
    hide(warnBox);
  }

  function setModePill(mode, ok) {
    if (!modePill) return;
    modePill.textContent = `TRYB: ${mode}`;
    modePill.className = ok ? "pill ok" : "pill warn";
  }

  function fmtTime(mins) {
    const m = Math.max(0, Math.round(Number(mins) || 0));
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return h ? `${h}h ${String(mm).padStart(2, "0")}m` : `${mm}m`;
  }

  function pln(amount) {
    const a = Number(amount);
    if (!Number.isFinite(a)) return "—";
    return `${Math.round(a)} PLN`;
  }

  // ---------------- Data (fallback suggestions from cities-eu.js) ----------------
  const CITIES = window.CITIES_EU || [];

  if (statsPill) statsPill.textContent = `Miasta: ${CITIES.length.toLocaleString("pl-PL")}`;

  const exactCity = new Map();
  const prefixCity = new Map();
  for (let i = 0; i < CITIES.length; i++) {
    const c = CITIES[i];
    if (!c?.name) continue;
    exactCity.set(norm(c.name), c);
    if (c.pl) exactCity.set(norm(c.pl), c);

    const base = c.pl || c.name;
    const key = norm(base).slice(0, 2);
    if (!prefixCity.has(key)) prefixCity.set(key, []);
    prefixCity.get(key).push(i);
  }

  function cityDisplay(c) {
    const base = c.pl || c.name;
    return c.cc ? `${base} (${c.cc})` : base;
  }

  function setDatalist(values) {
    if (!stationsDL) return;
    stationsDL.innerHTML = "";
    for (const v of values) {
      const opt = document.createElement("option");
      opt.value = v;
      stationsDL.appendChild(opt);
    }
  }

  function suggestFromCities(value) {
    if (!stationsDL) return;
    const v = norm(value);
    if (v.length < 2) return;
    const key = v.slice(0, 2);
    const idxs = prefixCity.get(key) || [];
    const out = [];
    for (let k = 0; k < idxs.length && out.length < 120; k++) {
      const c = CITIES[idxs[k]];
      const dn = cityDisplay(c);
      if (norm(dn).startsWith(v) || norm(c.name).startsWith(v) || (c.pl && norm(c.pl).startsWith(v))) out.push(dn);
    }
    if (out.length) setDatalist(out);
  }

  // ---------------- Map (robust tile fallback) ----------------
  let map = null;
  let baseLayer = null;
  let railLayer = null;
  let markers = [];
  let poly = null;

  const TILE_SOURCES = [
    { name: "OSM", url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", options: { attribution: "© OpenStreetMap", maxZoom: 19 } },
    { name: "CARTO (light)", url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", options: { attribution: "© OpenStreetMap © CARTO", maxZoom: 20, subdomains: "abcd" } },
    { name: "CARTO (dark)", url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", options: { attribution: "© OpenStreetMap © CARTO", maxZoom: 20, subdomains: "abcd" } },
  ];

  function overlay(msg) {
    if (!mapOverlay) return;
    mapOverlay.innerHTML = msg;
    mapOverlay.style.display = "flex";
  }
  function overlayOff() {
    if (!mapOverlay) return;
    mapOverlay.style.display = "none";
  }

  function setBaseLayerByIndex(idx) {
    if (!map) return;
    if (baseLayer) map.removeLayer(baseLayer);

    const src = TILE_SOURCES[idx];
    baseLayer = L.tileLayer(src.url, src.options).addTo(map);

    let ok = false;
    const okHandler = () => {
      if (!ok) {
        ok = true;
        overlayOff();
      }
    };
    const errHandler = () => {
      setTimeout(() => {
        if (ok) return;
        const next = idx + 1;
        if (next < TILE_SOURCES.length) {
          overlay(`⚠️ Nie ładują się kafelki z <b>${src.name}</b>… przełączam na <b>${TILE_SOURCES[next].name}</b>.`);
          setBaseLayerByIndex(next);
        } else {
          overlay(`❌ Nie udało się wczytać mapy.<br/>Wyłącz VPN/AdBlock i zrób Ctrl+F5.`);
        }
      }, 800);
    };

    baseLayer.on("load", okHandler);
    baseLayer.on("tileerror", errHandler);

    overlay(`Ładowanie mapy… (${src.name})`);
  }

  function applyRailOverlay() {
    if (!map || !railLayer || !railOverlayEl) return;
    const v = (railOverlayEl.value || "").toLowerCase();
    const on = v === "on" || v.includes("włącz") || v.includes("wlacz");
    const has = map.hasLayer(railLayer);
    if (on && !has) railLayer.addTo(map);
    if (!on && has) map.removeLayer(railLayer);
  }

  function initMap() {
    if (map) return;
    if (!mapEl) return showError("Brak elementu mapy (#map).");
    if (typeof L === "undefined") return showError("Leaflet nie wczytał się. Wyłącz VPN/AdBlock i odśwież Ctrl+F5.");

    map = L.map("map", { zoomControl: true }).setView([52.2297, 21.0122], 5);
    setBaseLayerByIndex(0);

    railLayer = L.tileLayer("https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png", {
      attribution: "© OpenRailwayMap",
      opacity: 0.65,
      maxZoom: 19,
    });

    applyRailOverlay();

    setTimeout(() => map && map.invalidateSize(true), 200);
    setTimeout(() => map && map.invalidateSize(true), 900);
    window.addEventListener("resize", () => map && map.invalidateSize(true));
  }

  function clearMap() {
    if (!map) return;
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    if (poly) map.removeLayer(poly);
    poly = null;
  }

  function drawMarkers(points) {
    if (!map) return;
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    points.forEach((p, idx) => {
      const label = idx === 0 ? "Start" : idx === points.length - 1 ? "Cel" : "Przesiadka";
      markers.push(L.marker([p.lat, p.lng]).addTo(map).bindPopup(`${label}: ${p.name}`));
    });
  }

  async function osrmPolyline(a, b) {
    // For MVP: OSRM driving as geometry; overlay rail gives “rail context”
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("OSRM");
    const data = await res.json();
    const coords = data?.routes?.[0]?.geometry?.coordinates;
    if (!coords?.length) throw new Error("OSRM geometry");
    return coords.map(([lng, lat]) => [lat, lng]);
  }

  async function drawPolyline(points) {
    if (!map) return;
    if (poly) map.removeLayer(poly);
    poly = null;

    const stitched = [];
    for (let i = 0; i < points.length - 1; i++) {
      try {
        const seg = await osrmPolyline(points[i], points[i + 1]);
        stitched.push(...seg);
      } catch {
        stitched.push([points[i].lat, points[i].lng], [points[i + 1].lat, points[i + 1].lng]);
      }
    }
    poly = L.polyline(stitched, { color: "#3b82f6", weight: 4, opacity: 0.9 }).addTo(map);
  }

  function fitTo(points) {
    if (!map) return;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding: [40, 40] });
  }

  // ---------------- Provider: PKP via Worker ----------------
  async function workerFetch(path, params) {
    if (!WORKER_URL) throw new Error("NO_WORKER_URL");
    const url = new URL(WORKER_URL.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && String(v).length) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) throw new Error("WORKER_HTTP");
    return res.json();
  }

  async function pkpStationsSuggest(q) {
    const data = await workerFetch("/stations", { q });
    return Array.isArray(data?.stations) ? data.stations : [];
  }

  async function pkpJourneys(query) {
    const data = await workerFetch("/journeys", query);
    return Array.isArray(data?.journeys) ? data.journeys : [];
  }

  // ---------------- MOCK (UI test) ----------------
  function mockStationsSuggest(q) {
    // fallback: cities list
    suggestFromCities(q);
    return [];
  }

  function mockJourney(fromName, toName, date, minTransfer, maxTransfers, viasArr) {
    // MOCK is clearly marked, no pretending “real PKP”
    const base = [
      { from: fromName, to: (viasArr[0] || toName), dep: "08:10", arr: "10:05", train: "IC 1234", pricePLN: 79, durationMin: 115, link: "#" },
    ];
    if (viasArr.length) {
      base.push({ from: viasArr[0], to: toName, dep: "10:30", arr: "12:20", train: "TLK 4567", pricePLN: 49, durationMin: 110, link: "#" });
    }
    return {
      id: "MOCK-1",
      isMock: true,
      legs: base,
      totalPLN: base.reduce((s, x) => s + x.pricePLN, 0),
      totalMin: base.reduce((s, x) => s + x.durationMin, 0) + (base.length > 1 ? minTransfer : 0),
    };
  }

  // ---------------- Rendering ----------------
  function renderStart() {
    if (routeMeta) routeMeta.textContent = "—";
    if (routeCard) {
      routeCard.innerHTML = `<div class="hint">Wpisz <span class="kbd">Skąd</span> i <span class="kbd">Dokąd</span>, wybierz datę i kliknij <span class="kbd">Szukaj</span>.</div>`;
    }
    if (offersEl) offersEl.innerHTML = "";
  }

  function renderJourneys(journeys, currency) {
    if (!journeys.length) {
      if (routeMeta) routeMeta.textContent = "Brak trasy";
      if (routeCard) routeCard.innerHTML = `<div class="hint">Brak wyników. Zmień datę / trasę / przesiadki.</div>`;
      if (offersEl) offersEl.innerHTML = "";
      return;
    }

    // pick best (cheapest) for now; later add optimize mode
    const best = journeys.slice().sort((a, b) => (a.totalPLN - b.totalPLN) || (a.totalMin - b.totalMin))[0];

    if (routeMeta) routeMeta.textContent = `${fmtTime(best.totalMin)} • ${pln(best.totalPLN)} • przesiadki: ${Math.max(0, best.legs.length - 1)}`;

    const badge = best.isMock
      ? `<span class="pill warn" style="margin-left:8px;">MOCK (test UI)</span>`
      : `<span class="pill ok" style="margin-left:8px;">REAL PKP</span>`;

    if (routeCard) {
      routeCard.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
          <div>
            <div style="font-weight:900; font-size:15px;">Najlepsza trasa${badge}</div>
            <div class="hint">Kolej (train-only) • ${fmtTime(best.totalMin)} • ${pln(best.totalPLN)}</div>
          </div>
        </div>
      `;
    }

    if (offersEl) {
      offersEl.innerHTML = "";
      for (const leg of best.legs) {
        const div = document.createElement("div");
        div.className = "offer";
        div.innerHTML = `
          <div>
            <div style="font-weight:900">🚆 ${leg.from} → ${leg.to}</div>
            <small>${leg.train} • ${leg.dep} → ${leg.arr} • ${fmtTime(leg.durationMin)} • ${pln(leg.pricePLN)}</small>
          </div>
          <a class="pillLink" href="${leg.link || "#"}" target="_blank" rel="noopener noreferrer">Kup</a>
        `;
        offersEl.appendChild(div);
      }
    }
  }

  // map points from city fallback (until we have station coordinates from PKP)
  function findCityPoint(name) {
    const c = exactCity.get(norm(name)) || exactCity.get(norm(name.replace(/\s*\([a-z]{2}\)\s*$/i, "")));
    if (!c) return null;
    return { name: cityDisplay(c), lat: c.lat, lng: c.lng };
  }

  function parseVias(str) {
    return (str || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  // ---------------- Search ----------------
  async function onSearch() {
    clearMsgs();
    initMap();
    applyRailOverlay();

    const fromName = (fromEl?.value || "").trim();
    const toName = (toEl?.value || "").trim();
    const date = (dateEl?.value || "").trim();
    const minTransfer = parseInt(minTransferEl?.value || "15", 10);
    const maxTransfers = parseInt(maxTransfersEl?.value || "1", 10);
    const currency = (currencyEl?.value || "PLN").trim();
    const viasArr = parseVias(viasEl?.value || "");

    if (!fromName) return showError("Wpisz „Skąd”.");
    if (!toName) return showError("Wpisz „Dokąd”.");
    if (!date) return showError("Wybierz datę.");

    // Decide provider
    const forced = (providerEl?.value || "auto").toLowerCase();
    const wantMock = forced === "mock";
    const canUsePKP = !!WORKER_URL && !wantMock;

    let journeys = [];

    if (canUsePKP) {
      try {
        journeys = await pkpJourneys({
          from: fromName,
          to: toName,
          date,
          minTransfer: String(minTransfer),
          maxTransfers: String(maxTransfers),
          vias: viasArr.join(",")
        });
        setModePill("REAL PKP", true);
      } catch (e) {
        setModePill("MOCK", false);
        showWarn("PKP (Worker) niedostępne — działam w trybie MOCK (test UI).");
        journeys = [mockJourney(fromName, toName, date, minTransfer, maxTransfers, viasArr)];
      }
    } else {
      setModePill("MOCK", false);
      journeys = [mockJourney(fromName, toName, date, minTransfer, maxTransfers, viasArr)];
    }

    // Render
    renderJourneys(journeys, currency);

    // Map draw: for now use cities coordinates (fallback). Later PKP stations will provide lat/lon.
    const points = [];
    const pFrom = findCityPoint(fromName);
    const pTo = findCityPoint(toName);
    if (pFrom) points.push(pFrom);
    for (const v of viasArr) {
      const pv = findCityPoint(v);
      if (pv) points.push(pv);
    }
    if (pTo) points.push(pTo);

    if (points.length >= 2 && map) {
      clearMap();
      drawMarkers(points);
      await drawPolyline(points);
      fitTo(points);
      map.invalidateSize(true);
    } else {
      showWarn("Mapa: brak współrzędnych dla wpisanych nazw (na razie używam miast z cities-eu.js). Po podpięciu PKP stacje będą dokładne.");
    }
  }

  // ---------------- Autocomplete (stations) ----------------
  let stationDebounce = null;

  async function onStationInput(value) {
    const q = (value || "").trim();
    if (q.length < 2) return;

    // If PKP Worker exists, use it for stations; otherwise fallback to cities
    if (!WORKER_URL) return mockStationsSuggest(q);

    try {
      const stations = await pkpStationsSuggest(q);
      // stations expected: [{name, id}] -> put name in datalist
      const names = stations.map(s => s.name).filter(Boolean).slice(0, 80);
      if (names.length) setDatalist(names);
    } catch {
      // fallback
      suggestFromCities(q);
    }
  }

  function bindAutocomplete(el) {
    if (!el) return;
    el.addEventListener("input", (e) => {
      const v = e.target.value;
      clearTimeout(stationDebounce);
      stationDebounce = setTimeout(() => onStationInput(v), 180);
    });
  }

  // ---------------- Boot ----------------
  document.addEventListener("DOMContentLoaded", () => {
    initMap();

    // Default date = today
    if (dateEl && !dateEl.value) {
      const d = new Date();
      dateEl.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    // no default from/to
    if (fromEl) fromEl.value = "";
    if (toEl) toEl.value = "";

    // default PLN
    if (currencyEl) currencyEl.value = "PLN";

    // suggestions initial
    setDatalist(CITIES.slice(0, 250).map(cityDisplay));

    bindAutocomplete(fromEl);
    bindAutocomplete(toEl);
    bindAutocomplete(viasEl);

    if (railOverlayEl) railOverlayEl.addEventListener("change", () => { initMap(); applyRailOverlay(); });
    if (searchBtn) searchBtn.addEventListener("click", onSearch);

    setModePill(WORKER_URL ? "AUTO" : "MOCK", !!WORKER_URL);
    renderStart();
  });
})();
