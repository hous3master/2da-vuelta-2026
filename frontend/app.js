/* ══════════════════════════════════════════════════════════════
   ONPE 2026 · Análisis Electoral bottom-up
   ══════════════════════════════════════════════════════════════

   PASOS:
   1. Leer CSV → quedarse solo con filas depth-4 (p4 != "")
   2. Por cada distrito calcular:
        p̂  = votos_A / total_válidos
        N̂  = total_válidos × (totalActas / contabilizadas)
        SE = √(p̂(1−p̂)/n) × √((N−n)/(N−1))   n=contabilizadas, N=totalActas
        MoE= 1.96 × SE
   3. SUMPRODUCTO → resultado nacional:
        total_A    = Σ (p̂ᵢ × N̂ᵢ)
        total_V    = Σ N̂ᵢ
        P_final    = total_A / total_V
        Var_total  = Σ (SEᵢ × N̂ᵢ)²
        MoE_final  = 1.96 × √Var_total / total_V
   ══════════════════════════════════════════════════════════════ */

'use strict';

const Z     = 1.96;
const CSV   = '/resultados_onpe_progresivo.csv';

const fmt    = n  => n == null ? '–' : Number(n).toLocaleString('es-PE');
const fmtPct = p  => p == null ? '–' : (+p).toFixed(3) + '%';
const qs     = s  => document.querySelector(s);
const qsa    = s  => [...document.querySelectorAll(s)];

let DISTRICTS = [];   // array of computed district objects
let candA = null, candB = null;

