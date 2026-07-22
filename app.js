/* ===================================================================
   LE GRAND LIVRE — app.js (v3.0 — snapshot local uniquement)
   Toute la logique d'appel API en direct (FMP, Finnhub, Wikipedia) a été
   retirée : le site lit uniquement data-snapshot.json, généré par le
   scraper Python local (dossier scraper/). Plus simple, plus rapide,
   aucune clé ni quota à gérer côté visiteur du site.
   =================================================================== */

const APP_VERSION = "v4.1.0";

// Aucun fetch() ne doit pouvoir bloquer indéfiniment (réseau instable,
// serveur qui ne répond jamais, etc.) — on force un délai maximum.
async function fetchWithTimeout(url, options, timeoutMs = 15000){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try{
    return await fetch(url, {...(options||{}), signal: controller.signal});
  }catch(e){
    if(e.name === "AbortError") throw new Error("Délai dépassé (>" + Math.round(timeoutMs/1000) + "s), le serveur ne répond pas");
    throw e;
  }finally{
    clearTimeout(timer);
  }
}

let state = {
  strategy: "trending_value",
  countries: new Set(), // aucun pays coché par défaut
  resultCount: 25,
  mcapFloor: 1000000000,
  sortCol: "rank",
  sortDir: "asc",
  lastResults: [],
  lastRunMeta: null,
};

// ---------------------------------------------------------------
// Scoring (Value Composite Two, percentile ranks) — fidèle au livre
// ---------------------------------------------------------------
function percentileRank(value, sortedAsc, betterWhenLower){
  if(value===null || value===undefined) return 50;
  const n = sortedAsc.length;
  if(n<=1) return 50;
  // rang moyen en cas d'ex-aequo (évite qu'un groupe de valeurs identiques
  // ne récupère toujours le rang du premier élément trouvé)
  let lowerCount = 0, equalCount = 0;
  for(const v of sortedAsc){
    if(v < value) lowerCount++;
    else if(v === value) equalCount++;
  }
  const avgPos = lowerCount + (equalCount - 1) / 2;
  const pct = avgPos / (n - 1);
  const rank = betterWhenLower ? (100 - pct*99) : (1 + pct*99);
  return Math.round(rank);
}

function scorePool(records){
  const factorDefs = [
    {key:"pb", lower:true},
    {key:"pe", lower:true},
    {key:"ps", lower:true},
    {key:"pcf", lower:true},
    {key:"ebitdaYield", lower:false},
    {key:"shareholderYield", lower:false},
  ];
  const sortedByFactor = {};
  factorDefs.forEach(f=>{
    sortedByFactor[f.key] = records.map(r=>r[f.key]).filter(v=>v!==null && v!==undefined).sort((a,b)=>a-b);
  });
  records.forEach(rec=>{
    let sum = 0;
    factorDefs.forEach(f=>{
      const rank = percentileRank(rec[f.key], sortedByFactor[f.key], f.lower);
      rec["rank_"+f.key] = rank;
      sum += rank;
    });
    rec.vc2Score = sum;
  });
  const sortedScores = records.map(r=>r.vc2Score).sort((a,b)=>a-b);
  records.forEach(rec=>{
    rec.vc2Rank = percentileRank(rec.vc2Score, sortedScores, false);
  });
  return records;
}

// ---------------------------------------------------------------
// Chargement et filtrage du snapshot local
// ---------------------------------------------------------------
let snapshotCache = null;
async function loadSnapshot(){
  if(snapshotCache) return snapshotCache;
  // Cache-buster : sans ça, le navigateur (ou le CDN de GitHub Pages) peut
  // continuer à servir une ancienne version du fichier après un ré-upload,
  // puisque data-snapshot.json garde toujours le même nom.
  const url = "./data-snapshot.json?t=" + Date.now();
  const res = await fetchWithTimeout(url, {cache:"no-store"}, 15000);
  if(!res.ok){
    throw new Error("data-snapshot.json introuvable (HTTP "+res.status+") — lance d'abord le scraper local (voir scraper/README.md) puis commit le fichier généré à la racine du site.");
  }
  const json = await res.json();
  if(!json || !Array.isArray(json.records)){
    throw new Error("data-snapshot.json a un format inattendu.");
  }
  snapshotCache = json;
  return json;
}

