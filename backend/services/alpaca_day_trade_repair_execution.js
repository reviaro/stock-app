const store = require('./alpaca_day_trade_store');

// Alpaca status classifications:
// NON_EXECUTABLE_BROKER_STATUSES: the ONLY statuses that prove a broker order can no longer execute.
// Used by exit-sequence C2 (skip cancel) and C3 (verification).
// stopped = trade guaranteed but not yet occurred; suspended = not currently eligible, may resume;
// done_for_day = may trade next session; replaced = successor order exists.
const NON_EXECUTABLE_BROKER_STATUSES = ['filled', 'canceled', 'expired', 'rejected'];

// LOCAL_AUDIT_FINAL_STATUSES: used for management-audit attempt numbering / live-order replay decisions.
const LOCAL_AUDIT_FINAL_STATUSES = [...NON_EXECUTABLE_BROKER_STATUSES, 'submission_rejected', 'submission_not_found'];

const UNRESOLVED_ORDER_STATUSES = ['pending_submission', 'submission_unknown', 'submission_failed'];

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
    if (!client || typeof client.getOrderByClientOrderId !== 'function') return [];
    const allAudits = await store.listOrderAudits();
    const ambiguous = allAudits.filter(
        (a) => a.execution_epoch === 'day_trading' && UNRESOLVED_ORDER_STATUSES.includes(a.status),
    );
    const diagnostics = [];
    for (const audit of ambiguous) {
        const diag = {
            idempotency_key: audit.idempotency_key,
            plan_id: audit.plan_id != null ? Number(audit.plan_id) : null,
            resolved: false,
            reason: null,
            status: null,
            brokerCode: null,
            brokerMessage: null,
        };
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
                diag.resolved = true;
                diag.reason = 'resolved';
                diag.status = lookup.order.status || null;
            } else if (lookup && !lookup.found) {
                const createdAt = audit.created_at ? new Date(audit.created_at) : null;
                if (createdAt && now.getTime() - createdAt.getTime() > 60_000) {
                    await store.updateOrderAudit(audit.idempotency_key, {
                        status: 'submission_not_found',
                        broker_payload: { status: 'submission_not_found' },
                    });
                    audit.status = 'submission_not_found';
                    diag.resolved = true;
                    diag.reason = 'marked_not_found';
                } else {
                    diag.resolved = false;
                    diag.reason = 'within_ambiguity_window';
                }
            } else {
                diag.resolved = false;
                diag.reason = 'within_ambiguity_window';
            }
        } catch (err) {
            diag.resolved = false;
            diag.reason = 'lookup_failed';
            diag.status = err.status ?? null;
            diag.brokerCode = err.brokerCode ?? null;
            diag.brokerMessage = err.brokerMessage ?? null;
        }
        diagnostics.push(diag);
    }
    return diagnostics;
}

