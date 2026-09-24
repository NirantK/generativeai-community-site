"""Apply the Xor quality gate to candidate and reference benchmark JSON."""

import argparse
import json
import statistics


def compare(reference, candidate):
    baseline = {r["id"]: r for r in reference["results"]}
    trial = {r["id"]: r for r in candidate["results"]}
    if len(baseline) != 231 or set(baseline) != set(trial):
        raise ValueError("Comparison requires the same 231 public JEVBench cases")
    if any(not row["ok"] for row in trial.values()):
        raise ValueError("Candidate has invalid responses")
    drift = statistics.mean(abs(p - trial[key]["probabilities"][label])
                            for key, row in baseline.items()
                            for label, p in row["probabilities"].items())
    accuracy_loss = reference["summary"]["accuracy"] - candidate["summary"]["accuracy"]
    brier_increase = candidate["summary"]["brierMean"] - reference["summary"]["brierMean"]
    p95 = candidate["summary"]["p95InferenceSeconds"]
    return {"accuracyLoss": accuracy_loss, "meanAbsoluteProbabilityDrift": drift,
            "brierIncrease": brier_increase, "p95InferenceSeconds": p95,
            "passes": accuracy_loss <= .01 and drift <= .01 and brier_increase <= .01 and p95 < 5}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("reference")
    parser.add_argument("candidate")
    parser.add_argument("--reference-fixtures")
    parser.add_argument("--candidate-fixtures")
    args = parser.parse_args()
    with open(args.reference) as stream:
        reference = json.load(stream)
    with open(args.candidate) as stream:
        candidate = json.load(stream)
    result = compare(reference, candidate)
    if args.reference_fixtures and args.candidate_fixtures:
        with open(args.reference_fixtures) as stream:
            reference_fixtures = json.load(stream)
        with open(args.candidate_fixtures) as stream:
            candidate_fixtures = json.load(stream)
        if reference_fixtures.keys() != candidate_fixtures.keys():
            raise ValueError("Fixture kinds differ")
        differences = []
        for kind, probabilities in reference_fixtures.items():
            if probabilities.keys() != candidate_fixtures[kind].keys():
                raise ValueError(f"{kind} fixture labels differ")
            differences.extend(abs(probability - candidate_fixtures[kind][label])
                               for label, probability in probabilities.items())
        result["fixtureMeanAbsoluteProbabilityDrift"] = statistics.mean(differences)
        result["passes"] = result["passes"] and result["fixtureMeanAbsoluteProbabilityDrift"] <= .01
    print(json.dumps(result, indent=2))
    if not result["passes"]:
        raise SystemExit(1)
