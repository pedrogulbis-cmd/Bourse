/* ===================================================================
   LE GRAND LIVRE — portfolio.js

   Deux choses honnêtes à savoir sur ce fichier :
   1. Le scraper ne fournit qu'un instantané (snapshot), jamais un
      historique de prix. Le graphique de valeur du portefeuille se
      construit donc UNIQUEMENT à partir d'aujourd'hui, un point par
      jour/visite — pas de données rétroactives possibles.
   2. Pour la même raison, on n'a pas de vrai niveau d'indice historique
      (CAC 40, S&P 500...) à comparer dans le temps. Ce qu'on affiche à
      la place est une comparaison de performance 6 mois/3 mois, calculée
      à l'instant présent à partir des mêmes données de momentum que le
      screener — c'est réel, mais c'est une photo, pas une courbe.
   =================================================================== */

const BENCHMARK_ZONES = {
  FR: ["FR"],
  EU: ["FR","DE","GB","NL","CH","ES","IT","BE","SE","DK","NO","FI","PT","AT","IE"],
  US: ["US"],
  WORLD: ["US","CA","FR","DE","GB","NL","CH","ES","IT","BE","SE","DK","NO","FI","PT","AT","IE","JP","AU","HK","SG","KR"],
};
const BENCHMARK_LABELS = {
  FR: "CAC 40 (France)", EU: "Indice européen", US: "S&P 500 (États-Unis)", WORLD: "Indice monde",
};

async function fetchWithTimeout(url, options, timeoutMs = 15000){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try{
    return await fetch(url, {...(options||{}), signal: controller.signal});
  }finally{
    clearTimeout(timer);
  }
}

async function loadSnapshot(){
  const url = "./data-snapshot.json?t=" + Date.now();
  const res = await fetchWithTimeout(url, {cache:"no-store"}, 15000);
  if(!res.ok) throw new Error("data-snapshot.json introuvable (HTTP "+res.status+")");
  const json = await res.json();
  if(!json || !Array.isArray(json.records)) throw new Error("Format de snapshot inattendu.");
  return json;
}

function fmtEUR(v){
  if(v===null||v===undefined||Number.isNaN(v)) return "—";
  return v.toLocaleString('fr-FR',{maximumFractionDigits:2}) + " €";
}
function fmtPctSigned(v){
  if(v===null||v===undefined||Number.isNaN(v)) return "—";
  return (v>=0?"+":"") + v.toFixed(1) + "%";
}

let chartInstance = null;

async function renderPortfolio(){
  const holdings = pfGetHoldings();
  let snap;
  try{
    snap = await loadSnapshot();
  }catch(err){
    document.getElementById("holdingsWrap").innerHTML = `<div class="empty-state">Impossible de charger data-snapshot.json : ${err.message}</div>`;
    return;
  }
  const bySymbol = {};
  snap.records.forEach(r=> bySymbol[r.symbol]=r );

  // ---- Calculs par position ----
  const rows = holdings.map(h=>{
    const live = bySymbol[h.symbol];
    const currentPrice = live ? live.price : null;
    const costBasis = h.quantity * h.purchasePrice;
    const currentValue = currentPrice!=null ? h.quantity * currentPrice : null;
    const gain = currentValue!=null ? currentValue - costBasis : null;
    const gainPct = (currentValue!=null && costBasis>0) ? (gain/costBasis*100) : null;
    return { ...h, live, currentPrice, costBasis, currentValue, gain, gainPct };
  });

  const totalCost = rows.reduce((s,r)=>s+r.costBasis, 0);
  const totalValue = rows.reduce((s,r)=>s + (r.currentValue!=null ? r.currentValue : r.costBasis), 0);
  const totalGain = totalValue - totalCost;
  const totalGainPct = totalCost>0 ? (totalGain/totalCost*100) : null;

  renderSummary(totalCost, totalValue, totalGain, totalGainPct, rows.length);
  renderHoldingsTable(rows);

  // Enregistre un point d'historique (un seul par jour, écrasé si on revisite le même jour)
  if(rows.length > 0){
    pfLogHistoryPoint(totalValue, totalCost);
  }

  renderChart(snap);
}

