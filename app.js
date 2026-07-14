/* ===================================================================
   LE GRAND LIVRE — app.js
   =================================================================== */

const FMP_BASE = "https://financialmodelingprep.com/stable";
const CACHE_TTL_FUNDAMENTALS = 24*3600*1000;   // 24h
const CACHE_TTL_SCREENER     = 6*3600*1000;    // 6h
const CACHE_KEY = "wss_cache_v1";
const APIKEY_KEY = "wss_apikey_v1";

let state = {
  strategy: "trending_value",
  countries: new Set(["US"]),
  poolSize: 20,
  resultCount: 25,
  mcapFloor: 1000000000,
  sortCol: "rank",
  sortDir: "asc",
  lastResults: [],
  lastRunMeta: null,
};

let cache = loadCache();

// ---------------------------------------------------------------
// Cache helpers (localStorage)
// ---------------------------------------------------------------
function loadCache(){
  try{
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {fund:{}, screen:{}};
  }catch(e){ return {fund:{}, screen:{}}; }
}
function saveCache(){
  try{ localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); }catch(e){/* quota exceeded, ignore */}
}
function cacheGetFund(symbol){
  const e = cache.fund[symbol];
  if(e && (Date.now()-e.ts) < CACHE_TTL_FUNDAMENTALS) return e.data;
  return null;
}
function cacheSetFund(symbol, data){
  cache.fund[symbol] = {ts:Date.now(), data};
}
function cacheGetScreen(key){
  const e = cache.screen[key];
  if(e && (Date.now()-e.ts) < CACHE_TTL_SCREENER) return e.data;
  return null;
}
function cacheSetScreen(key, data){
  cache.screen[key] = {ts:Date.now(), data};
}

// ---------------------------------------------------------------
// API key
// ---------------------------------------------------------------
function getApiKey(){ try{ return localStorage.getItem(APIKEY_KEY) || ""; }catch(e){ return ""; } }
function setApiKey(k){ try{ localStorage.setItem(APIKEY_KEY, k); }catch(e){ /* stockage indisponible */ } }

// ---------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------
let requestCount = 0;
async function fmpGet(path, params){
  const key = getApiKey();
  const url = new URL(FMP_BASE + path);
  Object.entries(params||{}).forEach(([k,v])=>url.searchParams.set(k,v));
  url.searchParams.set("apikey", key);
  requestCount++;
  const res = await fetch(url.toString());
  if(!res.ok){
    if(res.status===401 || res.status===403) throw new Error("Clé API invalide ou quota dépassé (HTTP "+res.status+")");
    throw new Error("Erreur réseau FMP (HTTP "+res.status+")");
  }
  return res.json();
}

