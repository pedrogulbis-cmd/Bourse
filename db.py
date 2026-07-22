"""
Couche SQLite — stocke l'univers (composition des indices) et les
fondamentaux par titre, avec horodatage pour savoir ce qui doit être
rafraîchi.
"""
import sqlite3
import json
import time
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS universe (
    symbol TEXT PRIMARY KEY,
    name TEXT,
    isin TEXT,
    country TEXT,
    sector TEXT,
    mcap REAL,
    fetched_at REAL
);

CREATE TABLE IF NOT EXISTS fundamentals (
    symbol TEXT PRIMARY KEY,
    price REAL,
    mcap REAL,
    pb REAL,
    pe REAL,
    ps REAL,
    pcf REAL,
    ebitda_yield REAL,
    div_yield REAL,
    buyback_yield REAL,
    mom3 REAL,
    mom6 REAL,
    eps_growth REAL,
    roe REAL,
    op_margin REAL,
    revenue_growth REAL,
    avg_daily_value REAL,
    analyst_rating REAL,
    analyst_label TEXT,
    fetched_at REAL,
    error TEXT
);
"""


def _migrate(conn):
    """Ajoute les colonnes manquantes sur une base créée par une version
    antérieure du schéma (CREATE TABLE IF NOT EXISTS ne modifie pas une
    table déjà existante — il faut une migration explicite)."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(universe)").fetchall()}
    if "mcap" not in cols:
        conn.execute("ALTER TABLE universe ADD COLUMN mcap REAL")
    if "isin" not in cols:
        conn.execute("ALTER TABLE universe ADD COLUMN isin TEXT")
    fcols = {row["name"] for row in conn.execute("PRAGMA table_info(fundamentals)").fetchall()}
    for col in ("roe", "op_margin", "revenue_growth", "avg_daily_value"):
        if col not in fcols:
            conn.execute(f"ALTER TABLE fundamentals ADD COLUMN {col} REAL")
    if "analyst_rating" not in fcols:
        conn.execute("ALTER TABLE fundamentals ADD COLUMN analyst_rating REAL")
    if "analyst_label" not in fcols:
        conn.execute("ALTER TABLE fundamentals ADD COLUMN analyst_label TEXT")


@contextmanager
def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(SCHEMA)
        _migrate(conn)
        yield conn
        conn.commit()
    finally:
        conn.close()


def clear_universe_for_country(conn, country_code):
    """Supprime toutes les entrées univers d'un pays avant un refetch, pour
    que les titres qui ne correspondent plus aux critères actuels (ex. exclus
    par un nouveau filtre de bourse) disparaissent vraiment, au lieu de
    rester en base indéfiniment (upsert seul ne supprime jamais rien)."""
    conn.execute("DELETE FROM universe WHERE country = ?", (country_code,))


def upsert_universe(conn, symbol, name, country, sector, mcap=None, isin=None):
    conn.execute(
        """INSERT INTO universe (symbol, name, country, sector, mcap, isin, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(symbol) DO UPDATE SET
             name=excluded.name, country=excluded.country,
             sector=excluded.sector, mcap=excluded.mcap, isin=excluded.isin, fetched_at=excluded.fetched_at""",
        (symbol, name, country, sector, mcap, isin, time.time()),
    )


import re

_CORP_SUFFIX_WORDS = {
    "sa", "ag", "asa", "ltd", "plc", "nv", "se", "inc", "co", "company", "corp",
    "corporation", "group", "holding", "holdings", "spa", "kgaa", "ab", "oyj",
    "as", "pjsc", "oao", "pao", "jsc", "de", "of", "and", "the", "van", "von",
    "sab", "cv", "bhd", "tbk", "ord", "reg", "shs", "class", "adr", "gdr",
    "ads", "dr", "unsp", "spons", "sponsored", "unsponsored",
    "act", "vz", "nam", "st", "pref", "namensaktie", "stamm", "inh", "vinkuliert",
    "grp", "eo",
}

