/* ===================================================================
   LE GRAND LIVRE — portfolio-store.js
   Gestion du portefeuille en localStorage, partagée entre index.html
   (screener, pour ajouter des lignes) et portfolio.html (pour les
   afficher/suivre). Rien ne transite par un serveur — tout reste dans
   le navigateur de l'utilisateur.
   =================================================================== */

const PF_HOLDINGS_KEY = "lgl_portfolio_holdings_v1";
const PF_HISTORY_KEY = "lgl_portfolio_history_v1";

function pfGetHoldings(){
  try{
    const raw = localStorage.getItem(PF_HOLDINGS_KEY);
    return raw ? JSON.parse(raw) : [];
  }catch(e){
    console.error("Portefeuille : lecture localStorage échouée", e);
    return [];
  }
}

function pfSaveHoldings(holdings){
  try{
    localStorage.setItem(PF_HOLDINGS_KEY, JSON.stringify(holdings));
    return true;
  }catch(e){
    console.error("Portefeuille : écriture localStorage échouée", e);
    return false;
  }
}

function pfAddHolding(holding){
  const holdings = pfGetHoldings();
  holdings.push({
    id: "h_" + Date.now() + "_" + Math.random().toString(36).slice(2,8),
    ...holding,
    addedAt: Date.now(),
  });
  pfSaveHoldings(holdings);
  return holdings;
}

function pfRemoveHolding(id){
  const holdings = pfGetHoldings().filter(h=>h.id!==id);
  pfSaveHoldings(holdings);
  return holdings;
}

function pfIsHeld(symbol){
  return pfGetHoldings().some(h=>h.symbol===symbol);
}

// ---------------------------------------------------------------
// Historique de valeur — un point par jour maximum, construit au fil
// des visites/rafraîchissements du snapshot. Pas de données rétroactives
// possibles : le scraper ne fournit qu'un instantané, pas un historique.
// ---------------------------------------------------------------
function pfGetHistory(){
  try{
    const raw = localStorage.getItem(PF_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  }catch(e){
    return [];
  }
}

function pfLogHistoryPoint(totalValue, totalCost){
  const today = new Date().toISOString().slice(0,10);
  const history = pfGetHistory();
  const existingIdx = history.findIndex(p=>p.date===today);
  const point = { date: today, totalValue, totalCost, ts: Date.now() };
  if(existingIdx >= 0) history[existingIdx] = point; // un seul point par jour, on écrase si on revisite
  else history.push(point);
  history.sort((a,b)=>a.date.localeCompare(b.date));
  try{ localStorage.setItem(PF_HISTORY_KEY, JSON.stringify(history)); }catch(e){}
  return history;
}

// ---------------------------------------------------------------
// Export / Import — pour passer d'un appareil à l'autre. Tout reste en
// localStorage (rien n'est synchronisé automatiquement), donc c'est le
// seul moyen de transférer un portefeuille d'un PC à un téléphone.
// ---------------------------------------------------------------
function pfExportData(){
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    holdings: pfGetHoldings(),
    history: pfGetHistory(),
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
  document.body.appendChild(a); // certains navigateurs (surtout mobiles) ignorent .click() sur un lien jamais attaché au DOM
  a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 1000); // laisse le temps au téléchargement de démarrer avant de libérer l'URL
}

/**
 * Importe un fichier exporté précédemment. mode="replace" (défaut) écrase
 * tout ; mode="merge" fusionne avec l'existant (les positions déjà
 * présentes, identifiées par symbole+date+prix, ne sont pas dupliquées).
 * Retourne {ok, message, holdingsCount}.
 */
function pfImportData(jsonText, mode){
  let data;
  try{ data = JSON.parse(jsonText); }
  catch(e){ return {ok:false, message:"Fichier JSON invalide."}; }

  if(!data || !Array.isArray(data.holdings)){
    return {ok:false, message:"Format inattendu : pas de liste de positions trouvée."};
  }

  let holdings, history;
  if(mode === "merge"){
    const current = pfGetHoldings();
    const key = h => `${h.symbol}|${h.purchaseDate}|${h.purchasePrice}|${h.quantity}`;
    const existingKeys = new Set(current.map(key));
    const toAdd = data.holdings.filter(h=>!existingKeys.has(key(h)));
    holdings = [...current, ...toAdd];

    const currentHist = pfGetHistory();
    const histByDate = {}; currentHist.forEach(p=>histByDate[p.date]=p);
    (data.history||[]).forEach(p=>{ if(!histByDate[p.date]) histByDate[p.date]=p; });
    history = Object.values(histByDate).sort((a,b)=>a.date.localeCompare(b.date));
  } else {
    holdings = data.holdings;
    history = data.history || [];
  }

  pfSaveHoldings(holdings);
  try{ localStorage.setItem(PF_HISTORY_KEY, JSON.stringify(history)); }catch(e){}
  return {ok:true, message:`${holdings.length} position(s) au total après import.`, holdingsCount: holdings.length};
}
