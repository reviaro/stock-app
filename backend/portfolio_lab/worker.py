#!/usr/bin/env python3
"""Read-only portfolio allocation and walk-forward analytics worker."""

from __future__ import annotations

import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from typing import Any

import cvxpy as cp
import numpy as np
import pandas as pd
import yfinance as yf
import skfolio
from skfolio import RiskMeasure
from skfolio.optimization import (
    EqualWeighted,
    HierarchicalRiskParity,
    InverseVolatility,
    MeanRisk,
    ObjectiveFunction,
)

MODEL_NAMES = {
    "equal_weight": "Equal weight",
    "inverse_volatility": "Inverse volatility",
    "hrp": "Hierarchical Risk Parity",
    "minimum_variance": "Minimum variance",
    "cvar": "Constrained CVaR",
}


def _model(model_id: str):
    if model_id == "equal_weight":
        return EqualWeighted()
    if model_id == "inverse_volatility":
        return InverseVolatility()
    if model_id == "hrp":
        return HierarchicalRiskParity(risk_measure=RiskMeasure.VARIANCE)
    if model_id == "minimum_variance":
        return MeanRisk(
            objective_function=ObjectiveFunction.MINIMIZE_RISK,
            risk_measure=RiskMeasure.VARIANCE,
        )
    if model_id == "cvar":
        return MeanRisk(
            objective_function=ObjectiveFunction.MINIMIZE_RISK,
            risk_measure=RiskMeasure.CVAR,
        )
    raise ValueError(f"Unknown model: {model_id}")


def _raw_weights(model_id: str, returns: pd.DataFrame) -> np.ndarray:
    estimator = _model(model_id)
    estimator.fit(returns)
    weights = np.asarray(estimator.weights_, dtype=float).reshape(-1)
    if len(weights) != returns.shape[1] or not np.all(np.isfinite(weights)):
        raise ValueError(f"{MODEL_NAMES[model_id]} returned invalid weights")
    weights = np.maximum(weights, 0)
    total = float(weights.sum())
    if total <= 0:
        raise ValueError(f"{MODEL_NAMES[model_id]} returned no investable weights")
    return weights / total


def _sector_groups(symbols: list[str], sectors: dict[str, str]) -> dict[str, list[int]]:
    groups: dict[str, list[int]] = {}
    for index, symbol in enumerate(symbols):
        sector = sectors.get(symbol) or "Unknown"
        groups.setdefault(sector, []).append(index)
    return groups


def _assert_constraint_feasibility(
    symbols: list[str],
    sectors: dict[str, str],
    investable: float,
    max_position: float,
    max_sector: float,
) -> None:
    groups = _sector_groups(symbols, sectors)
    total_capacity = sum(min(max_sector, len(indices) * max_position) for indices in groups.values())
    if total_capacity + 1e-9 < investable:
        raise ValueError("infeasible sector constraint: selected sectors cannot allocate the investable portfolio")


def _project_weights(
    raw: np.ndarray,
    symbols: list[str],
    sectors: dict[str, str],
    investable: float,
    max_position: float,
    max_sector: float,
) -> np.ndarray:
    _assert_constraint_feasibility(symbols, sectors, investable, max_position, max_sector)
    target = np.asarray(raw, dtype=float) * investable
    weights = cp.Variable(len(symbols))
    constraints = [weights >= 0, weights <= max_position, cp.sum(weights) == investable]
    for indices in _sector_groups(symbols, sectors).values():
        constraints.append(cp.sum(weights[indices]) <= max_sector)
    problem = cp.Problem(cp.Minimize(cp.sum_squares(weights - target)), constraints)
    problem.solve(solver="CLARABEL")
    if problem.status not in {cp.OPTIMAL, cp.OPTIMAL_INACCURATE} or weights.value is None:
        raise ValueError("allocation constraints could not be solved")
    result = np.asarray(weights.value, dtype=float)
    result[np.abs(result) < 1e-10] = 0
    return result


def _native_mean_risk_weights(
    model_id: str,
    returns: pd.DataFrame,
    symbols: list[str],
    sectors: dict[str, str],
    investable: float,
    max_position: float,
    max_sector: float,
) -> np.ndarray:
    _assert_constraint_feasibility(symbols, sectors, investable, max_position, max_sector)
    sector_codes = {sector: f"sector_{index}" for index, sector in enumerate(_sector_groups(symbols, sectors))}
    groups = {symbol: [sector_codes[sectors.get(symbol) or "Unknown"]] for symbol in symbols}
    linear_constraints = [f"{code} <= {max_sector:.12f}" for code in sector_codes.values()]
    estimator = MeanRisk(
        objective_function=ObjectiveFunction.MINIMIZE_RISK,
        risk_measure=RiskMeasure.VARIANCE if model_id == "minimum_variance" else RiskMeasure.CVAR,
        min_weights=0.0,
        max_weights=max_position,
        budget=investable,
        groups=groups,
        linear_constraints=linear_constraints,
        solver="CLARABEL",
        raise_on_failure=True,
    )
    estimator.fit(returns)
    weights = np.asarray(estimator.weights_, dtype=float).reshape(-1)
    if len(weights) != len(symbols) or not np.all(np.isfinite(weights)):
        raise ValueError(f"{MODEL_NAMES[model_id]} returned invalid weights")
    return weights


