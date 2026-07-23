/* ===================================================================
   LE GRAND LIVRE — data.js
   Définitions des stratégies (fidèles à What Works on Wall Street,
   4e édition, J. O'Shaughnessy) + référentiel pays/zones.
   Les données proviennent uniquement de data-snapshot.json (scraper
   Python local) — voir app.js et scraper/README.md.
   =================================================================== */

const COUNTRIES = [
  {code:"US", name:"États-Unis", flag:"🇺🇸", zone:"na"},
  {code:"CA", name:"Canada", flag:"🇨🇦", zone:"na"},
  {code:"FR", name:"France", flag:"🇫🇷", zone:"eu"},
  {code:"DE", name:"Allemagne", flag:"🇩🇪", zone:"eu"},
  {code:"GB", name:"Royaume-Uni", flag:"🇬🇧", zone:"eu"},
  {code:"NL", name:"Pays-Bas", flag:"🇳🇱", zone:"eu"},
  {code:"CH", name:"Suisse", flag:"🇨🇭", zone:"eu"},
  {code:"ES", name:"Espagne", flag:"🇪🇸", zone:"eu"},
  {code:"IT", name:"Italie", flag:"🇮🇹", zone:"eu"},
  {code:"BE", name:"Belgique", flag:"🇧🇪", zone:"eu"},
  {code:"SE", name:"Suède", flag:"🇸🇪", zone:"eu"},
  {code:"DK", name:"Danemark", flag:"🇩🇰", zone:"eu"},
  {code:"NO", name:"Norvège", flag:"🇳🇴", zone:"eu"},
  {code:"FI", name:"Finlande", flag:"🇫🇮", zone:"eu"},
  {code:"PT", name:"Portugal", flag:"🇵🇹", zone:"eu"},
  {code:"AT", name:"Autriche", flag:"🇦🇹", zone:"eu"},
  {code:"IE", name:"Irlande", flag:"🇮🇪", zone:"eu"},
  {code:"LU", name:"Luxembourg", flag:"🇱🇺", zone:"eu"},
  {code:"PL", name:"Pologne", flag:"🇵🇱", zone:"eu"},
  {code:"JP", name:"Japon", flag:"🇯🇵", zone:"apac"},
  {code:"AU", name:"Australie", flag:"🇦🇺", zone:"apac"},
  {code:"HK", name:"Hong Kong", flag:"🇭🇰", zone:"apac"},
  {code:"SG", name:"Singapour", flag:"🇸🇬", zone:"apac"},
  {code:"KR", name:"Corée du Sud", flag:"🇰🇷", zone:"apac"},
];

const ZONES = [
  {id:"na", label:"Amérique du Nord", countries:["US","CA"]},
  {id:"eu", label:"Europe", countries:["FR","DE","GB","NL","CH","ES","IT","BE","SE","DK","NO","FI","PT","AT","IE","LU","PL"]},
  {id:"apac", label:"Asie-Pacifique", countries:["JP","AU","HK","SG","KR"]},
  // Dérivée automatiquement de TOUS les pays de COUNTRIES, plutôt qu'une
  // liste codée en dur — évite de l'oublier à jour à chaque nouveau pays
  // ajouté (elle ne contenait plus que 12 pays sur les 22 disponibles).
  {id:"world", label:"Monde (tous les pays disponibles)", countries: COUNTRIES.map(c=>c.code)},
];

function countryMeta(code){ return COUNTRIES.find(c=>c.code===code); }

// Devise de cotation par pays — miroir de COUNTRY_CURRENCY côté scraper
// (config.py). Doit rester synchronisé si de nouveaux pays sont ajoutés.
const COUNTRY_CURRENCY = {
  US:"USD", CA:"CAD", FR:"EUR", DE:"EUR", GB:"GBP",
  NL:"EUR", CH:"CHF", ES:"EUR", IT:"EUR", BE:"EUR",
  SE:"SEK", DK:"DKK", NO:"NOK", FI:"EUR", PT:"EUR",
  AT:"EUR", IE:"EUR", LU:"EUR", JP:"JPY", AU:"AUD", HK:"HKD",
  SG:"SGD", KR:"KRW", PL:"PLN",
};
function currencyForCountry(code){ return COUNTRY_CURRENCY[code] || "EUR"; }

/**
 * Résout la VRAIE devise d'un prix, à partir du champ listedCurrency du
 * snapshot (prioritaire, vient directement de TradingView) plutôt que de la
 * déduire uniquement du pays. Nécessaire notamment pour les actions
 * britanniques cotées en pence (GBX) plutôt qu'en livres (GBP) — sans ça,
 * un prix en pence traité comme des livres fausse la valorisation d'un
 * facteur ~100. GBX est traité comme une devise à part entière (voir
 * toEUR() dans portfolio.js pour la dérivation de son taux).
 */
