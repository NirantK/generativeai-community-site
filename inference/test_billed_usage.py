import unittest

from billed_usage import APP_ID, summarize


class BillingReportTests(unittest.TestCase):
    def test_only_target_app_environment_and_t4_enter_gpu_total(self):
        def row(resource, cost, app=APP_ID, environment="main"):
            return dict(object_id=app, environment=environment, resource=resource, cost=cost)
        result = summarize([
            row("T4", "0.00010"), row("T4", "0.00020"), row("CPU", "0.03"),
            row("T4", "99", app="other-app"), row("T4", "99", environment="staging"),
        ], {"gpu_hour_cost_t4": "0.6"}, "start", "end", "now")
        self.assertEqual(result["reportedT4CostUsd"], "0.00030")
        self.assertEqual(result["t4SecondsAtCurrentRate"], "1.8000")
        self.assertEqual(result["reportedCostUsdByResource"]["CPU"], "0.03")
        self.assertEqual(len(result["intervals"]), 3)

    def test_empty_source_does_not_claim_complete_zero_usage(self):
        result = summarize([], {"gpu_hour_cost_t4": "0.59"}, "start", "end", "now")
        self.assertEqual(result["status"], "no_reported_usage")
        self.assertIn("delayed", result["completeness"])


if __name__ == "__main__":
    unittest.main()
