'use strict';

/* ══════════════════════════════════════════════════════════════
   ONPE 2026 · Análisis Electoral bottom-up
   ══════════════════════════════════════════════════════════════

   MoE approach (crítica y elección):
   ─────────────────────────────────
   Unidad de muestreo natural = acta (ballot box). Con n_actas
   contadas de N_actas totales, la proporción observada p̂ tiene:

     SE_binomial = √(p̂(1−p̂) / n_actas)           [SIN FPC]

   Elegimos NO aplicar FPC (finite-population correction) porque
   las actas aún no contadas pueden ser sistemáticamente distintas
   (zonas rurales, extranjero, etc.), lo que viola el supuesto de
   muestreo aleatorio simple que justifica FPC. Esta elección es
   conservadora: sobreestima la incertidumbre.

   SUMPRODUCTO compuesto (fórmula bottom-up):
     Total_A  = Σ p̂ᵢ × N̂ᵢ         N̂ᵢ = valid_i×(N_i/n_i)
     Total_V  = Σ N̂ᵢ
     P_final  = Total_A / Total_V
     Var_btup = Σ (SEᵢ × N̂ᵢ)²      independencia entre distritos
     MoE_btup = 1.96 × √Var_btup / Total_V

   MoE cluster-across-districts (alternativo):
     s²_w = Σ N̂ᵢ(p̂ᵢ − P_final)² / Total_V    varianza inter-distrito
     SE_cl = √(s²_w / n_districts)             SE del promedio ponderado
     MoE_cl = 1.96 × SE_cl

   Mostramos max(MoE_btup, MoE_cl) — la estimación más conservadora.

   Prueba de significancia: z = (p̂A − 0.5) / SE_final, p-value a 2 colas.
   ══════════════════════════════════════════════════════════════ */

const Z   = 1.96;
const CSV = '/resultados_onpe_progresivo.csv';

const fmt    = n => n == null ? '–' : Number(n).toLocaleString('es-PE');
const fmtPct = p => p == null ? '–' : (+p).toFixed(3) + '%';
const fmtPp  = p => (p >= 0 ? '+' : '') + (+p).toFixed(3) + ' pp';
const qs     = s => document.querySelector(s);

let DISTRICTS = [];
let candA = null, candB = null;
let ciChartInst = null, distChartInst = null;

