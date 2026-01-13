(() => {
  const $ = (id) => document.getElementById(id);

  const fromEl = $("from");
  const toEl = $("to");
  const viasEl = $("vias");
  const dateEl = $("date");
  const searchBtn = $("searchBtn");
  const railOverlayEl = $("railOverlay");
  const stationsDL = $("stations");

  const modePill = $("modePill");
  const statsPill = $("statsPill");
  const mapOverlay = $("mapOverlay");

  const warnBox = $("warnBox");
  const errorBox = $("errorBox");

  // Twój działający Worker:
  const WORKER_URL = "https://eutrans.maksijo43.workers.dev";

  const norm = (s) =>
    (s || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  function show(el, msg) {
    if (!el) return;
    el.style.display = "block";
    el.textContent = msg;
  }
  function hide(el) {
    if (!el) return;
    el.style.display = "none";
    el.textContent = "";
  }
  function warn(msg) {
    hide(errorBox);
    show(warnBox, msg);
  }
  function err(msg) {
    hide(warnBox);
    show(errorBox, msg);
  }
  function clearMsg() {
    hide(warnBox);
    hide(errorBox);
  }

  function setMode(text, ok) {
    if (!modePill) return;
    modePill.textContent = "TRYB: " + text;
    modePill.className = ok ? "pill ok" : "pill warn";
  }

  function setDatalist(values) {
    if (!stationsDL) return;
    stationsDL.innerHTML = "";
    for (const v of values.slice(0, 120)) {
      const opt = document.createElement("option");
      opt.value = v;
      stationsDL.appendChild(opt);
    }
  }

  // --- cities fallback
  const CITIES = window.CITIES_EU || [];
  if (statsPill) statsPill.textContent = "Miasta: " + (CITIES.length || 0).toLocaleString("pl-PL");

  const cityPrefix = new Map();

  for (let i = 0; i < CITIES.length; i++) {
    const c = CITIES[i];
    const base = (c && (c.pl || c.name)) ? (c.pl || c.name) : "";
    if (!base) continue;
    const key = norm(base).slice(0, 2);
    if (!cityPrefix.has(key)) cityPrefix.set(key, []);
    cityPrefix.get(key).push(i);
  }

  function cityDisplay(c) {
    const base = c.pl || c.name;
    return c.cc ? `${base} (${c.cc})` : base;
  }

  function suggestCities(q) {
    const v = norm(q);
    if (v.length < 2) return;
    const key = v.slice(0, 2);
    const idxs = cityPrefix.get(key) || [];
    const out = [];
    for (let k = 0; k < idxs.length && out.length < 120; k++) {
      const c = CITIES[idxs[k]];
      const dn = cityDisplay(c);
      const dnN = norm(dn);
      const nameN = norm(c.name);
      const plN = c.pl ? norm(c.pl) : "";
      if (dnN.startsWith(v) || nameN.startsWith(v) || (plN && plN.startsWith(v))) out.push(dn);
    }
    if (out.length) setDatalist(out);
  }

  // --- worker fetch
  async function workerFetch(path, params) {
    const url = new URL(WORKER_URL.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && String(v).length) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) throw new Error("WORKER_HTTP");
    return res.json();
  }

  async function pkpStations(q) {
    const data = await workerFetch("/stations", { q });
    return Array.isArray(data && data.stations) ? data.stations : [];
  }

  // --- map
  let map = null;
  let baseLayer = null;
  let railLayer = null;

  const TILE_SOURCES = [
    { name: "OSM", url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", opt: { attribution: "© OpenStreetMap", maxZoom: 19 } },
    { name: "CARTO light", url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", opt: { attribution: "© OSM © CARTO", maxZoom: 20, subdomains: "abcd" } },
    { name: "CARTO dark", url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", opt: { attribution: "© OSM © CARTO", maxZoom: 20, subdomains: "abcd" } },
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

  function setBase(idx) {
    if (!map) return;
    if (baseLayer) map.removeLayer(baseLayer);

    const src = TILE_SOURCES[idx];
    baseLayer = L.tileLayer(src.url, src.opt).addTo(map);

    let loaded = false;
    baseLayer.on("load", () => {
      loaded = true;
      overlayOff();
    });
    baseLayer.on("tileerror", () => {
      setTimeout(() => {
        if (loaded) return;
        const next = idx + 1;
        if (next < TILE_SOURCES.length) {
          overlay(`⚠️ Kafelki z <b>${src.name}</b> nie ładują się. Przełączam na <b>${TILE_SOURCES[next].name}</b>…`);
          setBase(next);
        } else {
          overlay("❌ Mapa nie ładuje kafelków. Zrób Ctrl+F5 / wyłącz blokery / spróbuj inną sieć.");
        }
      }, 800);
    });

    overlay("Ładowanie mapy… (" + src.name + ")");
  }

  function applyRail() {
    if (!map || !railLayer || !railOverlayEl) return;
    const on = (railOverlayEl.value || "").toLowerCase() === "on";
    const has = map.hasLayer(railLayer);
    if (on && !has) railLayer.addTo(map);
    if (!on && has) map.removeLayer(railLayer);
  }

  function initMap() {
    const el = $("map");
    if (!el) return;

    if (typeof L === "undefined") {
      err("Leaflet nie wczytał się. Zrób Ctrl+F5 lub wyłącz blokery.");
      return;
    }

    if (map) return;

    map = L.map("map").setView([52.2297, 21.0122], 6);
    setBase(0);

    railLayer = L.tileLayer("https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png", {
      attribution: "© OpenRailwayMap",
      opacity: 0.65,
      maxZoom: 19,
    });

    applyRail();

    setTimeout(() => map.invalidateSize(true), 250);
    setTimeout(() => map.invalidateSize(true), 900);
    window.addEventListener("resize", () => map && map.invalidateSize(true));
  }

  // --- autocomplete (zawsze fallback na miasta)
  let debounce = null;

  async function onType(val) {
    const q = (val || "").trim();
    if (q.length < 2) return;

    // zawsze fallback:
    suggestCities(q);

    // jak Worker kiedyś zwróci stacje, nadpisze:
    try {
      const stations = await pkpStations(q); // na razie zwykle []
      const names = stations.map((s) => s && s.name).filter(Boolean);
      if (names.length) setDatalist(names);
    } catch (e) {
      // ignoruj — zostaje fallback z miast
    }
  }

  function bind(el) {
    if (!el) return;
    el.addEventListener("input", (e) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => onType(e.target.value), 150);
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    clearMsg();
    initMap();

    if (dateEl && !dateEl.value) {
      const d = new Date();
      dateEl.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    setDatalist(CITIES.slice(0, 250).map(cityDisplay));

    bind(fromEl);
    bind(toEl);
    bind(viasEl);

    if (railOverlayEl) railOverlayEl.addEventListener("change", () => { initMap(); applyRail(); });

    try {
      const h = await workerFetch("/health", {});
      if (h && h.ok) setMode("AUTO (Worker OK)", true);
      else setMode("AUTO", false);
    } catch {
      setMode("MOCK", false);
    }

    if (searchBtn) {
      searchBtn.addEventListener("click", () => {
        clearMsg();
        warn("Stacje PKP jeszcze nie są podpięte (endpoint /stations zwraca pustą listę). Podpowiedzi działają z listy miast (fallback).");
      });
    }
  });
})();
