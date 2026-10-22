# Paper Day Trading entry preview

`POST /api/alpaca-paper/day-trading/v2/entries/preview` calculates an indicative
whole-share quantity for an account-2 paper-trading intent. The server reads the
current Alpaca paper account, orders, market clock, asset, and quote, and applies
the same entry policy used at submission. This endpoint does not apply to the
simulator or Long-Term Live investing.

A preview creates no plan, journal event, cash reservation, or broker order. It
does not recover uncertain submissions or change trading controls. It still
requires `paper_execute` mode, an inactive kill switch, no attention latch, a
recently reconciled monitor, and no entry submission in progress. Disabled or
shadow mode cannot use it to bypass those gates.

## Authentication and request

Use the scoped credential configured in `ALPACA_DAY_TRADING_ENTRY_TOKEN` as
`Authorization: Bearer <token>`, or an authenticated operator session with the
required browser Origin. The generic read-only token, loopback access, simulator
tokens, and live-investing token do not authorize this endpoint. Keep credentials
in private configuration and out of request logs, prompts, and source control.

Send JSON with `Content-Type: application/json` and these fields:

| Field | Requirement |
|---|---|
| `account_id` | The number `2` |
| `client_order_id` | A new intent identifier matching `^dt2-[A-Za-z0-9][A-Za-z0-9-]{0,99}$`; retain it for the eventual submission and recovery |
| `symbol` | US equity ticker; normalized to uppercase |
| `setup`, `catalyst`, `thesis`, `invalidation` | Nonblank strategy text, at most 1,000 characters each |
| `stop`, `target` | Positive numeric prices aligned to the broker price tick; the resulting entry must satisfy `stop < entryPrice < target` |
| `exit_deadline` | A timestamp later than the check and no later than the current regular-session close; use an explicit time zone |
| `max_notional_dollars` | Positive finite number: the caller's maximum entry cost in dollars |
| `max_risk_dollars` | Positive finite number: the caller's maximum planned stop-distance risk in dollars |
| `max_qty` | Optional positive safe whole number limiting the quantity |
| `setup_id`, `strategy_version`, `catalyst_class` | Optional classification labels matching `^[a-zA-Z][a-zA-Z0-9._-]{0,63}$` |
| `candidate_evidence` | Optional current evidence object, described below |

Do not send `qty`, `max_entry_price`, or broker order fields to the preview.
Unknown fields are rejected. The caller supplies its approved budgets; a preview
does not authorize increasing those budgets or changing the strategy to obtain
an eligible result.

If supplied, `candidate_evidence` requires `observed_at`, a real timestamp with
an explicit time zone that is not in the future and meets the configured evidence
age limit. The default limit is 15 minutes. Its other permitted fields are:

| Field | Meaning and validation |
|---|---|
| `catalyst_at` | Optional real timestamp no later than `observed_at` |
| `relative_volume` | Optional nonnegative finite number |
| `relative_strength_pct` | Optional finite number, which may be negative |
| `atr` | Optional positive finite number |
| `trend` | Optional `up`, `down`, `sideways`, or `unknown` |
| `entry_trigger` | Optional label with the same format as `setup_id` |
| `revision_reason` | Optional nonblank text, at most 300 characters |

Evidence numbers must have an absolute value no greater than one billion.
Caller-supplied evidence is not independently verified market analysis.

The following request is a **synthetic, historical illustration**, not a current
trade recommendation or a payload to submit unchanged. Its dates, ticker, prices,
and strategy text must not be reused as current evidence.

```json
{
  "account_id": 2,
  "client_order_id": "dt2-documentation-example",
  "symbol": "EXMPL",
  "setup": "Illustrative range breakout",
  "catalyst": "Synthetic example event",
  "thesis": "Example hypothesis for demonstrating the API contract",
  "invalidation": "Example hypothesis fails below the planned stop",
  "stop": 98,
  "target": 110,
  "exit_deadline": "2025-03-18T19:30:00Z",
  "max_notional_dollars": 2000,
  "max_risk_dollars": 100,
  "max_qty": 25,
  "setup_id": "example_range",
  "strategy_version": "example_v1",
  "catalyst_class": "example_event",
  "candidate_evidence": {
    "observed_at": "2025-03-18T13:59:00Z",
    "trend": "up",
    "entry_trigger": "example_breakout"
  }
}
```

## Response and sizing

A successful HTTP response has `{"status":"success","data":{...}}`.
**HTTP success alone does not permit submission:** require `data.eligible === true`,
an empty `blockers` array, and a non-null `submission`.

