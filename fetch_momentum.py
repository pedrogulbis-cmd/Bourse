#!/usr/bin/env python3
"""
Momentum 6 mois recalculé à partir de l'historique QUOTIDIEN (Yahoo
Finance), pour les titres susceptibles de sortir dans Trending Value.

Pourquoi : le champ Perf.6M de TradingView ne dit pas sur quelle fenêtre
il est calculé, et un seul jour de cotation d'écart au départ peut tout
changer (T.RAD 7236, bloqué à la hausse le 28/04/2026 : de +22 % à +83 %
selon la date de départ). L'historique quotidien permet aussi de repérer :
  - les SAUTS : une séance à plus de +20 % dans la fenêtre ;
  - les OFFRES DE RACHAT : un cours « collé » après une forte hausse
    (easyJet sous offre Apollo, figé vers 675-680p depuis fin août :
    son +98 % vient de la prime d'offre, pas d'une tendance).

Cours utilisés (endpoint « chart » de Yahoo) :
  - close    : ajusté des splits (et regroupements) — variante « cours »,
               comparable au Price Index de Quant Investing ;
  - adjclose : ajusté des splits ET des dividendes — variante
               « rendement total » (dividendes réinvestis).

Présélection : télécharger l'historique des ~95 000 lignes du snapshot
prendrait des heures. On ne garde que les titres déjà bon marché ET en
hausse, avec une large marge par rapport au décile du screener (voir
select_candidates) — un titre hors présélection garde le Perf.6M de
TradingView, signalé comme tel sur le site.

Usage :
    python fetch_momentum.py                       # snapshot publié (branche data)
    python fetch_momentum.py --snapshot-dir .      # snapshot local (data-snapshot-*.json)
    python fetch_momentum.py --symbols LSE:EZJ,TSE:7236   # test sur quelques titres
Écrit momentum-history.json.
"""
import argparse
import bisect
import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone

import requests

from fetch_dividends import EXCHANGE_SUFFIXES, HEADERS, YAHOO_CHART, YAHOO_SEARCH, _get, _same_price

OUT_PATH = "momentum-history.json"
SNAPSHOT_URL = "https://raw.githubusercontent.com/pedrogulbis-cmd/Bourse/data/"  # même dépôt que SNAPSHOT_REMOTE dans data.js

# Places absentes de fetch_dividends.EXCHANGE_SUFFIXES (le portefeuille n'en
# avait pas besoin) mais présentes dans l'univers du screener.
EXTRA_SUFFIXES = {
    "TWSE": [".TW"], "TPEX": [".TWO"], "NSE": [".NS"], "BSE": [".BO"],
    "NZX": [".NZ"], "ATHEX": [".AT"], "TASE": [".TA"], "JSE": [".JO"],
    "BMFBOVESPA": [".SA"], "BMV": [".MX"], "BIST": [".IS"], "SSE": [".SS"],
    "SZSE": [".SZ"], "BET": [".BD"], "NGM": [".ST"], "KRX": [".KS", ".KQ"],
}
SUFFIXES = {**EXCHANGE_SUFFIXES, **EXTRA_SUFFIXES}

# Seuils — repris tels quels par le site (champ "params" du fichier).
JUMP_THRESHOLD = 0.20        # une séance à plus de +20 % = alerte saut
TAKEOVER_MIN_MOM6 = 0.20     # « forte hausse » : momentum 6 mois ≥ +20 %
TAKEOVER_MAX_VOL60 = 0.0075  # volatilité quotidienne sur 60 séances ≤ 0,75 %
TAKEOVER_MAX_RANGE2M = 0.05  # écart plus haut / plus bas sur 2 mois (42 séances) ≤ 5 %
MIN_TV_MOM6 = -20            # présélection : Perf.6M TradingView minimum (%)
VOL_SESSIONS = 60
RANGE_SESSIONS = 42


