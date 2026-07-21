/* ===================================================================
   LE GRAND LIVRE — app.js
   =================================================================== */

const APP_VERSION = "v2.2.1";

const FMP_BASE = "https://financialmodelingprep.com/stable";

// Aucun fetch() ne doit pouvoir bloquer indéfiniment (réseau mobile instable,
// proxy qui ne répond jamais, etc.) — on force un délai maximum partout.
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
const CACHE_TTL_FUNDAMENTALS = 24*3600*1000;   // 24h
const CACHE_TTL_SCREENER     = 6*3600*1000;    // 6h
const CACHE_KEY = "wss_cache_v1";
const APIKEY_KEY = "wss_apikey_v1";
const FINNHUB_KEY_KEY = "wss_finnhub_key_v1";

let state = {
  strategy: "trending_value",
  countries: new Set(["US"]),
  poolSize: 20,
  resultCount: 25,
  mcapFloor: 1000000000,
  dataSource: "snapshot", // "snapshot" | "fmp" | "finnhub"
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
    const parsed = raw ? JSON.parse(raw) : {};
    return {fund: parsed.fund||{}, screen: parsed.screen||{}, index: parsed.index||{}};
  }catch(e){ return {fund:{}, screen:{}, index:{}}; }
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
function getFinnhubKey(){ try{ return localStorage.getItem(FINNHUB_KEY_KEY) || ""; }catch(e){ return ""; } }
function setFinnhubKey(k){ try{ localStorage.setItem(FINNHUB_KEY_KEY, k); }catch(e){ /* stockage indisponible */ } }

