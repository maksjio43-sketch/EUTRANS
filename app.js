(() => {
  const $ = (id) => document.getElementById(id);

  const fromEl = $("from");
  const toEl = $("to");
  const dateEl = $("date");
  const searchBtn = $("searchBtn");
  const railOverlayEl = $("railOverlay");
  const stationsDL = $("stations");
  const modePill = $("modePill");
  const statsPill = $("statsPill");
  const mapOverlay = $("mapOverlay");
  const warnBox = $("warnBox");
  const errorBox = $("errorBox");

  const WORKER_URL = "https://eutrans.maksijo43.workers.dev";

  const norm = (s) =>
    (s || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  const show = (el, msg) => { if (!el) return; el.style.display = "block"; el.textContent = msg; };
  const hide = (el) => { if (!el) return; el.style.display = "none"; el.textContent = ""; };
  const warn = (msg) => { hide(errorBox); show(warnBox, msg); };
  const err  = (msg) => { hide(warnBox); show(errorBox, msg); };

  const setMode = (text, ok) => {
    if (!modePill) return;
    modePill.textContent = `TRYB: ${text}`;
    modePill.className = ok ? "pill ok" : "pill warn";
  };

  const setDatalist = (values) => {
    if (!stationsDL) return;
    stationsDL.innerHTML = "";
    const seen = new Set();
    for (const v of (values || []).slice(0, 140)) {
      if (!v || seen.has(v)) continue;
      seen.add(v);
      const opt = document.createElement("option");
      opt.value = v;
      stationsDL.appendChild(opt);
    }
  };

  // ---------- Cities (fallback) ----------
  const CITIES = Array.isArray(window.CITIES_EU) ? window.CITIES_EU : [];
  if (statsPill) statsPill.textContent = `Miasta: ${CITIES.length.toLocaleString("pl-PL")}`;

  const CITY_INDEX = CITIES
    .map((c) => {
      const label = (c && (c.pl || c.name)) ? (c.pl || c.name) + (c.cc ? ` (${c.cc})` : "") : "";
      return { label, n: norm(label), n2: norm(c?.name), npl: norm(c?.pl) };
    })
    .filter((x) => x.label && x.n);

  const scoreMatch = (q, it) => {
    if (it.n.startsWith(q) || it.n2.startsWith(q) || (it.npl && it.npl.startsWith(q))) return 0;
    const re = new RegExp(`(^|\\s|\\-|\\(|\\[)${q}`);
    if (re.test(it.n) || re.test(it.n2) || (it.npl && re.test(it.npl))) return 1;
    if (it.n.includes(q) || it.n2.includes(q) || (it.npl && it.npl.includes(q))) return 2;
    return null;
  };

  const suggestCities = (qRaw) => {
    const q = norm(qRaw);
    if (q.length < 2) return [];
    const hits = [];
    for (const it of CITY_INDEX) {
      const s = scoreMatch(q, it);
      if (s === null) continue;
      hits.push({ s, len: it.label.length, label: it.label });
    }
    hits.sort((a,b) => (a.s-b.s) || (a.len-b.len) || a.label.localeCompare(b.label,"pl"));
    return hits.slice(0, 140).map(x => x.label);
  };

  // ---------- Worker ----------
  const workerFetch = async (path, params) => {
    const url = new URL(WORKER_URL.replace(/\/$/,"") + path);
    for (const [k,v] of Object.entries(params||{})) {
      if (v !== undefined && v !== null && String(v).length) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error("WORKER_HTTP");
    return res.json();
  };

  // ---------- Map ----------
  let map = null;
  let baseLayer = null;
  let railLayer = null;
  let tileLoaded = false;

  const TILE_SOURCES = [
    { name:"OSM", url:"https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", opt:{ attribution:"© OpenStreetMap", maxZoom:19 } },
    { name:"CARTO light", url:"https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", opt:{ attribution:"© OSM © CARTO", maxZoom:20, subdomains:"abcd" } },
    { name:"CARTO dark", url:"https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", opt:{ attribution:"© OSM © CARTO", maxZoom:20, subdomains:"abcd" } }
  ];

  const overlay = (html) => {
    if (!mapOverlay) return;
    mapOverlay.innerHTML = html;
    mapOverlay.style.display = "flex";
  };
  const overlayOff = () => {
    if (!mapOverlay) return;
    mapOverlay.style.display = "none";
  };

  const setBase = (idx) => {
    if (!map) return;
    if (baseLayer) map.removeLayer(baseLayer);
    const src = TILE_SOURCES[idx];
    tileLoaded = false;

    baseLayer = L.tileLayer(src.url, src.opt).addTo(map);

    baseLayer.on("load", () => { tileLoaded = true; overlayOff(); });
    baseLayer.on("tileerror", () => {
      setTimeout(() => {
        if (tileLoaded) return;
        const next = idx + 1;
        if (next < TILE_SOURCES.length) {
          overlay(`⚠️ Nie ładują się kafelki <b>${src.name}</b>. Przełączam na <b>${TILE_SOURCES[next].name}</b>…`);
          setBase(next);
        } else {
          overlay(`❌ Nie mogę załadować mapy (kafelki blokowane).<br/>Spróbuj Ctrl+F5, wyłącz adblock, albo inną sieć.`);
        }
      }, 800);
    });

    overlay(`Ładowanie mapy… (${src.name})`);
  };

  const applyRail = () => {
    if (!map || !railLayer || !railOverlayEl) return;
    const on = railOverlayEl.value === "on";
    const has = map.hasLayer(railLayer);
    if (on && !has) railLayer.addTo(map);
    if (!on && has) map.removeLayer(railLayer);
  };

  const initMap = () => {
    const el = $("map");
    if (!el) return;

    if (typeof L === "undefined") {
      overlay(`❌ Leaflet się nie wczytał.<br/>Zrób Ctrl+F5 lub wyłącz blokery.`);
      return;
    }
    if (map) return;

    map = L.map("map").setView([52.2297, 21.0122], 6);
    setBase(0);

    railLayer = L.tileLayer("https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png", {
      attribution:"© OpenRailwayMap",
      opacity:0.65,
      maxZoom:19
    });

    applyRail();

    // Timeout diagnostyczny: jeśli po 5s brak kafelków
    setTimeout(() => {
      if (!tileLoaded) {
        overlay(`⚠️ Mapa nadal się nie ładuje.<br/>Najczęściej blokuje to adblock lub sieć.<br/>Spróbuj Ctrl+F5 / wyłącz blokery / inna sieć.`);
      }
    }, 5000);

    setTimeout(()=>map.invalidateSize(true), 250);
    setTimeout(()=>map.invalidateSize(true), 900);
    window.addEventListener("resize", ()=>map && map.invalidateSize(true));
  };

  // ---------- Autocomplete ----------
  let debounce = null;

  const onType = async (val) => {
    const q = (val || "").trim();
    if (q.length < 2) return;

    // 1) Miasta (lokalnie)
    const citySuggestions = suggestCities(q);
    setDatalist(citySuggestions);

    // 2) Stacje (kiedy PKP będzie gotowe — nadpisze tylko jeśli ma wyniki)
    try {
      const data = await workerFetch("/stations", { q });
      const names = Array.isArray(data?.stations) ? data.stations.map(s => s?.name).filter(Boolean) : [];
      if (names.length) setDatalist(names);
    } catch {
      // ignoruj
    }
  };

  const bind = (el) => {
    if (!el) return;
    el.addEventListener("input", (e) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => onType(e.target.value), 120);
    });
  };

  // ---------- Boot ----------
  document.addEventListener("DOMContentLoaded", async () => {
    hide(warnBox); hide(errorBox);

    initMap();

    if (railOverlayEl) railOverlayEl.addEventListener("change", () => applyRail());

    // data dziś
    if (dateEl && !dateEl.value) {
      const d = new Date();
      dateEl.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    }

    // jeśli 0 miast -> pokaż czemu
    if (!CITIES.length) {
      err("Lista miast jest pusta. cities-eu.js nie wczytał się albo ma inną nazwę. Sprawdź w repo czy plik nazywa się dokładnie: cities-eu.js i jest w (root).");
    }

    // startowe podpowiedzi (top 120)
    setDatalist(CITY_INDEX.slice(0, 120).map(x => x.label));

    bind(fromEl);
    bind(toEl);

    // /health
    try {
      const h = await workerFetch("/health", {});
      setMode(h?.ok ? "AUTO (Worker OK)" : "AUTO", !!h?.ok);
    } catch {
      setMode("MOCK", false);
    }

    if (searchBtn) {
      searchBtn.addEventListener("click", () => {
        warn("Na razie: mapa + miasta. Stacje PKP podłączymy jak dostaniesz API.");
      });
    }
  });
})();
