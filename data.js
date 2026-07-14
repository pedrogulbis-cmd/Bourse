/* ===================================================================
   LE GRAND LIVRE — data.js
   Définitions des stratégies (fidèles à What Works on Wall Street,
   4e édition, J. O'Shaughnessy) + référentiel pays/zones.
   =================================================================== */

// ---------------------------------------------------------------------------
// Univers de titres — DYNAMIQUE, via Wikipedia (aucun ticker écrit à la main).
// Le plan gratuit FMP bloque le screener et la liste globale de titres
// ("Restricted Endpoint"), mais les endpoints PAR TITRE fonctionnent bien
// (quote, ratios-ttm, key-metrics-ttm, stock-price-change,
// cash-flow-statement-ttm). On récupère donc la vraie composition des
// grands indices directement depuis Wikipedia (API CORS-friendly via
// origin=*), puis on interroge FMP titre par titre sur un échantillon
// (contrainte de quota : 250 requêtes/jour ≈ 50 titres/run).
// ---------------------------------------------------------------------------
const INDEX_SOURCES = {
  US: {indexName:"S&P 500",        page:"List of S&P 500 companies", suffix:""},
  CA: {indexName:"S&P/TSX 60",     page:"S&P/TSX 60",                suffix:".TO"},
  GB: {indexName:"FTSE 100",       page:"FTSE 100 Index",            suffix:".L"},
  FR: {indexName:"CAC 40",         page:"CAC 40",                    suffix:".PA"},
  DE: {indexName:"DAX",            page:"DAX",                       suffix:".DE"},
  CH: {indexName:"SMI",            page:"Swiss Market Index",        suffix:".SW"},
  NL: {indexName:"AEX",            page:"AEX index",                 suffix:".AS"},
  JP: {indexName:"Nikkei 225",     page:"Nikkei 225",                suffix:".T"},
};

// ---------- Pays disponibles (uniquement ceux couverts par INDEX_SOURCES) ----------
const COUNTRIES = [
  {code:"US", name:"États-Unis", flag:"🇺🇸", zone:"na"},
  {code:"CA", name:"Canada", flag:"🇨🇦", zone:"na"},
  {code:"FR", name:"France", flag:"🇫🇷", zone:"eu"},
  {code:"DE", name:"Allemagne", flag:"🇩🇪", zone:"eu"},
  {code:"GB", name:"Royaume-Uni", flag:"🇬🇧", zone:"eu"},
  {code:"NL", name:"Pays-Bas", flag:"🇳🇱", zone:"eu"},
  {code:"CH", name:"Suisse", flag:"🇨🇭", zone:"eu"},
  {code:"JP", name:"Japon", flag:"🇯🇵", zone:"apac"},
];

const ZONES = [
  {id:"na", label:"Amérique du Nord", countries:["US","CA"]},
  {id:"eu", label:"Europe", countries:["FR","DE","GB","NL","CH"]},
  {id:"apac", label:"Asie-Pacifique", countries:["JP"]},
  {id:"world", label:"Monde (sélection large)", countries:["US","CA","GB","FR","DE","CH","NL","JP"]},
];

function countryMeta(code){ return COUNTRIES.find(c=>c.code===code); }

// ---------- Alias de champs API (les noms exacts varient selon les versions FMP) ----------
const FIELD_ALIASES = {
  pb:      ["priceToBookRatioTTM","priceBookValueRatioTTM","pbRatioTTM","priceToBookRatio"],
  pe:      ["priceToEarningsRatioTTM","peRatioTTM","priceEarningsRatioTTM","peRatio"],
  ps:      ["priceToSalesRatioTTM","priceSalesRatioTTM","psRatioTTM","priceToSalesRatio"],
  pcf:     ["priceToOperatingCashFlowRatioTTM","priceCashFlowRatioTTM","pocfRatioTTM","priceToFreeCashFlowsRatioTTM"],
  evEbitda:["enterpriseValueMultipleTTM","evToEbitdaTTM","evEbitdaTTM","enterpriseValueOverEBITDATTM"],
  divYield:["dividendYieldTTM","dividendYielPercentageTTM","dividendYieldPercentageTTM","dividendYielTTM"],
  buyback: ["commonStockRepurchasedTTM","purchasesOfCommonStockTTM","commonStockRepurchased"],
  mcap:    ["marketCap","marketCapTTM"],
  epsGrowth:["epsgrowth","epsGrowth","netIncomeGrowth"],
};

const FINNHUB_ALIASES = {
  pe: ["peTTM","peBasicExclExtraTTM","peExclExtraTTM","peInclExtraTTM","peNormalizedAnnual"],
  pb: ["pbAnnual","pbQuarterly","pb"],
  ps: ["psTTM","psAnnual","psQuarterly"],
  pcf: ["pfcfShareTTM","pcfShareTTM","pfcfShareAnnual"],
  evEbitda: ["currentEv/EbitdaTTM","evEbitdaTTM","enterpriseValueEbitdaTTM","currentEV/EBITDATTM"],
  divYield: ["currentDividendYieldTTM","dividendYieldIndicatedAnnual","dividendYield5Y"],
  mom3: ["13WeekPriceReturnDaily"],
  mom6: ["26WeekPriceReturnDaily"],
  mcap: ["marketCapitalization"], // en MILLIONS chez Finnhub — à multiplier par 1e6
  epsGrowth: ["epsGrowth3Y","epsGrowth5Y","epsGrowthTTMYoy","epsGrowthQuarterlyYoy"],
};