function renderSummary(totalCost, totalValue, totalGain, totalGainPct, nPositions){
  const el = document.getElementById("pfSummary");
  if(nPositions === 0){
    el.innerHTML = `<div class="card"><div class="lbl">Positions</div><div class="val">0</div></div>`;
    return;
  }
  const gainClass = totalGain>=0 ? "pos" : "neg";
  el.innerHTML = `
    <div class="card"><div class="lbl">Positions</div><div class="val">${nPositions}</div></div>
    <div class="card"><div class="lbl">Investi</div><div class="val">${fmtEUR(totalCost)}</div></div>
    <div class="card"><div class="lbl">Valeur actuelle</div><div class="val">${fmtEUR(totalValue)}</div></div>
    <div class="card"><div class="lbl">Plus/moins-value</div><div class="val ${gainClass}">${fmtEUR(totalGain)} (${fmtPctSigned(totalGainPct)})</div></div>
  `;
}

function renderHoldingsTable(rows){
  const wrap = document.getElementById("holdingsWrap");
  if(rows.length === 0){
    wrap.innerHTML = `<div class="empty-state"><div class="big">Portefeuille vide</div>Va sur le screener, clique le bouton "+" à côté d'une entreprise pour l'ajouter ici.</div>`;
    return;
  }
  let html = `<table class="holdings"><thead><tr>
    <th>Titre</th><th class="num">Qté</th><th class="num">Prix d'achat</th><th>Date d'achat</th>
    <th class="num">Prix actuel</th><th class="num">Valeur</th><th class="num">+/- value</th><th></th>
  </tr></thead><tbody>`;
  rows.forEach(r=>{
    const cm = countryMeta(r.country);
    const gainClass = r.gain==null ? "" : (r.gain>=0 ? "pos" : "neg");
    html += `<tr>
      <td><span class="cname">${cm?flagHTML(r.country)+' ':''}${r.name}</span><span class="tkr" style="display:block;font-family:'IBM Plex Mono',monospace;font-size:0.76rem;color:var(--ink-faint);">${r.symbol}</span></td>
      <td class="num">${r.quantity}</td>
      <td class="num">${fmtEUR(r.purchasePrice)}</td>
      <td>${r.purchaseDate}</td>
      <td class="num">${r.currentPrice!=null?fmtEUR(r.currentPrice):'—'}</td>
      <td class="num">${r.currentValue!=null?fmtEUR(r.currentValue):fmtEUR(r.costBasis)+' *'}</td>
      <td class="num ${gainClass}">${r.gain!=null?fmtEUR(r.gain)+' ('+fmtPctSigned(r.gainPct)+')':'—'}</td>
      <td><button class="remove-btn" data-remove-id="${r.id}" title="Retirer du portefeuille">✕</button></td>
    </tr>`;
  });
  html += `</tbody></table>`;
  if(rows.some(r=>r.currentPrice==null)){
    html += `<div class="detail-note" style="margin-top:10px;">* Titre absent du snapshot actuel (peut-être sorti de l'univers scrapé) — coût d'achat affiché à la place du prix live.</div>`;
  }
  wrap.innerHTML = html;

  wrap.querySelectorAll("[data-remove-id]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      if(confirm("Retirer cette position du portefeuille ?")){
        pfRemoveHolding(btn.dataset.removeId);
        renderPortfolio();
      }
    });
  });
}

function weightedMomentum(rows, field){
  const withPrice = rows.filter(r=>r.currentValue!=null && r.live && r.live[field]!=null);
  const totalW = withPrice.reduce((s,r)=>s+r.currentValue,0);
  if(totalW<=0) return null;
  return withPrice.reduce((s,r)=>s + r.live[field]*r.currentValue, 0) / totalW;
}

