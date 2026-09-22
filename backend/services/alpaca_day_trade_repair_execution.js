const store = require('./alpaca_day_trade_store');

const UNRESOLVED_ORDER_STATUSES = ['pending_submission', 'submission_unknown', 'submission_failed'];
const FINAL_STATUSES = [
    'filled', 'canceled', 'expired', 'rejected', 'replaced', 'done_for_day',
    'stopped', 'suspended', 'submission_rejected', 'submission_not_found',
];

function executionError(code, message) {
    return Object.assign(new Error(message), { code });
}

function assertWholeShareQty(qty) {
    if (!Number.isInteger(qty) || qty <= 0) {
        throw executionError('ALPACA_QTY_INVALID', 'a management action requires a positive whole number of shares');
    }
}

function buildManagementOrder(decision, plan, n = 1) {
    const qty = decision.details?.qty;
    assertWholeShareQty(qty);
    const suffix = n != null ? `-a${n}` : '';

    if (decision.action === 'attach_protective_oco') {
        return {
            key: `dt-repair-${plan.id}${suffix}`,
            base: 'dt-repair',
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
            key: `dt-flatten-${plan.id}${suffix}`,
            base: 'dt-flatten',
            legRole: 'emergency_flatten',
            order: { symbol: plan.symbol, side: 'sell', qty, type: 'market', time_in_force: 'day' },
        };
    }
    if (decision.action === 'submit_time_exit') {
        return {
            key: `dt-timeexit-${plan.id}${suffix}`,
            base: 'dt-timeexit',
            legRole: 'time_exit',
            order: { symbol: plan.symbol, side: 'sell', qty, type: 'market', time_in_force: 'day' },
        };
    }
    if (decision.action === 'buy_to_cover') {
        return {
            key: `dt-cover-${plan.id}${suffix}`,
            base: 'dt-cover',
            legRole: 'emergency_flatten',
            order: { symbol: plan.symbol, side: 'buy', qty, type: 'market', time_in_force: 'day' },
        };
    }
    throw executionError('ALPACA_UNKNOWN_MANAGEMENT_ACTION', `no order construction exists for action ${decision.action}`);
}

function intentMatchesExistingAudit(order, audit) {
    return audit.symbol === order.symbol && audit.side === order.side && Number(audit.qty) === order.qty;
}

// B2b: Resolves ambiguous audits by querying the broker by client order ID instead of blocking indefinitely.
async function resolveAmbiguousAudits({ client, now = new Date() }) {
    if (!client || typeof client.getOrderByClientOrderId !== 'function') return;
    const allAudits = await store.listOrderAudits();
    const ambiguous = allAudits.filter(
        (a) => a.execution_epoch === 'day_trading' && UNRESOLVED_ORDER_STATUSES.includes(a.status),
    );
    for (const audit of ambiguous) {
        try {
            const lookup = await client.getOrderByClientOrderId(audit.idempotency_key);
            if (lookup && lookup.found && lookup.order) {
                const brokerStatus = String(lookup.order.status || '').toLowerCase();
                await store.updateOrderAudit(audit.idempotency_key, {
                    status: brokerStatus,
                    broker_order_id: lookup.order.id || audit.broker_order_id || null,
                    broker_payload: { status: brokerStatus },
                });
                audit.status = brokerStatus;
                audit.broker_order_id = lookup.order.id || audit.broker_order_id || null;
            } else if (lookup && !lookup.found) {
                const createdAt = audit.created_at ? new Date(audit.created_at) : null;
                if (createdAt && now.getTime() - createdAt.getTime() > 60_000) {
                    await store.updateOrderAudit(audit.idempotency_key, {
                        status: 'submission_not_found',
                        broker_payload: { status: 'submission_not_found' },
                    });
                    audit.status = 'submission_not_found';
                }
            }
        } catch (_err) {
            // Broker lookup throw leaves audit as is
        }
    }
}

