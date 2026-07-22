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
function analystBadgeHTML(label){
  if(!label) return '<span class="analyst-badge none">—</span>';
  const cls = label.toLowerCase().replace(' ','-');
  return `<span class="analyst-badge ${cls}">${label}</span>`;
}

async function loadIndexHistory(){
  try{
    const url = "./index-history.json?t=" + Date.now();
    const res = await fetchWithTimeout(url, {cache:"no-store"}, 10000);
    if(!res.ok) return null;
    const json = await res.json();
    return json && json.indices ? json : null;
  }catch(e){
    return null; // pas grave si absent — le graphique se dégrade proprement
  }
}

async function loadHoldingsHistory(){
  try{
    const url = "./holdings-history.json?t=" + Date.now();
    const res = await fetchWithTimeout(url, {cache:"no-store"}, 10000);
    if(!res.ok) return null;
    const json = await res.json();
    return json && json.prices ? json.prices : null;
  }catch(e){
    return null;
  }
}

async function loadFxRates(){
  try{
    const url = "./fx-rates.json?t=" + Date.now();
    const res = await fetchWithTimeout(url, {cache:"no-store"}, 10000);
    if(!res.ok) return null;
    const json = await res.json();
    return json && json.rates ? json.rates : null;
  }catch(e){
    return null;
  }
}

/** Convertit un montant depuis sa devise native vers l'euro. Si le taux
 * est inconnu (fx-rates.json absent, ou devise non couverte), retourne le
 * montant TEL QUEL (repli permissif — mieux vaut un total légèrement faux
 * mais visible que masquer une position entière). */
function toEUR(amount, currency, fxRates){
  if(amount == null) return null;
  if(!currency || currency === "EUR") return amount;
  if(!fxRates || fxRates[currency] == null) return amount;
  return amount * fxRates[currency];
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
  const fxRates = await loadFxRates();
  const missingFx = new Set();
  const bySymbol = {};
  snap.records.forEach(r=> bySymbol[r.symbol]=r );

  // ---- Calculs par position (en devise native + converti en euros) ----
  const rows = holdings.map(h=>{
    const live = bySymbol[h.symbol];
    const currentPrice = live ? live.price : null;
    const currency = currencyForCountry(h.country);
    if(currency !== "EUR" && (!fxRates || fxRates[currency] == null)) missingFx.add(currency);

    const costBasisNative = h.quantity * h.purchasePrice;
    const currentValueNative = currentPrice!=null ? h.quantity * currentPrice : null;
    const costBasis = toEUR(costBasisNative, currency, fxRates);
    const currentValue = currentValueNative!=null ? toEUR(currentValueNative, currency, fxRates) : null;
    const gain = currentValue!=null ? currentValue - costBasis : null;
    const gainPct = (currentValue!=null && costBasis>0) ? (gain/costBasis*100) : null;
    return { ...h, live, currency, currentPrice, costBasisNative, currentValueNative, costBasis, currentValue, gain, gainPct };
  });

  if(missingFx.size){
    toast(`Taux de change manquant pour : ${[...missingFx].join(', ')} — fx-rates.json absent ou incomplet. Ces positions sont additionnées sans conversion (totaux inexacts). Lance fetch_fx_rates.py.`);
  }

  const totalCost = rows.reduce((s,r)=>s+r.costBasis, 0);
  const totalValue = rows.reduce((s,r)=>s + (r.currentValue!=null ? r.currentValue : r.costBasis), 0);
  const totalGain = totalValue - totalCost;
  const totalGainPct = totalCost>0 ? (totalGain/totalCost*100) : null;

  renderSummary(totalCost, totalValue, totalGain, totalGainPct, rows.length);
  renderHoldingsTable(rows);

  // Enregistre un point d'historique (un seul par jour, écrasé si on revisite le même jour)
  // — toujours en euros, cohérent avec les totaux affichés.
  if(rows.length > 0){
    pfLogHistoryPoint(totalValue, totalCost);
  }

  await renderChart();
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
    <th class="num">Prix actuel</th><th class="num">Valeur (€)</th><th class="num">+/- value (€)</th><th class="num">Analystes</th><th></th>
  </tr></thead><tbody>`;
  rows.forEach(r=>{
    const cm = countryMeta(r.country);
    const gainClass = r.gain==null ? "" : (r.gain>=0 ? "pos" : "neg");
    const ccySuffix = r.currency && r.currency !== "EUR" ? ` ${r.currency}` : " €";
    html += `<tr>
      <td><span class="cname">${cm?flagHTML(r.country)+' ':''}${r.name}</span><span class="tkr" style="display:block;font-family:'IBM Plex Mono',monospace;font-size:0.76rem;color:var(--ink-faint);">${r.symbol}</span></td>
      <td class="num">${r.quantity}</td>
      <td class="num">${r.purchasePrice.toLocaleString('fr-FR',{maximumFractionDigits:2})}${ccySuffix}</td>
      <td>${r.purchaseDate}</td>
      <td class="num">${r.currentPrice!=null?r.currentPrice.toLocaleString('fr-FR',{maximumFractionDigits:2})+ccySuffix:'—'}</td>
      <td class="num">${r.currentValue!=null?fmtEUR(r.currentValue):fmtEUR(r.costBasis)+' *'}</td>
      <td class="num ${gainClass}">${r.gain!=null?fmtEUR(r.gain)+' ('+fmtPctSigned(r.gainPct)+')':'—'}</td>
      <td class="num">${analystBadgeHTML(r.live ? r.live.analystLabel : null)}</td>
      <td><button class="remove-btn" data-remove-id="${r.id}" title="Retirer du portefeuille">✕</button></td>
    </tr>`;
  });
  html += `</tbody></table>`;
  if(rows.some(r=>r.currency && r.currency !== "EUR")){
    html += `<div class="detail-note" style="margin-top:10px;">Prix d'achat et prix actuel affichés dans la devise native du titre. Valeur et plus/moins-value converties en euros au taux le plus récent disponible.</div>`;
  }
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

