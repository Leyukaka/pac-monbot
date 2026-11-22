// PAC Monbot : rendu à partir de /api/now et /api/series. Aucune dépendance.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const el = (t, a = {}, txt) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; };
  const fr = (v, d = 1) => v == null || !Number.isFinite(v) ? "-" : v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const W_PER_HZ = 40;      // estimation puissance électrique F2120 : ~40 W par Hz (64 Hz ≈ 2,6 kW)
  const VOLT = 230;

  // Identifiants des points (voir src/worker.js TRACKED).
  const ID = {
    out: "40004", supply: "40008", ret: "40012", calc: "43009", ecsTop: "40013", ecsChg: "40014",
    dm: ["40940"], addFactor: "43081", gp1: "43437", gp12: "44396",
    pNow: "32486", prodH: "32491", prodE: "32492", useH: "32495", useE: "32496", addH: "32499", addE: "32500",
    year: "50321", yearProd: "50322", evi: "41025",
    be3: "40079", be2: "40081", be1: "40083",
    hz: "44701", state: "44064", defrost: "44703", starts: "44069", hours: "44071", hoursEcs: "44073",
    dis: "44059", liq: "44060", suc: "44061", evap: "44363", condOut: "44058", unitRet: "44055", bt28: "44362",
    hp: "41163", lp: "41162", flow: "40072",
  };

  let NOW = null;
  const nowS = () => NOW?.server || Math.floor(Date.now() / 1000);
  // Fenêtre des courbes [from, to] en secondes ; domaine de la frise [d0, d1].
  let WIN = null, DOM = null, OVER = null, FOLLOW = true; // FOLLOW : la fenêtre colle au présent
  const MIN_WIN = 2 * 3600;

  const val = (pid) => { const ids = Array.isArray(pid) ? pid : [pid]; for (const p of ids) { const r = NOW?.points?.[p]; if (r && r.last_val != null) return r.last_val; } return null; };
  const unit = (pid) => NOW?.points?.[pid]?.unit || "";
  const dmId = () => ID.dm.find((p) => NOW?.points?.[p]?.last_val != null) || ID.dm[0];

  // Sous /prive/ (Cloudflare Access), l'API privée inclut les phases maison.
  const BASE = location.pathname.startsWith("/prive/") ? "/prive" : "";
  async function getJSON(u) { const r = await fetch(BASE + u, { cache: "no-store" }); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }

  // ---------- état actuel ----------
  function renderNow() {
    const has = NOW && Object.keys(NOW.points || {}).length > 0;
    const w = $("wait");
    const last = NOW?.poll?.last;
    if (!has) {
      w.hidden = false;
      w.innerHTML = "<b>En attente de la première collecte.</b> Le collecteur interroge myUplink toutes les 5 minutes." +
        (last && !last.ok ? " La dernière tentative a échoué, nouvel essai dans 5 minutes." : "");
    } else w.hidden = true;

    const lastOk = NOW?.poll?.lastOk;
    const age = lastOk ? (NOW.server - lastOk) : null;
    $("stamp").textContent = lastOk ? "Relevé " + new Date(lastOk * 1000).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "Relevé -";
    $("stamp").classList.toggle("stale", age != null && age > 1200);
    const alarm = (NOW?.alarms || []).length;
    $("online").textContent = alarm ? alarm + " alarme" + (alarm > 1 ? "s" : "") : has ? "VVM 500 en ligne" : "VVM 500";
    $("dot").style.background = alarm ? "var(--crit)" : age != null && age > 1200 ? "var(--warn)" : "var(--ok)";
    $("ext").textContent = "Ext. " + fr(val(ID.out)) + " °C";

    const hz = val(ID.hz), sup = val(ID.supply), ret = val(ID.ret), calc = val(ID.calc), dm = val(dmId());
    const defrost = val(ID.defrost);
    const ecsOn = val(ID.gp12) > 0 && sup != null && calc != null && sup > calc + 4;
    $("mode").textContent = hz > 0 ? `Compresseur ${fr(hz, 0)} Hz · ${defrost > 0 ? "dégivrage" : ecsOn ? "eau chaude" : "chauffage"}` : "Compresseur à l'arrêt";
    $("supply").textContent = fr(sup);
    $("ret").textContent = fr(ret) + "°";
    $("calc").textContent = fr(calc) + "°";
    $("ecs").textContent = fr(val(ID.ecsTop)) + "°";
    if (dm != null) { $("dmcur").style.left = Math.max(0, Math.min(100, (dm + 300) / 4)) + "%"; $("dmv").textContent = fr(dm, 0); $("dmbar").setAttribute("aria-label", "Degrés-minutes " + fr(dm, 0)); }

    // cycle
    $("s-hz").textContent = hz != null ? fr(hz, 0) + " Hz" : "-";
    $("s-cond").textContent = fr(val(ID.hp)) + "°";
    $("s-evap").textContent = fr(val(ID.evap)) + "°";
    $("s-lp").textContent = "BP8 " + fr(val(ID.lp)) + (unit(ID.lp) || "");
    $("s-dis").textContent = fr(val(ID.dis)) + "° refoul.";
    $("s-suc").textContent = fr(val(ID.suc)) + "° aspi.";
    $("s-liq").textContent = fr(val(ID.liq)) + "° liquide";
    $("s-evi").textContent = "DÉTENDEUR · EVI " + fr(val(ID.evi), 0);
    $("s-ret").textContent = "retour BT3 " + fr(val(ID.unitRet)) + "°";
    $("u-sup").textContent = "eau chaude BT12 " + fr(val(ID.condOut)) + "°";
    $("o-bt28").textContent = "BT28 " + fr(val(ID.bt28)) + "°";
    $("o-bt1").textContent = "BT1 " + fr(val(ID.out)) + "°";
    $("h-ecs").textContent = fr(val(ID.ecsTop)) + "°";
    $("h-ecs2").textContent = "BT6 " + fr(val(ID.ecsChg)) + "°";
    $("h-add").textContent = "appoint BT63 " + fr(val("40121")) + "°";
    $("h-addf").textContent = "facteur " + fr(val(ID.addFactor));
    $("h-gp12").textContent = "GP12 " + fr(val(ID.gp12), 0) + " %";
    $("h-gp1").textContent = "GP1 " + fr(val(ID.gp1), 0) + " %";
    $("h-sup").textContent = "BT2 " + fr(sup) + "°";
    $("h-ret").textContent = "BT3 " + fr(ret) + "°";
    animatePlant(hz, defrost > 0);

    renderDiag();
    renderEnergy();
  }

  // Vitesse proportionnelle : fréquence compresseur pour le fluide, le rotor et le ventilateur,
  // vitesse de pompe pour l'eau. Dégivrage : cycle inversé, ventilateur arrêté, badge.
  function animatePlant(hz, defrost) {
    const lerp = (x, x0, x1, y0, y1) => y0 + (Math.max(x0, Math.min(x1, x)) - x0) * (y1 - y0) / (x1 - x0);
    const set = (sel, on, dur) => document.querySelectorAll(sel).forEach((p) => { p.style.animationPlayState = on ? "running" : "paused"; p.style.animationDuration = dur.toFixed(2) + "s"; });
    const run = hz > 0 || defrost;
    const fDur = lerp(hz || 40, 20, 110, 2.6, 0.45);          // 20 Hz lent, 110 Hz rapide
    const gp12 = val(ID.gp12) || 0, gp1 = val(ID.gp1) || 0;
    set("#plant .rflow", run, fDur);
    set("#rotor", run, lerp(hz || 40, 20, 110, 2.2, 0.25));
    set("#fan", hz > 0 && !defrost, lerp(hz || 40, 20, 110, 3.2, 0.6));
    set("#plant .wflow", run || gp12 > 0, lerp(gp12 || 50, 5, 100, 2.8, 0.7));
    set("#plant .hflow", gp1 > 0, lerp(gp1, 5, 100, 2.8, 0.7));
    $("plant").classList.toggle("defrost", !!defrost);
    // Logo : la particule suit le compresseur (6 s à 20 Hz, 1,8 s à 110 Hz), immobile à l'arrêt.
    const mk = $("mark");
    if (mk && mk.pauseAnimations) {
      const d = lerp(hz || 40, 20, 110, 6, 1.8).toFixed(2) + "s";
      ["mk-move", "mk-fill"].forEach((id) => { const a = $(id); if (a && a.getAttribute("dur") !== d) a.setAttribute("dur", d); });
      run ? mk.unpauseAnimations() : mk.pauseAnimations();
    }
    $("defrost-tag").setAttribute("visibility", defrost ? "visible" : "hidden");
  }

  function chip(label, v, u, why, st, level, na) {
    return `<div class="chip${v == null ? " na" : ""}" style="--s:var(--${v == null ? "mist" : level})"><span class="label">${label}</span><b>${v == null ? "-" : v}${u ? `<small>${u}</small>` : ""}</b><span class="why">${why}</span><span class="st">${v == null ? (na || "Pas encore de donnée") : st}</span></div>`;
  }
  function band(x, okLo, okHi, warnLo, warnHi) { if (x == null) return "mist"; if (x >= okLo && x <= okHi) return "ok"; if (x >= warnLo && x <= warnHi) return "warn"; return "crit"; }

  function renderDiag() {
    const hz = val(ID.hz);
    const sh = val(ID.suc) != null && val(ID.evap) != null ? val(ID.suc) - val(ID.evap) : null;
    const hpC = unit(ID.hp).includes("°") || unit(ID.hp) === "" ? val(ID.hp) : null;
    const sc = hpC != null && val(ID.liq) != null ? hpC - val(ID.liq) : null;
    const dt = val(ID.supply) != null && val(ID.ret) != null ? val(ID.supply) - val(ID.ret) : null;
    const dis = val(ID.dis);
    const c7 = NOW?.counters7d || {};
    let cyc = null, cycWhy = "sur 7 jours";
    if (c7[ID.starts] && c7[ID.hours] && val(ID.starts) != null) {
      const ds = val(ID.starts) - c7[ID.starts].value, dh = val(ID.hours) - c7[ID.hours].value;
      if (ds > 0) { cyc = (dh * 60) / ds; cycWhy = `${fr(ds, 0)} démarrages, ${fr(dh, 0)} h`; }
    }
    const af = val(ID.addFactor);
    const afOld = c7[ID.addFactor]?.value;
    const afDelta = af != null && afOld != null ? af - afOld : null;
    const live = hz > 0;
    const html = [
      chip("Surchauffe", live ? fr(sh) : null, "K", "aspiration - évaporateur", band(sh, 3, 9, 1.5, 12) === "ok" ? "Saine · 3 à 9 K" : "À surveiller", band(sh, 3, 9, 1.5, 12), live ? null : "Compresseur à l'arrêt"),
      chip("Sous-refroid.", live ? fr(sc) : null, "K", "condensation - liquide", band(sc, 2, 9, 1, 12) === "ok" ? "Correct · 2 à 9 K" : "À surveiller", band(sc, 2, 9, 1, 12), live ? null : "Compresseur à l'arrêt"),
      chip("Écart départ/retour", live ? fr(dt) : null, "K", "débit du circuit", band(dt, 3, 9, 2, 12) === "ok" ? "Normal · 3 à 9 K" : "Débit à vérifier", band(dt, 3, 9, 2, 12), live ? null : "Compresseur à l'arrêt"),
      chip("Refoulement", dis != null ? fr(dis) : null, "°C", "limite vers 110 °C", dis < 100 ? "Marge OK" : dis < 110 ? "Chaud" : "Trop chaud", dis == null ? "mist" : dis < 100 ? "ok" : dis < 110 ? "warn" : "crit"),
      chip("Cycle moyen", cyc != null ? fr(cyc, 0) : null, "min", cycWhy, cyc >= 30 ? "Pas de cycles courts" : "Cycles courts", cyc == null ? "mist" : cyc >= 30 ? "ok" : cyc >= 15 ? "warn" : "crit"),
      chip("Appoint élec.", af != null ? fr(af) : null, "", afDelta == null ? "facteur temps" : afDelta > 0 ? `+${fr(afDelta)} sur 7 j` : "stable sur 7 j", afDelta > 0 ? "A servi cette semaine" : "Pas utilisé", af == null ? "mist" : afDelta > 0 ? "warn" : "ok"),
    ];
    $("diag").innerHTML = html.join("");
  }

  function renderEnergy() {
    // Journal d'énergie NIBE : puissance instantanée réelle ; chaleur et COP sur l'heure passée.
    const pkw = val(ID.pNow);
    const pel = pkw != null ? pkw * 1000 : val(ID.hz) != null ? val(ID.hz) * W_PER_HZ : null;
    const add2 = (a, b) => (val(a) ?? 0) + (val(b) ?? 0);
    const prod = val(ID.prodH) != null ? add2(ID.prodH, ID.prodE) : null;
    const used = val(ID.useH) != null ? add2(ID.useH, ID.useE) + add2(ID.addH, ID.addE) : null;
    $("w-el").textContent = pel != null ? fr(pel, 0) : "-";
    $("w-el").parentElement.nextElementSibling.textContent = pkw != null ? "mesuré par la PAC, maintenant" : "estimé depuis la fréquence du compresseur";
    $("w-heat").textContent = prod != null ? fr(prod * 1000, 0) : "-";
    $("w-heat-why").textContent = prod != null ? `moyenne de l'heure passée · ${fr(prod, 2)} kWh` : "journal d'énergie non remonté";
    $("w-cop").textContent = prod != null && used > 0 ? fr(prod / used, 2) : "-";
    $("w-cop").nextElementSibling.textContent = used > 0 ? `heure passée · ${fr(used, 2)} kWh consommés` : "compresseur à l'arrêt sur l'heure passée";
    const a = [val(ID.be1), val(ID.be2), val(ID.be3)];
    const sum = a.every((x) => x != null) ? a.reduce((s, x) => s + x, 0) : null;
    // Phases maison : non publiées tant que le site est public (révèlent la présence).
    $("house-tile").hidden = !NOW?.house;
    $("w-house").textContent = sum != null ? fr(sum * VOLT, 0) : "-";
    $("phases").innerHTML = a.map((x, i) => `<span>L${i + 1} ${fr(x)} A</span>`).join("");
  }

  // ---------- graphiques ----------
  const fmtX = (t, span) => { const d = new Date(t * 1000); return span <= 86400 ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }); };

  function axes(svg, W, H, pad, t0, t1, ymin, ymax, yt) {
    svg.replaceChildren();
    const x = (t) => pad.l + ((W - pad.l - pad.r) * (t - t0)) / (t1 - t0 || 1);
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - ymin) / (ymax - ymin || 1));
    const g = el("g", { class: "grid" }), ax = el("g", { class: "axis" });
    yt.forEach((t) => { g.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t) })); ax.appendChild(el("text", { x: pad.l - 8, y: y(t) + 3, "text-anchor": "end" }, String(t))); });
    for (let k = 0; k <= 4; k++) { const t = t0 + ((t1 - t0) * k) / 4; ax.appendChild(el("text", { x: x(t), y: H - 4, "text-anchor": k === 0 ? "start" : k === 4 ? "end" : "middle" }, fmtX(t, t1 - t0))); }
    svg.append(g, ax);
    return { x, y };
  }
  const line = (pts, x, y) => pts.map((p, i) => (i ? "L" : "M") + x(p[0]).toFixed(1) + " " + y(p[1]).toFixed(1)).join("");
  const niceTicks = (lo, hi, n = 4) => { const s = Math.pow(10, Math.floor(Math.log10((hi - lo) / n || 1))); const st = [1, 2, 5, 10].map((m) => m * s).find((m) => (hi - lo) / m <= n) || s * 10; const a = Math.floor(lo / st) * st, b = Math.ceil(hi / st) * st; const r = []; for (let v = a; v <= b + 1e-9; v += st) r.push(Math.round(v * 100) / 100); return r; };
  const empty = (svg, W, H) => { svg.replaceChildren(el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", "font-family": "var(--f-data)", "font-size": 12, fill: "var(--mist)" }, "Courbe disponible après quelques collectes")); };

  let seriesSeq = 0;
  async function renderSeries() {
    const pids = [ID.supply, ID.calc, ID.out, ID.hz, ...ID.dm].join(",");
    const [t0, t1] = WIN, seq = ++seriesSeq;
    const s = await getJSON(`/api/series?from=${Math.floor(t0)}&to=${Math.ceil(t1)}&pids=${pids}`).catch(() => ({}));
    if (seq !== seriesSeq) return; // une fenêtre plus récente a été demandée
    const g = (p) => (s[p] || []).map((r) => [r[0] + (s.step || 0) / 2, r[1]]);

    // départ / calculé / extérieur
    {
      const svg = $("c-supply"), W = 1000, H = 260, pad = { l: 38, r: 60, t: 10, b: 22 };
      const sup = g(ID.supply), cal = g(ID.calc), out = g(ID.out);
      if (sup.length < 2) empty(svg, W, H);
      else {
        const all = [...sup, ...cal, ...out].map((p) => p[1]);
        const yt = niceTicks(Math.min(0, ...all), Math.max(...all));
        const { x, y } = axes(svg, W, H, pad, t0, t1, yt[0], yt[yt.length - 1], yt);
        const defs = el("defs"); defs.innerHTML = '<linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--t-warm)" stop-opacity=".35"/><stop offset="1" stop-color="var(--t-warm)" stop-opacity="0"/></linearGradient>'; svg.appendChild(defs);
        svg.appendChild(el("path", { d: line(sup, x, y) + `L${x(sup[sup.length - 1][0])} ${y(yt[0])} L${x(sup[0][0])} ${y(yt[0])} Z`, fill: "url(#ga)" }));
        if (cal.length) svg.appendChild(el("path", { d: line(cal, x, y), fill: "none", stroke: "var(--mist)", "stroke-width": 1.5, "stroke-dasharray": "5 5" }));
        if (out.length) svg.appendChild(el("path", { d: line(out, x, y), fill: "none", stroke: "var(--t-cold)", "stroke-width": 1.5 }));
        svg.appendChild(el("path", { d: line(sup, x, y), fill: "none", stroke: "var(--t-warm)", "stroke-width": 2.2 }));
        [[sup, "var(--t-warm)"], [cal, "var(--mist)"], [out, "var(--t-cold)"]].forEach(([ser, c]) => { if (!ser.length) return; const p = ser[ser.length - 1]; svg.appendChild(el("circle", { cx: x(p[0]), cy: y(p[1]), r: 4, fill: c })); svg.appendChild(el("text", { x: x(p[0]) + 10, y: y(p[1]) + 4, fill: c, "font-family": "var(--f-data)", "font-size": 12 }, fr(p[1]) + "°")); });
      }
    }
    // degrés-minutes
    {
      const svg = $("c-dm"), W = 480, H = 200, pad = { l: 42, r: 8, t: 10, b: 22 };
      const dm = g(ID.dm.find((p) => (s[p] || []).length) || ID.dm[0]);
      if (dm.length < 2) empty(svg, W, H);
      else {
        const v = dm.map((p) => p[1]); const yt = niceTicks(Math.min(-100, ...v), Math.max(20, ...v));
        const { x, y } = axes(svg, W, H, pad, t0, t1, yt[0], yt[yt.length - 1], yt);
        const bw = Math.max(1, ((W - pad.l - pad.r) / ((t1 - t0) / (s.step || 600))) * 0.8);
        dm.forEach((p, i) => { const y0 = y(0), y1 = y(p[1]); svg.appendChild(el("rect", { x: x(p[0]) - bw / 2, y: Math.min(y0, y1), width: bw, height: Math.max(1, Math.abs(y1 - y0)), fill: p[1] < 0 ? "var(--t-cold)" : "var(--t-warm)", opacity: i === dm.length - 1 ? 1 : 0.75 })); });
        svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: y(-60), y2: y(-60), stroke: "var(--frost)", "stroke-dasharray": "2 4" }));
      }
    }
    // compresseur
    {
      const svg = $("c-hz"), W = 480, H = 200, pad = { l: 38, r: 8, t: 10, b: 22 };
      const hz = g(ID.hz);
      if (hz.length < 2) empty(svg, W, H);
      else {
        const yt = niceTicks(0, Math.max(90, ...hz.map((p) => p[1])));
        const { x, y } = axes(svg, W, H, pad, t0, t1, 0, yt[yt.length - 1], yt);
        let d = ""; hz.forEach((p, i) => { d += (i ? "L" : "M") + x(p[0]).toFixed(1) + " " + y(p[1]).toFixed(1); if (i < hz.length - 1) d += "L" + x(hz[i + 1][0]).toFixed(1) + " " + y(p[1]).toFixed(1); });
        svg.appendChild(el("path", { d: d + `L${x(hz[hz.length - 1][0])} ${y(0)} L${x(hz[0][0])} ${y(0)} Z`, fill: "var(--t-hot)", opacity: 0.18 }));
        svg.appendChild(el("path", { d, fill: "none", stroke: "var(--t-hot)", "stroke-width": 1.6 }));
        const p = hz[hz.length - 1]; svg.appendChild(el("circle", { cx: x(p[0]), cy: y(p[1]), r: 4, fill: "var(--t-hot)" }));
      }
    }
  }

  const tcol = (t) => { const s = [[-5, [79, 195, 255]], [5, [123, 224, 200]], [12, [255, 181, 71]], [20, [255, 90, 78]]]; if (t <= s[0][0]) return "rgb(79,195,255)"; for (let k = 0; k < s.length - 1; k++) if (t <= s[k + 1][0]) { const f = (t - s[k][0]) / (s[k + 1][0] - s[k][0]); return "rgb(" + s[k][1].map((v, j) => Math.round(v + (s[k + 1][1][j] - v) * f)).join(",") + ")"; } return "rgb(255,90,78)"; };

  async function renderDaily() {
    const s = await getJSON(`/api/series?range=30dd&pids=${ID.out},${ID.prodH},${ID.prodE},${ID.useH},${ID.useE},${ID.addH},${ID.addE}`).catch(() => ({}));
    // bande 30 j
    {
      const svg = $("c-stripe"), W = 1000, n = 30, gap = 4, bw = (W - gap * (n - 1)) / n, top = 16, hh = 80;
      const days = s[ID.out] || [];
      svg.replaceChildren();
      if (!days.length) empty(svg, W, 132);
      const start = Math.floor((NOW?.server || Date.now() / 1000) / 86400) * 86400 - (n - 1) * 86400;
      const byDay = new Map(days.map((r) => [r[0], r]));
      const fi = (v) => String(Math.round(v)).replace("-", "−");
      for (let i = 0; i < n && days.length; i++) {
        const r = byDay.get(start + i * 86400); const x0 = i * (bw + gap), cx = x0 + bw / 2;
        if (!r) { svg.appendChild(el("rect", { x: x0, y: top, width: bw, height: hh, fill: "var(--rule)", opacity: 0.4 })); continue; }
        const gid = "st" + i, lg = el("linearGradient", { id: gid, x1: 0, y1: 1, x2: 0, y2: 0 }); lg.innerHTML = `<stop offset="0" stop-color="${tcol(r[2])}"/><stop offset="1" stop-color="${tcol(r[3])}"/>`; svg.appendChild(lg);
        svg.appendChild(el("rect", { x: x0, y: top, width: bw, height: hh, fill: `url(#${gid})` }));
        svg.appendChild(el("text", { x: cx, y: top - 4, "text-anchor": "middle", "font-family": "var(--f-data)", "font-size": 9, fill: "var(--mist)" }, fi(r[3])));
        svg.appendChild(el("text", { x: cx, y: top + hh / 2 + 5, "text-anchor": "middle", "font-family": "var(--f-display)", "font-weight": 700, "font-size": 15, fill: "var(--ink)" }, fi(r[1]) + "°"));
        svg.appendChild(el("text", { x: cx, y: top + hh + 11, "text-anchor": "middle", "font-family": "var(--f-data)", "font-size": 9, fill: "var(--mist)" }, fi(r[2])));
      }
      if (days.length) [[0, "start"], [15, "middle"], [29, "end"]].forEach(([i, a]) => svg.appendChild(el("text", { x: i === 29 ? W : i * (bw + gap) + (i ? bw / 2 : 0), y: 128, "text-anchor": a, "font-family": "var(--f-data)", "font-size": 10, fill: "var(--mist)" }, fmtX(start + i * 86400, 1e9))));
    }
    // bilan 14 j (estimations : électricité = Hz moyen × 40 W × 24 h ; chaleur = débit moyen × ΔT moyen)
    {
      const svg = $("c-energy"), W = 1000, H = 240, pad = { l: 40, r: 44, t: 14, b: 24 }, n = 14;
      svg.replaceChildren();
      // Moyenne du jour des valeurs « heure passée » (kWh) × 24 = énergie du jour.
      const m = (p) => new Map((s[p] || []).map((r) => [r[0], r[1]]));
      const P = [m(ID.prodH), m(ID.prodE)], U = [m(ID.useH), m(ID.useE), m(ID.addH), m(ID.addE)];
      const daySum = (maps, d) => { let t = 0, any = false; for (const mp of maps) { const v = mp.get(d); if (v != null) { t += v; any = true; } } return any ? t * 24 : null; };
      const end = Math.floor((NOW?.server || Date.now() / 1000) / 86400) * 86400;
      const days = [...Array(n)].map((_, i) => { const d = end - (n - 1 - i) * 86400; const elk = daySum(U, d), heat = daySum(P, d); return { d, el: elk, heat, cop: elk && heat ? heat / elk : null }; });
      if (!days.some((d) => d.el != null)) { empty(svg, W, H); return; }
      const ymax = niceTicks(0, Math.max(30, ...days.map((d) => Math.max(d.el || 0, d.heat || 0))));
      const top = ymax[ymax.length - 1];
      const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top), yc = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / 6);
      const g = el("g", { class: "grid" }), ax = el("g", { class: "axis" });
      ymax.forEach((t) => { g.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t) })); ax.appendChild(el("text", { x: pad.l - 8, y: y(t) + 3, "text-anchor": "end" }, String(t))); });
      [0, 2, 4, 6].forEach((t) => ax.appendChild(el("text", { x: W - pad.r + 8, y: yc(t) + 3 }, String(t))));
      ax.appendChild(el("text", { x: W - pad.r + 8, y: pad.t - 2 }, "COP"));
      svg.append(g, ax);
      const slot = (W - pad.l - pad.r) / n, bw = slot * 0.62, cp = [];
      days.forEach((d, i) => {
        const x = pad.l + slot * i + (slot - bw) / 2;
        if (d.heat != null) svg.appendChild(el("rect", { x, y: y(d.heat), width: bw, height: y(0) - y(d.heat), fill: "var(--t-warm)", opacity: 0.28 }));
        if (d.el != null) { svg.appendChild(el("rect", { x: x + bw * 0.22, y: y(d.el), width: bw * 0.56, height: y(0) - y(d.el), fill: "var(--t-hot)" })); svg.appendChild(el("text", { x: x + bw / 2, y: y(d.el) - 4, "text-anchor": "middle", "font-family": "var(--f-data)", "font-size": 10, fill: "var(--frost)" }, fr(d.el, 0))); }
        svg.appendChild(el("text", { x: x + bw / 2, y: H - 6, "text-anchor": "middle", "font-family": "var(--f-data)", "font-size": 10, fill: "var(--mist)" }, fmtX(d.d, 1e9)));
        if (d.cop != null) cp.push([x + bw / 2, yc(Math.min(6, d.cop))]);
      });
      if (cp.length > 1) svg.appendChild(el("path", { d: cp.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(""), fill: "none", stroke: "var(--frost)", "stroke-width": 1.4, "stroke-dasharray": "3 4" }));
      cp.forEach((p) => svg.appendChild(el("circle", { cx: p[0], cy: p[1], r: 3.5, fill: "var(--frost)" })));
    }
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

  // ---------- frise temporelle ----------
  const BW = 1000, BH = 74, BP = { l: 8, r: 8, t: 6, b: 18 };
  const bx = (t) => BP.l + ((BW - BP.l - BP.r) * (t - DOM[0])) / (DOM[1] - DOM[0]);
  const bt = (x) => DOM[0] + ((x - BP.l) / (BW - BP.l - BP.r)) * (DOM[1] - DOM[0]);
  const fmtSpan = (s) => s <= 86400 + 60 ? `${fr(s / 3600, 0)} h` : `${fr(s / 86400, s < 7 * 86400 && s % 86400 > 600 ? 1 : 0)} j`;
  const fmtWhen = (t) => new Date(t * 1000).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  async function loadOverview() {
    OVER = await getJSON(`/api/series?range=all&pids=${ID.supply},${ID.out}`).catch(() => ({}));
    const end = nowS();
    DOM = [Math.min(OVER.since || end, end - 30 * 86400), end];
    if (!WIN) WIN = [end - 86400, end];
    if (FOLLOW) { const span = WIN[1] - WIN[0]; WIN = [end - span, end]; }
  }

  function drawBrush() {
    const svg = $("c-brush"); svg.replaceChildren();
    const g = el("g", { class: "axis" });
    const span = DOM[1] - DOM[0], ticks = 6;
    for (let k = 0; k <= ticks; k++) { const t = DOM[0] + (span * k) / ticks; g.appendChild(el("text", { x: bx(t), y: BH - 4, "text-anchor": k === 0 ? "start" : k === ticks ? "end" : "middle" }, fmtX(t, span))); }
    svg.appendChild(g);
    const y = (v, lo, hi) => BP.t + (BH - BP.t - BP.b) * (1 - (v - lo) / (hi - lo || 1));
    const sup = (OVER?.[ID.supply] || []).map((r) => [r[0], r[1]]), out = (OVER?.[ID.out] || []).map((r) => [r[0], r[1]]);
    const vals = [...sup, ...out].map((p) => p[1]);
    if (vals.length > 1) {
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const path = (ser) => ser.map((p, i) => (i ? "L" : "M") + bx(p[0]).toFixed(1) + " " + y(p[1], lo, hi).toFixed(1)).join("");
      if (sup.length > 1) svg.appendChild(el("path", { d: path(sup) + `L${bx(sup[sup.length - 1][0])} ${BH - BP.b} L${bx(sup[0][0])} ${BH - BP.b} Z`, fill: "var(--t-warm)", opacity: 0.22 }));
      if (sup.length > 1) svg.appendChild(el("path", { d: path(sup), fill: "none", stroke: "var(--t-warm)", "stroke-width": 1.2 }));
      if (out.length > 1) svg.appendChild(el("path", { d: path(out), fill: "none", stroke: "var(--t-cold)", "stroke-width": 1 }));
    } else svg.appendChild(el("text", { x: BW / 2, y: BH / 2, "text-anchor": "middle", "font-family": "var(--f-data)", "font-size": 11, fill: "var(--mist)" }, "L'historique se remplit au fil des collectes"));
    const x0 = bx(WIN[0]), x1 = bx(WIN[1]), yT = BP.t, yH = BH - BP.t - BP.b;
    svg.appendChild(el("rect", { class: "shade", x: BP.l, y: yT, width: Math.max(0, x0 - BP.l), height: yH }));
    svg.appendChild(el("rect", { class: "shade", x: x1, y: yT, width: Math.max(0, BW - BP.r - x1), height: yH }));
    svg.appendChild(el("rect", { class: "win", id: "b-win", x: x0, y: yT, width: Math.max(2, x1 - x0), height: yH }));
    [[x0, "l"], [x1, "r"]].forEach(([x, side]) => {
      svg.appendChild(el("rect", { class: "grip-hit", "data-g": side, x: x - 9, y: yT, width: 18, height: yH }));
      svg.appendChild(el("rect", { class: "grip", "data-g": side, x: x - 2, y: yT + yH / 2 - 11, width: 4, height: 22, rx: 2 }));
    });
    const lbl = `${fmtWhen(WIN[0])} → ${fmtWhen(WIN[1])} · ${fmtSpan(WIN[1] - WIN[0])}${FOLLOW ? " · en direct" : ""}`;
    $("brush-label").textContent = lbl; svg.setAttribute("aria-valuetext", lbl);
    $("range-h").textContent = fmtSpan(WIN[1] - WIN[0]).replace(" h", " heures").replace(" j", " jours");
  }

  function setWin(a, b, commit) {
    const span = Math.max(MIN_WIN, Math.min(b - a, DOM[1] - DOM[0]));
    if (a < DOM[0]) { a = DOM[0]; b = a + span; } else if (b > DOM[1]) { b = DOM[1]; a = b - span; }
    WIN = [a, b]; FOLLOW = DOM[1] - b < 600;
    document.querySelectorAll(".tabs button").forEach((o) => o.setAttribute("aria-pressed", String(FOLLOW && Number(o.dataset.s) === Math.round(b - a))));
    drawBrush();
    if (commit) renderSeries();
  }

  (function brushEvents() {
    const svg = $("c-brush"); let drag = null;
    const toX = (e) => { const r = svg.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * BW; };
    svg.addEventListener("pointerdown", (e) => {
      if (!DOM) return;
      const x = toX(e), g = e.target.dataset?.g;
      const x0 = bx(WIN[0]), x1 = bx(WIN[1]);
      if (g) drag = { mode: g };
      else if (x > x0 && x < x1) drag = { mode: "move", off: bt(x) - WIN[0] };
      else { const span = WIN[1] - WIN[0], c = bt(x); setWin(c - span / 2, c + span / 2, false); drag = { mode: "move", off: span / 2 }; }
      svg.setPointerCapture(e.pointerId); $("b-win")?.classList.add("drag"); e.preventDefault();
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return; const t = bt(toX(e)), span = WIN[1] - WIN[0];
      if (drag.mode === "l") setWin(Math.min(t, WIN[1] - MIN_WIN), WIN[1], false);
      else if (drag.mode === "r") setWin(WIN[0], Math.max(t, WIN[0] + MIN_WIN), false);
      else setWin(t - drag.off, t - drag.off + span, false);
    });
    const end = () => { if (!drag) return; drag = null; renderSeries(); };
    svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end);
    svg.addEventListener("keydown", (e) => {
      if (!DOM) return; const span = WIN[1] - WIN[0], st = span * 0.1;
      const k = { ArrowLeft: [-st, -st], ArrowRight: [st, st], ArrowUp: [st / 2, -st / 2], ArrowDown: [-st / 2, st / 2] }[e.key];
      if (!k) return; e.preventDefault(); setWin(WIN[0] + k[0], WIN[1] + k[1], true);
    });
  })();

  async function refresh() {
    try { NOW = await getJSON("/api/now"); } catch (e) { NOW = { points: {}, poll: { last: { ok: 0, detail: String(e.message) } } }; }
    // Aperçu : ?demo=30|64|110 (Hz) ou ?demo=defrost, pour voir le schéma en marche. Ne touche pas aux données.
    const demo = new URLSearchParams(location.search).get("demo");
    if (demo && NOW.points) {
      const put = (pid, v) => { NOW.points[pid] = { ...(NOW.points[pid] || { pid }), last_val: v }; };
      if (demo === "defrost") { put(ID.hz, 50); put(ID.defrost, 1); put(ID.gp12, 60); }
      else { put(ID.hz, Number(demo) || 64); put(ID.defrost, 0); put(ID.gp12, 75); put(ID.gp1, 90); }
    }
    renderNow();
    await loadOverview();
    drawBrush();
    renderSeries();
    renderDaily();
  }

  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    if (!DOM) return;
    const end = DOM[1];
    if (b.dataset.s === "all") setWin(DOM[0], end, true);
    else setWin(end - Number(b.dataset.s), end, true);
    document.querySelectorAll(".tabs button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
  }));

  refresh();
  setInterval(refresh, 120000);
})();
