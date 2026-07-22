#!/usr/bin/env python3
"""
Récupère l'historique quotidien de quelques indices de référence via
tvDatafeed (accès direct au flux de données de graphique TradingView,
pas de scraping HTML, pas de connexion requise). Contrairement au
screener utilisé pour les actions, cette librairie donne un VRAI
historique — jusqu'à 5000 barres, soit ~20 ans en quotidien.

Écrit index-history.json à la racine du site, à committer sur GitHub
comme data-snapshot.json. Pas besoin de le relancer à chaque run du
scraper principal — l'historique d'indice n'a pas besoin d'être
rafraîchi quotidiennement (une fois par semaine ou par mois suffit).

Usage :
    python fetch_index_history.py                  # tous les indices, 1500 barres (~6 ans)
    python fetch_index_history.py --bars 5000       # maximum (~20 ans)
    python fetch_index_history.py --index FR        # un seul indice, pour tester
"""
import argparse
import json
from datetime import datetime, timezone

from tvDatafeed import TvDatafeed, Interval

# Symbole TradingView par zone. "FR" sert de proxy pour la France, "EU" pour
# l'Europe, etc. NON CONFIRMÉS EN CONDITIONS RÉELLES — à vérifier avec
# --index FR --bars 30 avant de lancer le run complet.
INDEX_SYMBOLS = {
    "FR": "EURONEXT:PX1",      # CAC 40
    "EU": "TVC:SXXP",          # STOXX Europe 600
    "US": "SP:SPX",            # S&P 500 — si échec, essayer "TVC:SPX"
    "WORLD": "STOXX:SXW1E",    # STOXX Global 1800 (proxy "monde", pas un vrai indice MSCI World gratuit trouvé)
}


def fetch_one(tv, key, symbol, n_bars):
    df = tv.get_hist(symbol=symbol, interval=Interval.in_daily, n_bars=n_bars)
    if df is None or df.empty:
        raise ValueError("aucune donnée retournée (symbole probablement incorrect)")
    points = [
        {"date": idx.strftime("%Y-%m-%d"), "close": float(row["close"])}
        for idx, row in df.iterrows()
    ]
    return points


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bars", type=int, default=1500, help="Nombre de barres quotidiennes (max 5000).")
    ap.add_argument("--index", type=str, default=None, help="Ne récupérer qu'un seul indice (FR, EU, US, WORLD), pour tester.")
    ap.add_argument("--out", type=str, default="index-history.json")
    args = ap.parse_args()

    targets = {args.index: INDEX_SYMBOLS[args.index]} if args.index else INDEX_SYMBOLS

    tv = TvDatafeed()
    out = {}
    for key, symbol in targets.items():
        try:
            points = fetch_one(tv, key, symbol, args.bars)
            out[key] = points
            print(f"  {key} ({symbol}) : {len(points)} points, du {points[0]['date']} au {points[-1]['date']}")
        except Exception as e:
            print(f"  ⚠ échec {key} ({symbol}) : {e}")

    if not out:
        print("Aucun indice récupéré avec succès — rien écrit.")
        return

    snapshot = {"generatedAt": datetime.now(timezone.utc).isoformat(), "indices": out}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, separators=(",", ":"))
    print(f"— Écrit : {args.out}")


if __name__ == "__main__":
    main()