function pick(obj, keys){
  if(!obj) return null;
  for(const k of keys){
    if(obj[k]!==undefined && obj[k]!==null && !Number.isNaN(obj[k])) return obj[k];
  }
  return null;
}

// ===================================================================
// STRATÉGIES
// Chaque stratégie définit :
//  - universe: filtre de base (capitalisation etc, appliqué au screener)
//  - factors: liste des facteurs de valorisation composités (Value Composite)
//  - select(pool): fonction qui prend le pool scoré et retourne les élus
// ===================================================================

const STRATEGIES = {

  trending_value: {
    id: "trending_value",
    name: "Trending Value",
    short: "Valeur profonde + momentum 6 mois",
    stampReturn: "21,2 %/an",
    stampYears: "1964–2009 · 25 titres",
    factors: ["pb","pe","ps","evEbitda","pcf","shareholderYield"],
    description: "Combine les deux facteurs les plus robustes du livre : la cherté (Value Composite Two, 6 ratios combinés) et la dynamique de prix. On ne garde que le décile le moins cher (10 % du pool) selon le composite de valeur, puis parmi ces titres on sélectionne ceux dont l'appréciation sur 6 mois est la plus forte. L'idée : acheter des actions décotées qui recommencent déjà à monter, plutôt que des décotées qui continuent de baisser.",
    rules: [
      "1. Univers : capitalisation ≥ seuil choisi",
      "2. Rang percentile sur 6 facteurs : P/B, P/E, P/S, EBITDA/EV, P/CF, rendement actionnarial",
      "3. Ne garder que le décile 1 (10 % les moins chers) du composite",
      "4. Trier par appréciation sur 6 mois, décroissant",
      "5. Retenir les N meilleurs",
    ],
    select(pool, n){
      const decile1 = topDeciles(pool, 1);
      return decile1.sort((a,b)=>(b.mom6-a.mom6)).slice(0,n);
    }
  },

  deep_value: {
    id: "deep_value",
    name: "Value Composite Two",
    short: "Valeur profonde pure",
    stampReturn: "17,3 %/an",
    stampYears: "1964–2009 · décile 1",
    factors: ["pb","pe","ps","evEbitda","pcf","shareholderYield"],
    description: "La brique de base du livre : au lieu de choisir un seul ratio (P/E ou P/B), on combine six mesures de valorisation en un score composite, chaque titre étant classé par percentile sur chaque facteur puis les rangs additionnés. Cette approche est plus stable et plus performante qu'un ratio isolé sur toute la période testée. Aucune contrainte de momentum ici — stratégie 100% value.",
    rules: [
      "1. Univers : capitalisation ≥ seuil choisi",
      "2. Rang percentile sur 6 facteurs : P/B, P/E, P/S, EBITDA/EV, P/CF, rendement actionnarial",
      "3. Trier par score composite décroissant (les moins chers en tête)",
      "4. Retenir les N meilleurs",
    ],
    select(pool, n){
      return [...pool].sort((a,b)=>b.vc2Score-a.vc2Score).slice(0,n);
    }
  },

  cheap_on_mend: {
    id: "cheap_on_mend",
    name: "Cheap Stocks on the Mend",
    short: "Valeur + momentum médian (croissance/valeur)",
    stampReturn: "19,8 %/an",
    stampYears: "1964–2009 · 25 titres",
    factors: ["pb","pe","ps","evEbitda","pcf","shareholderYield"],
    description: "Version assouplie de Trending Value : on élargit la base aux 30% de titres les moins chers (au lieu de 10%), mais on exige en plus que le momentum 3 mois ET 6 mois soit supérieur à la médiane du pool — pas seulement le meilleur. Le tri final se fait sur le momentum 6 mois. Dans le livre, cette variante affiche la plus forte corrélation au Russell 2000 Value.",
    rules: [
      "1. Univers : capitalisation ≥ seuil choisi",
      "2. Garder le top 3 déciles (30%) du composite de valeur",
      "3. Filtrer : momentum 3 mois > médiane du pool ET momentum 6 mois > médiane du pool",
      "4. Trier par momentum 6 mois décroissant",
      "5. Retenir les N meilleurs",
    ],
    select(pool, n){
      const top3dec = topDeciles(pool, 3);
      const med3 = median(pool.map(s=>s.mom3));
      const med6 = median(pool.map(s=>s.mom6));
      return top3dec.filter(s=>s.mom3>med3 && s.mom6>med6).sort((a,b)=>b.mom6-a.mom6).slice(0,n);
    }
  },

  all_stocks_growth: {
    id: "all_stocks_growth",
    name: "All Stocks Growth",
    short: "Croissance + momentum, forte corrélation croissance",
    stampReturn: "20,5 %/an",
    stampYears: "1964–2009 · 25 titres",
    factors: ["pb","pe","ps","evEbitda","pcf","shareholderYield"],
    description: "La variante la plus proche d'une vraie stratégie croissance : bénéfices en hausse sur un an, momentum 3 et 6 mois supérieurs à la médiane, et le titre doit être dans la meilleure moitié (top 50%) du composite de valeur — un filtre de qualité minimal plutôt qu'une exigence de cherté. Plus volatile que les stratégies value pures, mais rendement et corrélation aux indices croissance plus élevés.",
    rules: [
      "1. Univers : capitalisation ≥ seuil choisi",
      "2. Croissance du bénéfice par action sur 1 an > 0",
      "3. Momentum 3 mois > médiane ET momentum 6 mois > médiane",
      "4. Composite de valeur dans la meilleure moitié (rang ≥ 50)",
      "5. Trier par momentum 6 mois décroissant",
    ],
    select(pool, n){
      const med3 = median(pool.map(s=>s.mom3));
      const med6 = median(pool.map(s=>s.mom6));
      return pool.filter(s => (s.epsGrowth===null || s.epsGrowth>0) && s.mom3>med3 && s.mom6>med6 && s.vc2Rank>=50)
                  .sort((a,b)=>b.mom6-a.mom6).slice(0,n);
    }
  },

  shareholder_yield: {
    id: "shareholder_yield",
    name: "Shareholder Yield",
    short: "Dividendes + rachats d'actions",
    stampReturn: "14,9 %/an",
    stampYears: "1927–2009 · décile 1",
    factors: ["shareholderYield"],
    description: "Le facteur le plus simple du livre, et l'un des plus robustes sur longue période (données depuis 1927) : le rendement actionnarial cumule le rendement du dividende et le rendement des rachats d'actions (cash consacré aux buybacks / capitalisation). On classe simplement l'univers par ce score et on garde le décile le plus généreux.",
    rules: [
      "1. Univers : capitalisation ≥ seuil choisi",
      "2. Rendement actionnarial = rendement du dividende + rendement des rachats d'actions",
      "3. Trier par rendement actionnarial décroissant",
      "4. Retenir les N meilleurs",
    ],
    select(pool, n){
      return [...pool].sort((a,b)=>b.shareholderYield-a.shareholderYield).slice(0,n);
    }
  },

  market_leaders: {
    id: "market_leaders",
    name: "Market Leaders + Yield + Momentum",
    short: "Grandes capitalisations, rendement actionnarial, momentum",
    stampReturn: "≈17,9 %/an",
    stampYears: "1964–2009 · 25 titres",
    factors: ["shareholderYield"],
    description: "Réservée aux grandes valeurs bien établies : dans le livre, l'univers « Market Leaders » regroupe les sociétés dont le chiffre d'affaires, le flux de trésorerie et le nombre d'actions en circulation dépassent la moyenne du marché (environ 6% des sociétés cotées, les mastodontes). Ici on approxime cet univers par les capitalisations supérieures à la moyenne du pool récupéré, hors utilities. On exige un momentum 3 et 6 mois supérieur à la médiane, puis on trie par rendement actionnarial.",
    rules: [
      "1. Univers Market Leaders (approximation) : capitalisation > moyenne du pool, hors secteur Utilities",
      "2. Momentum 3 mois > médiane ET momentum 6 mois > médiane",
      "3. Trier par rendement actionnarial décroissant",
      "4. Retenir les N meilleurs",
    ],
    select(pool, n){
      const avgCap = pool.reduce((s,x)=>s+x.mcap,0)/pool.length;
      const leaders = pool.filter(s=>s.mcap>avgCap && s.sector!=="Utilities");
      const med3 = median(leaders.map(s=>s.mom3));
      const med6 = median(leaders.map(s=>s.mom6));
      return leaders.filter(s=>s.mom3>med3 && s.mom6>med6).sort((a,b)=>b.shareholderYield-a.shareholderYield).slice(0,n);
    }
  },
};

// ---------- utils stats ----------
function median(arr){
  const a = arr.filter(x=>x!==null && !Number.isNaN(x)).sort((x,y)=>x-y);
  if(a.length===0) return 0;
  const mid = Math.floor(a.length/2);
  return a.length%2 ? a[mid] : (a[mid-1]+a[mid])/2;
}

function topDeciles(pool, numDeciles){
  // deciles calculés sur vc2Rank (1..100, 100 = meilleur score du composite de valeur)
  // numDeciles=1 -> garde le décile 1 (10% les moins chers) ; numDeciles=3 -> garde les 3 premiers déciles (30%)
  const lowBound = 100 - (numDeciles*10) + 1;
  return pool.filter(s=>s.vc2Rank >= lowBound);
}

// expose méthodologie triée dans l'ordre d'affichage souhaité
const STRATEGY_ORDER = ["trending_value","deep_value","cheap_on_mend","all_stocks_growth","shareholder_yield","market_leaders"];
