"""
Replica exacta de la lógica estadística de frontend/app.js
Lee resultados_onpe_progresivo.csv e imprime el resumen en consola.
"""

import csv, math, sys
from collections import defaultdict
from datetime import datetime, timezone

Z = 1.96
CSV_FILE = "resultados_onpe_progresivo.csv"

def norm_cdf(z):
    t = 1 / (1 + 0.2315419 * abs(z))
    poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
    pdf  = math.exp(-0.5 * z * z) / math.sqrt(2 * math.pi)
    cdf  = 1 - pdf * poly
    return 1 - cdf if z < 0 else cdf

def load_csv(path):
    with open(path, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        return [r for r in reader]

def build(rows):
    latest        = {}   # (p1|p2|p3|p4, cand) → row   (depth-4)
    latest_parent = {}   # (p1|p2|p3,     cand) → row   (depth-1/2/3)

    for r in rows:
        p4 = r.get("PROFUNDIDAD_4", "").strip()
        cand = r.get("nombreCandidato", "").strip()
        ts   = r.get("executionTs", "").strip()

        if p4:
            key = f"{r['PROFUNDIDAD_1']}|{r['PROFUNDIDAD_2']}|{r['PROFUNDIDAD_3']}|{p4}|{cand}"
            if key not in latest or ts > latest[key]["executionTs"]:
                latest[key] = r
        else:
            parts = [r.get(f"PROFUNDIDAD_{i}", "").strip() for i in range(1, 4)]
            pkey  = "|".join(p for p in parts if p)
            key   = pkey + "|" + cand
            if key not in latest_parent or ts > latest_parent[key]["executionTs"]:
                latest_parent[key] = r

    # group depth-4 by geo node
    nodes = {}
    for r in latest.values():
        gk = f"{r['PROFUNDIDAD_1']}|{r['PROFUNDIDAD_2']}|{r['PROFUNDIDAD_3']}|{r['PROFUNDIDAD_4']}"
        if gk not in nodes:
            nodes[gk] = dict(
                p1=r["PROFUNDIDAD_1"], p2=r["PROFUNDIDAD_2"],
                p3=r["PROFUNDIDAD_3"], p4=r["PROFUNDIDAD_4"].strip(),
                n=int(r["contabilizadas"]), N=int(r["totalActas"]),
                ts=r["executionTs"], cands={}
            )
        nd = nodes[gk]
        nd["cands"][r["nombreCandidato"]] = int(r["totalVotosValidos"])
        if r["executionTs"] > nd["ts"]:
            nd["ts"] = r["executionTs"]
            nd["n"]  = int(r["contabilizadas"])
            nd["N"]  = int(r["totalActas"])

    # group parent nodes
    parent_nodes = {}
    for r in latest_parent.values():
        parts = [r.get(f"PROFUNDIDAD_{i}", "").strip() for i in range(1, 4)]
        pkey  = "|".join(p for p in parts if p)
        if pkey not in parent_nodes:
            parent_nodes[pkey] = dict(
                n=int(r["contabilizadas"]), N=int(r["totalActas"]),
                ts=r["executionTs"], cands={}
            )
        pnd = parent_nodes[pkey]
        pnd["cands"][r["nombreCandidato"]] = int(r["totalVotosValidos"])
        if r["executionTs"] > pnd["ts"]:
            pnd["ts"] = r["executionTs"]
            pnd["n"]  = int(r["contabilizadas"])
            pnd["N"]  = int(r["totalActas"])

    # detect candidates
    totals = defaultdict(int)
    for nd in nodes.values():
        for name, v in nd["cands"].items():
            totals[name] += v

    sorted_cands = sorted(totals.items(), key=lambda x: -x[1])
    cand_a = next((n for n, _ in sorted_cands if "SANCHEZ"  in n), sorted_cands[0][0])
    cand_b = next((n for n, _ in sorted_cands if "FUJIMORI" in n), sorted_cands[1][0])

    # parent prop helper
    def get_parent_prop(p1, p2, p3):
        keys = [
            "|".join(p for p in [p1, p2, p3] if p),
            "|".join(p for p in [p1, p2]     if p),
            p1,
        ]
        for pkey in keys:
            pnd = parent_nodes.get(pkey)
            if not pnd:
                continue
            total_v = sum(pnd["cands"].values())
            if total_v == 0 or pnd["n"] == 0:
                continue
            pA = pnd["cands"].get(cand_a, 0) / total_v
            return dict(pA=pA, votes_per_acta=total_v / pnd["n"],
                        n=pnd["n"], level=len(pkey.split("|")))
        return None

    # compute per-district stats
    districts = []
    for nd in nodes.values():
        total_valid = sum(nd["cands"].values())

        if total_valid == 0 or nd["n"] == 0:
            if nd["N"] == 0:
                continue
            parent = get_parent_prop(nd["p1"], nd["p2"], nd["p3"])
            if not parent:
                continue
            pA   = parent["pA"]
            pB   = 1 - pA
            Nhat = nd["N"] * parent["votes_per_acta"]
            SE   = math.sqrt(pA * (1 - pA) / parent["n"]) if parent["n"] > 1 else 0
            MoE  = Z * SE
            districts.append(dict(
                p1=nd["p1"], p2=nd["p2"], p3=nd["p3"], p4=nd["p4"],
                ts=nd["ts"], n=0, N=nd["N"], cov=0,
                total_valid=0, vA=0, vB=0, pA=pA, pB=pB,
                Nhat=Nhat, SE=SE, MoE=MoE, SE_votes=SE * Nhat,
                ciLo=max(0, pA - MoE), ciHi=min(1, pA + MoE),
                imputed=True, imputed_level=parent["level"],
            ))
        else:
            vA = nd["cands"].get(cand_a, 0)
            vB = nd["cands"].get(cand_b, 0)
            pA = vA / total_valid
            pB = vB / total_valid
            factor = nd["N"] / nd["n"] if nd["N"] > 0 else 1
            Nhat   = total_valid * factor
            SE     = math.sqrt(pA * (1 - pA) / nd["n"]) if nd["n"] > 1 else 0
            MoE    = Z * SE
            districts.append(dict(
                p1=nd["p1"], p2=nd["p2"], p3=nd["p3"], p4=nd["p4"],
                ts=nd["ts"], n=nd["n"], N=nd["N"],
                cov=nd["n"] / nd["N"] if nd["N"] > 0 else 0,
                total_valid=total_valid, vA=vA, vB=vB, pA=pA, pB=pB,
                Nhat=Nhat, SE=SE, MoE=MoE, SE_votes=SE * Nhat,
                ciLo=max(0, pA - MoE), ciHi=min(1, pA + MoE),
                imputed=False,
            ))

    return districts, cand_a, cand_b

def analyse(districts, cand_a, cand_b):
    total_A = sum(d["pA"] * d["Nhat"] for d in districts)
    total_B = sum(d["pB"] * d["Nhat"] for d in districts)
    total_V = sum(d["Nhat"]            for d in districts)
    total_N = sum(d["N"]               for d in districts)
    total_n = sum(d["n"]               for d in districts)

    pA = total_A / total_V
    pB = total_B / total_V

    # MoE bottom-up
    var_btup  = sum(d["SE_votes"] ** 2 for d in districts)
    SE_btup   = math.sqrt(var_btup) / total_V
    MoE_btup  = Z * SE_btup

    # MoE cluster
    s2w    = sum(d["Nhat"] * (d["pA"] - pA) ** 2 for d in districts) / total_V
    SE_cl  = math.sqrt(s2w / len(districts))
    MoE_cl = Z * SE_cl

    MoE_final = max(MoE_btup, MoE_cl)
    SE_final  = MoE_final / Z

    ciLoA = max(0, pA - MoE_final)
    ciHiA = min(1, pA + MoE_final)
    ciLoB = max(0, pB - MoE_final)
    ciHiB = min(1, pB + MoE_final)

    margin    = pA - pB
    MoE_diff  = Z * 2 * SE_final
    ciLo_margin = margin - MoE_diff
    ciHi_margin = margin + MoE_diff

    z_stat  = (pA - 0.5) / SE_final
    p_value = 2 * (1 - norm_cdf(abs(z_stat)))
    sig     = p_value < 0.05

    cov_pct = total_n / total_N * 100 if total_N else 0
    latest_ts = max(d["ts"] for d in districts)

    # actual counted votes (non-imputed districts only)
    real = [d for d in districts if not d["imputed"]]
    real_vA    = sum(d["vA"]          for d in real)
    real_vB    = sum(d["vB"]          for d in real)
    real_total = sum(d["total_valid"] for d in real)
    real_pA    = real_vA / real_total if real_total else 0
    real_pB    = real_vB / real_total if real_total else 0

    return dict(
        cand_a=cand_a, cand_b=cand_b,
        pA=pA, pB=pB,
        total_A=total_A, total_B=total_B, total_V=total_V,
        ciLoA=ciLoA, ciHiA=ciHiA, ciLoB=ciLoB, ciHiB=ciHiB,
        margin=margin, ciLo_margin=ciLo_margin, ciHi_margin=ciHi_margin,
        MoE_final=MoE_final, MoE_btup=MoE_btup, MoE_cl=MoE_cl,
        SE_final=SE_final, z_stat=z_stat, p_value=p_value, sig=sig,
        total_N=total_N, total_n=total_n, cov_pct=cov_pct,
        n_districts=len(districts), latest_ts=latest_ts,
        real_vA=real_vA, real_vB=real_vB, real_total=real_total,
        real_pA=real_pA, real_pB=real_pB,
    )

def print_report(r):
    def pp(x):   return f"{x*100:+.3f} pp"
    def pct(x):  return f"{x*100:.3f}%"
    def num(x):  return f"{int(x):,}".replace(",", "_")

    ts = r["latest_ts"][:19].replace("T", " ") + " UTC"
    winner = r["cand_a"].split()[0] if r["pA"] > r["pB"] else r["cand_b"].split()[0]
    overlap = r["ciHiA"] > r["ciLoB"] and r["ciHiB"] > r["ciLoA"]

    bar = lambda p: "█" * int(p * 40) + "░" * (40 - int(p * 40))

    print()
    print("=" * 66)
    print("  ONPE 2026 · Segunda Vuelta — Proyección estadística bottom-up")
    print(f"  Datos al: {ts}")
    print("=" * 66)

    print(f"\n  Cobertura: {r['total_n']:,} / {r['total_N']:,} actas "
          f"({r['cov_pct']:.1f}%)  ·  {r['n_districts']:,} distritos")
    print(f"  Votos válidos contados: {r['real_total']:,}"
          f"   (col. de {int(r['total_V']):,} proyectados)")

    print()
    print(f"  {'CANDIDATO':<42}  {'CONTADOS':>12}  {'PROYECTADOS':>13}")
    print(f"  {'-'*70}")

    def cand_line(name, p_real, v_real, p_proj, lo, hi, v_proj):
        short = " ".join(name.split()[:3])
        bar_s = bar(p_proj)
        return (
            f"  {short:<42}  {v_real:>11,}  {v_proj:>12,.0f}\n"
            f"    {bar_s}\n"
            f"    Contados: {p_real*100:.3f}%   Proyectado: {p_proj*100:.3f}%\n"
            f"    IC 95%: [{pct(lo)} – {pct(hi)}]"
        )

    print(cand_line(r["cand_a"], r["real_pA"], r["real_vA"],
                    r["pA"], r["ciLoA"], r["ciHiA"], r["total_A"]))
    print()
    print(cand_line(r["cand_b"], r["real_pB"], r["real_vB"],
                    r["pB"], r["ciLoB"], r["ciHiB"], r["total_B"]))

    print()
    print(f"  {'─'*66}")
    sign = "+" if r["margin"] >= 0 else ""
    print(f"  Ventaja {winner}: {sign}{r['margin']*100:.3f} pp")
    print(f"  IC 95% diferencia: [{pp(r['ciLo_margin'])} – {pp(r['ciHi_margin'])}]")
    print(f"  MoE final: ±{r['MoE_final']*100:.3f} pp  "
          f"(btup={r['MoE_btup']*100:.3f} pp  cluster={r['MoE_cl']*100:.3f} pp)")

    print()
    if r["sig"]:
        pstr = "<0.001" if r["p_value"] < 0.001 else f"{r['p_value']:.3f}"
        print(f"  ✓ Estadísticamente significativo  (z={r['z_stat']:+.2f}, p={pstr})")
    else:
        print(f"  ⚠ No significativo  (z={r['z_stat']:+.2f}, p={r['p_value']:.3f})")

    if overlap:
        print("  ⚠ Los IC se solapan → resultado dentro del margen de error")
    else:
        print("  ✓ IC no se solapan → diferencia estadísticamente distinguible")

    print()
    print("=" * 66)
    print()

if __name__ == "__main__":
    print("Cargando CSV…", end=" ", flush=True)
    rows = load_csv(CSV_FILE)
    print(f"{len(rows):,} filas")

    print("Calculando…", end=" ", flush=True)
    districts, cand_a, cand_b = build(rows)
    print(f"{len(districts):,} distritos depth-4")

    result = analyse(districts, cand_a, cand_b)
    print_report(result)
