/* ===================================================================
   LE GRAND LIVRE — app.js (v3.0 — snapshot local uniquement)
   Toute la logique d'appel API en direct (FMP, Finnhub, Wikipedia) a été
   retirée : le site lit uniquement data-snapshot.json, généré par le
   scraper Python local (dossier scraper/). Plus simple, plus rapide,
   aucune clé ni quota à gérer côté visiteur du site.
   =================================================================== */

const APP_VERSION = "v6.9.0";

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
  liquidityFloor: null, // optionnel — null = aucun filtre appliqué
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
    // Les ETF sont présents dans le snapshot (recherche, portefeuille) mais
    // n'ont pas de P/E, ROE etc. au sens où une action en a — les inclure
    // dans le calcul des stratégies n'aurait pas de sens (elles ressortiraient
    // avec des rangs neutres/faussés). Exclus ici uniquement, pas de la base.
    records = records.filter(r => r.assetType !== "etf");
    records = records.filter(r => !r.mcap || r.mcap >= state.mcapFloor);
    if(state.liquidityFloor){
      // Un titre sans donnée de liquidité n'est PAS exclu par défaut — on ne
      // veut pas punir un titre juste parce que la donnée manque, seulement
      // écarter ceux dont on SAIT qu'ils sont peu liquides.
      records = records.filter(r => r.avgDailyValue == null || r.avgDailyValue >= state.liquidityFloor);
    }

    if(records.length === 0){
      toast("Aucun titre dans le snapshot pour cette combinaison pays/capitalisation. Vérifie que le scraper a bien couvert ces pays, ou baisse le seuil de capitalisation.");
      runBtn.disabled=false; progressTxt.textContent="";
      return;
    }

    const beforeDedupe = records.length;
    records = dedupeForScreening(records);
    if(records.length < beforeDedupe){
      toast(`${beforeDedupe - records.length} cotations doublons (même entreprise, plusieurs bourses) fusionnées pour ce screening — la recherche, elle, continue de toutes les afficher.`);
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
function renderAddBtn(s){
  const held = pfIsHeld(s.symbol);
  if(held) return `<button class="add-btn added" title="Déjà dans le portefeuille" disabled>✓</button>`;
  return `<button class="add-btn" data-add-symbol="${s.symbol}" title="Ajouter au portefeuille">+</button>`;
}

function homeCountryBadge(s){
  if(!s.homeCountry) return '';
  if(s.homeCountryCode && s.homeCountryCode === s.country) return ''; // même pays, rien à signaler
  return `<span class="home-badge" title="Domicile réel : ${s.homeCountry} — coté ici sur un autre marché (ADR, cross-listing...)">🌐</span>`;
}

/**
 * Regroupe les cotations multiples d'une même entreprise (même ISIN — ex.
 * TotalEnergies coté à la fois à Paris, Francfort, Vienne, Londres...) en
 * une seule, pour que les stratégies du screener ne soient pas polluées
 * par des dizaines d'entrées quasi-identiques de la même société. Ne
 * modifie PAS les données sources : la page Recherche continue d'afficher
 * toutes les cotations telles quelles.
 *
 * Choix de la cotation "canonique" à garder, par ordre de préférence :
 * 1. Celle dont le domicile réel correspond au pays de cotation (pas de
 *    badge 🌐) — c'est la cotation principale, la plus fiable.
 * 2. À égalité, celle avec la plus grande liquidité (valeur échangée/jour).
 */
function dedupeForScreening(pool){
  const groups = {};
  pool.forEach(r=>{
    const key = r.isin || r.symbol; // repli sur le symbole si pas d'ISIN connu
    (groups[key] = groups[key] || []).push(r);
  });
  return Object.values(groups).map(group=>{
    if(group.length === 1) return group[0];
    const authentic = group.filter(r => !r.homeCountryCode || r.homeCountryCode === r.country);
    const candidates = authentic.length ? authentic : group;
    candidates.sort((a,b)=> (b.avgDailyValue||0) - (a.avgDailyValue||0));
    return candidates[0];
  });
}

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
  {key:"analystLabel", label:"Analystes", num:true},
  {key:"country", label:"Pays", num:true},
];