// B4: Inner submission function that assumes the submission lease is already held.
async function submitManagementOrderUnlocked({
    action, base, legRole, order, plan, client, now = new Date(), nowFn, renewalHook,
}) {
    const currentNow = nowFn ? nowFn() : now;
    // B2b: Attempt to resolve ambiguous audits across day_trading execution epoch
    const diagnostics = await resolveAmbiguousAudits({ client, now: currentNow });

    const allAudits = await store.listOrderAudits();
    const dtAudits = allAudits.filter((a) => a.execution_epoch === 'day_trading');

    // Scoped unresolved audit guard: exit actions only fail closed on unresolved audits for the SAME plan
    const isExitAction = ['flatten', 'submit_time_exit', 'buy_to_cover'].includes(action);
    const unresolved = dtAudits.filter((a) => UNRESOLVED_ORDER_STATUSES.includes(a.status));
    if (isExitAction) {
        const blockingAudits = unresolved.filter((a) => Number(a.plan_id) === plan.id);
        if (blockingAudits.length > 0) {
            const blockingKeys = new Set(blockingAudits.map((a) => a.idempotency_key));
            const blockingDiags = (diagnostics || []).filter((d) => blockingKeys.has(d.idempotency_key));
            const firstFailed = blockingDiags.find((d) => d.reason === 'lookup_failed');
            const err = executionError('ALPACA_RECONCILIATION_REQUIRED', 'an unresolved Day Trading order audit exists for this plan and must be reconciled before another submission');
            err.details = blockingDiags;
            if (firstFailed) {
                if (firstFailed.status != null) err.status = firstFailed.status;
                if (firstFailed.brokerCode != null) err.brokerCode = firstFailed.brokerCode;
                if (firstFailed.brokerMessage != null) err.brokerMessage = firstFailed.brokerMessage;
            }
            throw err;
        }
    } else {
        if (unresolved.length > 0) {
            const blockingKeys = new Set(unresolved.map((a) => a.idempotency_key));
            const blockingDiags = (diagnostics || []).filter((d) => blockingKeys.has(d.idempotency_key));
            const firstFailed = blockingDiags.find((d) => d.reason === 'lookup_failed');
            const err = executionError('ALPACA_RECONCILIATION_REQUIRED', 'an unresolved Day Trading order audit exists and must be reconciled before another submission');
            err.details = blockingDiags;
            if (firstFailed) {
                if (firstFailed.status != null) err.status = firstFailed.status;
                if (firstFailed.brokerCode != null) err.brokerCode = firstFailed.brokerCode;
                if (firstFailed.brokerMessage != null) err.brokerMessage = firstFailed.brokerMessage;
            }
            throw err;
        }
    }

    // Filter audits for this plan matching the base regex /^<base>-<planId>(-a(\d+))?$/
    const baseRegex = new RegExp(`^${base}-${plan.id}(-a(\\d+))?$`);
    const planBaseAudits = dtAudits.filter(
        (a) => Number(a.plan_id) === plan.id && baseRegex.test(a.idempotency_key),
    );

    // EXIT BASES ARE ONE FAMILY: for 'flatten', 'submit_time_exit', and 'buy_to_cover', the live-order check
    // considers dt-timeexit, dt-flatten, and dt-cover audits of the plan.
    let familyAudits;
    if (['flatten', 'submit_time_exit', 'buy_to_cover'].includes(action)) {
        const flattenRegex = new RegExp(`^dt-flatten-${plan.id}(-a(\\d+))?$`);
        const timeexitRegex = new RegExp(`^dt-timeexit-${plan.id}(-a(\\d+))?$`);
        const coverRegex = new RegExp(`^dt-cover-${plan.id}(-a(\\d+))?$`);
        familyAudits = dtAudits.filter(
            (a) => Number(a.plan_id) === plan.id && (
                flattenRegex.test(a.idempotency_key) ||
                timeexitRegex.test(a.idempotency_key) ||
                coverRegex.test(a.idempotency_key)
            ),
        );
    } else {
        familyAudits = planBaseAudits;
    }

    // Live order check over the WHOLE family (not only the latest audit): an older live exit must
    // never be joined by a new one. Each non-final audit is refreshed through its replacement chain.
    familyAudits.sort((a, b) => b.id - a.id);
    const liveFamilyAudits = [];
    for (const audit of familyAudits) {
        if (audit.broker_order_id && !LOCAL_AUDIT_FINAL_STATUSES.includes(audit.status)) {
            let chainRes;
            try {
                chainRes = await resolveTerminalDescendant(audit.broker_order_id, client);
            } catch (err) {
                const reqErr = executionError('ALPACA_RECONCILIATION_REQUIRED', `failed to resolve terminal descendant for audit ${audit.idempotency_key}: ${err.message}`);
                reqErr.diagnostics = { orderId: audit.broker_order_id, error: err.message };
                throw reqErr;
            }
            const freshStatus = chainRes.terminalStatus;
            const freshId = chainRes.terminalId;
            if (freshStatus && (freshStatus !== audit.status || freshId !== audit.broker_order_id)) {
                await store.updateOrderAudit(audit.idempotency_key, {
                    status: freshStatus,
                    broker_order_id: freshId,
                    broker_payload: { status: freshStatus, replaced_by_chain_length: chainRes.hops },
                });
                audit.status = freshStatus;
                audit.broker_order_id = freshId;
            }
        }
        if (UNRESOLVED_ORDER_STATUSES.includes(audit.status)) {
            throw executionError('ALPACA_RECONCILIATION_REQUIRED', `management order ${audit.idempotency_key} is unresolved and must be reconciled before retrying`);
        }
        if (!LOCAL_AUDIT_FINAL_STATUSES.includes(audit.status)) liveFamilyAudits.push(audit);
    }

    if (liveFamilyAudits.length > 0) {
        const isExitFamily = ['flatten', 'submit_time_exit', 'buy_to_cover'].includes(action);
        if (isExitFamily) {
            // Replay regardless of qty; a live exit on the other side must have been cancelled
            // and verified by the exit sequence before reaching here, so fail closed if not.
            const sameSide = liveFamilyAudits.find((a) => a.symbol === order.symbol && a.side === order.side);
            if (sameSide) return { replayed: true, outcome: 'replayed_live_order', order: sameSide };
            throw executionError('ALPACA_EXIT_OPPOSITE_SIDE_LIVE', `an opposite-side exit order (${liveFamilyAudits[0].idempotency_key}) is still live`);
        }
        const newestLive = liveFamilyAudits[0];
        if (!intentMatchesExistingAudit(order, newestLive)) {
            throw executionError('ALPACA_IDEMPOTENCY_KEY_CONFLICT', `client order id ${newestLive.idempotency_key} was already used for a different order`);
        }
        return { replayed: true, outcome: 'replayed_live_order', order: newestLive };
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

    if (typeof renewalHook === 'function') {
        await renewalHook();
    }

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
    action, base, legRole, order, plan, client, holderId, leaseDurationMs = 30_000, now = new Date(), nowFn: userNowFn,
}) {
    const nowFn = userNowFn || (() => new Date());
    const lease = await store.acquireSubmissionLease({ holderId, leaseDurationMs, now: nowFn() });
    if (!lease.acquired) {
        throw executionError('ALPACA_LEASE_UNAVAILABLE', 'the durable Day Trading submission lease is held by another process');
    }

    const renewalHook = async () => {
        const res = await store.renewSubmissionLease({ holderId, leaseDurationMs, now: nowFn() });
        if (!res?.renewed) {
            throw executionError('ALPACA_LEASE_LOST', 'submission lease lost before submitOrder');
        }
    };

    try {
        return await submitManagementOrderUnlocked({
            action, base, legRole, order, plan, client, nowFn, renewalHook,
        });
    } finally {
        await store.releaseSubmissionLease({ holderId });
    }
}