# ---------------------------------------------------------------------------
# Présélection
# ---------------------------------------------------------------------------
def load_snapshot(snapshot_dir=None):
    def read(name):
        if snapshot_dir:
            with open(os.path.join(snapshot_dir, name), encoding="utf-8") as f:
                return json.load(f)
        r = requests.get(SNAPSHOT_URL + name, headers=HEADERS, timeout=120)
        r.raise_for_status()
        return r.json()

    manifest = read("data-snapshot-manifest.json")
    records = []
    for part in manifest["parts"]:
        records += read(part)["records"]
    return records


def _vc2_percentiles(pool):
    """Percentile (0-1) du composite de valeur — mêmes 6 facteurs et même
    traitement que scorePool() dans app.js (manquant = 50)."""
    inv = lambda v: 1 / v if v and v > 0 else None
    factors = [
        (lambda r: r.get("by", inv(r.get("pb"))), False),
        (lambda r: r.get("ey", inv(r.get("pe"))), False),
        (lambda r: r.get("ps"), True),
        (lambda r: r.get("cfy", inv(r.get("pcf"))), False),
        (lambda r: r.get("ebitdaYield"), False),
        (lambda r: r.get("shareholderYield"), False),
    ]
    scores = [0.0] * len(pool)
    for get, lower in factors:
        vals = sorted(v for v in (get(r) for r in pool) if v is not None)
        n = len(vals)
        for i, r in enumerate(pool):
            v = get(r)
            if v is None or n <= 1:
                scores[i] += 50
                continue
            lo, hi = bisect.bisect_left(vals, v), bisect.bisect_right(vals, v)
            p = (lo + (hi - lo - 1) / 2) / (n - 1)
            scores[i] += (100 - p * 99) if lower else (1 + p * 99)
    ranked = sorted(scores)
    return [bisect.bisect_left(ranked, s) / len(ranked) for s in scores]


def select_candidates(records, mcap_floor, max_count):
    """Titres bon marché (30 % les moins chers du monde, ou 20 % les moins
    chers de leur pays) dont le Perf.6M TradingView dépasse −20 %, du plus
    fort momentum au plus faible, plafonnés à `max_count`. La marge sous
    zéro rattrape les titres dont la fenêtre TradingView démarre juste
    après un bond (T.RAD : −11 % chez TradingView, +22 % à +83 % selon la
    date de départ). Le screener garde 10 à 13 % d'un
    univers filtré : cette marge couvre les réglages habituels (pays exclus,
    seuil de capitalisation...)."""
    pool = [r for r in records if (r.get("mcap") or 0) >= mcap_floor and r.get("price")]
    # Une ligne par ISIN (la plus liquide) : inutile de télécharger dix fois
    # TotalEnergies coté sur dix places allemandes.
    best = {}
    for r in pool:
        k = r.get("isin") or r["symbol"]
        if k not in best or (r.get("avgDailyValue") or 0) > (best[k].get("avgDailyValue") or 0):
            best[k] = r
    pool = list(best.values())

    world = _vc2_percentiles(pool)
    by_country = {}
    for i, r in enumerate(pool):
        by_country.setdefault(r.get("country"), []).append(i)
    local = [0.0] * len(pool)
    for idx in by_country.values():
        for i, p in zip(idx, _vc2_percentiles([pool[i] for i in idx])):
            local[i] = p

    out = [r for i, r in enumerate(pool)
           if (r.get("mom6") or 0) > MIN_TV_MOM6 and (world[i] >= 0.70 or local[i] >= 0.80)]
    out.sort(key=lambda r: -(r.get("mom6") or 0))
    return out[:max_count]


# ---------------------------------------------------------------------------
# Historique Yahoo
# ---------------------------------------------------------------------------
def _ticker_candidates(symbol):
    exchange, _, code = symbol.partition(":")
    code = code.replace("_", "-").replace(".", "-")  # VOLCAR_B -> VOLCAR-B, BRK.B -> BRK-B
    if exchange == "HKEX":
        code = code.zfill(4)
    return [code + s for s in SUFFIXES.get(exchange, [])]


