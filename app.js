\// app.js (v5): REAL routes (no fake legs) + PLN conversion + OSRM polyline + rail overlay
(() => {
  const CITIES = window.CITIES_EU || [];
  const $ = (id) => document.getElementById(id);

  const errorBox = $("errorBox");
  const warnBox = $("warnBox");
  const citiesDL = $("cities");
  const statsPill = $("statsPill");
  const routeMeta = $("routeMeta");
  const offersEl = $("offers");
  const routeCard = $("routeCard");
  const buyLink = $("buyLink");
  const installBtn = $("installBtn");

  const currencyEl = $("currency");
  const lineStyleEl = $("lineStyle");
  const railOverlayEl = $("railOverlay");
  const dataSourceEl = $("dataSource");

  let deferredPrompt = null;

  // ---------- helpers ----------
  const norm = (s) => (s || "").trim().toLowerCase();

  function showError(msg) {
    errorBox.style.display = "block";
    errorBox.textContent = msg;
  }
  function clearError() {
    errorBox.style.display = "none";
    errorBox.textContent = "";
  }
  function showWarn(msg) {
    warnBox.style.display = "block";
    warnBox.textContent = msg;
  }
  function clearWarn() {
    warnBox.style.display = "none";
    warnBox.textContent = "";
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

  // ---------- city index ----------
  const prefixIndex = new Map();
  const exactIndex = new Map();
  for (let i = 0; i < CITIES.length; i++) {
    const name = norm(CITIES[i].name);
    const key = name.slice(0, 2);
    if (!prefixIndex.has(key)) prefixIndex.set(key, []);
    prefixIndex.get(key).push(i);
    if (!exactIndex.has(name)) exactIndex.set(name, CITIES[i]);
  }

  function findCity(name) {
    return exactIndex.get(norm(name)) || null;
  }

  function setDatalist(options) {
    citiesDL.innerHTML = "";
    for (const name of options) {
      const opt = document.createElement("option");
      opt.value = name;
      citiesDL.appendChild(opt);
    }
  }

  function onTypeUpdateDatalist(value) {
    const v = norm(value);
    if (v.length < 2) return;
    const key = v.slice(0, 2);
    const idxs = prefixIndex.get(key) || [];
    const matches = [];
    for (let k = 0; k < idxs.length && matches.length < 120; k++) {
      const c = CITIES[idxs[k]];
      if (norm(c.name).startsWith(v)) matches.push(c.name);
    }
    if (matches.length) setDatalist(matches);
  }

  $("from").addEventListener("input", (e) => onTypeUpdateDatalist(e.target.value));
  $("to").addEventListener("input", (e) => onTypeUpdateDatalist(e.target.value));
  $("vias").addEventListener("input", (e) => onTypeUpdateDatalist((e.target.value.split(",").pop() || "").trim()));

  statsPill.textContent = `Miasta: ${CITIES.length.toLocaleString("pl-PL")}`;

  // date default
  const d = new Date();
  $("date").value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  setDatalist(CITIES.slice(0, 250).map((c) => c.name));

  // ---------- map ----------
  const map = L.map("map").setView([52.2297, 21.0122], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map);

  let railLayer = null;
  function setRailOverlay(on) {
    if (on) {
      if (!railLayer) {
        railLayer = L.tileLayer("https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png", {
          attribution: "© OpenRailwayMap",
          opacity: 0.65,
          maxZoom: 19
        });
      }
      railLayer.addTo(map);
    } else {
      if (railLayer) map.removeLayer(railLayer);
    }
  }

  let markers = [];
  let poly = null;

  function clearMap() {
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    if (poly) map.removeLayer(poly);
    poly = null;
  }

  function drawMarkers(path) {
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    path.forEach((c, idx) => {
      const label = idx === 0 ? `Start: ${c.name}` : idx === path.length - 1 ? `Cel: ${c.name}` : `Przesiadka: ${c.name}`;
      markers.push(L.marker([c.lat, c.lng]).addTo(map).bindPopup(label));
    });
  }

  function fitTo(path) {
    map.fitBounds(L.latLngBounds(path.map((c) => [c.lat, c.lng])), { padding: [40, 40] });
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

  async function drawLine(path, style) {
    if (poly) map.removeLayer(poly);
    poly = null;

    if (style === "straight") {
      poly = L.polyline(path.map((c) => [c.lat, c.lng]), { color: "#3b82f6", weight: 4, opacity: 0.85 }).addTo(map);
      return;
    }

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

  // ---------- currency conversion (ECB) ----------
  const FX_KEY = "eutrans:fx:ecb:v1";
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
    if (!Number.isFinite(amount)) return amount;
    if (fromCur === toCur) return amount;
    const rate = await getEurToPlnRate();
    if (fromCur === "EUR" && toCur === "PLN") return amount * rate;
    if (fromCur === "PLN" && toCur === "EUR") return amount / rate;
    return amount;
  }

  // ---------- parsing vias ----------
  function parseVias(str) {
    const parts = (str || "").split(",").map((s) => s.trim()).filter(Boolean);
    const vias = [];
    const unknown = [];
    for (const p of parts) {
      const c = findCity(p);
      if (c) vias.push(c);
      else unknown.push(p);
    }
    return { vias, unknown };
  }

  function buildPath(from, to, vias, maxTransfers) {
    const v = vias.slice(0, Math.max(0, maxTransfers));
    return [from, ...v, to];
  }

  // ---------- REAL schedules (Omio plugin endpoint) ----------
  // Uwaga: jeśli Omio zablokuje CORS, pokażemy komunikat i przełączymy na Offline.
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

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error("SCHEDULES_HTTP");
    const data = await res.json();
    const schedules = Array.isArray(data?.schedules) ? data.schedules : [];
    return schedules;
  }

  function toDT(x) {
    const d = new Date(x);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  function chooseLegWithMinTransfer(schedules, afterTime, minTransferMin) {
    // pick cheapest that departs after (afterTime + minTransfer)
    const sorted = schedules.slice().sort((a, b) => (Number(a.price) - Number(b.price)) || (new Date(a.departureDateAndTime) - new Date(b.departureDateAndTime)));

    if (!afterTime) return sorted[0] || null;

    const threshold = new Date(afterTime.getTime() + minTransferMin * 60000);
    for (const s of sorted) {
      const dep = toDT(s.departureDateAndTime);
      if (dep && dep >= threshold) return s;
    }
    return null;
  }

  // ---------- OFFLINE fallback (only if user selects offline or real fails) ----------
  function km(a, b) {
    const R = 6371;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
    const aa = s1 * s1 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * s2 * s2;
    return 2 * R * Math.asin(Math.sqrt(aa));
  }

  function offlineLegs(path, minTransferMin) {
    const legs = [];
    let totalMin = 0;
    let totalEur = 0;

    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const dist = km(a, b);
      const mode = dist > 900 ? "flight" : dist < 180 ? "bus" : "train";
      const speed = mode === "flight" ? 650 : mode === "train" ? 140 : 95;
      const costPerKm = mode === "flight" ? 0.14 : mode === "train" ? 0.10 : 0.07;

      const minutes = Math.max(25, Math.round((dist / speed) * 60));
      const priceEur = Math.max(8, Math.round(dist * costPerKm));

      legs.push({
        travelMode: mode,
        durationInMinutes: minutes,
        price: priceEur,
        currency: "EUR",
        deeplink: "https://www.omio.com/"
      });

      totalMin += minutes + (i < path.length - 2 ? minTransferMin : 0);
      totalEur += priceEur;
    }

    return { legs, totalMin, totalEur };
  }

  // ---------- render ----------
  async function renderOffline(path, off, targetCurrency, minTransferMin) {
    const legsRendered = await Promise.all(off.legs.map(async (l, idx) => {
      const price = await convert(Number(l.price), l.currency, targetCurrency);
      return `
        <div class="leg">
          <div class="legLeft">
            <div class="legTitle">${iconFor(l.travelMode)} ${path[idx].name} → ${path[idx + 1].name}</div>
            <div class="legMeta">${l.travelMode} • ${formatTime(l.durationInMinutes)} • ~${Math.round(price)} ${targetCurrency}</div>
          </div>
          <a class="pill" href="${l.deeplink}" target="_blank" rel="noopener noreferrer">Kup</a>
        </div>
      `;
    }));

    const total = await convert(off.totalEur, "EUR", targetCurrency);

    routeMeta.textContent = `${path[0].name} → ${path[path.length - 1].name} • odcinki: ${off.legs.length} • przesiadki: ${Math.max(0, path.length - 2)}`;
    routeCard.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
        <div>
          <div style="font-weight:900; font-size:15px;">Trasa (offline – symulacja)</div>
          <div class="hint">Min. czas na przesiadkę: <span class="kbd">${minTransferMin} min</span></div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:900;">${formatTime(off.totalMin)}</div>
          <div class="hint">~${Math.round(total)} ${targetCurrency}</div>
        </div>
      </div>
      <div class="routeLegs" style="margin-top:10px;">${legsRendered.join("")}</div>
    `;

    offersEl.innerHTML = `<div class="hint">Tryb offline: to są wartości poglądowe.</div>`;
    buyLink.href = "https://www.omio.com/";
  }

  async function renderReal(path, chosen, targetCurrency, minTransferMin, allSchedulesFirstLeg) {
    // totals
    let totalMin = 0;
    let totalPrice = 0;

    const legsRendered = await Promise.all(chosen.map(async (s, idx) => {
      const p = await convert(Number(s.price), s.currency || "EUR", targetCurrency);
      totalMin += Number(s.durationInMinutes || 0);
      totalPrice += p;

      const dep = toDT(s.departureDateAndTime);
      const arr = toDT(s.arrivalDateAndTime);
      const depStr = dep ? dep.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "";
      const arrStr = arr ? arr.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "";

      return `
        <div class="leg">
          <div class="legLeft">
            <div class="legTitle">${iconFor(s.travelMode)} ${path[idx].name} → ${path[idx + 1].name}</div>
            <div class="legMeta">
              ${s.travelMode} • ${s.carrier || ""} • ${formatTime(Number(s.durationInMinutes || 0))}
              • ${Math.round(p)} ${targetCurrency}
              ${depStr && arrStr ? ` • ${depStr} → ${arrStr}` : ""}
              • stops: ${s.numberOfStops ?? "?"}
            </div>
          </div>
          <a class="pill" href="${s.deeplink}" target="_blank" rel="noopener noreferrer">Kup</a>
        </div>
      `;
    }));

    // add transfer buffer between legs
    if (chosen.length > 1) totalMin += (chosen.length - 1) * minTransferMin;

    routeMeta.textContent = `${path[0].name} → ${path[path.length - 1].name} • odcinki: ${chosen.length} • przesiadki: ${Math.max(0, path.length - 2)}`;
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
      <div class="routeLegs" style="margin-top:10px;">${legsRendered.join("")}</div>
    `;

    // Offers: show best few from first leg as quick pick
    offersEl.innerHTML = "";
    const top = (allSchedulesFirstLeg || []).slice(0, 6);
    for (const s of top) {
      const p = await convert(Number(s.price), s.currency || "EUR", targetCurrency);
      const dep = toDT(s.departureDateAndTime);
      const arr = toDT(s.arrivalDateAndTime);
      const depStr = dep ? dep.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "";
      const arrStr = arr ? arr.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "";

      const div = document.createElement("div");
      div.className = "offer";
      div.innerHTML = `
        <div>
          <div style="font-weight:900">${iconFor(s.travelMode)} ${s.travelMode} • ${Math.round(p)} ${targetCurrency}</div>
          <small>${depStr} → ${arrStr} • ${formatTime(Number(s.durationInMinutes||0))} • stops: ${s.numberOfStops ?? "?"} • ${s.carrier || ""}</small>
        </div>
        <a class="pill" href="${s.deeplink}" target="_blank" rel="noopener noreferrer">Kup</a>
      `;
      offersEl.appendChild(div);
    }

    // main buy link: first chosen leg
    buyLink.href = chosen[0]?.deeplink || "https://www.omio.com/";
  }

  // ---------- main search ----------
  async function onSearch() {
    clearError();
    clearWarn();

    const from = findCity($("from").value);
    const to = findCity($("to").value);
    const date = $("date").value;

    const minTransferMin = parseInt($("minTransfer").value, 10);
    const maxTransfers = parseInt($("maxTransfers").value, 10);

    const currency = currencyEl?.value || "PLN";
    const lineStyle = lineStyleEl?.value || "route";
    const railOn = (railOverlayEl?.value || "off") === "on";
    const dataSource = dataSourceEl?.value || "real";

    if (!from) return showError("Nie znam miasta w polu „Skąd”. Wybierz z listy.");
    if (!to) return showError("Nie znam miasta w polu „Dokąd”. Wybierz z listy.");
    if (!date) return showError("Wybierz datę.");

    const { vias, unknown } = parseVias($("vias").value);
    if (unknown.length) showWarn(`Nie rozpoznano: ${unknown.join(", ")} (pominięte).`);

    const path = buildPath(from, to, vias, maxTransfers);

    setRailOverlay(railOn);
    clearMap();
    drawMarkers(path);
    await drawLine(path, lineStyle);
    fitTo(path);

    // OFFLINE
    if (dataSource === "offline") {
      const off = offlineLegs(path, minTransferMin);
      return renderOffline(path, off, currency, minTransferMin);
    }

    // REAL
    try {
      const chosen = [];
      let lastArrival = null;
      let firstLegSchedules = null;

      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i].name;
        const b = path[i + 1].name;

        // We request PLN. If Omio returns EUR anyway, we'll convert.
        const schedules = await fetchSchedules({ fromName: a, toName: b, date, currency: currency });
        if (!schedules.length) {
          showError(`Brak połączenia dla odcinka: ${a} → ${b}. Zmień via lub liczbę przesiadek.`);
          offersEl.innerHTML = "";
          routeCard.innerHTML = `<div class="hint">Brak wyników dla odcinka ${a} → ${b}.</div>`;
          buyLink.href = "https://www.omio.com/";
          return;
        }

        if (i === 0) firstLegSchedules = schedules;

        const picked = chooseLegWithMinTransfer(schedules, lastArrival, minTransferMin);
        if (!picked) {
          showError(`Nie da się ułożyć przesiadek z min. czasem ${minTransferMin} min. Zmień min. czas przesiadki albo via.`);
          return;
        }

        chosen.push(picked);
        lastArrival = toDT(picked.arrivalDateAndTime) || lastArrival;
      }

      return renderReal(path, chosen, currency, minTransferMin, firstLegSchedules);
    } catch (e) {
      // If CORS/rate limit: fallback
      showWarn("Nie udało się pobrać realnych wyników (możliwy CORS/limit). Przełączam na Offline.");
      dataSourceEl.value = "offline";
      const off = offlineLegs(path, minTransferMin);
      return renderOffline(path, off, currency, minTransferMin);
    }
  }

  $("searchBtn").addEventListener("click", () => onSearch());
  document.addEventListener("keydown", (e) => { if (e.key === "Enter") onSearch(); });

  // PWA
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
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

  // defaults
  $("from").value = "Warszawa";
  $("to").value = "Berlin";
  onSearch();
})();

