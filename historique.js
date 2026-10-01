/* ===================================================================
   LE GRAND LIVRE — historique.js
   Suivi des clôtures de portefeuille (bouton "Clôturer position" sur la
   page Portefeuille) — permet de comparer la performance réalisée par
   méthode/stratégie utilisée ET par portefeuille, au fil du temps.

   Les clôtures sont rangées dans une liste commune, indépendante des
   portefeuilles : supprimer un portefeuille ne touche pas à son historique.
   Depuis ici, on peut supprimer une clôture, ou la restaurer (ses
   positions reviennent dans le portefeuille, recréé s'il a été supprimé).
   =================================================================== */

function fmtEUR(v){
  if(v===null||v===undefined||Number.isNaN(v)) return "—";
  return v.toLocaleString('fr-FR',{maximumFractionDigits:2}) + " €";
}
function fmtPctSigned(v){
  if(v===null||v===undefined||Number.isNaN(v)) return "—";
  return (v>=0?"+":"") + v.toFixed(1) + "%";
}
function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

let allClosures = []; // toutes les clôtures, portefeuilles supprimés compris

/** Clôtures avec le nom ACTUEL du portefeuille, ou son nom d'origine
 * marqué « supprimé » s'il n'existe plus. */
function loadAllClosures(){
  const portfolios = pfGetPortfolios();
  return pfGetAllClosures().map(c=>{
    const p = portfolios.find(x=>x.id === c.portfolioId);
    return { ...c, portfolioDeleted: !p, portfolioName: p ? p.name : (c.portfolioName || "Portefeuille") };
  });
}

/* Deux mesures pour chaque clôture :
   - plus/moins-value : variation des cours seule ;
   - rendement total : plus-value + dividendes bruts perçus pendant la
     détention (0 pour les clôtures enregistrées avant le suivi des dividendes). */
function closureGain(c){ return c.realizedGain || 0; }
function closureTotal(c){ return (c.realizedGain || 0) + (c.dividendsReceived || 0); }
function pctOf(v, base){ return base > 0 ? v / base * 100 : null; }

function computeStats(closures){
  const totalInvested = closures.reduce((s,c)=>s+(c.totalCostBasis||0), 0);
  const gain = closures.reduce((s,c)=>s+closureGain(c), 0);
  const dividends = closures.reduce((s,c)=>s+(c.dividendsReceived||0), 0);
  const total = gain + dividends;
  return { count: closures.length, totalInvested, gain, gainPct: pctOf(gain, totalInvested), dividends, total, totalPct: pctOf(total, totalInvested) };
}

function renderStatsCards(wrap, stats, label){
  if(stats.count === 0){
    wrap.innerHTML = `<div class="card"><div class="lbl">${label}</div><div class="val">0 clôture</div></div>`;
    return;
  }
  const cls = v => v>=0 ? "pos" : "neg";
  wrap.innerHTML = `
    <div class="card"><div class="lbl">${label} — clôtures</div><div class="val">${stats.count}</div></div>
    <div class="card"><div class="lbl">${label} — investi cumulé</div><div class="val">${fmtEUR(stats.totalInvested)}</div></div>
    <div class="card">
      <div class="lbl">${label} — plus/moins-value (hors dividendes)</div>
      <div class="val ${cls(stats.gain)}">${fmtEUR(stats.gain)} (${fmtPctSigned(stats.gainPct)})</div>
    </div>
    <div class="card">
      <div class="lbl">${label} — rendement total (dividendes inclus)</div>
      <div class="val ${cls(stats.total)}">${fmtEUR(stats.total)} (${fmtPctSigned(stats.totalPct)})</div>
      <div class="sub-lines"><span>dont ${fmtEUR(stats.dividends)} de dividendes bruts</span></div>
    </div>
  `;
}

function getFilters(){
  return {
    portfolioKey: document.getElementById("filterPortfolio").value,
    strategy: document.getElementById("filterStrategy").value,
  };
}

/* Un portefeuille supprimé n'a plus d'entrée dans la liste : on filtre
   donc sur une clé « id » pour les portefeuilles existants et « nom »
   pour ceux qui ont disparu. */
function portfolioKeyOf(c){ return c.portfolioDeleted ? "name:" + c.portfolioName : "id:" + c.portfolioId; }

function applyFilters(closures, filters){
  return closures.filter(c=>{
    if(filters.portfolioKey && portfolioKeyOf(c) !== filters.portfolioKey) return false;
    if(filters.strategy && c.strategy !== filters.strategy) return false;
    return true;
  });
}

