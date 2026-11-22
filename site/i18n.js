// PAC Monbot · langues. Le texte source est le français : il sert de clé. Aucune dépendance.
// Choix : ?lang=xx, sinon le choix mémorisé, sinon la langue du navigateur (navigator.languages), sinon l'anglais.
// Le HTML statique est traduit au chargement (nœuds texte + aria-label/title/alt + meta description) ;
// le JavaScript passe par I18N.t("texte source", { variables }).
(() => {
  "use strict";
  const LANGS = { fr: { name: "Français", locale: "fr-FR" }, en: { name: "English", locale: "en-GB" }, de: { name: "Deutsch", locale: "de-DE" } };
  const D = window.I18N_DICT || {};
  const pick = () => {
    const q = new URLSearchParams(location.search).get("lang");
    if (q && LANGS[q]) { try { localStorage.setItem("lang", q); } catch {} return q; }
    try { const s = localStorage.getItem("lang"); if (s && LANGS[s]) return s; } catch {}
    for (const l of navigator.languages || [navigator.language || ""]) { const k = String(l).slice(0, 2).toLowerCase(); if (LANGS[k]) return k; }
    return "en";
  };
  const lang = pick(), locale = LANGS[lang].locale, dict = lang === "fr" ? null : D[lang] || {};
  const miss = new Set();
  function t(s, vars) {
    let r = s;
    if (dict) { const v = dict[s]; if (v != null) r = v; else if (!miss.has(s)) { miss.add(s); if (location.hostname === "localhost") console.debug("[i18n] manque", lang, s); } }
    return vars ? r.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)) : r;
  }
  window.I18N = { lang, locale, t, langs: LANGS };
  document.documentElement.lang = lang;

  // HTML statique : remplace les textes connus du dictionnaire, espaces conservés.
  function translateTree(root) {
    if (!dict) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const k = n.nodeValue.trim(); if (!k || dict[k] == null) continue;
      n.nodeValue = n.nodeValue.replace(k, dict[k]);
    }
    root.querySelectorAll?.("[aria-label],[title],[alt]").forEach((e) => {
      for (const a of ["aria-label", "title", "alt"]) { const v = e.getAttribute(a); if (v && dict[v.trim()] != null) e.setAttribute(a, dict[v.trim()]); }
    });
  }
  if (dict) {
    if (dict[document.title]) document.title = dict[document.title];
    const md = document.querySelector('meta[name="description"]'); if (md && dict[md.content]) md.content = dict[md.content];
    translateTree(document.body);
  }

  // Sélecteur discret dans la barre du haut : FR · EN · DE, la langue active en gras.
  const bar = document.querySelector("header.bar");
  if (bar) {
    const nav = document.createElement("nav"); nav.className = "lang"; nav.setAttribute("aria-label", t("Langue"));
    nav.innerHTML = Object.entries(LANGS).map(([k, v]) => `<a href="?lang=${k}" hreflang="${k}" lang="${k}" title="${v.name}"${k === lang ? ' aria-current="true"' : ""}>${k.toUpperCase()}</a>`).join("");
    nav.addEventListener("click", (e) => {
      const a = e.target.closest("a"); if (!a) return; e.preventDefault();
      try { localStorage.setItem("lang", a.hreflang); } catch {}
      const u = new URL(location.href); u.searchParams.delete("lang"); location.replace(u.toString());
    });
    bar.appendChild(nav);
  }
})();
