"""
Récupère l'univers ET les fondamentaux en UNE SEULE requête par pays, via
l'API TradingView Screener (scanner.tradingview.com), grâce au package
tradingview-screener. Remplace l'ancienne architecture en deux temps
(Wikipedia/Yahoo pour l'univers, puis un appel par titre pour les
fondamentaux) — beaucoup plus rapide et beaucoup plus propre : le filtre
"is_primary" intégré à la librairie exclut nativement les cross-listings.
"""
from tradingview_screener import Query, col

from config import TV_MARKETS, TV_COUNTRY_NAMES, MAX_UNIVERSE_PER_COUNTRY

# Champs demandés à TradingView, dans l'ordre où ils reviennent dans les
# lignes de résultat (le premier "ticker"/"name" est toujours en tête,
# ajouté automatiquement par la librairie).
FIELDS = [
    "description",                              # nom complet de l'entreprise ("name" ne renvoie que le ticker court)
    "isin",                                     # code ISIN — NOM DE CHAMP NON CONFIRMÉ, à vérifier au premier run avec --debug
    "close",                                   # prix
    "market_cap_basic",                        # capitalisation
    "sector",
    "country",
    "price_earnings_ttm",                      # P/E
    "price_book_fq",                           # P/B
    "price_sales_current",                     # P/S — NOM DE CHAMP NON CONFIRMÉ, à vérifier au premier run
    "enterprise_value_ebitda_ttm",              # EV/EBITDA (inversé -> EBITDA/EV)
    "dividend_yield_recent",                    # rendement du dividende
    "buyback_yield",                            # rendement des rachats d'actions — NOM NON CONFIRMÉ, à vérifier au premier run
    "Perf.3M",                                  # momentum 3 mois
    "Perf.6M",                                  # momentum 6 mois
    "earnings_per_share_diluted_yoy_growth_fy",  # croissance BPA
    "return_on_equity_fq",                      # ROE — NOM DE CHAMP NON CONFIRMÉ, à vérifier au premier run
    "operating_margin",                         # marge d'exploitation (TTM) — confirmé
    "total_revenue_yoy_growth_fy",               # croissance du CA sur 12 mois — NOM NON CONFIRMÉ, à vérifier au premier run
    "average_volume_30d_calc",                  # volume moyen 30 jours — sert à calculer la liquidité (volume × prix)
    "recommendation_mark",                      # note des analystes (FactSet, -1 à 1) — NOM DE CHAMP NON CONFIRMÉ, à vérifier au premier run
]


def fetch_country_stocks(country_code, mcap_floor, max_results=MAX_UNIVERSE_PER_COUNTRY, debug=False):
    """Interroge TradingView pour TOUS les titres d'un pays (cotation
    primaire uniquement) dont la capitalisation dépasse `mcap_floor`.
    Retourne une liste de dicts prêts à insérer en base — à la fois
    l'univers ET les fondamentaux en un seul passage."""
    market = TV_MARKETS.get(country_code)
    if not market:
        raise ValueError(f"Pas de marché TradingView configuré pour {country_code}")

    query = (
        Query()
        .select(*FIELDS)
        .set_markets(market)
        .where(col("market_cap_basic") >= mcap_floor)
        .limit(max_results)
        .order_by("market_cap_basic", ascending=False)
    )

    total, df = query.get_scanner_data()

    if debug:
        print(f"  [TradingView] {country_code} : {total} titres trouvés au total, colonnes -> {list(df.columns)}")
        print(f"  [TradingView] échantillon :\n{df.head(3).to_string()}")

    out = []
    for _, row in df.iterrows():
        symbol = row.get("ticker")
        if not symbol:
            continue
        # Sécurité supplémentaire : vérifie que le pays déclaré correspond
        # bien à celui attendu (le filtre 'market' devrait déjà suffire,
        # mais mieux vaut être sûr — coûte rien de vérifier).
        expected_country = TV_COUNTRY_NAMES.get(country_code)
        actual_country = row.get("country")
        if expected_country and actual_country and actual_country != expected_country:
            continue

        ev_ebitda = row.get("enterprise_value_ebitda_ttm")
        ebitda_yield = (1.0 / ev_ebitda) if ev_ebitda and ev_ebitda > 0 else None

        div_yield = row.get("dividend_yield_recent")
        div_yield = (div_yield / 100.0) if div_yield is not None else None  # TradingView renvoie des %, notre schéma attend une fraction

        buyback_yield = row.get("buyback_yield")
        buyback_yield = (buyback_yield / 100.0) if buyback_yield is not None else None

        shareholder_yield = None
        if div_yield is not None or buyback_yield is not None:
            shareholder_yield = (div_yield or 0) + (buyback_yield or 0)

        eps_growth = row.get("earnings_per_share_diluted_yoy_growth_fy")
        eps_growth = (eps_growth / 100.0) if eps_growth is not None else None

        roe = row.get("return_on_equity_fq")
        roe = (roe / 100.0) if roe is not None else None

        op_margin = row.get("operating_margin")
        op_margin = (op_margin / 100.0) if op_margin is not None else None

        revenue_growth = row.get("total_revenue_yoy_growth_fy")
        revenue_growth = (revenue_growth / 100.0) if revenue_growth is not None else None

        avg_volume = row.get("average_volume_30d_calc")
        price = row.get("close")
        avg_daily_value = (avg_volume * price) if (avg_volume is not None and price is not None) else None

        analyst_rating = row.get("recommendation_mark")  # -1 (Strong Sell) à 1 (Strong Buy)
        analyst_label = None
        if analyst_rating is not None:
            if analyst_rating >= 0.5: analyst_label = "Strong Buy"
            elif analyst_rating >= 0.1: analyst_label = "Buy"
            elif analyst_rating > -0.1: analyst_label = "Neutral"
            elif analyst_rating > -0.5: analyst_label = "Sell"
            else: analyst_label = "Strong Sell"

        out.append({
            "symbol": symbol,
            "name": row.get("description") or row.get("name") or symbol,
            "isin": row.get("isin") or None,
            "sector": row.get("sector") or "—",
            "country": country_code,
            "price": row.get("close"),
            "mcap": row.get("market_cap_basic"),
            "pe": row.get("price_earnings_ttm"),
            "pb": row.get("price_book_fq"),
            "ps": row.get("price_sales_current"),
            "pcf": None,  # pas de champ P/CF confirmé côté TradingView pour l'instant
            "ebitda_yield": ebitda_yield,
            "div_yield": div_yield,
            "buyback_yield": buyback_yield,
            "shareholder_yield": shareholder_yield,
            "mom3": row.get("Perf.3M"),
            "mom6": row.get("Perf.6M"),
            "eps_growth": eps_growth,
            "roe": roe,
            "op_margin": op_margin,
            "revenue_growth": revenue_growth,
            "avg_daily_value": avg_daily_value,
            "analyst_rating": analyst_rating,
            "analyst_label": analyst_label,
        })

    return out
