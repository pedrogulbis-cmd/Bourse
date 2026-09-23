/* ===================================================================
   LE GRAND LIVRE — theme.js
   Choix du thème : Clair (défaut), Sombre ou Système (suit le réglage de
   l'appareil). Préférence sauvegardée en localStorage. Ce fichier est
   volontairement séparé et chargé tôt (avant le rendu du contenu) pour
   éviter un flash du mauvais thème au chargement de la page.

   L'attribut posé sur <html> vaut toujours "light" ou "dark" (jamais
   "auto") : les styles et pwa.js n'ont que ces deux cas à connaître.
   =================================================================== */

const LGL_THEME_KEY = "lgl_theme";   // "light" | "dark" | "auto"
const LGL_THEMES = [
  ["light", "Clair",   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>'],
  ["dark",  "Sombre",  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>'],
  ["auto",  "Système", '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/></svg>'],
];
const lglMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function lglThemePref(){
  try{
    const v = localStorage.getItem(LGL_THEME_KEY);
    if(v === "light" || v === "dark" || v === "auto") return v;
  }catch(e){}
  return "light";
}

function lglApplyTheme(pref){
  const dark = pref === "auto" ? !!(lglMedia && lglMedia.matches) : pref === "dark";
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  const m = document.querySelector('meta[name="theme-color"]');
  if(m) m.setAttribute("content", dark ? "#0d0d10" : "#ffffff");
}

// Appliqué immédiatement à l'exécution du script (placé tôt dans <head>),
// pas seulement au DOMContentLoaded, pour éviter un flash de thème.
lglApplyTheme(lglThemePref());

function lglSetTheme(pref){
  try{ localStorage.setItem(LGL_THEME_KEY, pref); }catch(e){}
  lglApplyTheme(pref);
  lglRenderThemeSeg();
  // permet aux autres modules de réagir (ex. pwa.js régénère l'icône et le
  // manifeste pour qu'ils suivent le thème choisi)
  document.dispatchEvent(new CustomEvent("themechange"));
}

function lglRenderThemeSeg(){
  const seg = document.getElementById("themeSeg");
  if(!seg) return;
  const cur = lglThemePref();
  seg.innerHTML = LGL_THEMES.map(([k, label, icon]) =>
    `<button type="button" data-theme-pick="${k}" class="${cur === k ? "on" : ""}" aria-pressed="${cur === k}" title="Thème ${label.toLowerCase()}">${icon}<span>${label}</span></button>`
  ).join("");
}

// En mode Système, suit le basculement clair/sombre de l'appareil en direct.
if(lglMedia){
  const onSystemChange = () => {
    if(lglThemePref() !== "auto") return;
    lglApplyTheme("auto");
    document.dispatchEvent(new CustomEvent("themechange"));
  };
  if(lglMedia.addEventListener) lglMedia.addEventListener("change", onSystemChange);
  else if(lglMedia.addListener) lglMedia.addListener(onSystemChange);
}

document.addEventListener("DOMContentLoaded", () => {
  const seg = document.getElementById("themeSeg");
  if(!seg) return;
  lglRenderThemeSeg();
  seg.addEventListener("click", e => {
    const b = e.target.closest("[data-theme-pick]");
    if(b) lglSetTheme(b.dataset.themePick);
  });
});