// ---------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------
let requestCount = 0;
let quotaErrorCount = 0;
async function fmpGet(path, params){
  const key = getApiKey();
  const url = new URL(FMP_BASE + path);
  Object.entries(params||{}).forEach(([k,v])=>url.searchParams.set(k,v));
  url.searchParams.set("apikey", key);
  requestCount++;
  const res = await fetchWithTimeout(url.toString(), undefined, 15000);
  if(!res.ok){
    if(res.status===401 || res.status===403) throw new Error("Clé API invalide ou quota dépassé (HTTP "+res.status+")");
    throw new Error("Erreur réseau FMP (HTTP "+res.status+")");
  }
  const data = await res.json();
  // FMP renvoie parfois un statut 200 avec un objet d'erreur au lieu du tableau attendu
  // (quota journalier dépassé, endpoint restreint, symbole invalide...)
  if(data && !Array.isArray(data) && (data["Error Message"] || data.error || data.message)){
    const msg = data["Error Message"] || data.error || data.message;
    if(/limit reach/i.test(msg)) quotaErrorCount++;
    throw new Error(msg);
  }
  return data;
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
// Univers dynamique via Wikipedia (composition réelle des indices)
// ---------------------------------------------------------------
const CACHE_TTL_INDEX = 30*24*3600*1000; // 30 jours — la composition d'un indice change rarement

function cacheGetIndex(country){
  const e = cache.index && cache.index[country];
  if(e && (Date.now()-e.ts) < CACHE_TTL_INDEX) return e.data;
  return null;
}
function cacheSetIndex(country, data){
  if(!cache.index) cache.index = {};
  cache.index[country] = {ts:Date.now(), data};
}

function cleanCell(text){
  return (text||"").replace(/\[\d+\]/g, "").replace(/^[A-Za-z]{2,6}:\s*/, "").trim();
}

function pickColumn(headerCells, patterns){
  for(let i=0;i<headerCells.length;i++){
    const t = headerCells[i].toLowerCase();
    if(patterns.some(p=>t.includes(p))) return i;
  }
  return -1;
}

// Parse le HTML rendu d'une page Wikipedia et en extrait la table de composants
function parseConstituentsHTML(html, suffix){
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tables = [...doc.querySelectorAll("table.wikitable")];
  let best = null;

  tables.forEach(table=>{
    const headerRow = table.querySelector("tr");
    if(!headerRow) return;
    const headers = [...headerRow.querySelectorAll("th,td")].map(c=>c.textContent.trim().toLowerCase());
    const tickerCol = pickColumn(headers, ["symbol","ticker","code","epic"]);
    const nameCol = pickColumn(headers, ["security","company","name"]);
    if(tickerCol===-1) return;
    const sectorCol = pickColumn(headers, ["sector","industry"]);

    const rows = [...table.querySelectorAll("tr")].slice(1);
    const parsed = rows.map(row=>{
      const cells = [...row.querySelectorAll("td,th")];
      if(cells.length <= tickerCol) return null;
      let symbol = cleanCell(cells[tickerCol].textContent);
      if(!symbol) return null;
      // évite de re-suffixer si la cellule contient déjà un point (rare mais possible)
      if(suffix && !symbol.includes(".")) symbol = symbol + suffix;
      const name = nameCol!==-1 && cells[nameCol] ? cleanCell(cells[nameCol].textContent) : symbol;
      const sector = sectorCol!==-1 && cells[sectorCol] ? cleanCell(cells[sectorCol].textContent) : "—";
      return {symbol, name, sector};
    }).filter(Boolean);

    if(!best || parsed.length > best.length) best = parsed;
  });

  return best || [];
}

async function fetchIndexConstituents(country){
  const cached = cacheGetIndex(country);
  if(cached) return cached;
  const src = INDEX_SOURCES[country];
  if(!src) return [];
  const url = "https://en.wikipedia.org/w/api.php?" + new URLSearchParams({
    action: "parse", page: src.page, prop: "text", format: "json", formatversion: "2", redirects: "1", origin: "*",
  });
  const res = await fetchWithTimeout(url, undefined, 15000);
  if(!res.ok) throw new Error("Wikipedia HTTP " + res.status);
  const data = await res.json();
  if(data.error) throw new Error("Wikipedia : " + (data.error.info || data.error.code));
  const html = data.parse && data.parse.text;
  if(!html) throw new Error("Page Wikipedia vide ou introuvable (" + src.page + ")");
  const list = parseConstituentsHTML(html, src.suffix);
  if(list.length === 0) throw new Error("Impossible d'extraire la table de composants pour " + src.indexName);
  cacheSetIndex(country, list);
  return list;
}

// Échantillonne poolSize candidats en priorisant les titres jamais/rarement récupérés
// (progressive coverage : chaque run explore de nouveaux titres jusqu'à couvrir tout l'indice)
function sampleCandidates(fullList, n){
  const now = Date.now();
  const prefix = state.dataSource === "finnhub" ? "finnhub:" : "fmp:";
  const withAge = fullList.map(item=>{
    const cached = cacheGetFund(prefix + item.symbol);
    const age = cached ? (now - cached.fetchedAt) : Infinity;
    return {...item, _age: age};
  });
  withAge.sort((a,b)=> b._age - a._age);
  return withAge.slice(0, n);
}

// ---------------------------------------------------------------
// Source de données FMP — normalise vers le format commun
// ---------------------------------------------------------------
async function fetchFundamentalsFMP(symbol){
  const cached = cacheGetFund("fmp:"+symbol);
  if(cached) return cached;
  const [quote, ratios, keyMetrics, priceChange, cashFlow] = await Promise.all([
    fmpGet("/quote", {symbol}).catch(()=>null),
    fmpGet("/ratios-ttm", {symbol}).catch(()=>null),
    fmpGet("/key-metrics-ttm", {symbol}).catch(()=>null),
    fmpGet("/stock-price-change", {symbol}).catch(()=>null),
    fmpGet("/cash-flow-statement-ttm", {symbol}).catch(()=>null),
  ]);
  const q = Array.isArray(quote) ? quote[0] : quote;
  const r = Array.isArray(ratios) ? ratios[0] : ratios;
  const km = Array.isArray(keyMetrics) ? keyMetrics[0] : keyMetrics;
  const pc = Array.isArray(priceChange) ? priceChange[0] : priceChange;
  const cf = Array.isArray(cashFlow) ? cashFlow[0] : cashFlow;

  const pbRaw = pick(r, FIELD_ALIASES.pb);
  const peRaw = pick(r, FIELD_ALIASES.pe);
  const psRaw = pick(r, FIELD_ALIASES.ps);
  const pcfRaw = pick(r, FIELD_ALIASES.pcf);
  const evMultRaw = pick(km, FIELD_ALIASES.evEbitda) ?? pick(r, FIELD_ALIASES.evEbitda);
  const divYieldRaw = pick(r, FIELD_ALIASES.divYield) ?? 0;
  const mcap = pick(q, FIELD_ALIASES.mcap) ?? pick(km, FIELD_ALIASES.mcap) ?? 0;
  const buybackRaw = pick(cf, FIELD_ALIASES.buyback); // négatif = cash dépensé en rachats
  const buybackYield = (buybackRaw!==null && mcap>0) ? Math.max(0, -buybackRaw)/mcap : 0;

  const data = {
    price: (q && q.price) ?? null,
    exchange: (q && q.exchange) || "—",
    mcap,
    pb: (pbRaw!==null && pbRaw>0) ? pbRaw : null,
    pe: (peRaw!==null && peRaw>0) ? peRaw : null,
    ps: (psRaw!==null && psRaw>0) ? psRaw : null,
    pcf: (pcfRaw!==null && pcfRaw>0) ? pcfRaw : null,
    ebitdaYield: (evMultRaw!==null && evMultRaw>0) ? (1/evMultRaw) : null,
    divYield: divYieldRaw,
    shareholderYield: divYieldRaw + buybackYield,
    mom3: pc ? (pc["3M"] ?? 0) : 0,
    mom6: pc ? (pc["6M"] ?? 0) : 0,
    epsGrowth: null,
    source: "fmp",
    fetchedAt: Date.now(),
  };
  cacheSetFund("fmp:"+symbol, data);
  return data;
}

async function fetchEpsGrowthFMP(symbol){
  const key = "fmp:"+symbol;
  const cached = cacheGetFund(key);
  if(cached && cached.epsGrowth !== undefined && cached.epsGrowth !== null) return cached.epsGrowth;
  let val = null;
  try{
    const g = await fmpGet("/financial-growth", {symbol, limit:1});
    const row = Array.isArray(g) ? g[0] : g;
    val = pick(row, FIELD_ALIASES.epsGrowth);
  }catch(e){ val = null; }
  const existing = cache.fund[key] ? cache.fund[key].data : {};
  cacheSetFund(key, {...existing, epsGrowth: val});
  return val;
}

// ---------------------------------------------------------------
// Source de données Finnhub (secours gratuit) — 60 requêtes/minute,
// CORS géré nativement par Finnhub (pas de proxy nécessaire, contrairement
// à Yahoo Finance qui exige depuis 2023 un cookie de session + "crumb"
// anti-scraping impossible à obtenir de façon fiable depuis un navigateur
// sans backend — Yahoo a donc été abandonné comme source).
// ---------------------------------------------------------------
const FINNHUB_BASE = "https://finnhub.io/api/v1";

let finnhubAccessErrorCount = 0;
async function finnhubGet(path, params){
  const key = getFinnhubKey();
  const url = new URL(FINNHUB_BASE + path);
  Object.entries(params||{}).forEach(([k,v])=>url.searchParams.set(k,v));
  url.searchParams.set("token", key);
  requestCount++;
  const res = await fetchWithTimeout(url.toString(), undefined, 12000);
  if(!res.ok){
    if(res.status===429){ quotaErrorCount++; throw new Error("Quota Finnhub dépassé (HTTP 429)"); }
    let body = null;
    try{ body = await res.json(); }catch(e){ /* pas de JSON, tant pis */ }
    if(res.status===403 && body && /don.t have access/i.test(body.error || "")){
      finnhubAccessErrorCount++;
      throw new Error("Marché non couvert par le plan gratuit Finnhub (accès refusé)");
    }
    if(res.status===401 || res.status===403) throw new Error("Clé Finnhub invalide (HTTP "+res.status+")");
    throw new Error("Erreur réseau Finnhub (HTTP "+res.status+")");
  }
  return res.json();
}

async function fetchFundamentalsFinnhub(symbol){
  const cached = cacheGetFund("finnhub:"+symbol);
  if(cached) return cached;

  // Finnhub attend le ticker "nu" (sans suffixe .PA/.DE/.T/.TO/.L/.SW/.AS ajouté
  // pour Wikipedia/FMP) pour la plupart des grandes bourses US ; pour les bourses
  // internationales il utilise ses propres conventions (souvent SYMBOLE.BOURSE,
  // ex. MC.PA fonctionne aussi chez Finnhub pour Euronext Paris).
  const [metricRes, quoteRes] = await Promise.all([
    finnhubGet("/stock/metric", {symbol, metric:"all"}).catch(()=>null),
    finnhubGet("/quote", {symbol}).catch(()=>null),
  ]);

  const m = (metricRes && metricRes.metric) || {};

  const peRaw = pick(m, FINNHUB_ALIASES.pe);
  const pbRaw = pick(m, FINNHUB_ALIASES.pb);
  const psRaw = pick(m, FINNHUB_ALIASES.ps);
  const pcfRaw = pick(m, FINNHUB_ALIASES.pcf);
  const evMultRaw = pick(m, FINNHUB_ALIASES.evEbitda);
  const divYieldPct = pick(m, FINNHUB_ALIASES.divYield); // Finnhub exprime en % (ex. 0.65 = 0,65%), pas en fraction
  const mcapM = pick(m, FINNHUB_ALIASES.mcap); // en millions
  const mom3Raw = pick(m, FINNHUB_ALIASES.mom3); // déjà en %
  const mom6Raw = pick(m, FINNHUB_ALIASES.mom6); // déjà en %
  const epsGrowthPct = pick(m, FINNHUB_ALIASES.epsGrowth);

  const mcap = (mcapM!==null) ? mcapM*1e6 : 0;
  const divYield = (divYieldPct!==null) ? divYieldPct/100 : 0; // uniformisé en fraction comme FMP

  const data = {
    price: (quoteRes && typeof quoteRes.c === "number" && quoteRes.c>0) ? quoteRes.c : null,
    exchange: "—", // pas dispo sur /stock/metric ; non critique pour le scoring
    mcap,
    pb: (pbRaw!==null && pbRaw>0) ? pbRaw : null,
    pe: (peRaw!==null && peRaw>0) ? peRaw : null,
    ps: (psRaw!==null && psRaw>0) ? psRaw : null,
    pcf: (pcfRaw!==null && pcfRaw>0) ? pcfRaw : null,
    ebitdaYield: (evMultRaw!==null && evMultRaw>0) ? (1/evMultRaw) : null,
    divYield,
    // pas de champ "rachats d'actions" fiable en accès gratuit Finnhub :
    // rendement actionnarial ramené au seul dividende pour cette source (limite documentée)
    shareholderYield: divYield,
    mom3: mom3Raw ?? 0,
    mom6: mom6Raw ?? 0,
    epsGrowth: (epsGrowthPct!==null) ? epsGrowthPct/100 : null,
    source: "finnhub",
    fetchedAt: Date.now(),
  };
  cacheSetFund("finnhub:"+symbol, data);
  return data;
}

// ---------------------------------------------------------------
// Dispatch source-agnostique
// ---------------------------------------------------------------
async function fetchFundamentals(symbol){
  return state.dataSource === "finnhub" ? fetchFundamentalsFinnhub(symbol) : fetchFundamentalsFMP(symbol);
}

async function fetchEpsGrowth(symbol){
  if(state.dataSource === "finnhub"){
    // déjà récupéré dans fetchFundamentalsFinnhub (metric.epsGrowth*)
    const cached = cacheGetFund("finnhub:"+symbol);
    return cached ? cached.epsGrowth : null;
  }
  return fetchEpsGrowthFMP(symbol);
}

// ---------------------------------------------------------------
// Build scored pool from normalized fundamentals
// ---------------------------------------------------------------
function rawToRecord(company, fund){
  return {
    symbol: company.symbol,
    name: company.name || company.symbol,
    country: company.country,
    sector: company.sector || "—",
    exchange: fund.exchange || "—",
    price: fund.price,
    mcap: fund.mcap || 0,
    pb: fund.pb, pe: fund.pe, ps: fund.ps, pcf: fund.pcf,
    ebitdaYield: fund.ebitdaYield,
    divYield: fund.divYield || 0,
    shareholderYield: fund.shareholderYield || 0,
    mom3: fund.mom3 || 0,
    mom6: fund.mom6 || 0,
    epsGrowth: fund.epsGrowth ?? null,
    dataSource: fund.source || state.dataSource,
  };
}

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
// Budget estimation (les appels Wikipedia sont hors quota FMP)
// ---------------------------------------------------------------
function estimateBudget(){
  const nCountries = state.countries.size;
  const perCandidate = 5; // quote/price, ratios, key-metrics, momentum, cash-flow — pareil sur les 2 sources
  let total = nCountries*state.poolSize*perCandidate;
  if(state.strategy === "all_stocks_growth" && state.dataSource==="fmp") total += nCountries*state.poolSize*1;
  return total;
}

function updateBudgetUI(){
  const bar = document.getElementById("budgetBar");
  const warn = document.getElementById("budgetWarn");
  if(state.dataSource === "snapshot"){
    document.getElementById("budgetNum").textContent = "—";
    bar.classList.remove("over");
    warn.textContent = snapshotCache
      ? `Snapshot chargé (généré le ${new Date(snapshotCache.generatedAt).toLocaleString('fr-FR')}) — ${snapshotCache.count} titres, aucun appel réseau au lancement.`
      : "Snapshot pas encore chargé — sera lu au premier lancement, aucun quota.";
    return;
  }
  if(state.dataSource === "finnhub"){
    document.getElementById("budgetNum").textContent = "—";
    bar.classList.remove("over");
    warn.textContent = "Finnhub : 60 requêtes/minute (clé gratuite distincte de FMP), pas de quota journalier fixe.";
    return;
  }
  const n = estimateBudget();
  document.getElementById("budgetNum").textContent = n;
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

async function runScreeningFromSnapshot(){
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
      dataSource: "snapshot",
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

async function runScreening(){
  if(state.dataSource === "snapshot"){
    return runScreeningFromSnapshot();
  }
  if(state.dataSource === "fmp"){
    const apiKey = document.getElementById("apiKey").value.trim() || getApiKey();
    if(!apiKey){
      toast("Entrez d'abord votre clé API Financial Modeling Prep, ou passez sur la source Finnhub (réglages avancés).");
      return;
    }
    setApiKey(apiKey);
    updateKeyStatus();
  }else if(state.dataSource === "finnhub"){
    const fhKey = document.getElementById("finnhubKey").value.trim() || getFinnhubKey();
    if(!fhKey){
      toast("Entrez d'abord ta clé API Finnhub (gratuite sur finnhub.io/register), dans les réglages avancés.");
      return;
    }
    setFinnhubKey(fhKey);
  }

  const runBtn = document.getElementById("runBtn");
  runBtn.disabled = true;
  const progressTxt = document.getElementById("progressTxt");
  requestCount = 0;
  quotaErrorCount = 0;
  finnhubAccessErrorCount = 0;

  try{
    const countries = [...state.countries];
    if(countries.length===0){ toast("Sélectionnez au moins un pays."); runBtn.disabled=false; return; }

    progressTxt.textContent = "Récupération de la composition réelle des indices (Wikipedia)…";
    const indexLists = await Promise.all(countries.map(c=>
      fetchIndexConstituents(c).catch(err=>{
        toast(`Échec de récupération de l'indice pour ${countryMeta(c)?.name||c} : ${err.message}`);
        return [];
      })
    ));

    let candidates = [];
    countries.forEach((c,i)=>{
      const full = indexLists[i];
      const sample = sampleCandidates(full, state.poolSize).map(s=>({...s, country:c}));
      candidates.push(...sample);
    });

    // dédoublonnage
    const seen = new Set();
    candidates = candidates.filter(c=>{
      if(!c.symbol || seen.has(c.symbol)) return false;
      seen.add(c.symbol); return true;
    });

    if(candidates.length===0){
      toast("Aucun titre récupéré. Vérifiez la connexion à Wikipedia ou réessayez.");
      runBtn.disabled=false; progressTxt.textContent="";
      return;
    }

    progressTxt.textContent = `Récupération des fondamentaux — 0/${candidates.length}`;
    let done = 0;
    const concurrency = 6;
    const emptyFund = {price:null, exchange:"—", mcap:0, pb:null, pe:null, ps:null, pcf:null, ebitdaYield:null, divYield:0, shareholderYield:0, mom3:0, mom6:0, epsGrowth:null};
    const funds = await runPool(candidates, concurrency, async (c)=>{
      const f = await fetchFundamentals(c.symbol).catch(()=>emptyFund);
      done++;
      progressTxt.textContent = `Récupération des fondamentaux — ${done}/${candidates.length}`;
      return f;
    });

    let records = candidates.map((c,i)=>rawToRecord(c, funds[i]));

    // filtre capitalisation minimum (appliqué côté client, après récupération des cotations)
    records = records.filter(r => r.mcap===0 || r.mcap >= state.mcapFloor);

    if(state.strategy === "all_stocks_growth"){
      progressTxt.textContent = "Récupération de la croissance des bénéfices…";
      const growths = await runPool(records, concurrency, (c)=>fetchEpsGrowth(c.symbol).catch(()=>null));
      records.forEach((rec,i)=>{ rec.epsGrowth = growths[i]; });
    }

    saveCache();

    if(records.length===0){
      toast("Aucun titre ne passe le filtre de capitalisation minimum sur cet échantillon. Réessayez ou abaissez le seuil.");
      runBtn.disabled=false; progressTxt.textContent="";
      return;
    }

    // Diagnostic qualité des données : si presque aucun candidat n'a de ratio exploitable,
    // le classement serait vide ou trompeur (tout le monde à égalité au rang neutre 50).
    const withData = records.filter(r => r.pb!==null || r.pe!==null || r.ps!==null || r.pcf!==null || r.ebitdaYield!==null || r.divYield>0);
    if(withData.length === 0){
      if(state.dataSource === "fmp" && quotaErrorCount > records.length){
        toast(`Quota FMP journalier dépassé (${quotaErrorCount} appels rejetés sur ${requestCount}). Le quota gratuit (250/jour) se réinitialise le lendemain — réessaie demain, réduis l'échantillon, ou passe sur la source Finnhub (réglages avancés).`);
      }else if(state.dataSource === "finnhub" && finnhubAccessErrorCount > records.length/2){
        toast(`Finnhub bloque l'accès à ce marché sur le plan gratuit (couverture limitée aux bourses américaines). Reste sur FMP pour les titres internationaux, ou limite Finnhub aux États-Unis.`);
      }else if(state.dataSource === "finnhub"){
        toast(`Aucune donnée exploitable via Finnhub pour cet échantillon — vérifie ta clé Finnhub, ou que le format de ticker (ex. ${records[0].symbol}) est bien reconnu par Finnhub pour cette bourse.`);
      }else{
        toast(`Aucune donnée fondamentale exploitable pour les ${records.length} titres de cet échantillon. FMP ne renvoie probablement rien pour ce format de ticker sur ton plan — vérifie une URL manuellement, ex. ratios-ttm?symbol=${records[0].symbol}`);
      }
      runBtn.disabled=false; progressTxt.textContent="";
      return;
    }
    if(withData.length < records.length * 0.5){
      toast(`Attention : seulement ${withData.length}/${records.length} titres ont des données fondamentales exploitables. Le classement peut être peu fiable pour cet échantillon.`);
    }

    records = scorePool(records);
    const strat = STRATEGIES[state.strategy];
    const selected = strat.select(records, state.resultCount);

    state.lastResults = selected;
    state.lastRunMeta = {
      strategy: state.strategy,
      poolCount: records.length,
      universeCount: indexLists.reduce((s,l)=>s+l.length,0),
      countries: countries,
      dataSource: state.dataSource,
      ts: Date.now(),
    };
    state.sortCol = "rank"; state.sortDir = "asc";
    renderResults();
    const anchor = document.getElementById("results-anchor");
    if(anchor && anchor.scrollIntoView) anchor.scrollIntoView({behavior:"smooth", block:"start"});
    if(state.dataSource === "finnhub"){
      progressTxt.textContent = `Terminé — ${requestCount} requêtes Finnhub utilisées (hors quota FMP).`;
    }else{
      progressTxt.textContent = quotaErrorCount>0
        ? `Terminé — ${requestCount} requêtes FMP (dont ${quotaErrorCount} rejetées pour quota dépassé).`
        : `Terminé — ${requestCount} requêtes FMP utilisées (Wikipedia hors quota).`;
    }
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
    item.innerHTML = `<input type="checkbox" ${state.countries.has(c.code)?"checked":""}> ${flagHTML(c.code)} ${c.name}`;
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
  const countryLabel = state.lastRunMeta.countries.map(c=>flagHTML(c)).join(" ");
  const srcLabel = state.lastRunMeta.dataSource === "snapshot" ? "Snapshot local"
    : state.lastRunMeta.dataSource === "finnhub" ? "Finnhub" : "Financial Modeling Prep";
  meta.innerHTML = `Échantillon analysé : ${state.lastRunMeta.poolCount} / ${state.lastRunMeta.universeCount} titres de l'univers réel · ${countryLabel} · source : ${srcLabel} · ${new Date(state.lastRunMeta.ts).toLocaleString('fr-FR')}`;
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
      <td class="name"><span class="tkr">${cm?flagHTML(s.country)+' ':''}${s.symbol}</span><span class="cname">${s.name}</span></td>
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
  const versionEl = document.getElementById("appVersion");
  if(versionEl) versionEl.textContent = APP_VERSION;

  document.getElementById("dataSource").value = state.dataSource;

  renderStrategyCards();
  renderZonesAndCountries();
  renderNPicker();
  renderMethodology();
  updateBudgetUI();

  const savedKey = getApiKey();
  if(savedKey) document.getElementById("apiKey").value = savedKey;
  updateKeyStatus();

  const savedFinnhubKey = getFinnhubKey();
  if(savedFinnhubKey) document.getElementById("finnhubKey").value = savedFinnhubKey;

  document.getElementById("apiKey").addEventListener("change", (e)=>{
    setApiKey(e.target.value.trim());
    updateKeyStatus();
  });

  document.getElementById("finnhubKey").addEventListener("change", (e)=>{
    setFinnhubKey(e.target.value.trim());
  });

  document.getElementById("dataSource").addEventListener("change", (e)=>{
    state.dataSource = e.target.value;
    document.getElementById("fmpKeyField").style.display = state.dataSource==="fmp" ? "block" : "none";
    document.getElementById("finnhubKeyField").style.display = state.dataSource==="finnhub" ? "block" : "none";
    updateBudgetUI();
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
    cache = {fund:{}, screen:{}, index:{}};
    saveCache();
    toast("Cache local vidé.");
  });
}

document.addEventListener("DOMContentLoaded", init);
