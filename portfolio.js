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
  EU: ["FR","DE","GB","NL","CH","ES","IT","BE","SE","DK","NO","FI","PT","AT","IE","LU","PL"],
  US: ["US"],
  WORLD: ["US","CA","FR","DE","GB","NL","CH","ES","IT","BE","SE","DK","NO","FI","PT","AT","IE","LU","PL","JP","AU","HK","SG","KR"],
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
function homeCountryBadge(live){
  if(!live || !live.homeCountry) return '';
  if(live.homeCountryCode && live.homeCountryCode === live.country) return '';
  return `<span class="home-badge" title="Domicile réel : ${live.homeCountry} — coté ici sur un autre marché (ADR, cross-listing...)">🌐</span>`;
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
  // GBX (pence sterling) n'a pas son propre taux fetché — dérivé du taux
  // GBP (1 GBP = 100 GBX), pour éviter d'avoir à interroger une devise de
  // plus côté scraper.
  if(currency === "GBX"){
    if(!fxRates || fxRates["GBP"] == null) return amount / 100; // repli grossier si même le taux GBP manque
    return (amount / 100) * fxRates["GBP"];
  }
  if(!fxRates || fxRates[currency] == null) return amount;
  return amount * fxRates[currency];
}

/** true si toEUR() pourra réellement convertir cette devise (taux
 * disponible), false si elle retombera sur le montant brut non converti —
 * sert à afficher un avertissement visible plutôt qu'un "€" trompeur. */
function fxRateAvailable(currency, fxRates){
  if(!currency || currency === "EUR") return true;
  if(currency === "GBX") return !!(fxRates && fxRates["GBP"] != null);
  return !!(fxRates && fxRates[currency] != null);
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
    // Devise réelle du prix ACTUEL : priorité au champ listedCurrency du
    // snapshot (gère GBX correctement), repli sur la déduction par pays si absent.
    const currency = resolveListedCurrency(live || h);
    if(currency !== "EUR" && (!fxRates || (currency !== "GBX" && fxRates[currency] == null) || (currency === "GBX" && fxRates["GBP"] == null))) missingFx.add(currency);

    // Le prix d'achat a pu être saisi soit dans la devise native du titre,
    // soit directement en euros (courtier qui convertit à l'achat) — voir
    // h.priceCurrency, choisi au moment de l'ajout. On ne convertit QUE si
    // besoin.
    const purchaseCcy = h.priceCurrency || currency; // repli : ancien holding sans ce champ -> devise native, comme avant
    const costBasisNative = h.quantity * h.purchasePrice;
    const currentValueNative = currentPrice!=null ? h.quantity * currentPrice : null;
    const costBasis = purchaseCcy === "EUR" ? costBasisNative : toEUR(costBasisNative, currency, fxRates);
    const currentValue = currentValueNative!=null ? toEUR(currentValueNative, currency, fxRates) : null;
    const gain = currentValue!=null ? currentValue - costBasis : null;
    const gainPct = (currentValue!=null && costBasis>0) ? (gain/costBasis*100) : null;
    const fxOk = fxRateAvailable(currency, fxRates) && fxRateAvailable(purchaseCcy, fxRates);
    return { ...h, live, currency, purchaseCcy, currentPrice, costBasisNative, currentValueNative, costBasis, currentValue, gain, gainPct, fxOk };
  });

  if(missingFx.size){
    toast(`Taux de change manquant pour : ${[...missingFx].join(', ')} — fx-rates.json absent ou incomplet. Ces positions sont additionnées sans conversion (totaux inexacts). Lance fetch_fx_rates.py.`);
  }

  const totalCost = rows.reduce((s,r)=>s+r.costBasis, 0);
  const totalValue = rows.reduce((s,r)=>s + (r.currentValue!=null ? r.currentValue : r.costBasis), 0);
  const totalGain = totalValue - totalCost;
  const totalGainPct = totalCost>0 ? (totalGain/totalCost*100) : null;
  // Dividende attendu = valeur actuelle de la position × rendement du dividende
  // du titre (hors rachats d'actions, qui ne sont pas un revenu perçu).
  const dividendIncome = rows.reduce((s,r)=>{
    const val = r.currentValue!=null ? r.currentValue : r.costBasis;
    const dy = r.live ? r.live.divYield : null;
    return s + (dy!=null ? val*dy : 0);
  }, 0);

  const cashList = pfGetCash();
  const cashRows = cashList.map(c=>({ ...c, valueEUR: toEUR(c.amount, c.currency, fxRates) }));
  const totalCash = cashRows.reduce((s,c)=>s+(c.valueEUR||0), 0);

  renderSummary(totalCost, totalValue, totalGain, totalGainPct, rows.length, dividendIncome, totalCash);
  renderHoldingsTable(rows);
  renderCash(cashRows);
  renderAllocation(rows);


  // Enregistre un point d'historique (un seul par jour, écrasé si on revisite le même jour)
  // — toujours en euros, cash inclus, cohérent avec les totaux affichés.
  if(rows.length > 0 || cashRows.length > 0){
    pfLogHistoryPoint(totalValue + totalCash, totalCost);
  }

  await renderChart();
}