// Scoped resolution of ambiguous audits for this plan (any leg_role)
async function resolvePlanAudits({ planId, client, nowFn }) {
    if (!client || typeof client.getOrderByClientOrderId !== 'function') return;
    const allAudits = await store.listOrderAudits();
    const planAmbiguousAudits = allAudits.filter(
        (a) => Number(a.plan_id) === planId && a.execution_epoch === 'day_trading' &&
            UNRESOLVED_ORDER_STATUSES.includes(a.status),
    );

    for (const audit of planAmbiguousAudits) {
        let lookup;
        try {
            lookup = await client.getOrderByClientOrderId(audit.idempotency_key);
        } catch (lookupErr) {
            const err = executionError('ALPACA_RECONCILIATION_REQUIRED', `reconciliation lookup failed for audit ${audit.idempotency_key}: ${lookupErr.message}`);
            err.status = lookupErr.status ?? null;
            err.brokerCode = lookupErr.brokerCode ?? null;
            err.brokerMessage = lookupErr.brokerMessage ?? null;
            err.diagnostics = {
                status: lookupErr.status ?? null,
                brokerCode: lookupErr.brokerCode ?? null,
                brokerMessage: lookupErr.brokerMessage ?? null,
            };
            err.details = [{
                idempotency_key: audit.idempotency_key,
                plan_id: planId,
                resolved: false,
                reason: 'lookup_failed',
                status: lookupErr.status ?? null,
                brokerCode: lookupErr.brokerCode ?? null,
                brokerMessage: lookupErr.brokerMessage ?? null,
            }];
            throw err;
        }

        if (lookup && lookup.found && lookup.order) {
            const brokerStatus = String(lookup.order.status || '').toLowerCase();
            const brokerOrderId = lookup.order.id || audit.broker_order_id || null;
            await store.updateOrderAudit(audit.idempotency_key, {
                status: brokerStatus,
                broker_order_id: brokerOrderId,
                broker_payload: { status: brokerStatus },
            });
            audit.status = brokerStatus;
            audit.broker_order_id = brokerOrderId;
        } else if (lookup && !lookup.found) {
            const createdAt = audit.created_at ? new Date(audit.created_at) : null;
            const nowTime = nowFn().getTime();
            if (createdAt && nowTime - createdAt.getTime() > 60_000) {
                await store.updateOrderAudit(audit.idempotency_key, {
                    status: 'submission_not_found',
                    broker_payload: { status: 'submission_not_found' },
                });
                audit.status = 'submission_not_found';
            } else {
                const err = executionError('ALPACA_RECONCILIATION_REQUIRED', `order audit ${audit.idempotency_key} not found at broker but within ambiguity window`);
                err.diagnostics = { reason: 'within_ambiguity_window' };
                err.details = [{
                    idempotency_key: audit.idempotency_key,
                    plan_id: planId,
                    resolved: false,
                    reason: 'within_ambiguity_window',
                    status: null,
                    brokerCode: null,
                    brokerMessage: null,
                }];
                throw err;
            }
        }
    }
}

async function resolveTerminalDescendant(orderId, client) {
    const chain = [];
    const orders = new Map();
    const visited = new Set();
    let currentId = orderId;
    let hops = 0;

    while (currentId) {
        if (visited.has(currentId)) {
            const err = executionError(
                'ALPACA_REPLACEMENT_CHAIN_UNRESOLVED',
                `replacement chain cycle detected: ${[...chain, currentId].join(' -> ')}`,
            );
            err.chain = chain;
            throw err;
        }
        visited.add(currentId);
        chain.push(currentId);

        let order;
        try {
            order = await client.getOrder(currentId);
        } catch (readErr) {
            readErr.chain = chain;
            throw readErr;
        }
        orders.set(currentId, order);

        const status = String(order?.status || '').toLowerCase();
        if (status === 'replaced') {
            if (!order?.replaced_by) {
                const err = executionError(
                    'ALPACA_REPLACEMENT_CHAIN_UNRESOLVED',
                    `order ${currentId} status is replaced but replaced_by is missing`,
                );
                err.chain = chain;
                throw err;
            }
            if (hops >= 5) {
                const err = executionError(
                    'ALPACA_REPLACEMENT_CHAIN_UNRESOLVED',
                    `replacement chain exceeded max depth of 5 hops: ${chain.join(' -> ')} -> ${order.replaced_by}`,
                );
                err.chain = chain;
                throw err;
            }
            hops += 1;
            currentId = order.replaced_by;
        } else {
            return {
                chain,
                orders,
                terminalOrder: order,
                terminalId: currentId,
                terminalStatus: status,
                isNonExecutable: NON_EXECUTABLE_BROKER_STATUSES.includes(status),
                hops,
            };
        }
    }
}

