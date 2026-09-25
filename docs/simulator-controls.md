# Simulator controls and evaluation

## Credentials and limits

Browser sessions represent the operator. The general bearer token and validated
loopback requests are read-only. Simulator agents use separate credentials in
`STOCK_DASHBOARD_SIMULATOR_TOKENS`, for example:

```json
[
  {"account_id": 1, "token": "<unique-random-token-at-least-32-characters>", "manage_limits": true},
  {"account_id": 2, "token": "<different-random-token-at-least-32-characters>", "manage_limits": true}
]
```

Generate secrets privately; never place them in prompts, source control, or
reports. Send the appropriate token in `Authorization: Bearer …`. Invalid
credentials do not fall back to loopback or a browser session. Every simulator
request must explicitly identify the credential's `account_id`. Conflicting
query/body accounts are rejected. `/accounts` returns only the permitted sleeve.

Agents can read approved market research and their sleeve, submit evaluated
trades, and record abstentions. They cannot fund/reset a sleeve, record manual
fills/dividends, administer runs, write research evidence, invoke built-in chat,
or execute broker orders. The built-in chat no longer exposes deposit/reset tools.

With `manage_limits: true`, Buffett can use `PUT /api/simulator/risk-policy` to
change the following settings on the authorized sleeve. The operator can use
the same endpoint with an authenticated browser session and valid Origin.

| Field | Meaning |
|---|---|
| `max_position_pct` | Maximum projected weight of the position being bought |
| `min_cash_pct` | Minimum projected cash weight after the entry and fees |
| `max_risk_per_trade_pct` | Maximum entry risk including fees relative to equity |
| `max_open_risk_pct` | Maximum combined open-position risk after the entry |
| `max_daily_loss_pct` | Block new entries after this loss relative to the first complete New York session-date observation, adjusted for cash flows |

Supply all five fields as finite numbers from 0 to 100; only `min_cash_pct`
may be zero. There are no implicit live defaults. An operator or delegated
Buffett credential must configure initial limits before new evaluated buys.
`GET /api/simulator/risk-policy?account_id=2` reports the active policy and
whether entry configuration exists; it is not an assurance that market data
or a particular order will pass.

Every change appends a policy version with actor and timestamp. Orders record
the version they used. Buffett should change limits when the user requests it,
then read back and explain the saved values, rather than silently relaxing them
to fit a proposed trade. This intent restriction is prompt guidance; possession
of a `manage_limits` credential technically allows limit updates within its sleeve.

All evaluated entry paths check limits inside the same SQLite write lock as
resource checks and fills. Marks are obtained by the server and checked again
under the lock. Missing/stale marks block entries. Positions without a stop are
conservatively budgeted at their full marked value; long-term accounts can set
their budgets accordingly. Existing plan-based positions use their stop distance.
These are modeled risk budgets, not guarantees that a gap cannot exceed a stop.
Limits constrain entries; long-only sells still require valid execution quotes
and sufficient shares, but do not require complete marks for other positions.
Manual operator records remain non-evaluated and are prohibited during active runs.

Existing mutual-fund holdings (provider type `MUTUALFUND`) use USD yfinance daily
NAV marks for valuation, labeled `daily_nav` with their original provider time.
These marks must be retrieved within three minutes and dated within four calendar
days to cover long weekends. This exception applies only to valuation; execution
prices and other holdings retain the regular-session, three-minute quote rule.

These permissions enforce the HTTP boundary. An agent with the server owner's
unrestricted shell, database, or operator-secret access can bypass that boundary.
Strong isolation requires separate OS/service identities and restricted tools.

## Recorded performance

The server records equity, net external contributions, quote provenance, and a
frozen ledger at trade and cash-flow boundaries. A five-minute sampler records
additional observations for configured sleeves, skipping known closed sessions.
Provider failures during an observed period remain missing-data evidence.