function analystBadgeHTML(label){
  if(!label) return '<span class="analyst-badge none">—</span>';
  const cls = label.toLowerCase().replace(' ','-'); // "Strong Buy" -> "strong-buy"
  return `<span class="analyst-badge ${cls}">${label}</span>`;
}

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
  html += `<th class="addcol"></th>`;
  html += `</tr></thead><tbody>`;

  rows.forEach((s, i)=>{
    const rank = state.sortCol==="rank" ? i+1 : (state.lastResults.indexOf(s)+1);
    const cm = countryMeta(s.country);
    const warnings = strat.warn ? strat.warn(s) : [];
    const warnBadge = warnings.length
      ? `<span class="warn-badge" title="${warnings.join(' · ').replace(/"/g,'&quot;')}">⚠</span>`
      : '';
    html += `<tr data-symbol="${s.symbol}"${warnings.length ? ' class="has-warn"' : ''}>
      <td class="rank">${rank}${warnBadge}</td>
      <td class="name"><span class="cname">${cm?flagHTML(s.country)+' ':''}${s.name}</span><span class="tkr">${s.symbol}</span>${s.isin?`<span class="isin">${s.isin}</span>`:''}</td>
      <td class="num"><span class="score-pill">${s.vc2Score}</span></td>
      <td class="num ${s.mom6>=0?'pos':'neg'}">${fmtMom(s.mom6)}</td>
      <td class="num ${s.mom3>=0?'pos':'neg'}">${fmtMom(s.mom3)}</td>
      <td class="num">${fmtNum(s.pe)}</td>
      <td class="num">${fmtNum(s.pb)}</td>
      <td class="num">${fmtNum(s.ps)}</td>
      <td class="num ${s.shareholderYield>=0?'pos':'neg'}">${fmtPct(s.shareholderYield)}</td>
      <td class="num">${fmtMcap(s.mcap)}</td>
      <td class="num">${analystBadgeHTML(s.analystLabel)}</td>
      <td class="num">${cm?flagHTML(s.country)+' '+cm.code:s.country||'—'}${homeCountryBadge(s)}</td>
      <td class="addcol">${renderAddBtn(s)}</td>
    </tr>
    <tr class="detail-row" style="display:none" data-detail-for="${s.symbol}"><td colspan="${COLS.length+1}">
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
        <div class="detail-item"><div class="k">Note des analystes</div><div class="v">${analystBadgeHTML(s.analystLabel)}</div></div>
        ${homeCountryBadge(s) ? `<div class="detail-item"><div class="k">Domicile réel</div><div class="v">${s.homeCountry} — cette cotation (${countryMeta(s.country)?countryMeta(s.country).name:s.country}) est une ADR/cross-listing, pas la cotation d'origine</div></div>` : ''}
        <div class="detail-item"><div class="k">ROE</div><div class="v">${s.roe!=null?fmtPct(s.roe):'—'}</div></div>
        <div class="detail-item"><div class="k">Marge d'exploitation</div><div class="v">${s.opMargin!=null?fmtPct(s.opMargin):'—'}</div></div>
        <div class="detail-item"><div class="k">Croissance CA (12M)</div><div class="v">${s.revenueGrowth!=null?fmtPct(s.revenueGrowth):'—'}</div></div>
        <div class="detail-item"><div class="k">Liquidité (valeur échangée/jour)</div><div class="v">${s.avgDailyValue!=null?fmtMcap(s.avgDailyValue):'—'}</div></div>
      </div>
      ${warnings.length ? `<div class="detail-warnings">⚠ ${warnings.join(' · ')}</div>` : ''}
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
    tr.addEventListener("click", (e)=>{
      if(e.target.closest(".add-btn")) return; // géré séparément ci-dessous
      const sym = tr.dataset.symbol;
      const detail = container.querySelector(`tr[data-detail-for="${sym}"]`);
      if(detail) detail.style.display = detail.style.display==="none" ? "table-row" : "none";
    });
  });
  container.querySelectorAll(".add-btn[data-add-symbol]").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.stopPropagation();
      const sym = btn.dataset.addSymbol;
      const record = state.lastResults.find(r=>r.symbol===sym);
      if(record) openAddToPortfolioModal(record);
    });
  });
}