def _target_weights(
    model_id: str,
    returns: pd.DataFrame,
    symbols: list[str],
    sectors: dict[str, str],
    investable: float,
    max_position: float,
    max_sector: float,
) -> np.ndarray:
    if model_id in {"minimum_variance", "cvar"}:
        return _native_mean_risk_weights(
            model_id, returns, symbols, sectors, investable, max_position, max_sector
        )
    return _project_weights(
        _raw_weights(model_id, returns), symbols, sectors, investable, max_position, max_sector
    )


def _turnover(current: np.ndarray | None, target: np.ndarray, cash_target: float) -> float:
    if current is None:
        return 0.0
    current_cash = max(0.0, 1.0 - float(current.sum()))
    return 0.5 * (float(np.abs(target - current).sum()) + abs(cash_target - current_cash))


def _drift_weights(target: np.ndarray, test_returns: pd.DataFrame, cash_weight: float) -> np.ndarray:
    growth = np.prod(1 + np.asarray(test_returns, dtype=float), axis=0)
    risky_values = np.asarray(target, dtype=float) * growth
    total_value = float(risky_values.sum()) + float(cash_weight)
    if not math.isfinite(total_value) or total_value <= 0:
        raise ValueError("portfolio value became non-positive during walk-forward validation")
    return risky_values / total_value


def _buy_and_hold_returns(target: np.ndarray, test_returns: pd.DataFrame, cash_weight: float) -> pd.Series:
    risky = np.asarray(target, dtype=float).copy()
    cash = float(cash_weight)
    realized: list[float] = []
    for asset_returns in np.asarray(test_returns, dtype=float):
        portfolio_return = float(np.dot(risky, asset_returns))
        denominator = 1.0 + portfolio_return
        if not math.isfinite(denominator) or denominator <= 0:
            raise ValueError("portfolio value became non-positive during walk-forward validation")
        realized.append(portfolio_return)
        risky = risky * (1.0 + asset_returns) / denominator
        cash = cash / denominator
    return pd.Series(realized, index=test_returns.index, dtype=float)


def _metrics(daily_returns: pd.Series, turnover: float, total_cost: float) -> dict[str, float]:
    values = np.asarray(daily_returns, dtype=float)
    if len(values) == 0 or not np.all(np.isfinite(values)):
        raise ValueError("out-of-sample returns are unavailable")
    wealth = np.cumprod(1 + values)
    total_return = float(wealth[-1] - 1)
    annualized_return = float(wealth[-1] ** (252 / len(values)) - 1) if wealth[-1] > 0 else -1.0
    annualized_volatility = float(np.std(values, ddof=1) * math.sqrt(252)) if len(values) > 1 else 0.0
    sharpe = float(np.mean(values) / np.std(values, ddof=1) * math.sqrt(252)) if annualized_volatility > 1e-12 else 0.0
    wealth_with_start = np.concatenate(([1.0], wealth))
    running_peak = np.maximum.accumulate(wealth_with_start)
    max_drawdown = float(np.max(1 - wealth_with_start / running_peak))
    return {
        "total_return_pct": round(total_return * 100, 4),
        "annualized_return_pct": round(annualized_return * 100, 4),
        "annualized_volatility_pct": round(annualized_volatility * 100, 4),
        "max_drawdown_pct": round(max_drawdown * 100, 4),
        "sharpe": round(float(sharpe), 4),
        "turnover_pct": round(turnover * 100, 4),
        "transaction_cost_pct": round(total_cost * 100, 4),
    }


def _weights_payload(symbols: list[str], weights: np.ndarray, sectors: dict[str, str]) -> list[dict[str, Any]]:
    return [
        {
            "symbol": symbol,
            "sector": sectors.get(symbol) or "Unknown",
            "weight_pct": round(float(weight) * 100, 6),
        }
        for symbol, weight in zip(symbols, weights, strict=True)
    ]