// ── CSV parser ────────────────────────────────────────────────
function splitLine(line) {
  const out = []; let cur = '', q = false;
  for (const c of line) {
    if (c === '"')         { q = !q; continue; }
    if (c === ',' && !q)   { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  return [...out, cur];
}

// ── Build district data ───────────────────────────────────────
function build(raw) {
  const lines   = raw.split('\n').filter(l => l.trim());
  const headers = splitLine(lines[0]).map(h => h.trim());

  // 1a. Most recent row per (depth-4 geo-key, candidato)
  const latest = new Map();
  // 1b. Most recent row per (depth-1/2/3 geo-key, candidato) for imputation
  const latestParent = new Map();

  for (let i = 1; i < lines.length; i++) {
    const vals = splitLine(lines[i]);
    if (vals.length < headers.length) continue;
    const row  = {};
    headers.forEach((h, j) => row[h] = (vals[j] ?? '').trim());

    if (row.PROFUNDIDAD_4) {
      // depth-4
      const key = `${row.PROFUNDIDAD_1}|${row.PROFUNDIDAD_2}|${row.PROFUNDIDAD_3}|${row.PROFUNDIDAD_4}|${row.nombreCandidato}`;
      const prev = latest.get(key);
      if (!prev || row.executionTs > prev.executionTs) latest.set(key, row);
    } else {
      // depth-1 / 2 / 3  (used as fallback for imputation)
      const pKey = [row.PROFUNDIDAD_1, row.PROFUNDIDAD_2, row.PROFUNDIDAD_3]
        .filter(Boolean).join('|');
      const key = pKey + '|' + row.nombreCandidato;
      const prev = latestParent.get(key);
      if (!prev || row.executionTs > prev.executionTs) latestParent.set(key, row);
    }
  }

  // 2. Group depth-4 by geographic node
  const nodes = new Map();
  for (const row of latest.values()) {
    const gk = `${row.PROFUNDIDAD_1}|${row.PROFUNDIDAD_2}|${row.PROFUNDIDAD_3}|${row.PROFUNDIDAD_4}`;
    if (!nodes.has(gk)) {
      nodes.set(gk, {
        p1: row.PROFUNDIDAD_1, p2: row.PROFUNDIDAD_2,
        p3: row.PROFUNDIDAD_3, p4: row.PROFUNDIDAD_4,
        n: +row.contabilizadas, N: +row.totalActas,
        ts: row.executionTs, cands: {},
      });
    }
    const nd = nodes.get(gk);
    nd.cands[row.nombreCandidato] = +row.totalVotosValidos;
    if (row.executionTs > nd.ts) {
      nd.ts = row.executionTs;
      nd.n  = +row.contabilizadas;
      nd.N  = +row.totalActas;
    }
  }

  // 2b. Build parent nodes map: pKey → {n, N, cands{}}
  const parentNodes = new Map();
  for (const row of latestParent.values()) {
    const pKey = [row.PROFUNDIDAD_1, row.PROFUNDIDAD_2, row.PROFUNDIDAD_3]
      .filter(Boolean).join('|');
    if (!parentNodes.has(pKey)) {
      parentNodes.set(pKey, {
        n: +row.contabilizadas, N: +row.totalActas,
        ts: row.executionTs, cands: {},
      });
    }
    const pnd = parentNodes.get(pKey);
    pnd.cands[row.nombreCandidato] = +row.totalVotosValidos;
    if (row.executionTs > pnd.ts) {
      pnd.ts = row.executionTs;
      pnd.n  = +row.contabilizadas;
      pnd.N  = +row.totalActas;
    }
  }

  // 3. Detect candidates (Sánchez = A red, Fujimori = B orange)
  const totals = {};
  for (const nd of nodes.values())
    for (const [name, v] of Object.entries(nd.cands))
      totals[name] = (totals[name] || 0) + v;

  const sorted   = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const fujimori = sorted.find(([n]) => n.includes('FUJIMORI'));
  const sanchez  = sorted.find(([n]) => n.includes('SANCHEZ'));
  candA = (sanchez  || sorted[0])?.[0];
  candB = (fujimori || sorted[1])?.[0];

  // Helper: walk up hierarchy (depth-3 → depth-2 → depth-1) to find parent proportion
  // Returns { pA, votesPerActa, n } or null
  function getParentProp(p1, p2, p3) {
    const keys = [
      [p1, p2, p3].filter(Boolean).join('|'),  // depth-3 parent
      [p1, p2].filter(Boolean).join('|'),       // depth-2 parent
      p1,                                        // depth-1 parent
    ];
    for (const pKey of keys) {
      const pnd = parentNodes.get(pKey);
      if (!pnd) continue;
      const totalV = Object.values(pnd.cands).reduce((s, v) => s + v, 0);
      if (totalV === 0 || pnd.n === 0) continue;
      const pA = (pnd.cands[candA] ?? 0) / totalV;
      return {
        pA,
        votesPerActa: totalV / pnd.n,
        n: pnd.n,
        level: pKey.split('|').length,  // 1, 2, or 3
      };
    }
    return null;
  }

  // 4. Compute per-district statistics (with imputation for missing districts)
  DISTRICTS = [];
  for (const nd of nodes.values()) {
    const totalValid = Object.values(nd.cands).reduce((s, v) => s + v, 0);

    if (totalValid === 0 || nd.n === 0) {
      // ── Imputation: use parent-level proportion ──────────────
      if (nd.N === 0) continue;  // nothing we can do
      const parent = getParentProp(nd.p1, nd.p2, nd.p3);
      if (!parent) continue;

      const pA   = parent.pA;
      const pB   = 1 - pA;
      // Estimate projected vote count using parent's votes-per-acta ratio
      const Nhat = nd.N * parent.votesPerActa;
      // SE uses parent's n — same uncertainty as parent estimate (we have no local data)
      const SE   = parent.n > 1 ? Math.sqrt(pA * (1 - pA) / parent.n) : 0;
      const MoE  = Z * SE;

      DISTRICTS.push({
        p1: nd.p1, p2: nd.p2, p3: nd.p3, p4: nd.p4,
        ts: nd.ts, n: 0, N: nd.N,
        cov: 0,
        totalValid: 0, vA: 0, vB: 0, pA, pB,
        Nhat, SE, MoE,
        SE_votes: SE * Nhat,
        ciLo: Math.max(0, pA - MoE),
        ciHi: Math.min(1, pA + MoE),
        imputed: true,
        imputedLevel: parent.level,  // which depth the fallback came from
      });
      continue;
    }

    // ── Normal district with real data ───────────────────────
    const vA = nd.cands[candA] ?? 0;
    const vB = nd.cands[candB] ?? 0;
    const pA = vA / totalValid;
    const pB = vB / totalValid;

    const factor = nd.N > 0 ? nd.N / nd.n : 1;
    const Nhat   = totalValid * factor;

    const SE  = nd.n > 1 ? Math.sqrt(pA * (1 - pA) / nd.n) : 0;
    const MoE = Z * SE;

    DISTRICTS.push({
      p1: nd.p1, p2: nd.p2, p3: nd.p3, p4: nd.p4,
      ts: nd.ts, n: nd.n, N: nd.N,
      cov: nd.N > 0 ? nd.n / nd.N : 0,
      totalValid, vA, vB, pA, pB,
      Nhat, SE, MoE,
      SE_votes: SE * Nhat,
      ciLo: Math.max(0, pA - MoE),
      ciHi: Math.min(1, pA + MoE),
      imputed: false,
    });
  }
}

// ── Normal PDF ────────────────────────────────────────────────
function normalPdf(x, mu, sigma) {
  if (sigma === 0) return 0;
  return Math.exp(-0.5 * ((x - mu) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));
}

// ── Render ────────────────────────────────────────────────────
function render() {
  if (!DISTRICTS.length) {
    qs('#status').textContent = '⚠ No se encontraron filas depth-4.';
    return;
  }

  // ── SUMPRODUCTO ──────────────────────────────────────────
  const totalA = DISTRICTS.reduce((s, d) => s + d.pA * d.Nhat, 0);
  const totalB = DISTRICTS.reduce((s, d) => s + d.pB * d.Nhat, 0);
  const totalV = DISTRICTS.reduce((s, d) => s + d.Nhat, 0);
  const totalN = DISTRICTS.reduce((s, d) => s + d.N, 0);
  const totaln = DISTRICTS.reduce((s, d) => s + d.n, 0);

  const pFinalA = totalA / totalV;
  const pFinalB = totalB / totalV;

  // MoE bottom-up compound
  const varBtup  = DISTRICTS.reduce((s, d) => s + d.SE_votes ** 2, 0);
  const SE_btup  = Math.sqrt(varBtup) / totalV;
  const MoE_btup = Z * SE_btup;

  // MoE cluster across districts (weighted variance of p̂ᵢ)
  const s2w      = DISTRICTS.reduce((s, d) => s + d.Nhat * (d.pA - pFinalA) ** 2, 0) / totalV;
  const SE_cl    = Math.sqrt(s2w / DISTRICTS.length);
  const MoE_cl   = Z * SE_cl;

  // Use the more conservative of the two
  const MoE_final = Math.max(MoE_btup, MoE_cl);
  const SE_final  = MoE_final / Z;

  const ciLoA = Math.max(0,   pFinalA - MoE_final);
  const ciHiA = Math.min(1,   pFinalA + MoE_final);
  const ciLoB = Math.max(0,   pFinalB - MoE_final);
  const ciHiB = Math.min(1,   pFinalB + MoE_final);

  // Margin & significance
  const margin    = pFinalA - pFinalB;           // can be negative
  const SE_diff   = 2 * SE_final;                // SE of difference (2-candidate race)
  const MoE_diff  = Z * SE_diff;
  const ciLoMargin = margin - MoE_diff;
  const ciHiMargin = margin + MoE_diff;

  // z-test H₀: pA = 0.5  (one-sided: is A winning?)
  const z_stat   = (pFinalA - 0.5) / SE_final;
  const p_value  = 2 * (1 - normCdf(Math.abs(z_stat)));
  const sig      = p_value < 0.05;

  const covPct = totalN > 0 ? totaln / totalN * 100 : 0;
  const ts     = DISTRICTS.reduce((a, d) => d.ts > a ? d.ts : a, '');

  // ── Status ────────────────────────────────────────────
  qs('#status').innerHTML =
    `<b>${fmt(DISTRICTS.length)}</b> distritos · ${covPct.toFixed(1)}% cobertura · ` +
    `${new Date(ts).toLocaleString('es-PE')}`;
  qs('#footer-ts').textContent = new Date().toLocaleString('es-PE');

  // ── KPI cards ─────────────────────────────────────────
  const winner = pFinalA > pFinalB ? 'a' : pFinalB > pFinalA ? 'b' : null;

  qs('#card-a').classList.toggle('winner', winner === 'a');
  qs('#card-b').classList.toggle('winner', winner === 'b');

  const setBadge = (el, w) => {
    el.className = 'kpi-badge ' + (w ? 'badge-win' : 'badge-lose');
    el.textContent = w ? '▲ Líder' : '▼ Atrás';
  };
  setBadge(qs('#badge-a'), winner === 'a');
  setBadge(qs('#badge-b'), winner === 'b');

  qs('#name-a').textContent   = candA;
  qs('#name-b').textContent   = candB;
  qs('#pct-a').textContent    = fmtPct(pFinalA * 100);
  qs('#pct-b').textContent    = fmtPct(pFinalB * 100);
  qs('#extrap-a').textContent = fmt(Math.round(totalA));
  qs('#extrap-b').textContent = fmt(Math.round(totalB));
  qs('#ic-a').textContent     = `IC 95%: [${fmtPct(ciLoA*100)} – ${fmtPct(ciHiA*100)}]`;
  qs('#ic-b').textContent     = `IC 95%: [${fmtPct(ciLoB*100)} – ${fmtPct(ciHiB*100)}]`;

  // Margin
  const winnerName = winner === 'a' ? candA.split(' ')[0] : winner === 'b' ? candB.split(' ')[0] : '–';
  qs('#margin-val').textContent = fmtPp(Math.abs(margin) * 100);
  qs('#margin-val').style.color = winner === 'a' ? 'var(--a)' : winner === 'b' ? 'var(--b)' : 'var(--muted)';
  qs('#margin-ic').textContent  = `[${fmtPp(ciLoMargin*100)} – ${fmtPp(ciHiMargin*100)}]`;

  const sigEl = qs('#sig-badge');
  sigEl.textContent = sig
    ? `Sig. estadística (p=${p_value < 0.001 ? '<0.001' : p_value.toFixed(3)})`
    : `No significativo (p=${p_value.toFixed(3)})`;
  sigEl.className = 'kpi-sig ' + (sig ? 'sig-yes' : 'sig-no');

  // Coverage
  qs('#cov-districts').textContent = fmt(DISTRICTS.length);
  qs('#cov-acts').textContent      = `${fmt(totaln)} / ${fmt(totalN)}`;
  qs('#cov-pct').textContent       = covPct.toFixed(1) + '%';
  qs('#cov-ts').textContent        = new Date(ts).toLocaleString('es-PE', {hour:'2-digit', minute:'2-digit'});

  qs('#kpi-section').classList.remove('hidden');

  // ── Charts ────────────────────────────────────────────
  buildCiChart(pFinalA, pFinalB, ciLoA, ciHiA, ciLoB, ciHiB);
  buildDistChart(pFinalA, pFinalB, SE_final);

  qs('#charts-section').classList.remove('hidden');

  // Overlap note
  const overlap = ciHiA > ciLoB && ciHiB > ciLoA;
  qs('#overlap-note').textContent = overlap
    ? '⚠ Los IC se solapan → resultado dentro del margen de error estadístico.'
    : '✓ Los IC no se solapan → diferencia estadísticamente distinguible.';

  // ── Table ─────────────────────────────────────────────
  const short = n => n.split(' ').slice(0, 2).join(' ');
  qs('#th-pa').textContent = 'p̂ ' + short(candA);
  qs('#th-pb').textContent = 'p̂ ' + short(candB);

  qs('#table-section').classList.remove('hidden');
  renderTable();

  qs('#search').addEventListener('input',  renderTable);
  qs('#sort').addEventListener('change',   renderTable);
}

// ── CI overlap chart ──────────────────────────────────────────
function buildCiChart(pA, pB, loA, hiA, loB, hiB) {
  if (ciChartInst) ciChartInst.destroy();

  const colorA = 'rgba(231,76,60,0.55)';
  const colorB = 'rgba(243,156,18,0.55)';
  const lo = Math.min(loA, loB) * 100;
  const hi = Math.max(hiA, hiB) * 100;
  const pad = Math.max((hi - lo) * 0.25, 0.5);

  ciChartInst = new Chart(qs('#ci-chart'), {
    type: 'bar',
    data: {
      labels: [candA.split(' ')[0], candB.split(' ')[0]],
      datasets: [
        // floating bar: CI range
        {
          label: 'IC 95%',
          data: [[loA * 100, hiA * 100], [loB * 100, hiB * 100]],
          backgroundColor: [colorA, colorB],
          borderColor: ['#e74c3c', '#f39c12'],
          borderWidth: 2,
          borderSkipped: false,
          borderRadius: 4,
        },
        // point estimate marker (height=0 bar at point)
        {
          label: 'Estimación',
          data: [[pA * 100 - 0.005, pA * 100 + 0.005], [pB * 100 - 0.005, pB * 100 + 0.005]],
          backgroundColor: ['#e74c3c', '#f39c12'],
          borderColor:     ['#fff', '#fff'],
          borderWidth: 1,
          borderSkipped: false,
          borderRadius: 2,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.raw;
              if (Array.isArray(v)) return ` [${v[0].toFixed(3)}% – ${v[1].toFixed(3)}%]`;
              return '';
            },
          },
        },
      },
      scales: {
        x: {
          min: lo - pad,
          max: hi + pad,
          grid:  { color: '#2a334760' },
          ticks: { color: '#7b8aab', callback: v => v.toFixed(1) + '%' },
        },
        y: {
          grid:  { display: false },
          ticks: { color: '#e8eaf0', font: { weight: '600' } },
        },
      },
    },
  });
}

