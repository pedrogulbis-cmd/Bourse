/* ===================================================================
   LE GRAND LIVRE — portfolio-store.js (v2 — plusieurs portefeuilles)
   Gestion du/des portefeuille(s) en localStorage, partagée entre
   index.html, search.html (pour ajouter des lignes) et portfolio.html
   (pour les afficher/suivre). Rien ne transite par un serveur — tout
   reste dans le navigateur de l'utilisateur.

   Modèle de données : plusieurs portefeuilles nommés (ex. "PEA", "CTO"),
   chacun avec ses propres positions et son propre historique de valeur.
   Un seul est "actif" à la fois — toutes les fonctions pfGetHoldings(),
   pfAddHolding() etc. opèrent sur le portefeuille actif par défaut, sauf
   si on leur passe explicitement un portfolioId.

   Migration automatique : si un ancien portefeuille au format v1 (un
   seul portefeuille, sans nom) est détecté, il est converti une fois en
   "Portefeuille principal" au premier chargement — aucune perte de
   données pour les utilisateurs déjà en place.
   =================================================================== */

const PF_STORE_KEY = "lgl_portfolios_v2";
// Anciennes clés v1 — lues UNIQUEMENT pour la migration automatique, plus jamais écrites après.
const PF_LEGACY_HOLDINGS_KEY = "lgl_portfolio_holdings_v1";
const PF_LEGACY_HISTORY_KEY = "lgl_portfolio_history_v1";

function pfNewId(){ return "p_" + Date.now() + "_" + Math.random().toString(36).slice(2,8); }

function pfMigrateFromV1(){
  let holdings = [], history = [];
  try{
    const rawH = localStorage.getItem(PF_LEGACY_HOLDINGS_KEY);
    if(rawH) holdings = JSON.parse(rawH);
  }catch(e){}
  try{
    const rawHist = localStorage.getItem(PF_LEGACY_HISTORY_KEY);
    if(rawHist) history = JSON.parse(rawHist);
  }catch(e){}
  const id = pfNewId();
  const store = {
    portfolios: [{ id, name: "Portefeuille principal", holdings, history }],
    activeId: id,
  };
  pfSaveStore(store);
  return store;
}

function pfLoadStore(){
  try{
    const raw = localStorage.getItem(PF_STORE_KEY);
    if(raw){
      const store = JSON.parse(raw);
      if(store && Array.isArray(store.portfolios) && store.portfolios.length){
        if(!store.portfolios.some(p=>p.id===store.activeId)) store.activeId = store.portfolios[0].id;
        return store;
      }
    }
  }catch(e){
    console.error("Portefeuille : lecture localStorage échouée", e);
  }
  return pfMigrateFromV1();
}

function pfSaveStore(store){
  try{
    localStorage.setItem(PF_STORE_KEY, JSON.stringify(store));
    return true;
  }catch(e){
    console.error("Portefeuille : écriture localStorage échouée", e);
    return false;
  }
}

// ---------------------------------------------------------------
// Gestion des portefeuilles eux-mêmes
// ---------------------------------------------------------------
function pfGetPortfolios(){ return pfLoadStore().portfolios; }
function pfGetActivePortfolioId(){ return pfLoadStore().activeId; }
function pfGetActivePortfolio(){
  const store = pfLoadStore();
  return store.portfolios.find(p=>p.id===store.activeId) || store.portfolios[0];
}
function pfSetActivePortfolio(id){
  const store = pfLoadStore();
  if(store.portfolios.some(p=>p.id===id)){ store.activeId = id; pfSaveStore(store); }
}
function pfCreatePortfolio(name){
  const store = pfLoadStore();
  const id = pfNewId();
  store.portfolios.push({ id, name: name || "Nouveau portefeuille", holdings: [], history: [] });
  store.activeId = id;
  pfSaveStore(store);
  return id;
}
function pfRenamePortfolio(id, newName){
  const store = pfLoadStore();
  const p = store.portfolios.find(x=>x.id===id);
  if(p && newName && newName.trim()){ p.name = newName.trim(); pfSaveStore(store); }
}
/** Retourne false si suppression refusée (dernier portefeuille restant — on en garde toujours au moins un). */
function pfDeletePortfolio(id){
  const store = pfLoadStore();
  if(store.portfolios.length <= 1) return false;
  store.portfolios = store.portfolios.filter(p=>p.id!==id);
  if(store.activeId === id) store.activeId = store.portfolios[0].id;
  pfSaveStore(store);
  return true;
}

// ---------------------------------------------------------------
// Positions — opèrent sur le portefeuille ACTIF sauf si portfolioId fourni
// ---------------------------------------------------------------
function pfGetHoldings(portfolioId){
  const store = pfLoadStore();
  const p = store.portfolios.find(x=>x.id===(portfolioId||store.activeId));
  return p ? p.holdings : [];
}

function pfSaveHoldings(holdings, portfolioId){
  const store = pfLoadStore();
  const p = store.portfolios.find(x=>x.id===(portfolioId||store.activeId));
  if(!p) return false;
  p.holdings = holdings;
  return pfSaveStore(store);
}

