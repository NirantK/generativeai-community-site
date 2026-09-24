import unittest

from inference.hopper.compare import compare


def run(probabilities):
    return {
        "summary": {"p50_ms": 50, "p95_ms": 70},
        "rows": [{"id": "choice-1", "response": {"answers": {"decision": {
            "type": "choice", "choice": "a", "probabilities": probabilities,
        }}}}],
    }


class ComparisonTests(unittest.TestCase):
    def test_accepts_small_probability_differences(self):
        result = compare(run({"a": 0.8, "b": 0.2}), run({"a": 0.8005, "b": 0.1995}))
        self.assertTrue(result["passes"])

    def test_rejects_probability_drift(self):
        result = compare(run({"a": 0.8, "b": 0.2}), run({"a": 0.79, "b": 0.21}))
        self.assertFalse(result["passes"])

    def test_rejects_answer_flip(self):
        result = compare(run({"a": 0.5001, "b": 0.4999}), run({"a": 0.4999, "b": 0.5001}))
        self.assertEqual(result["non_tie_answer_mismatches"], ["choice-1"])

    def test_noul_probability_is_compared_on_both_sides(self):
        reference = {"summary": {"p50_ms": 50, "p95_ms": 70}, "rows": [{
            "id": "yes-no", "response": {"answers": {"decision": {"type": "noul", "noul": 0.75}}},
        }]}
        candidate = {"summary": {"p50_ms": 40, "p95_ms": 60}, "rows": [{
            "id": "yes-no", "response": {"answers": {"decision": {"type": "noul", "noul": 0.752}}},
        }]}
        self.assertFalse(compare(reference, candidate)["passes"])

    def test_long_prompt_and_near_tie_are_reported(self):
        reference = run({"a": 0.51, "b": 0.49})
        reference["rows"][0]["tokens"] = 3500
        candidate = run({"a": 0.5101, "b": 0.4899})
        result = compare(reference, candidate)
        self.assertEqual(result["stress_subsets"]["long_prompt"]["items"], 1)
        self.assertEqual(result["stress_subsets"]["near_tie"]["items"], 1)


if __name__ == "__main__":
    unittest.main()