def _chart(ticker):
    data = _get(YAHOO_CHART.format(ticker=ticker), {"range": "1y", "interval": "1d", "events": "div,split"})
    result = ((data or {}).get("chart") or {}).get("result") or []
    return result[0] if result else None


def _matches(chart, rec):
    meta = chart.get("meta", {})
    return _same_price(meta.get("regularMarketPrice"), meta.get("currency"), rec.get("price"), rec.get("listedCurrency"))


def fetch_chart(rec, known_ticker=None):
    """(ticker Yahoo, données chart) — le ticker déjà résolu lors d'une
    exécution précédente est essayé en premier ; la recherche par ISIN
    n'intervient qu'en dernier recours (une requête de plus)."""
    tried = []
    for ticker in ([known_ticker] if known_ticker else []) + _ticker_candidates(rec["symbol"]):
        if ticker in tried:
            continue
        tried.append(ticker)
        chart = _chart(ticker)
        if chart and _matches(chart, rec):
            return ticker, chart
    if rec.get("isin"):
        found = _get(YAHOO_SEARCH, {"q": rec["isin"], "quotesCount": 10, "newsCount": 0})
        for q in (found or {}).get("quotes", []):
            ticker = q.get("symbol")
            if not ticker or ticker in tried:
                continue
            tried.append(ticker)
            chart = _chart(ticker)
            if chart and _matches(chart, rec):
                return ticker, chart
    return None, None


def _months_before(d, months):
    y, m = divmod(d.year * 12 + d.month - 1 - months, 12)
    m += 1
    for day in (d.day, 30, 29, 28):  # 31 août -> 28/29 février
        try:
            return date(y, m, day)
        except ValueError:
            continue


