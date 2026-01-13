// app.js (EUTrans MAP-FIX v1) — guarantees map init + clear diagnostics
(() => {
  const $ = (id) => document.getElementById(id);

  const mapEl = $("map");
  const mapStatus = $("mapStatus");

  const fromEl = $("from");
  const toEl = $("to");
  const dateEl = $("date");
  const searchBtn = $("searchBtn");
  const minTransferEl = $("minTransfer");
  const maxTransfersEl = $("maxTransfers");
  const viasEl = $("vias");
  const currencyEl = $("currency");

  const warnBox = $("warnBox");
  const errorBox = $("errorBox");
  const offersEl = $("offers");
  const routeCard = $("routeCard");
  const routeMeta = $("routeMeta");
  const statsPill = $("statsPill");
  const citiesDL = $("cities");

  const CITIES = window.CITIES_EU || [];

  // -------- helpers --------
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

  function fmtTime(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  }
  function iconFor(mode) {
    if (mode === "train") return "🚆";
    if (mode === "bus") return "🚌";
    if (mode === "flight") return "✈️";
    if (mode === "ferry") return "⛴️";
    return "🧭";
  }

  // -------- hard diagnostics first --------
  if (!mapEl) {
    console.error("Brak elementu #map w HTML.");
    showError("Błąd: brak elementu mapy (#map) w index.html.");
    return;
  }

  if (typeof L === "undefined") {
    console.error("Leaflet (L) nie jest zdefiniowany — CDN blokowany / nie doładował się.");
    if (mapStatus) {
      mapStatus.innerHTML =
        "❌ Leaflet nie wczytał się.<br/>" +
        "Najczęściej: blokada CDN (AdBlock/Brave) albo brak internetu.<br/>" +
        "Spróbuj: wyłącz adblock na stronie i odśwież (Ctrl+F5).";
    }
    showError("Leaflet nie wczytał się (blokada CDN). Wyłącz AdBlock / spróbuj innej przeglądarki i odśwież Ctrl+F5.");
    return;
  }

  // -------- map init (always on load) --------
  let map = null;
  let railLayer = null;
  let markers = [];
  let poly = null;

  function initMap() {
    if (map) return;

    map = L.map("map", { zoomControl: true }).setView([52.2297, 21.0122], 5);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
      maxZoom: 19,
    }).addTo(map);

    // Railway overlay ON by default
    railLayer = L.tileLayer("https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png", {
      attribution: "© OpenRailwayMap",
      opacity: 0.65,
      maxZoom: 19,
    }).addTo(map);

    if (mapStatus) mapStatus.remove();
  }

  function clearMap() {
    if (!map) return;
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    if (poly) map.removeLayer(poly);
    poly = null;
  }

  function drawMarkers(path) {
    if (!map) return;
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    path.forEach((c, idx) => {
      const label = idx === 0 ? "Start" : idx === path.length - 1 ? "Cel" : "Przesiadka";
      const name = c.pl || c.name;
      markers.push(L.marker([c.lat, c.lng]).addTo(map).bindPopup(`${label}: ${name}`));
    });
  }

  function fitTo(path) {
    if (!map) return;
    const bounds = L.latLngBounds(path.map((c) => [c.lat, c.lng]));
    map.fitBounds(bounds, { padding: [40, 40] });
  }

  async function osrmPolyline(a, b) {
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("OSRM");
    const data = await res.json();
    const coords = data?.routes?.[0]?.geometry?.coordinates;
    if (!coords?.length) throw new Error("OSRM geometry");
    return coords.map(([lng, lat]) => [lat, lng]);
  }

  async function drawPolyline(path) {
    if (!map) return;
    if (poly) map.removeLayer(poly);
    poly = null;

    const stitched = [];
    for (let i = 0; i < path.length - 1; i++) {
      try {
        const seg = await osrmPolyline(path[i], path[i + 1]);
        stitched.push(...seg);
      } catch {
        stitched.push([path[i].lat, path[i].lng], [path[i + 1].lat, path[i + 1].lng]);
      }
    }
    poly = L.polyline(stitched, { color: "#3b82f6", weight: 4, opacity: 0.85 }).addTo(map);
  }

  // -------- cities: datalist + lookup (PL names supported if `pl` exists in cities-eu.js) --------
  if (statsPill) statsPill.textContent = `Miasta: ${CITIES.length.toLocaleString("pl-PL")}`;

  const exactIndex = new Map();
  const prefixIndex = new Map();

  for (let i = 0; i < CITIES.length; i++) {
    const c = CITIES[i];
    if (!c?.name) continue;
    exactIndex.set(norm(c.name), c);
    if (c.pl) exactIndex.set(norm(c.pl), c);

    const key = norm(c.pl || c.name).slice(0, 2);
    if (!prefixIndex.has(key)) prefixIndex.set(key, []);
    prefixIndex.get(key).push(i);
  }

  function displayName(c) {
    const base = c.pl || c.name;
    return c.cc ? `${base} (${c.cc})` : base;
  }

  function setDatalist(values) {
    if (!citiesDL) return;
    citiesDL.innerHTML = "";
    for (const v of values) {
      const opt = document.createElement("option");
      opt.value = v;
      citiesDL.appendChild(opt);
    }
  }

  function suggest(value) {
    if (!citiesDL) return;
    const v = norm(value);
    if (v.length < 2) return;
    const key = v.slice(0, 2);
    const idxs = prefixIndex.get(key) || [];
    const out = [];
    for (let k = 0; k < idxs.length && out.length < 120; k++) {
      const c = CITIES[idxs[k]];
      const dn = displayName(c);
      if (norm(dn).startsWith(v) || norm(c.name).startsWith(v) || (c.pl && norm(c.pl).startsWith(v))) out.push(dn);
    }
    if (out.length) setDatalist(out);
  }

  function findCity(v) {
    const x = norm(v);
    const stripped = x.replace(/\s*\([a-z]{2}\)\s*$/i, "");
    return exactIndex.get(x) || exactIndex.get(stripped) || null;
  }

  function parseVias(str) {
    const parts = (str || "").split(",").map(s => s.trim()).filter(Boolean);
    const vias = [];
    const unknown = [];
    for (const p of parts) {
      const c = findCity(p);
      if (c) vias.push(c); else unknown.push(p);
    }
    return { vias, unknown };
  }

  function buildPath(fromCity, toCity, vias, maxTransfers) {
    return [fromCity, ...vias.slice(0, Math.max(0, maxTransfers)), toCity];
  }

  if (citiesDL) setDatalist(CITIES.slice(0, 300).map(displayName));
  if (fromEl) fromEl.addEventListener("input", (e) => suggest(e.target.value));
  if (toEl) toEl.addEventListener("input", (e) => suggest(e.target.value));
  if (viasEl) viasEl.addEventListener("input", (e) => suggest((e.target.value.split(",").pop() || "").trim()));

  // date default
  if (dateEl && !dateEl.value) {
    const d = new Date();
    dateEl.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // -------- PLN conversion (ECB) --------
  const FX_KEY = "eutrans:fx:ecb:v3";
  async function getEurToPlnRate() {
    try {
      const cached = JSON.parse(localStorage.getItem(FX_KEY) || "null");
      if (cached?.rate && Date.now() - cached.ts < 12 * 60 * 60 * 1000) return cached.rate;
    } catch {}
    const res = await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml");
    if (!res.ok) throw new Error("ECB");
    const xml = await res.text();
    const m = xml.match(/currency='PLN'\s+rate='([0-9.]+)'/);
    if (!m) throw new Error("ECB PLN missing");
    const rate = parseFloat(m[1]);
    localStorage.setItem(FX_KEY, JSON.stringify({ ts: Date.now(), rate }));
    return rate;
  }
  async function convert(amount, fromCur, toCur) {
    const a = Number(amount);
    if (!Number.isFinite(a)) return a;
    if (fromCur === toCur) return a;
    const rate = await getEurToPlnRate();
    if (fromCur === "EUR" && toCur === "PLN") return a * rate;
    if (fromCur === "PLN" && toCur === "EUR") return a / rate;
    return a;
  }

  // -------- REAL schedules only (no fake routes) --------
  async function fetchSchedules({ fromName, toName, date, currency, limit = 40 }) {
    const url = new URL("https://omio.com/b2b-chatgpt-plugin/schedules");
    url.searchParams.set("departureLocation", fromName);
    url.searchParams.set("arrivalLocation", toName);
    url.searchParams.set("departureDate", date);
    url.searchParams.set("currency", currency);
    url.searchParams.set("sortingField", "price");
    url.searchParams.set("sortingOrder", "ascending");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", "0");
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error("SCHEDULES_HTTP");
    const data = await res.json();
    return Array.isArray(data?.schedules) ? data.schedules : [];
  }

  function toDT(x) {
    const d = new Date(x);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  function chooseLegWithMinTransfer(schedules, afterArrival, minTransferMin) {
    const sorted = schedules.slice().sort((a, b) =>
      (Number(a.price) - Number(b.price)) || (new Date(a.departureDateAndTime) - new Date(b.departureDateAndTime))
    );
    if (!afterArrival) return sorted[0] || null;
    const threshold = new Date(afterArrival.getTime() + minTransferMin * 60000);
    for (const s of sorted) {
      const dep = toDT(s.departureDateAndTime);
      if (dep && dep >= threshold) return s;
    }
    return null;
  }

  // -------- render --------
  function renderStart() {
    if (routeMeta) routeMeta.textContent = "—";
    if (routeCard) {
      routeCard.innerHTML = `<div class="hint">Wpisz <span class="kbd">Skąd</span> i <span class="kbd">Dokąd</span>, wybierz datę i kliknij <span class="kbd">Szukaj</span>.</div>`;
    }
    if (offersEl) offersEl.innerHTML = "";
  }

  async function renderResult(path, chosen, currency, minTransferMin, firstLeg) {
    const transfers = Math.max(0, path.length - 2);
    if (routeMeta) routeMeta.textContent = `${path[0].pl || path[0].name} → ${path[path.length - 1].pl || path[path.length - 1].name} • przesiadki: ${transfers}`;

    let totalMin = 0;
    let totalPrice = 0;

    const legs = await Promise.all(chosen.map(async (s, idx) => {
      const srcCur = s.currency || "EUR";
      const price = await convert(Number(s.price), srcCur, currency);

      totalPrice += Number.isFinite(price) ? price : 0;
      totalMin += Number(s.durationInMinutes || 0);

      const dep = toDT(s.departureDateAndTime);
      const arr = toDT(s.arrivalDateAndTime);
      const depStr = dep ? dep.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "";
      const arrStr = arr ? arr.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "";

      return `
        <div class="offer">
          <div>
            <div style="font-weight:900">${iconFor(s.travelMode)} ${path[idx].pl || path[idx].name} → ${path[idx + 1].pl || path[idx + 1].name}</div>
            <small>${s.travelMode}${s.carrier ? ` • ${s.carrier}` : ""} • ${fmtTime(Number(s.durationInMinutes||0))} • ${Math.round(price)} ${currency} ${depStr && arrStr ? `• ${depStr} → ${arrStr}` : ""}</small>
          </div>
          <a class="pillLink" href="${s.deeplink || "https://www.omio.com/"}" target="_blank" rel="noopener noreferrer">Kup</a>
        </div>
      `;
    }));

    if (chosen.length > 1) totalMin += (chosen.length - 1) * minTransferMin;

    if (routeCard) {
      routeCard.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
          <div>
            <div style="font-weight:900; font-size:15px;">Trasa (realne połączenia)</div>
            <div class="hint">Min. czas na przesiadkę: <span class="kbd">${minTransferMin} min</span></div>
          </div>
          <div style="text-align:right;">
            <div style="font-weight:900;">${fmtTime(totalMin)}</div>
            <div class="hint">${Math.round(totalPrice)} ${currency}</div>
          </div>
        </div>
        <div style="margin-top:10px">${legs.join("")}</div>
      `;
    }

    if (offersEl) {
      offersEl.innerHTML = "";
      const top = (firstLeg || []).slice(0, 6);
      for (const s of top) {
        const srcCur = s.currency || "EUR";
        const price = await convert(Number(s.price), srcCur, currency);
        const div = document.createElement("div");
        div.className = "offer";
        div.innerHTML = `
          <div>
            <div style="font-weight:900">${iconFor(s.travelMode)} ${s.travelMode} • ${Math.round(price)} ${currency}</div>
            <small>${fmtTime(Number(s.durationInMinutes||0))} • ${s.carrier || ""}</small>
          </div>
          <a class="pillLink" href="${s.deeplink || "https://www.omio.com/"}" target="_blank" rel="noopener noreferrer">Kup</a>
        `;
        offersEl.appendChild(div);
      }
    }
  }

  async function onSearch() {
    hide(errorBox); hide(warnBox);

    const fromVal = (fromEl?.value || "").trim();
    const toVal = (toEl?.value || "").trim();
    const date = dateEl?.value || "";
    const currency = currencyEl?.value || "PLN";
    const minTransferMin = parseInt(minTransferEl?.value || "15", 10);
    const maxTransfers = parseInt(maxTransfersEl?.value || "1", 10);

    if (!fromVal) return showError("Wpisz miasto w polu „Skąd”.");
    if (!toVal) return showError("Wpisz miasto w polu „Dokąd”.");
    if (!date) return showError("Wybierz datę.");

    const fromCity = findCity(fromVal);
    const toCity = findCity(toVal);
    if (!fromCity) return showError("Nie rozpoznano miasta „Skąd” (wybierz z listy).");
    if (!toCity) return showError("Nie rozpoznano miasta „Dokąd” (wybierz z listy).");

    const { vias, unknown } = parseVias(viasEl?.value || "");
    if (unknown.length) showWarn(`Nie rozpoznano: ${unknown.join(", ")} (pominięte).`);

    const path = buildPath(fromCity, toCity, vias, maxTransfers);

    clearMap();
    drawMarkers(path);
    await drawPolyline(path);
    fitTo(path);

    try {
      const chosen = [];
      let lastArrival = null;
      let firstLegSchedules = null;

      for (let i = 0; i < path.length - 1; i++) {
        const aName = path[i].pl || path[i].name;
        const bName = path[i + 1].pl || path[i + 1].name;

        const schedules = await fetchSchedules({ fromName: aName, toName: bName, date, currency });
        if (!schedules.length) {
          showError(`Brak połączenia dla odcinka: ${aName} → ${bName}.`);
          if (routeMeta) routeMeta.textContent = "Brak trasy";
          if (routeCard) routeCard.innerHTML = `<div class="hint">Brak wyników dla <span class="kbd">${aName} → ${bName}</span>.</div>`;
          if (offersEl) offersEl.innerHTML = "";
          return;
        }

        if (i === 0) firstLegSchedules = schedules;

        const pick = chooseLegWithMinTransfer(schedules, lastArrival, minTransferMin);
        if (!pick) {
          showError(`Nie da się ułożyć przesiadki z min. czasem ${minTransferMin} min.`);
          return;
        }

        chosen.push(pick);
        lastArrival = toDT(pick.arrivalDateAndTime) || lastArrival;
      }

      await renderResult(path, chosen, currency, minTransferMin, firstLegSchedules);
    } catch (e) {
      showError("Nie udało się pobrać realnych połączeń (CORS/limit).");
      console.warn(e);
    }
  }

  // ---- start ----
  document.addEventListener("DOMContentLoaded", () => {
    initMap();
    if (fromEl) fromEl.value = "";
    if (toEl) toEl.value = "";
    renderStart();
  });

  if (searchBtn) searchBtn.addEventListener("click", onSearch);
})();
