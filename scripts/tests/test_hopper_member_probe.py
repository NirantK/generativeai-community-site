"""Offline checks for the hidden-token production verification probe."""

import contextlib
import importlib.util
import io
import json
import pathlib
import unittest
from unittest.mock import Mock, patch

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "check-hopper-member-api.py"
SPEC = importlib.util.spec_from_file_location("check_hopper_member_api", MODULE_PATH)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class HopperMemberProbeTests(unittest.TestCase):
    def test_requests_identify_the_probe_without_exposing_its_token(self):
        response = Mock()
        response.status = 401
        response.read.return_value = b'{"error":{"code":"unauthorized"}}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=None)
        with patch.object(probe.urllib.request, "urlopen", return_value=response) as open_request:
            status, _ = probe.call("/v1/models", "secret-test-token")
        request = open_request.call_args.args[0]
        self.assertEqual(status, 401)
        self.assertEqual(request.get_header("User-agent"), probe.USER_AGENT)
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-test-token")

    def test_one_decision_increments_only_hopper_usage(self):
        catalog = {"models": [{"name": "HopitAI/hopper"}]}
        inference = {
            "model": "HopitAI/hopper",
            "answers": {"billing": {"type": "choice", "choice": "billing"}},
            "usage": {"gpu": "A10", "gpuSeconds": 0.06},
        }
        before_hopper = {"requestCount": 2, "gpuSeconds": 0.20}
        after_hopper = {"requestCount": 3, "gpuSeconds": 0.26}
        laya = {"requestCount": 5, "gpuSeconds": 0.50}
        output = io.StringIO()
        with patch.object(probe.getpass, "getpass", return_value="secret-test-token"), \
                patch.object(probe, "call", side_effect=[(200, catalog), (200, inference)]) as call, \
                patch.object(probe, "usage", side_effect=[before_hopper, laya, laya, after_hopper, laya, laya]), \
                contextlib.redirect_stdout(output):
            probe.main()
        self.assertEqual(json.loads(output.getvalue())["result"], "verified")
        self.assertNotIn("secret-test-token", output.getvalue())
        self.assertEqual(call.call_count, 2)
        self.assertEqual(call.call_args.args[0], "/v1/systemone")
        self.assertEqual(call.call_args.args[2]["model"], "HopitAI/hopper")


if __name__ == "__main__":
    unittest.main()