function populateFilterOptions(){
  const portfolioSel = document.getElementById("filterPortfolio");
  const strategySel = document.getElementById("filterStrategy");
  const currentPortfolio = portfolioSel.value;
  const currentStrategy = strategySel.value;

  const options = pfGetPortfolios().map(p=>({ key: "id:" + p.id, label: p.name }));
  const deleted = [...new Set(allClosures.filter(c=>c.portfolioDeleted).map(c=>c.portfolioName))];
  deleted.forEach(name=> options.push({ key: "name:" + name, label: name + " (supprimé)" }));
  portfolioSel.innerHTML = `<option value="">Tous</option>` +
    options.map(o=>`<option value="${escapeHtml(o.key)}">${escapeHtml(o.label)}</option>`).join('');
  portfolioSel.value = options.some(o=>o.key === currentPortfolio) ? currentPortfolio : "";

  const strategiesSeen = {};
  allClosures.forEach(c=>{ strategiesSeen[c.strategy] = c.strategyName || c.strategy; });
  strategySel.innerHTML = `<option value="">Toutes</option>` +
    Object.entries(strategiesSeen).map(([id,name])=>`<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join('');
  strategySel.value = currentStrategy;
}

function gainCell(value, pct, extra){
  return `<td class="num ${value>=0?'pos':'neg'}">${fmtEUR(value)} (${fmtPctSigned(pct)})${extra||''}</td>`;
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
    (byStrategy[key] = byStrategy[key] || []).push(c);
  });

  const rows = Object.entries(byStrategy)
    .map(([name, list]) => ({ name, ...computeStats(list) }))
    .sort((a,b)=> (b.totalPct ?? -Infinity) - (a.totalPct ?? -Infinity));

  let html = `<table class="results"><thead><tr>
    <th>Méthode</th><th class="num">Clôtures</th><th class="num">Investi cumulé</th><th class="num">Plus/moins-value (hors div.)</th><th class="num">Rendement total (div. incl.)</th>
  </tr></thead><tbody>`;
  rows.forEach(r=>{
    html += `<tr>
      <td>${escapeHtml(r.name)}</td>
      <td class="num">${r.count}</td>
      <td class="num">${fmtEUR(r.totalInvested)}</td>
      ${gainCell(r.gain, r.gainPct)}
      ${gainCell(r.total, r.totalPct)}
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
    <th>Date de clôture</th><th>Portefeuille</th><th>Méthode</th><th class="num">Positions</th><th class="num">Investi</th><th class="num">Valeur à la clôture</th><th class="num">+/- value (hors div.)</th><th class="num">Rendement total (div. incl.)</th><th></th>
  </tr></thead><tbody>`;
  sorted.forEach(c=>{
    const canRestore = (c.positions || []).length > 0;
    html += `<tr class="closure-row" data-closure-id="${c.id}">
      <td data-label="Date">${c.closedDate}</td>
      <td data-label="Portefeuille">${escapeHtml(c.portfolioName)}${c.portfolioDeleted ? ` <span class="deleted-tag">supprimé</span>` : ''}</td>
      <td data-label="Méthode">${escapeHtml(c.strategyName || c.strategy || "Autre")}</td>
      <td class="num" data-label="Positions">${c.positionCount}</td>
      <td class="num" data-label="Investi">${fmtEUR(c.totalCostBasis)}</td>
      <td class="num" data-label="Valeur">${fmtEUR(c.totalValue)}</td>
      ${gainCell(closureGain(c), pctOf(closureGain(c), c.totalCostBasis) ?? c.realizedGainPct)}
      ${gainCell(closureTotal(c), pctOf(closureTotal(c), c.totalCostBasis) ?? c.realizedGainPct,
          c.dividendsReceived != null ? `<span class="cell-sub">dont ${fmtEUR(c.dividendsReceived)} de dividendes</span>` : `<span class="cell-sub">dividendes non suivis</span>`)}
      <td class="row-actions">
        ${canRestore ? `<button class="edit-btn" data-restore-closure="${c.id}" title="Restaurer : remettre ces positions dans le portefeuille${c.portfolioDeleted ? ' (recréé)' : ''} et retirer cette clôture">↺</button>` : ''}
        <button class="remove-btn" data-remove-closure="${c.id}" title="Supprimer cette ligne d'historique">✕</button>
      </td>
    </tr>`;
  });
  html += `</tbody></table>`;
  wrap.innerHTML = html;

  wrap.querySelectorAll("tr.closure-row").forEach(row=>{
    row.addEventListener("click", (e)=>{
      if(e.target.closest("button")) return; // ne pas ouvrir le détail si on clique un bouton
      const closure = sorted.find(c=>c.id===row.dataset.closureId);
      if(closure) openClosureDetailModal(closure);
    });
  });
  wrap.querySelectorAll("[data-remove-closure]").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.stopPropagation();
      if(confirm("Supprimer cette ligne d'historique ? Les positions ne seront PAS restaurées.")){
        pfRemoveClosure(btn.dataset.removeClosure);
        renderAll();
      }
    });
  });
  wrap.querySelectorAll("[data-restore-closure]").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.stopPropagation();
      const c = sorted.find(x=>x.id===btn.dataset.restoreClosure);
      if(c) restoreClosure(c);
    });
  });
}

function restoreClosure(c){
  const n = (c.positions || []).length;
  const where = c.portfolioDeleted
    ? `dans un portefeuille « ${c.portfolioName} » recréé`
    : `dans le portefeuille « ${c.portfolioName} »`;
  if(!confirm(`Restaurer cette clôture ?\n\nLes ${n} position(s) seront remises ${where}, et la clôture du ${c.closedDate} sera retirée de l'historique.`)) return;
  const res = pfRestoreClosure(c.id);
  alert(res.message);
  renderAll();
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
      <th>Titre</th><th>Qté</th><th>Prix d'achat</th><th>Prix à la clôture</th><th>+/- value</th><th>Avec dividendes</th>
    </tr></thead><tbody>` +
      positions.map(p=>{
        const total = (p.gain||0) + (p.dividendsReceived||0);
        const buyCcy = p.purchaseCcy && p.purchaseCcy!=='EUR' ? ` ${p.purchaseCcy}` : ' €';
        const sellCcy = p.currency && p.currency!=='EUR' ? ` ${p.currency}` : ' €';
        return `<tr>
          <td>${escapeHtml(p.name || p.symbol)}<br><span style="color:var(--ink-faint);font-size:0.8em;">${escapeHtml(p.symbol)}</span></td>
          <td>${p.quantity}</td>
          <td>${p.purchasePrice!=null?p.purchasePrice.toLocaleString('fr-FR',{maximumFractionDigits:2})+buyCcy:'—'}</td>
          <td>${p.currentPrice!=null?p.currentPrice.toLocaleString('fr-FR',{maximumFractionDigits:2})+sellCcy:'—'}</td>
          <td class="${(p.gain||0)>=0?'pos':'neg'}">${fmtEUR(p.gain)} (${fmtPctSigned(p.gainPct)})</td>
          <td class="${total>=0?'pos':'neg'}">${p.dividendsReceived!=null ? `${fmtEUR(total)} (${fmtPctSigned(pctOf(total, p.costBasis))})` : '—'}</td>
        </tr>`;
      }).join('') +
      `</tbody></table>`;
  }

  const canRestore = positions.length > 0;
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:720px;">
      <h3>Clôture du ${closure.closedDate}</h3>
      <div class="modal-sub">${escapeHtml(closure.portfolioName)}${closure.portfolioDeleted ? ' (supprimé)' : ''} — ${escapeHtml(closure.strategyName || closure.strategy || "Autre")}</div>
      <div style="overflow-x:auto;">${rowsHtml}</div>
      <div class="modal-actions">
        <button class="btn-cancel" id="closureDetailClose">Fermer</button>
        ${canRestore ? `<button class="btn-confirm" id="closureDetailRestore">↺ Restaurer</button>` : ''}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = ()=> overlay.remove();
  overlay.addEventListener("click", (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector("#closureDetailClose").addEventListener("click", close);
  const rb = overlay.querySelector("#closureDetailRestore");
  if(rb) rb.addEventListener("click", ()=>{ close(); restoreClosure(closure); });
}

function renderAll(){
  allClosures = loadAllClosures();
  populateFilterOptions();

  const filters = getFilters();
  const filtered = applyFilters(allClosures, filters);

  const scopeLabel = (filters.portfolioKey || filters.strategy) ? "(filtré)" : "";
  document.getElementById("recapScope").textContent = scopeLabel;

  renderStatsCards(document.getElementById("recapWrap"), computeStats(filtered), "Sélection");
  // Le récapitulatif global ne s'affiche que si un filtre est actif — sinon
  // il serait identique à "Sélection" et redondant.
  const globalWrap = document.getElementById("recapGlobalWrap");
  if(filters.portfolioKey || filters.strategy){
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
  if(versionEl) versionEl.textContent = "v7.40.0";
  renderAll();
  document.getElementById("filterPortfolio").addEventListener("change", renderAll);
  document.getElementById("filterStrategy").addEventListener("change", renderAll);
}

document.addEventListener("DOMContentLoaded", init);