| Response field | Meaning |
|---|---|
| `eligible` | Whether a positive whole-share quantity passed the current checks |
| `qty` | Largest whole-share quantity that passes the caller's budgets and all entry-policy caps; `0` when blocked |
| `entryPrice` | Server-calculated maximum entry limit price, including the configured slippage allowance and tick rounding |
| `quote` | Validated `bidPrice`, `askPrice`, `feed`, `sourceTimestamp`, and `retrievedAt`; may be `null` when unavailable |
| `notionalDollars` | `qty × entryPrice`; `null` when blocked |
| `riskDollars` | `qty × (entryPrice − stop)` before cent rounding; `null` when blocked |
| `rewardRiskRatio` | `(target − entryPrice) / (entryPrice − stop)`; `null` when blocked |
| `constraints` | Caller budgets and current account-policy limits, listed below |
| `blockers` | Fixed `{code, message}` refusal reasons; an empty array only for an eligible preview |
| `submission` | Exact `qty`, `max_entry_price`, `max_notional_dollars`, and `max_risk_dollars` to merge into the eventual entry intent; `null` when blocked |
| `asOf` | Server time of the final preview checks |
| `quoteExpiresAt` | Quote source time plus the policy's maximum quote age; not a reservation or guarantee of acceptance until that time |
| `indicative` | Always `true` |

`constraints` contains these numeric values, or `null` when unavailable or not
supplied: `maxNotionalDollars`, `maxRiskDollars`, `maxQty`,
`availableCashDollars`, `minimumCashReserveDollars`, `maxPositionDollars`,
`maxRiskPerTradeDollars`, `remainingOpenRiskDollars`, `minRewardRiskRatio`,
`maxDailyLossDollars`, and `dailyRealizedPnl`. Available cash already deducts
outstanding buy-order commitments; the minimum cash reserve is a separate
constraint. An omitted `max_qty` produces `maxQty: null` without itself blocking
the request. Account-policy risk checks retain their cent-rounded calculation;
the declared risk budget is checked against the unrounded stop-distance amount.

For the synthetic example, an ask of `$100.00`, a configured 0.5% allowance,
and sufficient account capacity yield an entry limit of `$100.50`. The `$2,000`
notional budget permits 19 shares: `$1,909.50` notional and `$47.50` planned risk.
The reward/risk ratio is `3.8`. The corresponding submission fragment is:

```json
{
  "qty": 19,
  "max_entry_price": 100.5,
  "max_notional_dollars": 2000,
  "max_risk_dollars": 100
}
```

These figures model the planned entry and stop distance. Actual fills, gaps, and
stop execution can produce different realized results.

## Submission and recovery

1. Build the strategy intent from current evidence and approved dollar budgets.
2. Request a preview. On an HTTP error or `eligible: false`, do not submit.
3. For an eligible, still-current preview, retain the original intent, remove
   the preview-only `max_qty`, and merge the **exact** `submission` fields last.
   Do not send the entire response or recompute its quantity or price limit.
4. Send that body to `POST /api/alpaca-paper/day-trading/v2/entries` with the same
   `client_order_id`. Submission independently refreshes the broker facts,
   quote, controls, and risk checks. It enforces the reviewed maximum entry
   price and dollar budgets; a prior preview cannot override a failed check.
5. After a pre-admission refusal, refresh the evidence and preview again when
   appropriate. Do not guess a quantity, raise budgets, widen the approved
   maximum price, or reuse a stale preview to force acceptance.
   If local admission takes too long, `ALPACA_V2_ENTRY_EXPIRED_BEFORE_SEND`
   confirms that the plan was cancelled without sending a broker order. Its ID
   remains consumed; a new attempt needs a fresh intent ID and preview.
6. If the actual submission times out or its outcome is uncertain, preserve
   the original submission body and `client_order_id`. Use same-ID replay and
   reconciliation to establish the outcome; do not generate a new ID or place
   another order. A returned acknowledgement is not proof of a fill. Follow
   the plan and reconciled broker state, and leave attention latches for the
   operator to resolve.

For example, the request body transformation is:

```js
const { max_qty: previewOnlyCap, ...entryIntent } = originalPreviewIntent;
const entryBody = { ...entryIntent, ...preview.data.submission };
// Send entryBody only after checking the eligible, current preview as above.
```

Malformed inputs and execution gates can return non-2xx errors rather than an
ineligible preview. Error bodies use `status: "error"`, `code`, and `error`.
Examples include `ALPACA_V2_SIZING_INVALID`, `ALPACA_V2_KILL_SWITCH_ACTIVE`,
`ALPACA_V2_MONITOR_STALE`, `ALPACA_V2_SUBMISSION_IN_PROGRESS`,
`ALPACA_V2_CONTROL_STATE_CHANGED`, and `ALPACA_V2_BROKER_SNAPSHOT_STALE`.
Policy refusals can instead appear in the successful preview's `blockers`,
including insufficient cash, unavailable quotes, or failed reward/risk geometry.
Both forms mean no trade. The endpoint sends `Cache-Control: no-store`; callers
must not cache previews as reusable trading approval.