// B4: Inner submission function that assumes the submission lease is already held.
async function submitManagementOrderUnlocked({
    action, base, legRole, order, plan, client, now = new Date(),
}) {
    // B2b: Attempt to resolve ambiguous audits across day_trading execution epoch
    await resolveAmbiguousAudits({ client, now });

    const allAudits = await store.listOrderAudits();
    const dtAudits = allAudits.filter((a) => a.execution_epoch === 'day_trading');

    // Scoped unresolved audit guard: exit actions only fail closed on unresolved audits for the SAME plan
    const isExitAction = ['flatten', 'submit_time_exit', 'buy_to_cover'].includes(action);
    const unresolved = dtAudits.filter((a) => UNRESOLVED_ORDER_STATUSES.includes(a.status));
    if (isExitAction) {
        if (unresolved.some((a) => Number(a.plan_id) === plan.id)) {
            throw executionError('ALPACA_RECONCILIATION_REQUIRED', 'an unresolved Day Trading order audit exists for this plan and must be reconciled before another submission');
        }
    } else {
        if (unresolved.length > 0) {
            throw executionError('ALPACA_RECONCILIATION_REQUIRED', 'an unresolved Day Trading order audit exists and must be reconciled before another submission');
        }
    }

    // Filter audits for this plan matching the base regex /^<base>-<planId>(-a(\d+))?$/
    const baseRegex = new RegExp(`^${base}-${plan.id}(-a(\\d+))?$`);
    const planBaseAudits = dtAudits.filter(
        (a) => Number(a.plan_id) === plan.id && baseRegex.test(a.idempotency_key),
    );

    // EXIT BASES ARE ONE FAMILY: for 'flatten' and 'submit_time_exit', the live-order check
    // considers BOTH dt-timeexit and dt-flatten audits of the plan.
    let familyAudits;
    if (['flatten', 'submit_time_exit'].includes(action)) {
        const flattenRegex = new RegExp(`^dt-flatten-${plan.id}(-a(\\d+))?$`);
        const timeexitRegex = new RegExp(`^dt-timeexit-${plan.id}(-a(\\d+))?$`);
        familyAudits = dtAudits.filter(
            (a) => Number(a.plan_id) === plan.id && (flattenRegex.test(a.idempotency_key) || timeexitRegex.test(a.idempotency_key)),
        );
    } else {
        familyAudits = planBaseAudits;
    }

    // Live order check: latest audit within the family
    familyAudits.sort((a, b) => b.id - a.id);
    const latestFamilyAudit = familyAudits[0];

    if (latestFamilyAudit) {
        // Refresh latest audit status if not final and broker_order_id exists
        if (latestFamilyAudit.broker_order_id && !FINAL_STATUSES.includes(latestFamilyAudit.status)) {
            const freshBrokerOrder = await client.getOrder(latestFamilyAudit.broker_order_id);
            const freshStatus = String(freshBrokerOrder?.status || '').toLowerCase();
            if (freshStatus && freshStatus !== latestFamilyAudit.status) {
                await store.updateOrderAudit(latestFamilyAudit.idempotency_key, {
                    status: freshStatus,
                    broker_payload: { status: freshStatus },
                });
                latestFamilyAudit.status = freshStatus;
            }
        }

        if (UNRESOLVED_ORDER_STATUSES.includes(latestFamilyAudit.status)) {
            throw executionError('ALPACA_RECONCILIATION_REQUIRED', `management order ${latestFamilyAudit.idempotency_key} is unresolved and must be reconciled before retrying`);
        }

        if (!FINAL_STATUSES.includes(latestFamilyAudit.status)) {
            // Live order already open. For the EXIT FAMILY only, a live exit order is replayed REGARDLESS of qty.
            const isExitFamily = ['flatten', 'submit_time_exit'].includes(action);
            if (isExitFamily) {
                if (latestFamilyAudit.symbol !== order.symbol || latestFamilyAudit.side !== order.side) {
                    throw executionError('ALPACA_IDEMPOTENCY_KEY_CONFLICT', `client order id ${latestFamilyAudit.idempotency_key} was already used for a different order`);
                }
            } else {
                if (!intentMatchesExistingAudit(order, latestFamilyAudit)) {
                    throw executionError('ALPACA_IDEMPOTENCY_KEY_CONFLICT', `client order id ${latestFamilyAudit.idempotency_key} was already used for a different order`);
                }
            }
            return { replayed: true, outcome: 'replayed_live_order', order: latestFamilyAudit };
        }
    }

    // Determine attempt counter n for this specific base
    let maxN = 0;
    for (const audit of planBaseAudits) {
        const match = audit.idempotency_key.match(baseRegex);
        if (match) {
            const attemptNum = match[2] ? Number(match[2]) : 1;
            if (attemptNum > maxN) maxN = attemptNum;
        }
    }

    const n = maxN === 0 ? 1 : maxN + 1;
    if (n > 10) {
        throw executionError('ALPACA_MANAGEMENT_ATTEMPTS_EXHAUSTED', `maximum management order attempts exhausted for base ${base}`);
    }

    const key = `${base}-${plan.id}-a${n}`;

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
        await store.updateOrderAudit(key, {
            status: brokerStatus,
            broker_order_id: brokerResult.id || null,
            broker_payload: { status: brokerStatus },
        });
        return { order: { ...auditRow, status: brokerStatus, broker_order_id: brokerResult.id || null } };
    } catch (submissionError) {
        const rejected = submissionError.code === 'ALPACA_BROKER_REJECTED';
        await store.updateOrderAudit(key, {
            status: rejected ? 'submission_rejected' : 'submission_unknown',
            broker_payload: {
                error: rejected ? 'broker_rejected' : 'submission_outcome_unknown',
                status: submissionError.status || null,
                broker_code: submissionError.brokerCode ?? null,
                broker_message: submissionError.brokerMessage ?? null,
            },
        });
        if (rejected) throw submissionError;
        const err = executionError('ALPACA_SUBMISSION_UNKNOWN', `management order submission outcome is ambiguous: ${submissionError.message}`);
        err.status = submissionError.status ?? null;
        err.brokerCode = submissionError.brokerCode ?? null;
        err.brokerMessage = submissionError.brokerMessage ?? null;
        throw err;
    }
}

