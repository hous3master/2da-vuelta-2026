"""
FASE 2: Scraper progresivo de resultados electorales ONPE 2da Vuelta 2026.

Lee geo_map.json (generado por onpe_geo_mapper.py) y por cada nodo consulta
totales + participantes, escribiendo cada fila en el CSV al instante.

Archivos:
  geo_map.json                   → mapa estático de geografía (input)
  resultados_onpe_progresivo.csv → CSV acumulativo (append)
  checkpoint.txt                 → índice del último nodo procesado con éxito

Columnas CSV:
  executionTs, nombreCandidato, PROFUNDIDAD_1..4,
  contabilizadas, totalActas, totalVotosValidos,
  porcentajeVotosValidos
"""

import json
import csv
import time
import sys
import os
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError

# Fix Windows cp1252 console encoding
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', buffering=1)
    sys.stderr = open(sys.stderr.fileno(), mode='w', encoding='utf-8', buffering=1)

# ─── Config ───────────────────────────────────────────────────────────────────
BASE       = "https://resultadosegundavuelta.onpe.gob.pe/presentacion-backend"
GEO_FILE   = "geo_map.json"
CSV_FILE   = "resultados_onpe_progresivo.csv"
CKPT_FILE  = "checkpoint.txt"
DELAY      = 0.15   # segundos entre requests
RETRIES    = 3
TIMEOUT    = 20

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
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
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
            print(f"  [intento {attempt+1}/{RETRIES}] {e}", file=sys.stderr)
            if attempt < RETRIES - 1:
                time.sleep(2 ** attempt)
    return None


def build_qs(node):
    parts = [
        f"idEleccion=10",
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


# ─── CSV helpers ───────────────────────────────────────────────────────────────
def csv_exists():
    return os.path.isfile(CSV_FILE) and os.path.getsize(CSV_FILE) > 0


def open_csv():
    write_header = not csv_exists()
    f = open(CSV_FILE, "a", newline="", encoding="utf-8")
    writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
    if write_header:
        writer.writeheader()
    return f, writer


# ─── Checkpoint ────────────────────────────────────────────────────────────────
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


# ─── Main ──────────────────────────────────────────────────────────────────────
def main():
    if not os.path.isfile(GEO_FILE):
        print(f"ERROR: '{GEO_FILE}' no encontrado. Ejecuta primero onpe_geo_mapper.py", file=sys.stderr)
        sys.exit(1)

    with open(GEO_FILE, encoding="utf-8") as f:
        nodes = json.load(f)

    last_ok = read_checkpoint()
    start_idx = last_ok + 1

    if start_idx > 0:
        print(f"Reanudando desde nodo {start_idx} (checkpoint: nodo {last_ok})")
    else:
        print(f"Iniciando desde el principio. Total nodos: {len(nodes)}")

    csv_file, writer = open_csv()

    try:
        for idx in range(start_idx, len(nodes)):
            node = nodes[idx]
            qs = build_qs(node)

            ts = datetime.now(timezone.utc).isoformat()
            label = f"{node['p1']} > {node['p2']} > {node['p3']} > {node['p4']}".rstrip(" > ")
            print(f"[{idx+1}/{len(nodes)}] {label[:70]}")

            totales      = get_json(f"{BASE}/resumen-general/totales?{qs}")
            time.sleep(DELAY)
            participantes = get_json(f"{BASE}/resumen-general/participantes?{qs}")
            time.sleep(DELAY)

            if totales is None or participantes is None:
                print(f"  ⚠ Sin datos — se omite nodo {idx}", file=sys.stderr)
                # No actualizamos checkpoint: al reiniciar reintentará este nodo
                continue

            contabilizadas   = totales.get("contabilizadas", 0)
            total_actas      = totales.get("totalActas", 0)

            for part in participantes:
                row = {
                    "executionTs"          : ts,
                    "nombreCandidato"      : part.get("nombreCandidato", ""),
                    "PROFUNDIDAD_1"        : node["p1"],
                    "PROFUNDIDAD_2"        : node["p2"],
                    "PROFUNDIDAD_3"        : node["p3"],
                    "PROFUNDIDAD_4"        : node["p4"],
                    "contabilizadas"       : contabilizadas,
                    "totalActas"           : total_actas,
                    "totalVotosValidos"    : part.get("totalVotosValidos", 0),
                    "porcentajeVotosValidos": part.get("porcentajeVotosValidos", 0),
                    "tipoFiltro"           : node["tipoFiltro"],
                    "idAmbitoGeografico"   : node["idAmbitoGeografico"],
                }
                writer.writerow(row)

            csv_file.flush()            # escribe al disco inmediatamente
            save_checkpoint(idx)        # marca este nodo como exitoso

    except KeyboardInterrupt:
        print("\nInterrumpido por el usuario. El checkpoint está guardado.")
    finally:
        csv_file.close()

    print(f"\n✓ Finalizado. CSV: {CSV_FILE}  |  Checkpoint: nodo {read_checkpoint()}/{len(nodes)-1}")


if __name__ == "__main__":
    main()