// ── BOOT ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  fetch(CSV)
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} al cargar ${CSV}`); return r.text(); })
    .then(text => { build(text); render(); })
    .catch(e  => { qs('#status').textContent = '⚠ ' + e.message; });
});

// ── CSV → DISTRICT OBJECTS ────────────────────────────────────
function splitLine(line) {
  const out = []; let cur = '', q = false;
  for (const c of line) {
    if (c === '"')              { q = !q; continue; }
    if (c === ',' && !q)        { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  return [...out, cur];
}

function build(raw) {
  const lines   = raw.split('\n').filter(l => l.trim());
  const headers = splitLine(lines[0]).map(h => h.trim());

  // ── 1. Most recent row per (geo4-key, candidato) ──────────
  const latest = new Map();
  for (let i = 1; i < lines.length; i++) {
    const vals = splitLine(lines[i]);
    if (vals.length < headers.length) continue;
    const row  = {};
    headers.forEach((h, j) => row[h] = (vals[j] ?? '').trim());

    const depth = [row.PROFUNDIDAD_2, row.PROFUNDIDAD_3, row.PROFUNDIDAD_4].filter(Boolean).length;
    if (depth !== 3) continue;               // ← solo depth 4

    const key  = `${row.PROFUNDIDAD_1}|${row.PROFUNDIDAD_2}|${row.PROFUNDIDAD_3}|${row.PROFUNDIDAD_4}|${row.nombreCandidato}`;
    const prev = latest.get(key);
    if (!prev || row.executionTs > prev.executionTs) latest.set(key, row);
  }

  // ── 2. Agrupar por nodo geográfico ───────────────────────
  const nodes = new Map();
  for (const row of latest.values()) {
    const gk = `${row.PROFUNDIDAD_1}|${row.PROFUNDIDAD_2}|${row.PROFUNDIDAD_3}|${row.PROFUNDIDAD_4}`;
    if (!nodes.has(gk)) {
      nodes.set(gk, {
        p1: row.PROFUNDIDAD_1, p2: row.PROFUNDIDAD_2,
        p3: row.PROFUNDIDAD_3, p4: row.PROFUNDIDAD_4,
        n: +row.contabilizadas,   // actas contabilizadas (muestra)
        N: +row.totalActas,       // total actas (población)
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

  // ── 3. Detectar candidatos ───────────────────────────────
  // Agrega para identificar cuáles son A (Sánchez=rojo) y B (Fujimori=naranja)
  const totals = {};
  for (const nd of nodes.values())
    for (const [nombre, v] of Object.entries(nd.cands))
      totals[nombre] = (totals[nombre] || 0) + v;
  const sorted = Object.entries(totals).sort((a,b) => b[1]-a[1]);
  const fujimori = sorted.find(([n]) => n.includes('FUJIMORI'));
  const sanchez  = sorted.find(([n]) => n.includes('SANCHEZ'));
  candA = (sanchez  || sorted[0])?.[0];
  candB = (fujimori || sorted[1])?.[0];

  // ── 4. Computar estadísticas por distrito ────────────────
  DISTRICTS = [];
  for (const nd of nodes.values()) {
    const totalValid = Object.values(nd.cands).reduce((s,v)=>s+v, 0);
    if (totalValid === 0) continue;

    const vA = nd.cands[candA] ?? 0;
    const vB = nd.cands[candB] ?? 0;
    const pA = vA / totalValid;          // proporción actual candidato A
    const pB = vB / totalValid;

    // Extrapolación
    const factor = (nd.n > 0 && nd.N > 0) ? nd.N / nd.n : 1;
    const Nhat   = totalValid * factor;  // votos válidos proyectados

    // MoE con FPC  (muestra = actas contabilizadas, población = total actas)
    // SE_p = √(p̂(1−p̂)/n) × √((N−n)/(N−1))
    let SE = 0;
    if (nd.n > 1 && nd.N > nd.n) {
      const fpc = Math.sqrt((nd.N - nd.n) / (nd.N - 1));
      SE = Math.sqrt(pA * (1 - pA) / nd.n) * fpc;
    } else if (nd.n > 1) {
      SE = Math.sqrt(pA * (1 - pA) / nd.n);  // sin FPC si n≥N
    }
    const MoE = Z * SE;   // en proporción (0..1)

    // Contribución a la varianza del SUMPRODUCTO (en unidades de voto)
    const SE_votes = SE * Nhat;

    DISTRICTS.push({
      p1: nd.p1, p2: nd.p2, p3: nd.p3, p4: nd.p4,
      ts: nd.ts,
      n:  nd.n,           // actas contabilizadas
      N:  nd.N,           // total actas
      cov: nd.N > 0 ? nd.n / nd.N : 0,     // cobertura 0..1
      totalValid,          // votos válidos contados
      vA, vB,
      pA, pB,             // proporciones actuales
      Nhat,               // votos válidos proyectados
      MoE,                // MoE en proporción, al 95%
      SE_votes,           // SE en unidades de voto (para componer)
      ciLo: Math.max(0,   pA - MoE),
      ciHi: Math.min(1,   pA + MoE),
    });
  }
}

// ── RENDER ────────────────────────────────────────────────────
function render() {
  if (!DISTRICTS.length) {
    qs('#status').textContent = '⚠ No se encontraron filas depth-4 en el CSV.';
    return;
  }

  // ── SUMPRODUCTO ──────────────────────────────────────────
  const totalA  = DISTRICTS.reduce((s,d) => s + d.pA * d.Nhat, 0);
  const totalB  = DISTRICTS.reduce((s,d) => s + d.pB * d.Nhat, 0);
  const totalV  = DISTRICTS.reduce((s,d) => s + d.Nhat, 0);
  const totalN  = DISTRICTS.reduce((s,d) => s + d.N, 0);
  const totaln  = DISTRICTS.reduce((s,d) => s + d.n, 0);

  const pFinalA = totalA / totalV;
  const pFinalB = totalB / totalV;

  // Varianza compuesta: Var = Σ (SE_i × N̂_i)²
  const varTotal  = DISTRICTS.reduce((s,d) => s + d.SE_votes ** 2, 0);
  const SE_final  = Math.sqrt(varTotal) / totalV;
  const MoE_final = Z * SE_final;

  const ciLo = Math.max(0,   pFinalA - MoE_final);
  const ciHi = Math.min(1,   pFinalA + MoE_final);

  const covPct = totalN > 0 ? totaln / totalN * 100 : 0;
  const ts     = DISTRICTS.reduce((a,d) => d.ts > a ? d.ts : a, '');

  // Header status
  qs('#status').innerHTML =
    `<b>${fmt(DISTRICTS.length)}</b> distritos · ${fmt(totalN)} actas · ` +
    `actualizado ${new Date(ts).toLocaleString('es-PE')}`;
  qs('#footer-ts').textContent = new Date().toLocaleString('es-PE');

  // ── Tarjetas de candidatos ───────────────────────────────
  const winner = pFinalA >= pFinalB ? 'a' : 'b';
  qs('#card-a').classList.toggle('winner', winner === 'a');
  qs('#card-b').classList.toggle('winner', winner === 'b');

  qs('#name-a').textContent   = candA;
  qs('#name-b').textContent   = candB;
  qs('#pct-a').textContent    = fmtPct(pFinalA * 100);
  qs('#pct-b').textContent    = fmtPct(pFinalB * 100);
  qs('#extrap-a').textContent = fmt(Math.round(totalA));
  qs('#extrap-b').textContent = fmt(Math.round(totalB));
  qs('#ic-a').textContent =
    `IC 95%: [${fmtPct(ciLo*100)} – ${fmtPct(ciHi*100)}]  MoE ±${fmtPct(MoE_final*100)}`;
  qs('#ic-b').textContent =
    `IC 95%: [${fmtPct((1-(ciHi))*100)} – ${fmtPct((1-(ciLo))*100)}]`;

  // Barra divergente
  qs('#bar-a').style.width  = (pFinalA * 100) + '%';
  qs('#bar-b').style.width  = (pFinalB * 100) + '%';
  qs('#blbl-a').textContent = fmtPct(pFinalA * 100);
  qs('#blbl-b').textContent = fmtPct(pFinalB * 100);

  // Anillo de cobertura
  const circ = 2 * Math.PI * 32;
  qs('#ring-fg').style.strokeDashoffset = circ * (1 - covPct / 100);
  qs('#cov-pct').textContent  = covPct.toFixed(1) + '%';
  qs('#cov-acts').textContent = `${fmt(totaln)} / ${fmt(totalN)} actas`;
  qs('#cov-districts').textContent = `${fmt(DISTRICTS.length)} distritos`;

  // Nombres de columnas en tabla
  const short = n => n.split(' ').slice(0,2).join(' ');
  qs('#th-pa').textContent = 'p̂ ' + short(candA);
  qs('#th-pb').textContent = 'p̂ ' + short(candB);

  qs('#result').classList.remove('hidden');
  qs('#table-section').classList.remove('hidden');

  // ── Tabla ────────────────────────────────────────────────
  renderTable();

  qs('#search').addEventListener('input',   renderTable);
  qs('#sort').addEventListener('change',    renderTable);
}

// ── TABLA ─────────────────────────────────────────────────────
function renderTable() {
  const q = qs('#search').value.toLowerCase();
  let rows = DISTRICTS.filter(d => !q ||
    [d.p4, d.p3, d.p2, d.p1].some(v => v.toLowerCase().includes(q)));

  const s = qs('#sort').value;
  if      (s === 'moe-desc')    rows.sort((a,b) => b.MoE - a.MoE);
  else if (s === 'moe-asc')     rows.sort((a,b) => a.MoE - b.MoE);
  else if (s === 'pct-a-desc')  rows.sort((a,b) => b.pA - a.pA);
  else if (s === 'pct-b-desc')  rows.sort((a,b) => b.pB - a.pB);
  else if (s === 'extrap-desc') rows.sort((a,b) => b.Nhat - a.Nhat);
  else if (s === 'cov-asc')     rows.sort((a,b) => a.cov - b.cov);
  else                          rows.sort((a,b) => d4label(a).localeCompare(d4label(b)));

  qs('#tbl-count').textContent = `${fmt(rows.length)} de ${fmt(DISTRICTS.length)}`;
  qs('#tbl-empty').classList.toggle('hidden', rows.length > 0);

  const tbody = qs('#tbody');
  tbody.innerHTML = '';

  for (const d of rows) {
    const moeClass = d.MoE * 100 <= 1 ? 'moe-low' : d.MoE * 100 <= 3 ? 'moe-med' : 'moe-high';
    const covPct   = (d.cov * 100).toFixed(1);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="loc">
        ${d.p4}
        <small>${[d.p2, d.p3].filter(Boolean).join(' › ')}</small>
      </td>
      <td class="num">${fmt(d.n)} / ${fmt(d.N)}</td>
      <td>
        <div style="font-size:.75rem;color:var(--muted)">${covPct}%</div>
        <div class="cov-bar-wrap"><div class="cov-bar" style="width:${Math.min(100,d.cov*100)}%"></div></div>
      </td>
      <td class="num">${fmt(d.totalValid)}</td>
      <td class="pa">${fmtPct(d.pA * 100)}</td>
      <td class="pb">${fmtPct(d.pB * 100)}</td>
      <td class="num">${fmt(Math.round(d.Nhat))}</td>
      <td class="moe">
        <span class="moe-badge ${moeClass}">±${fmtPct(d.MoE * 100)}</span>
      </td>
      <td class="num" style="color:var(--muted);font-size:.73rem">
        [${fmtPct(d.ciLo*100)} – ${fmtPct(d.ciHi*100)}]
      </td>
      <td>
        <div class="mini-bar">
          <div class="mini-a" style="width:${d.pA*100}%"></div>
          <div class="mini-b" style="width:${d.pB*100}%"></div>
        </div>
      </td>`;
    tbody.appendChild(tr);
  }
}

const d4label = d => d.p4 || d.p3 || d.p2 || d.p1;
