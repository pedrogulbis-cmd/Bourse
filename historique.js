/* ===================================================================
   LE GRAND LIVRE — historique.js
   Suivi des clôtures de portefeuille (bouton "Clôturer position" sur la
   page Portefeuille) — permet de comparer la performance réalisée par
   méthode/stratégie utilisée ET par portefeuille, au fil du temps.

   Toutes les clôtures de TOUS les portefeuilles sont chargées ensemble
   (pas de sélecteur de portefeuille séparé — les filtres ci-dessous
   couvrent ce besoin directement, avec une vue "Tous" par défaut).
   =================================================================== */

function fmtEUR(v){
  if(v===null||v===undefined||Number.isNaN(v)) return "—";
  return v.toLocaleString('fr-FR',{maximumFractionDigits:2}) + " €";
}
function fmtPctSigned(v){
  if(v===null||v===undefined||Number.isNaN(v)) return "—";
  return (v>=0?"+":"") + v.toFixed(1) + "%";
}

let allClosures = []; // toutes les clôtures de tous les portefeuilles, à plat, avec portfolioName/portfolioId ajoutés

function loadAllClosures(){
  const portfolios = pfGetPortfolios();
  const out = [];
  portfolios.forEach(p=>{
    (p.closures || []).forEach(c=>{
      out.push({ ...c, portfolioId: p.id, portfolioName: p.name });
    });
  });
  return out;
}

function computeStats(closures){
  const totalInvested = closures.reduce((s,c)=>s+(c.totalCostBasis||0), 0);
  const totalRealized = closures.reduce((s,c)=>s+(c.realizedGain||0), 0);
  const totalRealizedPct = totalInvested>0 ? (totalRealized/totalInvested*100) : null;
  return { count: closures.length, totalInvested, totalRealized, totalRealizedPct };
}

function renderStatsCards(wrap, stats, label){
  if(stats.count === 0){
    wrap.innerHTML = `<div class="card"><div class="lbl">${label}</div><div class="val">0 clôture</div></div>`;
    return;
  }
  const gainClass = stats.totalRealized>=0 ? "pos" : "neg";
  wrap.innerHTML = `
    <div class="card"><div class="lbl">${label} — clôtures</div><div class="val">${stats.count}</div></div>
    <div class="card"><div class="lbl">${label} — investi cumulé</div><div class="val">${fmtEUR(stats.totalInvested)}</div></div>
    <div class="card"><div class="lbl">${label} — plus/moins-value</div><div class="val ${gainClass}">${fmtEUR(stats.totalRealized)} (${fmtPctSigned(stats.totalRealizedPct)})</div></div>
  `;
}

function getFilters(){
  return {
    portfolioId: document.getElementById("filterPortfolio").value,
    strategy: document.getElementById("filterStrategy").value,
  };
}

function applyFilters(closures, filters){
  return closures.filter(c=>{
    if(filters.portfolioId && c.portfolioId !== filters.portfolioId) return false;
    if(filters.strategy && c.strategy !== filters.strategy) return false;
    return true;
  });
}

function populateFilterOptions(){
  const portfolioSel = document.getElementById("filterPortfolio");
  const strategySel = document.getElementById("filterStrategy");
  const currentPortfolio = portfolioSel.value;
  const currentStrategy = strategySel.value;

  const portfolios = pfGetPortfolios();
  portfolioSel.innerHTML = `<option value="">Tous</option>` +
    portfolios.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  portfolioSel.value = currentPortfolio;

  const strategiesSeen = {};
  allClosures.forEach(c=>{ strategiesSeen[c.strategy] = c.strategyName || c.strategy; });
  strategySel.innerHTML = `<option value="">Toutes</option>` +
    Object.entries(strategiesSeen).map(([id,name])=>`<option value="${id}">${name}</option>`).join('');
  strategySel.value = currentStrategy;
}