function exportCSV(){
  if(!state.lastResults.length) return;
  const headers = ["rank","symbol","isin","name","country","sector","price","mcap","vc2Score","vc2Rank","mom3","mom6","pe","pb","ps","pcf","ebitdaYield","divYield","shareholderYield","analystLabel"];
  let csv = headers.join(",")+"\n";
  state.lastResults.forEach((s,i)=>{
    const row = [i+1, s.symbol, s.isin||"", `"${(s.name||"").replace(/"/g,'""')}"`, s.country, s.sector, s.price, s.mcap, s.vc2Score, s.vc2Rank, s.mom3, s.mom6, s.pe, s.pb, s.ps, s.pcf, s.ebitdaYield, s.divYield, s.shareholderYield, s.analystLabel||""];
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

  document.getElementById("methodToggle").addEventListener("click", ()=>{
    const list = document.getElementById("methodList");
    const chevron = document.getElementById("methodChevron");
    const isOpen = list.style.display !== "none";
    list.style.display = isOpen ? "none" : "block";
    chevron.classList.toggle("open", !isOpen);
  });

  document.getElementById("mcapFloor").addEventListener("change", (e)=>{
    state.mcapFloor = parseInt(e.target.value,10);
  });

  document.getElementById("liquidityFloor").addEventListener("change", (e)=>{
    state.liquidityFloor = e.target.value ? parseInt(e.target.value,10) : null;
  });

  document.getElementById("runBtn").addEventListener("click", runScreening);
  document.getElementById("exportBtn").addEventListener("click", exportCSV);
}

// ---------------------------------------------------------------
// Modal "Ajouter au portefeuille"
// ---------------------------------------------------------------
function openAddToPortfolioModal(record){
  const today = new Date().toISOString().slice(0,10);
  const nativeCcy = resolveListedCurrency(record);
  const hasChoice = nativeCcy !== "EUR";
  const portfolios = pfGetPortfolios();
  const activeId = pfGetActivePortfolioId();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>${record.name}</h3>
      <div class="modal-sub">${record.symbol}${record.isin?' · '+record.isin:''} — ajouter au portefeuille</div>
      ${portfolios.length > 1 ? `
      <div class="modal-field">
        <label>Portefeuille</label>
        <select id="pfTarget" style="width:100%;background:var(--paper);border:1px solid var(--hairline-bright);color:var(--ink);padding:9px 10px;border-radius:4px;font-family:'IBM Plex Mono',monospace;font-size:0.88rem;">
          ${portfolios.map(p=>`<option value="${p.id}" ${p.id===activeId?'selected':''}>${p.name}</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="modal-field">
        <label>Date d'achat</label>
        <input type="date" id="pfDate" value="${today}" max="${today}">
      </div>
      <div class="modal-field">
        <label>Nombre d'actions</label>
        <input type="number" id="pfQty" value="1" min="0" step="any">
      </div>
      <div class="modal-field">
        <label>Prix d'achat (${record.price!=null?'prix actuel du snapshot par défaut':'prix inconnu, à renseigner'})</label>
        <div style="display:flex;gap:8px;">
          <input type="number" id="pfPrice" value="${record.price!=null?record.price:''}" min="0" step="any" style="flex:1;">
          ${hasChoice ? `
          <select id="pfPriceCcy" style="width:90px;background:var(--paper);border:1px solid var(--hairline-bright);color:var(--ink);border-radius:4px;font-family:'IBM Plex Mono',monospace;font-size:0.85rem;">
            <option value="${nativeCcy}">${nativeCcy}</option>
            <option value="EUR">EUR</option>
          </select>` : `<span style="align-self:center;color:var(--ink-faint);font-family:'IBM Plex Mono',monospace;font-size:0.85rem;padding:0 6px;">EUR</span>`}
        </div>
        ${hasChoice ? `<div style="font-size:0.7rem;color:var(--ink-faint);margin-top:5px;">Choisis "EUR" si ton courtier a converti et prélevé directement en euros.${nativeCcy==='GBX'?' ⚠ GBX = pence sterling (1 £ = 100 GBX) — vérifie bien avant de saisir le prix.':''}</div>` : ''}
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" id="pfCancel">Annuler</button>
        <button class="btn-confirm" id="pfConfirm">Ajouter</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = ()=> overlay.remove();
  overlay.addEventListener("click", (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector("#pfCancel").addEventListener("click", close);
  overlay.querySelector("#pfConfirm").addEventListener("click", ()=>{
    const qty = parseFloat(overlay.querySelector("#pfQty").value);
    const price = parseFloat(overlay.querySelector("#pfPrice").value);
    const date = overlay.querySelector("#pfDate").value;
    const priceCcySel = overlay.querySelector("#pfPriceCcy");
    const priceCurrency = priceCcySel ? priceCcySel.value : "EUR";
    const targetSel = overlay.querySelector("#pfTarget");
    const targetPortfolioId = targetSel ? targetSel.value : activeId;
    if(!qty || qty<=0){ toast("Nombre d'actions invalide."); return; }
    if(!price || price<=0){ toast("Prix d'achat invalide."); return; }
    if(!date){ toast("Date invalide."); return; }
    pfAddHolding({
      symbol: record.symbol, name: record.name, country: record.country, isin: record.isin || null,
      quantity: qty, purchasePrice: price, purchaseDate: date, priceCurrency,
    }, targetPortfolioId);
    const targetName = portfolios.find(p=>p.id===targetPortfolioId)?.name || "";
    toast(`${record.name} ajouté${targetName?` à "${targetName}"`:''}.`);
    close();
    renderResults(); // rafraîchit le bouton + -> ✓
  });
}

document.addEventListener("DOMContentLoaded", init);
