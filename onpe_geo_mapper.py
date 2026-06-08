"""
FASE 1: Mapeo estático de la jerarquía geográfica completa.
Genera geo_map.json con todos los nodos ordenados para el scraper principal.

Estructura de salida:
[
  {
    "tipo": "nacional" | "extranjero",
    "p1": "Perú" | "Extranjero",
    "p2": nombre_region_o_continente,
    "p3": nombre_provincia_o_pais,
    "p4": nombre_distrito_o_ciudad,
    "tipoFiltro": "ambito_geografico" | "ubigeo_nivel_01" | "ubigeo_nivel_02" | "ubigeo_nivel_03",
    "idAmbitoGeografico": 1 | 2,
    "idUbigeoDepartamento": str | null,
    "idUbigeoProvincia": str | null,
    "idUbigeoDistrito": str | null
  },
  ...
]
"""

import json
import time
import sys
from urllib.request import Request, urlopen
from urllib.error import URLError

BASE = "https://resultadosegundavuelta.onpe.gob.pe/presentacion-backend"
OUTPUT = "geo_map.json"
DELAY = 0.25

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


def get(url, retries=3):
    for attempt in range(retries):
        try:
            req = Request(url, headers=HEADERS)
            with urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("data") if data.get("success") else []
        except (URLError, json.JSONDecodeError) as e:
            print(f"  [intento {attempt+1}] ERROR {url[-80:]}: {e}", file=sys.stderr)
            if attempt < retries - 1:
                time.sleep(2)
    return []


def ubigeos(endpoint, **params):
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    return get(f"{BASE}/ubigeos/{endpoint}?idEleccion=10&{qs}") or []


nodes = []

def add(tipo, p1, p2, p3, p4, tipo_filtro, id_ambito, dep=None, prov=None, dist=None):
    nodes.append({
        "tipo": tipo,
        "p1": p1, "p2": p2, "p3": p3, "p4": p4,
        "tipoFiltro": tipo_filtro,
        "idAmbitoGeografico": id_ambito,
        "idUbigeoDepartamento": dep,
        "idUbigeoProvincia": prov,
        "idUbigeoDistrito": dist,
    })


# ─────────────────────────────────────
# PERÚ (idAmbitoGeografico=1)
# ─────────────────────────────────────
print("Mapeando Perú...")
add("nacional", "Perú", "", "", "", "ambito_geografico", 1)

departamentos = ubigeos("departamentos", idAmbitoGeografico=1)
time.sleep(DELAY)

for dep in departamentos:
    dep_u, dep_n = dep["ubigeo"], dep["nombre"]
    print(f"  Región: {dep_n}")
    add("nacional", "Perú", dep_n, "", "", "ubigeo_nivel_01", 1, dep=dep_u)

    provincias = ubigeos("provincias", idAmbitoGeografico=1, idUbigeoDepartamento=dep_u)
    time.sleep(DELAY)

    for prov in provincias:
        prov_u, prov_n = prov["ubigeo"], prov["nombre"]
        add("nacional", "Perú", dep_n, prov_n, "", "ubigeo_nivel_02", 1, dep=dep_u, prov=prov_u)

        distritos = ubigeos("distritos", idAmbitoGeografico=1, idUbigeoProvincia=prov_u)
        time.sleep(DELAY)

        for dist in distritos:
            dist_u, dist_n = dist["ubigeo"], dist["nombre"]
            add("nacional", "Perú", dep_n, prov_n, dist_n, "ubigeo_nivel_03", 1, dep=dep_u, prov=prov_u, dist=dist_u)

        print(f"    {prov_n}: {len(distritos)} distritos")


# ─────────────────────────────────────
# EXTRANJERO (idAmbitoGeografico=2)
# ─────────────────────────────────────
print("\nMapeando Extranjero...")
add("extranjero", "Extranjero", "", "", "", "ambito_geografico", 2)

continentes = ubigeos("departamentos", idAmbitoGeografico=2)
time.sleep(DELAY)

for cont in continentes:
    cont_u, cont_n = cont["ubigeo"], cont["nombre"]
    print(f"  Continente: {cont_n}")
    add("extranjero", "Extranjero", cont_n, "", "", "ubigeo_nivel_01", 2, dep=cont_u)

    paises = ubigeos("provincias", idAmbitoGeografico=2, idUbigeoDepartamento=cont_u)
    time.sleep(DELAY)

    for pais in paises:
        pais_u, pais_n = pais["ubigeo"], pais["nombre"]
        add("extranjero", "Extranjero", cont_n, pais_n, "", "ubigeo_nivel_02", 2, dep=cont_u, prov=pais_u)

        ciudades = ubigeos("distritos", idAmbitoGeografico=2, idUbigeoProvincia=pais_u)
        time.sleep(DELAY)

        for ciudad in ciudades:
            ciudad_u, ciudad_n = ciudad["ubigeo"], ciudad["nombre"]
            add("extranjero", "Extranjero", cont_n, pais_n, ciudad_n, "ubigeo_nivel_03", 2, dep=cont_u, prov=pais_u, dist=ciudad_u)

        print(f"    {pais_n}: {len(ciudades)} ciudades")


with open(OUTPUT, "w", encoding="utf-8") as f:
    json.dump(nodes, f, ensure_ascii=False, indent=2)

print(f"\n✓ geo_map.json guardado: {len(nodes)} nodos geográficos")

# Resumen
by_filtro = {}
for n in nodes:
    k = (n["tipo"], n["tipoFiltro"])
    by_filtro[k] = by_filtro.get(k, 0) + 1
for k, v in sorted(by_filtro.items()):
    print(f"  {k[0]:12} {k[1]:20} → {v} nodos")