`GET /api/simulator/performance?account_id=2` returns observed time-weighted
returns and drawdown. Deposits/withdrawals require complete valuations directly
before and after the flow at identical marks; fees remain losses. Missing marks,
unobserved flow boundaries, manual records, or invalid starting equity yield
unavailable metrics with reasons. No historical prices or equity curves are
invented. The old total-return field remains explicitly capital-relative P&L.
Drawdown is measured over stored observations, not every intervening tick.

## Immutable runs and verified evidence

1. As operator, create a Strategy Lab version with an `evaluation_policy` inside
   its rules. Supply `min_observations` (integer >= 2), `min_closed_trades`
   (integer >= 1), `max_drawdown_pct` (> 0, <= 100), `min_return_pct`, and
   `min_excess_return_pct`. Choose these before collecting results. No universal
   sample count or return target is claimed to establish a profitable strategy.
2. Fund the sleeve and start flat. `POST /api/simulator/runs` takes `account_id`,
   `strategy_version_id`, `model_id`, the 64-character SHA-256 `prompt_hash`,
   and `benchmark_symbol`. A validated benchmark quote is required.
3. The run freezes rules, model/prompt identifiers, source-file hashes, risk
   policy, capital, and starting observation. Trade results link to the active
   run; callers may send `run_id` and a mismatch is rejected. Keep using stable
   `client_order_id` values and reconcile uncertain orders before retrying.
4. `POST /api/simulator/decisions` takes `account_id`, `decision_key`, and a
   concise `reason` to record NO TRADE. Optional `input_snapshot_ids` are
   agent-supplied references, not a claim the inputs were independently verified.
   Successful fills and rejected trade attempts are also recorded by the server.
5. Funding, resets, and manual fill/dividend recording are blocked during an
   active run. Limit changes remain possible, but invalidate that run for a
   fixed-policy comparison. Archive it and start a new version/run to compare
   the changed policy deliberately.
6. `POST /api/simulator/runs/:id/archive` with `account_id` preserves the run's
   closing observation. Archival does not place exits; close positions first
   if the evaluation requires complete lifecycles.
7. `POST /api/strategy-lab/versions/:id/evaluations` takes `simulator_run_id`.
   The server recomputes metrics from the archived observations, including net
   completed-lifecycle outcomes, benchmark comparison, drawdown, and policy
   changes. Losing, undersampled, incomplete, non-flat, or policy-changed runs
   fail the applicable gates. Results and artifacts are append-only; subsequent
   ledger resets cannot rewrite them. Export through
   `GET /api/strategy-lab/evaluations/:id`.

The benchmark currently uses observed price returns and excludes benchmark
dividends; it is explicitly not a total-return benchmark. Execution remains a
latest-trade surrogate without spread, slippage, queue, or partial-fill modeling.
Observations/trades may be correlated; passing configured criteria is not a
statistical proof of edge or permission for live trading.

Manually entered Strategy Lab metrics remain unverified. This implementation
produces verified **simulator paper** artifacts only. Verified backtest and
out-of-sample artifacts still need a reproducible replay runner with frozen
datasets. Promotion gates remain blocked while those artifacts are missing;
labels alone cannot satisfy them. This does not complete the whole F06/F07/F12
research roadmap or the F08/F09 intraday/broker lifecycle.

## Rollout

Build/test in development. Before a separately approved production deployment:

- Back up code, runtime configuration, and the database.
- Provision separate sleeve credentials, with delegated limit management for
  Buffett as requested, and ensure the agent receives only the intended secret.
- Update cron HTTP calls to send their scoped token; loopback writes will be
  rejected under the new release. Preserve price-free, idempotent trade payloads.
- Configure initial limits through the operator session or Buffett's delegated
  credential, then verify their readback and a denied cross-sleeve/admin request.
- Start a fresh evaluation run when desired; do not relabel historical trades.

The existing stock-dashboard production deployment is documented separately in
the local readiness review. Updating this source does not deploy it.
