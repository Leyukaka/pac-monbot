// PAC/POWER · calculateur public : coût annuel de chaque offre d'électricité du marché luxembourgeois (réseau Creos)
// pour une consommation annuelle saisie. Données : /data/calculix.json (relevé daté du comparateur officiel ILR Calculix).
// Tout est calculé dans le navigateur, aucune API privée, aucune dépendance.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const el = (t, a = {}, txt) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; };
  const tr = (s, v) => (window.I18N ? window.I18N.t(s, v) : s), LOC = window.I18N?.locale || "fr-FR";
  const fr = (v, d = 0) => v == null || !Number.isFinite(v) ? "-" : v.toLocaleString(LOC, { minimumFractionDigits: d, maximumFractionDigits: d });
  const eur = (v, d = 0) => fr(v, d) + " €";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);

  // Liens de l'espace privé : visibles seulement sous /prive/ (liens relatifs, ils y restent).
  if (location.pathname.startsWith("/prive/")) document.querySelectorAll("[data-priv]").forEach((a) => { a.hidden = false; });

  // --- calcul --- (bloc pur, repris tel quel par le test Node)
  // Grille horaire « wd:0-6=0.09,6-17=0.13;we:... » -> { wd: [[de, à, prix], ...], we: [...] }
  const parseBands = (s) => { const out = {};
    for (const part of String(s || "").split(";")) { const m = part.trim().match(/^(wd|we|all)\s*:\s*(.+)$/); if (!m) return null;
      const xs = m[2].split(",").map((x) => x.trim().match(/^(\d+)-(\d+)=([\d.]+)$/));
      if (xs.some((x) => !x)) return null;
      out[m[1]] = xs.map((x) => [+x[1], +x[2], +x[3]]); }
    return Object.keys(out).length ? out : null; };
  // Niveaux de la grille : creux = prix le plus bas, pointe = le plus haut, base = moyenne des autres (ou pointe si deux niveaux).
  const bandLevels = (B) => { const ps = [...new Set(Object.values(B).flat().map((x) => x[2]))].sort((a, b) => a - b);
    const lo = ps[0], hi = ps[ps.length - 1], mid = ps.slice(1, -1);
    return { lo, hi, base: mid.length ? mid.reduce((s, v) => s + v, 0) / mid.length : hi }; };
  const BASE_SHARE = 0.7; // hors heures creuses : 70 % base (journée), 30 % pointe (soirée)
  const bandPrice = (L, share) => share * L.lo + (1 - share) * (BASE_SHARE * L.base + (1 - BASE_SHARE) * L.hi);
  // Part creuse qui redonne le prix moyen Calculix (energyKwh), bornée à [0, 1].
  const calculixShare = (L, e) => { const rest = BASE_SHARE * L.base + (1 - BASE_SHARE) * L.hi; return rest === L.lo ? 0 : Math.min(1, Math.max(0, (rest - e) / (rest - L.lo))); };
  // Coût annuel d'une offre : C kWh/an, P kW de puissance de référence, share = part creuse ou null (profil Calculix).
  function offerCost(D, o, C, P, share) {
    const N = D.network, X = D.taxes;
    let e = o.energyKwh;
    if (o.type === "bands" && share != null) { const B = parseBands(o.bands); if (B) e = bandPrice(bandLevels(B), share); }
    const energy = C * e, taxes = C * (X.compensationKwh + X.electricityTaxKwh);
    const fixedM = N.fixedMonthlyByPref[P] ?? N.fixedMonthlyByPref[7];
    const network = C * N.kwh + 12 * (fixedM + N.meteringMonthly), supplier = o.fixedYear;
    const ht = energy + taxes + network + supplier, ttc = ht * (1 + X.vat);
    return { e, energy, taxes, network, supplier, ht, ttc, month: ttc / 12, perKwh: C > 0 ? ttc / C : null };
  }
  // --- fin calcul ---

  const KEY = "calc.v1", PREFS = ["3", "7", "12", "17"];
  const S = { c: 12000, p: "7", mode: "calculix", share: null, best1: false };
  try { const j = JSON.parse(localStorage.getItem(KEY) || "null"); if (j && typeof j === "object") {
    if (Number.isFinite(j.c) && j.c >= 0 && j.c <= 200000) S.c = j.c;
    if (PREFS.includes(String(j.p))) S.p = String(j.p);
    if (j.mode === "mine" || j.mode === "calculix") S.mode = j.mode;
    if (Number.isFinite(j.share) && j.share >= 0 && j.share <= 1) S.share = j.share;
    S.best1 = !!j.best1; } } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };

  const TYPE = { fixed: "prix fixe", bands: "prix selon l'heure", spot: "prix variable du marché" };
  let D = null, DEF = 0.2, LAST = [];

  // bulle d'aide partagée (même rendu que les graphiques du site)
  const tip = document.createElement("div"); tip.className = "tip num"; tip.hidden = true; document.body.appendChild(tip);
  const trow = (c, n, v) => `<div><i style="background:${c}"></i>${n}<b>${v}</b></div>`;
  function hover(svg, fn) {
    const hide = () => { tip.hidden = true; };
    const move = (e) => {
      const m = svg.getScreenCTM(); if (!m) return hide();
      const r = fn(new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())); if (!r) return hide();
      tip.innerHTML = r; tip.hidden = false;
      const w = tip.offsetWidth, h = tip.offsetHeight, touch = e.pointerType === "touch";
      let x = e.clientX + 16, y = touch ? e.clientY - h - 28 : e.clientY + 16;
      if (x + w > innerWidth - 8) x = Math.max(8, e.clientX - w - 16);
      if (y + h > innerHeight - 8 || y < 8) y = Math.max(8, e.clientY - h - 16);
      tip.style.transform = `translate(${x}px, ${y}px)`;
    };
    svg.addEventListener("pointermove", move); svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") hide(); });
    addEventListener("scroll", hide, { passive: true });
  }

  const pressed = (box, attr, v) => box.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === String(v))));
  const shareNow = () => (S.mode === "mine" ? (S.share ?? DEF) : null);
  const dateTxt = () => new Date(D.date + "T12:00:00Z").toLocaleDateString(LOC, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

  function syncInputs() {
    const inp = $("k-c"); if (document.activeElement !== inp) inp.value = String(S.c);
    pressed($("k-presets"), "c", S.c); pressed($("k-pref"), "p", S.p); pressed($("k-mode"), "m", S.mode);
    const sh = S.mode === "mine" ? (S.share ?? DEF) : DEF; $("k-share").value = String(Math.round(sh * 100));
    $("k-share-v").textContent = fr(Math.round(sh * 100)) + " %";
    $("k-share").setAttribute("aria-valuetext", fr(Math.round(sh * 100)) + " %");
    $("k-best1").checked = S.best1;
  }

  function render() {
    syncInputs();
    const C = S.c, P = S.p, share = shareNow();
    let rows = D.offers.map((o) => ({ o, r: offerCost(D, o, C, P, share) })).sort((a, b) => a.r.ttc - b.r.ttc);
    if (S.best1) { const seen = new Set(); rows = rows.filter(({ o }) => (seen.has(o.supplier) ? false : seen.add(o.supplier))); }
    LAST = rows;
    const best = rows[0], worst = rows[rows.length - 1];
    const kind = (o) => tr(TYPE[o.type] || TYPE.fixed);

    $("k-best").innerHTML = `<span class="label">${esc(tr("Offre la moins chère pour {c} kWh par an", { c: fr(C) }))}</span>` +
      `<div class="k-best-row"><b class="k-best-v num">${eur(best.r.ttc)}</b><span class="k-best-u">${esc(tr("par an"))} · ${eur(best.r.month)} ${esc(tr("par mois"))}</span></div>` +
      `<p class="k-best-n"><strong>${esc(best.o.supplier)}</strong> · ${esc(best.o.name)} <span class="label">${esc(kind(best.o))}</span></p>` +
      `<p class="why">${esc(tr("Prix moyen tout compris {p} €/kWh. La plus chère coûte {d} de plus par an ({x}).", { p: fr(best.r.perKwh, 3), d: eur(worst.r.ttc - best.r.ttc), x: worst.o.supplier + " · " + worst.o.name }))}` +
      (best.o.type === "spot" ? " " + esc(tr("Attention : prix variable du marché, ce coût est une moyenne indicative.")) : "") + `</p>`;

    const head = ["Fournisseur", "Offre", "Type", "Coût annuel TTC", "Par mois", "Prix moyen €/kWh tout compris", "Écart"];
    $("k-table").innerHTML = `<thead><tr>${head.map((h) => `<th scope="col">${esc(tr(h))}</th>`).join("")}</tr></thead><tbody>` + rows.map(({ o, r }, i) => {
      const d = r.ttc - best.r.ttc;
      return `<tr${i === 0 ? ' class="k-top"' : ""}><td>${esc(o.supplier)}</td><td class="k-name">${esc(o.name)}${o.note ? `<br><span class="label">${esc(tr(o.note))}</span>` : ""}</td>` +
        `<td class="k-kind">${esc(kind(o))}${o.type === "spot" ? "*" : ""}</td><td><b>${eur(r.ttc)}</b></td><td>${eur(r.month)}</td><td>${fr(r.perKwh, 3)}</td>` +
        `<td class="${i === 0 ? "pos" : ""}">${i === 0 ? esc(tr("la moins chère")) : "+" + eur(d) + ` <span class="label">+${fr((100 * d) / best.r.ttc, 1)} %</span>`}</td></tr>`;
    }).join("") + "</tbody>";

    $("k-chart-l").textContent = tr("{c} kWh/an · {p} kW · TTC", { c: fr(C), p: P });
    drawChart();
  }

  function drawChart() {
    const svg = $("k-chart"), rows = LAST; if (!rows.length) return;
    const W = Math.max(280, Math.round(svg.parentElement.clientWidth - 28)), rowH = 40, pad = { l: 0, r: 64, t: 6, b: 22 };
    const H = pad.t + rows.length * rowH + pad.b;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H); svg.replaceChildren();
    const max = Math.max(...rows.map((x) => x.r.ttc)), step = max > 4000 ? 1000 : max > 1500 ? 500 : max > 600 ? 200 : 100;
    const top = Math.ceil(max / step) * step || step, x = (v) => pad.l + (W - pad.l - pad.r) * (v / top);
    for (let v = 0; v <= top; v += step) {
      svg.appendChild(el("line", { x1: x(v), x2: x(v), y1: pad.t, y2: H - pad.b, class: "a-gridline" }));
      svg.appendChild(el("text", { x: x(v), y: H - 6, "text-anchor": v === 0 ? "start" : "middle", class: "a-axis" }, fr(v) + (v === top ? " €" : "")));
    }
    rows.forEach(({ o, r }, i) => {
      const y0 = pad.t + i * rowH;
      svg.appendChild(el("text", { x: pad.l, y: y0 + 13, class: "k-bar-l" }, `${o.supplier} · ${o.name}`));
      svg.appendChild(el("rect", { x: pad.l, y: y0 + 19, width: Math.max(1, x(r.ttc) - pad.l), height: 12, class: i === 0 ? "k-bar k-bar-best" : o.type === "spot" ? "k-bar k-bar-spot" : "k-bar" }));
      svg.appendChild(el("text", { x: x(r.ttc) + 6, y: y0 + 29, class: "a-axis k-bar-v" }, eur(r.ttc)));
    });
    svg._fn = (p) => { const i = Math.floor((p.y - pad.t) / rowH); const it = rows[i]; if (!it) return null;
      const d = it.r.ttc - rows[0].r.ttc, c = i === 0 ? "var(--ok)" : it.o.type === "spot" ? "var(--t-warm)" : "var(--t-cold)";
      return `<div class="tip-h">${esc(it.o.supplier)} · ${esc(it.o.name)}</div>` + trow(c, esc(tr("par an")), eur(it.r.ttc)) + trow(c, esc(tr("par mois")), eur(it.r.month)) +
        trow("var(--mist)", "€/kWh", fr(it.r.perKwh, 3)) + (i ? trow("var(--mist)", esc(tr("écart")), "+" + eur(d)) : ""); };
    if (!svg._hv) { svg._hv = 1; hover(svg, (p) => svg._fn?.(p)); }
  }

  function bindInputs() {
    const inp = $("k-c");
    inp.addEventListener("input", () => {
      const v = inp.value.trim() === "" ? NaN : Number(inp.value), ok = Number.isFinite(v) && v >= 0 && v <= 200000;
      inp.setAttribute("aria-invalid", String(!ok)); $("k-c-err").hidden = ok;
      if (!ok) return; S.c = Math.round(v); save(); render();
    });
    inp.addEventListener("blur", () => { if (inp.getAttribute("aria-invalid") !== "true") inp.value = String(S.c); });
    $("k-presets").addEventListener("click", (e) => { const b = e.target.closest("button[data-c]"); if (!b) return;
      S.c = Number(b.dataset.c); inp.value = String(S.c); inp.setAttribute("aria-invalid", "false"); $("k-c-err").hidden = true; save(); render(); });
    $("k-pref").addEventListener("click", (e) => { const b = e.target.closest("button[data-p]"); if (!b) return; S.p = b.dataset.p; save(); render(); });
    $("k-mode").addEventListener("click", (e) => { const b = e.target.closest("button[data-m]"); if (!b) return; S.mode = b.dataset.m; save(); render(); });
    $("k-share").addEventListener("input", (e) => { S.share = Number(e.target.value) / 100; S.mode = "mine"; save(); render(); });
    $("k-best1").addEventListener("change", (e) => { S.best1 = e.target.checked; save(); render(); });
    let raf = 0; addEventListener("resize", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(drawChart); }, { passive: true });
  }

  // Heures creuses lues dans la grille (prix le plus bas), pour le texte d'aide du curseur.
  function creuxText(B) {
    const lo = bandLevels(B).lo, part = (k) => (B[k] || []).filter((x) => x[2] === lo).map((x) => `${x[0]}-${x[1]} h`).join(", ");
    const out = [];
    if (B.all) out.push(part("all"));
    if (B.wd) out.push(tr("semaine {r}", { r: part("wd") }));
    if (B.we) out.push(tr("week-end {r}", { r: part("we") }));
    return out.filter(Boolean).join(" ; ");
  }

  fetch("/data/calculix.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((j) => {
    if (!j || !Array.isArray(j.offers) || !j.offers.length || !j.network || !j.taxes) throw new Error("data");
    D = j;
    // Part creuse par défaut : celle qui redonne le prix moyen Calculix des offres à tranches (moyenne si plusieurs).
    const bands = D.offers.filter((o) => o.type === "bands").map((o) => ({ o, B: parseBands(o.bands) })).filter((x) => x.B);
    if (bands.length) DEF = Math.round(100 * bands.reduce((s, { o, B }) => s + calculixShare(bandLevels(B), o.energyKwh), 0) / bands.length) / 100;
    $("k-share-help").textContent = bands.length
      ? tr("Heures creuses de la grille : {h}. Profil Calculix = {d} % ; plus tu décales de consommation (chauffe-eau, voiture, lave-linge) vers ces heures, plus la part monte.", { h: creuxText(bands[0].B), d: fr(DEF * 100) })
      : tr("Aucune offre à prix selon l'heure dans ce relevé.");
    if (!bands.length) { $("k-share").disabled = true; $("k-mode").querySelectorAll("button").forEach((b) => { b.disabled = true; }); }
    const d = dateTxt();
    $("k-date").textContent = tr("relevé du {d}", { d });
    $("k-src").innerHTML = `<b>${esc(tr("Prix relevés sur le comparateur officiel de l'ILR (calculix.lu) le {d}", { d }))}</b> ; ` +
      esc(tr("ils changent rarement mais vérifie sur calculix.lu avant de changer de fournisseur.")) + " " +
      esc(tr("Réseau {n}, puissance de référence au choix, remises de bienvenue exclues.", { n: D.network.name || "Creos" }));
    $("k-wait").hidden = true; $("k-out").hidden = false;
    bindInputs(); render();
  }).catch(() => { $("k-wait").textContent = tr("Les prix des offres sont indisponibles pour le moment. Réessaie plus tard ou consulte calculix.lu."); });
})();
