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

// fetchWithTimeout() et loadSnapshot() sont désormais définis dans data.js
// (partagé entre les 3 pages) — gère la fusion des parties si le snapshot
// est découpé pour rester sous la limite de taille d'upload de GitHub.

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
  if(!live || !isCrossListed(live)) return '';
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

const HOLDINGS_SUFFIX_KEY = "lgl_holdings_history_suffix"; // localStorage, personnel — jamais partagé sur GitHub

function getHoldingsHistorySuffix(){
  try{ return localStorage.getItem(HOLDINGS_SUFFIX_KEY) || ""; }
  catch(e){ return ""; }
}
function setHoldingsHistorySuffix(suffix){
  try{ localStorage.setItem(HOLDINGS_SUFFIX_KEY, suffix || ""); }catch(e){}
}

/** Consulte l'annuaire partagé (déposé par fetch_holdings_history.py à
 * chaque lancement avec --suffix) pour savoir quels fichiers existent —
 * évite d'avoir à taper un nom à la main, et permet de proposer
 * automatiquement "popo" si quelqu'un a lancé le script avec --suffix popo. */
const HOLDINGS_PASSPHRASE_KEY = "lgl_holdings_passphrase"; // localStorage, jamais envoyé nulle part — sert uniquement à déchiffrer localement

