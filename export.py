"""
Exporte le contenu de la base SQLite vers data-snapshot.json, dans le
format attendu par app.js (mode "snapshot" — voir loadSnapshot() côté JS).
"""
import json
import time
from datetime import datetime, timezone

import db as dbmod
from config import SNAPSHOT_PATH, TV_COUNTRY_NAMES

NAME_TO_COUNTRY_CODE = {v: k for k, v in TV_COUNTRY_NAMES.items()}


def export_snapshot(conn, out_path=SNAPSHOT_PATH):
    rows = dbmod.get_all_fundamentals(conn)

    records = []
    skipped = 0
    for r in rows:
        if r.get("error") is not None or r.get("fetched_at") is None:
            skipped += 1
            continue
        div_yield = r.get("div_yield") or 0.0
        buyback_yield = r.get("buyback_yield") or 0.0
        records.append({
            "symbol": r["symbol"],
            "name": r["name"],
            "isin": r.get("isin"),
            "country": r["country"],
            "homeCountry": r.get("home_country"),
            "homeCountryCode": NAME_TO_COUNTRY_CODE.get(r.get("home_country")) if r.get("home_country") else None,
            "listedCurrency": r.get("listed_currency"),
            "sector": r["sector"] or "—",
            "price": r.get("price"),
            "mcap": r.get("mcap") or 0,
            "pb": r.get("pb"),
            "pe": r.get("pe"),
            "ps": r.get("ps"),
            "pcf": r.get("pcf"),
            "ebitdaYield": r.get("ebitda_yield"),
            "divYield": div_yield,
            "shareholderYield": div_yield + buyback_yield,
            "mom3": r.get("mom3") or 0,
            "mom6": r.get("mom6") or 0,
            "epsGrowth": r.get("eps_growth"),
            "roe": r.get("roe"),
            "opMargin": r.get("op_margin"),
            "revenueGrowth": r.get("revenue_growth"),
            "avgDailyValue": r.get("avg_daily_value"),
            "analystRating": r.get("analyst_rating"),
            "analystLabel": r.get("analyst_label"),
        })

    snapshot = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "generatedAtUnix": time.time(),
        "count": len(records),
        "skipped": skipped,
        "records": records,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, separators=(",", ":"))

    return len(records), skipped, out_path
