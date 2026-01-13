// app.js (EUTrans v6) — REAL routes only + PLN + PL city names + rail overlay + no fake connections
(() => {
  const CITIES = window.CITIES_EU || [];
  const $ = (id) => document.getElementById(id);

  // Required UI ids (from your index.html). If something is missing, we fail gracefully.
  const fromEl = $("from");
  const toEl = $("to");
  const dateEl = $("date");
  const searchBtn = $("searchBtn");
  const minTransferEl = $("minTransfer");
  const maxTransfersEl = $("maxTransfers");
  const viasEl = $("vias");
  const currencyEl = $("currency"); // PLN/EUR
  const errorBox = $("errorBox");
  const warnBox = $("warnBox");
  const offersEl = $("offers");
  const routeCard = $("routeCard");
  const routeMeta = $("routeMeta");
  const statsPill = $("statsPill");
  const citiesDL = $("cities");
  const buyLink = $("buyLink"); // optional in some HTML versions

  // Map container must exist
  const mapEl = $("map");

  // ---- UI helpers ----
  const norm = (s) =>
    (s || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, ""); // strip diacritics

  function show(el, msg, mode) {
    if (!el) return;
    el.style.display = "block";
    el.textContent = msg;
    if (mode === "warn") el.className = "warn";
    if (mode === "error") el.className = "error";
  }
  function hide(el) {
    if (!el) return;
    el.style.display = "none";
    el.textContent = "";
  }
  function showError(msg) {
    hide(warnBox);
    show(errorBox, msg, "error");
  }
  function showWarn(msg) {
    hide(errorBox);
    show(warnBox, msg, "warn");
  }
  function clearMsgs() {
    hide(errorBox);
    hide(warnBox);
  }

  function formatTime(mins) {
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

  // ---- Data: build search indices (PL + EN) ----
  // Expected city shape from cities-eu.js:
  // { id, name, pl?, cc?, lat, lng, population? }
  const exactIndex = new Map(); // norm(name)->city
  const prefixIndex = new Map(); // first2->list indices

  for (let i = 0; i < CITIES.length; i++) {
    const c = CITIES[i];
    const n1 = norm(c.name);
    exactIndex.set(n1, c);
    if (c.pl) exactIndex.set(norm(c.pl), c);

    // also index "name (cc)" typed by user
    if (c.cc) {
      exactIndex.set(norm(`${c.name} (${c.cc})`), c);
      if (c.pl) exactIndex.set(norm(`${c.pl} (${c.cc})`), c);
    }

    const key = (c.pl ? norm(c.pl) : n1).slice(0, 2);
    if (!prefixIndex.has(key)) prefixIndex.set(key, []);
    prefixIndex.get(key).push(i);
  }

  function displayName(c) {
    // Show PL if exists, otherwise original.
    // Optionally add country code.
    const base = c.pl || c.name;
    return c.cc ? `${base} (${c.cc})` : base;
  }

  function findCity(value) {
    const v = norm(value);

    // Exact match
    const direct = exactIndex.get(v);
    if (direct) return direct;

    // Try removing " (CC)" if user typed it weirdly
    const stripped = v.replace(/\s*\([a-z]{2}\)\s*$/i, "");
    const direct2 = exactIndex.get(stripped);
    if (direct2) return direct2;

    // Fuzzy: start-with match among prefix bucket
    if (v.length >= 2) {
      const key = v.slice(0, 2);
      const idxs = prefixIndex.get(key) || [];
      for (let k = 0; k < idxs.length; k++) {
        const c = CITIES[idxs[k]];
        const candidates = [c.pl, c.name, c.cc ? `${c.pl || c.name} (${c.cc})` : null].filter(Boolean);
        for (const cand of candidates) {
          if (norm(cand).startsWith(v)) return c;
        }
      }
    }
    return null;
  }

  // ---- Datalist suggestions ----
  function setDatalist(names) {
    if (!citiesDL) return;
    citiesDL.innerHTML = "";
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      citiesDL.appendChild(opt);
    }
  }

  function onTypeSuggest(value) {
    if (!citiesDL) return;
    const v = norm(value);
    if (v.length < 2) return;

    const key = v.slice(0, 2);
    const idxs = prefixIndex.get(key) || [];
    const matches = [];
    for (let k = 0; k < idxs.length && matches.length < 120; k++) {
      const c = CITIES[idxs[k]];
      const dn = displayName(c);
      if (norm(dn).startsWith(v) || norm(c.name).startsWith(v) || (c.pl && norm(c.pl).startsWith(v))) {
        matches.push(dn);
      }
    }
    if (matches.length) setDatalist(matches);
  }

  if (fromEl) fromEl.addEventListener("input", (e) => onTypeSuggest(e.target.value));
  if (toEl) toEl.addEventListener("input", (e) => onTypeSuggest(e.target.value));
  if (viasEl) viasEl.addEventListener("input", (e) => onTypeSuggest((e.target.value.split(",").pop() || "").trim()));

  // initial datalist
  setDatalist(CITIES.slice(0, 250).map(displayName));

  // stats
  if (statsPill) statsPill.textContent = `Miasta: ${CITIES.length.toLocaleString("pl-PL")}`;

  // date default
  if (dateEl && !dateEl.value) {
    const d = new Date();
    dateEl.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // ---- Map setup ----
  if (!mapEl || typeof L === "undefined") {
    // Map missing - still allow planning logic to work.
    console.warn("Leaflet/map container missing. Map disabled.");
  }

  let map = null;
  let markers = [];
  let poly = null;
  let railLayer = null;

  function initMapOnce() {
    if (map || !mapEl || typeof L === "undefined") return;
    map = L.map("map").setView([52.2297, 21.0122], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
    }).addTo(map);

    // Railway overlay ON by default (requirement: "uwzględnij linie kolejowe")
    railLayer = L.tileLayer("https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png", {
      attribution: "© OpenRailwayMap",
      opacity: 0.65,
      maxZoom: 19,
    });
    railLayer.addTo(map);
  }

  function clearMap() {
    if (!map) return;
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    if (poly) map.removeLayer(poly);
    poly = null;
  }

  function drawMarkers(pathCities) {
    if (!map) return;
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    pathCities.forEach((c, idx) => {
      const label =
        idx === 0 ? `Start: ${c.pl || c.name}` : idx === pathCities.length - 1 ? `Cel: ${c.pl || c.name}` : `Przesiadka: ${c.pl || c.name}`;
      const m = L.marker([c.lat, c.lng]).addTo(map).bindPopup(label);
      markers.push(m);
    });
  }

  function fitTo(pathCities) {
    if (!map) return;
    const bounds = L.latLngBounds(pathCities.map((c) => [c.lat, c.lng]));
    map.fitBounds(bounds, { padding: [40, 40] });
  }

  // OSRM polyline to avoid straight lines
  async function osrmPolyline(a, b) {
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("OSRM error");
    const data = await res.json();
    const coords = data?.routes?.[0]?.geometry?.coordinates;
    if (!coords?.length) throw new Error("OSRM geometry missing");
    return coords.map(([lng, lat]) => [lat, lng]);
  }

  async function drawPolyline(pathCities) {
    if (!map) return;
    if (poly) map.removeLayer(poly);
    poly = null;

    const stitched = [];
    for (let i = 0; i < pathCities.length - 1; i++) {
      try {
        const seg = await osrmPolyline(pathCities[i], pathCities[i + 1]);
        stitched.push(...seg);
      } catch {
        // fallback: straight segment if OSRM fails
        stitched.push([pathCities[i].lat, pathCities[i].lng], [pathCities[i + 1].lat, pathCities[i + 1].lng]);
      }
    }
    poly = L.polyline(stitched, { color: "#3b82f6", weight: 4, opacity: 0.85 }).addTo(map);
  }

  // ---- Currency conversion EUR->PLN (ECB daily XML) ----
  const FX_KEY = "eutrans:fx:ecb:v2";
  async function getEurToPlnRate() {
    try {
      const cached = JSON.parse(localStorage.getItem(FX_KEY) || "null");
      if (cached?.rate && Date.now() - cached.ts < 12 * 60 * 60 * 1000) return cached.rate;
    } catch {}

    const res = await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml");
    if (!res.ok) throw new Error("ECB fetch failed");
    const xml = await res.text();
    const m = xml.match(/currency='PLN'\s+rate='([0-9.]+)'/);
    if (!m) throw new Error("ECB PLN rate missing");
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

  // ---- Parse vias ----
  function parseVias(str) {
    const parts = (str || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const vias = [];
    const unknown = [];
    for (const p of parts) {
      const c = findCity(p);
      if (c) vias.push(c);
      else unknown.push(p);
    }
    return { vias, unknown };
  }

  function buildPath(fromCity, toCity, vias, maxTransfers) {
    const v = vias.slice(0, Math.max(0, maxTransfers));
    return [fromCity, ...v, toCity];
  }

  // ---- REAL schedules (no fake routes) ----
  // IMPORTANT: This uses a public plugin endpoint. If the browser blocks it (CORS/limits),
  // we will SHOW an error (no offline pretending), per your requirement "brak zmyślonych tras".
  async function fetchSchedules({ fromName, toName, date, currency, limit = 30 }) {
    const url = new URL("https://omio.com/b2b-chatgpt-plugin/schedules");
    url.searchParams.set("departureLocation", fromName);
    url.searchParams.set("arrivalLocation", toName);
    url.searchParams.set("departureDate", date);
    url.searchParams.set("currency", currency);
    url.searchParams.set("sortingField", "price");
    url.searchParams.set("sortingOrder", "ascending");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", "0");

    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) throw new Error("SCHEDULES_HTTP");
    const data = await res.json();
    const schedules = Array.isArray(data?.schedules) ? data.schedules : [];
    return schedules;
  }

  function toDT(x) {
    const d = new Date(x);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  function chooseLegWithMinTransfer(schedules, afterArrival, minTransferMin) {
    const sorted = schedules
      .slice()
      .sort((a, b) => (Number(a.price) - Number(b.price)) || (new Date(a.departureDateAndTime) - new Date(b.departureDateAndTime)));

    if (!afterArrival) return sorted[0] || null;

    const threshold = new Date(afterArrival.getTime() + minTransferMin * 60000);
    for (const s of sorted) {
      const dep = toDT(s.departureDateAndTime);
      if (dep && dep >= threshold) return s;
    }
    return null;
  }

  // ---- Render ----
  async function renderReal(pathCities, chosenSchedules, targetCurrency, minTransferMin, firstLegListForOffers) {
    const transfersCount = Math.max(0, pathCities.length - 2);

    // totals
    let totalMin = 0;
    let totalPrice = 0;

    const legsHtml = await Promise.all(
      chosenSchedules.map(async (s, idx) => {
        const srcCur = s.currency || "EUR";
        const converted = await convert(Number(s.price), srcCur, targetCurrency);

        totalPrice += Number.isFinite(converted) ? converted : 0;
        totalMin += Number(s.durationInMinutes || 0);

        const dep = toDT(s.departureDateAndTime);
        const arr = toDT(s.arrivalDateAndTime);
        const depStr = dep ? dep.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "";
        const arrStr = arr ? arr.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "";

        const carrier = s.carrier ? ` • ${s.carrier}` : "";
        const stops = typeof s.numberOfStops === "number" ? ` • przystanki: ${s.numberOfStops}` : "";

        return `
          <div class="leg">
            <div class="legLeft">
              <div class="legTitle">${iconFor(s.travelMode)} ${(pathCities[idx].pl || pathCities[idx].name)} → ${(pathCities[idx + 1].pl || pathCities[idx + 1].name)}</div>
              <div class="legMeta">
                ${s.travelMode}${carrier} • ${formatTime(Number(s.durationInMinutes || 0))}
                • ${Math.round(converted)} ${targetCurrency}
                ${depStr && arrStr ? ` • ${depStr} → ${arrStr}` : ""}
                ${stops}
              </div>
            </div>
            <a class="pill" href="${s.deeplink || "https://www.omio.com/"}" target="_blank" rel="noopener noreferrer">Kup</a>
          </div>
        `;
      })
    );

    // add transfer buffers between legs
    if (chosenSchedules.length > 1) totalMin += (chosenSchedules.length - 1) * minTransferMin;

    if (routeMeta) {
      routeMeta.textContent = `${(pathCities[0].pl || pathCities[0].name)} → ${(pathCities[pathCities.length - 1].pl || pathCities[pathCities.length - 1].name)} • przesiadki: ${transfersCount}`;
    }

    if (routeCard) {
      routeCard.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
          <div>
            <div style="font-weight:900; font-size:15px;">Trasa (realne połączenia)</div>
            <div class="hint">Min. czas na przesiadkę: <span class="kbd">${minTransferMin} min</span></div>
          </div>
          <div style="text-align:right;">
            <div style="font-weight:900;">${formatTime(totalMin)}</div>
            <div class="hint">${Math.round(totalPrice)} ${targetCurrency}</div>
          </div>
        </div>
        <div class="routeLegs" style="margin-top:10px;">${legsHtml.join("")}</div>
      `;
    }

    // offers (quick list from first leg)
    if (offersEl) {
      offersEl.innerHTML = "";
      const top = (firstLegListForOffers || []).slice(0, 6);
      for (const s of top) {
        const srcCur = s.currency || "EUR";
        const converted = await convert(Number(s.price), srcCur, targetCurrency);
        const dep = toDT(s.departureDateAndTime);
        const arr = toDT(s.arrivalDateAndTime);
        const depStr = dep ? dep.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "";
        const arrStr = arr ? arr.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "";

        const div = document.createElement("div");
        div.className = "offer";
        div.innerHTML = `
          <div>
            <div style="font-weight:900">${iconFor(s.travelMode)} ${s.travelMode} • ${Math.round(converted)} ${targetCurrency}</div>
            <small>${depStr} → ${arrStr} • ${formatTime(Number(s.durationInMinutes || 0))} • ${s.carrier || ""}</small>
          </div>
          <a class="pill" href="${s.deeplink || "https://www.omio.com/"}" target="_blank" rel="noopener noreferrer">Kup</a>
        `;
        offersEl.appendChild(div);
      }
    }

    // main buy link points to first chosen leg deeplink (if exists)
    if (buyLink) buyLink.href = chosenSchedules[0]?.deeplink || "https://www.omio.com/";
  }

  function renderStartState() {
    if (routeMeta) routeMeta.textContent = "—";
    if (offersEl) offersEl.innerHTML = "";
    if (routeCard) {
      routeCard.innerHTML = `
        <div class="hint">
          Wpisz <span class="kbd">Skąd</span> i <span class="kbd">Dokąd</span>, wybierz datę i kliknij <span class="kbd">Szukaj</span>.
        </div>
      `;
    }
    if (buyLink) buyLink.href = "#";
  }

  // ---- Main search (REAL ONLY) ----
  async function onSearch() {
    clearMsgs();
    initMapOnce();

    const fromVal = fromEl?.value || "";
    const toVal = toEl?.value || "";
    const date = dateEl?.value || "";
    const currency = currencyEl?.value || "PLN";
    const minTransferMin = parseInt(minTransferEl?.value || "15", 10);
    const maxTransfers = parseInt(maxTransfersEl?.value || "1", 10);

    if (!fromVal.trim()) return showError("Wpisz miasto w polu „Skąd”.");
    if (!toVal.trim()) return showError("Wpisz miasto w polu „Dokąd”.");
    if (!date) return showError("Wybierz datę.");

    const fromCity = findCity(fromVal);
    const toCity = findCity(toVal);

    if (!fromCity) return showError("Nie znam miasta w polu „Skąd”. Wpisz pełną nazwę i wybierz z listy.");
    if (!toCity) return showError("Nie znam miasta w polu „Dokąd”. Wpisz pełną nazwę i wybierz z listy.");
    if (norm(fromCity.name) === norm(toCity.name) && (fromCity.cc === toCity.cc)) return showError("Miasto startu i celu muszą być różne.");

    const { vias, unknown } = parseVias(viasEl?.value || "");
    if (unknown.length) showWarn(`Nie rozpoznano: ${unknown.join(", ")} (pominięte).`);

    const pathCities = buildPath(fromCity, toCity, vias, maxTransfers);

    // Map: markers + polyline + rail overlay already on
    if (map) {
      clearMap();
      drawMarkers(pathCities);
      await drawPolyline(pathCities);
      fitTo(pathCities);
    }

    // REAL schedules per leg
    try {
      const chosen = [];
      let lastArrival = null;
      let firstLegSchedules = null;

      for (let i = 0; i < pathCities.length - 1; i++) {
        const aName = pathCities[i].pl || pathCities[i].name;
        const bName = pathCities[i + 1].pl || pathCities[i + 1].name;

        // Ask for PLN if user wants PLN; if source returns EUR anyway, we convert.
        const schedules = await fetchSchedules({
          fromName: aName,
          toName: bName,
          date,
          currency: currency,
          limit: 40,
        });

        if (!schedules.length) {
          // HARD RULE: no fake routes.
          showError(`Brak połączenia dla odcinka: ${aName} → ${bName}. Zmień via / datę / limit przesiadek.`);
          if (routeMeta) routeMeta.textContent = "Brak trasy";
          if (offersEl) offersEl.innerHTML = "";
          if (routeCard) routeCard.innerHTML = `<div class="hint">Brak wyników dla odcinka <span class="kbd">${aName} → ${bName}</span>.</div>`;
          if (buyLink) buyLink.href = "#";
          return;
        }

        if (i === 0) firstLegSchedules = schedules;

        const picked = chooseLegWithMinTransfer(schedules, lastArrival, minTransferMin);
        if (!picked) {
          showError(`Nie da się dobrać przesiadki z min. czasem ${minTransferMin} min. Zwiększ czas przesiadki albo zmień via.`);
          return;
        }

        chosen.push(picked);
        lastArrival = toDT(picked.arrivalDateAndTime) || lastArrival;
      }

      // Render
      await renderReal(pathCities, chosen, currency, minTransferMin, firstLegSchedules);
    } catch (e) {
      // HARD RULE: no fake routes. Do NOT fall back to offline.
      showError("Nie udało się pobrać realnych połączeń (możliwa blokada CORS / limit). Nie wyświetlam trasy, żeby nie „zmyślać”.");
      if (routeMeta) routeMeta.textContent = "Brak trasy";
      if (offersEl) offersEl.innerHTML = "";
      if (routeCard) routeCard.innerHTML = `<div class="hint">Spróbuj ponownie za chwilę albo zmień datę/miasta. Docelowo: stabilne źródło (np. API PKP / backend proxy).</div>`;
      if (buyLink) buyLink.href = "#";
      console.warn(e);
    }
  }

  // ---- Bindings ----
  if (searchBtn) searchBtn.addEventListener("click", onSearch);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // only if user started typing
      const fv = fromEl?.value?.trim();
      const tv = toEl?.value?.trim();
      if (fv || tv) onSearch();
    }
  });

  // ---- Start state (no defaults!) ----
  if (fromEl) fromEl.value = "";
  if (toEl) toEl.value = "";
  renderStartState();

  // Optional: show rail overlay info once
  if (warnBox) {
    showWarn("Warstwa torów jest włączona (OpenRailwayMap). Trasa na mapie rysowana jest polilinią, nie prostą.");
    // Do not block user; keep it visible until they search
  }

  // PWA install button (if present in some HTML versions)
  if (installBtn) {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      installBtn.style.display = "inline-flex";
    });

    installBtn.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.style.display = "none";
    });
  }
})();