// Lease wrapper for submitManagementOrder
async function submitManagementOrder({
    action, base, legRole, order, plan, client, holderId, leaseDurationMs = 30_000, now = new Date(),
}) {
    const lease = await store.acquireSubmissionLease({ holderId, leaseDurationMs, now });
    if (!lease.acquired) {
        throw executionError('ALPACA_LEASE_UNAVAILABLE', 'the durable Day Trading submission lease is held by another process');
    }

    try {
        return await submitManagementOrderUnlocked({
            action, base, legRole, order, plan, client, now,
        });
    } finally {
        await store.releaseSubmissionLease({ holderId });
    }
}

// C: Exit sequence for 'flatten' and 'submit_time_exit'.
// Incident Rationale (2026-09-22):
// Open bracket protective legs (stop/target) reserve shares on the broker side, causing Alpaca
// to reject market sell orders with HTTP 403 "insufficient qty available". The exit sequence
// cancels all protective bracket/OCO legs first, verifies they reach a terminal state, refreshes
// the true broker position, submits the market sell for the fresh quantity, and verifies flat.
async function executeExitSequence(decision, plan, {
    client, holderId, leaseDurationMs = 60_000, now = new Date(),
    exitPolicy: userExitPolicy, sleep: userSleep,
}) {
    const exitPolicy = {
        legTerminalTimeoutMs: 10_000,
        flatVerifyTimeoutMs: 10_000,
        pollIntervalMs: 500,
        ...userExitPolicy,
    };
    const sleep = userSleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    const lease = await store.acquireSubmissionLease({ holderId, leaseDurationMs, now });
    if (!lease.acquired) {
        throw executionError('ALPACA_LEASE_UNAVAILABLE', 'the durable Day Trading submission lease is held by another process');
    }

    try {
        const planAudits = (await store.listOrderAudits()).filter(
            (a) => a.execution_epoch === 'day_trading' && Number(a.plan_id) === plan.id,
        );

        // Check if an exit order in this plan's family is already live
        const flattenRegex = new RegExp(`^dt-flatten-${plan.id}(-a(\\d+))?$`);
        const timeexitRegex = new RegExp(`^dt-timeexit-${plan.id}(-a(\\d+))?$`);
        const familyAudits = planAudits.filter(
            (a) => flattenRegex.test(a.idempotency_key) || timeexitRegex.test(a.idempotency_key),
        );
        familyAudits.sort((a, b) => b.id - a.id);
        const latestFamilyAudit = familyAudits[0];
        if (latestFamilyAudit) {
            if (latestFamilyAudit.broker_order_id && !FINAL_STATUSES.includes(latestFamilyAudit.status)) {
                const freshBrokerOrder = await client.getOrder(latestFamilyAudit.broker_order_id);
                const freshStatus = String(freshBrokerOrder?.status || '').toLowerCase();
                if (freshStatus && freshStatus !== latestFamilyAudit.status) {
                    await store.updateOrderAudit(latestFamilyAudit.idempotency_key, {
                        status: freshStatus,
                        broker_payload: { status: freshStatus },
                    });
                    latestFamilyAudit.status = freshStatus;
                }
            }
            if (UNRESOLVED_ORDER_STATUSES.includes(latestFamilyAudit.status)) {
                throw executionError('ALPACA_RECONCILIATION_REQUIRED', `an unresolved Day Trading order audit exists for this plan and must be reconciled before another submission`);
            }
            if (!FINAL_STATUSES.includes(latestFamilyAudit.status)) {
                // Live exit-family order is replayed regardless of qty (it was sized to the position when submitted;
                // the legs were already cancelled). Run the C6 flat-verification poll.
                const flatDeadline = Date.now() + exitPolicy.flatVerifyTimeoutMs;
                let flat = false;
                while (true) {
                    const currentPos = await client.getPosition(plan.symbol);
                    const currentQty = currentPos ? Number(currentPos.qty) : 0;
                    if (!currentPos || currentQty === 0) {
                        flat = true;
                        break;
                    }
                    if (Date.now() >= flatDeadline) break;
                    await sleep(exitPolicy.pollIntervalMs);
                }
                return {
                    action: decision.action,
                    outcome: flat ? 'flat_verified' : 'replayed_live_order',
                    flatVerified: flat,
                    replayed: true,
                    order: latestFamilyAudit,
                };
            }
        }

        // C1. Collect protective order IDs to cancel (Day-Trading owned only)
        const targetIdsSet = new Set();
        if (plan.protective_stop_broker_order_id) targetIdsSet.add(plan.protective_stop_broker_order_id);
        if (plan.protective_target_broker_order_id) targetIdsSet.add(plan.protective_target_broker_order_id);

        if (plan.entry_parent_broker_order_id) {
            // Cancel unfilled entry remainder so it cannot fill after the exit and reopen the position
            targetIdsSet.add(plan.entry_parent_broker_order_id);
            try {
                const parentOrder = await client.getOrder(plan.entry_parent_broker_order_id, { nested: true });
                if (Array.isArray(parentOrder?.legs)) {
                    for (const leg of parentOrder.legs) {
                        if (leg?.id) targetIdsSet.add(leg.id);
                    }
                }
            } catch (err) {
                if (err.status !== 404) throw err;
            }
        }

        const repairAudits = planAudits.filter((a) => a.leg_role === 'repair_exit' && a.broker_order_id);
        for (const ra of repairAudits) {
            targetIdsSet.add(ra.broker_order_id);
            try {
                const repairOrder = await client.getOrder(ra.broker_order_id, { nested: true });
                if (Array.isArray(repairOrder?.legs)) {
                    for (const leg of repairOrder.legs) {
                        if (leg?.id) targetIdsSet.add(leg.id);
                    }
                }
            } catch (err) {
                if (err.status !== 404) throw err;
            }
        }

        // Exclude this plan's own exit audits (time_exit / emergency_flatten)
        const exitOrderIds = new Set(
            planAudits
                .filter((a) => ['time_exit', 'emergency_flatten'].includes(a.leg_role) && a.broker_order_id)
                .map((a) => a.broker_order_id),
        );
        for (const id of exitOrderIds) {
            targetIdsSet.delete(id);
        }

        const targetIds = Array.from(targetIdsSet).filter(Boolean);

        // C2. Fetch each order; if final skip, else cancelOrder
        for (const id of targetIds) {
            let order;
            try {
                order = await client.getOrder(id);
            } catch (err) {
                if (err.status === 404) continue;
                throw err;
            }
            const s = String(order?.status || '').toLowerCase();
            if (FINAL_STATUSES.includes(s)) continue;

            try {
                const cancelRes = await client.cancelOrder(id);
                if (cancelRes && cancelRes.canceled === false && cancelRes.reason === 'not_found') {
                    continue;
                }
            } catch (err) {
                if (err.status === 422 || err.status === 404) {
                    continue;
                }
                throw err;
            }
        }

        // C3. Poll until all target orders reach a terminal status
        const legDeadline = Date.now() + exitPolicy.legTerminalTimeoutMs;
        while (true) {
            const nonFinal = [];
            for (const id of targetIds) {
                try {
                    const order = await client.getOrder(id);
                    const s = String(order?.status || '').toLowerCase();
                    if (!FINAL_STATUSES.includes(s)) {
                        nonFinal.push({ id, status: s });
                    }
                } catch (err) {
                    if (err.status !== 404) throw err;
                }
            }
            if (nonFinal.length === 0) break;
            if (Date.now() >= legDeadline) {
                const list = nonFinal.map((nf) => `${nf.id}: ${nf.status}`).join(', ');
                throw executionError('ALPACA_EXIT_LEGS_NOT_TERMINAL', `protective legs did not reach terminal state within timeout: ${list}`);
            }
            await sleep(exitPolicy.pollIntervalMs);
        }

        // C4. Refresh position
        const pos = await client.getPosition(plan.symbol);
        const qty = pos ? Number(pos.qty) : 0;
        if (!pos || qty === 0) {
            return { action: decision.action, outcome: 'already_flat', flatVerified: true };
        }
        if (pos.side === 'short' || qty < 0) {
            throw executionError('ALPACA_EXIT_UNEXPECTED_SHORT', `position for ${plan.symbol} is unexpectedly short (${qty})`);
        }
        assertWholeShareQty(qty);

        // C5. Submit market sell with refreshed quantity
        const base = decision.action === 'submit_time_exit' ? 'dt-timeexit' : 'dt-flatten';
        const legRole = decision.action === 'submit_time_exit' ? 'time_exit' : 'emergency_flatten';
        const order = { symbol: plan.symbol, side: 'sell', qty, type: 'market', time_in_force: 'day' };

        const submitResult = await submitManagementOrderUnlocked({
            action: decision.action,
            base,
            legRole,
            order,
            plan,
            client,
            now,
        });

        // C6. Verify flat
        const flatDeadline = Date.now() + exitPolicy.flatVerifyTimeoutMs;
        let flat = false;
        while (true) {
            const currentPos = await client.getPosition(plan.symbol);
            const currentQty = currentPos ? Number(currentPos.qty) : 0;
            if (!currentPos || currentQty === 0) {
                flat = true;
                break;
            }
            if (Date.now() >= flatDeadline) break;
            await sleep(exitPolicy.pollIntervalMs);
        }

        const isReplay = Boolean(submitResult.replayed);
        return {
            action: decision.action,
            outcome: flat ? 'flat_verified' : (isReplay ? 'replayed_live_order' : 'exit_submitted_unverified'),
            flatVerified: flat,
            replayed: isReplay,
            order: submitResult.order,
        };
    } finally {
        await store.releaseSubmissionLease({ holderId });
    }
}

