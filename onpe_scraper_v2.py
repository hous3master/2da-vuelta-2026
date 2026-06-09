"""
FASE 2: Scraper progresivo de resultados electorales ONPE 2da Vuelta 2026.

Lee geo_map.json y lanza hasta WORKERS peticiones HTTP en paralelo.
Escribe al CSV con lock y avanza el checkpoint de forma consecutiva segura.

Archivos:
  geo_map.json                   → mapa estático (input)
  resultados_onpe_progresivo.csv → CSV acumulativo (append)
  checkpoint.txt                 → último índice consecutivo exitoso
"""

import json, csv, time, sys, os, threading
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError
from concurrent.futures import ThreadPoolExecutor, as_completed

# Fix Windows cp1252 console encoding
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', buffering=1)
    sys.stderr = open(sys.stderr.fileno(), mode='w', encoding='utf-8', buffering=1)

# ─── Config ───────────────────────────────────────────────────────────────────
BASE      = "https://resultadosegundavuelta.onpe.gob.pe/presentacion-backend"
GEO_FILE  = "geo_map.json"
CSV_FILE  = "resultados_onpe_progresivo.csv"
CKPT_FILE = "checkpoint.txt"
WORKERS   = 10
DELAY     = 0.10   # pausa entre los 2 endpoints dentro de un mismo hilo
RETRIES   = 3
TIMEOUT   = 25

HEADERS = {
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    "priority": "u=1, i",
    "referer": "https://resultadosegundavuelta.onpe.gob.pe/main/resumen",
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
    ),
}

FIELDNAMES = [
    "executionTs",
    "nombreCandidato",
    "PROFUNDIDAD_1", "PROFUNDIDAD_2", "PROFUNDIDAD_3", "PROFUNDIDAD_4",
    "contabilizadas", "totalActas", "totalVotosValidos", "porcentajeVotosValidos",
    "tipoFiltro", "idAmbitoGeografico",
]

# ─── HTTP ──────────────────────────────────────────────────────────────────────
def get_json(url):
    for attempt in range(RETRIES):
        try:
            req = Request(url, headers=HEADERS)
            with urlopen(req, timeout=TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("data") if data.get("success") else None
        except (URLError, json.JSONDecodeError) as e:
            if attempt < RETRIES - 1:
                time.sleep(2 ** attempt)
    return None


def build_qs(node):
    parts = [
        "idEleccion=10",
        f"tipoFiltro={node['tipoFiltro']}",
        f"idAmbitoGeografico={node['idAmbitoGeografico']}",
    ]
    if node.get("idUbigeoDepartamento"):
        parts.append(f"idUbigeoDepartamento={node['idUbigeoDepartamento']}")
    if node.get("idUbigeoProvincia"):
        parts.append(f"idUbigeoProvincia={node['idUbigeoProvincia']}")
    if node.get("idUbigeoDistrito"):
        parts.append(f"idUbigeoDistrito={node['idUbigeoDistrito']}")
    return "&".join(parts)


# ─── Worker (runs in thread pool) ─────────────────────────────────────────────
def process_node(idx, node):
    """Fetch totales + participantes for one node. Returns (idx, rows|None)."""
    ts = datetime.now(timezone.utc).isoformat()
    qs = build_qs(node)

    totales       = get_json(f"{BASE}/resumen-general/totales?{qs}")
    time.sleep(DELAY)
    participantes = get_json(f"{BASE}/resumen-general/participantes?{qs}")

    if totales is None or participantes is None:
        return idx, None

    contabilizadas = totales.get("contabilizadas", 0)
    total_actas    = totales.get("totalActas", 0)

    rows = [
        {
            "executionTs"           : ts,
            "nombreCandidato"       : p.get("nombreCandidato", ""),
            "PROFUNDIDAD_1"         : node["p1"],
            "PROFUNDIDAD_2"         : node["p2"],
            "PROFUNDIDAD_3"         : node["p3"],
            "PROFUNDIDAD_4"         : node["p4"],
            "contabilizadas"        : contabilizadas,
            "totalActas"            : total_actas,
            "totalVotosValidos"     : p.get("totalVotosValidos", 0),
            "porcentajeVotosValidos": p.get("porcentajeVotosValidos", 0),
            "tipoFiltro"            : node["tipoFiltro"],
            "idAmbitoGeografico"    : node["idAmbitoGeografico"],
        }
        for p in participantes
    ]
    return idx, rows


# ─── Checkpoint (thread-safe) ──────────────────────────────────────────────────
def read_checkpoint():
    if os.path.isfile(CKPT_FILE):
        try:
            return int(open(CKPT_FILE).read().strip())
        except ValueError:
            pass
    return -1


def save_checkpoint(idx):
    with open(CKPT_FILE, "w") as f:
        f.write(str(idx))


def advance_checkpoint(completed_set, start_idx, current_ckpt):
    """Return the highest consecutive index from start_idx that is completed."""
    i = max(current_ckpt + 1, start_idx)
    while i in completed_set:
        i += 1
    return i - 1


# ─── Main ──────────────────────────────────────────────────────────────────────
def main():
    if not os.path.isfile(GEO_FILE):
        print(f"ERROR: '{GEO_FILE}' no encontrado.", file=sys.stderr)
        sys.exit(1)

    with open(GEO_FILE, encoding="utf-8") as f:
        nodes = json.load(f)

    last_ok   = read_checkpoint()
    start_idx = last_ok + 1
    total     = len(nodes)

    if start_idx >= total:
        print("Ya completados todos los nodos según checkpoint.")
        return

    print(f"Nodos pendientes: {total - start_idx}/{total}  |  Workers: {WORKERS}")

    write_header = not (os.path.isfile(CSV_FILE) and os.path.getsize(CSV_FILE) > 0)
    csv_file  = open(CSV_FILE, "a", newline="", encoding="utf-8")
    writer    = csv.DictWriter(csv_file, fieldnames=FIELDNAMES)
    if write_header:
        writer.writeheader()

    csv_lock       = threading.Lock()
    completed_set  = set()
    ckpt_lock      = threading.Lock()
    current_ckpt   = [last_ok]   # mutable container for closure
    done_count     = [0]
    ok_count       = [0]

    try:
        with ThreadPoolExecutor(max_workers=WORKERS) as executor:
            futures = {
                executor.submit(process_node, idx, nodes[idx]): idx
                for idx in range(start_idx, total)
            }

            for future in as_completed(futures):
                idx, rows = future.result()
                label = f"{nodes[idx]['p1']} > {nodes[idx].get('p4') or nodes[idx].get('p3') or nodes[idx].get('p2', '')}"

                with csv_lock:
                    done_count[0] += 1
                    if rows:
                        for row in rows:
                            writer.writerow(row)
                        csv_file.flush()
                        ok_count[0] += 1
                        status = "✓"
                    else:
                        status = "⚠"

                with ckpt_lock:
                    completed_set.add(idx)
                    new_ckpt = advance_checkpoint(completed_set, start_idx, current_ckpt[0])
                    if new_ckpt > current_ckpt[0]:
                        current_ckpt[0] = new_ckpt
                        save_checkpoint(new_ckpt)

                print(f"[{done_count[0]}/{total-start_idx}] {status} {label[:70]}")

    except KeyboardInterrupt:
        print("\nInterrumpido. Checkpoint guardado.")
    finally:
        csv_file.close()

    print(f"\nFinalizado. OK={ok_count[0]}  Checkpoint={current_ckpt[0]}/{total-1}")


if __name__ == "__main__":
    main()
