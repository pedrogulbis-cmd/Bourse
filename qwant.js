/* ===================================================================
   LE GRAND LIVRE — qwant.js
   Rapprochement avec un export du screener Quant Investing (« Qwant ») :
   quels titres les deux sources retiennent, lesquels n'apparaissent que
   d'un côté (et pourquoi, côté Grand Livre), et où le momentum ou le
   rang divergent. Alimente aussi la colonne « Consensus Qwant » du
   tableau de résultats.

   Colonnes attendues dans l'export : Name, Country, ISIN, Ticker,
   Value Comp Two, Price Index 6m, Volatility 6m, Sector, Sub-Sector.
   L'ordre Qwant est celui de Trending Value : Price Index 6m décroissant.
   Rien n'est conservé d'une visite à l'autre : l'export reste en mémoire
   le temps de la page.
   =================================================================== */

let qwantRows = null;   // lignes de l'export, triées dans l'ordre Qwant
let qwantFileName = "";

const QWANT_MOM_GAP = 10; // écart de momentum signalé, en points

/* Noms de pays de Quant Investing -> nos codes. Les noms identiques à
   ceux de TradingView passent par TV_NAME_TO_CODE ci-dessous. */
const QWANT_COUNTRY_ALIASES = {
  "United States of America":"US", "Great Britain":"GB", "The Netherlands":"NL",
  "Taiwan (Republic of China)":"TW", "Korea":"KR", "Republic of Korea":"KR",
  "Czech Republic":"CZ", "Cyprus":"CY", "Russia":"RU",
};
const TV_NAME_TO_CODE = {
  "United States":"US","Canada":"CA","France":"FR","Germany":"DE","United Kingdom":"GB",
  "Netherlands":"NL","Switzerland":"CH","Spain":"ES","Italy":"IT","Belgium":"BE",
  "Sweden":"SE","Denmark":"DK","Norway":"NO","Finland":"FI","Portugal":"PT","Austria":"AT",
  "Ireland":"IE","Luxembourg":"LU","Poland":"PL","Japan":"JP","Australia":"AU","Hong Kong":"HK",
  "Singapore":"SG","South Korea":"KR","China":"CN","India":"IN","Taiwan":"TW","New Zealand":"NZ",
  "Greece":"GR","Hungary":"HU","Turkey":"TR","Israel":"IL","South Africa":"ZA","Brazil":"BR","Mexico":"MX",
};
function qwantCountryCode(name){
  return QWANT_COUNTRY_ALIASES[name] || TV_NAME_TO_CODE[name] || null;
}

/** Nom normalisé (sans formes juridiques ni classes d'actions), même
 * règle que le dédoublonnage du screener (companyKey, app.js). */
function qwantNameKey(name){
  return (name || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(NAME_NOISE_RE, " ").replace(/[^a-z0-9]+/g, " ").trim();
}
function tickerKey(code){
  return String(code == null ? "" : code).toUpperCase().replace(/^0+(?=\d)/, "").replace(/[._\-\s]/g, "");
}
/** Pays possibles d'un titre Grand Livre : cotation, domicile, et
 * « Chine » pour une société chinoise cotée à Hong Kong. */
function glCountries(r){
  return new Set([r.country, r.homeCountryCode, qiListingCountry(r)].filter(Boolean));
}

/** Lecture de l'export (xlsx ou csv) avec la librairie XLSX déjà chargée
 * pour l'export Excel. */
function parseQwantFile(file){
  return new Promise((resolve, reject)=>{
    if(typeof XLSX === "undefined"){ reject(new Error("librairie XLSX non chargée (connexion ?)")); return; }
    const reader = new FileReader();
    reader.onerror = ()=> reject(new Error("lecture du fichier impossible"));
    reader.onload = ()=>{
      try{
        const wb = XLSX.read(new Uint8Array(reader.result), {type:"array"});
        const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {defval:null});
        const pick = (row, names)=>{
          for(const k of Object.keys(row)){
            if(names.includes(k.trim().toLowerCase())) return row[k];
          }
          return null;
        };
        const num = v => (v === null || v === "" || isNaN(+v)) ? null : +v;
        const rows = raw.map(row=>({
          name: pick(row, ["name"]),
          country: pick(row, ["country"]),
          isin: (pick(row, ["isin"]) || "").toString().trim().toUpperCase() || null,
          ticker: pick(row, ["ticker"]),
          vc2: num(pick(row, ["value comp two","value composite two","vc2"])),
          priceIndex6m: num(pick(row, ["price index 6m","price index 6 m"])),
          volatility6m: num(pick(row, ["volatility 6m"])),
          sector: pick(row, ["sector"]),
          subSector: pick(row, ["sub-sector","sub sector","subsector"]),
        })).filter(r=>r.name || r.isin);
        if(!rows.length) throw new Error("aucune ligne exploitable");
        if(rows.every(r=>r.priceIndex6m == null)) throw new Error("colonne « Price Index 6m » introuvable");
        rows.sort((a,b)=>(b.priceIndex6m ?? -Infinity) - (a.priceIndex6m ?? -Infinity));
        rows.forEach((r,i)=>{
          r.rank = i + 1;
          r.mom6 = r.priceIndex6m != null ? (r.priceIndex6m - 1) * 100 : null; // 2,02 -> +102 %
          r.countryCode = qwantCountryCode(r.country);
        });
        resolve(rows);
      }catch(e){ reject(e); }
    };
    reader.readAsArrayBuffer(file);
  });
}

