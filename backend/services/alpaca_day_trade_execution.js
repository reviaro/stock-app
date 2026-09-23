const store = require('./alpaca_day_trade_store');
const { getProvenQuote } = require('./alpaca_market_data');
const { buildDayTradeBracketOrder, DEFAULT_DAY_TRADE_POLICY } = require('./alpaca_day_trade_order_policy');
const { computeDailyRealizedPnl } = require('./alpaca_day_trade_journal');
const { DEFAULT_MONITOR_POLICY } = require('./alpaca_day_trade_monitor');

const UNRESOLVED_ORDER_STATUSES = ['pending_submission', 'submission_unknown', 'submission_failed'];
const TERMINAL_ORDER_STATUSES = ['filled', 'canceled', 'rejected', 'expired', 'suspended', 'stopped', 'submission_rejected', 'submission_not_found'];
const TERMINAL_PLAN_STATES = ['closed', 'cancelled', 'error'];

function executionError(code, message) {
    return Object.assign(new Error(message), { code });
}

// Mirrors alpaca_paper_service.js's committedBuyCash, but scoped to execution_epoch ===
// 'day_trading' only (Safety Invariant #3: Long-Term isolation) rather than shared across
// every epoch in the table. An order with a broker_order_id is counted from the broker's own
// open-orders view (authoritative, reflects partial fills); a not-yet-acknowledged local audit
// row is counted once from our own bookkeeping, and never double-counted against the broker
// view once it appears there (matched by client_order_id, which Day Trading always sets equal
// to idempotency_key).
function committedDayTradeBuyCash(openOrders, dtAudits) {
    const brokerKeys = new Set();
    const brokerCommitment = openOrders
        .filter((order) => order.side === 'buy')
        .reduce((total, order) => {
            if (order.client_order_id) brokerKeys.add(order.client_order_id);
            const qty = Number(order.qty) - Number(order.filled_qty || 0);
            const limitPrice = Number(order.limit_price);
            if (!(qty >= 0) || !(limitPrice > 0)) {
                throw executionError('ALPACA_COMMITMENT_UNAVAILABLE', 'unable to determine open Day Trading buy-order cash commitments');
            }
            return total + (qty * limitPrice);
        }, 0);

    // Deliberately a broader set than UNRESOLVED_ORDER_STATUSES: the reconciliation gate above
    // cares about ambiguity (pending_submission/submission_unknown/submission_failed), but
    // money stays committed for as long as an order is open at all — an 'accepted'/'new' order
    // the broker has acknowledged is not ambiguous, but its cash is still spoken for until it
    // fills, is canceled, or is rejected. By the time this runs, the gate has already ruled out
    // any *unresolved* row, so filtering on that same narrower set here would always see zero.
    const localCommitment = dtAudits
        .filter((audit) => audit.side === 'buy')
        .filter((audit) => !TERMINAL_ORDER_STATUSES.includes(audit.status))
        .filter((audit) => !brokerKeys.has(audit.idempotency_key))
        .reduce((total, audit) => {
            const qty = Number(audit.qty);
            const limitPrice = Number(audit.limit_price);
            if (!(qty > 0) || !(limitPrice > 0)) {
                throw executionError('ALPACA_COMMITMENT_UNAVAILABLE', 'unable to determine local Day Trading buy-order cash commitments');
            }
            return total + (qty * limitPrice);
        }, 0);

    return brokerCommitment + localCommitment;
}

// Compares only the caller-controlled fields of the intent (symbol, qty, stop, target) against
// what was actually persisted — never the computed entry price, which depends on the live
// quote at submission time and is expected to differ between a first attempt and a retry.
// This is a plain field comparison, not a re-run of buildDayTradeBracketOrder: rebuilding would
// re-trigger checks that only make sense for a brand-new entry (duplicate-symbol-plan, chief
// among them, since the very plan this replay is checking against is itself the "duplicate").
function intentMatchesExistingAudit(intent, audit) {
    const symbol = String(intent?.symbol || '').trim().toUpperCase();
    return audit.symbol === symbol
        && Number(audit.qty) === Number(intent.qty)
        && Number(audit.stop_price) === Number(intent.stop_price)
        && Number(audit.take_profit_price) === Number(intent.target_price);
}

