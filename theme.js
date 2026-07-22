/* ===================================================================
   LE GRAND LIVRE — theme.js
   Bascule thème sombre (défaut) / clair, préférence sauvegardée en
   localStorage. Ce fichier est volontairement séparé et chargé tôt
   (avant le rendu du contenu) pour éviter un flash du mauvais thème
   au chargement de la page.
   =================================================================== */

const LGL_THEME_KEY = "lgl_theme";

function lglApplyThemeFromStorage(){
  try{
    const saved = localStorage.getItem(LGL_THEME_KEY);
    if(saved === "light") document.documentElement.setAttribute("data-theme", "light");
  }catch(e){}
}

// Appliqué immédiatement à l'exécution du script (placé tôt dans <head>),
// pas seulement au DOMContentLoaded, pour éviter le flash de thème sombre
// avant bascule vers le clair.
lglApplyThemeFromStorage();

function lglToggleTheme(){
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  if(isLight){
    document.documentElement.removeAttribute("data-theme");
    try{ localStorage.setItem(LGL_THEME_KEY, "dark"); }catch(e){}
  } else {
    document.documentElement.setAttribute("data-theme", "light");
    try{ localStorage.setItem(LGL_THEME_KEY, "light"); }catch(e){}
  }
  lglUpdateThemeBtnLabel();
}

function lglUpdateThemeBtnLabel(){
  const btn = document.getElementById("themeToggleBtn");
  if(!btn) return;
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  btn.textContent = isLight ? "☾ Sombre" : "☀ Clair";
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("themeToggleBtn");
  if(btn){
    btn.addEventListener("click", lglToggleTheme);
    lglUpdateThemeBtnLabel();
  }
});
