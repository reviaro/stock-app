import importlib.util
import math
import pathlib
import unittest

import numpy as np
import pandas as pd

WORKER_PATH = pathlib.Path(__file__).with_name("worker.py")
spec = importlib.util.spec_from_file_location("portfolio_lab_worker", WORKER_PATH)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class PortfolioLabWorkerTests(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(42)
        dates = pd.bdate_range("2022-01-03", periods=540)
        returns = rng.normal(
            loc=[0.00035, 0.00025, 0.0003, 0.0002],
            scale=[0.012, 0.009, 0.011, 0.008],
            size=(len(dates), 4),
        )
        self.prices = pd.DataFrame(
            100 * np.cumprod(1 + returns, axis=0),
            index=dates,
            columns=["AAPL", "MSFT", "JPM", "JNJ"],
        )
        self.sectors = {
            "AAPL": "Technology",
            "MSFT": "Technology",
            "JPM": "Financial Services",
            "JNJ": "Healthcare",
        }
        self.request = {
            "symbols": list(self.prices.columns),
            "current_weights_pct": {"AAPL": 25, "MSFT": 20, "JPM": 20, "JNJ": 15},
            "cash_target_pct": 10,
            "max_position_pct": 35,
            "max_sector_pct": 55,
            "transaction_cost_bps": 10,
            "lookback_years": 3,
            "train_days": 252,
            "test_days": 63,
        }

    def test_compares_five_models_with_constrained_target_weights(self):
        result = worker.analyze_price_history(self.request, self.prices, self.sectors)

        self.assertEqual(
            [model["id"] for model in result["models"]],
            ["equal_weight", "inverse_volatility", "hrp", "minimum_variance", "cvar"],
        )
        self.assertGreaterEqual(result["validation"]["fold_count"], 2)
        self.assertEqual(result["validation"]["out_of_sample_end"], self.prices.index[-1].date().isoformat())
        self.assertEqual(result["validation"]["fold_lengths_days"][-1], 35)
        self.assertTrue(result["validation"]["includes_partial_final_fold"])
        self.assertEqual(result["benchmark_model_id"], "equal_weight")
        for model in result["models"]:
            self.assertEqual(model["status"], "success", model)
            weights = {row["symbol"]: row["weight_pct"] for row in model["target_weights"]}
            self.assertAlmostEqual(sum(weights.values()), 90.0, places=4)
            self.assertLessEqual(max(weights.values()), 35.0001)
            tech_weight = weights["AAPL"] + weights["MSFT"]
            self.assertLessEqual(tech_weight, 55.0001)
            expected_handling = "native_optimization" if model["id"] in {"minimum_variance", "cvar"} else "post_optimization_projection"
            self.assertEqual(model["constraint_handling"], expected_handling)
            for metric in ("total_return_pct", "annualized_return_pct", "annualized_volatility_pct", "max_drawdown_pct", "sharpe", "turnover_pct", "transaction_cost_pct"):
                self.assertTrue(math.isfinite(model["out_of_sample"][metric]), (model["id"], metric))
            self.assertEqual(model["strategy_lab_evidence"]["run_type"], "out_of_sample")
            self.assertEqual(model["strategy_lab_evidence"]["evidence_domain"], "allocation")
            self.assertEqual(model["strategy_lab_evidence"]["trade_count"], 0)
            self.assertIn("rolling folds", model["strategy_lab_evidence"]["notes"])

    def test_discloses_when_current_target_turnover_is_unavailable_without_weights(self):
        request = {**self.request, "current_weights_pct": {}}
        result = worker.analyze_price_history(request, self.prices, self.sectors)
        self.assertTrue(any("current target turnover" in warning.lower() for warning in result["warnings"]))
        self.assertTrue(all(model["out_of_sample"]["turnover_pct"] > 0 for model in result["models"]))
        self.assertTrue(all(model["current_target_turnover_pct"] is None for model in result["models"]))

    def test_rejects_sector_constraints_that_cannot_allocate_the_investable_budget(self):
        sectors = {symbol: "Technology" for symbol in self.prices.columns}
        with self.assertRaisesRegex(ValueError, "sector constraint"):
            worker.analyze_price_history(self.request, self.prices, sectors)

    def test_unknown_sectors_share_one_conservative_constraint_bucket(self):
        groups = worker._sector_groups(list(self.prices.columns), {symbol: "Unknown" for symbol in self.prices.columns})
        self.assertEqual(list(groups), ["Unknown"])
        with self.assertRaisesRegex(ValueError, "sector constraint"):
            worker.analyze_price_history(
                {**self.request, "max_sector_pct": 35},
                self.prices,
                {symbol: "Unknown" for symbol in self.prices.columns},
            )

    def test_metrics_include_initial_loss_and_use_conventional_zero_rate_sharpe(self):
        returns = pd.Series([-0.10, 0.05])
        metrics = worker._metrics(returns, 0.0, 0.0)
        self.assertAlmostEqual(metrics["max_drawdown_pct"], 10.0, places=4)
        expected = float(returns.mean() / returns.std(ddof=1) * math.sqrt(252))
        self.assertAlmostEqual(metrics["sharpe"], expected, places=4)

    def test_rebalance_turnover_uses_post_return_drifted_weights(self):
        target = np.asarray([0.5, 0.5])
        test_returns = pd.DataFrame([[1.0, 0.0]], columns=["A", "B"])
        drifted = worker._drift_weights(target, test_returns, cash_weight=0.0)
        self.assertTrue(np.allclose(drifted, [2 / 3, 1 / 3]))
        self.assertAlmostEqual(worker._turnover(drifted, target, 0.0), 1 / 6)

    def test_mean_risk_models_use_native_constraints_instead_of_post_projection(self):
        returns = self.prices.pct_change(fill_method=None).dropna()
        for model_id in ("minimum_variance", "cvar"):
            native = worker._target_weights(
                model_id, returns, list(self.prices.columns), self.sectors,
                investable=0.90, max_position=0.35, max_sector=0.55,
            )
            self.assertAlmostEqual(float(native.sum()), 0.90, places=6)
            self.assertLessEqual(float(native.max()), 0.350001)
            self.assertLessEqual(float(native[0] + native[1]), 0.550001)
            raw_projected = worker._project_weights(
                worker._raw_weights(model_id, returns), list(self.prices.columns), self.sectors,
                investable=0.90, max_position=0.35, max_sector=0.55,
            )
            self.assertFalse(np.allclose(native, raw_projected, atol=1e-5))

    def test_worker_source_has_no_execution_or_ledger_dependencies(self):
        source = WORKER_PATH.read_text(encoding="utf-8").lower()
        for forbidden in ("alpaca", "submit_order", "simulator", "database/db", "node-cron"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