/** Index d'une liste de titres Grand Livre par ISIN, nom et ticker. */
function buildGlIndex(records){
  const byIsin = new Map(), byName = new Map(), byTicker = new Map();
  const add = (map, key, r)=>{ if(!key) return; if(!map.has(key)) map.set(key, []); map.get(key).push(r); };
  records.forEach(r=>{
    add(byIsin, r.isin, r);
    add(byName, qwantNameKey(r.name), r);
    add(byTicker, tickerKey((r.symbol || "").split(":")[1]), r);
  });
  return { byIsin, byName, byTicker };
}

/** Titre Grand Livre correspondant à une ligne Qwant : ISIN d'abord,
 * puis nom (même pays), puis ticker (même pays) — couvre les ISIN
 * différents d'une même société (A/H-shares, classes, ADR). */
function matchQwantRow(q, idx){
  const sameCountry = r => !q.countryCode || glCountries(r).has(q.countryCode);
  const first = list => (list || []).find(sameCountry) || null;
  if(q.isin && idx.byIsin.has(q.isin)) return { rec: idx.byIsin.get(q.isin)[0], how: "ISIN" };
  const byName = first(idx.byName.get(qwantNameKey(q.name)));
  if(byName) return { rec: byName, how: "nom" };
  const byTicker = first(idx.byTicker.get(tickerKey(q.ticker)));
  if(byTicker) return { rec: byTicker, how: "ticker" };
  return null;
}