def normalize_company_name(name):
    """Reduit un nom d'entreprise a sa forme la plus nue possible, pour
    reperer les doublons entre cotations (ex. 'SoftBank Group Corp. R' et
    'SOFTBANK GROUP CORP' -> 'softbank' dans les deux cas, 'EASYJET PLC ORD
    27 2/7P' et 'easyJet PLC' -> 'easyjet' dans les deux cas). Best-effort :
    n'attrape pas tous les cas (noms tres abreges notamment), mais couvre
    la grande majorite des doublons de cotations secondaires/OTC/certificats.
    """
    if not name:
        return ""
    n = name.lower()
    n = re.sub(r"[.,()&/\-]", " ", n)  # ponctuation ET tirets (ex. "-PETRO", "HARLEY-DAVIDSON")
    raw_tokens = n.split()
    tokens = []
    for t in raw_tokens:
        if t in _CORP_SUFFIX_WORDS:
            continue
        if re.fullmatch(r"\d+[a-z]?", t):
            continue  # codes de denomination d'action (ex. "1p", "27", "20", "7p")
        if re.fullmatch(r"[a-z]{2,3}\d+[a-z]?", t):
            continue  # codes devise+denomination (ex. "gbp0", "eur1", "usd0")
        if len(t) <= 1:
            continue
        tokens.append(t)
    tokens = list(dict.fromkeys(tokens))  # retire les repetitions (ex. "ENI SPA ENI ORD SHS")
    return " ".join(tokens)


import re as _re

_SECONDARY_LISTING_SUFFIXES = (".F", ".VI", ".IL", ".XC", ".SG", ".DU", ".MU", ".DE")
# NB : .DE (Xetra) n'est PAS exclu à la source (universe.py) car il héberge
# aussi de vraies entreprises allemandes — il est seulement déclassé ICI,
# dans le départage entre doublons déjà détectés par nom. Un titre .DE seul
# (sans concurrent dans un autre pays) n'est jamais affecté par ce réglage.

def _looks_like_otc_ticker(symbol):
    """Heuristique : les ADR pink sheets/OTC US ont très souvent un ticker
    de 4-5 lettres se terminant par F ou Y (ex. REPYF, SFTBY, OMVKY...).
    On déclasse aussi les suffixes de bourse repérés empiriquement comme
    hébergeant surtout des cross-listings/certificats plutôt que la vraie
    cotation domestique : .F (Frankfort Freiverkehr), .VI (Vienne), .IL et
    .XC (carnet international / certificats de Londres). Sert uniquement de
    départage secondaire en cas d'égalité de capitalisation entre deux
    cotations de la même entreprise, pas de filtre principal."""
    if bool(_re.match(r"^[A-Z]{3,5}[FY]$", symbol)) or "CDR" in symbol.upper():
        return True
    return any(symbol.upper().endswith(suf) for suf in _SECONDARY_LISTING_SUFFIXES)


def dedupe_universe_by_name(conn):
    """Parmi les titres de la table universe partageant le même nom normalisé
    (probable doublon de cotation entre pays/bourses — ADR, cross-listing OTC...),
    ne garde que celui à la plus grosse capitalisation, supprime les autres
    (de universe ET fundamentals, pour qu'ils ne réapparaissent jamais dans
    l'export). Utilise la capitalisation déjà fetchée (fundamentals.mcap, plus
    fiable) quand elle existe, sinon celle de l'univers (screener.mcap). En cas
    d'égalité de capitalisation (fréquent pour la même entreprise), déprioritise
    les tickers au format typique des ADR OTC. Retourne le nombre de doublons
    supprimés."""
    rows = conn.execute(
        """SELECT u.symbol, u.name,
                  COALESCE(f.mcap, u.mcap) AS best_mcap
           FROM universe u LEFT JOIN fundamentals f ON f.symbol = u.symbol"""
    ).fetchall()
    groups = {}
    for r in rows:
        key = normalize_company_name(r["name"])
        if not key:
            continue
        groups.setdefault(key, []).append(r)

    removed = 0
    for key, entries in groups.items():
        if len(entries) <= 1:
            continue
        entries.sort(key=lambda r: (
            r["best_mcap"] or 0,
            0 if _looks_like_otc_ticker(r["symbol"]) else 1,  # non-OTC gagne les égalités
        ), reverse=True)
        for loser in entries[1:]:
            conn.execute("DELETE FROM universe WHERE symbol = ?", (loser["symbol"],))
            conn.execute("DELETE FROM fundamentals WHERE symbol = ?", (loser["symbol"],))
            removed += 1
    return removed