function renderByStrategy(closures){
  const wrap = document.getElementById("byStrategyWrap");
  if(closures.length === 0){
    wrap.innerHTML = `<div class="empty-state">Aucune clôture enregistrée — utilise le bouton "Clôturer position" sur la page Portefeuille pour commencer à suivre tes résultats par méthode.</div>`;
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
    wrap.innerHTML = `<div class="empty-state">Aucune clôture ne correspond à ces filtres.</div>`;
    return;
  }
  const sorted = [...closures].sort((a,b)=> b.closedDate.localeCompare(a.closedDate));

  let html = `<table class="results"><thead><tr>
    <th>Date de clôture</th><th>Portefeuille</th><th>Méthode</th><th class="num">Positions</th><th class="num">Investi</th><th class="num">Valeur à la clôture</th><th class="num">+/- value</th><th></th>
  </tr></thead><tbody>`;
  sorted.forEach(c=>{
    const gainClass = c.realizedGain>=0 ? "pos" : "neg";
    html += `<tr class="closure-row" data-closure-id="${c.id}" data-portfolio-id="${c.portfolioId}">
      <td>${c.closedDate}</td>
      <td>${c.portfolioName}</td>
      <td>${c.strategyName || c.strategy || "Autre"}</td>
      <td class="num">${c.positionCount}</td>
      <td class="num">${fmtEUR(c.totalCostBasis)}</td>
      <td class="num">${fmtEUR(c.totalValue)}</td>
      <td class="num ${gainClass}">${fmtEUR(c.realizedGain)} (${fmtPctSigned(c.realizedGainPct)})</td>
      <td><button class="remove-btn" data-remove-closure="${c.id}" data-portfolio-id="${c.portfolioId}" title="Supprimer cette ligne d'historique (ne restaure pas les positions)">✕</button></td>
    </tr>`;
  });
  html += `</tbody></table>`;
  wrap.innerHTML = html;

  wrap.querySelectorAll("tr.closure-row").forEach(row=>{
    row.addEventListener("click", (e)=>{
      if(e.target.closest("[data-remove-closure]")) return; // ne pas ouvrir le détail si on clique la croix
      const closure = sorted.find(c=>c.id===row.dataset.closureId);
      if(closure) openClosureDetailModal(closure);
    });
  });
  wrap.querySelectorAll("[data-remove-closure]").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.stopPropagation();
      if(confirm("Supprimer cette ligne d'historique ? Les positions ne seront PAS restaurées (action indépendante).")){
        pfRemoveClosure(btn.dataset.removeClosure, btn.dataset.portfolioId);
        renderAll();
      }
    });
  });
}

function openClosureDetailModal(closure){
  const positions = closure.positions || [];
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  let rowsHtml;
  if(positions.length === 0){
    rowsHtml = `<div class="empty-state" style="padding:20px 0;">Détail non disponible pour cette clôture (enregistrée avant l'ajout du détail par position).</div>`;
  } else {
    rowsHtml = `<table class="closure-detail-list"><thead><tr>
      <th>Titre</th><th>Qté</th><th>Prix d'achat</th><th>Prix à la clôture</th><th>+/- value</th>
    </tr></thead><tbody>` +
      positions.map(p=>{
        const gainClass = (p.gain||0)>=0 ? "pos" : "neg";
        const buyCcy = p.purchaseCcy && p.purchaseCcy!=='EUR' ? ` ${p.purchaseCcy}` : ' €';
        const sellCcy = p.currency && p.currency!=='EUR' ? ` ${p.currency}` : ' €';
        return `<tr>
          <td>${p.name || p.symbol}<br><span style="color:var(--ink-faint);font-size:0.8em;">${p.symbol}</span></td>
          <td>${p.quantity}</td>
          <td>${p.purchasePrice!=null?p.purchasePrice.toLocaleString('fr-FR',{maximumFractionDigits:2})+buyCcy:'—'}</td>
          <td>${p.currentPrice!=null?p.currentPrice.toLocaleString('fr-FR',{maximumFractionDigits:2})+sellCcy:'—'}</td>
          <td class="${gainClass}">${fmtEUR(p.gain)} (${fmtPctSigned(p.gainPct)})</td>
        </tr>`;
      }).join('') +
      `</tbody></table>`;
  }

  overlay.innerHTML = `
    <div class="modal-box" style="max-width:640px;">
      <h3>Clôture du ${closure.closedDate}</h3>
      <div class="modal-sub">${closure.portfolioName} — ${closure.strategyName || closure.strategy || "Autre"}</div>
      ${rowsHtml}
      <div class="modal-actions">
        <button class="btn-cancel" id="closureDetailClose">Fermer</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = ()=> overlay.remove();
  overlay.addEventListener("click", (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector("#closureDetailClose").addEventListener("click", close);
}

function renderAll(){
  allClosures = loadAllClosures();
  populateFilterOptions();

  const filters = getFilters();
  const filtered = applyFilters(allClosures, filters);

  const scopeLabel = (filters.portfolioId || filters.strategy) ? "(filtré)" : "";
  document.getElementById("recapScope").textContent = scopeLabel;

  renderStatsCards(document.getElementById("recapWrap"), computeStats(filtered), "Sélection");
  // Le récapitulatif global ne s'affiche que si un filtre est actif — sinon
  // il serait identique à "Sélection" et redondant.
  const globalWrap = document.getElementById("recapGlobalWrap");
  if(filters.portfolioId || filters.strategy){
    renderStatsCards(globalWrap, computeStats(allClosures), "Global (tous portefeuilles/méthodes)");
    globalWrap.style.display = "grid";
  } else {
    globalWrap.style.display = "none";
  }

  renderByStrategy(allClosures); // vue d'ensemble non filtrée, pour comparer toutes les méthodes d'un coup d'œil
  renderClosuresTable(filtered);
}

function init(){
  const versionEl = document.getElementById("appVersion");
  if(versionEl) versionEl.textContent = "v7.28.0";
  renderAll();
  document.getElementById("filterPortfolio").addEventListener("change", renderAll);
  document.getElementById("filterStrategy").addEventListener("change", renderAll);
}

document.addEventListener("DOMContentLoaded", init);