function resolveListedCurrency(record){
  const raw = record && record.listedCurrency;
  if(raw) return raw.toUpperCase();
  return currencyForCountry(record ? record.country : null);
}

// Génère à la fois l'emoji drapeau (utilisé en mobile) et une vraie image de
// drapeau via flagcdn.com (utilisée en desktop, où les polices d'emoji du
// système n'affichent pas toujours les drapeaux correctement — notamment
// Windows). Le bon élément est choisi en CSS selon la largeur d'écran.
function flagHTML(code){
  if(!code) return "";
  const cc = code.toLowerCase();
  const label = countryMeta(code)?.flag || code;
  return `<span class="flag-emoji">${label}</span><img class="flag-img" src="https://flagcdn.com/20x15/${cc}.png" srcset="https://flagcdn.com/40x30/${cc}.png 2x" width="20" height="15" alt="${code}" loading="lazy">`;
}

// ---------- Alias de champs API (les noms exacts varient selon les versions FMP) ----------
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
    },
    warn(s){
      const w = [];
      if(s.mom6 <= 0) w.push("Momentum 6M négatif malgré la sélection");
      if(missingFactorCount(s) >= 3) w.push("Score basé sur des données largement incomplètes");
      return w;
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
    },
    warn(s){
      const w = [];
      if(missingFactorCount(s) >= 3) w.push("Score basé sur des données largement incomplètes");
      return w;
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
    },
    warn(s){
      const w = [];
      if(s.mom3 <= 0 || s.mom6 <= 0) w.push("Momentum positif seulement par rapport au pool, pas en absolu");
      return w;
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
    },
    warn(s){
      const w = [];
      if(s.epsGrowth === null || s.epsGrowth === undefined) w.push("Croissance du BPA inconnue (non filtrée)");
      else if(s.epsGrowth < 0.02) w.push("Croissance du BPA à peine positive");
      return w;
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
    },
    warn(s){
      const w = [];
      if(s.shareholderYield < 0.02) w.push("Rendement actionnarial faible en valeur absolue (<2%)");
      return w;
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
    },
    warn(s){
      const w = [];
      if(s.shareholderYield < 0.02) w.push("Rendement actionnarial faible en valeur absolue (<2%)");
      if(s.mom3 <= 0 || s.mom6 <= 0) w.push("Momentum positif seulement par rapport au groupe, pas en absolu");
      return w;
    }
  },

  higgons_v2: {
    id: "higgons_v2",
    name: "HiggonsV2",
    short: "Higgons affiné : marge stricte + filtre anti-sous-performance",
    stampReturn: null,
    stampYears: null,
    hardMcapCeiling: 10e9,
    factors: ["pe","pcf","roe","opMargin","revenueGrowth","mom6"],
    description: "Version affinée de la stratégie William Higgon, basée sur une lecture plus détaillée de sa méthode (source : article Les Daubasses, « Les clés de la réussite du meilleur gérant français »). Deux différences principales avec la V1 : la marge d'exploitation est exigée à 5% strict (pas de tolérance à 4%), et un filtre de momentum écarte les titres qui se sont fortement effondrés — Higgons se méfie d'une chute de cours sans nouvelle publiée, qui trahit souvent une information négative pas encore publique. Le tri se fait par P/CF croissant, le critère de valorisation qu'il privilégie réellement (le PER n'étant qu'un second choix, plus volatil).",
    rules: [
      "1. Capitalisation ≤ 10 Md — small/mid cap, cœur de cible du fonds",
      "2. P/E ≤ 12",
      "3. P/CF < 10 (si la donnée est disponible) — critère de valorisation privilégié",
      "4. ROE (proxy du ROCE) ≥ 9 %",
      "5. Marge d'exploitation ≥ 5 % strict",
      "6. Chiffre d'affaires en croissance sur les 12 derniers mois",
      "7. Exclusion : momentum 6 mois ≤ −20 % (évite les titres qui s'effondrent sans raison connue)",
      "8. Trier par P/CF croissant (P/E en repli si P/CF indisponible), retenir les N premiers",
    ],
    select(pool, n){
      const filtered = pool.filter(s=>
        s.mcap != null && s.mcap <= 10e9 &&
        s.pe != null && s.pe > 0 && s.pe <= 12 &&
        (s.pcf == null || s.pcf < 10) &&
        s.roe != null && s.roe >= 0.09 &&
        s.opMargin != null && s.opMargin >= 0.05 &&
        s.revenueGrowth != null && s.revenueGrowth > 0 &&
        (s.mom6 == null || s.mom6 > -20)
      );
      return filtered.sort((a,b)=>{
        const av = a.pcf != null ? a.pcf : a.pe;
        const bv = b.pcf != null ? b.pcf : b.pe;
        return av - bv;
      }).slice(0,n);
    },
    warn(s){
      const w = [];
      if(s.pe > 10) w.push("P/E proche du plafond (12)");
      if(s.pcf != null && s.pcf > 8) w.push("P/CF proche du plafond (10)");
      if(s.roe < 0.11) w.push("ROE proche du plancher (9%)");
      if(s.opMargin < 0.06) w.push("Marge d'exploitation proche du plancher strict (5%)");
      if(s.revenueGrowth < 0.02) w.push("Croissance du CA à peine positive");
      if(s.mom6 != null && s.mom6 <= -15) w.push("Momentum proche du seuil d'exclusion (-20%)");
      return w;
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

// Compte combien des 6 facteurs du composite de valeur sont manquants pour un
// titre donné (rang neutre 50 ET valeur brute null -> vraiment absent, pas
// juste "dans la moyenne"). Sert à signaler les scores peu fiables.
function missingFactorCount(s){
  const factors = [
    [s.rank_pb, s.pb], [s.rank_pe, s.pe], [s.rank_ps, s.ps],
    [s.rank_pcf, s.pcf], [s.rank_ebitdaYield, s.ebitdaYield], [s.rank_shareholderYield, s.shareholderYield],
  ];
  return factors.filter(([rank, val])=> rank===50 && (val===null || val===undefined)).length;
}

// expose méthodologie triée dans l'ordre d'affichage souhaité
const STRATEGY_ORDER = ["trending_value","deep_value","cheap_on_mend","all_stocks_growth","shareholder_yield","market_leaders","higgons_v2"];

// ===================================================================
// Chargement du snapshot — partagé entre index.html, search.html et
// portfolio.html (toutes chargent data.js avant leur propre script).
//
// Le fichier peut désormais être découpé en plusieurs parties par le
// scraper (voir scraper/export.py) pour rester sous la limite d'upload
// de GitHub (25 Mo) une fois l'univers élargi : data-snapshot-manifest.json
// liste les parties, chacune un fichier data-snapshot-N.json. On charge
// le manifeste puis toutes les parties en parallèle, et on fusionne —
// transparent pour le reste du code, qui continue de voir un seul objet
// {generatedAt, records: [...]}.
//
// Repli sur l'ancien format à fichier unique (data-snapshot.json) si
// aucun manifeste n'est trouvé, pour une transition en douceur.
// ===================================================================

let snapshotCache = null;

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

async function loadSnapshot(){
  if(snapshotCache) return snapshotCache;

  const manifestUrl = "./data-snapshot-manifest.json?t=" + Date.now();
  let manifestRes = null;
  try{
    manifestRes = await fetchWithTimeout(manifestUrl, {cache:"no-store"}, 15000);
  }catch(e){
    manifestRes = null; // pas de manifeste accessible -> on tentera l'ancien format plus bas
  }

  if(manifestRes && manifestRes.ok){
    const manifest = await manifestRes.json();
    if(!manifest || !Array.isArray(manifest.parts) || manifest.parts.length === 0){
      throw new Error("Manifeste de snapshot invalide (data-snapshot-manifest.json sans partie listée).");
    }
    const partsData = await Promise.all(manifest.parts.map(async (partFile)=>{
      const partUrl = `./${partFile}?t=${Date.now()}`;
      const res = await fetchWithTimeout(partUrl, {cache:"no-store"}, 25000);
      if(!res.ok) throw new Error(`Partie de snapshot introuvable : ${partFile} (HTTP ${res.status})`);
      const data = await res.json();
      if(!data || !Array.isArray(data.records)) throw new Error(`Format inattendu dans ${partFile}`);
      return data.records;
    }));
    const merged = {
      generatedAt: manifest.generatedAt,
      records: partsData.flat(),
    };
    snapshotCache = merged;
    return merged;
  }

  // Repli : ancien format à fichier unique (avant le découpage en parties)
  const legacyUrl = "./data-snapshot.json?t=" + Date.now();
  const res = await fetchWithTimeout(legacyUrl, {cache:"no-store"}, 15000);
  if(!res.ok){
    throw new Error("Aucun snapshot trouvé (ni data-snapshot-manifest.json, ni data-snapshot.json) — lance d'abord le scraper local (voir scraper/README.md) puis commit les fichiers générés à la racine du site.");
  }
  const json = await res.json();
  if(!json || !Array.isArray(json.records)) throw new Error("Format de snapshot inattendu.");
  snapshotCache = json;
  return json;
}
