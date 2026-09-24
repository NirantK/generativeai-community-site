"""Estimate Modal resource cost from measured Hopper benchmark summaries.

Rates: https://modal.com/pricing (checked 2026-09-23). These are lower bounds:
the benchmark requests 4 physical CPU cores and 32 GiB RAM, but Modal bills
max(request, actual); scheduling, image pull, and network costs are omitted.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

GPU_PER_SECOND = {"A10": 0.000306, "L4": 0.000222, "T4": 0.000164}
CPU_PER_CORE_SECOND = 0.0000131
MEMORY_PER_GIB_SECOND = 0.00000222
BENCHMARK_CORES = 4
BENCHMARK_MEMORY_GIB = 32
SCALEDOWN_IDLE_SECONDS = 30


def estimate(summary):
    rate = (GPU_PER_SECOND[summary["gpu"]]
            + BENCHMARK_CORES * CPU_PER_CORE_SECOND
            + BENCHMARK_MEMORY_GIB * MEMORY_PER_GIB_SECOND)
    warm = rate * summary["mean_gpu_seconds_per_decision"]
    activation = rate * (summary["startup_seconds"] + SCALEDOWN_IDLE_SECONDS)
    return {
        "gpu": summary["gpu"], "resource_usd_per_second": rate,
        "warm_usd_per_1000_decisions": warm * 1000,
        "activation_usd_lower_bound": activation,
        "usd_per_decision_if_1_per_activation": warm + activation,
        "usd_per_decision_if_10_per_activation": warm + activation / 10,
        "usd_per_decision_if_100_per_activation": warm + activation / 100,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: cost_report.py BENCHMARK.json [BENCHMARK.json ...]")
    for filename in sys.argv[1:]:
        record = json.loads(Path(filename).read_text())
        print(json.dumps({"file": filename, **estimate(record["summary"])}, indent=2))