// The route checks these gates before calling in, but the kill switch / block_entries can be
// set by the monitor while this request waits for the lease or fetches broker data. Re-read the
// durable state inside the lease, right before anything is persisted or sent to the broker, with
// the same codes and thresholds the route uses.
async function assertEntryGatesOpen() {
    const state = await store.getMonitorState();
    if (state?.kill_switch) {
        throw executionError('ALPACA_KILL_SWITCH_ACTIVE', 'the Day Trading kill switch is active; new entries are refused until it is cleared');
    }
    if (state?.mode !== 'paper_execute') {
        throw executionError('ALPACA_ENTRIES_DISABLED', 'Day Trading entries are currently disabled');
    }
    if (state.block_entries) {
        throw executionError('ALPACA_ENTRIES_BLOCKED', 'a Day Trading plan currently requires attention; new entries are refused');
    }
    const lastTick = state.last_rest_reconciliation_at;
    const tickAgeMs = lastTick ? Date.now() - new Date(lastTick).getTime() : Infinity;
    if (!(tickAgeMs <= DEFAULT_MONITOR_POLICY.staleReconciliationMs)) {
        throw executionError('ALPACA_MONITOR_STALE', 'the Day Trading monitor has not confirmed account state recently enough to trust');
    }
}

// The one function through which every Day Trading entry submission passes (plan Section 7
// steps 12-16). A durable, cross-process lease (Safety Invariant #10) serializes attempts from
// the web server and the standalone monitor worker; a plan+entry-order row is persisted before
// the broker POST (Safety Invariant #4); and any outcome that isn't a clean accept or a clean
// synchronous rejection is recorded as ambiguous and blocks further entries until an operator
// or Task 10's reconciliation resolves it (Safety Invariant #11).
async function executeDayTradeEntry({
    intent, clientOrderId, client, policy = DEFAULT_DAY_TRADE_POLICY, holderId, leaseDurationMs = 30_000, now = new Date(),
}) {
    const key = String(clientOrderId || '').trim();
    if (!key) throw executionError('ALPACA_CLIENT_ORDER_ID_REQUIRED', 'a client order id is required to submit a Day Trading entry');

    const lease = await store.acquireSubmissionLease({ holderId, leaseDurationMs, now });
    if (!lease.acquired) {
        throw executionError('ALPACA_LEASE_UNAVAILABLE', 'the durable Day Trading submission lease is held by another process');
    }

    try {
        const symbol = String(intent?.symbol || '').trim().toUpperCase();

        // Every check in this block reads only the local database, deliberately before any
        // network call (including the quote fetch): a replay or a globally-blocked account
        // must resolve without ever touching the broker, and must not fail on an incidental
        // network-layer mismatch (e.g. fetching a quote for a symbol that gets rejected for an
        // unrelated reason) before the real, DB-backed reason is ever evaluated.
        const existing = await store.getOrderAuditByIdempotencyKey(key);
        if (existing) {
            // idempotency_key is UNIQUE database-wide, so this lookup can surface a
            // legacy_long_term/legacy_unattributed row. Such a row must never be treated as a
            // Day Trading replay: it never went through Task 7's validation, its stop/target
            // prices are NULL (which would otherwise coincidentally "match" an intent supplying
            // 0/null), and its plan_id is NULL. The key is genuinely already taken, so this is a
            // conflict, not a replay, regardless of content.
            if (existing.execution_epoch !== 'day_trading' || !intentMatchesExistingAudit(intent, existing)) {
                throw executionError('ALPACA_IDEMPOTENCY_KEY_CONFLICT', `client order id ${key} was already used for a different order`);
            }
            if (UNRESOLVED_ORDER_STATUSES.includes(existing.status)) {
                throw executionError('ALPACA_RECONCILIATION_REQUIRED', `Day Trading order ${key} is unresolved and must be reconciled before retrying`);
            }
            const plan = await store.getPlan(existing.plan_id);
            if (!plan) {
                throw executionError('ALPACA_PLAN_NOT_FOUND', `Day Trading order ${key} has no associated plan; cannot be safely replayed`);
            }
            const replayEventKey = `entry:${plan.id}:${key}:replay`;
            const existingReplayEvent = await store.getEventByKey(replayEventKey);
            await store.appendEvent({
                event_key: replayEventKey, plan_id: plan.id, event_type: 'entry_replay',
                action: 'submit_entry', outcome: 'replayed', reason: 'idempotent_replay',
                detail: { symbol: plan.symbol, qty: plan.planned_qty }, occurred_at: existingReplayEvent?.occurred_at || new Date(now).toISOString(),
            });
            return { replayed: true, plan, order: existing };
        }

        // Replays above never reach the broker; a new submission must see the gates open now that
        // the lease is held.
        await assertEntryGatesOpen();

        const allAudits = await store.listOrderAudits();
        const dtAudits = allAudits.filter((audit) => audit.execution_epoch === 'day_trading');
        if (dtAudits.some((audit) => UNRESOLVED_ORDER_STATUSES.includes(audit.status))) {
            throw executionError('ALPACA_RECONCILIATION_REQUIRED', 'an unresolved Day Trading order audit exists and must be reconciled before another submission');
        }

        const [account, asset, clock, openOrders] = await Promise.all([
            client.getAccount(), client.getAsset(symbol), client.getClock(), client.getOrders({ status: 'open' }),
        ]);
        // Fetched fresh, after the lease is held and every DB-only gate has passed: Task 6's
        // freshness bound is 10 seconds, and fetching the quote any earlier would let lease
        // contention or the atomic plan write eat into that budget before the price is used.
        const quote = await getProvenQuote({
            client, symbol, now, feed: policy.feed, maxAgeMs: policy.maxQuoteAgeMs,
        });

        const cashAfterCommitments = Number(account?.cash) - committedDayTradeBuyCash(openOrders, dtAudits);
        const allPlans = await store.listPlans(null);
        const nonterminalPlans = allPlans.filter((plan) => !TERMINAL_PLAN_STATES.includes(plan.state));
        const sessionDate = String(now instanceof Date ? now.toISOString() : now).slice(0, 10);
        const dailyRealizedPnl = computeDailyRealizedPnl(allPlans, sessionDate);
        const riskContext = {
            hasActivePlanForSymbol: nonterminalPlans.some((plan) => plan.symbol === symbol),
            currentOpenRiskDollars: nonterminalPlans.reduce((total, plan) => total + Number(plan.planned_risk_dollars || 0), 0),
            dailyRealizedPnl,
        };

        const built = buildDayTradeBracketOrder({
            intent, quote, clock, asset, riskContext, policy, now, account: { ...account, cash: cashAfterCommitments },
        });
        const { order, entryPrice, stopPrice, targetPrice, plannedRiskDollars, plannedRewardRisk } = built;

        // Second check, as late as possible: the broker reads and quote fetch above can take
        // seconds, during which the monitor may have latched the kill switch.
        await assertEntryGatesOpen();

        const { plan, order: auditRow } = await store.createPlanWithEntry(
            {
                symbol,
                setup: intent.setup,
                catalyst: intent.catalyst,
                thesis: intent.thesis,
                invalidation: intent.invalidation,
                // No entry-zone concept exists in the caller intent (Section 7) or in Task 7's
                // output — this is a single computed price, not a range, so both bounds
                // collapse to it rather than fabricating a zone that was never observed.
                planned_entry_low: entryPrice,
                planned_entry_high: entryPrice,
                planned_stop: stopPrice,
                planned_target: targetPrice,
                planned_qty: order.qty,
                planned_risk_dollars: plannedRiskDollars,
                planned_reward_risk: plannedRewardRisk,
                planned_account_risk_pct: plannedRiskDollars / Number(account.equity),
                exit_deadline: String(intent.exit_deadline),
            },
            {
                idempotency_key: key,
                client_order_id: key,
                symbol,
                side: 'buy',
                qty: order.qty,
                order_type: 'limit',
                time_in_force: 'day',
                limit_price: order.limit_price,
                stop_price: order.stop_loss.stop_price,
                take_profit_price: order.take_profit.limit_price,
                status: 'pending_submission',
                order_class: 'bracket',
            },
        );

        const occurredAt = new Date(now).toISOString();
        await store.appendEvent({
            event_key: `entry:${plan.id}:${key}:intent`, plan_id: plan.id, event_type: 'entry_intent',
            action: 'submit_entry', outcome: 'planned', reason: null,
            detail: {
                symbol, setup: intent.setup, catalyst: intent.catalyst, thesis: intent.thesis,
                invalidation: intent.invalidation, planned_qty: order.qty, planned_stop: stopPrice,
                planned_target: targetPrice, planned_risk_dollars: plannedRiskDollars,
            }, occurred_at: occurredAt,
        });
        await store.appendEvent({
            event_key: `entry:${plan.id}:${key}:submission`, plan_id: plan.id, event_type: 'entry_submission',
            action: 'submit_entry', outcome: 'started', reason: null,
            detail: { symbol, qty: order.qty, order_type: 'limit' }, occurred_at: occurredAt,
        });

        try {
            const brokerOrder = { ...order, client_order_id: key };
            const brokerResult = await client.submitOrder(brokerOrder);
            const brokerStatus = String(brokerResult.status || 'submitted');
            await store.updateOrderAudit(key, { status: brokerStatus, broker_order_id: brokerResult.id || null, broker_payload: { status: brokerStatus } });
            await store.updatePlan(plan.id, { entry_parent_broker_order_id: brokerResult.id || null });
            await store.appendEvent({
                event_key: `entry:${plan.id}:${key}:outcome`, plan_id: plan.id, event_type: 'entry_outcome',
                action: 'submit_entry', outcome: 'acknowledged', reason: brokerStatus,
                detail: { symbol, qty: order.qty, status: brokerStatus }, occurred_at: occurredAt,
            });
            return {
                plan: { ...plan, entry_parent_broker_order_id: brokerResult.id || null },
                order: { ...auditRow, status: brokerStatus, broker_order_id: brokerResult.id || null },
            };
        } catch (submissionError) {
            const rejected = submissionError.code === 'ALPACA_BROKER_REJECTED';
            await store.updateOrderAudit(key, {
                status: rejected ? 'submission_rejected' : 'submission_unknown',
                broker_payload: { error: rejected ? 'broker_rejected' : 'submission_outcome_unknown', status: submissionError.status || null },
            });
            await store.appendEvent({
                event_key: `entry:${plan.id}:${key}:outcome`, plan_id: plan.id, event_type: 'entry_outcome',
                action: 'submit_entry', outcome: rejected ? 'rejected' : 'unknown',
                reason: rejected ? 'broker_rejected' : 'submission_outcome_unknown',
                detail: { symbol, qty: order.qty, status: submissionError.status || null }, occurred_at: occurredAt,
            });
            if (rejected) {
                await store.updatePlan(plan.id, { state: 'error' });
                throw submissionError;
            }
            throw executionError('ALPACA_SUBMISSION_UNKNOWN', `Day Trading order submission outcome is ambiguous: ${submissionError.message}`);
        }
    } finally {
        await store.releaseSubmissionLease({ holderId });
    }
}

module.exports = { executeDayTradeEntry, committedDayTradeBuyCash };