def compute_metrics(chart):
    """Mesures sur la fenêtre de 6 mois calendaires se terminant à la
    dernière séance disponible. None si l'historique est trop court."""
    ts = chart.get("timestamp") or []
    quote = (chart.get("indicators", {}).get("quote") or [{}])[0]
    adj = (chart.get("indicators", {}).get("adjclose") or [{}])[0].get("adjclose") or [None] * len(ts)
    # Date locale de la place (décalage horaire fourni par Yahoo) : à Tokyo,
    # l'ouverture tombe encore la veille en heure UTC.
    offset = (chart.get("meta") or {}).get("gmtoffset") or 0
    rows = [(datetime.fromtimestamp(t + offset, timezone.utc).date(), c, a)
            for t, c, a in zip(ts, quote.get("close") or [], adj) if c is not None and c > 0]
    if len(rows) < 2:
        return None

    end = len(rows) - 1
    target = _months_before(rows[end][0], 6)
    start = None
    for i, (d, _, _) in enumerate(rows):
        if d <= target:
            start = i
    if start is None:
        return None  # moins de 6 mois de cotation

    closes = [c for _, c, _ in rows]
    rets = [closes[i] / closes[i - 1] - 1 for i in range(1, len(closes))]

    jump, jump_date = None, None
    for i in range(start + 1, end + 1):
        r = closes[i] / closes[i - 1] - 1
        if jump is None or r > jump:
            jump, jump_date = r, rows[i][0]

    recent = rets[-VOL_SESSIONS:]
    mean = sum(recent) / len(recent)
    vol60 = math.sqrt(sum((x - mean) ** 2 for x in recent) / (len(recent) - 1)) if len(recent) > 1 else None
    window = closes[-RANGE_SESSIONS:]
    range2m = max(window) / min(window) - 1

    mom6 = closes[end] / closes[start] - 1
    a_start, a_end = rows[start][2], rows[end][2]
    mom6_tr = (a_end / a_start - 1) if a_start and a_end else None

    takeover = mom6 >= TAKEOVER_MIN_MOM6 and (
        (vol60 is not None and vol60 <= TAKEOVER_MAX_VOL60) or range2m <= TAKEOVER_MAX_RANGE2M)

    pct = lambda v: round(v * 100, 2) if v is not None else None
    return {
        "start": rows[start][0].isoformat(),
        "end": rows[end][0].isoformat(),
        "mom6": pct(mom6),
        "mom6Tr": pct(mom6_tr),
        "maxJump": pct(jump),
        "maxJumpDate": jump_date.isoformat() if jump_date else None,
        "vol60": pct(vol60),
        "range2m": pct(range2m),
        "takeover": takeover,
    }


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Momentum 6 mois sur historique quotidien ajusté (Yahoo Finance).")
    ap.add_argument("--snapshot-dir", default=None, help="Dossier contenant data-snapshot-manifest.json (sinon : branche data du dépôt).")
    ap.add_argument("--symbols", default=None, help="Symboles TradingView séparés par des virgules, au lieu de la présélection.")
    ap.add_argument("--mcap-floor", type=float, default=50e6, help="Capitalisation minimum en $ pour la présélection (défaut 50 M$).")
    ap.add_argument("--max", type=int, default=8000, help="Nombre maximum de titres présélectionnés (défaut 8000).")
    ap.add_argument("--workers", type=int, default=4, help="Requêtes Yahoo en parallèle (défaut 4 — au-delà, Yahoo limite le débit).")
    ap.add_argument("--out", default=OUT_PATH)
    args = ap.parse_args()

    records = load_snapshot(args.snapshot_dir)
    print(f"— Snapshot : {len(records)} lignes")
    if args.symbols:
        wanted = {s.strip() for s in args.symbols.split(",") if s.strip()}
        candidates = [r for r in records if r["symbol"] in wanted]
    else:
        candidates = select_candidates(records, args.mcap_floor, args.max)
    print(f"— {len(candidates)} titre(s) présélectionné(s)")

    previous = {}
    if os.path.exists(args.out):
        try:
            with open(args.out, encoding="utf-8") as f:
                previous = json.load(f).get("data") or {}
        except Exception:
            previous = {}

    out, failed = {}, 0
    started = time.time()

    def work(rec):
        ticker, chart = fetch_chart(rec, (previous.get(rec["symbol"]) or {}).get("yahoo"))
        metrics = compute_metrics(chart) if chart else None
        return rec, ticker, metrics

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(work, r) for r in candidates]
        for n, fut in enumerate(as_completed(futures), start=1):
            rec, ticker, metrics = fut.result()
            if metrics:
                # L'ISIN permet au site de retrouver l'historique depuis une
                # autre cotation de la même société (présélection dédoublonnée).
                out[rec["symbol"]] = {"yahoo": ticker, "isin": rec.get("isin"), **metrics}
            else:
                failed += 1
            if n % 250 == 0:
                print(f"  {n}/{len(candidates)} ({time.time() - started:.0f} s)")

    flagged_jump = sum(1 for v in out.values() if (v["maxJump"] or 0) > JUMP_THRESHOLD * 100)
    flagged_takeover = sum(1 for v in out.values() if v["takeover"])
    print(f"— {len(out)} historique(s) exploitable(s), {failed} sans correspondance Yahoo ou trop court(s)")
    print(f"— Alertes : {flagged_jump} saut(s) > {JUMP_THRESHOLD:.0%}, {flagged_takeover} suspicion(s) d'offre")

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "params": {
                "jumpThreshold": JUMP_THRESHOLD * 100,
                "takeoverMinMom6": TAKEOVER_MIN_MOM6 * 100,
                "takeoverMaxVol60": TAKEOVER_MAX_VOL60 * 100,
                "takeoverMaxRange2m": TAKEOVER_MAX_RANGE2M * 100,
                "volSessions": VOL_SESSIONS,
                "rangeSessions": RANGE_SESSIONS,
            },
            "data": out,
        }, f, ensure_ascii=False, separators=(",", ":"))
    print(f"— Écrit : {args.out}")


if __name__ == "__main__":
    main()