async function runScreening(){
  const runBtn = document.getElementById("runBtn");
  const progressTxt = document.getElementById("progressTxt");
  runBtn.disabled = true;
  progressTxt.textContent = "Chargement du snapshot local…";
  try{
    const countries = [...state.countries];
    if(countries.length===0){ toast("Sélectionnez au moins un pays."); runBtn.disabled=false; progressTxt.textContent=""; return; }

    const snap = await loadSnapshot();
    let records = snap.records.filter(r => countries.includes(r.country));
    records = records.filter(r => !r.mcap || r.mcap >= state.mcapFloor);

    if(records.length === 0){
      toast("Aucun titre dans le snapshot pour cette combinaison pays/capitalisation. Vérifie que le scraper a bien couvert ces pays, ou baisse le seuil de capitalisation.");
      runBtn.disabled=false; progressTxt.textContent="";
      return;
    }

    records = scorePool(records.map(r=>({...r}))); // copie défensive, scorePool mute les objets
    const strat = STRATEGIES[state.strategy];
    const selected = strat.select(records, state.resultCount);

    state.lastResults = selected;
    state.lastRunMeta = {
      strategy: state.strategy,
      poolCount: records.length,
      universeCount: records.length,
      countries: countries,
      snapshotGeneratedAt: snap.generatedAt,
      ts: Date.now(),
    };
    state.sortCol = "rank"; state.sortDir = "asc";
    renderResults();
    const anchor = document.getElementById("results-anchor");
    if(anchor && anchor.scrollIntoView) anchor.scrollIntoView({behavior:"smooth", block:"start"});
    progressTxt.textContent = `Terminé — snapshot local du ${new Date(snap.generatedAt).toLocaleString('fr-FR')}.`;
  }catch(err){
    console.error(err);
    toast("Erreur : " + err.message);
    progressTxt.textContent = "";
  }finally{
    runBtn.disabled = false;
  }
}

// ---------------------------------------------------------------
// Formatage
// ---------------------------------------------------------------
function fmtPct(v){ return (v===null||v===undefined) ? "—" : (v*100>=0?"+":"")+(v*100).toFixed(1)+"%"; }
function fmtMom(v){ return (v===null||v===undefined) ? "—" : (v>=0?"+":"")+v.toFixed(1)+"%"; }
function fmtNum(v, d=1){ return (v===null||v===undefined) ? "—" : v.toFixed(d); }
function fmtMcap(v){
  if(!v) return "—";
  if(v>=1e12) return (v/1e12).toFixed(2)+"T";
  if(v>=1e9) return (v/1e9).toFixed(2)+"Md";
  if(v>=1e6) return (v/1e6).toFixed(0)+"M";
  return v.toString();
}

// ---------------------------------------------------------------
// Rendu UI
// ---------------------------------------------------------------
function renderStrategyCards(){
  const grid = document.getElementById("strategyGrid");
  grid.innerHTML = "";
  STRATEGY_ORDER.forEach(id=>{
    const s = STRATEGIES[id];
    const card = document.createElement("div");
    card.className = "strategy-card" + (state.strategy===id ? " active":"");
    card.dataset.id = id;
    card.innerHTML = `
      <h3>${s.name}</h3>
      <p>${s.short}</p>
      ${s.stampReturn?`<div class="stamp"><b>${s.stampReturn}</b><span class="yrs">${s.stampYears}</span></div>`:''}
    `;
    card.addEventListener("click", ()=>{
      state.strategy = id;
      document.querySelectorAll(".strategy-card").forEach(el=>el.classList.remove("active"));
      card.classList.add("active");
      // Certaines stratégies (Higgons) ont un plafond de capitalisation intégré à
      // leur filtre — si le plancher choisi est au-dessus ou trop proche de ce
      // plafond, la stratégie ne trouverait presque plus rien. On rabaisse alors
      // automatiquement le plancher, avec un message explicite pour ne pas
      // surprendre silencieusement.
      if(s.hardMcapCeiling && state.mcapFloor >= s.hardMcapCeiling){
        state.mcapFloor = 200000000;
        const sel = document.getElementById("mcapFloor");
        if(sel) sel.value = "200000000";
        toast(`${s.name} a un plafond de capitalisation intégré (≤ ${(s.hardMcapCeiling/1e9).toFixed(0)} Md) — plancher repassé à 200 M$ automatiquement.`);
      }
    });
    grid.appendChild(card);
  });
}

