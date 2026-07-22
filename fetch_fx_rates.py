#!/usr/bin/env python3
"""
Récupère les taux de change actuels de chaque devise présente dans
l'univers vers l'euro (base de ton portefeuille), via tvDatafeed —
même mécanisme que pour les indices et l'historique des positions.

Écrit fx-rates.json à la racine du site : {"USD": 0.92, "GBP": 1.17, ...}
— multiplier un montant dans cette devise par ce taux donne son
équivalent en euros.

À relancer à chaque run principal (les taux bougent au jour le jour),
donc idéalement dans la même routine hebdomadaire que `run.py`.

Usage :
    python fetch_fx_rates.py
    python fetch_fx_rates.py --currency USD   (test rapide sur une seule devise)
"""
import argparse
import json
from datetime import datetime, timezone

from tvDatafeed import TvDatafeed, Interval

from config import COUNTRY_CURRENCY

# Devises à récupérer (toutes celles utilisées dans l'univers, sauf EUR
# elle-même qui vaut 1 par définition).
CURRENCIES = sorted({c for c in COUNTRY_CURRENCY.values() if c != "EUR"})


def fetch_rate_to_eur(tv, currency):
    """Essaie CCYEUR d'abord (taux direct), puis EURCCY inversé si le
    premier échoue — les deux conventions existent selon la paire."""
    try:
        df = tv.get_hist(symbol=f"FX_IDC:{currency}EUR", interval=Interval.in_daily, n_bars=1)
        if df is not None and not df.empty:
            return float(df.iloc[-1]["close"]), f"FX_IDC:{currency}EUR (direct)"
    except Exception:
        pass
    try:
        df = tv.get_hist(symbol=f"FX_IDC:EUR{currency}", interval=Interval.in_daily, n_bars=1)
        if df is not None and not df.empty:
            rate = float(df.iloc[-1]["close"])
            if rate > 0:
                return 1.0 / rate, f"FX_IDC:EUR{currency} (inversé)"
    except Exception:
        pass
    raise ValueError(f"aucune des deux conventions de symbole n'a fonctionné pour {currency}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--currency", type=str, default=None, help="Ne récupérer qu'une seule devise, pour tester (ex. USD).")
    ap.add_argument("--out", type=str, default="fx-rates.json")
    args = ap.parse_args()

    targets = [args.currency] if args.currency else CURRENCIES

    tv = TvDatafeed()
    rates = {"EUR": 1.0}
    for ccy in targets:
        try:
            rate, source = fetch_rate_to_eur(tv, ccy)
            rates[ccy] = rate
            print(f"  {ccy} -> EUR : {rate:.4f}  (source : {source})")
        except Exception as e:
            print(f"  ⚠ échec {ccy} : {e}")

    if len(rates) <= 1:
        print("Rien récupéré — rien écrit.")
        return

    snapshot = {"generatedAt": datetime.now(timezone.utc).isoformat(), "base": "EUR", "rates": rates}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, separators=(",", ":"))
    print(f"— Écrit : {args.out}")


if __name__ == "__main__":
    main()
