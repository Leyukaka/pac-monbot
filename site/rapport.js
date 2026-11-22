// PAC Monbot · page Analyse (espace privé) : rendu de /prive/api/analysis. Aucune dépendance.
// Nommé rapport.js : les bloqueurs de pub bloquent « analyse.js » (ressemble à un script de statistiques).
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const el = (t, a = {}, txt) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; };
  const fr = (v, d = 1) => v == null || !Number.isFinite(v) ? "-" : v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const eur = (v, d = 2) => fr(v, d) + " €";
  const BANDS = [["creuse", "Creuse", "var(--t-cool)"], ["base", "Base", "var(--t-warm)"], ["pointe", "Pointe", "var(--t-hot)"]];
  const BASE = location.pathname.startsWith("/prive/") ? "/prive" : "";
  const MONTH = (m) => new Date(m + "-15T12:00:00Z").toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  const day = (ts) => new Date(ts * 1000).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });

  // bulle partagée
  const tip = document.createElement("div"); tip.className = "tip num"; tip.hidden = true; document.body.appendChild(tip);
  const row = (c, n, v) => `<div><i style="background:${c}"></i>${n}<b>${v}</b></div>`;
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

  function bandBlock(prefix, b, unitLabel) {
    const tk = BANDS.reduce((s, [k]) => s + b[k].kwh, 0), te = BANDS.reduce((s, [k]) => s + b[k].eur, 0);
    const bar = (id, f, tot, unit) => { $(id).innerHTML = BANDS.map(([k, n, c]) => { const p = tot > 0 ? (100 * f(b[k])) / tot : 0;
      return p > 0 ? `<span style="width:${p.toFixed(2)}%;background:${c}" title="${n} ${fr(p, 0)} %">${p >= 8 ? `${n} ${fr(p, 0)} %` : ""}</span>` : ""; }).join("") +
      `<em>${unit}</em>`; };
    bar(prefix + "-kwh", (x) => x.kwh, tk, "kWh"); bar(prefix + "-eur", (x) => x.eur, te, "€");
    $(prefix + "-cells").innerHTML = BANDS.map(([k, n, c]) => `<div class="a-cell"><span class="label" style="color:${c}">${n}</span>` +
      `<b>${eur(b[k].eur)}</b><span>${fr(b[k].kwh, 0)} kWh · ${b[k].kwh > 0 ? fr(b[k].eur / b[k].kwh, 3) : "-"} €/kWh</span></div>`).join("");
    $(prefix + "-tot").textContent = `${fr(tk, 0)} kWh · ${eur(te)} · ${tk > 0 ? fr(te / tk, 3) : "-"} €/kWh en moyenne${unitLabel}`;
    return { tk, te };
  }

  let A = null, K = "wd";
  function drawProfile() {
    const svg = $("a-profile"), W = 1000, H = 260, pad = { l: 40, r: 10, t: 12, b: 24 }; svg.replaceChildren();
    const P = A.profile[K], sch = A.schedule[K], slot = (W - pad.l - pad.r) / 24;
    const top = Math.max(0.5, ...P.house, ...P.pac) * 1.1, y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
    sch.forEach((b, h) => svg.appendChild(el("rect", { x: pad.l + slot * h, y: pad.t, width: slot, height: H - pad.t - pad.b, class: "band-bg b-" + b })));
    for (let i = 0; i <= 4; i++) { const v = (top * i) / 4; svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: "a-gridline" }));
      svg.appendChild(el("text", { x: pad.l - 6, y: y(v) + 3, "text-anchor": "end", class: "a-axis" }, fr(v, v < 1 ? 2 : 1))); }
    P.house.forEach((v, h) => svg.appendChild(el("rect", { x: pad.l + slot * h + slot * 0.18, y: y(v), width: slot * 0.64, height: y(0) - y(v), fill: "var(--mist)", opacity: 0.85 })));
    if (P.pacDays) svg.appendChild(el("path", { d: P.pac.map((v, h) => (h ? "L" : "M") + (pad.l + slot * h + slot / 2).toFixed(1) + " " + y(v).toFixed(1)).join(""), fill: "none", stroke: "var(--t-hot)", "stroke-width": 2.2 }));
    for (let h = 0; h < 24; h += 3) svg.appendChild(el("text", { x: pad.l + slot * h, y: H - 6, class: "a-axis" }, `${h} h`));
    svg._fn = (p) => { const h = Math.floor((p.x - pad.l) / slot); if (h < 0 || h > 23) return null;
      const b = BANDS.find(([k]) => k === sch[h]);
      return `<div class="tip-h">${K === "wd" ? "semaine" : "week-end"} · ${h} h - ${h + 1} h · ${b[1].toLowerCase()}</div>` +
        row("var(--mist)", "maison", fr(P.house[h], 2) + " kWh") + (P.pacDays ? row("var(--t-hot)", "PAC", fr(P.pac[h], 2) + " kWh") : ""); };
    $("a-profile-why").textContent = `Moyenne sur ${P.houseDays} jours au compteur` + (P.pacDays ? ` et ${P.pacDays} jours de PAC` : "") +
      `. Fond : tranche tarifaire de l'heure.`;
  }

  function render() {
    const T = A.tariff;
    $("a-tariff").textContent = T.label;
    $("a-range").textContent = A.meterFrom ? `compteur ${day(A.meterFrom)} → ${day(A.meterTo)}` + (A.pacFrom ? ` · PAC depuis ${day(A.pacFrom)}` : "") : "pas de données compteur";
    $("a-prices").innerHTML = BANDS.filter(([k]) => T.prices[k]).map(([k, n, c]) => `<span class="pill" style="border-color:${c}"><b style="color:${c}">${n}</b> ${T.prices[k].map((p) => fr(p, 4)).join(" / ")} €/kWh</span>`).join("") +
      (T.shared ? `<span class="pill"><b>Partagé</b> ${fr(T.shared, 4)} €/kWh</span>` : "") + `<span class="label">prix tout compris du kWh (énergie, taxes, réseau, TVA)</span>`;

    const hs = bandBlock("a-house", A.bands.house, "");
    const ps = bandBlock("a-pac", A.bands.pac, A.pacFrom ? ` (depuis le ${day(A.pacFrom)})` : "");

    // partage
    const sh = A.bands.shared, sk = BANDS.reduce((s, [k]) => s + sh[k].kwh, 0), sg = BANDS.reduce((s, [k]) => s + sh[k].eur, 0);
    $("a-share-cells").innerHTML = BANDS.map(([k, n, c]) => `<div class="a-cell"><span class="label" style="color:${c}">${n}</span><b>${fr(sh[k].kwh, 0)} kWh</b>` +
      `<span>${sh[k].eur >= 0 ? "économie" : "surcoût"} ${eur(Math.abs(sh[k].eur))}</span></div>`).join("") +
      `<div class="a-cell"><span class="label">Total</span><b class="${sg >= 0 ? "pos" : "neg"}">${sg >= 0 ? "+" : "−"}${eur(Math.abs(sg))}</b><span>${fr(sk, 0)} kWh partagés</span></div>`;
    $("a-share-why").textContent = T.shared
      ? `Un kWh partagé coûte ${fr(T.shared, 4)} € (communauté + réseau). Le même kWh chez le fournisseur coûte ${BANDS.filter(([k]) => T.prices[k]).map(([k, n]) => `${n.toLowerCase()} ${T.prices[k].map((p) => fr(p, 3)).join("/")} €`).join(", ")}. ` +
        `Le partage n'est gagnant que quand il remplace des kWh plus chers que lui. Le partage arrive surtout en milieu de journée, quand la production est là.`
      : "Pas de prix de partage configuré.";

    // pics
    const svg = $("a-peaks"), W = 1000, H = 220, pad = { l: 46, r: 10, t: 12, b: 26 }; svg.replaceChildren();
    const pk = A.peaks, maxKw = Math.max(8, ...pk.map((p) => p.kw + 1)), maxQ = Math.max(1, ...pk.map((p) => p.q)), slot = (W - pad.l - pad.r) / maxKw;
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - Math.log10(1 + v) / Math.log10(1 + maxQ));
    pk.forEach((p) => svg.appendChild(el("rect", { x: pad.l + slot * p.kw + 2, y: y(p.q), width: slot - 4, height: y(0) - y(p.q), fill: T.pref && p.kw >= T.pref ? "var(--t-hot)" : "var(--t-cold)" })));
    for (let k = 0; k <= maxKw; k += 2) svg.appendChild(el("text", { x: pad.l + slot * k, y: H - 8, class: "a-axis" }, `${k} kW`));
    [1, 10, 100, 1000].filter((v) => v <= maxQ * 1.5).forEach((v) => { svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: "a-gridline" }));
      svg.appendChild(el("text", { x: pad.l - 6, y: y(v) + 3, "text-anchor": "end", class: "a-axis" }, String(v))); });
    if (T.pref) svg.appendChild(el("line", { x1: pad.l + slot * T.pref, x2: pad.l + slot * T.pref, y1: pad.t, y2: H - pad.b, stroke: "var(--frost)", "stroke-dasharray": "4 4" }));
    const totQ = pk.reduce((s, p) => s + p.q, 0), overQ = pk.filter((p) => T.pref && p.kw >= T.pref).reduce((s, p) => s + p.q, 0);
    svg._fn = (p) => { const k = Math.floor((p.x - pad.l) / slot), b = pk.find((x) => x.kw === k); if (!b) return null;
      return `<div class="tip-h">${k} à ${k + 1} kW</div>` + row(T.pref && k >= T.pref ? "var(--t-hot)" : "var(--t-cold)", "quarts d'heure", `${b.q} · ${fr((100 * b.q) / totQ, 1)} %`) + row("var(--mist)", "durée", fr(b.q / 4, 1) + " h"); };
    $("a-peaks-why").textContent = T.pref ? `${overQ} quarts d'heure sur ${totQ} (${fr((100 * overQ) / Math.max(1, totQ), 1)} %) au-dessus de la puissance de référence de ${fr(T.pref, 0)} kW. Échelle verticale logarithmique.` : "Puissance de référence non configurée.";

    // mois
    $("a-months").innerHTML = `<thead><tr><th>Mois</th><th>Jours</th><th>Maison kWh</th><th>Maison €</th><th>€/kWh</th><th>Partagé kWh</th><th>Partage €</th><th>PAC kWh</th><th>PAC €</th><th>Pic kW</th><th>&gt; Pref kWh</th></tr></thead><tbody>` +
      A.months.map((m) => `<tr><td>${MONTH(m.m)}</td><td>${fr(m.days, 1)}</td><td>${fr(m.houseKwh, 0)}</td><td>${fr(m.houseEur, 2)}</td><td>${m.houseKwh ? fr(m.houseEur / m.houseKwh, 3) : "-"}</td>` +
        `<td>${m.shared ? fr(m.shared, 0) : "-"}</td><td class="${m.gain >= 0 ? "pos" : "neg"}">${m.shared ? (m.gain >= 0 ? "+" : "−") + fr(Math.abs(m.gain), 2) : "-"}</td>` +
        `<td>${m.pacKwh ? fr(m.pacKwh, 0) : "-"}</td><td>${m.pacKwh ? fr(m.pacEur, 2) : "-"}</td><td>${fr(m.peak, 1)}</td><td>${fr(m.over, 1)}</td></tr>`).join("") + "</tbody>";

    // théorie : décalage pointe -> creuse
    const pC = T.prices.creuse?.[0], pP = T.prices.pointe?.slice(-1)[0];
    const sim = () => { const v = Number($("a-sim").value); $("a-sim-v").textContent = `${fr(v, 1)} kWh par jour`;
      $("a-sim-why").textContent = pC != null && pP != null
        ? `Déplacer ${fr(v, 1)} kWh par jour de la pointe (${fr(pP, 4)} €) vers la creuse (${fr(pC, 4)} €) économiserait ${eur(v * (pP - pC) * 30.4)} par mois, ${eur(v * (pP - pC) * 365, 0)} par an. ` +
          `Ordre de grandeur : un lave-linge à 60 °C consomme 1 à 1,5 kWh, un lave-vaisselle 1 à 1,5 kWh, une charge de ballon d'eau chaude par PAC 2 à 4 kWh.`
        : "Le tarif configuré n'a pas de tranches creuse et pointe."; };
    $("a-sim").oninput = sim; sim();

    // théorie : ECS la nuit
    const pp = A.bands.pac, pDays = Math.max(A.profile.wd.pacDays + A.profile.we.pacDays, 1);
    $("a-ecs-why").textContent = pC != null && pp.pointe.kwh > 0
      ? `Sur ${pDays} jours, la PAC a consommé ${fr(pp.pointe.kwh, 1)} kWh en pointe (${eur(pp.pointe.eur)}), soit ${fr(pp.pointe.kwh / pDays, 1)} kWh par jour. ` +
        `Si la moitié est de l'eau chaude programmable la nuit (hypothèse), le gain serait d'environ ${eur((pp.pointe.kwh / pDays / 2) * (pP - pC) * 30.4)} par mois. ` +
        `Réglage côté NIBE : programme « eau chaude » de la VVM 500 (Menu 2) sur 0 h - 6 h, et 12 h - 17 h le week-end. Le chauffage suit la météo et se décale peu.`
      : "Pas encore assez de données PAC en pointe.";

    // théorie : puissance de référence (frais fixes Creos 2026 HT, source switchr.lu / ILR)
    const FIX = { 3: 7.42, 7: 12.84, 12: 19.61, 17: 26.39 }, vat = 1.08;
    const months = A.months.filter((m) => m.days >= 20), avgOver = months.length ? months.reduce((s, m) => s + m.over, 0) / months.length : 0;
    $("a-pref-why").textContent = T.pref
      ? `Passer de ${T.pref} à 12 kW coûterait ${eur((FIX[12] - (FIX[T.pref] ?? FIX[7])) * vat)} de plus par mois en part fixe. ` +
        `Au-delà de ${T.pref} kW, tu tires en moyenne ${fr(avgOver, 1)} kWh par mois complet` +
        (T.overrun ? `, facturés ${eur(avgOver * T.overrun)}.` : `. Ta facture actuelle ne contient aucune ligne de dépassement : à ce jour, rester à ${T.pref} kW est le bon choix. Si Creos le facturait à 0,0765 € HT, cela ferait ${eur(avgOver * 0.0765 * vat)} par mois.`)
      : "Puissance de référence non configurée.";

    [$("a-profile"), $("a-peaks")].forEach((s) => { if (!s._hv) { s._hv = 1; hover(s, (p) => s._fn?.(p)); } });
    drawProfile();
  }

  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    K = b.dataset.k; document.querySelectorAll(".tabs button").forEach((o) => o.setAttribute("aria-pressed", String(o === b))); if (A) drawProfile();
  }));

  fetch(BASE + "/api/analysis", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((j) => {
    A = j; $("a-wait").hidden = true; render();
  }).catch((e) => { $("a-wait").textContent = e === 404 ? "Analyse réservée à l'espace privé." : "Analyse indisponible pour le moment."; });
})();