function simpleAvgMomentum(records, field){
  const vals = records.map(r=>r[field]).filter(v=>v!=null);
  if(vals.length===0) return null;
  return vals.reduce((a,b)=>a+b,0)/vals.length;
}

function renderChart(snap){
  const history = pfGetHistory();
  const canvas = document.getElementById("pfChart");
  const emptyMsg = document.getElementById("chartEmptyMsg");
  const startInput = document.getElementById("chartStartDate");
  if(!startInput.value && history.length){
    startInput.value = history[0].date;
  }
  const startDate = startInput.value || (history[0] && history[0].date) || new Date().toISOString().slice(0,10);
  const filtered = history.filter(p=>p.date >= startDate);

  if(filtered.length < 2){
    canvas.style.display = "none";
    emptyMsg.style.display = "block";
    emptyMsg.textContent = history.length===0
      ? "Aucun historique pour l'instant — reviens après avoir ajouté des positions et laissé passer au moins un jour pour voir la courbe se dessiner."
      : "Pas encore assez de points sur cette période pour tracer une courbe (un seul point enregistré jusqu'ici). Reviens dans les prochains jours.";
    if(chartInstance){ chartInstance.destroy(); chartInstance = null; }
    return;
  }
  canvas.style.display = "block";
  emptyMsg.style.display = "none";

  const labels = filtered.map(p=>p.date);
  const values = filtered.map(p=>p.totalValue);

  if(chartInstance) chartInstance.destroy();
  chartInstance = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Valeur du portefeuille (€)",
        data: values,
        borderColor: "#C9A24B",
        backgroundColor: "rgba(201,162,75,0.08)",
        fill: true,
        tension: 0.15,
        pointRadius: 3,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#B8B3A1" } } },
      scales: {
        x: { ticks: { color: "#8C8878" }, grid: { color: "rgba(232,227,211,0.06)" } },
        y: { ticks: { color: "#8C8878" }, grid: { color: "rgba(232,227,211,0.06)" } },
      },
    },
  });
}

function renderBenchmarkComparison(snap, rows){
  const zone = document.getElementById("benchmarkSelect").value;
  const note = document.getElementById("chartEmptyMsg");
  if(zone === "none") return;
  const countries = BENCHMARK_ZONES[zone];
  const benchPool = snap.records.filter(r=>countries.includes(r.country));
  const pf6 = weightedMomentum(rows, "mom6");
  const pf3 = weightedMomentum(rows, "mom3");
  const b6 = simpleAvgMomentum(benchPool, "mom6");
  const b3 = simpleAvgMomentum(benchPool, "mom3");
  toast(`Portefeuille 6M: ${fmtPctSigned(pf6)} vs ${BENCHMARK_LABELS[zone]} 6M: ${fmtPctSigned(b6)} (moyenne simple du pool, pas un vrai niveau d'indice) · 3M: ${fmtPctSigned(pf3)} vs ${fmtPctSigned(b3)}`);
}

function toast(msg){
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 6000);
}

function init(){
  const versionEl = document.getElementById("appVersion");
  if(versionEl) versionEl.textContent = "v5.0.0";
  renderPortfolio();
  document.getElementById("chartStartDate").addEventListener("change", renderPortfolio);
  document.getElementById("benchmarkSelect").addEventListener("change", async ()=>{
    const holdings = pfGetHoldings();
    if(holdings.length===0){ toast("Ajoute d'abord des positions depuis le screener."); return; }
    try{
      const snap = await loadSnapshot();
      const bySymbol = {}; snap.records.forEach(r=>bySymbol[r.symbol]=r);
      const rows = holdings.map(h=>{
        const live = bySymbol[h.symbol];
        const currentValue = live ? h.quantity*live.price : h.quantity*h.purchasePrice;
        return {...h, live, currentValue};
      });
      renderBenchmarkComparison(snap, rows);
    }catch(e){ toast("Erreur : " + e.message); }
  });
}

document.addEventListener("DOMContentLoaded", init);