/** Recalcule le consensus et le rapport à partir du dernier screening. */
function qwantRefresh(){
  const report = document.getElementById("qwantReport");
  if(!qwantRows){
    state.qwantConsensus = null;
    return;
  }
  if(!state.lastFullSorted){
    state.qwantConsensus = null;
    if(report) report.innerHTML = `<div class="empty-state">Export chargé (${qwantRows.length} lignes) — lance le screening pour le rapprocher de tes résultats.</div>`;
    return;
  }
  const topN = Math.max(1, parseInt(document.getElementById("qwantTopN").value, 10) || 100);
  state.qwantTopN = topN;

  const glList = state.lastFullSorted;                     // classement complet de la stratégie
  const glRank = new Map(glList.map((r,i)=>[r.symbol, i+1]));
  const glTop = glList.slice(0, topN);
  const listIdx = buildGlIndex(glList);
  const poolIdx = buildGlIndex(state.lastPool || []);

  // Chaque ligne Qwant -> titre Grand Livre (classement, sinon univers filtré)
  const qMatches = qwantRows.map(q=>{
    const m = matchQwantRow(q, listIdx) || matchQwantRow(q, poolIdx);
    return { q, rec: m ? m.rec : null, how: m ? m.how : null };
  });
  const qBySymbol = new Map();
  qMatches.forEach(m=>{ if(m.rec && !qBySymbol.has(m.rec.symbol)) qBySymbol.set(m.rec.symbol, m); });

  // 1) Top N Grand Livre présents dans l'export Qwant
  const common = glTop.filter(r=>qBySymbol.has(r.symbol)).map(r=>{
    const m = qBySymbol.get(r.symbol);
    const gap = (r.mom6 != null && m.q.mom6 != null) ? r.mom6 - m.q.mom6 : null;
    return { r, q: m.q, how: m.how, glRank: glRank.get(r.symbol), gap };
  });
  const glOnly = glTop.filter(r=>!qBySymbol.has(r.symbol));
  // 2) Top N Qwant absents du top N Grand Livre
  const qTop = qMatches.slice(0, topN);
  const glTopSet = new Set(glTop.map(r=>r.symbol));
  const qwantOnly = qTop.filter(m=>!(m.rec && glTopSet.has(m.rec.symbol)));
  const qInGlList = qTop.filter(m=>m.rec && glRank.has(m.rec.symbol)).length;

  // Consensus : présent dans les deux top N
  state.qwantConsensus = new Set(qTop.filter(m=>m.rec && glTopSet.has(m.rec.symbol)).map(m=>m.rec.symbol));
  const momGaps = common.filter(c=>c.gap != null && Math.abs(c.gap) > QWANT_MOM_GAP);
  const maxQRank = common.length ? Math.max(...common.map(c=>c.q.rank)) : null;

  if(report) report.innerHTML = renderQwantReport({ topN, glTop, glList, common, glOnly, qwantOnly, qInGlList, momGaps, maxQRank });
}

/** Pourquoi un titre du top Qwant n'est pas dans le top Grand Livre. */
async function explainQwantOnly(m, topN){
  if(m.rec){
    const rank = (state.lastFullSorted || []).findIndex(r=>r.symbol === m.rec.symbol) + 1;
    if(rank > 0) return `Classé ${rank}ᵉ chez toi (au-delà du top ${topN})`;
    return `Hors du seuil value chez toi : percentile composite ${m.rec.vc2Rank} (Qwant VC2 ${m.q.vc2 ?? "—"})`;
  }
  // Absent de l'univers filtré : exclu par un filtre, ou absent des données
  const snap = await loadSnapshot();
  const idx = buildGlIndex(snap.records);
  const hit = matchQwantRow(m.q, idx);
  if(!hit) return "Absent des données Grand Livre (snapshot)";
  const reason = state.lastExcluded && state.lastExcluded.get(hit.rec.symbol);
  return reason ? `Exclu par un filtre : ${reason}` : "Hors des pays / places sélectionnés";
}

const QWANT_CONCENTRATION = 20; // part (%) à partir de laquelle un secteur ou un pays est signalé

/** Drapeau + code pays (pays de cotation, comme dans le tableau des résultats). */
function countryCell(code){
  if(!code) return "—";
  return countryMeta(code) ? `${flagHTML(code)} ${code}` : code;
}
/** Secteur d'un titre Grand Livre : industrie TradingView si connue. */
function glSector(r){ return r.industry || r.sector || "—"; }
/** Secteur d'une ligne Qwant : sous-secteur (« Oil & Gas »), plus parlant
 * que le secteur (« Energy »). */
function qwSector(q){ return q.subSector || q.sector || null; }

/** Répartition d'une liste par clé, en part décroissante. */
function breakdown(items, keyFn){
  const counts = {};
  items.forEach(it=>{ const k = keyFn(it) || "—"; counts[k] = (counts[k] || 0) + 1; });
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([k,n])=>({k, n, pct: n / items.length * 100}));
}
function breakdownHTML(title, rows, labelFn){
  return `<div class="qwant-mix"><span class="qwant-mix-title">${title}</span>${rows.map(r=>
    `<span class="qwant-chip${r.pct >= QWANT_CONCENTRATION ? ' heavy' : ''}" title="${r.n} titre(s), ${r.pct.toFixed(0)} %">${labelFn(r.k)} <b>${r.n}</b></span>`).join("")}</div>`;
}

