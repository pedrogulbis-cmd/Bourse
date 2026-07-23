"""
Exporte le contenu de la base SQLite vers un ou plusieurs fichiers JSON,
dans le format attendu par le site (voir loadSnapshot() dans data.js).

Le fichier complet peut dépasser la limite d'upload de GitHub (25 Mo) une
fois l'univers élargi (voir MAX_UNIVERSE_PER_COUNTRY dans config.py) — ce
module découpe donc automatiquement en plusieurs parties dès que ça
approche la limite :

    data-snapshot-manifest.json   (petit fichier listant les parties)
    data-snapshot-1.json
    data-snapshot-2.json
    ... (autant que nécessaire)

Le site charge d'abord le manifeste, puis toutes les parties en parallèle,
et les fusionne — transparent pour le reste du code, qui continue de voir
un seul objet {generatedAt, records: [...]}.
"""
import json
import os
import time
from datetime import datetime, timezone

import db as dbmod
from config import SNAPSHOT_PATH, TV_COUNTRY_NAMES

NAME_TO_COUNTRY_CODE = {v: k for k, v in TV_COUNTRY_NAMES.items()}

# Taille max visée par partie — nettement sous la limite de 25 Mo de GitHub
# pour laisser de la marge (l'estimation de taille pendant le découpage est
# approximative, pas un calcul byte-perfect de l'export final).
MAX_PART_BYTES = 20 * 1024 * 1024


def _build_records(conn):
    rows = dbmod.get_all_fundamentals(conn)
    records = []
    skipped = 0
    for r in rows:
        if r.get("error") is not None or r.get("fetched_at") is None:
            skipped += 1
            continue
        div_yield = r.get("div_yield") or 0.0
        buyback_yield = r.get("buyback_yield") or 0.0
        records.append({
            "symbol": r["symbol"],
            "name": r["name"],
            "isin": r.get("isin"),
            "country": r["country"],
            "homeCountry": r.get("home_country"),
            "homeCountryCode": NAME_TO_COUNTRY_CODE.get(r.get("home_country")) if r.get("home_country") else None,
            "listedCurrency": r.get("listed_currency"),
            "sector": r["sector"] or "—",
            "price": r.get("price"),
            "mcap": r.get("mcap") or 0,
            "pb": r.get("pb"),
            "pe": r.get("pe"),
            "ps": r.get("ps"),
            "pcf": r.get("pcf"),
            "ebitdaYield": r.get("ebitda_yield"),
            "divYield": div_yield,
            "shareholderYield": div_yield + buyback_yield,
            "mom3": r.get("mom3") or 0,
            "mom6": r.get("mom6") or 0,
            "epsGrowth": r.get("eps_growth"),
            "roe": r.get("roe"),
            "opMargin": r.get("op_margin"),
            "revenueGrowth": r.get("revenue_growth"),
            "avgDailyValue": r.get("avg_daily_value"),
            "analystRating": r.get("analyst_rating"),
            "analystLabel": r.get("analyst_label"),
        })
    return records, skipped


def _split_into_parts(records, max_bytes=MAX_PART_BYTES):
    """Découpe la liste de records en groupes dont la taille sérialisée
    reste sous max_bytes chacun. Estimation incrémentale (pas de
    re-sérialisation de tout le groupe à chaque record — resterait O(n²)
    sur un gros univers)."""
    parts = []
    current = []
    current_size = 2  # pour les crochets [ ]
    for rec in records:
        rec_json = json.dumps(rec, ensure_ascii=False, separators=(",", ":"))
        added = len(rec_json.encode("utf-8")) + 1  # +1 pour la virgule séparatrice
        if current and current_size + added > max_bytes:
            parts.append(current)
            current = []
            current_size = 2
        current.append(rec)
        current_size += added
    if current:
        parts.append(current)
    return parts


def export_snapshot(conn, out_path=SNAPSHOT_PATH):
    records, skipped = _build_records(conn)
    generated_at = datetime.now(timezone.utc).isoformat()
    generated_at_unix = time.time()

    base, _ext = os.path.splitext(out_path)
    parts = _split_into_parts(records)

    part_filenames = []
    for i, part_records in enumerate(parts, start=1):
        part_filename = f"{base}-{i}.json"
        with open(part_filename, "w", encoding="utf-8") as f:
            json.dump({
                "generatedAt": generated_at,
                "records": part_records,
            }, f, ensure_ascii=False, separators=(",", ":"))
        part_filenames.append(os.path.basename(part_filename))

    manifest_path = f"{base}-manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": generated_at,
            "generatedAtUnix": generated_at_unix,
            "count": len(records),
            "skipped": skipped,
            "parts": part_filenames,
        }, f, ensure_ascii=False, separators=(",", ":"))

    sizes = [os.path.getsize(f"{base}-{i}.json") for i in range(1, len(parts) + 1)]
    print(f"— {len(parts)} partie(s) écrite(s) : " +
          ", ".join(f"{os.path.basename(base)}-{i}.json ({s/1024/1024:.1f} Mo)" for i, s in enumerate(sizes, start=1)))

    return len(records), skipped, manifest_path