function renderSummary(totalCost, totalValue, totalGain, totalGainPct, nPositions, dividendIncome, totalCash){
  const el = document.getElementById("pfSummary");
  const grandTotal = totalValue + (totalCash||0);
  if(nPositions === 0 && !totalCash){
    el.innerHTML = `<div class="card"><div class="lbl">Positions</div><div class="val">0</div></div>`;
    return;
  }
  const gainClass = totalGain>=0 ? "pos" : "neg";
  const yieldOnCost = totalCost>0 ? (dividendIncome/totalCost*100) : null;
  el.innerHTML = `
    <div class="card"><div class="lbl">Positions</div><div class="val">${nPositions}</div></div>
    <div class="card"><div class="lbl">Investi</div><div class="val">${fmtEUR(totalCost)}</div></div>
    <div class="card"><div class="lbl">Valeur totale</div><div class="val">${fmtEUR(grandTotal)}${totalCash?` <span style="font-size:0.5em;color:var(--ink-faint);">(dont ${fmtEUR(totalCash)} cash)</span>`:''}</div></div>
    <div class="card"><div class="lbl">Plus/moins-value</div><div class="val ${gainClass}">${fmtEUR(totalGain)} (${fmtPctSigned(totalGainPct)})</div></div>
    <div class="card"><div class="lbl">Dividendes attendus (12M)</div><div class="val">${fmtEUR(dividendIncome)}${yieldOnCost!=null?` <span style="font-size:0.55em;color:var(--ink-faint);">(${yieldOnCost.toFixed(1)}% du coût)</span>`:''}</div></div>
  `;
}

function renderCash(cashRows){
  const wrap = document.getElementById("cashWrap");
  if(!wrap) return;
  let html = `<div class="cash-list">`;
  cashRows.forEach(c=>{
    html += `<div class="cash-row">
      <span class="cash-label">${c.label}</span>
      <span class="cash-amount">${c.amount.toLocaleString('fr-FR',{maximumFractionDigits:2})} ${c.currency}${c.currency!=='EUR'?` <span class="cash-eur">(${fmtEUR(c.valueEUR)})</span>`:''}</span>
      <button class="edit-btn" data-cash-edit="${c.id}" title="Modifier">✎</button>
      <button class="remove-btn" data-cash-remove="${c.id}" title="Retirer">✕</button>
    </div>`;
  });
  html += `<button class="pf-add-btn" id="addCashBtn">+ Ajouter du cash</button>`;
  html += `</div>`;
  wrap.innerHTML = html;

  wrap.querySelectorAll("[data-cash-remove]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      if(confirm("Retirer cette ligne de cash ?")){
        pfRemoveCash(btn.dataset.cashRemove);
        renderPortfolio();
      }
    });
  });
  wrap.querySelectorAll("[data-cash-edit]").forEach(btn=>{
    btn.addEventListener("click", ()=> openCashModal(btn.dataset.cashEdit));
  });
  document.getElementById("addCashBtn").addEventListener("click", ()=> openCashModal(null));
}

