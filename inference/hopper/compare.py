"""Compare Hopper GGUF benchmark output with the pinned PyTorch reference."""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path


def distribution(row):
    answer = next(iter(row["response"]["answers"].values()))
    if answer["type"] == "noul":
        return {"true": answer["noul"], "false": 1 - answer["noul"]}
    return answer["probabilities"]


def top(values):
    return max(sorted(values), key=values.get)


def compare(reference, candidate):
    originals = {row["id"]: row for row in reference["rows"]}
    matches = {row["id"]: row for row in candidate["rows"]}
    if originals.keys() != matches.keys():
        raise ValueError("candidate and reference task sets differ")
    errors = []
    mismatches = []
    stress = {"long_prompt": {"items": 0, "max_probability_error": 0.0, "answer_mismatches": []},
              "near_tie": {"items": 0, "max_probability_error": 0.0, "answer_mismatches": []}}
    for item_id, source in originals.items():
        a, b = distribution(source), distribution(matches[item_id])
        if a.keys() != b.keys():
            raise ValueError(f"{item_id}: candidate option labels differ")
        item_errors = [abs(a[label] - b[label]) for label in a]
        errors.extend(item_errors)
        ranks = sorted(a.values(), reverse=True)
        mismatch = top(a) != top(b) and ranks[0] != ranks[1]
        if mismatch:
            mismatches.append(item_id)
        groups = []
        if source.get("tokens", 0) >= 3000:
            groups.append("long_prompt")
        if len(ranks) >= 2 and ranks[0] - ranks[1] <= 0.05:
            groups.append("near_tie")
        for group in groups:
            stress[group]["items"] += 1
            stress[group]["max_probability_error"] = max(stress[group]["max_probability_error"],
                                                           max(item_errors))
            if mismatch:
                stress[group]["answer_mismatches"].append(item_id)
    return {
        "items": len(originals),
        "max_probability_error": max(errors),
        "mean_probability_error": statistics.mean(errors),
        "non_tie_answer_mismatches": mismatches,
        "stress_subsets": stress,
        "passes": max(errors) <= 1e-3 and not mismatches,
        "reference_p50_ms": reference["summary"]["p50_ms"],
        "reference_p95_ms": reference["summary"]["p95_ms"],
        "candidate_p50_ms": candidate["summary"]["p50_ms"],
        "candidate_p95_ms": candidate["summary"]["p95_ms"],
    }


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: compare.py REFERENCE.json CANDIDATE.json")
    a, b = (json.loads(Path(path).read_text()) for path in sys.argv[1:])
    result = compare(a, b)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result["passes"] else 1)
