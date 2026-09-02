/* ===================================================================
   LE GRAND LIVRE — pwa.js
   Installation sur l'écran d'accueil.

   L'icône est dessinée au canevas et le manifeste construit ici même :
   rien à déposer à côté des fichiers du site, et l'icône suit le thème
   choisi. Le navigateur peut alors proposer l'installation, et on relaie
   la proposition par un bandeau plutôt que d'attendre qu'il la range dans
   un menu que personne n'ouvre.

   Chargé par les 4 pages (index, search, portfolio, historique).
   =================================================================== */

const PWA_DISMISS_KEY = "lgl_install_dismissed";

/* ---------- icône : un graphique en barres montant, dans les tons laiton ---------- */
function pwaDrawIcon(size, maskable){
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d");

  const dark = document.documentElement.getAttribute("data-theme") !== "light";
  const bg = dark ? "#0F1512" : "#F7F4EC";
  const brass = "#C08A3E";
  const brassBright = "#E0AC5C";
  const verdigris = "#5B8A7A";

  // marge de sécurité pour les icônes "maskable" (le système peut rogner
  // les bords en cercle ou en losange selon le lanceur)
  const pad = maskable ? size * 0.14 : 0;
  const t = size - pad * 2, k = t / 64;

  if(maskable){
    x.fillStyle = bg;
    x.fillRect(0, 0, size, size);
  } else {
    const r = size * 0.22;
    x.beginPath();
    x.moveTo(r, 0); x.arcTo(size, 0, size, size, r); x.arcTo(size, size, 0, size, r);
    x.arcTo(0, size, 0, 0, r); x.arcTo(0, 0, size, 0, r); x.closePath();
    x.fillStyle = bg; x.fill();
  }

  // trois barres croissantes
  const barW = 10 * k, gap = 5 * k;
  const baseY = pad + 48 * k;
  const startX = pad + 13 * k;
  const heights = [16 * k, 24 * k, 33 * k];
  const colors = [brass, brass, brassBright];
  heights.forEach((h, i) => {
    x.fillStyle = colors[i];
    const bx = startX + i * (barW + gap);
    const by = baseY - h;
    const br = 2 * k;
    x.beginPath();
    x.moveTo(bx + br, by);
    x.arcTo(bx + barW, by, bx + barW, by + h, br);
    x.arcTo(bx + barW, by + h, bx, by + h, br);
    x.arcTo(bx, by + h, bx, by, br);
    x.arcTo(bx, by, bx + barW, by, br);
    x.closePath(); x.fill();
  });

  // ligne de tendance par-dessus
  x.strokeStyle = verdigris;
  x.lineWidth = 3 * k;
  x.lineCap = "round";
  x.lineJoin = "round";
  x.beginPath();
  x.moveTo(startX + barW / 2, baseY - heights[0] - 5 * k);
  x.lineTo(startX + barW + gap + barW / 2, baseY - heights[1] - 5 * k);
  x.lineTo(startX + 2 * (barW + gap) + barW / 2, baseY - heights[2] - 5 * k);
  x.stroke();

  // socle
  x.fillStyle = dark ? "#3A4640" : "#C9C0A8";
  x.fillRect(pad + 11 * k, baseY, 42 * k, 2.5 * k);

  return c.toDataURL("image/png");
}

