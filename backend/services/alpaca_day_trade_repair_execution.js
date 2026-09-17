const store = require('./alpaca_day_trade_store');

const UNRESOLVED_ORDER_STATUSES = ['pending_submission', 'submission_unknown', 'submission_failed'];

function executionError(code, message) {
    return Object.assign(new Error(message), { code });
}

function assertWholeShareQty(qty) {
    if (!Number.isInteger(qty) || qty <= 0) {
        throw executionError('ALPACA_QTY_INVALID', 'a management action requires a positive whole number of shares');
    }
}

// The complete surface decidePlanAction can emit: five things to construct (one of which,
// cancel, isn't a new order at all) and 'none'. Each submit action gets its own deterministic
// client order id (Safety Invariant #9) and leg_role (Task 4's enum already has repair_exit,
// time_exit, and emergency_flatten for exactly these). buy_to_cover reuses emergency_flatten --
// no dedicated leg_role exists for it and adding one is a schema change out of scope here; it
// is, in substance, the same kind of emergency safety action.
function buildManagementOrder(decision, plan) {
    const qty = decision.details?.qty;
    assertWholeShareQty(qty);

    if (decision.action === 'attach_protective_oco') {
        return {
            key: `dt-repair-${plan.id}`,
            legRole: 'repair_exit',
            order: {
                symbol: plan.symbol, side: 'sell', qty, type: 'limit', limit_price: plan.planned_target,
                time_in_force: 'day', order_class: 'oco',
                take_profit: { limit_price: plan.planned_target },
                stop_loss: { stop_price: plan.planned_stop }, // never limit_price: stop-market, not stop-limit
            },
        };
    }
    if (decision.action === 'flatten') {
        return {
            key: `dt-flatten-${plan.id}`,
            legRole: 'emergency_flatten',
            order: { symbol: plan.symbol, side: 'sell', qty, type: 'market', time_in_force: 'day' },
        };
    }
    if (decision.action === 'submit_time_exit') {
        return {
            key: `dt-timeexit-${plan.id}`,
            legRole: 'time_exit',
            order: { symbol: plan.symbol, side: 'sell', qty, type: 'market', time_in_force: 'day' },
        };
    }
    if (decision.action === 'buy_to_cover') {
        return {
            key: `dt-cover-${plan.id}`,
            legRole: 'emergency_flatten',
            order: { symbol: plan.symbol, side: 'buy', qty, type: 'market', time_in_force: 'day' },
        };
    }
    throw executionError('ALPACA_UNKNOWN_MANAGEMENT_ACTION', `no order construction exists for action ${decision.action}`);
}

function intentMatchesExistingAudit(order, audit) {
    return audit.symbol === order.symbol && audit.side === order.side && Number(audit.qty) === order.qty;
}

// Mirrors executeDayTradeEntry's lease + idempotency-key + ambiguity-classification discipline
// (Task 8), applied to management orders instead of entries: this is the second process
// Safety Invariant #10 was written about, and a repair/flatten/cover order that bypassed the
// same durable lease would reintroduce exactly the cross-process race that invariant closes.
async function submitManagementOrder({
    key, legRole, order, plan, client, holderId, leaseDurationMs = 30_000, now = new Date(),
}) {
    const lease = await store.acquireSubmissionLease({ holderId, leaseDurationMs, now });
    if (!lease.acquired) {
        throw executionError('ALPACA_LEASE_UNAVAILABLE', 'the durable Day Trading submission lease is held by another process');
    }

    try {
        const existing = await store.getOrderAuditByIdempotencyKey(key);
        if (existing) {
            if (existing.execution_epoch !== 'day_trading' || !intentMatchesExistingAudit(order, existing)) {
                throw executionError('ALPACA_IDEMPOTENCY_KEY_CONFLICT', `client order id ${key} was already used for a different order`);
            }
            if (UNRESOLVED_ORDER_STATUSES.includes(existing.status)) {
                throw executionError('ALPACA_RECONCILIATION_REQUIRED', `management order ${key} is unresolved and must be reconciled before retrying`);
            }
            return { replayed: true, order: existing };
        }

        const dtAudits = (await store.listOrderAudits()).filter((audit) => audit.execution_epoch === 'day_trading');
        if (dtAudits.some((audit) => UNRESOLVED_ORDER_STATUSES.includes(audit.status))) {
            throw executionError('ALPACA_RECONCILIATION_REQUIRED', 'an unresolved Day Trading order audit exists and must be reconciled before another submission');
        }

        const auditRow = await store.createOrderAudit({
            idempotency_key: key,
            client_order_id: key,
            symbol: order.symbol,
            side: order.side,
            qty: order.qty,
            order_type: order.type,
            time_in_force: order.time_in_force,
            limit_price: order.limit_price ?? null,
            stop_price: order.stop_loss?.stop_price ?? null,
            take_profit_price: order.take_profit?.limit_price ?? null,
            status: 'pending_submission',
            execution_epoch: 'day_trading',
            order_class: order.order_class || 'simple',
            leg_role: legRole,
            plan_id: plan.id,
        });

        try {
            const brokerOrder = { ...order, client_order_id: key };
            const brokerResult = await client.submitOrder(brokerOrder);
            const brokerStatus = String(brokerResult.status || 'submitted');
            await store.updateOrderAudit(key, { status: brokerStatus, broker_order_id: brokerResult.id || null, broker_payload: { status: brokerStatus } });
            return { order: { ...auditRow, status: brokerStatus, broker_order_id: brokerResult.id || null } };
        } catch (submissionError) {
            const rejected = submissionError.code === 'ALPACA_BROKER_REJECTED';
            await store.updateOrderAudit(key, {
                status: rejected ? 'submission_rejected' : 'submission_unknown',
                broker_payload: { error: rejected ? 'broker_rejected' : 'submission_outcome_unknown', status: submissionError.status || null },
            });
            if (rejected) throw submissionError;
            throw executionError('ALPACA_SUBMISSION_UNKNOWN', `management order submission outcome is ambiguous: ${submissionError.message}`);
        }
    } finally {
        await store.releaseSubmissionLease({ holderId });
    }
}

// cancel_unfilled_remainder targets an *existing* order by its own broker id; Alpaca's cancel
// endpoint takes no client_order_id and is already naturally idempotent (alpaca_paper_service's
// cancelOrder reports {canceled:false, reason:'not_found'} rather than throwing when a cancel
// races a fill or an earlier cancel) -- it does not need a new audit row of its own, but it
// still goes through the same lease to serialize with other management actions on this account.
async function executeManagementAction(decision, plan, { client, holderId, leaseDurationMs = 30_000, now = new Date() }) {
    if (decision.action === 'none') {
        return { skipped: true };
    }
    if (decision.action === 'cancel_unfilled_remainder') {
        const lease = await store.acquireSubmissionLease({ holderId, leaseDurationMs, now });
        if (!lease.acquired) {
            throw executionError('ALPACA_LEASE_UNAVAILABLE', 'the durable Day Trading submission lease is held by another process');
        }
        try {
            const result = await client.cancelOrder(plan.entry_parent_broker_order_id);
            return { action: decision.action, result };
        } finally {
            await store.releaseSubmissionLease({ holderId });
        }
    }

    const { key, legRole, order } = buildManagementOrder(decision, plan);
    return submitManagementOrder({
        key, legRole, order, plan, client, holderId, leaseDurationMs, now,
    });
}

module.exports = { executeManagementAction };