// cancel_unfilled_remainder targets an *existing* order by its own broker id; Alpaca's cancel
// endpoint takes no client_order_id and is already naturally idempotent -- it does not need a
// new audit row of its own, but it still goes through the same lease to serialize with other
// management actions on this account.
async function executeManagementAction(decision, plan, deps) {
    const { client, holderId, leaseDurationMs = 30_000, now = new Date() } = deps;
    if (decision.action === 'none') {
        return { skipped: true };
    }
    if (decision.details && decision.details.qty != null) {
        assertWholeShareQty(decision.details.qty);
    }
    if (decision.action === 'cancel_unfilled_remainder') {
        const lease = await store.acquireSubmissionLease({ holderId, leaseDurationMs, now });
        if (!lease.acquired) {
            throw executionError('ALPACA_LEASE_UNAVAILABLE', 'the durable Day Trading submission lease is held by another process');
        }
        try {
            try {
                const result = await client.cancelOrder(plan.entry_parent_broker_order_id);
                return { action: decision.action, result };
            } catch (error) {
                if (error.status === 422) {
                    return { action: decision.action, result: { canceled: false, reason: 'not_cancelable' } };
                }
                throw error;
            }
        } finally {
            await store.releaseSubmissionLease({ holderId });
        }
    }

    if (decision.action === 'flatten' || decision.action === 'submit_time_exit') {
        return executeExitSequence(decision, plan, deps);
    }

    const qty = decision.details?.qty;
    assertWholeShareQty(qty);

    let base;
    let legRole;
    let order;
    if (decision.action === 'attach_protective_oco') {
        base = 'dt-repair';
        legRole = 'repair_exit';
        order = {
            symbol: plan.symbol, side: 'sell', qty, type: 'limit', limit_price: plan.planned_target,
            time_in_force: 'day', order_class: 'oco',
            take_profit: { limit_price: plan.planned_target },
            stop_loss: { stop_price: plan.planned_stop },
        };
    } else if (decision.action === 'buy_to_cover') {
        base = 'dt-cover';
        legRole = 'emergency_flatten';
        order = { symbol: plan.symbol, side: 'buy', qty, type: 'market', time_in_force: 'day' };
    } else {
        throw executionError('ALPACA_UNKNOWN_MANAGEMENT_ACTION', `no order construction exists for action ${decision.action}`);
    }

    return submitManagementOrder({
        action: decision.action,
        base,
        legRole,
        order,
        plan,
        client,
        holderId,
        leaseDurationMs,
        now,
    });
}

module.exports = { executeManagementAction };
