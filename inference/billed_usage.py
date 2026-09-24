"""Read authoritative app billing separately from member inference measurements.

Run: uv run python inference/billed_usage.py --start 2026-09-22
Uses the local CLI workspace credential; never accepts or prints credentials.
"""

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import json
import subprocess
import sys

APP_ID = "ap-GZHVsFa9WJZZYhc6iTj8Tu"


def summarize(rows, rates, start, end, retrieved_at):
    rate = Decimal(rates["gpu_hour_cost_t4"])
    if not rate.is_finite() or rate <= 0:
        raise ValueError("Invalid T4 hourly rate")
    selected = [row for row in rows if row["object_id"] == APP_ID and row["environment"] == "main"]
    costs = {}
    for row in selected:
        cost = Decimal(row["cost"])
        if not cost.is_finite() or cost < 0:
            raise ValueError("Invalid reported cost")
        resource = row["resource"]
        costs[resource] = costs.get(resource, Decimal(0)) + cost
    t4_cost = costs.get("T4", Decimal(0))
    return {
        "model": "mys/laya-typed-decisions-GGUF",
        "gpu": "T4",
        "scope": "entire deployed app, including startup, idle time and operator calls",
        "status": "reported" if selected else "no_reported_usage",
        "startInclusive": start,
        "endExclusive": end,
        "retrievedAt": retrieved_at,
        "resolution": "hour",
        "reportedCostUsdByResource": {key: str(value) for key, value in sorted(costs.items())},
        "reportedT4CostUsd": str(t4_cost),
        "currentT4HourlyRateUsd": str(rate),
        "t4SecondsAtCurrentRate": str(t4_cost * 3600 / rate),
        "secondsBasis": "Derived from reported T4 cost and the current rate; not raw billed duration. Historical rate changes and cost rounding may affect the conversion.",
        "completeness": "Current partial hour is excluded. Source collection can be delayed; rerun to obtain revisions. Costs are before credits and reservations, not the final invoice.",
        "intervals": selected,
    }


def query(*args):
    result = subprocess.run([sys.executable, "-m", "modal", "billing", *args, "--json"], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def main():
    now = datetime.now(timezone.utc)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", default=now.date().isoformat(), help="Inclusive UTC date or hour")
    args = parser.parse_args()
    start = datetime.fromisoformat(args.start).replace(tzinfo=timezone.utc)
    end = now.replace(minute=0, second=0, microsecond=0)
    if start >= end or start.minute or start.second or start.microsecond:
        parser.error("start must be an aligned UTC hour before the current hour")
    start_text, end_text = start.isoformat(), end.isoformat()
    rows = query("report", "--start", start_text, "--end", end_text, "--resolution", "h", "--show-resources")
    rates = query("rates")
    print(json.dumps(summarize(rows, rates, start_text, end_text, datetime.now(timezone.utc).isoformat()), indent=2))


if __name__ == "__main__":
    main()