// Every broker order this plan owns: its bracket legs, the entry parent, and every Day Trading
// audit's order (entry, repair OCO, exits) plus the legs of each. Discovery 404s only mean
// "legs unknown"; the known id itself stays in the set and must still be proven.
async function collectPlanOwnedOrderIds(plan, client) {
    const ids = new Set();
    if (plan.protective_stop_broker_order_id) ids.add(plan.protective_stop_broker_order_id);
    if (plan.protective_target_broker_order_id) ids.add(plan.protective_target_broker_order_id);
    const audits = (await store.listOrderAudits()).filter(
        (a) => a.execution_epoch === 'day_trading' && Number(a.plan_id) === Number(plan.id) && a.broker_order_id,
    );
    const parents = [plan.entry_parent_broker_order_id, ...audits.map((a) => a.broker_order_id)].filter(Boolean);
    for (const id of parents) {
        ids.add(id);
        try {
            const order = await client.getOrder(id, { nested: true });
            for (const leg of (Array.isArray(order?.legs) ? order.legs : [])) {
                if (leg?.id) ids.add(leg.id);
            }
        } catch (err) {
            if (err.status !== 404) throw err;
        }
    }
    return ids;
}

// Orders that must not stay executable once the plan holds no position: any live exit/repair
// order, and bracket legs whose entry parent can no longer execute (a filled/cancelled entry's
// legs would open a short). A still-pending entry and its held legs are normal and not stale.
async function findStaleLiveOrders(plan, client) {
    const stale = [];
    const audits = (await store.listOrderAudits()).filter(
        (a) => a.execution_epoch === 'day_trading' && Number(a.plan_id) === Number(plan.id) && a.broker_order_id
            && ['time_exit', 'emergency_flatten', 'repair_exit'].includes(a.leg_role),
    );
    const candidates = new Set(audits.map((a) => a.broker_order_id));
    for (const audit of audits.filter((a) => a.leg_role === 'repair_exit')) {
        try {
            const order = await client.getOrder(audit.broker_order_id, { nested: true });
            for (const leg of (Array.isArray(order?.legs) ? order.legs : [])) if (leg?.id) candidates.add(leg.id);
        } catch (err) {
            if (err.status !== 404) throw err;
        }
    }
    if (plan.entry_parent_broker_order_id) {
        const entryChain = await resolveTerminalDescendant(plan.entry_parent_broker_order_id, client);
        if (entryChain.isNonExecutable) {
            if (plan.protective_stop_broker_order_id) candidates.add(plan.protective_stop_broker_order_id);
            if (plan.protective_target_broker_order_id) candidates.add(plan.protective_target_broker_order_id);
            for (const id of entryChain.chain) {
                const legs = entryChain.orders.get(id)?.legs;
                for (const leg of (Array.isArray(legs) ? legs : [])) if (leg?.id) candidates.add(leg.id);
            }
            try {
                const parent = await client.getOrder(entryChain.terminalId, { nested: true });
                for (const leg of (Array.isArray(parent?.legs) ? parent.legs : [])) if (leg?.id) candidates.add(leg.id);
            } catch (err) {
                if (err.status !== 404) throw err;
            }
        }
    }
    for (const id of candidates) {
        const chainRes = await resolveTerminalDescendant(id, client);
        if (!chainRes.isNonExecutable) stale.push({ id, status: chainRes.terminalStatus });
    }
    return stale;
}

// A zero position is not "safely flat" while any plan-owned order can still execute: a live
// exit or stale leg could later open an unintended short or long. Cancel whatever is still
// executable (following replacement chains) and require proof of non-executability for all of
// them, bounded by legTerminalTimeoutMs. Unreadable orders count as live (fail closed).
async function ensurePlanOrdersNonExecutable({ plan, client, renewLease, sleep, exitPolicy }) {
    const ids = await collectPlanOwnedOrderIds(plan, client);
    const cancelRequested = new Set();
    const deadline = Date.now() + exitPolicy.legTerminalTimeoutMs;
    while (true) {
        const live = [];
        let cancelledThisRound = false;
        for (const id of ids) {
            let chainRes;
            try {
                chainRes = await resolveTerminalDescendant(id, client);
            } catch (err) {
                live.push({ id, status: err.status === 404 ? 'not_found_404' : (err.code || 'unresolved') });
                continue;
            }
            if (chainRes.isNonExecutable) continue;
            live.push({ id, status: chainRes.terminalStatus || 'unknown' });
            for (const cid of chainRes.chain) {
                const status = String(chainRes.orders.get(cid)?.status || '').toLowerCase();
                if (NON_EXECUTABLE_BROKER_STATUSES.includes(status) || cancelRequested.has(cid)) continue;
                await renewLease('verify_flat_cancel');
                try {
                    await client.cancelOrder(cid);
                } catch (err) {
                    if (err.status !== 422 && err.status !== 404) throw err;
                }
                cancelRequested.add(cid);
                cancelledThisRound = true;
            }
        }
        if (live.length === 0) return { ok: true, live: [] };
        // A cancel issued this round is always re-verified at least once before giving up.
        if (!cancelledThisRound && Date.now() >= deadline) return { ok: false, live };
        await sleep(exitPolicy.pollIntervalMs);
        await renewLease('verify_flat_poll');
    }
}

