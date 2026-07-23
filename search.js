/* ===================================================================
   LE GRAND LIVRE — search.js
   Recherche libre dans tout l'univers scrapé (pas seulement les
   résultats d'une stratégie du screener) — utile pour retrouver une
   action achetée il y a longtemps et l'ajouter au portefeuille même
   si elle ne sort dans aucun filtre.
   =================================================================== */

let allRecords = [];

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

function fmtPct(v){ return (v===null||v===undefined) ? "—" : (v*100>=0?"+":"")+(v*100).toFixed(1)+"%"; }
function fmtNum(v, d=1){ return (v===null||v===undefined) ? "—" : v.toFixed(d); }
function fmtMcap(v){
  if(!v) return "—";
  if(v>=1e12) return (v/1e12).toFixed(2)+"T";
  if(v>=1e9) return (v/1e9).toFixed(2)+"Md";
  if(v>=1e6) return (v/1e6).toFixed(0)+"M";
  return v.toString();
}
function analystBadgeHTML(label){
  if(!label) return '<span class="analyst-badge none">—</span>';
  const cls = label.toLowerCase().replace(' ','-');
  return `<span class="analyst-badge ${cls}">${label}</span>`;
}
function homeCountryBadge(s){
  if(!s.homeCountry) return '';
  if(s.homeCountryCode && s.homeCountryCode === s.country) return '';
  return `<span class="home-badge" title="Domicile réel : ${s.homeCountry} — coté ici sur un autre marché (ADR, cross-listing...)">🌐</span>`;
}

function matchesQuery(record, q){
  if(!q) return false;
  const needle = q.toLowerCase();
  return (record.name && record.name.toLowerCase().includes(needle))
    || (record.symbol && record.symbol.toLowerCase().includes(needle))
    || (record.isin && record.isin.toLowerCase().includes(needle));
}

function renderAddBtn(s){
  const held = pfIsHeld(s.symbol);
  if(held) return `<button class="add-btn added" title="Déjà dans le portefeuille" disabled>✓</button>`;
  return `<button class="add-btn" data-add-symbol="${s.symbol}" title="Ajouter au portefeuille">+</button>`;
}

function renderResults(matches, query){
  const statusEl = document.getElementById("searchStatus");
  const container = document.getElementById("searchResults");

  if(!query){
    statusEl.textContent = "";
    container.innerHTML = "";
    return;
  }
  if(matches.length === 0){
    statusEl.textContent = `Aucun résultat pour "${query}".`;
    container.innerHTML = "";
    return;
  }

  const shown = matches.slice(0, 50);
  statusEl.textContent = matches.length > 50
    ? `${matches.length} résultats — affichage des 50 premiers, affine ta recherche pour être plus précis.`
    : `${matches.length} résultat(s).`;

  let html = `<table class="results"><thead><tr>
    <th>Titre</th><th class="num">Prix</th><th class="num">Cap.</th><th class="num">P/E</th>
    <th class="num">Mom. 6M</th><th class="num">Analystes</th><th class="num">Pays</th><th></th>
  </tr></thead><tbody>`;
  shown.forEach(s=>{
    const cm = countryMeta(s.country);
    html += `<tr data-symbol="${s.symbol}">
      <td class="name"><span class="cname">${cm?flagHTML(s.country)+' ':''}${s.name}</span><span class="tkr">${s.symbol}</span>${s.isin?`<span class="isin">${s.isin}</span>`:''}</td>
      <td class="num">${s.price!=null?s.price.toLocaleString('fr-FR',{maximumFractionDigits:2}):'—'}</td>
      <td class="num">${fmtMcap(s.mcap)}</td>
      <td class="num">${fmtNum(s.pe)}</td>
      <td class="num ${s.mom6>=0?'pos':'neg'}">${fmtPct(s.mom6!=null?s.mom6/100:null)}</td>
      <td class="num">${analystBadgeHTML(s.analystLabel)}</td>
      <td class="num">${cm?flagHTML(s.country)+' '+cm.code:s.country||'—'}${homeCountryBadge(s)}</td>
      <td class="addcol">${renderAddBtn(s)}</td>
    </tr>`;
  });
  html += `</tbody></table>`;
  container.innerHTML = html;

  container.querySelectorAll(".add-btn[data-add-symbol]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const sym = btn.dataset.addSymbol;
      const record = allRecords.find(r=>r.symbol===sym);
      if(record) openAddToPortfolioModal(record);
    });
  });
}