// ── Distribution chart ────────────────────────────────────────
function buildDistChart(pA, pB, SE) {
  if (distChartInst) distChartInst.destroy();
  if (SE === 0) return;

  const nPts   = 300;
  const range  = Math.max(SE * 7, Math.abs(pA - pB) + SE * 5);
  const center = (pA + pB) / 2;
  const xMin   = Math.max(0,   center - range / 2);
  const xMax   = Math.min(1,   center + range / 2);

  const xs = Array.from({ length: nPts }, (_, i) => xMin + i * (xMax - xMin) / (nPts - 1));

  // Use {x, y} objects so Chart.js uses a linear x-axis (values in %, not indices)
  const mkPt  = (x, y) => ({ x: +(x * 100).toFixed(4), y });
  const dataA = xs.map(x => mkPt(x, normalPdf(x, pA, SE)));
  const dataB = xs.map(x => mkPt(x, normalPdf(x, pB, SE)));
  const dataOv = xs.map((x, i) => mkPt(x, Math.min(dataA[i].y, dataB[i].y)));

  distChartInst = new Chart(qs('#dist-chart'), {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: candA.split(' ')[0],
          data: dataA,
          borderColor: '#e74c3c',
          backgroundColor: 'rgba(231,76,60,0.15)',
          fill: true,
          showLine: true,
          tension: 0.4,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: candB.split(' ')[0],
          data: dataB,
          borderColor: '#f39c12',
          backgroundColor: 'rgba(243,156,18,0.15)',
          fill: true,
          showLine: true,
          tension: 0.4,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: 'Solapamiento',
          data: dataOv,
          borderColor: 'transparent',
          backgroundColor: 'rgba(255,255,255,0.12)',
          fill: true,
          showLine: true,
          pointRadius: 0,
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          labels: { color: '#7b8aab', font: { size: 11 }, boxWidth: 12 },
          filter: item => item.datasetIndex < 2,
        },
        tooltip: {
          callbacks: {
            title: ctx => ctx[0].parsed.x.toFixed(3) + '%',
            label: ctx => ctx.datasetIndex < 2
              ? ` ${ctx.dataset.label}: densidad ${ctx.parsed.y.toFixed(1)}`
              : '',
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          grid:  { color: '#2a334760' },
          ticks: {
            color: '#7b8aab',
            maxTicksLimit: 8,
            callback: v => v.toFixed(2) + '%',
          },
        },
        y: {
          display: false,
          grid:    { display: false },
        },
      },
    },
  });
}

