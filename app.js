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

  function showError(msg){ errorBox.style.display="block"; errorBox.textContent=msg; }
  function clearError(){ errorBox.style.display="none"; errorBox.textContent=""; }
  function showWarn(msg){ warnBox.style.display="block"; warnBox.textContent=msg; }
  function clearWarn(){ warnBox.style.display="none"; warnBox.textContent=""; }
  const norm = (s)=> (s||"").trim().toLowerCase();

  // --- indices ---
  const prefixIndex = new Map();
  const exactIndex = new Map();
  for (let i=0;i<CITIES.length;i++){
    const n = norm(CITIES[i].name);
    const k = n.slice(0,2);
    if(!prefixIndex.has(k)) prefixIndex.set(k, []);
    prefixIndex.get(k).push(i);
    if(!exactIndex.has(n)) exactIndex.set(n, CITIES[i]);
  }
  const findCity = (name)=> exactIndex.get(norm(name)) || null;

  function setDatalist(options){
    citiesDL.innerHTML = "";
    for (const name of options){
      const opt = document.createElement("option");
      opt.value = name;
      citiesDL.appendChild(opt);
    }
  }
  function onTypeUpdateDatalist(value){
    const v = norm(value);
    if (v.length < 2) return;
    const key = v.slice(0,2);
    const idxs = prefixIndex.get(key) || [];
    const matches = [];
    for (let k=0; k<idxs.length && matches.length<100; k++){
      const c = CITIES[idxs[k]];
      if (norm(c.name).startsWith(v)) matches.push(c.name);
    }
    if (matches.length) setDatalist(matches);
  }

  $("from").addEventListener("input", (e)=>onTypeUpdateDatalist(e.target.value));
  $("to").addEventListener("input", (e)=>onTypeUpdateDatalist(e.target.value));
  $("vias").addEventListener("input", (e)=>onTypeUpdateDatalist((e.target.value.split(",").pop() || "").trim()));

  statsPill.textContent = `Miasta: ${CITIES.length.toLocaleString("pl-PL")}`;

  // date default
  const d = new Date();
  $("date").value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

  setDatalist(CITIES.slice(0,250).map(c=>c.name));

  // --- map ---
  const map = L.map("map").setView([52.2297, 21.0122], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution:"© OpenStreetMap" }).addTo(map);

  let railLayer = null;
  function setRailOverlay(on){
    if(on){
      if(!railLayer){
        // OpenRailwayMap tile URL (standard style) :contentReference[oaicite:4]{index=4}
        railLayer = L.tileLayer("https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png", {
          attribution:"© OpenRailwayMap",
          opacity: 0.65,
          maxZoom: 19
        });
      }
      railLayer.addTo(map);
    } else {
      if(railLayer) map.removeLayer(railLayer);
    }
  }

  let markers = [];
  let poly = null;
  function clearMap(){
    markers.forEach(m=>map.removeLayer(m));
    markers = [];
    if(poly) map.removeLayer(poly);
    poly = null;
  }
  function drawMarkers(path){
    markers.forEach(m=>map.removeLayer(m));
    markers = [];
    path.forEach((c, idx)=>{
      const label = idx===0 ? `Start: ${c.name}` : (idx===path.length-1 ? `Cel: ${c.name}` : `Przesiadka: ${c.name}`);
      markers.push(L.marker([c.lat,c.lng]).addTo(map).bindPopup(label));
    });
  }
  function fitTo(path){
    map.fitBounds(L.latLngBounds(path.map(c=>[c.lat,c.lng])), { padding:[40,40] });
  }

  // OSRM polyline (route, not straight) :contentReference[oaicite:5]{index=5}
  async function osrmPolyline(a,b){
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if(!res.ok) throw new Error("OSRM");
    const data = await res.json();
    const coords = data?.routes?.[0]?.geometry?.coordinates;
    if(!coords?.length) throw new Error("OSRM geometry");
    return coords.map(([lng,lat])=>[lat,lng]);
  }

  async function drawLine(path, style){
    if(poly) map.removeLayer(poly);
    poly = null;

    if(style === "straight"){
      poly = L.polyline(path.map(c=>[c.lat,c.lng]), { color:"#3b82f6", weight:4, opacity:.85 }).addTo(map);
      return;
    }

    const stitched = [];
    for(let i=0;i<path.length-1;i++){
      try{
        const seg = await osrmPolyline(path[i], path[i+1]);
        stitched.push(...seg);
      } catch {
        stitched.push([path[i].lat,path[i].lng],[path[i+1].lat,path[i+1].lng]);
      }
    }
    poly = L.polyline(stitched, { color:"#3b82f6", weight:4, opacity:.85 }).addTo(map);
  }

  // --- currency: ECB EUR->PLN ---
  // ECB publishes daily FX XML :contentReference[oaicite:6]{index=6}
  const FX_KEY = "smartroute:fx:ecb";
  async function getEurToPlnRate(){
    const cached = (()=>{ try{return JSON.parse(localStorage.getItem(FX_KEY)||"null")}catch{return null} })();
    if(cached && (Date.now()-cached.ts)<12*60*60*1000 && cached.rate) return cached.rate;

    const res = await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml");
    if(!res.ok) throw new Error("ECB FX");
    const xml = await res.text();

    // quick parse: find Cube currency='PLN' rate='X'
    const m = xml.match(/currency='PLN'\s+rate='([0-9.]+)'/);
    if(!m) throw new Error("ECB PLN missing");
    const rate = parseFloat(m[1]);
    localStorage.setItem(FX_KEY, JSON.stringify({ ts: Date.now(), rate }));
    return rate;
  }

  async function toCurrency(amount, fromCur, toCur){
    if(fromCur === toCur) return amount;
    // support EUR->PLN and PLN->EUR via ECB rate
    const rate = await getEurToPlnRate();
    if(fromCur === "EUR" && toCur === "PLN") return amount * rate;
    if(fromCur === "PLN" && toCur === "EUR") return amount / rate;
    return amount; // fallback
  }

  // --- planner basics ---
  function parseVias(str){
    const parts = (str||"").split(",").map(s=>s.trim()).filter(Boolean);
    const vias = [];
    const unknown = [];
    for(const p of parts){
      const c = findCity(p);
      if(c) vias.push(c); else unknown.push(p);
    }
    return { vias, unknown };
  }

  // --- “real” verification stub ---
  // Uwaga: realne rozkłady wymagają źródła danych (API). Omio ma rozwiązania B2B i plugin, ale bywa CORS. :contentReference[oaicite:7]{index=7}
  // W tej wersji: jeśli fetch zablokuje, przełączamy na offline i piszemy ostrzeżenie.
  async function verifyLegExists(/*fromName,toName,date*/){
    // Tu docelowo podpinasz API rozkładów (np. B2B/partner).
    // Na dziś zwracamy true, ale możesz tu wpiąć swoje źródło.
    return true;
  }

  function iconFor(mode){
    if(mode==="train") return "🚆";
    if(mode==="bus") return "🚌";
    if(mode==="flight") return "✈️";
    return "🧭";
  }
  function formatTime(mins){
    const h=Math.floor(mins/60), m=mins%60;
    return h?`${h}h ${String(m).padStart(2,"0")}m`:`${m}m`;
  }

  // offline legs (symulacja)
  function offlineLegs(path, minTransferMin){
    const legs=[];
    let totalMin=0;
    let totalEur=0;

    for(let i=0;i<path.length-1;i++){
      const a=path[i], b=path[i+1];
      const dist = (()=>{
        const R=6371;
        const dLat=(b.lat-a.lat)*Math.PI/180;
        const dLng=(b.lng-a.lng)*Math.PI/180;
        const s1=Math.sin(dLat/2), s2=Math.sin(dLng/2);
        const aa=s1*s1 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*s2*s2;
        return 2*R*Math.asin(Math.sqrt(aa));
      })();

      const mode = dist>900?"flight":(dist<180?"bus":"train");
      const speed = mode==="flight"?650:(mode==="train"?140:95);
      const costPerKm = mode==="flight"?0.14:(mode==="train"?0.10:0.07);

      const minutes = Math.max(25, Math.round((dist/speed)*60));
      const priceEur = Math.max(8, Math.round(dist*costPerKm));

      legs.push({ from:a.name, to:b.name, mode, minutes, price:priceEur, currency:"EUR", deeplink:"#"});
      totalMin += minutes + (i<path.length-2 ? minTransferMin : 0);
      totalEur += priceEur;
    }

    return { legs, totalMin, totalEur };
  }

  async function render(path, legsObj, targetCurrency, minTransferMin){
    const rateNote = targetCurrency === "PLN" ? " (przeliczenie wg ECB)" : "";
    routeMeta.textContent = `${path[0].name} → ${path[path.length-1].name} • przesiadki: ${Math.max(0,path.length-2)}`;

    // convert totals
    const total = await toCurrency(legsObj.totalEur, "EUR", targetCurrency);

    routeCard.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
        <div>
          <div style="font-weight:900; font-size:15px;">Trasa</div>
          <div class="hint">Min. czas na przesiadkę: <span class="kbd">${minTransferMin} min</span></div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:900;">${formatTime(legsObj.totalMin)}</div>
          <div class="hint">~${Math.round(total)} ${targetCurrency}${rateNote}</div>
        </div>
      </div>

      <div class="routeLegs" style="margin-top:10px;">
        ${await Promise.all(legsObj.legs.map(async (l, idx)=>{
          const p = await toCurrency(l.price, l.currency, targetCurrency);
          return `
            <div class="leg">
              <div class="legLeft">
                <div class="legTitle">${iconFor(l.mode)} ${l.from} → ${l.to}</div>
                <div class="legMeta">${l.mode} • ${formatTime(l.minutes)} • ~${Math.round(p)} ${targetCurrency}</div>
              </div>
              <span class="pill">${idx < legsObj.legs.length-1 ? `Przesiadka ≥ ${minTransferMin} min` : "Koniec"}</span>
            </div>
          `;
        })) .then(x=>x.join(""))}
      </div>
    `;
  }

  async function onSearch(){
    clearError(); clearWarn();

    const from = findCity($("from").value);
    const to = findCity($("to").value);
    const date = $("date").value;
    const minTransferMin = parseInt($("minTransfer").value,10);
    const maxTransfers = parseInt($("maxTransfers").value,10);

    const currency = currencyEl?.value || "PLN";
    const lineStyle = lineStyleEl?.value || "route";
    const railOn = (railOverlayEl?.value||"off")==="on";
    const dataSource = dataSourceEl?.value || "real";

    setRailOverlay(railOn);

    if(!from) return showError("Nie znam miasta w polu „Skąd”. Wybierz z listy.");
    if(!to) return showError("Nie znam miasta w polu „Dokąd”. Wybierz z listy.");
    if(!date) return showError("Wybierz datę.");

    const { vias, unknown } = parseVias($("vias").value);
    if(unknown.length) showWarn(`Nie rozpoznano: ${unknown.join(", ")} (pominięte).`);

    const clippedVias = vias.slice(0, Math.max(0, maxTransfers));
    const path = [from, ...clippedVias, to];

    // REAL: verify each leg exists (docelowo: API rozkładów)
    if(dataSource === "real"){
      try{
        for(let i=0;i<path.length-1;i++){
          const ok = await verifyLegExists(path[i].name, path[i+1].name, date);
          if(!ok){
            showError(`Brak połączenia dla odcinka: ${path[i].name} → ${path[i+1].name}. Zmień via lub liczbę przesiadek.`);
            return;
          }
        }
      } catch {
        showWarn("Weryfikacja rozkładów zablokowana (np. CORS). Przełączam na Offline.");
        dataSourceEl.value = "offline";
      }
    }

    clearMap();
    drawMarkers(path);
    await drawLine(path, lineStyle);
    fitTo(path);

    const legsObj = offlineLegs(path, minTransferMin);

    // buy link (na razie ogólny)
    buyLink.href = "https://www.omio.com/";
    offersEl.innerHTML = `<div class="hint">Źródło zakupu: Omio / przewoźnik (do dopięcia na realnych danych)</div>`;

    await render(path, legsObj, currency, minTransferMin);
  }

  $("searchBtn").addEventListener("click", ()=>onSearch());
  document.addEventListener("keydown", (e)=>{ if(e.key==="Enter") onSearch(); });

  // PWA
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{});
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