// C: Exit sequence for 'flatten', 'submit_time_exit', and 'buy_to_cover'.
// Incident Rationale (2026-09-22):
// Open bracket protective legs (stop/target) reserve shares on the broker side, causing Alpaca
// to reject market sell orders with HTTP 403 "insufficient qty available". The exit sequence
// cancels all protective bracket/OCO legs first, verifies they reach a terminal state, refreshes
// the true broker position, submits the market sell for the fresh quantity, and verifies flat.
async function executeExitSequence(decision, plan, {
    client, holderId, leaseDurationMs = 60_000, now = new Date(), nowFn: userNowFn,
    exitPolicy: userExitPolicy, sleep: userSleep,
}) {
    const nowFn = userNowFn || (() => new Date());
    const exitPolicy = {
        legTerminalTimeoutMs: 10_000,
        flatVerifyTimeoutMs: 10_000,
        pollIntervalMs: 500,
        ...userExitPolicy,
    };
    const sleep = userSleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    const lease = await store.acquireSubmissionLease({ holderId, leaseDurationMs, now: nowFn() });
    if (!lease.acquired) {
        throw executionError('ALPACA_LEASE_UNAVAILABLE', 'the durable Day Trading submission lease is held by another process');
    }

    const renewLeaseOrThrow = async (stage) => {
        const res = await store.renewSubmissionLease({ holderId, leaseDurationMs, now: nowFn() });
        if (!res?.renewed) {
            throw executionError('ALPACA_LEASE_LOST', `submission lease lost during exit sequence (${stage})`);
        }
    };

    // "Flat" is only reported once the position is zero AND every plan-owned order is proven
    // non-executable; otherwise the result says so and the next tick retries.
    const finishFlat = async (result) => {
        const check = await ensurePlanOrdersNonExecutable({
            plan, client, renewLease: renewLeaseOrThrow, sleep, exitPolicy,
        });
        if (check.ok) return { ...result, flatVerified: true };
        return { ...result, outcome: 'flat_with_live_orders', flatVerified: false, liveOrderCount: check.live.length };
    };

    try {
        // C: Resolve ALL same-plan ambiguity before collecting orders or checking live orders
        await resolvePlanAudits({ planId: plan.id, client, nowFn });

        // RE-READ the plan's audits and use that fresh snapshot for everything after
        const planAudits = (await store.listOrderAudits()).filter(
            (a) => a.execution_epoch === 'day_trading' && Number(a.plan_id) === plan.id,
        );

        const exitSide = decision.action === 'buy_to_cover' ? 'buy' : 'sell';

        // Treat ALL of the plan's exit audits (dt-timeexit, dt-flatten, dt-cover) as one family
        const flattenRegex = new RegExp(`^dt-flatten-${plan.id}(-a(\\d+))?$`);
        const timeexitRegex = new RegExp(`^dt-timeexit-${plan.id}(-a(\\d+))?$`);
        const coverRegex = new RegExp(`^dt-cover-${plan.id}(-a(\\d+))?$`);
        const exitFamilyAudits = planAudits.filter((a) =>
            flattenRegex.test(a.idempotency_key) || timeexitRegex.test(a.idempotency_key) || coverRegex.test(a.idempotency_key),
        );

        // N3: Wherever a management/exit audit's status is refreshed from the broker,
        // use resolveTerminalDescendant(audit.broker_order_id): persist the TERMINAL descendant's
        // status (and its id in broker_payload as { status, replaced_by_chain_length } — do not
        // store extra broker ids in persisted payload beyond the existing broker_order_id column,
        // which should be updated to the terminal descendant's id).
        // Chain unresolved/unreadable -> throw ALPACA_RECONCILIATION_REQUIRED (fail closed).
        for (const audit of exitFamilyAudits) {
            if (audit.broker_order_id && !LOCAL_AUDIT_FINAL_STATUSES.includes(audit.status)) {
                let chainRes;
                try {
                    chainRes = await resolveTerminalDescendant(audit.broker_order_id, client);
                } catch (err) {
                    const reqErr = executionError('ALPACA_RECONCILIATION_REQUIRED', `failed to resolve terminal descendant for audit ${audit.idempotency_key}: ${err.message}`);
                    reqErr.diagnostics = { orderId: audit.broker_order_id, error: err.message };
                    throw reqErr;
                }
                const termStatus = chainRes.terminalStatus;
                const termId = chainRes.terminalId;
                if (termStatus && (termStatus !== audit.status || termId !== audit.broker_order_id)) {
                    await store.updateOrderAudit(audit.idempotency_key, {
                        status: termStatus,
                        broker_order_id: termId,
                        broker_payload: { status: termStatus, replaced_by_chain_length: chainRes.hops },
                    });
                    audit.status = termStatus;
                    audit.broker_order_id = termId;
                }
            }
            if (UNRESOLVED_ORDER_STATUSES.includes(audit.status)) {
                throw executionError('ALPACA_RECONCILIATION_REQUIRED', `an unresolved Day Trading order audit exists for this plan and must be reconciled before another submission`);
            }
        }

        // Find every live (not LOCAL_AUDIT_FINAL, after refresh) exit-family order of the plan.
        const liveExitAudits = exitFamilyAudits.filter((a) => !LOCAL_AUDIT_FINAL_STATUSES.includes(a.status));
        liveExitAudits.sort((a, b) => b.id - a.id);

        const sameSideLive = liveExitAudits.filter((a) => a.side === exitSide);
        const oppositeSideLive = liveExitAudits.filter((a) => a.side !== exitSide);

        // A live order on the SAME side as this action (sell for flatten/submit_time_exit, buy for buy_to_cover)
        // -> replay it (regardless of qty) + flat verification, as today.
        // Replay only if there is exactly one live same-side order and NO opposite-side live orders;
        // if more than one is live, include all but the newest in the cancel set.
        // Wait for a live same-side exit to finish instead of submitting another one.
        const replayLiveExit = async (liveAudit) => {
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
                await renewLeaseOrThrow('replayed_flat_verify_poll');
            }
            if (flat) {
                return finishFlat({
                    action: decision.action, outcome: 'flat_verified', replayed: true, order: liveAudit,
                });
            }
            return {
                action: decision.action,
                outcome: 'replayed_live_order',
                flatVerified: false,
                replayed: true,
                order: liveAudit,
            };
        };

        if (sameSideLive.length === 1 && oppositeSideLive.length === 0) {
            return await replayLiveExit(sameSideLive[0]);
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

        // N2: A live order on the OPPOSITE side -> must be cancelled and verified non-executable
        // (add it to the C2/C3 set; remove it from the exclusion list) BEFORE the position refresh.
        for (const oppAudit of oppositeSideLive) {
            if (oppAudit.broker_order_id) {
                targetIdsSet.add(oppAudit.broker_order_id);
            }
        }

        // N2: If more than one same-side order is live, include all but the newest in the cancel set.
        if (sameSideLive.length > 1) {
            for (const surplusAudit of sameSideLive.slice(1)) {
                if (surplusAudit.broker_order_id) {
                    targetIdsSet.add(surplusAudit.broker_order_id);
                }
            }
        }

        // N2: Only same-side live exit orders are excluded from cancellation.
        const excludedOrderIds = new Set();
        if (sameSideLive.length > 0 && sameSideLive[0].broker_order_id) {
            excludedOrderIds.add(sameSideLive[0].broker_order_id);
        }
        for (const id of excludedOrderIds) {
            targetIdsSet.delete(id);
        }
        await renewLeaseOrThrow('discovery');

        // C2. Fetch each order; if final skip, else cancelOrder
        const processed = new Set();
        while (true) {
            const currentIds = Array.from(targetIdsSet).filter((id) => !processed.has(id));
            if (currentIds.length === 0) break;
            for (const id of currentIds) {
                processed.add(id);
                let chainRes = null;
                try {
                    chainRes = await resolveTerminalDescendant(id, client);
                } catch (err) {
                    if (Array.isArray(err.chain)) {
                        for (const cid of err.chain) targetIdsSet.add(cid);
                    }
                }
                if (chainRes) {
                    for (const cid of chainRes.chain) targetIdsSet.add(cid);
                }

                await renewLeaseOrThrow('cancel_poll');
                const order = chainRes?.orders?.get(id);
                const s = String(order?.status || '').toLowerCase();
                if (NON_EXECUTABLE_BROKER_STATUSES.includes(s)) continue;

                await renewLeaseOrThrow('cancel_order');
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
        }

        // C3. Poll until all target orders reach a terminal status
        const legDeadline = Date.now() + exitPolicy.legTerminalTimeoutMs;
        const terminalIds = new Set();
        while (true) {
            const nonFinal = [];
            for (const id of Array.from(targetIdsSet)) {
                if (terminalIds.has(id)) continue;
                let chainRes;
                try {
                    chainRes = await resolveTerminalDescendant(id, client);
                } catch (err) {
                    if (Array.isArray(err.chain)) {
                        for (const cid of err.chain) targetIdsSet.add(cid);
                    }
                    const statusDesc = err.status === 404 ? 'not_found_404' : (err.code || err.message || 'unresolved');
                    nonFinal.push({ id, status: statusDesc });
                    await renewLeaseOrThrow('leg_terminal_poll');
                    continue;
                }
                for (const cid of chainRes.chain) {
                    targetIdsSet.add(cid);
                }
                await renewLeaseOrThrow('leg_terminal_poll');
                if (chainRes.isNonExecutable) {
                    terminalIds.add(id);
                } else {
                    nonFinal.push({ id, status: chainRes.terminalStatus || 'unknown' });
                }
            }
            if (nonFinal.length === 0) break;
            if (Date.now() >= legDeadline) {
                const list = nonFinal.map((nf) => `${nf.id}: ${nf.status}`).join(', ');
                throw executionError('ALPACA_EXIT_LEGS_NOT_TERMINAL', `protective legs did not reach terminal state within timeout: ${list}`);
            }
            await sleep(exitPolicy.pollIntervalMs);
        }

        // Mixed live exits: the opposite-side ones were just cancelled and verified above. If the
        // newest same-side exit is still live, it is the one exit -- replay it, never add another.
        if (sameSideLive.length > 0 && sameSideLive[0].broker_order_id) {
            let sameSideChain = null;
            try {
                sameSideChain = await resolveTerminalDescendant(sameSideLive[0].broker_order_id, client);
            } catch (err) {
                const reqErr = executionError('ALPACA_RECONCILIATION_REQUIRED', `cannot read the live exit ${sameSideLive[0].idempotency_key}: ${err.message}`);
                throw reqErr;
            }
            if (!sameSideChain.isNonExecutable) {
                return await replayLiveExit(sameSideLive[0]);
            }
        }

        // C4. Refresh position
        const pos = await client.getPosition(plan.symbol);
        const qty = pos ? Number(pos.qty) : 0;
        if (!pos || qty === 0) {
            return await finishFlat({ action: decision.action, outcome: 'already_flat' });
        }
        if (exitSide === 'buy') {
            if (pos.side === 'long' || qty > 0) {
                throw executionError('ALPACA_EXIT_UNEXPECTED_LONG', `position for ${plan.symbol} is unexpectedly long (${qty})`);
            }
        } else {
            if (pos.side === 'short' || qty < 0) {
                throw executionError('ALPACA_EXIT_UNEXPECTED_SHORT', `position for ${plan.symbol} is unexpectedly short (${qty})`);
            }
        }
        const absQty = Math.abs(qty);
        assertWholeShareQty(absQty);

        // C5. Submit market order with refreshed quantity
        let base;
        let legRole;
        if (decision.action === 'buy_to_cover') {
            base = 'dt-cover';
            legRole = 'emergency_flatten';
        } else if (decision.action === 'submit_time_exit') {
            base = 'dt-timeexit';
            legRole = 'time_exit';
        } else {
            base = 'dt-flatten';
            legRole = 'emergency_flatten';
        }
        const order = { symbol: plan.symbol, side: exitSide, qty: absQty, type: 'market', time_in_force: 'day' };

        const submitResult = await submitManagementOrderUnlocked({
            action: decision.action,
            base,
            legRole,
            order,
            plan,
            client,
            nowFn,
            renewalHook: async () => renewLeaseOrThrow('submit_order'),
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
            await renewLeaseOrThrow('flat_verify_poll');
        }

        const isReplay = Boolean(submitResult.replayed);
        if (flat) {
            return await finishFlat({
                action: decision.action, outcome: 'flat_verified', replayed: isReplay, order: submitResult.order,
            });
        }
        return {
            action: decision.action,
            outcome: isReplay ? 'replayed_live_order' : 'exit_submitted_unverified',
            flatVerified: false,
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
    const { client, holderId, leaseDurationMs = 30_000, now = new Date(), nowFn: userNowFn } = deps;
    const nowFn = userNowFn || (() => new Date());
    if (decision.action === 'none') {
        return { skipped: true };
    }
    if (decision.details && decision.details.qty != null) {
        assertWholeShareQty(decision.details.qty);
    }
    if (decision.action === 'cancel_unfilled_remainder') {
        const lease = await store.acquireSubmissionLease({ holderId, leaseDurationMs, now: nowFn() });
        if (!lease.acquired) {
            throw executionError('ALPACA_LEASE_UNAVAILABLE', 'the durable Day Trading submission lease is held by another process');
        }
        try {
            const entryOrderId = plan.entry_parent_broker_order_id;
            const chainRes = await resolveTerminalDescendant(entryOrderId, client);
            const canceled_ids = [];
            for (const id of chainRes.chain) {
                const order = chainRes.orders.get(id);
                const s = String(order?.status || '').toLowerCase();
                if (NON_EXECUTABLE_BROKER_STATUSES.includes(s)) {
                    continue;
                }
                const res = await store.renewSubmissionLease({ holderId, leaseDurationMs, now: nowFn() });
                if (!res?.renewed) {
                    throw executionError('ALPACA_LEASE_LOST', 'submission lease lost before cancelOrder');
                }
                try {
                    await client.cancelOrder(id);
                } catch (err) {
                    // 422/404 only mean the cancel itself was not accepted (often a race into a
                    // terminal state); they prove nothing. Verification below decides.
                    if (err.status !== 422 && err.status !== 404) throw err;
                }
                canceled_ids.push(id);
            }

            // A cancel request is not proof: poll the replacement chain until its terminal
            // descendant is non-executable, cancelling any new executable descendant, bounded by
            // legTerminalTimeoutMs. Unverified -> throw, so no caller treats the entry as dead.
            const cancelPolicy = { legTerminalTimeoutMs: 10_000, pollIntervalMs: 500, ...deps.exitPolicy };
            const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
            const requested = new Set(canceled_ids);
            // Verify every order seen in the chain (not only the root): each one's own terminal
            // descendant must be non-executable.
            const toVerify = new Set(chainRes.chain);
            const deadline = Date.now() + cancelPolicy.legTerminalTimeoutMs;
            while (true) {
                let allNonExecutable = true;
                let cancelledThisRound = false;
                let lastStatus = 'unreadable';
                for (const id of [...toVerify]) {
                    let current = null;
                    try {
                        current = await resolveTerminalDescendant(id, client);
                    } catch (_err) {
                        current = null;
                    }
                    if (current && current.isNonExecutable) continue;
                    allNonExecutable = false;
                    if (!current) continue;
                    lastStatus = current.terminalStatus;
                    for (const cid of current.chain) toVerify.add(cid);
                    if (!requested.has(current.terminalId)) {
                        const renewed = await store.renewSubmissionLease({ holderId, leaseDurationMs, now: nowFn() });
                        if (!renewed?.renewed) {
                            throw executionError('ALPACA_LEASE_LOST', 'submission lease lost before cancelOrder');
                        }
                        try {
                            await client.cancelOrder(current.terminalId);
                        } catch (err) {
                            if (err.status !== 422 && err.status !== 404) throw err;
                        }
                        requested.add(current.terminalId);
                        canceled_ids.push(current.terminalId);
                        cancelledThisRound = true;
                    }
                }
                if (allNonExecutable) break;
                // A cancel issued this round is always re-verified at least once before giving up.
                if (!cancelledThisRound && Date.now() >= deadline) {
                    throw executionError(
                        'ALPACA_ENTRY_CANCEL_UNVERIFIED',
                        `entry order could not be proven non-executable (terminal status: ${lastStatus})`,
                    );
                }
                await sleep(cancelPolicy.pollIntervalMs);
                const renewed = await store.renewSubmissionLease({ holderId, leaseDurationMs, now: nowFn() });
                if (!renewed?.renewed) {
                    throw executionError('ALPACA_LEASE_LOST', 'submission lease lost while verifying entry cancellation');
                }
            }
            return {
                action: decision.action,
                verified: true,
                result: {
                    canceled_ids,
                    chain: chainRes.chain,
                },
            };
        } finally {
            await store.releaseSubmissionLease({ holderId });
        }
    }

    if (decision.action === 'cancel_stale_orders') {
        // Position is flat but plan-owned orders can still execute: cancel them all and require
        // proof of non-executability, under the lease.
        const staleLeaseMs = deps.leaseDurationMs || 60_000;
        const lease = await store.acquireSubmissionLease({ holderId, leaseDurationMs: staleLeaseMs, now: nowFn() });
        if (!lease.acquired) {
            throw executionError('ALPACA_LEASE_UNAVAILABLE', 'the durable Day Trading submission lease is held by another process');
        }
        try {
            const renewLease = async (stage) => {
                const renewed = await store.renewSubmissionLease({ holderId, leaseDurationMs: staleLeaseMs, now: nowFn() });
                if (!renewed?.renewed) throw executionError('ALPACA_LEASE_LOST', `submission lease lost during stale-order cleanup (${stage})`);
            };
            const check = await ensurePlanOrdersNonExecutable({
                plan,
                client,
                renewLease,
                sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
                exitPolicy: { legTerminalTimeoutMs: 10_000, pollIntervalMs: 500, ...deps.exitPolicy },
            });
            return {
                action: decision.action,
                outcome: check.ok ? 'stale_orders_cancelled' : 'stale_orders_still_live',
                flatVerified: check.ok,
                liveOrderCount: check.live.length,
            };
        } finally {
            await store.releaseSubmissionLease({ holderId });
        }
    }

    if (decision.action === 'flatten' || decision.action === 'submit_time_exit' || decision.action === 'buy_to_cover') {
        return executeExitSequence(decision, plan, { ...deps, nowFn });
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
        nowFn,
    });
}

module.exports = {
    executeManagementAction,
    findStaleLiveOrders,
    executeExitSequence,
    resolveTerminalDescendant,
    NON_EXECUTABLE_BROKER_STATUSES,
    LOCAL_AUDIT_FINAL_STATUSES,
};