// small concurrency-limited pool runner
async function runPool(items, limit, worker){
  const results = new Array(items.length);
  let i = 0;
  async function next(){
    while(i < items.length){
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  const runners = Array.from({length: Math.min(limit, items.length)}, next);
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------
// Screener call per country
// ---------------------------------------------------------------
async function screenCountry(country, poolSize, mcapFloor){
  const key = `${country}|${poolSize}|${mcapFloor}`;
  const cached = cacheGetScreen(key);
  if(cached) return cached;
  const data = await fmpGet("/company-screener", {
    country,
    marketCapMoreThan: mcapFloor,
    isEtf: "false",
    isFund: "false",
    isActivelyTrading: "true",
    limit: poolSize,
  });
  const list = Array.isArray(data) ? data : [];
  cacheSetScreen(key, list);
  return list;
}

// ---------------------------------------------------------------
// Fundamentals fetch per symbol (3 calls, cached 24h)
// ---------------------------------------------------------------
async function fetchFundamentals(symbol){
  const cached = cacheGetFund(symbol);
  if(cached) return cached;
  const [ratios, keyMetrics, priceChange, cashFlow] = await Promise.all([
    fmpGet("/ratios-ttm", {symbol}).catch(()=>null),
    fmpGet("/key-metrics-ttm", {symbol}).catch(()=>null),
    fmpGet("/stock-price-change", {symbol}).catch(()=>null),
    fmpGet("/cash-flow-statement-ttm", {symbol}).catch(()=>null),
  ]);
  const r = Array.isArray(ratios) ? ratios[0] : ratios;
  const km = Array.isArray(keyMetrics) ? keyMetrics[0] : keyMetrics;
  const pc = Array.isArray(priceChange) ? priceChange[0] : priceChange;
  const cf = Array.isArray(cashFlow) ? cashFlow[0] : cashFlow;
  const data = {r, km, pc, cf, fetchedAt: Date.now()};
  cacheSetFund(symbol, data);
  return data;
}

async function fetchEpsGrowth(symbol){
  const cached = cacheGetFund(symbol);
  if(cached && cached.epsGrowth !== undefined) return cached.epsGrowth;
  let val = null;
  try{
    const g = await fmpGet("/financial-growth", {symbol, limit:1});
    const row = Array.isArray(g) ? g[0] : g;
    val = pick(row, FIELD_ALIASES.epsGrowth);
  }catch(e){ val = null; }
  const existing = cache.fund[symbol] ? cache.fund[symbol].data : {};
  cacheSetFund(symbol, {...existing, epsGrowth: val});
  return val;
}

// ---------------------------------------------------------------
// Build scored pool from raw fundamentals
// ---------------------------------------------------------------
function rawToRecord(company, fund){
  const {r, km, pc, cf} = fund;
  const pbRaw = pick(r, FIELD_ALIASES.pb);
  const peRaw = pick(r, FIELD_ALIASES.pe);
  const psRaw = pick(r, FIELD_ALIASES.ps);
  const pcfRaw = pick(r, FIELD_ALIASES.pcf);
  const evMultRaw = pick(km, FIELD_ALIASES.evEbitda) ?? pick(r, FIELD_ALIASES.evEbitda);
  const divYieldRaw = pick(r, FIELD_ALIASES.divYield) ?? 0;
  const mcap = company.marketCap ?? pick(km, FIELD_ALIASES.mcap) ?? 0;
  const buybackRaw = pick(cf, FIELD_ALIASES.buyback); // negative = cash spent buying back
  const buybackYield = (buybackRaw!==null && mcap>0) ? Math.max(0, -buybackRaw)/mcap : 0;

  return {
    symbol: company.symbol,
    name: company.companyName || company.symbol,
    country: company.country,
    sector: company.sector || "—",
    exchange: company.exchangeShortName || company.exchange || "—",
    price: company.price ?? null,
    mcap: mcap,
    // raw ratios, cleaned: non-positive treated as missing for "lower better" ratios
    pb: (pbRaw!==null && pbRaw>0) ? pbRaw : null,
    pe: (peRaw!==null && peRaw>0) ? peRaw : null,
    ps: (psRaw!==null && psRaw>0) ? psRaw : null,
    pcf: (pcfRaw!==null && pcfRaw>0) ? pcfRaw : null,
    ebitdaYield: (evMultRaw!==null && evMultRaw>0) ? (1/evMultRaw) : null,
    divYield: divYieldRaw,
    shareholderYield: divYieldRaw + buybackYield,
    mom3: pc ? (pc["3M"] ?? 0) : 0,
    mom6: pc ? (pc["6M"] ?? 0) : 0,
    epsGrowth: null, // rempli à la demande pour la stratégie growth
  };
}

function percentileRank(value, sortedAsc, betterWhenLower){
  if(value===null || value===undefined) return 50;
  const n = sortedAsc.length;
  if(n<=1) return 50;
  // position via recherche binaire simple (doublons -> première occurrence)
  let idx = sortedAsc.indexOf(value);
  if(idx===-1){
    // valeur pas dans le tableau (ne devrait pas arriver) — approx par comptage
    idx = sortedAsc.filter(v=>v<value).length;
  }
  const pct = idx/(n-1);
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
// Budget estimation
// ---------------------------------------------------------------
function estimateBudget(){
  const nCountries = state.countries.size;
  const perCandidate = 4; // ratios-ttm, key-metrics-ttm, stock-price-change, cash-flow-statement-ttm
  let total = nCountries*1 + nCountries*state.poolSize*perCandidate;
  if(state.strategy === "all_stocks_growth") total += nCountries*state.poolSize*1;
  return total;
}

function updateBudgetUI(){
  const n = estimateBudget();
  document.getElementById("budgetNum").textContent = n;
  const bar = document.getElementById("budgetBar");
  const warn = document.getElementById("budgetWarn");
  if(n>250){
    bar.classList.add("over");
    warn.textContent = "⚠ dépasse le quota gratuit quotidien — réduisez le nombre de pays ou la profondeur";
  }else{
    bar.classList.remove("over");
    warn.textContent = "";
  }
}

// ---------------------------------------------------------------
// Main run
// ---------------------------------------------------------------
async function runScreening(){
  const apiKey = document.getElementById("apiKey").value.trim() || getApiKey();
  if(!apiKey){
    toast("Entrez d'abord votre clé API Financial Modeling Prep (section « Clé API »).");
    return;
  }
  setApiKey(apiKey);
  updateKeyStatus();

  const runBtn = document.getElementById("runBtn");
  runBtn.disabled = true;
  const progressTxt = document.getElementById("progressTxt");
  requestCount = 0;

  try{
    const countries = [...state.countries];
    if(countries.length===0){ toast("Sélectionnez au moins un pays."); runBtn.disabled=false; return; }

    progressTxt.textContent = "Criblage des marchés sélectionnés…";
    const screenLists = await Promise.all(countries.map(c=>
      screenCountry(c, state.poolSize, state.mcapFloor).catch(err=>{
        toast(`Échec du criblage pour ${countryMeta(c)?.name||c} : ${err.message}`);
        return [];
      })
    ));
    let candidates = [];
    screenLists.forEach(list=>candidates.push(...list));
    // dédoublonnage
    const seen = new Set();
    candidates = candidates.filter(c=>{
      if(!c.symbol || seen.has(c.symbol)) return false;
      seen.add(c.symbol); return true;
    });

    if(candidates.length===0){
      toast("Aucune entreprise trouvée pour ces filtres. Essayez d'abaisser la capitalisation minimum.");
      runBtn.disabled=false; progressTxt.textContent="";
      return;
    }

    progressTxt.textContent = `Récupération des fondamentaux — 0/${candidates.length}`;
    let done = 0;
    const funds = await runPool(candidates, 6, async (c)=>{
      const f = await fetchFundamentals(c.symbol).catch(()=>({r:null,km:null,pc:null,cf:null}));
      done++;
      progressTxt.textContent = `Récupération des fondamentaux — ${done}/${candidates.length}`;
      return f;
    });

    let records = candidates.map((c,i)=>rawToRecord(c, funds[i]));

    if(state.strategy === "all_stocks_growth"){
      progressTxt.textContent = "Récupération de la croissance des bénéfices…";
      const growths = await runPool(candidates, 6, (c)=>fetchEpsGrowth(c.symbol).catch(()=>null));
      records.forEach((rec,i)=>{ rec.epsGrowth = growths[i]; });
    }

    saveCache();

    records = scorePool(records);
    const strat = STRATEGIES[state.strategy];
    const selected = strat.select(records, state.resultCount);

    state.lastResults = selected;
    state.lastRunMeta = {
      strategy: state.strategy,
      poolCount: records.length,
      countries: countries,
      ts: Date.now(),
    };
    state.sortCol = "rank"; state.sortDir = "asc";
    renderResults();
    const anchor = document.getElementById("results-anchor");
    if(anchor && anchor.scrollIntoView) anchor.scrollIntoView({behavior:"smooth", block:"start"});
    progressTxt.textContent = `Terminé — ${requestCount} requêtes API utilisées.`;
  }catch(err){
    console.error(err);
    toast("Erreur : " + err.message);
    progressTxt.textContent = "";
  }finally{
    runBtn.disabled = false;
  }
}

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------
// fmtPct : pour les ratios exprimés en fraction par l'API (ex. dividendYieldTTM = 0.0065 => 0,65%)
function fmtPct(v){ return (v===null||v===undefined) ? "—" : (v*100>=0?"+":"")+(v*100).toFixed(1)+"%"; }
// fmtMom : le endpoint stock-price-change de FMP renvoie déjà des pourcentages (ex. 5.23 => 5,23%), pas des fractions
function fmtMom(v){ return (v===null||v===undefined) ? "—" : (v>=0?"+":"")+v.toFixed(1)+"%"; }
function fmtNum(v, d=1){ return (v===null||v===undefined) ? "—" : v.toFixed(d); }
function fmtMcap(v){
  if(!v) return "—";
  if(v>=1e12) return (v/1e12).toFixed(2)+"T";
  if(v>=1e9) return (v/1e9).toFixed(2)+"Md";
  if(v>=1e6) return (v/1e6).toFixed(0)+"M";
  return v.toString();
}

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
      <div class="stamp"><b>${s.stampReturn}</b><span class="yrs">${s.stampYears}</span></div>
    `;
    card.addEventListener("click", ()=>{
      state.strategy = id;
      document.querySelectorAll(".strategy-card").forEach(el=>el.classList.remove("active"));
      card.classList.add("active");
      updateBudgetUI();
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
      updateBudgetUI();
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
    item.innerHTML = `<input type="checkbox" ${state.countries.has(c.code)?"checked":""}> ${c.flag} ${c.name}`;
    item.querySelector("input").addEventListener("change", (e)=>{
      if(e.target.checked) state.countries.add(c.code); else state.countries.delete(c.code);
      item.classList.toggle("checked", e.target.checked);
      document.getElementById("countryCount").textContent = state.countries.size;
      updateBudgetUI();
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
      <h3>${s.name} <span class="stamp"><b>${s.stampReturn}</b><span class="yrs">${s.stampYears}</span></span></h3>
      <p>${s.description}</p>
      <ul class="rules">${s.rules.map(r=>`<li>${r}</li>`).join("")}</ul>
    `;
    wrap.appendChild(div);
  });
}

const COLS = [
  {key:"rank", label:"#"},
  {key:"symbol", label:"Titre"},
  {key:"vc2Score", label:"Score"},
  {key:"mom6", label:"Mom. 6M"},
  {key:"mom3", label:"Mom. 3M"},
  {key:"pe", label:"P/E"},
  {key:"pb", label:"P/B"},
  {key:"ps", label:"P/S"},
  {key:"shareholderYield", label:"Rend. Act."},
  {key:"mcap", label:"Cap."},
  {key:"country", label:"Pays"},
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
  const countryLabel = state.lastRunMeta.countries.map(c=>countryMeta(c)?.flag).join(" ");
  meta.textContent = `Univers criblé : ${state.lastRunMeta.poolCount} entreprises · ${countryLabel} · ${new Date(state.lastRunMeta.ts).toLocaleString('fr-FR')}`;
  exportBtn.style.display = "inline-block";

  let rows = [...state.lastResults];
  // apply sort
  if(state.sortCol !== "rank"){
    rows.sort((a,b)=>{
      const av = a[state.sortCol], bv = b[state.sortCol];
      if(typeof av === "string") return state.sortDir==="asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      return state.sortDir==="asc" ? (av-bv) : (bv-av);
    });
  }

  let html = `<table class="results"><thead><tr>`;
  COLS.forEach(c=>{
    html += `<th data-key="${c.key}" class="${state.sortCol===c.key?'sorted':''}">${c.label}</th>`;
  });
  html += `</tr></thead><tbody>`;

  rows.forEach((s, i)=>{
    const rank = state.sortCol==="rank" ? i+1 : (state.lastResults.indexOf(s)+1);
    const cm = countryMeta(s.country);
    html += `<tr data-symbol="${s.symbol}">
      <td class="rank">${rank}</td>
      <td class="name"><span class="tkr">${cm?cm.flag+' ':''}${s.symbol}</span><span class="cname">${s.name}</span></td>
      <td class="num"><span class="score-pill">${s.vc2Score}</span></td>
      <td class="num ${s.mom6>=0?'pos':'neg'}">${fmtMom(s.mom6)}</td>
      <td class="num ${s.mom3>=0?'pos':'neg'}">${fmtMom(s.mom3)}</td>
      <td class="num">${fmtNum(s.pe)}</td>
      <td class="num">${fmtNum(s.pb)}</td>
      <td class="num">${fmtNum(s.ps)}</td>
      <td class="num ${s.shareholderYield>=0?'pos':'neg'}">${fmtPct(s.shareholderYield)}</td>
      <td class="num">${fmtMcap(s.mcap)}</td>
      <td class="num">${cm?cm.flag:s.country||'—'}</td>
    </tr>
    <tr class="detail-row" style="display:none" data-detail-for="${s.symbol}"><td colspan="${COLS.length}">
      <div class="detail-grid">
        <div class="detail-item"><div class="k">Secteur</div><div class="v">${s.sector}</div></div>
        <div class="detail-item"><div class="k">Bourse</div><div class="v">${s.exchange}</div></div>
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
      </div>
      <div class="detail-note">Rangs percentiles calculés sur l'univers criblé de ${state.lastRunMeta.poolCount} entreprises (pas l'ensemble du marché mondial). Une valeur manquante reçoit un rang neutre de 50, conformément à la méthode du livre.</div>
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
  const headers = ["rank","symbol","name","country","sector","price","mcap","vc2Score","vc2Rank","mom3","mom6","pe","pb","ps","pcf","ebitdaYield","divYield","shareholderYield"];
  let csv = headers.join(",")+"\n";
  state.lastResults.forEach((s,i)=>{
    const row = [i+1, s.symbol, `"${(s.name||"").replace(/"/g,'""')}"`, s.country, s.sector, s.price, s.mcap, s.vc2Score, s.vc2Rank, s.mom3, s.mom6, s.pe, s.pb, s.ps, s.pcf, s.ebitdaYield, s.divYield, s.shareholderYield];
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

// ---------------------------------------------------------------
// misc UI
// ---------------------------------------------------------------
function toast(msg){
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 4200);
}

function updateKeyStatus(){
  const k = getApiKey();
  document.getElementById("keyDot").classList.toggle("ok", !!k);
  document.getElementById("keyStatusTxt").textContent = k ? "Clé enregistrée localement" : "Aucune clé enregistrée";
}

// ---------------------------------------------------------------
// init
// ---------------------------------------------------------------
function init(){
  renderStrategyCards();
  renderZonesAndCountries();
  renderNPicker();
  renderMethodology();
  updateBudgetUI();

  const savedKey = getApiKey();
  if(savedKey) document.getElementById("apiKey").value = savedKey;
  updateKeyStatus();

  document.getElementById("apiKey").addEventListener("change", (e)=>{
    setApiKey(e.target.value.trim());
    updateKeyStatus();
  });

  document.getElementById("poolSize").addEventListener("input", (e)=>{
    state.poolSize = parseInt(e.target.value,10);
    document.getElementById("poolVal").textContent = state.poolSize;
    updateBudgetUI();
  });
  document.getElementById("poolVal").textContent = state.poolSize;
  document.getElementById("poolSize").value = state.poolSize;

  document.getElementById("mcapFloor").addEventListener("change", (e)=>{
    state.mcapFloor = parseInt(e.target.value,10);
  });

  document.getElementById("runBtn").addEventListener("click", runScreening);
  document.getElementById("exportBtn").addEventListener("click", exportCSV);
  document.getElementById("clearCacheBtn").addEventListener("click", ()=>{
    cache = {fund:{}, screen:{}};
    saveCache();
    toast("Cache local vidé.");
  });
}

document.addEventListener("DOMContentLoaded", init);
