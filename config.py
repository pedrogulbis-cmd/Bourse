"""
Configuration du scraper — API TradingView Screener (remplace Yahoo Finance
et Wikipedia). Une seule requête par pays donne à la fois l'univers ET les
fondamentaux (P/E, P/B, momentum, rendement...), contrairement à l'ancienne
architecture en deux temps. Le filtre "is_primary" intégré à la librairie
exclut nativement les cotations secondaires/cross-listings — le problème
qui nous a occupés pendant tout le reste de ce projet.
"""

# code pays (utilisé partout ailleurs dans l'appli) -> slug de "market"
# TradingView (paramètre d'URL scanner.tradingview.com/{market}/scan).
# Confirmé pour 'america' (US), 'italy', 'germany' via la doc officielle du
# package tradingview-screener. Les autres suivent la même convention
# (nom de pays anglais, minuscule) mais n'ont PAS été testés en conditions
# réelles — un échec isolé n'empêche pas les autres pays de fonctionner.
TV_MARKETS = {
    "US": "america",
    "CA": "canada",
    "FR": "france",
    "DE": "germany",
    "GB": "uk",
    "NL": "netherlands",
    "CH": "switzerland",
    "ES": "spain",
    "IT": "italy",
    "BE": "belgium",
    "SE": "sweden",
    "DK": "denmark",
    "NO": "norway",
    "FI": "finland",
    "PT": "portugal",
    "AT": "austria",
    "IE": "ireland",
    "PL": "poland",
    "JP": "japan",
    "AU": "australia",
    "HK": "hongkong",
    "SG": "singapore",
    "KR": "korea",
}

# code pays -> valeur exacte du champ "country" TradingView (confirmé via
# la documentation officielle des champs, liste de 117 pays disponibles).
# Utilisé comme double vérification en plus du filtre de "market".
TV_COUNTRY_NAMES = {
    "US": "United States",
    "CA": "Canada",
    "FR": "France",
    "DE": "Germany",
    "GB": "United Kingdom",
    "NL": "Netherlands",
    "CH": "Switzerland",
    "ES": "Spain",
    "IT": "Italy",
    "BE": "Belgium",
    "SE": "Sweden",
    "DK": "Denmark",
    "NO": "Norway",
    "FI": "Finland",
    "PT": "Portugal",
    "AT": "Austria",
    "IE": "Ireland",
    "LU": "Luxembourg",
    "PL": "Poland",
    "JP": "Japan",
    "AU": "Australia",
    "HK": "Hong Kong",
    "SG": "Singapore",
    "KR": "South Korea",
    # Pays UE/EEE qu'on ne scrape PAS activement comme marché à part (pas
    # dans TV_MARKETS), mais qu'on doit reconnaître par leur NOM pour
    # classer correctement le domicile réel d'une société qui y est basée
    # mais cotée ailleurs (ex. Motor Oil Hellas, grecque, cotée à Francfort
    # via Lang & Schwarz) — sans ça, le domicile retombe à tort sur le pays
    # de cotation, ce qui fausse notamment le filtre d'éligibilité PEA.
    "GR": "Greece",
    "HU": "Hungary",
    "CZ": "Czech Republic",
    "SK": "Slovakia",
    "SI": "Slovenia",
    "HR": "Croatia",
    "RO": "Romania",
    "BG": "Bulgaria",
    "MT": "Malta",
    "CY": "Cyprus",
    "LT": "Lithuania",
    "LV": "Latvia",
    "EE": "Estonia",
    "IS": "Iceland",
    "LI": "Liechtenstein",
}

# Capitalisation minimum par défaut si non précisée en ligne de commande.
# 0 = aucun filtre, récupère tout ce que TradingView renvoie pour un marché
# (aligné avec ce qu'on voit sur tradingview.com sans filtre de capitalisation).
# Ajuster via --mcap-floor si besoin d'un univers plus restreint.
DEFAULT_MCAP_FLOOR = 0

# Garde-fou : nombre max de titres récupérés par pays (TradingView pagine
# en interne dans get_scanner_data(), ce plafond évite un pays énorme comme
# les USA de ramener des dizaines de milliers de microcaps). Relevé à 15000
# pour couvrir l'univers complet réel (ex. ~8000 titres US, ~3900 Japon,
# ~2600 Canada observés sans filtre sur tradingview.com) avec de la marge.
MAX_UNIVERSE_PER_COUNTRY = 15000

DB_PATH = "screener.db"
SNAPSHOT_PATH = "data-snapshot.json"  # à ajuster si scraper/ est un sous-dossier du site (ex. "../data-snapshot.json")

DEFAULT_MAX_AGE_DAYS = 7  # conservé pour compatibilité, moins critique maintenant (un fetch pays = un seul appel)

# Devise de cotation par pays (approximation : chaque bourse nationale cote
# dans SA devise ; suffisant pour la conversion du portefeuille, pas
# d'exceptions connues dans notre univers actuel — une action listée sur une
# bourse donnée y est cotée dans la devise locale de cette bourse).
COUNTRY_CURRENCY = {
    "US": "USD", "CA": "CAD", "FR": "EUR", "DE": "EUR", "GB": "GBP",
    "NL": "EUR", "CH": "CHF", "ES": "EUR", "IT": "EUR", "BE": "EUR",
    "SE": "SEK", "DK": "DKK", "NO": "NOK", "FI": "EUR", "PT": "EUR",
    "AT": "EUR", "IE": "EUR", "JP": "JPY", "AU": "AUD", "HK": "HKD",
    "SG": "SGD", "KR": "KRW",
    "PL": "PLN",
}