function openCashModal(cashId){
  const existing = cashId ? pfGetCash().find(c=>c.id===cashId) : null;
  const currencies = ["EUR","USD","GBP","GBX","CHF","JPY","CAD","AUD","HKD","SGD","KRW","SEK","DKK","NOK","PLN"];
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>${existing ? "Modifier le cash" : "Ajouter du cash"}</h3>
      <div class="modal-sub">Argent disponible, pas encore investi — compté dans la valeur totale.</div>
      <div class="modal-field">
        <label>Libellé (optionnel)</label>
        <input type="text" id="cashLabel" value="${existing ? existing.label : ''}" placeholder="ex. Liquidités DEGIRO">
      </div>
      <div class="modal-field">
        <label>Montant</label>
        <div style="display:flex;gap:8px;">
          <input type="number" id="cashAmount" value="${existing ? existing.amount : ''}" min="0" step="any" style="flex:1;">
          <select id="cashCcy" style="width:90px;background:var(--paper);border:1px solid var(--hairline-bright);color:var(--ink);border-radius:4px;font-family:'IBM Plex Mono',monospace;font-size:0.85rem;">
            ${currencies.map(c=>`<option value="${c}" ${(existing?existing.currency:'EUR')===c?'selected':''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" id="cashCancel">Annuler</button>
        <button class="btn-confirm" id="cashConfirm">${existing ? "Enregistrer" : "Ajouter"}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = ()=> overlay.remove();
  overlay.addEventListener("click", (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector("#cashCancel").addEventListener("click", close);
  overlay.querySelector("#cashConfirm").addEventListener("click", ()=>{
    const amount = parseFloat(overlay.querySelector("#cashAmount").value);
    const currency = overlay.querySelector("#cashCcy").value;
    const label = overlay.querySelector("#cashLabel").value.trim() || "Liquidités";
    if(isNaN(amount)){ toast("Montant invalide."); return; }
    if(existing){
      pfUpdateCash(existing.id, { amount, currency, label });
    } else {
      pfAddCash({ amount, currency, label });
    }
    close();
    renderPortfolio();
  });
}

function renderHoldingsTable(rows){
  const wrap = document.getElementById("holdingsWrap");
  if(rows.length === 0){
    wrap.innerHTML = `<div class="empty-state"><div class="big">Portefeuille vide</div>Va sur le screener, clique le bouton "+" à côté d'une entreprise pour l'ajouter ici.</div>`;
    return;
  }
  const otherPortfolios = pfGetPortfolios().filter(p=>p.id !== pfGetActivePortfolioId());
  let html = `<table class="holdings"><thead><tr>
    <th>Titre</th><th class="num">Qté</th><th class="num">Prix d'achat</th><th>Date d'achat</th>
    <th class="num">Prix actuel</th><th class="num">Valeur (€)</th><th class="num">+/- value (€)</th><th class="num">Analystes</th><th></th>
  </tr></thead><tbody>`;
  rows.forEach(r=>{
    const cm = countryMeta(r.country);
    const gainClass = r.gain==null ? "" : (r.gain>=0 ? "pos" : "neg");
    const ccySuffix = r.currency && r.currency !== "EUR" ? ` ${r.currency}` : " €";
    const purchaseCcySuffix = r.purchaseCcy && r.purchaseCcy !== "EUR" ? ` ${r.purchaseCcy}` : " €";
    html += `<tr${!r.fxOk?' class="fx-warn"':''}>
      <td><span class="cname">${cm?flagHTML(r.country)+' ':''}${r.name}${r.live?homeCountryBadge(r.live):''}</span><span class="tkr" style="display:block;font-family:'IBM Plex Mono',monospace;font-size:0.76rem;color:var(--ink-faint);">${r.symbol}</span></td>
      <td class="num">${r.quantity}</td>
      <td class="num">${r.purchasePrice.toLocaleString('fr-FR',{maximumFractionDigits:2})}${purchaseCcySuffix}</td>
      <td>${r.purchaseDate}</td>
      <td class="num">${r.currentPrice!=null?r.currentPrice.toLocaleString('fr-FR',{maximumFractionDigits:2})+ccySuffix:'—'}</td>
      <td class="num">${!r.fxOk?`<span class="fx-warn-badge" title="Taux de change ${r.currency} manquant (fx-rates.json) — montant NON converti, probablement faux">⚠ ${r.currentValue!=null?fmtEUR(r.currentValue):fmtEUR(r.costBasis)}</span>`:(r.currentValue!=null?fmtEUR(r.currentValue):fmtEUR(r.costBasis)+' *')}</td>
      <td class="num ${gainClass}">${r.gain!=null?fmtEUR(r.gain)+' ('+fmtPctSigned(r.gainPct)+')':'—'}</td>
      <td class="num">${analystBadgeHTML(r.live ? r.live.analystLabel : null)}</td>
      <td class="row-actions">
        <button class="edit-btn" data-edit-id="${r.id}" title="Modifier cette position">✎</button>
        ${otherPortfolios.length ? `<button class="move-btn" data-move-id="${r.id}" title="Déplacer vers un autre portefeuille">⇄</button>` : ''}
        <button class="remove-btn" data-remove-id="${r.id}" title="Retirer du portefeuille">✕</button>
      </td>
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

  wrap.querySelectorAll("[data-edit-id]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      openEditHoldingModal(btn.dataset.editId);
    });
  });

  wrap.querySelectorAll("[data-move-id]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      openMoveHoldingModal(btn.dataset.moveId);
    });
  });
}

