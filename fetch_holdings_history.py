#!/usr/bin/env python3
"""
Récupère l'historique réel de prix de chaque action de ton portefeuille,
depuis leur date d'achat jusqu'à aujourd'hui — via tvDatafeed, la même
librairie que pour les indices (scanner Yahoo classique ne fait pas
d'historique). Permet une VRAIE courbe rétroactive de la valeur du
portefeuille, pas seulement un suivi qui démarre à partir d'aujourd'hui.

Ce script n'a PAS d'accès direct à ton portefeuille : il vit dans ton
navigateur (localStorage), pas sur ton PC. Il faut d'abord l'exporter :

    1. Sur la page Portefeuille du site, clique "↓ Exporter mes données"
    2. Place le fichier téléchargé dans ce dossier (scraper/)
    3. Lance : python fetch_holdings_history.py --input export.json --suffix TONPRENOM

PLUSIEURS UTILISATEURS DU MÊME SITE : le paramètre --suffix évite que
deux personnes partageant le même dépôt GitHub Pages n'écrasent le
fichier l'une de l'autre. Avec --suffix popo, ce script écrit
holdings-history-popo.json (au lieu de holdings-history.json), et
l'enregistre dans un petit annuaire partagé (holdings-history-index.json)
que le site consulte pour proposer automatiquement "popo" comme choix,
sans que personne n'ait à taper le nom à la main.

Usage :
    python fetch_holdings_history.py --input mon-export.json --suffix popo
    python fetch_holdings_history.py --input mon-export.json --suffix popo --bars 1500
    python fetch_holdings_history.py --input mon-export.json   (sans --suffix : usage solo, comme avant)
"""
import argparse
import json
import os
from datetime import datetime, timezone

from tvDatafeed import TvDatafeed, Interval

INDEX_PATH = "holdings-history-index.json"


def fetch_one(tv, symbol, n_bars):
    df = tv.get_hist(symbol=symbol, interval=Interval.in_daily, n_bars=n_bars)
    if df is None or df.empty:
        raise ValueError("aucune donnée retournée (symbole probablement incorrect ou retiré de la cote)")
    return [
        {"date": idx.strftime("%Y-%m-%d"), "close": float(row["close"])}
        for idx, row in df.iterrows()
    ]


def update_index(suffix, index_path=INDEX_PATH):
    """Ajoute ce suffixe à l'annuaire partagé, SANS écraser les entrées
    déjà déposées par d'autres utilisateurs — lit l'existant d'abord."""
    suffixes = []
    if os.path.exists(index_path):
        try:
            with open(index_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
            if isinstance(existing.get("suffixes"), list):
                suffixes = existing["suffixes"]
        except Exception:
            pass  # annuaire corrompu ou illisible -> repart propre, tant pis pour l'historique de l'annuaire lui-même
    if suffix not in suffixes:
        suffixes.append(suffix)
    suffixes.sort()
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "suffixes": suffixes,
        }, f, separators=(",", ":"))
    print(f"— Annuaire mis à jour ({index_path}) : {', '.join(suffixes)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=str, required=True, help="Fichier JSON exporté depuis la page Portefeuille.")
    ap.add_argument("--bars", type=int, default=1500, help="Nombre de barres quotidiennes par titre (max 5000, ~6 ans).")
    ap.add_argument("--suffix", type=str, default=None,
                     help="Identifiant personnel (ex. ton prénom) si plusieurs personnes partagent ce site — voir docstring en haut du fichier.")
    ap.add_argument("--out", type=str, default=None, help="Nom de fichier explicite (remplace le calcul automatique à partir de --suffix).")
    args = ap.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Le format d'export a changé avec l'arrivée des portefeuilles multiples :
    # les positions sont maintenant nichées dans data["portfolios"][i]["holdings"]
    # plutôt qu'à la racine. On gère les deux formats pour rester compatible
    # avec d'anciens exports.
    if isinstance(data.get("portfolios"), list):
        holdings = [h for p in data["portfolios"] for h in p.get("holdings", [])]
    else:
        holdings = data.get("holdings", [])

    if not holdings:
        print("Aucune position trouvée dans le fichier exporté.")
        return

    symbols = sorted({h["symbol"] for h in holdings if h.get("symbol")})
    print(f"— {len(symbols)} titre(s) unique(s) à récupérer : {', '.join(symbols)}")

    tv = TvDatafeed()
    out = {}
    for symbol in symbols:
        try:
            points = fetch_one(tv, symbol, args.bars)
            out[symbol] = points
            print(f"  {symbol} : {len(points)} points, du {points[0]['date']} au {points[-1]['date']}")
        except Exception as e:
            print(f"  ⚠ échec {symbol} : {e}")

    if not out:
        print("Rien récupéré — rien écrit.")
        return

    if args.out:
        out_filename = args.out
    elif args.suffix:
        out_filename = f"holdings-history-{args.suffix}.json"
    else:
        out_filename = "holdings-history.json"

    snapshot = {"generatedAt": datetime.now(timezone.utc).isoformat(), "prices": out}
    with open(out_filename, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, separators=(",", ":"))
    print(f"— Écrit : {out_filename}")

    if args.suffix:
        update_index(args.suffix)


if __name__ == "__main__":
    main()
