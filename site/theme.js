// PAC/POWER · thèmes graphiques (nuit, jour, contraste, neumorphisme, glassmorphisme, cyber-brutalisme). Chargé sans defer dans <head> : pose
// html[data-theme] avant le premier rendu. Choix : mémorisé (localStorage.theme), sinon préférence du
// système (contraste élevé -> contraste, clair -> jour), sinon nuit. Le sélecteur n'apparaît que dans /prive/.
(() => {
  "use strict";
  const THEMES = {
    nuit: { label: "Thème nuit", color: "#0A111F" },
    jour: { label: "Thème jour", color: "#F4F7FB" },
    contraste: { label: "Thème contraste", color: "#000000" },
    neumorphisme: { label: "Thème neumorphisme", color: "#E0E5EC" },
    glassmorphisme: { label: "Thème glassmorphisme", color: "#120E2E" },
    "cyber-brutalisme": { label: "Thème cyber-brutalisme", color: "#050505" },
  };
  const root = document.documentElement;
  const mq = (q) => { try { return window.matchMedia(q); } catch { return null; } };
  const mqLight = mq("(prefers-color-scheme: light)"), mqMore = mq("(prefers-contrast: more)");

  const stored = () => { try { const s = localStorage.getItem("theme"); return s && Object.hasOwn(THEMES, s) ? s : null; } catch { return null; } };
  const auto = () => (mqMore?.matches ? "contraste" : mqLight?.matches ? "jour" : "nuit");

  function apply(name) {
    root.dataset.theme = name;
    let m = document.querySelector('meta[name="theme-color"]');
    if (!m && document.head) { m = document.createElement("meta"); m.name = "theme-color"; document.head.appendChild(m); }
    if (m) m.content = THEMES[name].color;
    document.querySelectorAll(".theme button[data-theme]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.theme === name)));
  }

  apply(stored() || auto());

  // Sans choix mémorisé, suivre les changements de préférence du système.
  const follow = () => { if (!stored()) apply(auto()); };
  for (const m of [mqLight, mqMore]) m?.addEventListener?.("change", follow);

  document.addEventListener("DOMContentLoaded", () => {
    if (!location.pathname.startsWith("/prive/")) return;
    const bar = document.querySelector("header.bar");
    if (!bar) return;
    const t = (s) => (window.I18N?.t ? window.I18N.t(s) : s);
    const g = document.createElement("div");
    g.className = "theme"; g.setAttribute("role", "group"); g.setAttribute("aria-label", t("Thème"));
    for (const [k, v] of Object.entries(THEMES)) {
      const b = document.createElement("button");
      b.type = "button"; b.dataset.theme = k;
      b.setAttribute("aria-label", t(v.label)); b.title = t(v.label);
      b.setAttribute("aria-pressed", String(root.dataset.theme === k));
      g.appendChild(b);
    }
    g.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-theme]"); if (!b) return;
      try { localStorage.setItem("theme", b.dataset.theme); } catch {}
      apply(b.dataset.theme);
    });
    const lang = bar.querySelector(":scope > .lang");
    if (lang) bar.insertBefore(g, lang); else bar.appendChild(g);
  });
})();