function renderZonesAndCountries(){
  const zoneRow = document.getElementById("zoneRow");
  zoneRow.innerHTML = "";
  ZONES.forEach(z=>{
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.textContent = z.label;
    chip.addEventListener("click", ()=>{
      // toggle: si toutes les countries de la zone sont déjà sélectionnées -> on les retire, sinon on les ajoute
      const allIn = z.countries.every(c=>state.countries.has(c));
      z.countries.forEach(c=> allIn ? state.countries.delete(c) : state.countries.add(c));
      renderCountryList();
    });
    zoneRow.appendChild(chip);
  });

  renderCountryList();
}

function renderCountryList(){
  const list = document.getElementById("countryList");
  list.innerHTML = "";
  COUNTRIES.forEach(c=>{
    const item = document.createElement("label");
    item.className = "c-item" + (state.countries.has(c.code) ? " checked":"");
    item.innerHTML = `<input type="checkbox" ${state.countries.has(c.code)?"checked":""}> ${flagHTML(c.code)} ${c.name}`;
    item.querySelector("input").addEventListener("change", (e)=>{
      if(e.target.checked) state.countries.add(c.code); else state.countries.delete(c.code);
      item.classList.toggle("checked", e.target.checked);
      document.getElementById("countryCount").textContent = state.countries.size;
    });
    list.appendChild(item);
  });
  document.getElementById("countryCount").textContent = state.countries.size;
}

function renderNPicker(){
  const el = document.getElementById("nPicker");
  el.innerHTML = "";
  [25,50,100].forEach(n=>{
    const btn = document.createElement("button");
    btn.textContent = n;
    if(n===state.resultCount) btn.classList.add("on");
    btn.addEventListener("click", ()=>{
      state.resultCount = n;
      el.querySelectorAll("button").forEach(b=>b.classList.remove("on"));
      btn.classList.add("on");
    });
    el.appendChild(btn);
  });
}

function renderMethodology(){
  const wrap = document.getElementById("methodList");
  wrap.innerHTML = "";
  STRATEGY_ORDER.forEach(id=>{
    const s = STRATEGIES[id];
    const div = document.createElement("div");
    div.className = "method-item";
    div.innerHTML = `
      <h3>${s.name} ${s.stampReturn?`<span class="stamp"><b>${s.stampReturn}</b><span class="yrs">${s.stampYears}</span></span>`:''}</h3>
      <p>${s.description}</p>
      <ul class="rules">${s.rules.map(r=>`<li>${r}</li>`).join("")}</ul>
    `;
    wrap.appendChild(div);
  });
}

const COLS = [
  {key:"rank", label:"#", num:true},
  {key:"symbol", label:"Titre"},
  {key:"vc2Score", label:"Score", num:true},
  {key:"mom6", label:"Mom. 6M", num:true},
  {key:"mom3", label:"Mom. 3M", num:true},
  {key:"pe", label:"P/E", num:true},
  {key:"pb", label:"P/B", num:true},
  {key:"ps", label:"P/S", num:true},
  {key:"shareholderYield", label:"Rend. Act.", num:true},
  {key:"mcap", label:"Cap.", num:true},
  {key:"country", label:"Pays", num:true},
];