function openAddToPortfolioModal(record){
  const today = new Date().toISOString().slice(0,10);
  const nativeCcy = resolveListedCurrency(record);
  const hasChoice = nativeCcy !== "EUR";
  const portfolios = pfGetPortfolios();
  const activeId = pfGetActivePortfolioId();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>${record.name}</h3>
      <div class="modal-sub">${record.symbol}${record.isin?' · '+record.isin:''} — ajouter au portefeuille</div>
      ${portfolios.length > 1 ? `
      <div class="modal-field">
        <label>Portefeuille</label>
        <select id="pfTarget" style="width:100%;background:var(--paper);border:1px solid var(--hairline-bright);color:var(--ink);padding:9px 10px;border-radius:4px;font-family:'IBM Plex Mono',monospace;font-size:0.88rem;">
          ${portfolios.map(p=>`<option value="${p.id}" ${p.id===activeId?'selected':''}>${p.name}</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="modal-field">
        <label>Date d'achat</label>
        <input type="date" id="pfDate" value="${today}" max="${today}">
      </div>
      <div class="modal-field">
        <label>Nombre d'actions</label>
        <input type="number" id="pfQty" value="1" min="0" step="any">
      </div>
      <div class="modal-field">
        <label>Prix d'achat (${record.price!=null?'prix actuel du snapshot par défaut':'prix inconnu, à renseigner'})</label>
        <div style="display:flex;gap:8px;">
          <input type="number" id="pfPrice" value="${record.price!=null?record.price:''}" min="0" step="any" style="flex:1;">
          ${hasChoice ? `
          <select id="pfPriceCcy" style="width:90px;background:var(--paper);border:1px solid var(--hairline-bright);color:var(--ink);border-radius:4px;font-family:'IBM Plex Mono',monospace;font-size:0.85rem;">
            <option value="${nativeCcy}">${nativeCcy}</option>
            <option value="EUR">EUR</option>
          </select>` : `<span style="align-self:center;color:var(--ink-faint);font-family:'IBM Plex Mono',monospace;font-size:0.85rem;padding:0 6px;">EUR</span>`}
        </div>
        ${hasChoice ? `<div style="font-size:0.7rem;color:var(--ink-faint);margin-top:5px;">Choisis "EUR" si ton courtier a converti et prélevé directement en euros.${nativeCcy==='GBX'?' ⚠ GBX = pence sterling (1 £ = 100 GBX) — vérifie bien avant de saisir le prix.':''}</div>` : ''}
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" id="pfCancel">Annuler</button>
        <button class="btn-confirm" id="pfConfirm">Ajouter</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = ()=> overlay.remove();
  overlay.addEventListener("click", (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector("#pfCancel").addEventListener("click", close);
  overlay.querySelector("#pfConfirm").addEventListener("click", ()=>{
    const qty = parseFloat(overlay.querySelector("#pfQty").value);
    const price = parseFloat(overlay.querySelector("#pfPrice").value);
    const date = overlay.querySelector("#pfDate").value;
    const priceCcySel = overlay.querySelector("#pfPriceCcy");
    const priceCurrency = priceCcySel ? priceCcySel.value : "EUR";
    const targetSel = overlay.querySelector("#pfTarget");
    const targetPortfolioId = targetSel ? targetSel.value : activeId;
    if(!qty || qty<=0){ toast("Nombre d'actions invalide."); return; }
    if(!price || price<=0){ toast("Prix d'achat invalide."); return; }
    if(!date){ toast("Date invalide."); return; }
    pfAddHolding({
      symbol: record.symbol, name: record.name, country: record.country, isin: record.isin || null,
      quantity: qty, purchasePrice: price, purchaseDate: date, priceCurrency,
    }, targetPortfolioId);
    const targetName = portfolios.find(p=>p.id===targetPortfolioId)?.name || "";
    toast(`${record.name} ajouté${targetName?` à "${targetName}"`:''}.`);
    close();
    doSearch(); // rafraîchit le bouton + -> ✓
  });
}

function toast(msg){
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 5000);
}

function doSearch(){
  const q = document.getElementById("searchInput").value.trim();
  const matches = q ? allRecords.filter(r=>matchesQuery(r,q)) : [];
  renderResults(matches, q);
}

let debounceTimer = null;
function init(){
  const versionEl = document.getElementById("appVersion");
  if(versionEl) versionEl.textContent = "v6.7.0";

  const statusEl = document.getElementById("searchStatus");
  statusEl.textContent = "Chargement de l'univers…";

  loadSnapshot().then(snap=>{
    allRecords = snap.records;
    statusEl.textContent = `Prêt — ${allRecords.length} titres disponibles.`;
  }).catch(err=>{
    statusEl.textContent = "Erreur de chargement : " + err.message;
  });

  document.getElementById("searchInput").addEventListener("input", ()=>{
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doSearch, 200);
  });
}

document.addEventListener("DOMContentLoaded", init);
