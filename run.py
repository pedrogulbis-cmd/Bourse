#!/usr/bin/env python3
"""
Orchestrateur du scraper Trending Value — API TradingView Screener.

Architecture simplifiée par rapport aux versions précédentes : un seul
appel par pays donne à la fois l'univers ET les fondamentaux (plus besoin
de boucle titre par titre avec pause polie — l'API TradingView renvoie tout
en une requête). Beaucoup plus rapide qu'avant.

Usage :
    python run.py                              # tous les pays
    python run.py --countries US,FR,DE         # seulement ces pays
    python run.py --mcap-floor 200000000       # univers "All Stocks" du livre
    python run.py --limit 20                   # test rapide sur 20 titres max par pays
    python run.py --debug                      # affiche un échantillon brut par pays (utile pour vérifier les noms de champs)
    python run.py --export-only                # régénère juste data-snapshot.json depuis la base
    python run.py --dedupe-only                # dédoublonne la base existante, sans refetcher

À la fin, écrit data-snapshot.json (voir SNAPSHOT_PATH dans config.py).
"""
import argparse
import sys

import db as dbmod
import universe
import export as exportmod
from config import TV_MARKETS, DB_PATH, DEFAULT_MCAP_FLOOR

ALL_COUNTRIES = list(TV_MARKETS.keys())


def main():
    ap = argparse.ArgumentParser(description="Scraper Trending Value (TradingView) — met à jour data-snapshot.json")
    ap.add_argument("--countries", type=str, default=None,
                     help="Codes pays séparés par des virgules (ex. US,FR,DE). Par défaut : tous.")
    ap.add_argument("--mcap-floor", type=int, default=DEFAULT_MCAP_FLOOR,
                     help=f"Capitalisation minimum en $ (défaut {DEFAULT_MCAP_FLOOR:,}).")
    ap.add_argument("--limit", type=int, default=None, help="Limite le nombre de titres par pays (pour tester).")
    ap.add_argument("--debug", action="store_true", help="Affiche un échantillon brut des données reçues par pays.")
    ap.add_argument("--export-only", action="store_true",
                     help="Ne fait aucun appel réseau : régénère juste data-snapshot.json à partir de ce qui est déjà dans la base.")
    ap.add_argument("--dedupe-only", action="store_true",
                     help="Supprime les doublons de cotations dans la base existante, puis réexporte le snapshot — sans rien refetcher.")
    ap.add_argument("--no-etfs", action="store_true",
                     help="Ne récupère PAS les ETF (récupérés par défaut, marqués asset_type='etf', exclus du calcul des stratégies côté site mais consultables en recherche/portefeuille).")
    ap.add_argument("--db", type=str, default=DB_PATH)
    args = ap.parse_args()

    if args.export_only:
        with dbmod.connect(args.db) as conn:
            n, skipped, path = exportmod.export_snapshot(conn)
            print(f"— Snapshot régénéré à partir de la base existante : {path} ({n} titres exploitables, {skipped} ignorés car sans données)")
        return

    if args.dedupe_only:
        with dbmod.connect(args.db) as conn:
            removed = dbmod.dedupe_universe_by_name(conn)
            conn.commit()
            print(f"— Déduplication par nom d'entreprise : {removed} cotations doublons retirées")
            n, skipped, path = exportmod.export_snapshot(conn)
            print(f"— Snapshot régénéré : {path} ({n} titres exploitables, {skipped} ignorés car sans données)")
        return

    countries = [c.strip().upper() for c in args.countries.split(",")] if args.countries else ALL_COUNTRIES
    unknown = [c for c in countries if c not in ALL_COUNTRIES]
    if unknown:
        print(f"Pays inconnus ignorés : {unknown} (disponibles : {ALL_COUNTRIES})")
        countries = [c for c in countries if c in ALL_COUNTRIES]

    with dbmod.connect(args.db) as conn:
        print(f"— Récupération univers + fondamentaux (TradingView) pour {countries}…")
        total_ok = 0
        euronext_targets = [c for c in countries if c in universe.EURONEXT_COUNTRIES]
        other_targets = [c for c in countries if c not in universe.EURONEXT_COUNTRIES]

        if euronext_targets:
            try:
                for c in euronext_targets:
                    dbmod.clear_universe_for_country(conn, c)
                buckets = universe.fetch_euronext_bucket(args.mcap_floor, debug=args.debug, countries=euronext_targets)
                etf_buckets = {}
                if not args.no_etfs:
                    try:
                        etf_buckets = universe.fetch_euronext_bucket(args.mcap_floor, debug=args.debug, countries=euronext_targets, is_etf=True)
                    except Exception as e:
                        print(f"  ⚠ échec ETF groupe Euronext : {e}")
                for c in euronext_targets:
                    records = buckets.get(c, []) + etf_buckets.get(c, [])
                    if args.limit:
                        records = records[: args.limit]
                    for r in records:
                        dbmod.upsert_universe(conn, r["symbol"], r["name"], r["country"], r["sector"], r.get("mcap"), r.get("isin"), r.get("home_country"), r.get("asset_type", "stock"))
                        dbmod.upsert_fundamentals(conn, r["symbol"], r, error=None)
                    total_ok += len(records)
                    n_etf = sum(1 for r in records if r.get("asset_type") == "etf")
                    print(f"  {c} : {len(records)} titres (groupe Euronext, classés par domicile réel)" + (f" (dont {n_etf} ETF)" if n_etf else ""))
                conn.commit()
            except Exception as e:
                print(f"  ⚠ échec groupe Euronext ({', '.join(euronext_targets)}) : {e}")

        for c in other_targets:
            try:
                dbmod.clear_universe_for_country(conn, c)
                records = universe.fetch_country_stocks(c, args.mcap_floor, debug=args.debug)
                if not args.no_etfs:
                    try:
                        records += universe.fetch_country_etfs(c, args.mcap_floor, debug=args.debug)
                    except Exception as e:
                        print(f"  ⚠ échec ETF pour {c} : {e}")
                if args.limit:
                    records = records[: args.limit]
                for r in records:
                    dbmod.upsert_universe(conn, r["symbol"], r["name"], r["country"], r["sector"], r.get("mcap"), r.get("isin"), r.get("home_country"), r.get("asset_type", "stock"))
                    dbmod.upsert_fundamentals(conn, r["symbol"], r, error=None)
                conn.commit()
                total_ok += len(records)
                n_etf = sum(1 for r in records if r.get("asset_type") == "etf")
                print(f"  {c} : {len(records)} titres" + (f" (dont {n_etf} ETF)" if n_etf else ""))
            except Exception as e:
                print(f"  ⚠ échec pour {c} : {e}")

        # Pas de déduplication automatique par nom ici : on garde volontairement
        # toutes les cotations d'une même entreprise (ex. Euronext Paris ET ADR
        # NYSE de TotalEnergies) plutôt que d'en supprimer une au hasard — le
        # pays de domicile réel est affiché sur chaque titre pour s'y retrouver.
        # Reste disponible manuellement si besoin : python run.py --dedupe-only

        print(f"— Terminé : {total_ok} titres récupérés au total")

        n, skipped, path = exportmod.export_snapshot(conn)
        print(f"— Snapshot écrit : {path} ({n} titres exploitables, {skipped} ignorés car sans données)")


if __name__ == "__main__":
    sys.exit(main())