/* ---------- manifeste, construit à la volée ---------- */
let _pwaManifestUrl = null;
function pwaUpdateManifest(){
  try{
    const dark = document.documentElement.getAttribute("data-theme") !== "light";
    const i192 = pwaDrawIcon(192, false);
    const i512 = pwaDrawIcon(512, false);
    const iMask = pwaDrawIcon(512, true);

    let at = document.querySelector('link[rel="apple-touch-icon"]');
    if(!at){ at = document.createElement("link"); at.rel = "apple-touch-icon"; document.head.appendChild(at); }
    at.href = i192;

    // start_url pointe vers index.html du MÊME dossier que la page courante —
    // le site vit dans un sous-dossier sur GitHub Pages, et on peut installer
    // depuis n'importe laquelle des 4 pages.
    const dir = location.pathname.replace(/[^/]*$/, "");
    const man = {
      name: "Le Grand Livre",
      short_name: "Grand Livre",
      description: "Screener quantitatif et suivi de portefeuille",
      start_url: dir + "index.html",
      scope: dir,
      display: "standalone",
      orientation: "portrait",
      lang: "fr",
      background_color: dark ? "#0F1512" : "#F7F4EC",
      theme_color: dark ? "#0F1512" : "#F7F4EC",
      icons: [
        { src: i192, sizes: "192x192", type: "image/png" },
        { src: i512, sizes: "512x512", type: "image/png" },
        { src: iMask, sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    };

    if(_pwaManifestUrl) URL.revokeObjectURL(_pwaManifestUrl);
    _pwaManifestUrl = URL.createObjectURL(new Blob([JSON.stringify(man)], { type: "application/manifest+json" }));
    let lm = document.querySelector('link[rel="manifest"]');
    if(!lm){ lm = document.createElement("link"); lm.rel = "manifest"; document.head.appendChild(lm); }
    lm.href = _pwaManifestUrl;

    let tc = document.querySelector('meta[name="theme-color"]');
    if(!tc){ tc = document.createElement("meta"); tc.name = "theme-color"; document.head.appendChild(tc); }
    tc.content = man.theme_color;
  }catch(e){
    /* une icône ratée ne doit jamais empêcher le site de fonctionner */
  }
}

/* ---------- invite d'installation ---------- */
let _pwaPrompt = null;

const pwaAlreadyInstalled = () => {
  try{
    if(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
  }catch(e){ /* matchMedia absent sur de vieux navigateurs — on continue */ }
  return window.navigator.standalone === true;
};

const pwaIsIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

function pwaDismissed(){
  try{ return localStorage.getItem(PWA_DISMISS_KEY) === "1"; }catch(e){ return false; }
}

window.addEventListener("beforeinstallprompt", ev => {
  // On garde la main sur le moment où l'invite apparaît, plutôt que de
  // laisser le navigateur la reléguer dans un menu.
  ev.preventDefault();
  _pwaPrompt = ev;
  pwaRenderBanner();
});

window.addEventListener("appinstalled", () => {
  _pwaPrompt = null;
  pwaRemoveBanner();
});

function pwaRemoveBanner(){
  const el = document.getElementById("pwaBanner");
  if(el) el.remove();
}

function pwaRenderBanner(){
  if(pwaAlreadyInstalled() || pwaDismissed()) return;
  if(!_pwaPrompt && !pwaIsIOS()) return;
  if(document.getElementById("pwaBanner")) return;

  const bar = document.createElement("div");
  bar.id = "pwaBanner";
  bar.className = "pwa-banner";

  if(_pwaPrompt){
    bar.innerHTML = `
      <div class="pwa-icon"><img src="${pwaDrawIcon(96, false)}" alt=""></div>
      <div class="pwa-text">
        <strong>Installer Le Grand Livre</strong>
        <span>Ajoute l'application à ton écran d'accueil — ouverture directe, plein écran, sans barre du navigateur.</span>
      </div>
      <div class="pwa-actions">
        <button class="pwa-btn-ghost" id="pwaDismiss">Plus tard</button>
        <button class="pwa-btn" id="pwaInstall">Installer</button>
      </div>`;
  } else {
    // iOS ne fournit pas d'invite programmable : on explique le geste.
    bar.innerHTML = `
      <div class="pwa-icon"><img src="${pwaDrawIcon(96, false)}" alt=""></div>
      <div class="pwa-text">
        <strong>Installer sur l'écran d'accueil</strong>
        <span>Appuie sur <b>Partager</b> en bas de Safari, puis sur <b>« Sur l'écran d'accueil »</b>.</span>
      </div>
      <div class="pwa-actions">
        <button class="pwa-btn-ghost" id="pwaDismiss">Compris</button>
      </div>`;
  }

  document.body.appendChild(bar);
  requestAnimationFrame(()=> bar.classList.add("visible"));

  const dismiss = bar.querySelector("#pwaDismiss");
  if(dismiss) dismiss.addEventListener("click", ()=>{
    try{ localStorage.setItem(PWA_DISMISS_KEY, "1"); }catch(e){}
    bar.classList.remove("visible");
    setTimeout(pwaRemoveBanner, 250);
  });

  const install = bar.querySelector("#pwaInstall");
  if(install) install.addEventListener("click", async ()=>{
    if(!_pwaPrompt) return;
    _pwaPrompt.prompt();
    try{ await _pwaPrompt.userChoice; }catch(e){}
    _pwaPrompt = null;
    bar.classList.remove("visible");
    setTimeout(pwaRemoveBanner, 250);
  });
}

/** Permet de reproposer l'installation même après un "Plus tard" —
 * appelable depuis la console ou un futur bouton de réglages. */
function pwaResetDismiss(){
  try{ localStorage.removeItem(PWA_DISMISS_KEY); }catch(e){}
  pwaRenderBanner();
}

document.addEventListener("DOMContentLoaded", ()=>{
  pwaUpdateManifest();
  // iOS n'émet jamais beforeinstallprompt : on propose le bandeau explicatif
  // au bout de quelques secondes, pour ne pas s'imposer dès l'ouverture.
  if(pwaIsIOS()) setTimeout(pwaRenderBanner, 4000);
});

// Le manifeste porte les couleurs du thème : on le régénère si l'utilisateur
// bascule clair/sombre, pour que l'icône installée reste cohérente.
document.addEventListener("themechange", pwaUpdateManifest);
