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

/* ---------------------------------------------------------------
   Comparaison à un indice sur la même période
   Chaque position est comparée à l'indice entre SA date d'achat et la
   date de clôture, puis on pondère par le montant investi : c'est le
   rendement qu'aurait donné le même argent placé dans l'indice, aux mêmes
   dates. Les indices sont des indices de prix (sans dividendes) : la
   comparaison juste est donc avec la plus-value HORS dividendes.
   --------------------------------------------------------------- */
const HIST_BENCHMARKS = { FR: "CAC 40", EU: "Indice européen", US: "S&P 500", WORLD: "Indice monde" };
const HIST_BENCH_KEY = "lgl_hist_benchmark";
let indexHistory = null; // { FR: [{date, close}], ... } trié par date

function getBenchmark(){
  try{
    const v = localStorage.getItem(HIST_BENCH_KEY);
    if(v === "" || HIST_BENCHMARKS[v]) return v;
  }catch(e){}
  return "FR";
}
function setBenchmark(v){ try{ localStorage.setItem(HIST_BENCH_KEY, v); }catch(e){} }

async function loadIndexHistoryForHist(){
  try{
    const res = await fetchWithTimeout("./index-history.json?t=" + Date.now(), {cache:"no-store"}, 10000);
    if(!res.ok) return null;
    const json = await res.json();
    if(!json || !json.indices) return null;
    const out = {};
    Object.entries(json.indices).forEach(([k, s])=>{ out[k] = [...s].sort((a,b)=>a.date.localeCompare(b.date)); });
    return out;
  }catch(e){ return null; }
}

/** Clôture de l'indice au plus tard à `date` (null si la date précède l'historique). */
function indexCloseAt(series, date){
  if(!series || !series.length || !date || date < series[0].date) return null;
  let lo = 0, hi = series.length - 1;
  while(lo < hi){
    const mid = (lo + hi + 1) >> 1;
    if(series[mid].date <= date) lo = mid; else hi = mid - 1;
  }
  return series[lo].close;
}
function indexReturnPct(key, from, to){
  const s = indexHistory && indexHistory[key];
  const a = indexCloseAt(s, from), b = indexCloseAt(s, to);
  return (a && b) ? (b / a - 1) * 100 : null;
}
function positionStartDate(c, p){
  return (p.holding && p.holding.purchaseDate) || p.purchaseDate || c.startDate || null;
}

/** Rendement de l'indice pour une clôture, pondéré par le coût de chaque
 * position. Renvoie { pct, coveredCost, partial } ou null. */
