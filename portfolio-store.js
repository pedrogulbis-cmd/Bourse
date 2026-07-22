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
