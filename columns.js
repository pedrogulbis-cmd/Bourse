/* ===================================================================
   LE GRAND LIVRE — columns.js
   Personnalisation des colonnes : ordre et visibilité, mémorisés d'une
   visite à l'autre (localStorage, donc propre à chaque navigateur).

   Choix d'interface : des flèches ↑ ↓ plutôt qu'un glisser-déposer.
   Le glisser-déposer est agréable à la souris mais pénible au doigt, et
   demanderait deux implémentations séparées ; les flèches fonctionnent
   identiquement sur ordinateur et sur téléphone.
   =================================================================== */

const COLPREF_PREFIX = "lgl_columns_";

/** Charge la préférence pour une table donnée, en la réconciliant avec les
 * colonnes réellement disponibles : une colonne ajoutée par une mise à jour
 * du site apparaît à la fin plutôt que de disparaître, et une colonne
 * supprimée est ignorée sans casser la préférence enregistrée. */
function loadColumnPrefs(tableId, allKeys){
  let saved = null;
  try{
    const raw = localStorage.getItem(COLPREF_PREFIX + tableId);
    if(raw) saved = JSON.parse(raw);
  }catch(e){ saved = null; }

  if(!saved || !Array.isArray(saved.order)){
    return { order: [...allKeys], hidden: [] };
  }
  const known = new Set(allKeys);
  const order = saved.order.filter(k=>known.has(k));
  allKeys.forEach(k=>{ if(!order.includes(k)) order.push(k); });
  const hidden = (saved.hidden || []).filter(k=>known.has(k));
  return { order, hidden };
}

function saveColumnPrefs(tableId, prefs){
  try{ localStorage.setItem(COLPREF_PREFIX + tableId, JSON.stringify(prefs)); }catch(e){}
}

function resetColumnPrefs(tableId){
  try{ localStorage.removeItem(COLPREF_PREFIX + tableId); }catch(e){}
}

/**
 * Ouvre le panneau de personnalisation.
 * @param {string} tableId   identifiant de stockage (ex. "screener")
 * @param {Array}  columns   [{key, label, fixed?}] — `fixed` empêche de
 *                           masquer une colonne indispensable (le nom du
 *                           titre, les actions), qu'on peut néanmoins
 *                           déplacer.
 * @param {Function} onApply appelée après validation, pour re-rendre.
 */
function openColumnsModal(tableId, columns, onApply){
  const allKeys = columns.map(c=>c.key);
  const labelOf = k => (columns.find(c=>c.key===k) || {}).label || k;
  const isFixed = k => !!(columns.find(c=>c.key===k) || {}).fixed;

  let prefs = loadColumnPrefs(tableId, allKeys);
  let order = [...prefs.order];
  let hidden = new Set(prefs.hidden);

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>Colonnes affichées</h3>
      <div class="modal-sub">Réordonne avec ↑ ↓, décoche pour masquer. Ton réglage est conservé sur cet appareil.</div>
      <div class="col-list" id="colList"></div>
      <div class="modal-actions">
        <button class="btn-cancel" id="colReset">Réinitialiser</button>
        <button class="btn-cancel" id="colCancel">Annuler</button>
        <button class="btn-confirm" id="colApply">Appliquer</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const list = overlay.querySelector("#colList");
  function render(){
    list.innerHTML = order.map((k,i)=>`
      <div class="col-row${hidden.has(k)?' off':''}" data-key="${k}">
        <label class="col-check">
          <input type="checkbox" ${hidden.has(k)?'':'checked'} ${isFixed(k)?'disabled':''}>
          <span>${labelOf(k)}${isFixed(k)?' <em>(toujours visible)</em>':''}</span>
        </label>
        <div class="col-moves">
          <button data-move="up" ${i===0?'disabled':''} title="Monter">↑</button>
          <button data-move="down" ${i===order.length-1?'disabled':''} title="Descendre">↓</button>
        </div>
      </div>`).join('');

    list.querySelectorAll(".col-row").forEach(row=>{
      const key = row.dataset.key;
      const cb = row.querySelector("input");
      if(cb) cb.addEventListener("change", ()=>{
        if(cb.checked) hidden.delete(key); else hidden.add(key);
        row.classList.toggle("off", !cb.checked);
      });
      row.querySelectorAll("[data-move]").forEach(btn=>{
        btn.addEventListener("click", ()=>{
          const i = order.indexOf(key);
          const j = btn.dataset.move === "up" ? i-1 : i+1;
          if(j < 0 || j >= order.length) return;
          [order[i], order[j]] = [order[j], order[i]];
          render();
        });
      });
    });
  }
  render();

  const close = ()=> overlay.remove();
  overlay.addEventListener("click", e=>{ if(e.target===overlay) close(); });
  overlay.querySelector("#colCancel").addEventListener("click", close);
  overlay.querySelector("#colReset").addEventListener("click", ()=>{
    resetColumnPrefs(tableId);
    close();
    onApply();
  });
  overlay.querySelector("#colApply").addEventListener("click", ()=>{
    saveColumnPrefs(tableId, { order, hidden: [...hidden] });
    close();
    onApply();
  });
}

/** Applique la préférence à une liste de colonnes : réordonne et retire
 * les masquées. Utilisé au moment de construire le tableau. */
function applyColumnPrefs(tableId, columns){
  const allKeys = columns.map(c=>c.key);
  const { order, hidden } = loadColumnPrefs(tableId, allKeys);
  const byKey = {};
  columns.forEach(c=>byKey[c.key]=c);
  return order.filter(k=>!hidden.includes(k)).map(k=>byKey[k]).filter(Boolean);
}