function fmtGap(v){ return v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(1) + " pts"; }

function renderQwantReport(d){
  const n = d.topN;
  const rowsCommon = d.common.map(c=>{
    const rankGap = c.q.rank - c.glRank;
    const flagged = c.gap != null && Math.abs(c.gap) > QWANT_MOM_GAP;
    const why = flagged ? [c.r.jumpAlert ? "saut dans la fenêtre" : null, c.r.takeover ? "suspicion OPA" : null, c.r.momSource === "tv" ? "fenêtre TradingView non datée" : null, c.r.momSource === "tr" ? "toi en rendement total" : null].filter(Boolean).join(", ") : "";
    return `<tr class="${flagged ? 'has-warn' : ''}">
      <td class="name"><span class="cname">${c.r.name}</span><span class="tkr">${c.r.symbol}</span></td>
      <td class="num">${countryCell(c.r.country)}${homeCountryBadge(c.r)}</td>
      <td title="Grand Livre : ${glSector(c.r)}${c.q.sector ? ' · Qwant : ' + c.q.sector : ''}">${qwSector(c.q) || glSector(c.r)}</td>
      <td class="num">${c.glRank}</td><td class="num">${c.q.rank}</td><td class="num">${rankGap >= 0 ? "+" : ""}${rankGap}</td>
      <td class="num">${fmtMom(c.r.mom6)}</td><td class="num">${fmtMom(c.q.mom6)}</td>
      <td class="num">${flagged ? `<span class="flag-alert" title="${why || 'cause non identifiée'}">⚠ ${fmtGap(c.gap)}</span>` : fmtGap(c.gap)}</td>
      <td class="num" title="${momWindowTitle(c.r)}">${momWindowLabel(c.r)}</td>
      <td class="num">${c.how}</td>
    </tr>`;
  }).join("");
  const rowsGlOnly = d.glOnly.map(r=>`<tr>
      <td class="name"><span class="cname">${r.name}</span><span class="tkr">${r.symbol}</span></td>
      <td class="num">${d.glList.indexOf(r) + 1}</td><td class="num">${countryCell(r.country)}${homeCountryBadge(r)}</td>
      <td title="${r.sector || ''}">${glSector(r)}</td>
      <td class="num">${r.vc2Rank}</td><td class="num">${fmtMom(r.mom6)}</td>
      <td class="num">${[r.takeover ? "⚠ OPA ?" : "", r.jumpAlert ? "⚠ saut" : ""].filter(Boolean).join(" ") || ""}</td>
    </tr>`).join("");
  const rowsQOnly = d.qwantOnly.map((m,i)=>`<tr>
      <td class="name"><span class="cname">${m.q.name}</span><span class="tkr">${m.q.ticker ?? ""} · ${m.q.isin ?? ""}</span></td>
      <td class="num">${m.q.rank}</td><td class="num" title="${m.q.country || ''}">${countryCell(m.q.countryCode) === "—" ? (m.q.country || "—") : countryCell(m.q.countryCode)}</td>
      <td title="${m.q.sector || ''}">${qwSector(m.q) || "—"}</td>
      <td class="num">${m.q.vc2 ?? "—"}</td><td class="num">${fmtMom(m.q.mom6)}</td>
      <td data-qwant-why="${i}">…</td>
    </tr>`).join("");

  // Les raisons « seulement Qwant » demandent le snapshot complet : remplies après coup.
  setTimeout(async ()=>{
    for(let i=0; i<d.qwantOnly.length; i++){
      const cell = document.querySelector(`[data-qwant-why="${i}"]`);
      if(cell) cell.textContent = await explainQwantOnly(d.qwantOnly[i], n);
    }
  }, 0);

  return `
    <div class="qwant-summary">
      <div class="card"><div class="lbl">Ton top ${n} aussi chez Qwant</div><div class="val">${d.common.length} / ${d.glTop.length}</div>
        <div class="sub-lines">${d.maxQRank ? `tous dans son top ${d.maxQRank}` : ""}</div></div>
      <div class="card"><div class="lbl">Top ${n} Qwant dans ton classement complet</div><div class="val">${d.qInGlList} / ${Math.min(n, qwantRows.length)}</div>
        <div class="sub-lines">${state.lastFullSorted.length} titres sous ton seuil value</div></div>
      <div class="card"><div class="lbl">Consensus (dans les deux top ${n})</div><div class="val">${state.qwantConsensus.size}</div>
        <div class="sub-lines">colonne « Consensus Qwant » du tableau</div></div>
      <div class="card"><div class="lbl">Écarts de momentum &gt; ${QWANT_MOM_GAP} pts</div><div class="val">${d.momGaps.length}</div>
        <div class="sub-lines">sur ${d.common.length} titres communs</div></div>
    </div>
    <div class="qwant-block">
      <h3>Titres communs (${d.common.length}) <span class="pea-hint">— rang et momentum comparés ; écart = Grand Livre − Qwant</span></h3>
      ${d.common.length ? breakdownHTML("Par secteur", breakdown(d.common, c=>qwSector(c.q) || glSector(c.r)), k=>k)
        + breakdownHTML("Par pays", breakdown(d.common, c=>c.r.country), k=>countryCell(k))
        + `<div class="pea-hint">En rouge : ${QWANT_CONCENTRATION} % ou plus des titres communs. Secteur = sous-secteur Quant Investing (industrie TradingView au survol).</div>` : ""}
      ${d.common.length ? `<table class="results"><thead><tr><th>Titre</th><th class="num">Pays</th><th>Secteur</th><th class="num">Rang GL</th><th class="num">Rang Qwant</th><th class="num">Écart de rang</th><th class="num">Mom. 6M GL</th><th class="num">Mom. 6M Qwant</th><th class="num">Écart</th><th class="num">Fenêtre GL</th><th class="num">Rapproché par</th></tr></thead><tbody>${rowsCommon}</tbody></table>` : `<div class="empty-state">Aucun titre commun.</div>`}
    </div>
    <div class="qwant-block">
      <h3>Seulement dans Grand Livre (${d.glOnly.length}) <span class="pea-hint">— de ton top ${n}, absents de l'export Qwant</span></h3>
      ${d.glOnly.length ? `<table class="results"><thead><tr><th>Titre</th><th class="num">Rang GL</th><th class="num">Pays</th><th>Secteur</th><th class="num">Percentile value</th><th class="num">Mom. 6M</th><th class="num">Alertes</th></tr></thead><tbody>${rowsGlOnly}</tbody></table>` : `<div class="empty-state">Aucun.</div>`}
    </div>
    <div class="qwant-block">
      <h3>Seulement dans Qwant (${d.qwantOnly.length}) <span class="pea-hint">— de son top ${n}, absents de ton top ${n}, avec la raison côté Grand Livre</span></h3>
      ${d.qwantOnly.length ? `<table class="results"><thead><tr><th>Titre</th><th class="num">Rang Qwant</th><th class="num">Pays</th><th>Secteur</th><th class="num">VC2 Qwant</th><th class="num">Mom. 6M Qwant</th><th>Chez Grand Livre</th></tr></thead><tbody>${rowsQOnly}</tbody></table>` : `<div class="empty-state">Aucun.</div>`}
    </div>`;
}

function initQwant(){
  const input = document.getElementById("qwantFile");
  const status = document.getElementById("qwantStatus");
  if(!input) return;
  input.addEventListener("change", async ()=>{
    const file = input.files && input.files[0];
    if(!file) return;
    status.textContent = "Lecture…";
    try{
      qwantRows = await parseQwantFile(file);
      qwantFileName = file.name;
      status.textContent = `${qwantFileName} : ${qwantRows.length} titres (ordre Qwant = Price Index 6m décroissant).`;
      qwantRefresh();
      if(state.lastResults && state.lastResults.length) renderResults();
    }catch(e){
      status.textContent = "Import impossible : " + e.message;
    }
    input.value = "";
  });
  document.getElementById("qwantTopN").addEventListener("change", ()=>{
    if(!qwantRows) return;
    qwantRefresh();
    if(state.lastResults && state.lastResults.length) renderResults();
  });
}

document.addEventListener("DOMContentLoaded", initQwant);
