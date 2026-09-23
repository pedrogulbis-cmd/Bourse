"""
Historique des dividendes des titres du portefeuille, via Yahoo Finance.

TradingView (scanner comme tvDatafeed) ne fournit que le DERNIER et le
PROCHAIN dividende d'un titre, pas l'historique. Yahoo Finance, lui,
renvoie tous les versements passés (date de détachement + montant brut
par action) sur l'endpoint "chart" avec events=div.

Difficulté : retrouver le ticker Yahoo d'un symbole TradingView. Le
préfixe de bourse ne suffit pas toujours — "EURONEXT:" couvre Paris,
Amsterdam, Bruxelles, Lisbonne... On construit donc une liste de
candidats (suffixes Yahoo plausibles + recherche Yahoo par ISIN), puis on
garde le premier dont le cours actuel colle à celui de TradingView : ça
élimine les homonymes d'une autre bourse.

Utilisé par fetch_holdings_history.py ; peut aussi se lancer seul pour
tester :  python fetch_dividends.py EURONEXT:TTE XETR:BMW LSE:AEP
"""
import sys
import time

import requests

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
YAHOO_SEARCH = "https://query2.finance.yahoo.com/v1/finance/search"
TV_SCAN = "https://scanner.tradingview.com/global/scan"

# Préfixe de bourse TradingView -> suffixe(s) Yahoo, dans l'ordre à essayer.
EXCHANGE_SUFFIXES = {
    "EURONEXT": [".PA", ".AS", ".BR", ".LS", ".IR", ".OL"],
    "XETR": [".DE"], "FWB": [".F", ".DE"], "GETTEX": [".DE"],
    "LSE": [".L"], "LSIN": [".L"], "AQUIS": [".L"],
    "MIL": [".MI"], "BME": [".MC"], "SIX": [".SW"], "VIE": [".VI"],
    "OMXSTO": [".ST"], "OMXCOP": [".CO"], "OMXHEX": [".HE"], "OSL": [".OL"],
    "GPW": [".WA"], "HKEX": [".HK"], "ASX": [".AX"], "TSE": [".T"],
    "TSX": [".TO"], "TSXV": [".V"], "NEO": [".NE"], "SGX": [".SI"], "KRX": [".KS"],
    "NYSE": [""], "NASDAQ": [""], "AMEX": [""], "NYSE ARCA": [""], "CBOE": [""], "OTC": [""],
}

# Tolérance entre le cours Yahoo et le cours TradingView pour valider une
# correspondance (écart de clôture, heure de relevé différente...).
PRICE_TOLERANCE = 0.15


def _get(url, params=None, retries=3):
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=20)
            if r.status_code == 429:  # limitation de débit Yahoo : on patiente
                time.sleep(3 * (attempt + 1))
                continue
            if r.status_code != 200:
                return None
            return r.json()
        except (requests.RequestException, ValueError):
            time.sleep(1 + attempt)
    return None


def tradingview_info(symbols):
    """ISIN, cours et devise de chaque symbole, en une seule requête."""
    try:
        r = requests.post(TV_SCAN, json={"symbols": {"tickers": list(symbols)},
                                         "columns": ["isin", "close", "currency"]},
                          headers=HEADERS, timeout=30)
        r.raise_for_status()
        return {row["s"]: dict(zip(["isin", "close", "currency"], row["d"]))
                for row in r.json().get("data", [])}
    except Exception as e:
        print(f"  ⚠ TradingView (ISIN/cours) indisponible : {e}")
        return {}


def _candidates(symbol, isin):
    exchange, _, code = symbol.partition(":")
    code_y = code.replace("_", "-").replace(".", "-")  # VOLCAR_B -> VOLCAR-B, BRK.B -> BRK-B
    if exchange == "HKEX":
        code_y = code_y.zfill(4)                        # 1618 -> 1618.HK, 5 -> 0005.HK
    out = [code_y + s for s in EXCHANGE_SUFFIXES.get(exchange, [])]
    if isin:
        found = _get(YAHOO_SEARCH, {"q": isin, "quotesCount": 10, "newsCount": 0})
        for q in (found or {}).get("quotes", []):
            if q.get("symbol") and q["symbol"] not in out:
                out.append(q["symbol"])
    return out


def _same_price(yahoo_price, yahoo_ccy, tv_price, tv_ccy):
    if not yahoo_price or not tv_price:
        return True  # impossible de vérifier : on fait confiance au premier candidat qui répond
    # Unités différentes pour une même devise (pence vs livres).
    if yahoo_ccy == "GBP" and tv_ccy == "GBX":
        yahoo_price *= 100
    elif yahoo_ccy == "GBp" and tv_ccy == "GBP":
        yahoo_price /= 100
    return abs(yahoo_price - tv_price) / tv_price <= PRICE_TOLERANCE


def fetch_dividend_history(symbol, tv=None, years=15):
    """Retourne {"yahoo", "currency", "events": [{"date", "amount"}]} ou
    None si aucun ticker Yahoo cohérent n'a été trouvé. Les montants sont
    BRUTS, par action, dans la devise de cotation Yahoo."""
    tv = tv or {}
    for ticker in _candidates(symbol, tv.get("isin")):
        data = _get(YAHOO_CHART.format(ticker=ticker),
                    {"range": f"{years}y", "interval": "1mo", "events": "div"})
        result = ((data or {}).get("chart") or {}).get("result") or []
        if not result:
            continue
        meta = result[0].get("meta", {})
        ccy = meta.get("currency")
        if not _same_price(meta.get("regularMarketPrice"), ccy, tv.get("close"), tv.get("currency")):
            continue
        divs = ((result[0].get("events") or {}).get("dividends") or {}).values()
        events = sorted(
            ({"date": time.strftime("%Y-%m-%d", time.gmtime(d["date"])), "amount": float(d["amount"])}
             for d in divs if d.get("amount")),
            key=lambda e: e["date"],
        )
        # Yahoo note "GBp" les pence ; le site utilise le code "GBX" (comme TradingView).
        return {"yahoo": ticker, "currency": "GBX" if ccy == "GBp" else ccy, "events": events}
    return None


def fetch_all(symbols):
    info = tradingview_info(symbols)
    out = {}
    for symbol in symbols:
        res = fetch_dividend_history(symbol, info.get(symbol))
        if res is None:
            print(f"  ⚠ dividendes {symbol} : aucun ticker Yahoo correspondant")
            continue
        out[symbol] = res
        last = res["events"][-1] if res["events"] else None
        print(f"  {symbol} -> {res['yahoo']} : {len(res['events'])} dividende(s)"
              + (f", dernier {last['amount']} {res['currency']} le {last['date']}" if last else ""))
        time.sleep(0.3)  # ménage Yahoo
    return out


if __name__ == "__main__":
    fetch_all(sys.argv[1:] or ["EURONEXT:TTE"])