function renderResults(){
  const container = document.getElementById("resultsContainer");
  const title = document.getElementById("resultsTitle");
  const meta = document.getElementById("resultsMeta");
  const exportBtn = document.getElementById("exportBtn");

  if(!state.lastResults || state.lastResults.length===0){
    container.innerHTML = `<div class="empty-state"><div class="big">Aucun résultat</div>Ajustez les filtres et relancez le screening.</div>`;
    title.textContent = "Aucun résultat";
    meta.textContent = "";
    exportBtn.style.display = "none";
    return;
  }

  const strat = STRATEGIES[state.lastRunMeta.strategy];
  title.textContent = `${strat.name} — ${state.lastResults.length} entreprises`;
  const countryLabel = state.lastRunMeta.countries.map(c=>flagHTML(c)).join(" ");
  meta.innerHTML = `Échantillon analysé : ${state.lastRunMeta.poolCount} / ${state.lastRunMeta.universeCount} titres de l'univers réel · ${countryLabel} · snapshot du ${new Date(state.lastRunMeta.snapshotGeneratedAt).toLocaleString('fr-FR')}`;
  exportBtn.style.display = "inline-block";

  let rows = [...state.lastResults];
  if(state.sortCol !== "rank"){
    rows.sort((a,b)=>{
      const av = a[state.sortCol], bv = b[state.sortCol];
      if(typeof av === "string") return state.sortDir==="asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      return state.sortDir==="asc" ? (av-bv) : (bv-av);
    });
  }

  let html = `<table class="results"><thead><tr>`;
  COLS.forEach(c=>{
    html += `<th data-key="${c.key}" class="${c.num?'num ':''}${state.sortCol===c.key?'sorted':''}">${c.label}</th>`;
  });
  html += `</tr></thead><tbody>`;

  rows.forEach((s, i)=>{
    const rank = state.sortCol==="rank" ? i+1 : (state.lastResults.indexOf(s)+1);
    const cm = countryMeta(s.country);
    html += `<tr data-symbol="${s.symbol}">
      <td class="rank">${rank}</td>
      <td class="name"><span class="tkr">${cm?flagHTML(s.country)+' ':''}${s.symbol}</span><span class="cname">${s.name}</span>${s.isin?`<span class="isin">${s.isin}</span>`:''}</td>
      <td class="num"><span class="score-pill">${s.vc2Score}</span></td>
      <td class="num ${s.mom6>=0?'pos':'neg'}">${fmtMom(s.mom6)}</td>
      <td class="num ${s.mom3>=0?'pos':'neg'}">${fmtMom(s.mom3)}</td>
      <td class="num">${fmtNum(s.pe)}</td>
      <td class="num">${fmtNum(s.pb)}</td>
      <td class="num">${fmtNum(s.ps)}</td>
      <td class="num ${s.shareholderYield>=0?'pos':'neg'}">${fmtPct(s.shareholderYield)}</td>
      <td class="num">${fmtMcap(s.mcap)}</td>
      <td class="num">${cm?flagHTML(s.country)+' '+cm.code:s.country||'—'}</td>
    </tr>
    <tr class="detail-row" style="display:none" data-detail-for="${s.symbol}"><td colspan="${COLS.length}">
      <div class="detail-grid">
        <div class="detail-item"><div class="k">Secteur</div><div class="v">${s.sector}</div></div>
        <div class="detail-item"><div class="k">Bourse</div><div class="v">${s.exchange||'—'}</div></div>
        <div class="detail-item"><div class="k">Prix</div><div class="v">${fmtNum(s.price,2)}</div></div>
        <div class="detail-item"><div class="k">P/E <span class="r">rang ${s.rank_pe}</span></div><div class="v">${fmtNum(s.pe)}</div></div>
        <div class="detail-item"><div class="k">P/B <span class="r">rang ${s.rank_pb}</span></div><div class="v">${fmtNum(s.pb)}</div></div>
        <div class="detail-item"><div class="k">P/S <span class="r">rang ${s.rank_ps}</span></div><div class="v">${fmtNum(s.ps)}</div></div>
        <div class="detail-item"><div class="k">P/CF <span class="r">rang ${s.rank_pcf}</span></div><div class="v">${fmtNum(s.pcf)}</div></div>
        <div class="detail-item"><div class="k">EBITDA/EV <span class="r">rang ${s.rank_ebitdaYield}</span></div><div class="v">${s.ebitdaYield?fmtPct(s.ebitdaYield):'—'}</div></div>
        <div class="detail-item"><div class="k">Rend. actionnarial <span class="r">rang ${s.rank_shareholderYield}</span></div><div class="v">${fmtPct(s.shareholderYield)}</div></div>
        <div class="detail-item"><div class="k">— dont dividende</div><div class="v">${fmtPct(s.divYield)}</div></div>
        <div class="detail-item"><div class="k">Score composite</div><div class="v">${s.vc2Score} / 600</div></div>
        <div class="detail-item"><div class="k">Percentile composite</div><div class="v">${s.vc2Rank} / 100</div></div>
        <div class="detail-item"><div class="k">ROE</div><div class="v">${s.roe!=null?fmtPct(s.roe):'—'}</div></div>
        <div class="detail-item"><div class="k">Marge d'exploitation</div><div class="v">${s.opMargin!=null?fmtPct(s.opMargin):'—'}</div></div>
        <div class="detail-item"><div class="k">Croissance CA (12M)</div><div class="v">${s.revenueGrowth!=null?fmtPct(s.revenueGrowth):'—'}</div></div>
      </div>
      <div class="detail-note">Rangs percentiles calculés sur l'univers filtré de ${state.lastRunMeta.poolCount} entreprises. Une valeur manquante reçoit un rang neutre de 50, conformément à la méthode du livre.</div>
    </td></tr>`;
  });
  html += `</tbody></table>`;
  container.innerHTML = html;

  container.querySelectorAll("thead th").forEach(th=>{
    th.addEventListener("click", ()=>{
      const key = th.dataset.key;
      if(state.sortCol===key) state.sortDir = state.sortDir==="asc"?"desc":"asc";
      else { state.sortCol = key; state.sortDir = key==="rank"?"asc":"desc"; }
      renderResults();
    });
  });
  container.querySelectorAll("tbody tr[data-symbol]").forEach(tr=>{
    tr.addEventListener("click", ()=>{
      const sym = tr.dataset.symbol;
      const detail = container.querySelector(`tr[data-detail-for="${sym}"]`);
      if(detail) detail.style.display = detail.style.display==="none" ? "table-row" : "none";
    });
  });
}