def upsert_fundamentals(conn, symbol, data, error=None):
    conn.execute(
        """INSERT INTO fundamentals
           (symbol, price, mcap, pb, pe, ps, pcf, ebitda_yield, div_yield,
            buyback_yield, mom3, mom6, eps_growth, roe, op_margin, revenue_growth,
            avg_daily_value, analyst_rating, analyst_label, fetched_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(symbol) DO UPDATE SET
             price=excluded.price, mcap=excluded.mcap, pb=excluded.pb,
             pe=excluded.pe, ps=excluded.ps, pcf=excluded.pcf,
             ebitda_yield=excluded.ebitda_yield, div_yield=excluded.div_yield,
             buyback_yield=excluded.buyback_yield, mom3=excluded.mom3,
             mom6=excluded.mom6, eps_growth=excluded.eps_growth,
             roe=excluded.roe, op_margin=excluded.op_margin, revenue_growth=excluded.revenue_growth,
             avg_daily_value=excluded.avg_daily_value,
             analyst_rating=excluded.analyst_rating, analyst_label=excluded.analyst_label,
             fetched_at=excluded.fetched_at, error=excluded.error""",
        (
            symbol,
            data.get("price"), data.get("mcap"), data.get("pb"), data.get("pe"),
            data.get("ps"), data.get("pcf"), data.get("ebitda_yield"),
            data.get("div_yield"), data.get("buyback_yield"), data.get("mom3"),
            data.get("mom6"), data.get("eps_growth"),
            data.get("roe"), data.get("op_margin"), data.get("revenue_growth"),
            data.get("avg_daily_value"), data.get("analyst_rating"), data.get("analyst_label"),
            time.time(), error,
        ),
    )


def get_universe(conn, countries=None):
    if countries:
        placeholders = ",".join("?" * len(countries))
        rows = conn.execute(
            f"SELECT * FROM universe WHERE country IN ({placeholders})", countries
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM universe").fetchall()
    return [dict(r) for r in rows]


def get_stale_symbols(conn, symbols, max_age_days):
    """Retourne le sous-ensemble de `symbols` absent de la table fundamentals
    ou dont la dernière récupération date de plus de `max_age_days`, en
    ignorant les erreurs (on retente toujours les échecs précédents)."""
    cutoff = time.time() - max_age_days * 86400
    fresh = set()
    rows = conn.execute(
        "SELECT symbol, fetched_at, error FROM fundamentals"
    ).fetchall()
    for r in rows:
        if r["error"] is None and r["fetched_at"] and r["fetched_at"] >= cutoff:
            fresh.add(r["symbol"])
    return [s for s in symbols if s not in fresh]


def get_all_fundamentals(conn):
    rows = conn.execute(
        """SELECT u.symbol, u.name, u.isin, u.country, u.sector,
                  f.price, f.mcap, f.pb, f.pe, f.ps, f.pcf, f.ebitda_yield,
                  f.div_yield, f.buyback_yield, f.mom3, f.mom6, f.eps_growth,
                  f.roe, f.op_margin, f.revenue_growth, f.avg_daily_value,
                  f.analyst_rating, f.analyst_label,
                  f.fetched_at, f.error
           FROM universe u
           LEFT JOIN fundamentals f ON f.symbol = u.symbol"""
    ).fetchall()
    return [dict(r) for r in rows]