def analyze_price_history(
    request: dict[str, Any],
    prices: pd.DataFrame,
    sectors: dict[str, str],
    warnings: list[str] | None = None,
) -> dict[str, Any]:
    symbols = request["symbols"]
    warnings = list(warnings or [])
    prices = prices.loc[:, symbols].replace([np.inf, -np.inf], np.nan)
    missing_counts = {symbol: int(count) for symbol, count in prices.isna().sum().items() if count}
    if missing_counts:
        detail = ", ".join(f"{symbol}={count}" for symbol, count in missing_counts.items())
        raise ValueError(f"incomplete shared price history; missing adjusted closes: {detail}")
    returns = prices.pct_change(fill_method=None).replace([np.inf, -np.inf], np.nan).dropna()
    train_days = int(request["train_days"])
    test_days = int(request["test_days"])
    if len(returns) < train_days + (2 * test_days):
        raise ValueError(
            f"insufficient shared price history: need at least {train_days + (2 * test_days)} daily returns, received {len(returns)}"
        )

    investable = (100 - float(request["cash_target_pct"])) / 100
    cash_target = 1 - investable
    max_position = float(request["max_position_pct"]) / 100
    max_sector = float(request["max_sector_pct"]) / 100
    cost_rate = float(request["transaction_cost_bps"]) / 10_000
    _assert_constraint_feasibility(symbols, sectors, investable, max_position, max_sector)

    current_input = request.get("current_weights_pct") or {}
    current = None
    if current_input:
        candidate = np.asarray([float(current_input.get(symbol, 0)) / 100 for symbol in symbols])
        if float(candidate.sum()) > 0:
            current = candidate
    if current is None:
        warnings.append("No current allocation was supplied; current target turnover is unavailable.")

    fold_ranges: list[tuple[int, int, int]] = []
    start = 0
    minimum_partial_test_days = 21
    while start + train_days + minimum_partial_test_days <= len(returns):
        train_end = start + train_days
        test_end = min(train_end + test_days, len(returns))
        fold_ranges.append((start, train_end, test_end))
        if test_end == len(returns):
            break
        start += test_days

    model_rows = []
    model_returns: dict[str, pd.Series] = {}
    for model_id, model_name in MODEL_NAMES.items():
        try:
            previous = np.zeros(len(symbols), dtype=float)
            fold_series = []
            total_turnover = 0.0
            total_cost = 0.0
            for train_start, train_end, test_end in fold_ranges:
                train = returns.iloc[train_start:train_end]
                test = returns.iloc[train_end:test_end]
                target = _target_weights(
                    model_id, train, symbols, sectors, investable, max_position, max_sector
                )
                fold_turnover = _turnover(previous, target, cash_target)
                fold_cost = fold_turnover * cost_rate
                realized = _buy_and_hold_returns(target, test, cash_target)
                if len(realized):
                    realized.iloc[0] -= fold_cost
                fold_series.append(realized)
                total_turnover += fold_turnover
                total_cost += fold_cost
                previous = _drift_weights(target, test, cash_target)

            combined = pd.concat(fold_series)
            model_returns[model_id] = combined
            target = _target_weights(
                model_id, returns, symbols, sectors, investable, max_position, max_sector
            )
            stats = _metrics(combined, total_turnover, total_cost)
            max_weight = float(np.max(target))
            hhi = float(np.square(target).sum())
            model_rows.append({
                "id": model_id,
                "name": model_name,
                "status": "success",
                "target_weights": _weights_payload(symbols, target, sectors),
                "cash_weight_pct": round(cash_target * 100, 6),
                "max_position_pct": round(max_weight * 100, 4),
                "concentration_hhi": round(hhi, 6),
                "constraint_handling": (
                    "native_optimization" if model_id in {"minimum_variance", "cvar"}
                    else "post_optimization_projection"
                ),
                "current_target_turnover_pct": (
                    None if current is None else round(_turnover(current, target, cash_target) * 100, 4)
                ),
                "out_of_sample": stats,
            })
        except Exception as error:
            model_rows.append({
                "id": model_id,
                "name": model_name,
                "status": "error",
                "error": str(error)[:300],
                "target_weights": [],
            })

    benchmark = next((row for row in model_rows if row["id"] == "equal_weight" and row["status"] == "success"), None)
    if benchmark is None:
        raise ValueError("equal-weight benchmark failed")
    benchmark_return = benchmark["out_of_sample"]["total_return_pct"]
    oos_start = model_returns["equal_weight"].index[0]
    oos_end = model_returns["equal_weight"].index[-1]
    for row in model_rows:
        if row["status"] != "success":
            continue
        row["out_of_sample"]["benchmark_return_pct"] = benchmark_return
        row["strategy_lab_evidence"] = {
            "run_type": "out_of_sample",
            "evidence_domain": "allocation",
            "start_date": oos_start.date().isoformat(),
            "end_date": oos_end.date().isoformat(),
            "trade_count": 0,
            "total_return_pct": row["out_of_sample"]["total_return_pct"],
            "benchmark_return_pct": benchmark_return,
            "max_drawdown_pct": row["out_of_sample"]["max_drawdown_pct"],
            "sharpe": row["out_of_sample"]["sharpe"],
            "notes": (
                f"Portfolio Lab {row['name']}; "
                f"{len(fold_ranges)} rolling folds; allocation evidence only; "
                f"engine skfolio {skfolio.__version__}; symbols {','.join(symbols)}; "
                f"train/test {train_days}/{test_days}; costs {request['transaction_cost_bps']} bps; "
                f"cash/max-position/max-sector {request['cash_target_pct']}/{request['max_position_pct']}/{request['max_sector_pct']}%."
            ),
        }

    return {
        "generated_at": date.today().isoformat(),
        "engine": {"name": "skfolio", "version": skfolio.__version__},
        "symbols": symbols,
        "sectors": {symbol: sectors.get(symbol) or "Unknown" for symbol in symbols},
        "history": {
            "start_date": prices.index[0].date().isoformat(),
            "end_date": prices.index[-1].date().isoformat(),
            "daily_price_rows": int(len(prices)),
        },
        "validation": {
            "method": "rolling_walk_forward",
            "train_days": train_days,
            "test_days": test_days,
            "fold_count": len(fold_ranges),
            "fold_lengths_days": [test_end - train_end for _, train_end, test_end in fold_ranges],
            "includes_partial_final_fold": (fold_ranges[-1][2] - fold_ranges[-1][1]) < test_days,
            "out_of_sample_start": oos_start.date().isoformat(),
            "out_of_sample_end": oos_end.date().isoformat(),
        },
        "constraints": {
            "cash_target_pct": request["cash_target_pct"],
            "max_position_pct": request["max_position_pct"],
            "max_sector_pct": request["max_sector_pct"],
            "transaction_cost_bps": request["transaction_cost_bps"],
        },
        "benchmark_model_id": "equal_weight",
        "data_quality": {
            "provider": "yfinance",
            "auto_adjust": True,
            "alignment": "complete_shared_trading_days",
            "forward_filled_prices": 0,
            "dropped_incomplete_rows": 0,
        },
        "models": model_rows,
        "warnings": warnings or [],
    }