async function openEditHoldingModal(holdingId){
  const portfolioId = pfGetActivePortfolioId();
  const holding = pfGetHoldings(portfolioId).find(h=>h.id===holdingId);
  if(!holding) return;

  let live = null;
  try{
    const snap = await loadSnapshot();
    live = snap.records.find(r=>r.symbol===holding.symbol) || null;
  }catch(e){ /* tant pis, repli sur la devise déduite du pays */ }

  const nativeCcy = resolveListedCurrency(live || holding);
  const hasChoice = nativeCcy !== "EUR";
  const currentCcy = holding.priceCurrency || nativeCcy;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>Modifier ${holding.name}</h3>
      <div class="modal-sub">${holding.symbol}</div>
      <div class="modal-field">
        <label>Date d'achat</label>
        <input type="date" id="editDate" value="${holding.purchaseDate}" max="${new Date().toISOString().slice(0,10)}">
      </div>
      <div class="modal-field">
        <label>Nombre d'actions</label>
        <input type="number" id="editQty" value="${holding.quantity}" min="0" step="any">
      </div>
      <div class="modal-field">
        <label>Prix d'achat</label>
        <div style="display:flex;gap:8px;">
          <input type="number" id="editPrice" value="${holding.purchasePrice}" min="0" step="any" style="flex:1;">
          ${hasChoice ? `
          <select id="editPriceCcy" style="width:90px;background:var(--paper);border:1px solid var(--hairline-bright);color:var(--ink);border-radius:4px;font-family:'IBM Plex Mono',monospace;font-size:0.85rem;">
            <option value="${nativeCcy}" ${currentCcy===nativeCcy?'selected':''}>${nativeCcy}</option>
            <option value="EUR" ${currentCcy==='EUR'?'selected':''}>EUR</option>
          </select>` : `<span style="align-self:center;color:var(--ink-faint);font-family:'IBM Plex Mono',monospace;font-size:0.85rem;padding:0 6px;">EUR</span>`}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" id="editCancel">Annuler</button>
        <button class="btn-confirm" id="editConfirm">Enregistrer</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = ()=> overlay.remove();
  overlay.addEventListener("click", (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector("#editCancel").addEventListener("click", close);
  overlay.querySelector("#editConfirm").addEventListener("click", ()=>{
    const qty = parseFloat(overlay.querySelector("#editQty").value);
    const price = parseFloat(overlay.querySelector("#editPrice").value);
    const date = overlay.querySelector("#editDate").value;
    const ccySel = overlay.querySelector("#editPriceCcy");
    const priceCurrency = ccySel ? ccySel.value : "EUR";
    if(!qty || qty<=0){ toast("Nombre d'actions invalide."); return; }
    if(!price || price<=0){ toast("Prix d'achat invalide."); return; }
    if(!date){ toast("Date invalide."); return; }
    const result = pfUpdateHolding(holdingId, { quantity: qty, purchasePrice: price, purchaseDate: date, priceCurrency }, portfolioId);
    if(result.ok){
      toast("Position mise à jour.");
      close();
      renderPortfolio();
    } else {
      toast("Échec : " + result.message);
    }
  });
}

function openMoveHoldingModal(holdingId){
  const fromId = pfGetActivePortfolioId();
  const holding = pfGetHoldings(fromId).find(h=>h.id===holdingId);
  const targets = pfGetPortfolios().filter(p=>p.id !== fromId);
  if(!holding || targets.length === 0) return;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>Déplacer ${holding.name}</h3>
      <div class="modal-sub">${holding.symbol} — choisis le portefeuille de destination</div>
      <div class="modal-field">
        <label>Portefeuille de destination</label>
        <select id="moveTarget" style="width:100%;background:var(--paper);border:1px solid var(--hairline-bright);color:var(--ink);padding:9px 10px;border-radius:4px;font-family:'IBM Plex Mono',monospace;font-size:0.88rem;">
          ${targets.map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" id="moveCancel">Annuler</button>
        <button class="btn-confirm" id="moveConfirm">Déplacer</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = ()=> overlay.remove();
  overlay.addEventListener("click", (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector("#moveCancel").addEventListener("click", close);
  overlay.querySelector("#moveConfirm").addEventListener("click", ()=>{
    const toId = overlay.querySelector("#moveTarget").value;
    const result = pfMoveHolding(holdingId, fromId, toId);
    if(result.ok){
      toast(result.message);
      close();
      renderPortfolio();
    } else {
      toast("Échec : " + result.message);
    }
  });
}

let allocationCharts = [];

function renderAllocation(rows){
  const wrap = document.getElementById("allocationWrap");
  allocationCharts.forEach(c=>c.destroy());
  allocationCharts = [];

  if(rows.length === 0){
    wrap.innerHTML = "";
    return;
  }
  if(typeof Chart === "undefined"){
    wrap.innerHTML = `<div class="allocation-card">La librairie de graphique n'a pas pu se charger — répartition indisponible pour l'instant.</div>`;
    return;
  }

  const groupBy = (keyFn, labelFn) => {
    const totals = {};
    rows.forEach(r=>{
      const val = r.currentValue!=null ? r.currentValue : r.costBasis;
      const key = keyFn(r) || "Inconnu";
      totals[key] = (totals[key]||0) + val;
    });
    const entries = Object.entries(totals).sort((a,b)=>b[1]-a[1]);
    const grandTotal = entries.reduce((s,[,v])=>s+v,0);
    return entries.map(([key,val])=>({ label: labelFn ? labelFn(key) : key, value: val, pct: grandTotal>0?val/grandTotal*100:0 }));
  };

  const bySector = groupBy(r => r.live ? r.live.sector : null);
  const byCountry = groupBy(r => r.country, code => { const cm = countryMeta(code); return cm ? cm.name : code; });
  const byCurrency = groupBy(r => r.currency);

  wrap.innerHTML = `
    <div class="allocation-card"><h4>Par secteur</h4><div class="chart-holder"><canvas id="allocSector"></canvas></div><div class="allocation-legend" id="legendSector"></div></div>
    <div class="allocation-card"><h4>Par pays</h4><div class="chart-holder"><canvas id="allocCountry"></canvas></div><div class="allocation-legend" id="legendCountry"></div></div>
    <div class="allocation-card"><h4>Par devise</h4><div class="chart-holder"><canvas id="allocCurrency"></canvas></div><div class="allocation-legend" id="legendCurrency"></div></div>
  `;

  const palette = ["#C9A24B","#5B8A7A","#8B7CB6","#C9704B","#4F8FBF","#D0A5B0","#8FA85E","#A98CC9","#6FB0A8","#C97D8F","#9FA0C9","#B8935E"];
  const panelColor = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() || "#161F1A";

  const drawDoughnut = (canvasId, legendId, data) => {
    const ctx = document.getElementById(canvasId).getContext("2d");
    const chart = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: data.map(d=>d.label),
        datasets: [{ data: data.map(d=>d.value), backgroundColor: data.map((_,i)=>palette[i%palette.length]), borderColor: panelColor, borderWidth: 2 }],
      },
      options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } } },
    });
    allocationCharts.push(chart);
    document.getElementById(legendId).innerHTML = data.map((d,i)=>`
      <div class="row"><span class="swatch" style="background:${palette[i%palette.length]}"></span><span class="label">${d.label}</span><span class="pct">${d.pct.toFixed(1)}%</span></div>
    `).join('');
  };

  drawDoughnut("allocSector", "legendSector", bySector);
  drawDoughnut("allocCountry", "legendCountry", byCountry);
  drawDoughnut("allocCurrency", "legendCurrency", byCurrency);
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
  let liveBySymbol = {};
  if(holdings.length){
    try{
      const snap = await loadSnapshot();
      snap.records.forEach(r=>liveBySymbol[r.symbol]=r);
    }catch(e){ /* tant pis, on retombera sur la devise déduite du pays */ }
  }

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
          let priceEUR;
          const ccy = resolveListedCurrency(liveBySymbol[h.symbol] || h);
          if(pt){
            // prix historique réel (holdings-history.json) — même instrument
            // que le prix actuel, donc même devise de cotation.
            priceEUR = toEUR(pt.close, ccy, fxRates);
          } else {
            // repli sur le prix d'achat — respecte la devise choisie à l'ajout
            const purchaseCcy = h.priceCurrency || ccy;
            priceEUR = purchaseCcy === "EUR" ? h.purchasePrice : toEUR(h.purchasePrice, ccy, fxRates);
          }
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