async function renderChart(){
  const history = pfGetHistory();
  const holdings = pfGetHoldings();
  const canvas = document.getElementById("pfChart");
  const emptyMsg = document.getElementById("chartEmptyMsg");
  const startInput = document.getElementById("chartStartDate");
  const benchmarkKeys = [...document.querySelectorAll('#benchmarkChips input:checked')].map(el=>el.value);

  const idxHist = benchmarkKeys.length ? await loadIndexHistory() : null;
  const holdingsPrices = holdings.length ? await loadHoldingsHistory() : null;
  const fxRates = holdings.length ? await loadFxRates() : null;

  if(!startInput.value){
    if(history.length) startInput.value = history[0].date;
    else {
      const d = new Date(); d.setFullYear(d.getFullYear()-1);
      startInput.value = d.toISOString().slice(0,10);
    }
  }
  const startDate = startInput.value;
  const filteredPf = history.filter(p=>p.date >= startDate);

  // --- Série rétroactive du portefeuille, à partir de l'historique réel de
  // chaque action (holdings-history.json) plutôt que du simple suivi
  // jour-par-jour depuis aujourd'hui. Si absente ou incomplète, on retombe
  // sur le suivi local habituel.
  let retroSeries = null;
  const missingHoldingsPrices = [];
  if(holdingsPrices && holdings.length){
    const seriesBySymbol = {};
    let richest = null;
    for(const h of holdings){
      const s = holdingsPrices[h.symbol];
      if(s && s.length){
        const sorted = [...s].sort((a,b)=>a.date.localeCompare(b.date));
        seriesBySymbol[h.symbol] = sorted;
        if(!richest || sorted.length > richest.length) richest = sorted;
      } else {
        missingHoldingsPrices.push(h.symbol);
      }
    }
    if(richest){
      const findClosest = (arr, date) => { let best=null; for(const p of arr){ if(p.date>date) break; best=p; } return best; };
      const candidateDates = richest.map(p=>p.date).filter(d=>d >= startDate);
      const computed = candidateDates.map(date=>{
        let total = 0, anyHeld = false;
        for(const h of holdings){
          if(h.purchaseDate > date) continue; // pas encore acheté à cette date
          anyHeld = true;
          const s = seriesBySymbol[h.symbol];
          const pt = s ? findClosest(s, date) : null;
          const price = pt ? pt.close : h.purchasePrice; // repli sur le prix d'achat si le titre manque à l'historique
          const priceEUR = toEUR(price, currencyForCountry(h.country), fxRates);
          total += h.quantity * priceEUR;
        }
        return anyHeld ? { date, totalValue: total } : null;
      }).filter(Boolean);
      if(computed.length >= 2) retroSeries = computed;
    }
  }
  if(missingHoldingsPrices.length){
    toast(`Historique de prix manquant pour : ${missingHoldingsPrices.join(', ')} — relance fetch_holdings_history.py pour les inclure. Prix d'achat utilisé en repli pour ces titres.`);
  }

  const hasRetroLine = !!retroSeries;
  const hasLocalPfLine = !hasRetroLine && filteredPf.length >= 1;

  // Choix des labels (axe des dates) : priorité à la série rétroactive
  // (la plus riche et la plus honnête), sinon un indice sélectionné, sinon
  // le suivi local jour-par-jour.
  let labels = [];
  let referenceSeries = null;
  const missing = [];
  const benchSeriesByKey = {};

  for(const key of benchmarkKeys){
    const series = idxHist && idxHist.indices ? idxHist.indices[key] : null;
    if(!series || !series.length){ missing.push(BENCHMARK_LABELS[key]); continue; }
    const sorted = [...series].sort((a,b)=>a.date.localeCompare(b.date)).filter(p=>p.date >= startDate);
    if(sorted.length < 2){ missing.push(BENCHMARK_LABELS[key]); continue; }
    benchSeriesByKey[key] = sorted;
    if(!referenceSeries || sorted.length > referenceSeries.length) referenceSeries = sorted;
  }
  if(missing.length){
    toast(`Pas assez d'historique pour : ${missing.join(', ')} (index-history.json absent, incomplet, ou période trop ancienne).`);
  }

  if(hasRetroLine && (!referenceSeries || retroSeries.length >= referenceSeries.length)){
    labels = retroSeries.map(p=>p.date);
  } else if(referenceSeries){
    labels = referenceSeries.map(p=>p.date);
  } else if(hasRetroLine){
    labels = retroSeries.map(p=>p.date);
  } else if(hasLocalPfLine){
    labels = filteredPf.map(p=>p.date);
  }

  if(labels.length < 2){
    canvas.style.display = "none";
    emptyMsg.style.display = "block";
    emptyMsg.textContent = (history.length===0 && benchmarkKeys.length===0)
      ? "Ajoute des positions et/ou coche un indice de comparaison ci-dessus pour voir un graphique."
      : "Rien à afficher sur cette période — élargis la plage de dates ou coche un indice.";
    if(chartInstance){ chartInstance.destroy(); chartInstance = null; }
    return;
  }
  canvas.style.display = "block";
  emptyMsg.style.display = "none";

  const datasets = [];

  if(hasRetroLine){
    const sorted = [...retroSeries].sort((a,b)=>a.date.localeCompare(b.date));
    const base = sorted[0].totalValue;
    const findPf = (date) => { let best=null; for(const p of sorted){ if(p.date>date) break; best=p; } return best; };
    const pfIndexed = labels.map(d => {
      const p = findPf(d);
      return p ? (base>0 ? p.totalValue/base*100 : 100) : null;
    });
    datasets.push({
      label: "Portefeuille (base 100, historique réel)",
      data: pfIndexed,
      borderColor: "#C9A24B",
      backgroundColor: "rgba(201,162,75,0.08)",
      fill: true,
      tension: 0.15,
      pointRadius: 2,
      spanGaps: false,
    });
  } else if(hasLocalPfLine){
    const pfSorted = [...filteredPf].sort((a,b)=>a.date.localeCompare(b.date));
    const pfBase = pfSorted[0].totalValue;
    // valeur du portefeuille à la date la plus proche <= d, ou null si on n'a
    // pas encore de données à ce moment-là (avant le début du suivi)
    const findPf = (date) => {
      let best = null;
      for(const p of pfSorted){ if(p.date > date) break; best = p; }
      return best;
    };
    const pfIndexed = labels.map(d => {
      const p = findPf(d);
      return p ? (pfBase>0 ? p.totalValue/pfBase*100 : 100) : null;
    });
    datasets.push({
      label: "Portefeuille (base 100)",
      data: pfIndexed,
      borderColor: "#C9A24B",
      backgroundColor: "rgba(201,162,75,0.08)",
      fill: true,
      tension: 0.15,
      pointRadius: 3,
      spanGaps: false,
    });
  }

  const benchColors = {FR:"#5B8A7A", EU:"#8B7CB6", US:"#C9704B", WORLD:"#4F8FBF"};
  for(const key of Object.keys(benchSeriesByKey)){
    const sorted = benchSeriesByKey[key];
    const findClosest = (date) => {
      let best = sorted[0];
      for(const pt of sorted){ if(pt.date > date) break; best = pt; }
      return best;
    };
    const benchBase = findClosest(startDate).close;
    const benchIndexed = labels.map(d => {
      const pt = findClosest(d);
      return pt ? (pt.close/benchBase*100) : null;
    });
    datasets.push({
      label: `${BENCHMARK_LABELS[key]} (base 100)`,
      data: benchIndexed,
      borderColor: benchColors[key] || "#5B8A7A",
      backgroundColor: "transparent",
      borderDash: [5,4],
      tension: 0.15,
      pointRadius: 0,
    });
  }

  if(typeof Chart === "undefined"){
    canvas.style.display = "none";
    emptyMsg.style.display = "block";
    emptyMsg.textContent = "La librairie de graphique (Chart.js) n'a pas pu se charger depuis le CDN — vérifie ta connexion ou un éventuel bloqueur de scripts, puis recharge la page.";
    return;
  }

  if(chartInstance) chartInstance.destroy();
  chartInstance = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#B8B3A1" } } },
      scales: {
        x: { ticks: { color: "#8C8878" }, grid: { color: "rgba(232,227,211,0.06)" } },
        y: { ticks: { color: "#8C8878" }, grid: { color: "rgba(232,227,211,0.06)" } },
      },
    },
  });
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
  if(versionEl) versionEl.textContent = "v5.7.0";
  renderPortfolio();
  document.getElementById("chartStartDate").addEventListener("change", renderChart);
  document.querySelectorAll('#benchmarkChips input[type=checkbox]').forEach(cb=>{
    cb.addEventListener("change", renderChart);
  });
  document.querySelectorAll('.quick-range-btn').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const today = new Date();
      let start;
      switch(btn.dataset.range){
        case "ytd": start = new Date(today.getFullYear(), 0, 1); break;
        case "1y": start = new Date(today); start.setFullYear(start.getFullYear()-1); break;
        case "3y": start = new Date(today); start.setFullYear(start.getFullYear()-3); break;
        case "5y": start = new Date(today); start.setFullYear(start.getFullYear()-5); break;
        default: start = today;
      }
      document.getElementById("chartStartDate").value = start.toISOString().slice(0,10);
      document.querySelectorAll('.quick-range-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      renderChart();
    });
  });

  document.getElementById("exportBtn").addEventListener("click", ()=>{
    pfDownloadExport();
    toast("Export téléchargé.");
  });

  document.getElementById("importBtn").addEventListener("click", ()=>{
    document.getElementById("importFile").click();
  });
  document.getElementById("importFile").addEventListener("change", (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      const hasExisting = pfGetHoldings().length > 0;
      let mode = "replace";
      if(hasExisting){
        mode = confirm(
          "Tu as déjà des positions enregistrées sur cet appareil.\n\n" +
          "OK = fusionner (garde l'existant + ajoute les nouvelles positions du fichier)\n" +
          "Annuler = tout remplacer par le contenu du fichier"
        ) ? "merge" : "replace";
      }
      const result = pfImportData(reader.result, mode);
      if(result.ok){
        toast(`Import réussi (${mode==='merge'?'fusion':'remplacement'}) — ${result.message}`);
        renderPortfolio();
      } else {
        toast("Échec de l'import : " + result.message);
      }
      e.target.value = ""; // permet de réimporter le même fichier si besoin
    };
    reader.readAsText(file);
  });
}

document.addEventListener("DOMContentLoaded", init);