function closureBenchmark(c, key){
  if(!key || !indexHistory) return null;
  const positions = c.positions || [];
  let weighted = 0, covered = 0;
  if(positions.length){
    positions.forEach(p=>{
      const r = indexReturnPct(key, positionStartDate(c, p), c.closedDate);
      const w = p.costBasis || 0;
      if(r != null && w > 0){ weighted += r * w; covered += w; }
    });
  } else if(c.startDate){
    const r = indexReturnPct(key, c.startDate, c.closedDate);
    if(r != null){ weighted = r * (c.totalCostBasis || 1); covered = c.totalCostBasis || 1; }
  }
  if(!covered) return null;
  const total = positions.length ? positions.reduce((s,p)=>s+(p.costBasis||0), 0) : covered;
  return { pct: weighted / covered, coveredCost: covered, partial: covered < total * 0.999 };
}
function benchMissingReason(c){
  if(!indexHistory) return "Historique des indices indisponible (index-history.json).";
  const dated = (c.positions || []).some(p=>positionStartDate(c, p)) || c.startDate;
  return dated ? "Période antérieure à l'historique de l'indice." : "Date d'achat inconnue (clôture ancienne) — ouvre le détail pour saisir une date de début.";
}
function fmtPts(v){ return v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(1) + " pts"; }

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
  // Indice : moyenne pondérée par le coût, et NOTRE performance recalculée
  // sur les seules clôtures comparables (sinon l'écart serait faussé).
  const key = getBenchmark();
  let bW = 0, bCost = 0, oGain = 0, oTotal = 0, oCost = 0, nBench = 0;
  closures.forEach(c=>{
    const b = closureBenchmark(c, key);
    if(!b) return;
    nBench++;
    bW += b.pct * b.coveredCost; bCost += b.coveredCost;
    oGain += closureGain(c); oTotal += closureTotal(c); oCost += c.totalCostBasis || 0;
  });
  const bench = bCost ? {
    pct: bW / bCost, n: nBench,
    gapGain: pctOf(oGain, oCost) - bW / bCost,
    gapTotal: pctOf(oTotal, oCost) - bW / bCost,
  } : null;
  return { count: closures.length, totalInvested, gain, gainPct: pctOf(gain, totalInvested), dividends, total, totalPct: pctOf(total, totalInvested), bench };
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
    ${benchCard(stats, label)}
  `;
}

function benchCard(stats, label){
  const key = getBenchmark();
  if(!key) return "";
  const name = HIST_BENCHMARKS[key];
  if(!stats.bench){
    return `<div class="card"><div class="lbl">${label} — ${name} sur les mêmes périodes</div><div class="val">—</div>
      <div class="sub-lines"><span>${indexHistory ? "Aucune clôture avec des dates d'achat connues." : "Historique des indices indisponible."}</span></div></div>`;
  }
  const b = stats.bench;
  return `<div class="card">
    <div class="lbl">${label} — ${name} sur les mêmes périodes</div>
    <div class="val">${fmtPctSigned(b.pct)}</div>
    <div class="sub-lines">
      <span class="${b.gapGain>=0?'pos':'neg'}">Écart hors dividendes : ${fmtPts(b.gapGain)}</span>
      <span class="${b.gapTotal>=0?'pos':'neg'}">Écart dividendes inclus : ${fmtPts(b.gapTotal)}</span>
      ${b.n < stats.count ? `<span>sur ${b.n} clôture(s) sur ${stats.count} (dates connues)</span>` : ''}
    </div>
  </div>`;
}

/** Cellule « indice même période » d'une ligne (clôture ou méthode). */
function benchCell(ourGainPct, ourTotalPct, bench, missingTitle){
  if(!getBenchmark()) return "";
  if(!bench) return `<td class="num" data-label="${HIST_BENCHMARKS[getBenchmark()]}" title="${escapeHtml(missingTitle || "")}">—</td>`;
  const gap = ourGainPct != null ? ourGainPct - bench.pct : null;
  const gapT = ourTotalPct != null ? ourTotalPct - bench.pct : null;
  return `<td class="num" data-label="${HIST_BENCHMARKS[getBenchmark()]}">${fmtPctSigned(bench.pct)}${bench.partial ? ' <span title="Calculé sur une partie des positions seulement (dates manquantes)">*</span>' : ''}
    <span class="cell-sub ${gap>=0?'pos':'neg'}">${fmtPts(gap)} hors div.</span>
    <span class="cell-sub ${gapT>=0?'pos':'neg'}">${fmtPts(gapT)} avec div.</span></td>`;
}
function benchHeader(){
  const key = getBenchmark();
  return key ? `<th class="num">${HIST_BENCHMARKS[key]} (même période)</th>` : "";
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
    <th>Méthode</th><th class="num">Clôtures</th><th class="num">Investi cumulé</th><th class="num">Plus/moins-value (hors div.)</th><th class="num">Rendement total (div. incl.)</th>${benchHeader()}
  </tr></thead><tbody>`;
  rows.forEach(r=>{
    html += `<tr>
      <td>${escapeHtml(r.name)}</td>
      <td class="num">${r.count}</td>
      <td class="num">${fmtEUR(r.totalInvested)}</td>
      ${gainCell(r.gain, r.gainPct)}
      ${gainCell(r.total, r.totalPct)}
      ${getBenchmark() ? (r.bench
        ? benchCell(r.bench.pct + r.bench.gapGain, r.bench.pct + r.bench.gapTotal, { pct: r.bench.pct, partial: r.bench.n < r.count })
        : benchCell(null, null, null, "Aucune clôture de cette méthode avec des dates d'achat connues.")) : ""}
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
    <th>Date de clôture</th><th>Portefeuille</th><th>Méthode</th><th class="num">Positions</th><th class="num">Investi</th><th class="num">Valeur à la clôture</th><th class="num">+/- value (hors div.)</th><th class="num">Rendement total (div. incl.)</th>${benchHeader()}<th></th>
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
      ${benchCell(pctOf(closureGain(c), c.totalCostBasis), pctOf(closureTotal(c), c.totalCostBasis), closureBenchmark(c, getBenchmark()), benchMissingReason(c))}
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
      <th>Titre</th><th>Achat</th><th>Qté</th><th>Prix d'achat</th><th>Prix à la clôture</th><th>+/- value</th><th>Avec dividendes</th>${getBenchmark() ? `<th>${HIST_BENCHMARKS[getBenchmark()]} même période</th>` : ''}
    </tr></thead><tbody>` +
      positions.map(p=>{
        const total = (p.gain||0) + (p.dividendsReceived||0);
        const buyCcy = p.purchaseCcy && p.purchaseCcy!=='EUR' ? ` ${p.purchaseCcy}` : ' €';
        const sellCcy = p.currency && p.currency!=='EUR' ? ` ${p.currency}` : ' €';
        return `<tr>
          <td>${escapeHtml(p.name || p.symbol)}<br><span style="color:var(--ink-faint);font-size:0.8em;">${escapeHtml(p.symbol)}</span></td>
          <td>${positionStartDate(closure, p) || '—'}</td>
          <td>${p.quantity}</td>
          <td>${p.purchasePrice!=null?p.purchasePrice.toLocaleString('fr-FR',{maximumFractionDigits:2})+buyCcy:'—'}</td>
          <td>${p.currentPrice!=null?p.currentPrice.toLocaleString('fr-FR',{maximumFractionDigits:2})+sellCcy:'—'}</td>
          <td class="${(p.gain||0)>=0?'pos':'neg'}">${fmtEUR(p.gain)} (${fmtPctSigned(p.gainPct)})</td>
          <td class="${total>=0?'pos':'neg'}">${p.dividendsReceived!=null ? `${fmtEUR(total)} (${fmtPctSigned(pctOf(total, p.costBasis))})` : '—'}</td>
          ${getBenchmark() ? (()=>{ const r = indexReturnPct(getBenchmark(), positionStartDate(closure, p), closure.closedDate);
            return `<td>${r==null ? '—' : `${fmtPctSigned(r)}<br><span class="${(p.gainPct-r)>=0?'pos':'neg'}" style="font-size:0.8em;">${p.gainPct!=null ? fmtPts(p.gainPct - r) : ""}</span>`}</td>`; })() : ''}
        </tr>`;
      }).join('') +
      `</tbody></table>`;
  }

  const canRestore = positions.length > 0;
  // Clôture ancienne sans date d'achat : on peut saisir le début de période
  // pour pouvoir la comparer à un indice.
  const undated = !(positions.some(p=>(p.holding && p.holding.purchaseDate) || p.purchaseDate));
  const startField = undated ? `
      <div class="modal-field" style="margin-top:14px;">
        <label>Date de début de la période (date d'achat inconnue pour cette clôture ancienne)</label>
        <div style="display:flex;gap:8px;">
          <input type="date" id="closureStartDate" value="${closure.startDate || ''}" max="${closure.closedDate}">
          <button class="btn-io" id="closureStartSave">Enregistrer</button>
        </div>
      </div>` : '';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:720px;">
      <h3>Clôture du ${closure.closedDate}</h3>
      <div class="modal-sub">${escapeHtml(closure.portfolioName)}${closure.portfolioDeleted ? ' (supprimé)' : ''} — ${escapeHtml(closure.strategyName || closure.strategy || "Autre")}</div>
      <div style="overflow-x:auto;">${rowsHtml}</div>
      ${startField}
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
  const sb = overlay.querySelector("#closureStartSave");
  if(sb) sb.addEventListener("click", ()=>{
    const v = overlay.querySelector("#closureStartDate").value;
    pfUpdateClosure(closure.id, { startDate: v || undefined });
    close();
    renderAll();
  });
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

async function init(){
  const versionEl = document.getElementById("appVersion");
  if(versionEl) versionEl.textContent = "v7.41.0";
  const benchSel = document.getElementById("filterBenchmark");
  benchSel.value = getBenchmark();
  renderAll();
  document.getElementById("filterPortfolio").addEventListener("change", renderAll);
  document.getElementById("filterStrategy").addEventListener("change", renderAll);
  benchSel.addEventListener("change", ()=>{ setBenchmark(benchSel.value); renderAll(); });
  indexHistory = await loadIndexHistoryForHist();
  renderAll();
}

document.addEventListener("DOMContentLoaded", init);
