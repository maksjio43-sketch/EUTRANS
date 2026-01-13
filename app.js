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

  // ---------- helpers ----------
  const norm = (s) =>
    (s || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, ""); // usuwa akcenty: ł->l itd.

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
    for (const v of values.slice(0, 140)) {
      const opt = document.createElement("option");
      opt.value = v;
      stationsDL.appendChild(opt);
    }
  }

  // ---------- cities fallback (FULL SEARCH + ranking) ----------
  const CITIES = window.CITIES_EU || [];
  if (statsPill) statsPill.textContent = "Miasta: " + (CITIES.length || 0).toLocaleString("pl-PL");

  function cityDisplay(c) {
    const base = c.pl || c.name;
    return c.cc ? `${base} (${c.cc})` : base;
  }

  // Precompute searchable strings to make it fast
  const CITY_INDEX = CITIES
    .map((c, i) => {
      const label = cityDisplay(c);
      const a = norm(label);
      const b = norm(c.name);
      const p = c.pl ? norm(c.pl) : "";
      return { i, c, label, a, b, p };
    })
    .filter((x) => x.label && x.a);

  // Ranking:
  // 0 = prefix match (najlepsze)
  // 1 = word-boundary match
  // 2 = substring match
  function scoreMatch(q, item) {
    if (!q) return null;

    const { a, b, p } = item;

    // prefix
    if (a.startsWith(q) || b.startsWith(q) || (p && p.startsWith(q))) return 0;

    // word boundary (np. "Nowy" w "Kraków Nowy..." itd.)
    const re = new RegExp(`(^|\\s|\\-|\\(|\\[)${q}`);
    if (re.test(a) || re.test(b) || (p && re.test(p))) return 1;

    // substring
    if (a.includes(q) || b.includes(q) || (p && p.includes(q))) return 2;

    return null;
  }

  function suggestCities(qRaw) {
    const q = norm(qRaw);
    if (q.length < 2) return [];

    // Weź top N po rankingu + krótsze nazwy wyżej
    const hits = [];
    for (const item of CITY_INDEX) {
      const s = scoreMatch(q, item);
      if (s === null) continue;
      hits.push({ s, len: item.label.length, label: item.label });
    }

    hits.sort((x, y) => (x.s - y.s) || (x.len - y.len) || x.label.localeCompare(y.label, "pl"));

    // uniq + limit
    const out = [];
    const seen = new Set();
    for (const h of hits) {
      if (seen.has(h.label)) continue;
      seen.add(h.label);
      out.push(h.label);
      if (out.length >= 140) break;
    }
    return out;
  }

  // ---------- worker fetch ----------
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
    // na razie worker zwraca [], ale zostawiamy
    const data = await workerFetch("/stations", { q });
    return Array.isArray(data && data.stations) ? data.stations : [];
  }

  // ---------- map ----------
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

  // ---------- autocomplete ----------
  let debounce = null;

  async function onType(val) {
    const q = (val || "").trim();
    if (q.length < 2) return;

    // 1) zawsze cities fallback (pełnotekst)
    const citySuggestions = suggestCities(q);
    if (citySuggestions.length) setDatalist(citySuggestions);

    // 2) jeśli kiedyś dojdą stacje z /stations - nadpisz tylko jeśli są
    try {
      const stations = await pkpStations(q);
      const names = stations.map((s) => s && s.name).filter(Boolean);
      if (names.length) setDatalist(names);
    } catch {
      // ignoruj
    }
  }

  function bind(el) {
    if (!el) return;
    el.addEventListener("input", (e) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => onType(e.target.value), 120);
    });
  }

  // ---------- boot ----------
  document.addEventListener("DOMContentLoaded", async () => {
    clearMsg();
    initMap();

    // data dzisiaj
    if (dateEl && !dateEl.value) {
      const d = new Date();
      dateEl.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    // startowe podpowiedzi: top 200 (żeby nie był tylko A)
    const initial = CITY_INDEX
      .slice(0, 220)
      .map((x) => x.label);
    setDatalist(initial);

    bind(fromEl);
    bind(toEl);
    bind(viasEl);

    if (railOverlayEl) railOverlayEl.addEventListener("change", () => { initMap(); applyRail(); });

    // /health
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
        warn("Stacje PKP jeszcze nie są podpięte (endpoint /stations zwraca pustą listę). Podpowiedzi działają z listy miast (pełnotekst).");
      });
    }
  });
})();