// ---------------------------------------------------------------
// Import DEGIRO (export CSV du portefeuille)
// ---------------------------------------------------------------

/** Parseur CSV respectant les guillemets (les nombres DEGIRO utilisent la
 * virgule comme séparateur décimal ET le CSV utilise la virgule comme
 * séparateur de colonnes — un .split(',') naïf casserait tout). */
function parseCsvLine(line){
  const result = [];
  let cur = '', inQuotes = false;
  for(let i=0; i<line.length; i++){
    const c = line[i];
    if(inQuotes){
      if(c === '"'){
        if(line[i+1] === '"'){ cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if(c === '"') inQuotes = true;
      else if(c === ',') { result.push(cur); cur = ''; }
      else cur += c;
    }
  }
  result.push(cur);
  return result;
}

/** "1 234,56" (notation française) -> 1234.56 (nombre JS) */
function parseFrenchNumber(str){
  if(str == null || str === '') return null;
  const cleaned = str.replace(/\s/g,'').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/**
 * Parse un export CSV DEGIRO (colonnes : Produit, Ticker/ISIN, Quantité,
 * Clôture, Devise, [montant natif], Montant en EUR). Retourne
 * {positions: [...], cash: [...]}. Les lignes "CASH & CASH FUND..." sont
 * distinguées des vraies positions.
 *
 * IMPORTANT : DEGIRO exporte le prix ACTUEL (Clôture), pas le prix
 * d'achat réel — ce n'est pas dans l'export. Les positions importées
 * auront donc un prix d'achat = prix actuel (plus-value à 0 au départ),
 * à corriger manuellement via le bouton ✎ pour chaque ligne si tu veux
 * un suivi de performance exact.
 */
function parseDegiroCSV(text){
  const lines = text.split(/\r?\n/).filter(l=>l.trim().length);
  if(lines.length < 2) return {positions: [], cash: []};
  const rows = lines.slice(1).map(parseCsvLine); // ligne 0 = en-têtes

  const positions = [];
  const cash = [];
  for(const row of rows){
    const [name, isin, qtyStr, closeStr, currency] = row;
    if(!name) continue;
    if(name.trim().toUpperCase().startsWith("CASH")){
      const nativeAmountStr = row[5];
      const amount = parseFrenchNumber(nativeAmountStr);
      if(amount != null && Math.abs(amount) > 0.001){
        cash.push({ label: name.trim(), amount, currency: (currency||'EUR').trim() });
      }
      continue;
    }
    const quantity = parseFrenchNumber(qtyStr);
    const close = parseFrenchNumber(closeStr);
    if(!isin || !quantity || close == null) continue; // ligne incomplète, ignorée
    positions.push({
      name: name.trim(),
      isin: isin.trim(),
      quantity,
      price: close, // prix ACTUEL, utilisé comme repli de prix d'achat — voir docstring
      currency: (currency||'EUR').trim(),
    });
  }
  return {positions, cash};
}

/**
 * Fait correspondre chaque position DEGIRO (identifiée par ISIN) à notre
 * snapshot, pour récupérer le bon symbole/pays. Si plusieurs cotations
 * partagent le même ISIN (cross-listings, voir badge 🌐), préfère celle
 * dont le domicile réel correspond au pays de cotation.
 */
function matchDegiroToSnapshot(positions, snapshotRecords){
  const byIsin = {};
  snapshotRecords.forEach(r=>{
    if(!r.isin) return;
    (byIsin[r.isin] = byIsin[r.isin] || []).push(r);
  });

  return positions.map(pos=>{
    const candidates = byIsin[pos.isin] || [];
    let match = null;
    if(candidates.length){
      const authentic = candidates.filter(r => !r.homeCountryCode || r.homeCountryCode === r.country);
      match = (authentic.length ? authentic : candidates)
        .sort((a,b)=>(b.avgDailyValue||0)-(a.avgDailyValue||0))[0];
    }
    return { ...pos, match };
  });
}

async function importDegiroCSV(file){
  const text = await file.text();
  const { positions, cash } = parseDegiroCSV(text);
  if(positions.length === 0 && cash.length === 0){
    toast("Aucune position ou ligne de cash reconnue dans ce fichier.");
    return;
  }

  let snap;
  try{ snap = await loadSnapshot(); }
  catch(e){ toast("Impossible de charger data-snapshot.json pour faire correspondre les titres : " + e.message); return; }

  const matched = matchDegiroToSnapshot(positions, snap.records);
  const unmatched = matched.filter(m=>!m.match);

  const name = prompt("Nom du nouveau portefeuille :", "DEGIRO");
  if(!name) return;
  const portfolioId = pfCreatePortfolio(name.trim());

  const today = new Date().toISOString().slice(0,10);
  matched.forEach(m=>{
    const symbol = m.match ? m.match.symbol : `MANUAL:${m.isin}`;
    const country = m.match ? m.match.country : null;
    pfAddHolding({
      symbol, name: m.name, country, isin: m.isin,
      quantity: m.quantity, purchasePrice: m.price, purchaseDate: today,
      priceCurrency: m.currency, // devise EXACTE du fichier DEGIRO (GBX incluse) — fiable, pas de déduction nécessaire
    }, portfolioId);
  });
  cash.forEach(c=>{
    pfAddCash({ label: c.label, amount: c.amount, currency: c.currency }, portfolioId);
  });

  pfSetActivePortfolio(portfolioId);
  renderSwitcher();
  renderPortfolio();

  let msg = `Portefeuille "${name.trim()}" créé : ${matched.length} position(s), ${cash.length} ligne(s) de cash importées.`;
  msg += ` ⚠ Le prix d'achat = prix actuel du fichier (DEGIRO ne fournit pas le vrai prix de revient) — corrige chaque position via ✎ si tu veux une vraie plus-value.`;
  if(unmatched.length){
    msg += ` ${unmatched.length} titre(s) non retrouvé(s) dans le snapshot (prix ne se mettra pas à jour automatiquement) : ${unmatched.map(m=>m.name).join(', ')}.`;
  }
  toast(msg);
}

function renderSwitcher(){
  const wrap = document.getElementById("pfSwitcher");
  const portfolios = pfGetPortfolios();
  const activeId = pfGetActivePortfolioId();

  wrap.innerHTML = portfolios.map(p => `
    <div class="pf-tab ${p.id===activeId?'active':''}" data-pf-id="${p.id}">
      <span class="pf-tab-label">${p.name}</span>
      <button class="pf-menu-btn" data-pf-menu="${p.id}" title="Options">⋯</button>
    </div>
  `).join('') + `<button class="pf-add-btn" id="pfAddBtn">+ Nouveau portefeuille</button>`;

  wrap.querySelectorAll(".pf-tab").forEach(tab=>{
    tab.addEventListener("click", (e)=>{
      if(e.target.closest(".pf-menu-btn")) return;
      pfSetActivePortfolio(tab.dataset.pfId);
      renderSwitcher();
      renderPortfolio();
    });
  });

  wrap.querySelectorAll("[data-pf-menu]").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.stopPropagation();
      const id = btn.dataset.pfMenu;
      const p = portfolios.find(x=>x.id===id);
      const action = prompt(`Portefeuille "${p.name}" — tape "renommer" ou "supprimer" :`);
      if(!action) return;
      const a = action.trim().toLowerCase();
      if(a === "renommer" || a === "renomer"){
        const newName = prompt("Nouveau nom :", p.name);
        if(newName && newName.trim()){
          pfRenamePortfolio(id, newName.trim());
          renderSwitcher();
        }
      } else if(a === "supprimer"){
        if(portfolios.length <= 1){
          toast("Impossible de supprimer le dernier portefeuille restant.");
          return;
        }
        if(confirm(`Supprimer définitivement "${p.name}" et toutes ses positions ?`)){
          pfDeletePortfolio(id);
          renderSwitcher();
          renderPortfolio();
        }
      }
    });
  });

  document.getElementById("pfAddBtn").addEventListener("click", ()=>{
    const name = prompt("Nom du nouveau portefeuille (ex. PEA, CTO, Assurance-vie) :");
    if(name && name.trim()){
      pfCreatePortfolio(name.trim());
      renderSwitcher();
      renderPortfolio();
    }
  });
}

function init(){
  const versionEl = document.getElementById("appVersion");
  if(versionEl) versionEl.textContent = "v6.7.0";
  renderSwitcher();
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
  document.getElementById("importDegiroBtn").addEventListener("click", ()=>{
    document.getElementById("importDegiroFile").click();
  });
  document.getElementById("importDegiroFile").addEventListener("change", (e)=>{
    const file = e.target.files[0];
    if(file) importDegiroCSV(file);
    e.target.value = "";
  });
  document.getElementById("importFile").addEventListener("change", (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      const hasExisting = pfGetPortfolios().some(p=>p.holdings.length > 0);
      let mode = "replace";
      if(hasExisting){
        mode = confirm(
          "Tu as déjà des positions enregistrées sur cet appareil.\n\n" +
          "OK = fusionner (garde l'existant + ajoute les nouveaux portefeuilles/positions du fichier)\n" +
          "Annuler = tout remplacer par le contenu du fichier"
        ) ? "merge" : "replace";
      }
      const result = pfImportData(reader.result, mode);
      if(result.ok){
        toast(`Import réussi (${mode==='merge'?'fusion':'remplacement'}) — ${result.message}`);
        renderSwitcher();
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