// ── Normal CDF (for p-value) ──────────────────────────────────
function normCdf(z) {
  const t = 1 / (1 + 0.2315419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf  = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cdf  = 1 - pdf * poly;
  return z < 0 ? 1 - cdf : cdf;
}

// ── Table ─────────────────────────────────────────────────────
function renderTable() {
  const q = (qs('#search').value || '').toLowerCase();
  let rows = DISTRICTS.filter(d => !q ||
    [d.p4, d.p3, d.p2, d.p1].some(v => v.toLowerCase().includes(q)));

  const s = qs('#sort').value;
  if      (s === 'moe-desc')    rows.sort((a, b) => b.MoE - a.MoE);
  else if (s === 'moe-asc')     rows.sort((a, b) => a.MoE - b.MoE);
  else if (s === 'pct-a-desc')  rows.sort((a, b) => b.pA - a.pA);
  else if (s === 'pct-b-desc')  rows.sort((a, b) => b.pB - a.pB);
  else if (s === 'extrap-desc') rows.sort((a, b) => b.Nhat - a.Nhat);
  else if (s === 'cov-asc')     rows.sort((a, b) => a.cov - b.cov);
  else rows.sort((a, b) => (a.p4 || a.p3 || a.p2).localeCompare(b.p4 || b.p3 || b.p2));

  qs('#tbl-count').textContent = `${fmt(rows.length)} de ${fmt(DISTRICTS.length)}`;
  qs('#tbl-empty').classList.toggle('hidden', rows.length > 0);

  const tbody = qs('#tbody');
  tbody.innerHTML = '';

  for (const d of rows) {
    const moeClass = d.MoE * 100 <= 1 ? 'moe-low' : d.MoE * 100 <= 3 ? 'moe-med' : 'moe-high';
    const imputedBadge = d.imputed
      ? ` <span class="imp-badge" title="Sin actas contadas. Distribución imputada desde nivel ${d.imputedLevel}">↑L${d.imputedLevel}</span>`
      : '';
    const tr = document.createElement('tr');
    if (d.imputed) tr.classList.add('row-imputed');
    tr.innerHTML = `
      <td class="loc">${d.p4}${imputedBadge}<small>${[d.p2, d.p3].filter(Boolean).join(' › ')}</small></td>
      <td class="num">${d.imputed ? `<span style="color:var(--muted)">0 / ${fmt(d.N)}</span>` : `${fmt(d.n)} / ${fmt(d.N)}`}</td>
      <td>
        <div style="font-size:.72rem;color:var(--muted)">${(d.cov*100).toFixed(1)}%</div>
        <div class="cov-bar-wrap"><div class="cov-bar" style="width:${Math.min(100,d.cov*100)}%"></div></div>
      </td>
      <td class="num">${fmt(d.totalValid)}</td>
      <td class="pa">${fmtPct(d.pA*100)}</td>
      <td class="pb">${fmtPct(d.pB*100)}</td>
      <td class="num">${fmt(Math.round(d.Nhat))}</td>
      <td class="moe"><span class="moe-badge ${moeClass}">±${fmtPct(d.MoE*100)}</span></td>
      <td class="num" style="font-size:.72rem;color:var(--muted)">[${fmtPct(d.ciLo*100)} – ${fmtPct(d.ciHi*100)}]</td>
      <td>
        <div class="mini-bar">
          <div class="mini-a" style="width:${d.pA*100}%"></div>
          <div class="mini-b" style="width:${d.pB*100}%"></div>
        </div>
      </td>`;
    tbody.appendChild(tr);
  }
}

// ── Boot ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  fetch(CSV)
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
    .then(text => { build(text); render(); })
    .catch(e  => { qs('#status').textContent = '⚠ ' + e.message; });
});
