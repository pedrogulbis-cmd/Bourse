#!/usr/bin/env python3
"""
Orchestrateur du scraper Trending Value.

Usage :
    python run.py                              # tous les pays, rafraîchit ce qui a >7 jours
    python run.py --countries US,FR,DE         # seulement ces pays
    python run.py --mcap-floor 200000000       # univers "All Stocks" du livre (200 M$), pas que les blue chips
    python run.py --max-age-days 1             # force un rafraîchissement plus fréquent
    python run.py --limit 20                   # test rapide sur 20 titres max
    python run.py --skip-universe              # ne re-tape pas Yahoo pour l'univers, réutilise la base
    python run.py --export-only                # régénère juste data-snapshot.json depuis la base (après un Ctrl+C/plantage)

À la fin, écrit data-snapshot.json (voir SNAPSHOT_PATH dans config.py).
"""
import argparse
import random
import time
import sys

from tqdm import tqdm

import db as dbmod
import universe
import fetch
import export as exportmod
from config import REGION_MAP, DB_PATH, DEFAULT_MAX_AGE_DAYS, DEFAULT_MCAP_FLOOR, REQUEST_DELAY_MIN, REQUEST_DELAY_MAX


def main():
    ap = argparse.ArgumentParser(description="Scraper Trending Value — met à jour data-snapshot.json")
    ap.add_argument("--countries", type=str, default=None,
                     help="Codes pays séparés par des virgules (ex. US,FR,DE). Par défaut : tous.")
    ap.add_argument("--mcap-floor", type=int, default=DEFAULT_MCAP_FLOOR,
                     help=f"Capitalisation minimum en $ pour l'univers (défaut {DEFAULT_MCAP_FLOOR:,} = seuil 'All Stocks' du livre).")
    ap.add_argument("--max-age-days", type=int, default=DEFAULT_MAX_AGE_DAYS,
                     help=f"Ne re-télécharge un titre que si ses données ont plus de N jours (défaut {DEFAULT_MAX_AGE_DAYS}).")
    ap.add_argument("--limit", type=int, default=None, help="Limite le nombre de titres à récupérer (pour tester).")
    ap.add_argument("--skip-universe", action="store_true", help="Ne rappelle pas le screener Yahoo pour l'univers, réutilise la table 'universe' existante.")
    ap.add_argument("--export-only", action="store_true",
                     help="Ne fait ni univers ni fetch : régénère juste data-snapshot.json à partir de ce qui est déjà dans la base (utile après un Ctrl+C ou un plantage en cours de run).")
    ap.add_argument("--db", type=str, default=DB_PATH)
    args = ap.parse_args()

    if args.export_only:
        with dbmod.connect(args.db) as conn:
            n, skipped, path = exportmod.export_snapshot(conn)
            print(f"— Snapshot régénéré à partir de la base existante : {path} ({n} titres exploitables, {skipped} ignorés car sans données)")
        return

    countries = [c.strip().upper() for c in args.countries.split(",")] if args.countries else list(REGION_MAP.keys())
    unknown = [c for c in countries if c not in REGION_MAP]
    if unknown:
        print(f"Pays inconnus ignorés : {unknown} (disponibles : {list(REGION_MAP.keys())})")
        countries = [c for c in countries if c in REGION_MAP]

    with dbmod.connect(args.db) as conn:
        # 1) Univers (titres réels du pays, via le screener Yahoo, filtrés par capitalisation)
        if not args.skip_universe:
            print(f"— Récupération de l'univers (cap ≥ {args.mcap_floor:,}$) pour {countries}…")
            for c in countries:
                try:
                    constituents = universe.fetch_country_universe(c, args.mcap_floor)
                    for item in constituents:
                        dbmod.upsert_universe(conn, item["symbol"], item["name"], item["country"], item["sector"])
                    conn.commit()
                    print(f"  {c} : {len(constituents)} titres (région Yahoo '{REGION_MAP[c]}')")
                except Exception as e:
                    print(f"  ⚠ échec pour {c} : {e}")
        else:
            print("— Univers non rafraîchi (--skip-universe)")

        all_symbols = [row["symbol"] for row in dbmod.get_universe(conn, countries)]
        print(f"— Univers total en base pour ces pays : {len(all_symbols)} titres")

        # 2) Détermine ce qui doit être (re)fetché
        stale = dbmod.get_stale_symbols(conn, all_symbols, args.max_age_days)
        if args.limit:
            stale = stale[: args.limit]
        print(f"— {len(stale)} titres à (re)fetcher (max_age_days={args.max_age_days})")

        # 3) Fetch fondamentaux, un titre à la fois, avec pause polie
        errors = 0
        for symbol in tqdm(stale, desc="Fondamentaux", unit="titre"):
            data, err = fetch.fetch_symbol(symbol)
            dbmod.upsert_fundamentals(conn, symbol, data, error=err)
            if err:
                errors += 1
            conn.commit()
            time.sleep(random.uniform(REQUEST_DELAY_MIN, REQUEST_DELAY_MAX))

        print(f"— Terminé : {len(stale) - errors} succès, {errors} échecs")

        # 4) Export du snapshot JSON pour le site
        n, skipped, path = exportmod.export_snapshot(conn)
        print(f"— Snapshot écrit : {path} ({n} titres exploitables, {skipped} ignorés car sans données)")


if __name__ == "__main__":
    sys.exit(main())
