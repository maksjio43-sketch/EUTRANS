// app.js (v2: szybkie wyszukiwanie + lepsze przesiadki + PWA)
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

  // PWA install
  let deferredPrompt = null;
  const installBtn = $("installBtn");

  // ---------- UI helpers ----------
  function showError(msg){ errorBox.style.display="block"; errorBox.textContent=msg; }
  function clearError(){ errorBox.style.display="none"; errorBox.textContent=""; }
  function showWarn(msg){ warnBox.style.display="block"; warnBox.textContent=msg; }
  function clearWarn(){ warnBox.style.display="none"; warnBox.textContent=""; }
  function norm(s){ return (s||"").trim().toLowerCase(); }

  // ---------- Fast search index ----------
  // Build prefix index to avoid heavy filtering on every keypress for huge lists.
  // key = first 2 letters, value = array of indices into CITIES
  const prefixIndex = new Map();
  for (let i=0; i<CITIES.length; i++){
    const name = norm(CITIES[i].name);
    const key = name.slice(0,2);
    if(!prefixIndex.has(key)) prefixIndex.set(key, []);
    prefixIndex.get(key).push(i);
  }

  // Also build exact lookup (fast city resolve)
  const exactIndex = new Map();
  for (const c of CITIES) {
    const k = norm(c.name);
    if (!exactIndex.has(k)) exactIndex.set(k, c);
  }

  function findCity(name){
    return exactIndex.get(norm(name)) || null;
  }

  function parseVias(str){
    const parts = (str||"").split(",").map(s=>s.trim()).filter(Boolean);
    const vias = [];
    const unknown = [];
    for (const p of parts){
      const c = findCity(p);
      if(c) vias.push(c);
      else unknown.push(p);
    }
    return { vias, unknown };
  }

  // Fill datalist with a limited initial set (for performance).
  // We'll dynamically update datalist as user types.
  function setDatalist(options){
    citiesDL.innerHTML = "";
    options.forEach(name => {
      const opt = document.createElement("option");
      opt.value = name;
      citiesDL.appendChild(opt);
    });
  }

  statsPill.textContent = `Miasta: ${CITIES.length.toLocaleString("pl-PL")}`;

  // Default date = today
  const d = new Date();
  $("date").value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

  // Initial datalist: top 200 by population (if available) else first 200.
  const initial = CITIES
    .slice()
    .sort((a,b)=> (b.population||0) - (a.population||0))
    .slice(0, 200)
    .map(c=>c.name);
  setDatalist(initial);

  // Dynamically update datalist when typing in from/to
  function onTypeUpdateDatalist(value){
    const v = norm(value);
    if (v.length < 2) return; // keep it small
    const key = v.slice(0,2);
    const idxs = prefixIndex.get(key) || [];
    const matches = [];
    // pull first ~80 matches max
    for (let k=0; k<idxs.length && matches.length<80; k++){
      const c = CITIES[idxs[k]];
      if (norm(c.name).startsWith(v)) matches.push(c.name);
    }
    if (matches.length) setDatalist(matches);
  }

  $("from").addEventListener("input", (e)=>onTypeUpdateDatalist(e.target.value));
  $("to").addEventListener("input", (e)=>onTypeUpdateDatalist(e.target.value));
  $("vias").addEventListener("input", (e)=>onTypeUpdateDatalist(e.target.value.split(",").pop() || ""));

  // ---------- Leaflet map ----------
  const map = L.map("map", { zoomControl:true }).setView([52.2297, 21.0122], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution:"© OpenStreetMap" }).addTo(map);

  let markers = [];
  let poly = null;

  function clearMap(){
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    if(poly) map.removeLayer(poly);
    poly = null;
  }

  function drawPath(pathCities){
    clearMap();
    const latlngs = pathCities.map(c => [c.lat, c.lng]);

    pathCities.forEach((c, idx) => {
      const label = idx === 0 ? `Start: ${c.name}` : (idx === pathCities.length-1 ? `Cel: ${c.name}` : `Przesiadka: ${c.name}`);
      const m = L.marker([c.lat, c.lng]).addTo(map).bindPopup(label);
      markers.push(m);
    });

    poly = L.polyline(latlngs, { color:"#3b82f6", weight:4, opacity:.85 }).addTo(map);

    const bounds = L.latLngBounds(latlngs);
    map.fitBounds(bounds, { padding:[40,40] });
  }

  // ---------- Distance helpers ----------
  function km(a,b){
    const R=6371;
    const dLat=(b.lat-a.lat)*Math.PI/180;
    const dLng=(b.lng-a.lng)*Math.PI/180;
    const s1=Math.sin(dLat/2), s2=Math.sin(dLng/2);
    const aa=s1*s1 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*s2*s2;
    return 2*R*Math.asin(Math.sqrt(aa));
  }
  function totalKm(path){
    let sum=0;
    for(let i=0;i<path.length-1;i++) sum += km(path[i], path[i+1]);
    return sum;
  }

  // ---------- Planner logic (offline, but respects your rules) ----------
  // Rules:
  // - user can force vias (must be included in order)
  // - user can set maxTransfers (strict)
  // - user can set minTransferMin (applied between legs)
  // - if auto-suggested transfers do not violate rules, keep them; else reduce transfers
  // - never "add" a transfer that breaks maxTransfers; instead return a direct route

  function pickHubs(from, to, count){
    // choose hubs that reduce detour: minimize from->hub + hub->to
    // we limit candidates to keep it fast on huge datasets
    const candidates = CITIES
      .filter(c => c !== from && c !== to)
      .slice(0, 5000);

    const scored = candidates.map(c => ({
      c,
      score: km(from,c) + km(c,to)
    })).sort((a,b)=>a.score-b.score);

    const hubs = [];
    for (const s of scored){
      hubs.push(s.c);
      if (hubs.length >= count) break;
    }
    return hubs;
  }

  function buildPath(from, to, vias, maxTransfers){
    // strict maxTransfers
    // transfers = nodes in between = path.length - 2
    if (maxTransfers < 0) maxTransfers = 0;

    if (vias.length){
      const transfers = vias.length;
      if (transfers > maxTransfers) {
        // strict: if user demands too many vias, we cannot satisfy -> take only first allowed
        const clipped = vias.slice(0, maxTransfers);
        return [from, ...clipped, to];
      }
      return [from, ...vias, to];
    }

    if (maxTransfers === 0) return [from, to];

    const hubs = pickHubs(from, to, maxTransfers);
    return [from, ...hubs, to];
  }

  function chooseMode(distKm, optMode){
    // simple heuristics; later we can replace by real schedules once backend exists
    if (optMode === "cheapest") {
      if (distKm < 220) return "autobus";
      if (distKm < 900) return "pociąg";
      return "samolot (opc.)";
    }
    if (optMode === "fastest") {
      if (distKm > 450) return "samolot (opc.)";
      if (distKm > 160) return "pociąg";
      return "autobus";
    }
    if (optMode === "fewest") {
      // mode doesn't matter much here; prefer train
      if (distKm > 900) return "samolot (opc.)";
      return "pociąg";
    }
    // balanced
    if (distKm < 180) return "autobus";
    if (distKm > 900) return "samolot (opc.)";
    return "pociąg";
  }

  function legParams(mode){
    if (mode.includes("samolot")) return { speed: 650, costPerKm: 0.14 };
    if (mode === "pociąg") return { speed: 140, costPerKm: 0.10 };
    return { speed: 95, costPerKm: 0.07 };
  }

  function buildLegs(path, minTransferMin, optMode){
    const legs = [];
    let totalMinutes = 0;
    let totalPrice = 0;

    for(let i=0;i<path.length-1;i++){
      const a = path[i], b = path[i+1];
      const dist = km(a,b);
      const mode = chooseMode(dist, optMode);
      const { speed, costPerKm } = legParams(mode);

      const minutes = Math.max(25, Math.round((dist / speed) * 60));
      const price = Math.max(8, Math.round(dist * costPerKm));

      legs.push({
        from: a.name, to: b.name,
        mode, distKm: Math.round(dist),
        durationMin: minutes, priceEUR: price
      });

      totalMinutes += minutes;
      totalPrice += price;

      if(i < path.length-2) totalMinutes += minTransferMin; // strict: apply user min transfer
    }

    return { legs, totalMinutes, totalPrice };
  }

  function formatTime(mins){
    const h = Math.floor(mins/60);
    const m = mins%60;
    return h ? `${h}h ${String(m).padStart(2,"0")}m` : `${m}m`;
  }

  function iconFor(mode){
    if(mode.includes("samolot")) return "✈️";
    if(mode === "pociąg") return "🚆";
    if(mode === "autobus") return "🚌";
    return "🚗";
  }

  function buildOmioDeeplink(from, to, date){
    const affiliateId = "TEST123"; // podmienisz później na swój
    return `https://www.omio.com/?departure_fk=${encodeURIComponent(from.id)}&arrival_fk=${encodeURIComponent(to.id)}&date=${encodeURIComponent(date)}&affiliate_id=${encodeURIComponent(affiliateId)}`;
  }

  function renderRoute(path, legsInfo, minTransferMin){
    const transfers = Math.max(0, path.length - 2);
    const dist = Math.round(totalKm(path));

    routeMeta.textContent = `${path[0].name} → ${path[path.length-1].name} • ${dist} km • przesiadki: ${transfers}`;

    routeCard.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
        <div>
          <div style="font-weight:900; font-size:15px;">Proponowana trasa</div>
          <div class="hint">Min. czas na przesiadkę: <span class="kbd">${minTransferMin} min</span></div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:900;">${formatTime(legsInfo.totalMinutes)}</div>
          <div class="hint">~${legsInfo.totalPrice} EUR (poglądowo)</div>
        </div>
      </div>

      <div class="routeLegs">
        ${legsInfo.legs.map((l, idx) => `
          <div class="leg">
            <div class="legLeft">
              <div class="legTitle">${iconFor(l.mode)} ${l.from} → ${l.to}</div>
              <div class="legMeta">${l.mode} • ${l.distKm} km • ${formatTime(l.durationMin)} • ~${l.priceEUR} EUR</div>
            </div>
            <span class="pill">${idx < legsInfo.legs.length-1 ? `Przesiadka ≥ ${minTransferMin} min` : "Koniec"}</span>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderOffers(from, to, date, distKm, optMode){
    // demo offers – consistent with optMode
    const base = Math.max(8, Math.round(distKm * 0.10));
    const fastest = Math.round(base * 1.15);
    const cheapest = Math.round(base * 0.85);

    const offers = [
      { title:"Najkorzystniej", price: base, meta:"balans", link: buildOmioDeeplink(from,to,date) },
      { title:"Najszybciej", price: fastest, meta:"priorytet czasu", link: buildOmioDeeplink(from,to,date) },
      { title:"Najtaniej", price: cheapest, meta:"priorytet ceny", link: buildOmioDeeplink(from,to,date) },
    ].sort((a,b)=>a.price-b.price);

    offersEl.innerHTML = "";
    offers.forEach(o => {
      const div = document.createElement("div");
      div.className = "offer";
      div.innerHTML = `
        <div>
          <div style="font-weight:900">${o.title}</div>
          <small>${o.meta} • link: Omio</small>
        </div>
        <div style="display:flex; gap:10px; align-items:center;">
          <div style="font-weight:900">${o.price} EUR</div>
          <a class="pill" href="${o.link}" target="_blank" rel="noopener noreferrer">Kup</a>
        </div>
      `;
      offersEl.appendChild(div);
    });
  }

  // ---------- Main search ----------
  function onSearch(){
    clearError(); clearWarn();

    const from = findCity($("from").value);
    const to = findCity($("to").value);
    const date = $("date").value;

    const minTransferMin = parseInt($("minTransfer").value, 10);
    const maxTransfers = parseInt($("maxTransfers").value, 10);
    const optMode = $("optMode").value;

    if(!from) return showError("Nie znam miasta w polu „Skąd”. Wpisz nazwę i wybierz z listy.");
    if(!to) return showError("Nie znam miasta w polu „Dokąd”. Wpisz nazwę i wybierz z listy.");
    if(!date) return showError("Wybierz datę.");
    if(norm(from.name) === norm(to.name)) return showError("Miasto startu i celu muszą być różne.");

    const { vias, unknown } = parseVias($("vias").value);
    if(unknown.length){
      showWarn(`Nie rozpoznano stacji pobocznych: ${unknown.join(", ")}. Te punkty zostaną pominięte.`);
    }

    // Build route strictly respecting maxTransfers
    const path = buildPath(from, to, vias, maxTransfers);
    const transfers = Math.max(0, path.length - 2);

    if(vias.length && vias.length > maxTransfers){
      showWarn(`Wpisałeś ${vias.length} stacji pobocznych, ale limit przesiadek to ${maxTransfers}. Użyłem pierwszych ${maxTransfers}.`);
    } else if(!vias.length && maxTransfers > 0){
      // Inform user that suggested transfers are within limit
      showWarn(`Proponuję trasę z przesiadkami: ${transfers} (mieszczę się w limicie). Możesz dopisać własne stacje poboczne.`);
    }

    // Draw map + render route
    drawPath(path);
    const legsInfo = buildLegs(path, minTransferMin, optMode);
    renderRoute(path, legsInfo, minTransferMin);

    // Buy link for whole trip
    buyLink.href = buildOmioDeeplink(from, to, date);

    // Demo offers
    const dist = Math.round(totalKm(path));
    renderOffers(from, to, date, dist, optMode);
  }

  $("searchBtn").addEventListener("click", onSearch);
  document.addEventListener("keydown", (e)=>{ if(e.key==="Enter") onSearch(); });

  // Defaults
  $("from").value = "Warszawa";
  $("to").value = "Berlin";
  onSearch();

  // ---------- PWA ----------
  if ("serviceWorker" in navigator) {
    // Works best on http(s); file:// may limit SW.
    navigator.serviceWorker.register("./sw.js").catch(()=>{});
  }

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
})();