function base64ToBytes(b64){
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for(let i=0; i<bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Dérive la même clé AES-256 que côté Python (PBKDF2-SHA256), via l'API
 * Web Crypto native du navigateur — aucune librairie externe nécessaire. */
async function deriveHoldingsKey(passphrase, saltB64, iterations){
  const enc = new TextEncoder();
  const salt = base64ToBytes(saltB64);
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

/** Déchiffre un fichier holdings-history chiffré par
 * fetch_holdings_history.py --encrypt. Un mauvais mot de passe fait
 * échouer la vérification d'intégrité AES-GCM (exception levée) — sert à
 * distinguer "mauvais mot de passe" de "fichier corrompu". */
async function decryptHoldingsPayload(encryptedObj, passphrase){
  const key = await deriveHoldingsKey(passphrase, encryptedObj.salt, encryptedObj.iterations);
  const iv = base64ToBytes(encryptedObj.iv);
  const ciphertext = base64ToBytes(encryptedObj.ciphertext);
  const plaintextBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintextBuf));
}

/** Demande le mot de passe si besoin (mémorisé ensuite dans CE navigateur
 * uniquement, jamais dans le dépôt), avec 3 essais avant d'abandonner. */
async function decryptHoldingsWithPrompt(encryptedObj){
  let passphrase = localStorage.getItem(HOLDINGS_PASSPHRASE_KEY);
  for(let attempt=0; attempt<3; attempt++){
    if(!passphrase){
      passphrase = prompt("Mot de passe pour déchiffrer l'historique de prix :");
      if(!passphrase) return null; // annulé par l'utilisateur
    }
    try{
      const decrypted = await decryptHoldingsPayload(encryptedObj, passphrase);
      localStorage.setItem(HOLDINGS_PASSPHRASE_KEY, passphrase); // mémorisé seulement si ça a fonctionné
      return decrypted;
    }catch(e){
      toast("Mot de passe incorrect.");
      passphrase = null; // force une nouvelle saisie au prochain essai
    }
  }
  return null;
}

async function loadHoldingsHistorySuffixes(){
  try{
    const url = "./holdings-history-index.json?t=" + Date.now();
    const res = await fetchWithTimeout(url, {cache:"no-store"}, 10000);
    if(!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json.suffixes) ? json.suffixes : [];
  }catch(e){
    return [];
  }
}

async function loadHoldingsHistory(){
  try{
    const suffix = getHoldingsHistorySuffix();
    const filename = suffix ? `holdings-history-${suffix}.json` : "holdings-history.json";
    const url = `./${filename}?t=` + Date.now();
    const res = await fetchWithTimeout(url, {cache:"no-store"}, 10000);
    if(!res.ok) return null;
    const json = await res.json();
    if(json && json.encrypted){
      const decrypted = await decryptHoldingsWithPrompt(json);
      return decrypted && decrypted.prices ? decrypted.prices : null;
    }
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

/**
 * Calcule les lignes de portefeuille (prix natif + converti en euros) pour
 * une liste de positions donnée — factorisé pour être réutilisé à la fois
 * par l'affichage normal ET par le calcul de clôture (même logique de
 * conversion de devise, pas de duplication).
 */
function computeHoldingsRows(holdings, snap, fxRates){
  const missingFx = new Set();
  const bySymbol = {};
  snap.records.forEach(r=> bySymbol[r.symbol]=r );

  const rows = holdings.map(h=>{
    const live = bySymbol[h.symbol];
    const currentPrice = live ? live.price : null;
    const currency = resolveListedCurrency(live || h);
    if(currency !== "EUR" && (!fxRates || (currency !== "GBX" && fxRates[currency] == null) || (currency === "GBX" && fxRates["GBP"] == null))) missingFx.add(currency);

    const purchaseCcy = h.priceCurrency || currency;
    const costBasisNative = h.quantity * h.purchasePrice;
    const currentValueNative = currentPrice!=null ? h.quantity * currentPrice : null;
    const costBasis = purchaseCcy === "EUR" ? costBasisNative : toEUR(costBasisNative, currency, fxRates);
    const currentValue = currentValueNative!=null ? toEUR(currentValueNative, currency, fxRates) : null;
    const gain = currentValue!=null ? currentValue - costBasis : null;
    const gainPct = (currentValue!=null && costBasis>0) ? (gain/costBasis*100) : null;
    const fxOk = fxRateAvailable(currency, fxRates) && fxRateAvailable(purchaseCcy, fxRates);
    return { ...h, live, currency, purchaseCcy, currentPrice, costBasisNative, currentValueNative, costBasis, currentValue, gain, gainPct, fxOk };
  });

  return { rows, missingFx };
}

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
  const { rows, missingFx } = computeHoldingsRows(holdings, snap, fxRates);

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

  // Expose les lignes calculées pour que le bandeau de plan puisse vérifier
  // les règles portant sur un multiple (ex. PER ≥ 20 chez Higgons).
  window.__lastRows = rows;
  renderPlan();

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
    <div class="card">
      <div class="lbl">Valeur totale</div>
      <div class="val">${fmtEUR(grandTotal)}</div>
      ${totalCash ? `<div class="sub-breakdown"><span>Actions ${fmtEUR(totalValue)}</span><span>Cash ${fmtEUR(totalCash)}</span></div>` : ''}
    </div>
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

/**
 * "Clôturer position" — enregistre une ligne dans l'Historique (méthode
 * utilisée, date, bénéfice réalisé) puis vide TOUTES les positions du
 * portefeuille actif. Ne touche ni au cash, ni à l'historique de valeur
 * jour par jour, ni aux clôtures déjà enregistrées.
 */
/** Date d'achat la plus fréquente parmi les positions — sert de point de
 * départ pour calculer une échéance de rotation (ex. +12 mois). */
function dominantPurchaseDate(portfolioId){
  const counts = {};
  pfGetHoldings(portfolioId).forEach(h=>{ if(h.purchaseDate) counts[h.purchaseDate] = (counts[h.purchaseDate]||0)+1; });
  const dates = Object.keys(counts);
  if(dates.length === 0) return null;
  dates.sort((a,b)=> (counts[b]-counts[a]) || a.localeCompare(b));
  return dates[0];
}

function addMonths(dateStr, months){
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0,10);
}

/**
 * Plan EFFECTIF d'un portefeuille : les réglages personnalisés s'il y en a,
 * sinon la règle par défaut de la stratégie (voir exitRule dans data.js).
 * L'idée est qu'on n'ait RIEN à saisir pour savoir quand vendre — la
 * méthode choisie porte déjà sa propre règle, documentée et sourcée.
 */
function getEffectivePlan(portfolioId){
  const saved = pfGetPlan(portfolioId);
  if(!saved || !saved.strategy) return null;
  const strat = STRATEGIES[saved.strategy];
  const defaults = strat ? strat.exitRule : null;
  const rule = saved.customRule || defaults;
  if(!rule) return null;

  const out = {
    strategy: saved.strategy,
    strategyName: saved.strategyName || (strat ? strat.name : saved.strategy),
    rule,
    isCustom: !!saved.customRule,
    source: (saved.customRule ? null : (defaults ? defaults.source : null)),
  };

  if(rule.type === "months"){
    const base = saved.startDate || dominantPurchaseDate(portfolioId);
    out.startDate = base;
    out.exitDate = base ? addMonths(base, rule.months) : null;
  }
  return out;
}

/** Bandeau du plan de sortie — affiche automatiquement QUAND vendre selon
 * la méthode suivie, sans rien avoir à renseigner au-delà de la méthode. */
function renderPlan(){
  const wrap = document.getElementById("planWrap");
  if(!wrap) return;
  const plan = getEffectivePlan();

  if(!plan){
    wrap.innerHTML = `<div class="plan-bar plan-empty">
      <span>Choisis la méthode suivie par ce portefeuille pour savoir automatiquement quand vendre.</span>
      <button class="btn-io" id="editPlanBtn">Choisir la méthode</button>
    </div>`;
  } else {
    let statusHtml = "", barClass = "", extra = "";

    if(plan.rule.type === "months"){
      if(!plan.exitDate){
        statusHtml = `Rotation à ${plan.rule.months} mois — <strong>ajoute des positions</strong> pour calculer l'échéance.`;
      } else {
        const today = new Date().toISOString().slice(0,10);
        const daysLeft = Math.round((new Date(plan.exitDate) - new Date(today)) / 86400000);
        if(daysLeft < 0){
          barClass = "plan-due";
          statusHtml = `<strong>À vendre : échéance dépassée depuis ${Math.abs(daysLeft)} jour(s)</strong> (rotation ${plan.rule.months} mois, prévue le ${plan.exitDate}).`;
        } else if(daysLeft <= 30){
          barClass = "plan-soon";
          statusHtml = `<strong>Vendre dans ${daysLeft} jour(s)</strong> — le ${plan.exitDate} (rotation ${plan.rule.months} mois).`;
        } else {
          statusHtml = `Vendre le <strong>${plan.exitDate}</strong> — dans ${daysLeft} jours (rotation ${plan.rule.months} mois).`;
        }
      }
    } else if(plan.rule.type === "metric" && plan.rule.metric === "pe"){
      statusHtml = `Vendre quand le PER dépasse <strong>${plan.rule.sellAt}</strong>${plan.rule.trimAt?` (alléger dès ${plan.rule.trimAt})`:''}.`;
      // Vérifie directement quelles positions atteignent le seuil — c'est
      // tout l'intérêt d'une règle sur multiple plutôt que sur date.
      const rows = window.__lastRows || [];
      const above = rows.filter(r=> r.live && r.live.pe != null && r.live.pe >= plan.rule.sellAt);
      // Un PER élevé n'a PAS le même sens selon que la position gagne ou perd :
      //  - en gain  -> le cours a monté, la décote a disparu : c'est le cas visé
      //                par Higgons ("vendre au-delà de 20"), thèse réalisée.
      //  - en perte -> le PER explose parce que les BÉNÉFICES se sont effondrés,
      //                pas parce que le cours a monté. C'est un piège de valeur,
      //                un signal différent qu'il ne faut pas confondre avec une
      //                réussite (Higgons conseille par ailleurs de se séparer des
      //                titres sur lesquels on perd le plus, mais c'est une autre
      //                logique — à l'utilisateur de trancher en connaissance).
      const realized = above.filter(r=> (r.gain||0) >= 0);
      const traps = above.filter(r=> (r.gain||0) < 0);
      const trims = rows.filter(r=> r.live && r.live.pe != null && plan.rule.trimAt && r.live.pe >= plan.rule.trimAt && r.live.pe < plan.rule.sellAt);

      const parts = [];
      if(realized.length){
        barClass = "plan-due";
        parts.push(`<div><strong>Objectif atteint — à vendre</strong> (PER ≥ ${plan.rule.sellAt}, en plus-value) : ${realized.map(h=>`${h.name} (PER ${h.live.pe.toFixed(1)})`).join(', ')}</div>`);
      }
      if(traps.length){
        if(!barClass) barClass = "plan-soon";
        parts.push(`<div style="margin-top:6px;"><strong>PER élevé mais en moins-value</strong> — bénéfices en baisse, pas une thèse réalisée : ${traps.map(h=>`${h.name} (PER ${h.live.pe.toFixed(1)})`).join(', ')}. À examiner séparément : la règle des 20 vise les titres devenus chers par hausse du cours, pas ceux dont les résultats s'effondrent.</div>`);
      }
      if(!realized.length && !traps.length && trims.length){
        barClass = "plan-soon";
        parts.push(`<div><strong>À alléger (PER ≥ ${plan.rule.trimAt})</strong> : ${trims.map(h=>`${h.name} (PER ${h.live.pe.toFixed(1)})`).join(', ')}</div>`);
      }
      if(parts.length) extra = `<div class="plan-hits">${parts.join('')}</div>`;
    } else {
      statusHtml = plan.rule.label || "Conservation longue.";
    }

    const originTag = plan.isCustom
      ? `<span class="plan-origin" title="Règle que tu as personnalisée">personnalisé</span>`
      : `<span class="plan-origin auto" title="${(plan.source||'').replace(/"/g,'&quot;')}">règle par défaut</span>`;

    wrap.innerHTML = `<div class="plan-bar ${barClass}">
      <span class="plan-strategy">${plan.strategyName}</span>
      <span class="plan-status">${statusHtml} ${originTag}</span>
      <button class="btn-io" id="editPlanBtn">Modifier</button>
      ${extra}
    </div>`;
  }
  document.getElementById("editPlanBtn").addEventListener("click", openPlanModal);
}

function openPlanModal(){
  const saved = pfGetPlan() || {};
  const strategyOptions = STRATEGY_ORDER.map(id =>
    `<option value="${id}" ${saved.strategy===id?'selected':''}>${STRATEGIES[id].name}</option>`
  ).join('');

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>Méthode et règle de sortie</h3>
      <div class="modal-sub">Choisis la méthode : sa règle de sortie s'applique automatiquement. Tu peux la personnaliser si tu veux t'en écarter.</div>
      <div class="modal-field">
        <label>Méthode suivie</label>
        <select id="planStrategy" style="width:100%;background:var(--paper);border:1px solid var(--hairline-bright);color:var(--ink);padding:9px 10px;border-radius:4px;font-family:'IBM Plex Mono',monospace;font-size:0.88rem;">
          ${strategyOptions}
        </select>
      </div>
      <div class="modal-field">
        <div class="plan-default-box" id="planDefaultBox"></div>
      </div>
      <div class="modal-field">
        <label class="pea-check"><input type="checkbox" id="planCustomize" ${saved.customRule?'checked':''}> Personnaliser la règle de sortie</label>
      </div>
      <div id="planCustomFields" style="display:${saved.customRule?'block':'none'};">
        <div class="modal-field">
          <label>Type de règle</label>
          <select id="customType" style="width:100%;background:var(--paper);border:1px solid var(--hairline-bright);color:var(--ink);padding:9px 10px;border-radius:4px;font-size:0.85rem;">
            <option value="months">Durée de détention (en mois)</option>
            <option value="metric">Seuil de PER</option>
            <option value="hold">Conservation longue (aucune sortie prévue)</option>
          </select>
        </div>
        <div class="modal-field" id="customMonthsField">
          <label>Vendre après (mois)</label>
          <input type="number" id="customMonths" min="1" max="600" value="${saved.customRule && saved.customRule.months || 12}">
        </div>
        <div class="modal-field" id="customPeField" style="display:none;">
          <label>Alléger à partir d'un PER de</label>
          <input type="number" id="customTrimAt" min="1" step="0.5" value="${saved.customRule && saved.customRule.trimAt || 17}">
          <label style="margin-top:8px;">Vendre au-delà d'un PER de</label>
          <input type="number" id="customSellAt" min="1" step="0.5" value="${saved.customRule && saved.customRule.sellAt || 20}">
        </div>
      </div>
      <div class="modal-actions">
        ${pfGetPlan() ? `<button class="btn-cancel" id="planDelete">Supprimer</button>` : ''}
        <button class="btn-cancel" id="planCancel">Annuler</button>
        <button class="btn-confirm" id="planConfirm">Enregistrer</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const stratSel = overlay.querySelector("#planStrategy");
  const defaultBox = overlay.querySelector("#planDefaultBox");
  const customChk = overlay.querySelector("#planCustomize");
  const customFields = overlay.querySelector("#planCustomFields");
  const typeSel = overlay.querySelector("#customType");

  function refreshDefaultBox(){
    const rule = (STRATEGIES[stratSel.value] || {}).exitRule;
    defaultBox.innerHTML = rule
      ? `<div class="plan-default-label">Règle par défaut de cette méthode</div>
         <div class="plan-default-text">${rule.label}</div>
         ${rule.source?`<div class="plan-default-source">${rule.source}</div>`:''}`
      : `<div class="plan-default-text">Aucune règle par défaut pour cette méthode.</div>`;
  }
  function refreshCustomFields(){
    const t = typeSel.value;
    overlay.querySelector("#customMonthsField").style.display = t==="months" ? "block" : "none";
    overlay.querySelector("#customPeField").style.display = t==="metric" ? "block" : "none";
  }
  if(saved.customRule) typeSel.value = saved.customRule.type;
  refreshDefaultBox();
  refreshCustomFields();

  stratSel.addEventListener("change", refreshDefaultBox);
  typeSel.addEventListener("change", refreshCustomFields);
  customChk.addEventListener("change", ()=>{ customFields.style.display = customChk.checked ? "block" : "none"; });

  const close = ()=> overlay.remove();
  overlay.addEventListener("click", (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector("#planCancel").addEventListener("click", close);
  const delBtn = overlay.querySelector("#planDelete");
  if(delBtn) delBtn.addEventListener("click", ()=>{
    if(confirm("Supprimer la méthode et sa règle de sortie ?")){ pfClearPlan(); close(); renderPlan(); toast("Plan supprimé."); }
  });

  overlay.querySelector("#planConfirm").addEventListener("click", ()=>{
    const strategyId = stratSel.value;
    const strategyName = STRATEGIES[strategyId].name;
    let customRule = null;
    if(customChk.checked){
      const t = typeSel.value;
      if(t === "months"){
        const m = parseInt(overlay.querySelector("#customMonths").value, 10);
        if(!m || m < 1){ toast("Durée invalide."); return; }
        customRule = { type:"months", months:m, label:`Vendre après ${m} mois (réglage personnalisé)` };
      } else if(t === "metric"){
        const trimAt = parseFloat(overlay.querySelector("#customTrimAt").value);
        const sellAt = parseFloat(overlay.querySelector("#customSellAt").value);
        if(!sellAt || sellAt <= 0){ toast("Seuil de vente invalide."); return; }
        customRule = { type:"metric", metric:"pe", trimAt, sellAt, label:`Vendre au-delà d'un PER de ${sellAt} (réglage personnalisé)` };
      } else {
        customRule = { type:"hold", label:"Conservation longue (réglage personnalisé)" };
      }
    }
    pfSetPlan({ strategy: strategyId, strategyName, customRule });
    close();
    renderPlan();
    toast(customRule ? "Règle personnalisée enregistrée." : "Méthode enregistrée — règle par défaut appliquée.");
  });
}

async function openCloseoutModal(){
  const portfolioId = pfGetActivePortfolioId();
  const holdings = pfGetHoldings(portfolioId);
  if(holdings.length === 0){
    toast("Aucune position à clôturer dans ce portefeuille.");
    return;
  }

  let snap, fxRates;
  try{
    snap = await loadSnapshot();
    fxRates = await loadFxRates();
  }catch(e){
    toast("Impossible de charger les prix actuels : " + e.message);
    return;
  }
  const { rows } = computeHoldingsRows(holdings, snap, fxRates);
  const totalCostBasis = rows.reduce((s,r)=>s+r.costBasis, 0);
  const totalValue = rows.reduce((s,r)=>s + (r.currentValue!=null ? r.currentValue : r.costBasis), 0);
  const realizedGain = totalValue - totalCostBasis;
  const realizedGainPct = totalCostBasis>0 ? (realizedGain/totalCostBasis*100) : null;

  const today = new Date().toISOString().slice(0,10);
  // Pré-sélectionne la méthode du plan de sortie s'il en existe un — évite
  // de resaisir la même information, et garde l'historique cohérent.
  const plannedStrategy = (pfGetPlan(portfolioId) || {}).strategy;
  const strategyOptions = STRATEGY_ORDER.map(id => `<option value="${id}" ${id===plannedStrategy?'selected':''}>${STRATEGIES[id].name}</option>`).join('');

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>Clôturer ce portefeuille</h3>
      <div class="modal-sub">Enregistre une ligne dans l'Historique, puis vide les ${holdings.length} position(s) actuelles. Le cash n'est pas touché.</div>
      <div class="modal-field">
        <label>Méthode utilisée</label>
        <select id="closeoutStrategy" style="width:100%;background:var(--paper);border:1px solid var(--hairline-bright);color:var(--ink);padding:9px 10px;border-radius:4px;font-family:'IBM Plex Mono',monospace;font-size:0.88rem;">
          ${strategyOptions}
          <option value="autre">Autre / choix manuel</option>
        </select>
      </div>
      <div class="modal-field">
        <label>Date de clôture</label>
        <input type="date" id="closeoutDate" value="${today}" max="${today}">
      </div>
      <div class="modal-field">
        <div class="closeout-summary">
          <div class="row"><span>Positions concernées</span><span>${holdings.length}</span></div>
          <div class="row"><span>Investi</span><span>${fmtEUR(totalCostBasis)}</span></div>
          <div class="row"><span>Valeur actuelle</span><span>${fmtEUR(totalValue)}</span></div>
          <div class="row ${realizedGain>=0?'pos':'neg'}"><span>Plus/moins-value réalisée</span><span>${fmtEUR(realizedGain)} (${fmtPctSigned(realizedGainPct)})</span></div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" id="closeoutCancel">Annuler</button>
        <button class="btn-confirm" id="closeoutConfirm">Clôturer</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = ()=> overlay.remove();
  overlay.addEventListener("click", (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector("#closeoutCancel").addEventListener("click", close);
  overlay.querySelector("#closeoutConfirm").addEventListener("click", ()=>{
    if(!confirm(`Confirmer la clôture ? Les ${holdings.length} position(s) actuelles seront retirées du portefeuille (le cash reste intact).`)) return;

    const strategyId = overlay.querySelector("#closeoutStrategy").value;
    const strategyName = strategyId === "autre" ? "Autre / choix manuel" : STRATEGIES[strategyId].name;
    const closedDate = overlay.querySelector("#closeoutDate").value || today;

    pfAddClosure({
      strategy: strategyId,
      strategyName,
      closedDate,
      positionCount: holdings.length,
      totalCostBasis,
      totalValue,
      realizedGain,
      realizedGainPct,
      positions: rows.map(r => ({
        symbol: r.symbol,
        name: r.name,
        quantity: r.quantity,
        purchasePrice: r.purchasePrice,
        purchaseCcy: r.purchaseCcy,
        currentPrice: r.currentPrice,
        currency: r.currency,
        costBasis: r.costBasis,
        currentValue: r.currentValue,
        gain: r.gain,
        gainPct: r.gainPct,
      })),
    }, portfolioId);
    pfClearHoldings(portfolioId);

    toast(`Clôture enregistrée (${strategyName}, ${fmtEUR(realizedGain)}) — positions vidées.`);
    close();
    renderPortfolio();
  });
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

/**
 * Détail dépliable d'une position : les chiffres utiles à la décision de
 * vente, et surtout OÙ SE SITUE ce titre par rapport aux seuils de la
 * stratégie suivie (voir getEffectivePlan). L'idée est de ne pas avoir à
 * aller chercher le PER ailleurs au moment de trancher.
 */
function buildHoldingDetail(r){
  const live = r.live;
  const n = (v,d=1) => (v===null||v===undefined) ? "—" : v.toLocaleString('fr-FR',{maximumFractionDigits:d});
  const pct = v => (v===null||v===undefined) ? "—" : (v*100).toFixed(1)+"%";
  const signed = v => (v===null||v===undefined) ? "—" : (v>=0?"+":"")+v.toFixed(1)+"%";
  const cap = v => {
    if(v==null) return "—";
    if(v>=1e12) return (v/1e12).toFixed(2)+" T";
    if(v>=1e9) return (v/1e9).toFixed(2)+" Md";
    if(v>=1e6) return (v/1e6).toFixed(0)+" M";
    return n(v,0);
  };

  let gridHtml;
  if(live){
    const items = [
      ["Secteur", live.sector || "—"],
      ["Prix actuel", n(live.price,2) + (r.currency && r.currency!=="EUR" ? ` ${r.currency}` : " €")],
      ["Capitalisation", cap(live.mcap)],
      ["P/E", n(live.pe)],
      ["P/B", n(live.pb)],
      ["P/S", n(live.ps)],
      ["P/CF", n(live.pcf)],
      ["EBITDA/EV", live.ebitdaYield!=null ? pct(live.ebitdaYield) : "—"],
      ["Rend. actionnarial", pct(live.shareholderYield)],
      ["— dont dividende", pct(live.divYield)],
      ["ROE", pct(live.roe)],
      ["Marge d'exploitation", pct(live.opMargin)],
      ["Croissance CA (12M)", pct(live.revenueGrowth)],
      ["Momentum 6 mois", signed(live.mom6)],
      ["Momentum 3 mois", signed(live.mom3)],
      ["Liquidité (valeur échangée/jour)", cap(live.avgDailyValue)],
      ["Note des analystes", analystBadgeHTML(live.analystLabel)],
    ];
    gridHtml = `<div class="detail-grid">` +
      items.map(([k,v])=>`<div class="detail-item"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('') +
      `</div>`;
  } else {
    gridHtml = `<div class="detail-note">Pas de données de marché pour ce titre (non retrouvé dans le snapshot). Utilise « 🔄 Rechercher » après avoir relancé le scraper.</div>`;
  }

  // --- Position par rapport à la règle de sortie de la stratégie suivie ---
  const plan = getEffectivePlan();
  let ruleHtml = "";

  if(plan && plan.rule.type === "metric" && plan.rule.metric === "pe"){
    const pe = live ? live.pe : null;
    const trimAt = plan.rule.trimAt, sellAt = plan.rule.sellAt;
    if(pe == null){
      ruleHtml = `<div class="hd-rule"><div class="hd-rule-title">${plan.strategyName}</div><div class="hd-verdict">P/E indisponible — impossible de situer ce titre par rapport aux seuils.</div></div>`;
    } else {
      let verdict, cls;
      if(pe >= sellAt){
        if((r.gain||0) >= 0){ verdict = `Seuil de vente atteint (P/E ${pe.toFixed(1)} ≥ ${sellAt}) et position en plus-value : objectif rempli.`; cls = "due"; }
        else { verdict = `P/E ${pe.toFixed(1)} ≥ ${sellAt}, mais position en moins-value : le P/E est élevé parce que les bénéfices ont baissé, pas parce que le cours a monté. Autre décision que la règle des ${sellAt}.`; cls = "warn"; }
      } else if(trimAt && pe >= trimAt){
        verdict = `Zone d'allègement (P/E ${pe.toFixed(1)} ≥ ${trimAt}, vente au-delà de ${sellAt}).`; cls = "warn";
      } else {
        verdict = `Sous les seuils : P/E ${pe.toFixed(1)} — allègement à ${trimAt}, vente au-delà de ${sellAt}. Rien à faire.`; cls = "ok";
      }
      const scaleMax = sellAt * 1.3;
      const pos = Math.min(100, (pe / scaleMax) * 100);
      const trimPos = (trimAt / scaleMax) * 100;
      const sellPos = (sellAt / scaleMax) * 100;
      ruleHtml = `<div class="hd-rule ${cls}">
        <div class="hd-rule-title">${plan.strategyName} — où se situe ce titre</div>
        <div class="hd-scale">
          <div class="hd-scale-bar">
            <div class="hd-scale-zone" style="left:0;width:${trimPos}%;background:rgba(91,138,122,0.25);"></div>
            <div class="hd-scale-zone" style="left:${trimPos}%;width:${sellPos-trimPos}%;background:rgba(201,162,75,0.3);"></div>
            <div class="hd-scale-zone" style="left:${sellPos}%;right:0;background:rgba(200,110,50,0.3);"></div>
            <div class="hd-scale-marker" style="left:${pos}%;" title="P/E actuel : ${pe.toFixed(1)}"></div>
          </div>
          <div class="hd-scale-labels">
            <span>0</span><span style="position:absolute;left:${trimPos}%;">alléger ${trimAt}</span><span style="position:absolute;left:${sellPos}%;">vendre ${sellAt}</span>
          </div>
        </div>
        <div class="hd-verdict">${verdict}</div>
      </div>`;
    }
  } else if(plan && plan.rule.type === "months" && plan.exitDate){
    const daysLeft = Math.round((new Date(plan.exitDate) - new Date(new Date().toISOString().slice(0,10))) / 86400000);
    const cls = daysLeft < 0 ? "due" : (daysLeft <= 30 ? "warn" : "ok");
    const txt = daysLeft < 0
      ? `Échéance dépassée depuis ${Math.abs(daysLeft)} jour(s) — rotation ${plan.rule.months} mois prévue le ${plan.exitDate}.`
      : `Vente prévue le ${plan.exitDate}, dans ${daysLeft} jour(s) (rotation ${plan.rule.months} mois depuis le ${plan.startDate}).`;
    ruleHtml = `<div class="hd-rule ${cls}">
      <div class="hd-rule-title">${plan.strategyName} — échéance de rotation</div>
      <div class="hd-verdict">${txt}</div>
      <div class="detail-note">Cette stratégie vend le panier entier à échéance, quels que soient les multiples du titre — la date prime sur le P/E.</div>
    </div>`;
  } else if(plan && plan.rule.type === "hold"){
    ruleHtml = `<div class="hd-rule ok">
      <div class="hd-rule-title">${plan.strategyName}</div>
      <div class="hd-verdict">Conservation longue — aucune sortie prévue par la méthode.</div>
    </div>`;
  } else {
    ruleHtml = `<div class="hd-rule"><div class="hd-verdict">Aucune méthode définie pour ce portefeuille — choisis-en une en haut de page pour voir où se situe ce titre par rapport à sa règle de sortie.</div></div>`;
  }

  return gridHtml + ruleHtml;
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
    html += `<tr class="holding-row${!r.fxOk?' fx-warn':''}" data-detail-id="${r.id}">
      <td><span class="cname">${cm?flagHTML(r.country)+' ':''}${r.name}${r.live?homeCountryBadge(r.live):''}</span><span class="tkr" style="display:block;font-family:'IBM Plex Mono',monospace;font-size:0.76rem;color:var(--ink-faint);">${r.symbol}</span></td>
      <td class="num" data-label="Quantité">${r.quantity}</td>
      <td class="num" data-label="Prix d'achat">${r.purchasePrice.toLocaleString('fr-FR',{maximumFractionDigits:2})}${purchaseCcySuffix}</td>
      <td data-label="Date d'achat">${r.purchaseDate}</td>
      <td class="num" data-label="Prix actuel">${r.currentPrice!=null?r.currentPrice.toLocaleString('fr-FR',{maximumFractionDigits:2})+ccySuffix:(r.isin?`<button class="rematch-btn" data-rematch-id="${r.id}" data-rematch-isin="${r.isin}" title="Rechercher à nouveau ce titre dans le snapshot actuel">🔄 Rechercher</button>`:'—')}</td>
      <td class="num" data-label="Valeur">${!r.fxOk?`<span class="fx-warn-badge" title="Taux de change ${r.currency} manquant (fx-rates.json) — montant NON converti, probablement faux">⚠ ${r.currentValue!=null?fmtEUR(r.currentValue):fmtEUR(r.costBasis)}</span>`:(r.currentValue!=null?fmtEUR(r.currentValue):fmtEUR(r.costBasis)+' *')}</td>
      <td class="num ${gainClass}" data-label="+/- value">${r.gain!=null?fmtEUR(r.gain)+' ('+fmtPctSigned(r.gainPct)+')':'—'}</td>
      <td class="num" data-label="Analystes">${analystBadgeHTML(r.live ? r.live.analystLabel : null)}</td>
      <td class="row-actions">
        <button class="edit-btn" data-edit-id="${r.id}" title="Modifier cette position">✎</button>
        ${otherPortfolios.length ? `<button class="move-btn" data-move-id="${r.id}" title="Déplacer vers un autre portefeuille">⇄</button>` : ''}
        <button class="remove-btn" data-remove-id="${r.id}" title="Retirer du portefeuille">✕</button>
      </td>
    </tr>
    <tr class="holding-detail-row detail-row" data-detail-for="${r.id}" style="display:none;">
      <td colspan="9">${buildHoldingDetail(r)}</td>
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

  wrap.querySelectorAll("tr.holding-row").forEach(row=>{
    row.addEventListener("click", (e)=>{
      // ne pas déplier si on a cliqué un bouton d'action (✎ ⇄ ✕ 🔄)
      if(e.target.closest("button")) return;
      const detail = wrap.querySelector(`tr.holding-detail-row[data-detail-for="${row.dataset.detailId}"]`);
      if(!detail) return;
      const open = detail.style.display !== "none";
      detail.style.display = open ? "none" : "table-row";
      row.classList.toggle("expanded", !open);
    });
  });

  wrap.querySelectorAll("[data-edit-id]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      openEditHoldingModal(btn.dataset.editId);
    });
  });

  wrap.querySelectorAll("[data-rematch-id]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      rematchHolding(btn.dataset.rematchId, btn.dataset.rematchIsin);
    });
  });

  wrap.querySelectorAll("[data-move-id]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      openMoveHoldingModal(btn.dataset.moveId);
    });
  });
}

/**
 * Retente une correspondance par ISIN contre le snapshot ACTUEL pour une
 * position dont le symbole n'a jamais été résolu (ex. importée avant que
 * le titre soit couvert par le scraper — cas typique quand on relève le
 * plafond de récupération après coup, comme pour Blue Cap AG). Ne touche
 * ni au prix d'achat ni à la quantité, seulement au symbole/pays.
 */
async function rematchHolding(holdingId, isin){
  let snap;
  try{ snap = await loadSnapshot(); }
  catch(e){ toast("Impossible de charger le snapshot : " + e.message); return; }

  const candidates = snap.records.filter(r => r.isin === isin);
  if(candidates.length === 0){
    toast(`Toujours introuvable pour l'ISIN ${isin} dans le snapshot actuel.`);
    return;
  }
  // Même logique que l'import DEGIRO/Fortuneo : préfère la cotation dont
  // le domicile réel correspond au pays de cotation, puis la plus liquide.
  const authentic = candidates.filter(r => !r.homeCountryCode || r.homeCountryCode === r.country);
  const best = (authentic.length ? authentic : candidates)
    .sort((a,b)=>(b.avgDailyValue||0)-(a.avgDailyValue||0))[0];

  const portfolioId = pfGetActivePortfolioId();
  const result = pfUpdateHolding(holdingId, { symbol: best.symbol, country: best.country }, portfolioId);
  if(result.ok){
    toast(`${best.name} retrouvée (${best.symbol}) — prix maintenant à jour.`);
    renderPortfolio();
  } else {
    toast("Échec : " + result.message);
  }
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
  const benchmarkKeys = [...document.querySelectorAll('#benchmarkChips input:checked')].filter(el=>el.id !== "showBaseline").map(el=>el.value);
  const showBaseline = document.getElementById("showBaseline").checked;

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
    // Priorité à la date d'achat dominante : c'est la période réellement
    // pertinente ("depuis que je détiens ce panier"), et elle est couverte
    // par l'historique de prix réel. Le premier point du suivi local ne
    // reflète que le jour où la page a été ouverte pour la première fois,
    // ce qui n'a pas de sens comme point de départ.
    const purchase = dominantPurchaseDate();
    if(purchase) startInput.value = purchase;
    else if(history.length) startInput.value = history[0].date;
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
      // IMPORTANT — on valorise le panier ACTUEL (positions et quantités
      // d'aujourd'hui) à chaque date passée, SANS tenir compte de la date
      // d'achat réelle de chaque ligne. C'est volontaire : une courbe base
      // 100 doit montrer la PERFORMANCE, pas les apports de capital. Filtrer
      // par purchaseDate ferait "sauter" la courbe d'une marche à chaque
      // nouvel achat (de l'argent ajouté, pas un gain), ce qui écrasait
      // visuellement les indices de comparaison et rendait le graphique
      // trompeur sur 3-5 ans.
      const computed = candidateDates.map(date=>{
        let total = 0, anyPriced = false;
        for(const h of holdings){
          const s = seriesBySymbol[h.symbol];
          const pt = s ? findClosest(s, date) : null;
          if(!pt) continue; // pas encore de cotation à cette date (introduction en bourse plus récente, etc.)
          anyPriced = true;
          const ccy = resolveListedCurrency(liveBySymbol[h.symbol] || h);
          total += h.quantity * toEUR(pt.close, ccy, fxRates);
        }
        return anyPriced ? { date, totalValue: total } : null;
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
    const today = new Date().toISOString().slice(0,10);
    const daysSpan = Math.round((new Date(today) - new Date(startDate)) / 86400000);
    if(history.length===0 && benchmarkKeys.length===0){
      emptyMsg.textContent = "Ajoute des positions et/ou coche un indice de comparaison ci-dessus pour voir un graphique.";
    } else if(daysSpan >= 0 && daysSpan < 3){
      // Cas le plus fréquent : une date de départ trop proche d'aujourd'hui.
      // Une courbe a besoin d'au moins deux points de cotation.
      emptyMsg.textContent = `Période trop courte : il n'y a qu'un ou deux jours de cotation depuis le ${startDate}. Recule la date de départ, ou utilise le bouton « Depuis achat ».`;
    } else {
      emptyMsg.textContent = "Rien à afficher sur cette période — élargis la plage de dates ou coche un indice.";
    }
    if(chartInstance){ chartInstance.destroy(); chartInstance = null; }
    return;
  }
  canvas.style.display = "block";
  emptyMsg.style.display = "none";

  const datasets = [];

  // Ligne horizontale au point de départ (base 100) — repère visuel simple :
  // au-dessus = gain depuis le début de la période, en-dessous = perte.
  // Ajoutée en premier pour être dessinée DERRIÈRE les autres courbes.
  if(showBaseline){
    datasets.push({
      label: "Départ (100)",
      data: labels.map(()=>100),
      borderColor: "rgba(140,130,115,0.55)",
      borderWidth: 1,
      borderDash: [2,3],
      pointRadius: 0,
      pointHoverRadius: 0,
      fill: false,
      tension: 0,
    });
  }

  if(hasRetroLine){
    const sorted = [...retroSeries].sort((a,b)=>a.date.localeCompare(b.date));
    const base = sorted[0].totalValue;
    const findPf = (date) => { let best=null; for(const p of sorted){ if(p.date>date) break; best=p; } return best; };
    const pfIndexed = labels.map(d => {
      const p = findPf(d);
      return p ? (base>0 ? p.totalValue/base*100 : 100) : null;
    });
    datasets.push({
      label: "Portefeuille actuel (base 100, valorisé rétroactivement)",
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
  renderPlan();
  renderPortfolio();

  let msg = `Portefeuille "${name.trim()}" créé : ${matched.length} position(s), ${cash.length} ligne(s) de cash importées.`;
  msg += ` ⚠ Le prix d'achat = prix actuel du fichier (DEGIRO ne fournit pas le vrai prix de revient) — corrige chaque position via ✎ si tu veux une vraie plus-value.`;
  if(unmatched.length){
    msg += ` ${unmatched.length} titre(s) non retrouvé(s) dans le snapshot (prix ne se mettra pas à jour automatiquement) : ${unmatched.map(m=>m.name).join(', ')}.`;
  }
  toast(msg);
}

// ---------------------------------------------------------------
// Import Fortuneo (relevé de portefeuille PDF)
// ---------------------------------------------------------------

const MOIS_FR = {
  janvier:1, février:2, fevrier:2, mars:3, avril:4, mai:5, juin:6,
  juillet:7, août:8, aout:8, septembre:9, octobre:10, novembre:11, décembre:12, decembre:12,
};

/** "1 496,66" ou "-97,63" (notation française, espace = séparateur de
 * milliers) -> nombre JS. */
function parseFrenchAmount(str){
  if(str == null) return null;
  const cleaned = str.replace(/\s/g,'').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/** Extrait tout le texte d'un PDF via PDF.js (chargé sur cette page). */
async function extractPdfText(file){
  if(typeof pdfjsLib === "undefined"){
    throw new Error("La librairie de lecture PDF (PDF.js) n'a pas pu se charger depuis le CDN — vérifie ta connexion et recharge la page.");
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js";
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = "";
  for(let i = 1; i <= pdf.numPages; i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map(item => item.str).join(" ") + "\n";
  }
  return fullText;
}

/**
 * Parse le texte extrait d'un relevé de portefeuille Fortuneo. Repère
 * chaque ligne de titre en s'ancrant sur le code ISIN (identifiant fiable
 * et non ambigu), puis lit les nombres qui le suivent dans l'ordre connu
 * du tableau : Quantité, Cours, Date, Valorisation €, Valorisation %,
 * Prix de revient fiscal, +/- Value latente.
 *
 * Le "Prix de revient fiscal" donne le VRAI prix d'achat par action —
 * contrairement à DEGIRO, pas besoin de repli sur le prix actuel.
 * Fortuneo affiche tout déjà converti en euros, donc priceCurrency="EUR"
 * pour toutes les lignes.
 *
 * N'a pas pu être testé sur un vrai relevé (extraction PDF réelle) —
 * à vérifier et ajuster si le format ne correspond pas exactement.
 */
function parseFortuneoPDF(text){
  const positions = [];
  const isinRegex = /([A-Z]{2}[A-Z0-9]{9}[0-9])\s+(\d+)\s+(-?[\d\s]+,\d+)\s+(\d{2}\/\d{2}\/\d{2,4})\s+(-?[\d\s]+,\d+)\s+(-?[\d\s]+,\d+)\s+(-?[\d\s]+,\d+)\s+(-?[\d\s]+,\d+)/g;

  let lastEnd = 0;
  let match;
  while((match = isinRegex.exec(text)) !== null){
    // Fenêtre limitée aux ~200 derniers caractères avant l'ISIN, puis on
    // n'garde que la partie finale qui ressemble à un nom de valeur (suite
    // de lettres majuscules) — les noms de sociétés sont toujours en
    // majuscules dans ce type de relevé, contrairement au reste du texte
    // environnant (titres, adresse, numéro de compte avec des chiffres).
    const searchStart = Math.max(lastEnd, match.index - 200);
    const rawNameSegment = text.slice(searchStart, match.index);
    const nameMatch = rawNameSegment.match(/[A-ZÀ-Ÿ][A-ZÀ-Ÿ&.\-'() ]*$/);
    const cleanedSegment = nameMatch ? nameMatch[0] : rawNameSegment;
    // Le nom de la valeur est le dernier "mot" significatif juste avant
    // l'ISIN (nettoyage des en-têtes de section "■ Actions Europe" etc.
    // et des retours à la ligne).
    const name = cleanedSegment
      .replace(/■\s*Actions\s+\w+(\s*\(suite\))?/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    positions.push({
      name: name || match[1],
      isin: match[1],
      quantity: parseInt(match[2], 10),
      currentPrice: parseFrenchAmount(match[3]),
      valuationEUR: parseFrenchAmount(match[5]),
      costBasisPerShare: parseFrenchAmount(match[7]),
    });
    lastEnd = isinRegex.lastIndex;
  }

  const dateMatch = text.match(/Au\s+(\d{1,2})\s+(\S+)\s+(\d{4})/i);
  let statementDate = null;
  if(dateMatch){
    const monthNum = MOIS_FR[dateMatch[2].toLowerCase()];
    if(monthNum){
      statementDate = `${dateMatch[3]}-${String(monthNum).padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}`;
    }
  }

  return { positions, statementDate };
}

async function importFortuneoPDF(file){
  let text;
  try{
    text = await extractPdfText(file);
  }catch(e){
    toast("Échec de lecture du PDF : " + e.message);
    return;
  }

  const { positions, statementDate } = parseFortuneoPDF(text);
  if(positions.length === 0){
    toast("Aucune position reconnue dans ce PDF — le format ne correspond peut-être pas exactement à ce qui était attendu. Dis-le à Claude pour ajuster le parseur.");
    return;
  }

  let snap;
  try{ snap = await loadSnapshot(); }
  catch(e){ toast("Impossible de charger data-snapshot.json pour faire correspondre les titres : " + e.message); return; }

  const matched = matchDegiroToSnapshot(
    positions.map(p=>({ name:p.name, isin:p.isin, quantity:p.quantity, price:p.costBasisPerShare, currency:"EUR" })),
    snap.records
  );
  const unmatched = matched.filter(m=>!m.match);

  const name = prompt("Nom du nouveau portefeuille :", "Fortuneo");
  if(!name) return;
  const portfolioId = pfCreatePortfolio(name.trim());

  const purchaseDate = statementDate || new Date().toISOString().slice(0,10);
  matched.forEach(m=>{
    const symbol = m.match ? m.match.symbol : `MANUAL:${m.isin}`;
    const country = m.match ? m.match.country : null;
    pfAddHolding({
      symbol, name: m.name, country, isin: m.isin,
      quantity: m.quantity, purchasePrice: m.price, purchaseDate,
      priceCurrency: "EUR", // Fortuneo affiche tout déjà converti en euros
    }, portfolioId);
  });

  pfSetActivePortfolio(portfolioId);
  renderSwitcher();
  renderPlan();
  renderPortfolio();

  let msg = `Portefeuille "${name.trim()}" créé : ${matched.length} position(s) importées, avec le VRAI prix de revient fiscal Fortuneo (pas une approximation).`;
  msg += " Aucune ligne de cash détectée dans ce type de relevé — ajoute-la manuellement si besoin (+ Ajouter du cash).";
  if(unmatched.length){
    msg += ` ${unmatched.length} titre(s) non retrouvé(s) dans le snapshot : ${unmatched.map(m=>m.name).join(', ')}.`;
  }
  toast(msg);
}

/** Renseigne la valeur totale (positions + cash, en euros) dans chaque
 * onglet de portefeuille — permet de les comparer sans avoir à basculer
 * de l'un à l'autre. Silencieuse en cas d'échec : un onglet sans montant
 * reste utilisable. */
async function fillSwitcherValues(portfolios){
  let snap, fxRates;
  try{
    snap = await loadSnapshot();
    fxRates = await loadFxRates();
  }catch(e){ return; }

  portfolios.forEach(p=>{
    const el = document.querySelector(`[data-pf-value="${p.id}"]`);
    if(!el) return;
    try{
      const { rows } = computeHoldingsRows(p.holdings || [], snap, fxRates);
      const positions = rows.reduce((s,r)=> s + (r.currentValue!=null ? r.currentValue : r.costBasis), 0);
      const cash = (p.cash || []).reduce((s,c)=> s + (toEUR(c.amount, c.currency, fxRates) || 0), 0);
      const total = positions + cash;
      if(total > 0) el.textContent = fmtEUR(total);
    }catch(e){ /* portefeuille illisible : on laisse l'onglet sans montant */ }
  });
}

function renderSwitcher(){
  const wrap = document.getElementById("pfSwitcher");
  const portfolios = pfGetPortfolios();
  const activeId = pfGetActivePortfolioId();

  wrap.innerHTML = portfolios.map(p => `
    <div class="pf-tab ${p.id===activeId?'active':''}" data-pf-id="${p.id}">
      <span class="pf-tab-label">${p.name}</span>
      <span class="pf-tab-value" data-pf-value="${p.id}"></span>
      <button class="pf-menu-btn" data-pf-menu="${p.id}" title="Options">⋯</button>
    </div>
  `).join('') + `<button class="pf-add-btn" id="pfAddBtn">+ Nouveau portefeuille</button>`;

  // La valeur de chaque portefeuille est calculée en arrière-plan : elle
  // demande le snapshot et les taux de change, qu'on ne veut pas attendre
  // pour afficher les onglets eux-mêmes.
  fillSwitcherValues(portfolios);

  wrap.querySelectorAll(".pf-tab").forEach(tab=>{
    tab.addEventListener("click", (e)=>{
      if(e.target.closest(".pf-menu-btn")) return;
      pfSetActivePortfolio(tab.dataset.pfId);
      renderSwitcher();
      renderPlan();
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
      renderPlan();
      renderPortfolio();
    }
  });
}

async function initHoldingsSuffixSelector(){
  const suffixes = await loadHoldingsHistorySuffixes();
  if(suffixes.length === 0) return; // personne n'a encore utilisé --suffix -> pas besoin d'afficher ce réglage

  const row = document.getElementById("holdingsSuffixRow");
  const select = document.getElementById("holdingsSuffixSelect");
  const current = getHoldingsHistorySuffix();

  select.innerHTML = `<option value="">Aucun (fichier par défaut)</option>` +
    suffixes.map(s => `<option value="${s}" ${s===current?'selected':''}>${s}</option>`).join('');
  row.style.display = "flex";

  select.addEventListener("change", ()=>{
    setHoldingsHistorySuffix(select.value);
    toast(select.value ? `Historique "${select.value}" sélectionné — s'appliquera au prochain calcul du graphique.` : "Retour au fichier par défaut.");
    renderChart();
  });
}

function init(){
  const versionEl = document.getElementById("appVersion");
  if(versionEl) versionEl.textContent = "v7.31.0";
  renderSwitcher();
  renderPlan();
  renderPortfolio();
  initHoldingsSuffixSelector();
  document.getElementById("chartStartDate").addEventListener("change", renderChart);
  document.querySelectorAll('#benchmarkChips input[type=checkbox]').forEach(cb=>{
    cb.addEventListener("change", renderChart);
  });
  document.querySelectorAll('.quick-range-btn').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const today = new Date();
      let start;
      if(btn.dataset.range === "purchase"){
        // Date d'achat la plus fréquente parmi les positions actuelles —
        // pertinent pour une stratégie type Trending Value où tout le
        // panier est acheté le même jour : la courbe correspond alors
        // exactement à la performance réelle depuis la constitution.
        const counts = {};
        pfGetHoldings().forEach(h=>{ if(h.purchaseDate) counts[h.purchaseDate] = (counts[h.purchaseDate]||0)+1; });
        const dates = Object.keys(counts);
        if(dates.length === 0){
          toast("Aucune position avec une date d'achat — ajoute des positions d'abord.");
          return;
        }
        // à égalité de fréquence, on prend la plus ancienne (couvre toute la période)
        dates.sort((a,b)=> (counts[b]-counts[a]) || a.localeCompare(b));
        document.getElementById("chartStartDate").value = dates[0];
        document.querySelectorAll('.quick-range-btn').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        renderChart();
        return;
      }
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

  document.getElementById("closeoutBtn").addEventListener("click", openCloseoutModal);

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
  document.getElementById("importFortuneoBtn").addEventListener("click", ()=>{
    document.getElementById("importFortuneoFile").click();
  });
  document.getElementById("importFortuneoFile").addEventListener("change", (e)=>{
    const file = e.target.files[0];
    if(file) importFortuneoPDF(file);
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
