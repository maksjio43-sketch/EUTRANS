(() => {
  const $ = (id) => document.getElementById(id);

  const pillLeaflet = $("pillLeaflet");
  const pillCities = $("pillCities");
  const pillApp = $("pillApp");
  const mapOverlay = $("mapOverlay");

  const stationsDL = $("stations");
  const fromEl = $("from");
  const toEl = $("to");
  const dateEl = $("date");
  const railOverlayEl = $("railOverlay");
  const diagText = $("diagText");

  // oznaczamy, że app.js się uruchomił
  pillApp.textContent = "app.js: OK";
  pillApp.className = "pill ok";

  // Leaflet check
  const hasLeaflet = typeof window.L !== "undefined";
  pillLeaflet.textContent = hasLeaflet ? "Leaflet: OK" : "Leaflet: BRAK";
  pillLeaflet.className = hasLeaflet ? "pill ok" : "pill bad";

  // Cities check
  const cities = Array.isArray(window.CITIES_EU) ? window.CITIES_EU : [];
  pillCities.textContent = `Miasta: ${cities.length}`;
  pillCities.className = cities.length ? "pill ok" : "pill bad";

  // jeśli cities puste -> pokaż powód na ekranie
  if (!cities.length) {
    diagText.textContent = "cities-eu.js nie wczytał się albo nie jest w root (404 / zła nazwa).";
  } else {
    diagText.textContent = "OK — lista miast załadowana.";
  }

  // ustaw datę dzisiaj
  if (dateEl && !dateEl.value) {
    const d = new Date();
    dateEl.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }

  // proste autouzupełnianie miast (działa zawsze)
  const norm = (s) => (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
  const labels = cities.map(c => (c.pl || c.name) + (c.cc ? ` (${c.cc})` : "")).filter(Boolean);
  const labelsN = labels.map(l => norm(l));

  function setDatalist(arr){
    stationsDL.innerHTML = "";
    const seen = new Set();
    for (const v of arr.slice(0, 120)) {
      if (seen.has(v)) continue;
      seen.add(v);
      const opt = document.createElement("option");
      opt.value = v;
      stationsDL.appendChild(opt);
    }
  }

  function suggest(q){
    const nq = norm(q);
    if (nq.length < 2) return;
    const out = [];
    for (let i=0;i<labels.length && out.length<120;i++){
      if (labelsN[i].includes(nq)) out.push(labels[i]);
    }
    setDatalist(out.length ? out : labels.slice(0,120));
  }

  fromEl?.addEventListener("input", e => suggest(e.target.value));
  toEl?.addEventListener("input", e => suggest(e.target.value));

  // --- MAPA ---
  if (!hasLeaflet) {
    mapOverlay.innerHTML = "❌ Leaflet nie wczytał się (CDN zablokowany).";
    mapOverlay.style.display = "flex";
    return;
  }

  const map = L.map("map").setView([52.2297, 21.0122], 6);

  const baseLayers = [
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }),
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom: 20, subdomains: "abcd", attribution: "© OSM © CARTO" }),
  ];

  let current = 0;
  let loaded = false;

  function useLayer(i){
    loaded = false;
    if (baseLayers[current]) map.removeLayer(baseLayers[current]);
    current = i;
    baseLayers[current].addTo(map);

    baseLayers[current].once("load", () => {
      loaded = true;
      mapOverlay.style.display = "none";
    });

    baseLayers[current].on("tileerror", () => {
      // po błędzie przełącz na kolejny
      if (!loaded && current + 1 < baseLayers.length) {
        mapOverlay.innerHTML = "⚠️ Kafelki nie dochodzą — przełączam źródło mapy…";
        useLayer(current + 1);
      } else if (!loaded) {
        mapOverlay.innerHTML = "❌ Mapa nie ładuje kafelków. Wyłącz adblock / Ctrl+F5 / inna sieć.";
        mapOverlay.style.display = "flex";
      }
    });

    mapOverlay.innerHTML = "Ładowanie mapy…";
    mapOverlay.style.display = "flex";
  }

  useLayer(0);

  // railway overlay (opcjonalnie)
  const rail = L.tileLayer("https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png", {
    maxZoom: 19, opacity: 0.65, attribution: "© OpenRailwayMap"
  });

  function applyRail(){
    const on = railOverlayEl?.value === "on";
    const has = map.hasLayer(rail);
    if (on && !has) rail.addTo(map);
    if (!on && has) map.removeLayer(rail);
  }
  railOverlayEl?.addEventListener("change", applyRail);

  setTimeout(()=>map.invalidateSize(true), 250);
})();
