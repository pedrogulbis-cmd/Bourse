"""
Récupère l'univers ET les fondamentaux en UNE SEULE requête par pays, via
l'API TradingView Screener (scanner.tradingview.com), grâce au package
tradingview-screener. Remplace l'ancienne architecture en deux temps
(Wikipedia/Yahoo pour l'univers, puis un appel par titre pour les
fondamentaux) — beaucoup plus rapide et beaucoup plus propre : le filtre
"is_primary" intégré à la librairie exclut nativement les cross-listings.
"""
from tradingview_screener import Query, col, And
from tradingview_screener.column import Column

from config import TV_MARKETS, TV_COUNTRY_NAMES, MAX_UNIVERSE_PER_COUNTRY

# Pays dont la bourse principale est un segment national d'Euronext. Une
# société peut être domiciliée dans l'un de ces pays mais cotée sur le
# segment d'un AUTRE (ex. X-FAB : domiciliée en Belgique, cotée à Paris).
# Interroger chaque marché séparément puis filtrer par pays la fait passer
# entre les mailles : ni dans "belgium" (pas cotée là), ni gardée dans
# "france" (le filtre pays la rejette). Solution : interroger TOUS les
# segments Euronext ensemble, puis classer chaque résultat par son pays
# RÉEL plutôt que par le marché où on l'a trouvée.
EURONEXT_COUNTRIES = {"FR", "BE", "NL", "PT", "IE", "IT", "LU"}

# Préfixes de tickers correspondant à des plateformes de cotation "miroir"
# (MTF) qui dupliquent une cotation principale sans apporter d'information
# nouvelle — juste moins liquides, avec un prix légèrement différent dû à
# l'écart bid/ask. EUROTLX (plateforme italienne pour investisseurs
# particuliers achetant des actions étrangères) en est l'exemple type :
# TotalEnergies y apparaît sous "EUROTLX:4TTE" en plus de sa vraie cotation
# "EURONEXT:TTE" — même ISIN, même pays, aucune valeur ajoutée à garder les
# deux. Contrairement aux ADR (marché différent, souvent devise différente,
# vraie alternative d'investissement), ce sont de purs doublons à écarter.
EXCLUDED_EXCHANGE_PREFIXES = ("EUROTLX:",)

# Nom TradingView du pays -> notre code pays, pour retrouver un code à partir
# du champ `country` brut quand on veut afficher le domicile réel d'un titre.
NAME_TO_COUNTRY_CODE = {v: k for k, v in TV_COUNTRY_NAMES.items()}

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
    "currency",                                 # devise RÉELLE de cotation du prix — NOM NON CONFIRMÉ, à vérifier au premier run. Essentiel pour les actions britanniques cotées en pence (GBX) plutôt qu'en livres (GBP) : sans ce champ, on suppose GBP pour tout titre GB, ce qui fausse la valorisation d'un facteur ~100 pour les titres en GBX.
]


def _row_to_record(row, country_code):
    """Convertit une ligne de résultat TradingView en dict prêt pour la base.
    `country_code` est le code pays à ENREGISTRER (peut différer du marché
    interrogé — voir fetch_euronext_bucket)."""
    ev_ebitda = row.get("enterprise_value_ebitda_ttm")
    ebitda_yield = (1.0 / ev_ebitda) if ev_ebitda and ev_ebitda > 0 else None

    div_yield = row.get("dividend_yield_recent")
    div_yield = (div_yield / 100.0) if div_yield is not None else None

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

    analyst_rating = row.get("recommendation_mark")  # échelle 1 (Strong Buy) à 5 (Strong Sell)
    analyst_label = None
    if analyst_rating is not None:
        if analyst_rating <= 1.5: analyst_label = "Strong Buy"
        elif analyst_rating <= 2.5: analyst_label = "Buy"
        elif analyst_rating <= 3.5: analyst_label = "Neutral"
        elif analyst_rating <= 4.5: analyst_label = "Sell"
        else: analyst_label = "Strong Sell"

    return {
        "symbol": row.get("ticker"),
        "name": row.get("description") or row.get("name") or row.get("ticker"),
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
        "home_country": row.get("country") or None,  # nom brut TradingView, ex. "Bermuda" — pour affichage uniquement
        "home_country_code": NAME_TO_COUNTRY_CODE.get(row.get("country")),  # None si pays hors de notre liste (ex. Bermudes)
        "listed_currency": row.get("currency") or None,  # devise RÉELLE du prix affiché (ex. "GBX" pour du GB coté en pence) — prioritaire sur la devise déduite du pays côté site
        "asset_type": "stock",  # écrasé en "etf" par fetch_country_etfs()
    }


def fetch_country_stocks(country_code, mcap_floor, max_results=MAX_UNIVERSE_PER_COUNTRY, debug=False):
    """Interroge TradingView pour TOUS les titres d'un pays (cotation
    primaire uniquement) dont la capitalisation dépasse `mcap_floor`.
    Retourne une liste de dicts prêts à insérer en base — à la fois
    l'univers ET les fondamentaux en un seul passage.

    ATTENTION : pour les pays Euronext (voir EURONEXT_COUNTRIES), cette
    fonction peut manquer des sociétés domiciliées dans ce pays mais
    cotées sur le segment Euronext d'un AUTRE pays (ex. X-FAB, domiciliée
    en Belgique, cotée à Paris). Utiliser fetch_euronext_bucket() pour
    ces pays-là plutôt que cette fonction."""
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
        ticker = row.get("ticker")
        if not ticker or ticker.startswith(EXCLUDED_EXCHANGE_PREFIXES):
            continue
        # Plus aucune exclusion par pays ici (contrairement aux versions
        # précédentes, qui créaient un jeu d'équilibriste sans fin entre
        # ADR de blue chips et holdings de transport maritime). On garde
        # TOUT ce que renvoie TradingView pour ce marché (is_primary suffit
        # à écarter le bruit) — le pays de domiciliation réel est capturé à
        # part (home_country) pour affichage, sans influencer le classement.
        out.append(_row_to_record(row, country_code))

    return out


