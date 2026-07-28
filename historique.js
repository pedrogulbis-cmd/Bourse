/* ===================================================================
   LE GRAND LIVRE — historique.js
   Suivi des clôtures de portefeuille (bouton "Clôturer position" sur la
   page Portefeuille) — permet de comparer la performance réalisée par
   méthode/stratégie utilisée, au fil du temps.
   =================================================================== */

function fmtEUR(v){
  if(v===null||v===undefined||Number.isNaN(v)) return "—";
  return v.toLocaleString('fr-FR',{maximumFractionDigits:2}) + " €";
}
function fmtPctSigned(v){
  if(v===null||v===undefined||Number.isNaN(v)) return "—";
  return (v>=0?"+":"") + v.toFixed(1) + "%";
}

/** Sélecteur de portefeuille en lecture seule — juste pour choisir de
 * quel portefeuille regarder l'historique. La création/suppression/
 * renommage restent gérés depuis la page Portefeuille, pas dupliqués ici. */
function renderSwitcherReadonly(){
  const wrap = document.getElementById("pfSwitcherReadonly");
  const portfolios = pfGetPortfolios();
  const activeId = pfGetActivePortfolioId();

  if(portfolios.length <= 1){
    wrap.innerHTML = "";
    return;
  }

  wrap.innerHTML = portfolios.map(p => `
    <div class="pf-tab ${p.id===activeId?'active':''}" data-pf-id="${p.id}">
      <span class="pf-tab-label">${p.name}</span>
    </div>
  `).join('');

  wrap.querySelectorAll(".pf-tab").forEach(tab=>{
    tab.addEventListener("click", ()=>{
      pfSetActivePortfolio(tab.dataset.pfId);
      renderAll();
    });
  });
}

function renderRecap(closures){
  const wrap = document.getElementById("recapWrap");
  if(closures.length === 0){
    wrap.innerHTML = `<div class="card"><div class="lbl">Clôtures enregistrées</div><div class="val">0</div></div>`;
    return;
  }
  const totalInvested = closures.reduce((s,c)=>s+(c.totalCostBasis||0), 0);
  const totalRealized = closures.reduce((s,c)=>s+(c.realizedGain||0), 0);
  const totalRealizedPct = totalInvested>0 ? (totalRealized/totalInvested*100) : null;
  const gainClass = totalRealized>=0 ? "pos" : "neg";

  wrap.innerHTML = `
    <div class="card"><div class="lbl">Clôtures enregistrées</div><div class="val">${closures.length}</div></div>
    <div class="card"><div class="lbl">Total investi (cumulé)</div><div class="val">${fmtEUR(totalInvested)}</div></div>
    <div class="card"><div class="lbl">Plus/moins-value réalisée (cumulée)</div><div class="val ${gainClass}">${fmtEUR(totalRealized)} (${fmtPctSigned(totalRealizedPct)})</div></div>
  `;
}

function renderByStrategy(closures){
  const wrap = document.getElementById("byStrategyWrap");
  if(closures.length === 0){
    wrap.innerHTML = `<div class="empty-state">Aucune clôture enregistrée pour ce portefeuille — utilise le bouton "Clôturer position" sur la page Portefeuille pour commencer à suivre tes résultats par méthode.</div>`;
    return;
  }

  const byStrategy = {};
  closures.forEach(c=>{
    const key = c.strategyName || c.strategy || "Autre";
    if(!byStrategy[key]) byStrategy[key] = { count:0, invested:0, realized:0 };
    byStrategy[key].count += 1;
    byStrategy[key].invested += (c.totalCostBasis||0);
    byStrategy[key].realized += (c.realizedGain||0);
  });

  const rows = Object.entries(byStrategy)
    .map(([name, s]) => ({ name, ...s, pct: s.invested>0 ? s.realized/s.invested*100 : null }))
    .sort((a,b)=> (b.pct ?? -Infinity) - (a.pct ?? -Infinity));

  let html = `<table class="results"><thead><tr>
    <th>Méthode</th><th class="num">Clôtures</th><th class="num">Investi cumulé</th><th class="num">Plus/moins-value cumulée</th>
  </tr></thead><tbody>`;
  rows.forEach(r=>{
    const gainClass = r.realized>=0 ? "pos" : "neg";
    html += `<tr>
      <td>${r.name}</td>
      <td class="num">${r.count}</td>
      <td class="num">${fmtEUR(r.invested)}</td>
      <td class="num ${gainClass}">${fmtEUR(r.realized)} (${fmtPctSigned(r.pct)})</td>
    </tr>`;
  });
  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

function renderClosuresTable(closures){
  const wrap = document.getElementById("closuresWrap");
  if(closures.length === 0){
    wrap.innerHTML = "";
    return;
  }
  const sorted = [...closures].sort((a,b)=> b.closedDate.localeCompare(a.closedDate));

  let html = `<table class="results"><thead><tr>
    <th>Date de clôture</th><th>Méthode</th><th class="num">Positions</th><th class="num">Investi</th><th class="num">Valeur à la clôture</th><th class="num">+/- value</th><th></th>
  </tr></thead><tbody>`;
  sorted.forEach(c=>{
    const gainClass = c.realizedGain>=0 ? "pos" : "neg";
    html += `<tr>
      <td>${c.closedDate}</td>
      <td>${c.strategyName || c.strategy || "Autre"}</td>
      <td class="num">${c.positionCount}</td>
      <td class="num">${fmtEUR(c.totalCostBasis)}</td>
      <td class="num">${fmtEUR(c.totalValue)}</td>
      <td class="num ${gainClass}">${fmtEUR(c.realizedGain)} (${fmtPctSigned(c.realizedGainPct)})</td>
      <td><button class="remove-btn" data-remove-closure="${c.id}" title="Supprimer cette ligne d'historique (ne restaure pas les positions)">✕</button></td>
    </tr>`;
  });
  html += `</tbody></table>`;
  wrap.innerHTML = html;

  wrap.querySelectorAll("[data-remove-closure]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      if(confirm("Supprimer cette ligne d'historique ? Les positions ne seront PAS restaurées (cette action est indépendante).")){
        pfRemoveClosure(btn.dataset.removeClosure);
        renderAll();
      }
    });
  });
}

function renderAll(){
  renderSwitcherReadonly();
  const closures = pfGetClosures();
  renderRecap(closures);
  renderByStrategy(closures);
  renderClosuresTable(closures);
}

function init(){
  const versionEl = document.getElementById("appVersion");
  if(versionEl) versionEl.textContent = "v7.17.0";
  renderAll();
}

document.addEventListener("DOMContentLoaded", init);