function exportCSV(){
  if(!state.lastResults.length) return;
  const headers = ["rank","symbol","isin","name","country","sector","price","mcap","vc2Score","vc2Rank","mom3","mom6","pe","pb","ps","pcf","ebitdaYield","divYield","shareholderYield"];
  let csv = headers.join(",")+"\n";
  state.lastResults.forEach((s,i)=>{
    const row = [i+1, s.symbol, s.isin||"", `"${(s.name||"").replace(/"/g,'""')}"`, s.country, s.sector, s.price, s.mcap, s.vc2Score, s.vc2Rank, s.mom3, s.mom6, s.pe, s.pb, s.ps, s.pcf, s.ebitdaYield, s.divYield, s.shareholderYield];
    csv += row.map(v=>v===null||v===undefined?"":v).join(",")+"\n";
  });
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.strategy}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function toast(msg){
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 4200);
}

// ---------------------------------------------------------------
// init
// ---------------------------------------------------------------
function init(){
  const versionEl = document.getElementById("appVersion");
  if(versionEl) versionEl.textContent = APP_VERSION;

  renderStrategyCards();
  renderZonesAndCountries();
  renderNPicker();
  renderMethodology();

  document.getElementById("mcapFloor").addEventListener("change", (e)=>{
    state.mcapFloor = parseInt(e.target.value,10);
  });

  document.getElementById("runBtn").addEventListener("click", runScreening);
  document.getElementById("exportBtn").addEventListener("click", exportCSV);
}

document.addEventListener("DOMContentLoaded", init);