def fetch_country_etfs(country_code, mcap_floor, max_results=MAX_UNIVERSE_PER_COUNTRY, debug=False):
    """Récupère les ETF (pas les actions) pour un marché donné — même
    mécanisme que fetch_country_stocks, mais avec le filtre TradingView
    INVERSÉ : la librairie exclut les ETF par défaut (voir sa docstring :
    "stocks... and non-ETF funds"), donc on reconstruit explicitement le
    filtre pour ne garder QUE type=fund + typespecs contient 'etf'.

    Marqués asset_type='etf' dans le dict retourné, pour que le site les
    garde consultables (recherche, portefeuille) mais les EXCLUE du calcul
    des stratégies du screener — un ETF n'a pas de P/E, ROE etc. au sens
    où une action en a, donc le noter avec ces critères n'a pas de sens.
    La plupart des champs fondamentaux (P/E, P/B, ROE, marge...) reviendront
    vides pour un ETF, c'est normal, pas un bug."""
    market = TV_MARKETS.get(country_code)
    if not market:
        raise ValueError(f"Pas de marché TradingView configuré pour {country_code}")

    query = (
        Query()
        .select(*FIELDS)
        .set_markets(market)
        .where2(And(
            Column("type") == "fund",
            Column("typespecs").has(["etf"]),
            Column("market_cap_basic") >= mcap_floor,
        ))
        .limit(max_results)
        .order_by("market_cap_basic", ascending=False)
    )

    total, df = query.get_scanner_data()

    if debug:
        print(f"  [TradingView] {country_code} (ETF) : {total} trouvés, colonnes -> {list(df.columns)}")
        print(f"  [TradingView] échantillon :\n{df.head(3).to_string()}")

    out = []
    for _, row in df.iterrows():
        ticker = row.get("ticker")
        if not ticker or ticker.startswith(EXCLUDED_EXCHANGE_PREFIXES):
            continue
        rec = _row_to_record(row, country_code)
        rec["asset_type"] = "etf"
        out.append(rec)

    return out


def fetch_euronext_bucket(mcap_floor, max_results=MAX_UNIVERSE_PER_COUNTRY, debug=False, countries=None, is_etf=False):
    """Interroge TOUS les segments Euronext (France, Belgique, Pays-Bas,
    Portugal, Irlande, Italie, Luxembourg) EN UNE SEULE requête groupée, puis
    classe chaque résultat par son pays de domiciliation RÉEL (champ
    `country`), pas par le segment où il est coté. Corrige les cas comme
    X-FAB (domiciliée en Belgique, cotée à Paris) qui passent entre les
    mailles d'une requête par pays isolée.

    is_etf=True récupère les ETF de ce même groupe de marchés au lieu des
    actions (même logique de classement par domicile réel — beaucoup d'ETF
    domiciliés en Irlande/Luxembourg sont cotés sur plusieurs segments
    Euronext à la fois).

    Retourne un dict {code_pays: [dicts prêts pour la base]}."""
    target_countries = countries or EURONEXT_COUNTRIES
    markets = [TV_MARKETS[c] for c in target_countries if c in TV_MARKETS]

    query = (
        Query()
        .select(*FIELDS)
        .set_markets(*markets)
        .limit(max_results * len(markets))
        .order_by("market_cap_basic", ascending=False)
    )
    if is_etf:
        query = query.where2(And(
            Column("type") == "fund",
            Column("typespecs").has(["etf"]),
            Column("market_cap_basic") >= mcap_floor,
        ))
    else:
        query = query.where(col("market_cap_basic") >= mcap_floor)

    total, df = query.get_scanner_data()

    if debug:
        kind = "ETF" if is_etf else "actions"
        print(f"  [TradingView] Euronext groupé {kind} ({', '.join(markets)}) : {total} titres trouvés au total")
        print(f"  [TradingView] échantillon :\n{df.head(5).to_string()}")

    # reverse-lookup : nom TradingView du pays -> notre code pays
    name_to_code = {v: k for k, v in TV_COUNTRY_NAMES.items() if k in target_countries}

    buckets = {c: [] for c in target_countries}
    unmatched = 0
    for _, row in df.iterrows():
        ticker = row.get("ticker")
        if not ticker or ticker.startswith(EXCLUDED_EXCHANGE_PREFIXES):
            continue
        actual_country_name = row.get("country")
        code = name_to_code.get(actual_country_name)
        if not code:
            unmatched += 1
            continue  # domicilié hors de notre liste Euronext ciblée (ex. société US cotée à Paris) — ignoré ici
        rec = _row_to_record(row, code)
        if is_etf:
            rec["asset_type"] = "etf"
        buckets[code].append(rec)

    if debug and unmatched:
        print(f"  [TradingView] {unmatched} titres Euronext ignorés (domiciliés hors des pays ciblés)")

    return buckets
