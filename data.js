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
  {code:"JP", name:"Japon", flag:"🇯🇵", zone:"apac"},
  {code:"AU", name:"Australie", flag:"🇦🇺", zone:"apac"},
  {code:"HK", name:"Hong Kong", flag:"🇭🇰", zone:"apac"},
  {code:"SG", name:"Singapour", flag:"🇸🇬", zone:"apac"},
  {code:"KR", name:"Corée du Sud", flag:"🇰🇷", zone:"apac"},
];

const ZONES = [
  {id:"na", label:"Amérique du Nord", countries:["US","CA"]},
  {id:"eu", label:"Europe", countries:["FR","DE","GB","NL","CH","ES","IT","BE","SE","DK","NO","FI","PT","AT","IE"]},
  {id:"apac", label:"Asie-Pacifique", countries:["JP","AU","HK","SG","KR"]},
  {id:"world", label:"Monde (sélection large)", countries:["US","CA","GB","FR","DE","CH","NL","ES","IT","JP","AU","KR"]},
];

function countryMeta(code){ return COUNTRIES.find(c=>c.code===code); }

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

  william_higgon: {
    id: "william_higgon",
    name: "William Higgon",
    short: "Small/mid caps décotées, rentables et en croissance",
    stampReturn: null,
    stampYears: null,
    hardMcapCeiling: 10e9,
    factors: ["pe","pcf","roe","opMargin","revenueGrowth"],
    description: "Inspirée de l'approche de William Higgons, gérant de fonds réputé pour son travail sur les small et mid caps décotées (notamment via les fonds Indépendance et Expansion). Contrairement aux stratégies du livre d'O'Shaughnessy, ce n'est pas un composite de percentiles : chaque critère est un filtre strict, appliqué tel quel. Le résultat est ensuite trié par P/E croissant (les moins chères en tête).",
    rules: [
      "1. Capitalisation ≤ 10 Md (small/mid cap)",
      "2. P/E ≤ 12",
      "3. P/CF < 10 (si la donnée est disponible)",
      "4. ROE (rentabilité des fonds propres) ≥ 9 %",
      "5. Marge d'exploitation ≥ 4 % (5 % visé, 4 % toléré)",
      "6. Chiffre d'affaires en croissance sur les 12 derniers mois",
      "7. Trier par P/E croissant, retenir les N premiers",
    ],
    select(pool, n){
      const filtered = pool.filter(s=>
        s.mcap != null && s.mcap <= 10e9 &&
        s.pe != null && s.pe > 0 && s.pe <= 12 &&
        (s.pcf == null || s.pcf < 10) &&
        s.roe != null && s.roe >= 0.09 &&
        s.opMargin != null && s.opMargin >= 0.04 &&
        s.revenueGrowth != null && s.revenueGrowth > 0
      );
      return filtered.sort((a,b)=>a.pe-b.pe).slice(0,n);
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
const STRATEGY_ORDER = ["trending_value","deep_value","cheap_on_mend","all_stocks_growth","shareholder_yield","market_leaders","william_higgon","higgons_v2"];