function pfAddHolding(holding, portfolioId){
  const holdings = pfGetHoldings(portfolioId);
  holdings.push({
    id: "h_" + Date.now() + "_" + Math.random().toString(36).slice(2,8),
    ...holding,
    addedAt: Date.now(),
  });
  pfSaveHoldings(holdings, portfolioId);
  return holdings;
}

function pfRemoveHolding(id, portfolioId){
  const holdings = pfGetHoldings(portfolioId).filter(h=>h.id!==id);
  pfSaveHoldings(holdings, portfolioId);
  return holdings;
}

/** Un titre est-il détenu dans CE portefeuille (actif par défaut) ? Ne
 * regarde pas les autres portefeuilles — un même titre peut légitimement
 * être détenu à la fois en PEA et en CTO. */
function pfIsHeld(symbol, portfolioId){
  return pfGetHoldings(portfolioId).some(h=>h.symbol===symbol);
}

// ---------------------------------------------------------------
// Historique de valeur — un point par jour maximum, par portefeuille.
// ---------------------------------------------------------------
function pfGetHistory(portfolioId){
  const store = pfLoadStore();
  const p = store.portfolios.find(x=>x.id===(portfolioId||store.activeId));
  return p ? p.history : [];
}

function pfLogHistoryPoint(totalValue, totalCost, portfolioId){
  const store = pfLoadStore();
  const p = store.portfolios.find(x=>x.id===(portfolioId||store.activeId));
  if(!p) return [];
  const today = new Date().toISOString().slice(0,10);
  const idx = p.history.findIndex(pt=>pt.date===today);
  const point = { date: today, totalValue, totalCost, ts: Date.now() };
  if(idx >= 0) p.history[idx] = point;
  else p.history.push(point);
  p.history.sort((a,b)=>a.date.localeCompare(b.date));
  pfSaveStore(store);
  return p.history;
}

// ---------------------------------------------------------------
// Export / Import — pour passer d'un appareil à l'autre. Exporte TOUS les
// portefeuilles d'un coup (pas besoin de le refaire un par un).
// ---------------------------------------------------------------
function pfExportData(){
  const store = pfLoadStore();
  return {
    exportedAt: new Date().toISOString(),
    version: 2,
    portfolios: store.portfolios,
    activeId: store.activeId,
  };
}

function pfDownloadExport(){
  const data = pfExportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `portefeuille-lgl-${new Date().toISOString().slice(0,10)}.json`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

function pfDedupeHoldingsKey(h){
  return `${h.symbol}|${h.purchaseDate}|${h.purchasePrice}|${h.quantity}`;
}

/**
 * Importe un fichier exporté précédemment. Comprend à la fois le nouveau
 * format (plusieurs portefeuilles) et l'ancien (v1, un seul portefeuille
 * sans nom — importé comme portefeuille unique "Portefeuille importé").
 * mode="replace" écrase tout ; mode="merge" fusionne portefeuille par
 * portefeuille (par nom), sans dupliquer les positions déjà présentes.
 */
function pfImportData(jsonText, mode){
  let data;
  try{ data = JSON.parse(jsonText); }
  catch(e){ return {ok:false, message:"Fichier JSON invalide."}; }
  if(!data) return {ok:false, message:"Fichier vide ou invalide."};

  let incomingPortfolios;
  if(Array.isArray(data.portfolios)){
    incomingPortfolios = data.portfolios;
  } else if(Array.isArray(data.holdings)){
    incomingPortfolios = [{ name: "Portefeuille importé", holdings: data.holdings, history: data.history || [] }];
  } else {
    return {ok:false, message:"Format inattendu : ni portefeuilles, ni liste de positions trouvés."};
  }

  const store = pfLoadStore();

  if(mode === "merge"){
    incomingPortfolios.forEach(incoming=>{
      const existing = store.portfolios.find(p=>p.name === incoming.name);
      if(existing){
        const existingKeys = new Set(existing.holdings.map(pfDedupeHoldingsKey));
        const toAdd = (incoming.holdings||[]).filter(h=>!existingKeys.has(pfDedupeHoldingsKey(h)));
        existing.holdings = [...existing.holdings, ...toAdd];

        const histByDate = {};
        existing.history.forEach(p=>histByDate[p.date]=p);
        (incoming.history||[]).forEach(p=>{ if(!histByDate[p.date]) histByDate[p.date]=p; });
        existing.history = Object.values(histByDate).sort((a,b)=>a.date.localeCompare(b.date));
      } else {
        store.portfolios.push({ id: pfNewId(), name: incoming.name || "Portefeuille importé", holdings: incoming.holdings||[], history: incoming.history||[] });
      }
    });
  } else {
    store.portfolios = incomingPortfolios.map(p=>({ id: pfNewId(), name: p.name || "Portefeuille importé", holdings: p.holdings||[], history: p.history||[] }));
    store.activeId = store.portfolios[0].id;
  }

  pfSaveStore(store);
  const totalHoldings = store.portfolios.reduce((s,p)=>s+p.holdings.length, 0);
  return {ok:true, message:`${store.portfolios.length} portefeuille(s), ${totalHoldings} position(s) au total après import.`};
}