def _fetch_sector(symbol: str) -> tuple[str, str | None]:
    try:
        sector = (yf.Ticker(symbol).info or {}).get("sector")
        return symbol, sector if sector else None
    except Exception:
        return symbol, None


def fetch_market_inputs(request: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, str], list[str]]:
    symbols = request["symbols"]
    period = f"{int(request['lookback_years'])}y"
    downloaded = yf.download(
        tickers=symbols,
        period=period,
        interval="1d",
        auto_adjust=True,
        actions=False,
        progress=False,
        threads=True,
        group_by="column",
    )
    if downloaded.empty:
        raise ValueError("market data provider returned no price history")
    if isinstance(downloaded.columns, pd.MultiIndex):
        if "Close" not in downloaded.columns.get_level_values(0):
            raise ValueError("market data response has no adjusted close history")
        prices = downloaded["Close"]
    else:
        prices = downloaded[["Close"]].rename(columns={"Close": symbols[0]})
    prices = prices.reindex(columns=symbols)
    first_valid = [prices[symbol].first_valid_index() for symbol in symbols]
    last_valid = [prices[symbol].last_valid_index() for symbol in symbols]
    if any(value is None for value in first_valid + last_valid):
        raise ValueError("one or more symbols have no adjusted close history")
    prices = prices.loc[max(first_valid):min(last_valid)]

    with ThreadPoolExecutor(max_workers=min(8, len(symbols))) as pool:
        sector_pairs = list(pool.map(_fetch_sector, symbols))
    sectors = {symbol: sector or "Unknown" for symbol, sector in sector_pairs}
    missing = [symbol for symbol, sector in sector_pairs if not sector]
    warnings = []
    if missing:
        warnings.append(
            "Sector metadata was unavailable for " + ", ".join(missing)
            + "; unknown symbols share one conservative sector constraint bucket."
        )
    return prices, sectors, warnings


def main() -> None:
    try:
        request = json.load(sys.stdin)
        prices, sectors, warnings = fetch_market_inputs(request)
        result = analyze_price_history(request, prices, sectors, warnings)
        print(json.dumps({"status": "success", "data": result}, allow_nan=False))
    except Exception as error:
        print(json.dumps({"status": "error", "error": str(error)[:500]}, allow_nan=False))


if __name__ == "__main__":
    main()
