'use strict';

const crypto = require('node:crypto');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_ONLY = new RegExp(`^${UUID}$`, 'i');
const REST_ID = new RegExp(`^\\d{17}::(${UUID})$`, 'i');
const DAY_MS = 24 * 60 * 60_000;
const TERMINAL_V2 = new Set(['closed', 'cancelled', 'rejected']);
const round = (value, places = 2) => Math.round((value + Number.EPSILON) * 10 ** places) / 10 ** places;
const stamp = (value) => typeof value === 'string' ? Date.parse(value) : NaN;
const fail = (code) => Object.assign(new Error('Historical trading evidence could not be applied safely.'), { code: `ALPACA_HISTORY_${code}` });

function canonicalHistoryExecutionId(value) {
    const text = String(value ?? '');
    const match = text.match(REST_ID);
    return match ? match[1].toLowerCase() : UUID_ONLY.test(text) ? text.toLowerCase() : text;
}

function sameFill(a, b) {
    return a.symbol === b.symbol && a.side === b.side
        && String(a.broker_order_id ?? a.order_id ?? '') === String(b.broker_order_id ?? b.order_id ?? '')
        && Math.abs(Number(a.qty) - Number(b.qty)) <= 1e-9
        && Math.abs(Number(a.price) - Number(b.price)) <= 1e-9;
}

// Keep raw deliveries intact. Canonical grouping prevents REST/stream duplicates
// from affecting quantities while conflicting evidence remains an explicit error.
function groupFills(fills, idField) {
    const groups = new Map();
    for (const fill of fills) {
        const key = canonicalHistoryExecutionId(fill[idField]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(fill);
    }
    const conflicts = [];
    for (const [key, rows] of groups) {
        const owners = new Set(rows.map(row => row.plan_id).filter(value => value != null));
        if (rows.some(row => !sameFill(row, rows[0])) || owners.size > 1) conflicts.push(key);
    }
    return { groups, conflicts };
}

function effectiveV1HistoryFills(fills = []) {
    const { groups, conflicts } = groupFills(fills, 'activity_id');
    if (conflicts.length) throw fail('FILL_CONFLICT');
    const superseded = new Set(fills.filter(fill => fill.correction_of).map(fill => canonicalHistoryExecutionId(fill.correction_of)));
    return [...groups].filter(([key, rows]) => !superseded.has(key) && !rows.some(row => row.is_bust))
        .map(([, rows]) => rows.find(row => row.plan_id != null) || rows[0]);
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
}
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

async function collectBrokerHistory(client, { after, until, maxPages = 100, pageSize = 100 } = {}) {
    if (!(stamp(after) < stamp(until)) || !Number.isInteger(maxPages) || maxPages < 1
        || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw fail('INCOMPLETE_BROKER_HISTORY');
    const brokerActivities = [];
    const cursors = new Set();
    let pageToken;
    let pages = 0;
    let complete = false;
    for (; pages < maxPages;) {
        let rows;
        try {
            rows = await client.getAccountActivities({ activityType: 'FILL', after, until, direction: 'asc', pageSize, pageToken });
        } catch (_error) { throw fail('BROKER_UNAVAILABLE'); }
        pages += 1;
        if (!Array.isArray(rows)) break;
        brokerActivities.push(...rows);
        if (rows.length < pageSize) { complete = true; break; }
        const next = rows.at(-1)?.id;
        if (typeof next !== 'string' || !next || cursors.has(next)) break;
        cursors.add(next);
        pageToken = next;
    }
    return { brokerActivities, coverage: { after, until, complete }, pages };
}

function normalizeBroker(raw) {
    const row = {
        activity_id: canonicalHistoryExecutionId(raw?.id), broker_order_id: raw?.order_id,
        symbol: String(raw?.symbol || '').toUpperCase(), side: raw?.side,
        qty: Number(raw?.qty), price: Number(raw?.price), executed_at: raw?.transaction_time,
        fill_type: raw?.type === 'partial_fill' ? 'partial_fill' : 'fill',
    };
    if (!row.activity_id || typeof row.broker_order_id !== 'string' || !row.broker_order_id
        || !row.symbol || !['buy', 'sell'].includes(row.side) || !Number.isSafeInteger(row.qty) || row.qty <= 0
        || !Number.isFinite(row.price) || row.price <= 0 || !Number.isFinite(stamp(row.executed_at))
        || (raw.activity_type != null && raw.activity_type !== 'FILL')) return null;
    return row;
}

function publicPlan(plan) {
    return {
        state: plan.state, entryQty: plan.filled_entry_qty, exitQty: plan.filled_exit_qty,
        entryPrice: plan.avg_entry_price, exitPrice: plan.avg_exit_price,
        realizedPnl: plan.realized_pnl, realizedR: plan.realized_r,
        openedAt: plan.opened_at, closedAt: plan.closed_at, exitReason: plan.exit_reason,
    };
}

function changed(before, after) {
    return Object.keys(after).some(key => {
        if (['opened_at', 'closed_at'].includes(key) && Number.isFinite(stamp(before[key]))) return stamp(before[key]) !== stamp(after[key]);
        if (typeof after[key] === 'number' && typeof before[key] === 'number') return Math.abs(before[key] - after[key]) > 1e-7;
        return before[key] !== after[key];
    });
}

function prepareAudit(local, facts, now) {
    const issues = [];
    const applyBlockers = [];
    const issue = (code, detail = {}, severity = 'warning') => issues.push({ code, severity, message: code.toLowerCase().replaceAll('_', ' '), ...detail });
    const block = (code) => { if (!applyBlockers.includes(`ALPACA_HISTORY_${code}`)) applyBlockers.push(`ALPACA_HISTORY_${code}`); };
    const { coverage = {}, positions, openOrders, snapshotAt } = facts;
    const validCoverage = coverage.complete === true && stamp(coverage.after) < stamp(coverage.until)
        && stamp(coverage.until) <= now.getTime() + 5000;
    if (!validCoverage) block('INCOMPLETE_BROKER_HISTORY');
    if (!Number.isFinite(stamp(snapshotAt)) || now.getTime() - stamp(snapshotAt) > 60_000 || stamp(snapshotAt) - now.getTime() > 5000) block('STALE_BROKER_SNAPSHOT');
    if (!Array.isArray(positions) || !Array.isArray(openOrders) || positions.length || openOrders.length) block('BROKER_NOT_FLAT');
    if (local.v1Monitor?.mode !== 'disabled' || local.v2Monitor?.mode !== 'disabled') block('MONITORS_ENABLED');
    if (local.v1Monitor?.submission_lease_holder || local.admissions.length || local.v2Plans.some(plan => !TERMINAL_V2.has(plan.state))) block('ACTIVE_EXECUTION');
    if (local.v1Plans.some(plan => !['closed', 'cancelled', 'error'].includes(plan.state)
        && (!Number.isFinite(stamp(plan.created_at)) || now.getTime() - stamp(plan.created_at) < DAY_MS))) block('RECENT_PLAN');

    const rawActivities = Array.isArray(facts.brokerActivities) ? facts.brokerActivities : [];
    const normalized = rawActivities.map(normalizeBroker);
    if (!Array.isArray(facts.brokerActivities) || normalized.some(row => !row)
        || normalized.some(row => row && (stamp(row.executed_at) < stamp(coverage.after) || stamp(row.executed_at) > stamp(coverage.until)))) {
        issue('BROKER_FILL_INVALID', {}, 'error'); block('INCOMPLETE_BROKER_HISTORY');
    }
    const brokerGroups = groupFills(normalized.filter(Boolean), 'activity_id');
    if (brokerGroups.conflicts.length) { issue('BROKER_FILL_CONFLICT', { count: brokerGroups.conflicts.length }, 'error'); block('INCOMPLETE_BROKER_HISTORY'); }
    const broker = [...brokerGroups.groups.values()].map(rows => rows[0]).sort((a, b) => stamp(a.executed_at) - stamp(b.executed_at) || a.activity_id.localeCompare(b.activity_id));
    const brokerById = new Map(broker.map(fill => [fill.activity_id, fill]));
    const v1 = groupFills(local.v1Fills, 'activity_id');
    const v2 = groupFills(local.v2Fills, 'execution_id');
    const stats = (plans, fills, groups) => ({ planCount: plans.length, fillCount: fills.length, canonicalFillCount: groups.size,
        duplicateRows: fills.length - groups.size, unlinkedFills: fills.filter(fill => fill.plan_id == null).length });
    for (const [version, rows, grouping, idField] of [['v1', local.v1Fills, v1, 'activity_id'], ['v2', local.v2Fills, v2, 'execution_id']]) {
        if (rows.length > grouping.groups.size) issue('DUPLICATE_DELIVERIES', { version, count: rows.length - grouping.groups.size });
        if (grouping.conflicts.length) issue('LOCAL_FILL_CONFLICT', { version, count: grouping.conflicts.length }, 'error');
        const unlinked = rows.filter(fill => fill.plan_id == null).length;
        if (unlinked) issue('UNLINKED_FILLS', { version, count: unlinked });
        let missing = 0; let divergent = 0;
        for (const fill of rows) {
            if (stamp(fill.executed_at) < stamp(coverage.after) || stamp(fill.executed_at) > stamp(coverage.until)) continue;
            const evidence = brokerById.get(canonicalHistoryExecutionId(fill[idField]));
            if (!evidence) missing += 1;
            else if (!sameFill(fill, evidence)) divergent += 1;
        }
        if (missing) issue('LOCAL_FILLS_NOT_IN_BROKER_HISTORY', { version, count: missing }, 'error');
        if (divergent) issue('BROKER_LOCAL_FILL_MISMATCH', { version, count: divergent }, 'error');
    }
    const overlap = [...v1.groups.keys()].filter(key => v2.groups.has(key));
    if (overlap.length) { issue('CROSS_VERSION_EXECUTION_OVERLAP', { count: overlap.length }, 'error'); block('INCOMPLETE_BROKER_HISTORY'); }

    const v2Owned = new Set(local.v2Plans.flatMap(plan => [plan.parent_order_id, plan.stop_order_id, plan.target_order_id, plan.exit_order_id]).filter(Boolean));
    const v2Missing = broker.filter(fill => v2Owned.has(fill.broker_order_id) && !v2.groups.has(fill.activity_id));
    if (v2Missing.length) issue('BROKER_FILLS_MISSING_LOCALLY', { version: 'v2', count: v2Missing.length }, 'error');
    for (const plan of local.v2Plans) {
        const rows = [...v2.groups.values()].map(group => group[0]).filter(fill => fill.plan_id === plan.id);
        const entry = rows.filter(fill => fill.role === 'entry');
        const exits = rows.filter(fill => ['bracket_exit', 'time_exit'].includes(fill.role));
        const qty = rows => rows.reduce((sum, fill) => sum + fill.qty, 0);
        const notional = rows => rows.reduce((sum, fill) => sum + fill.qty * fill.price, 0);
        if (qty(entry) !== plan.filled_entry_qty || qty(exits) !== plan.filled_exit_qty
            || (plan.state === 'closed' && (qty(entry) <= 0 || qty(entry) !== qty(exits)
                || plan.realized_pnl == null || Math.abs(round(notional(exits) - notional(entry)) - plan.realized_pnl) > 0.01))) {
            issue('PLAN_FILL_SUMMARY_MISMATCH', { version: 'v2', planId: plan.id, symbol: plan.symbol }, 'error');
        }
    }

    const operations = [];
    for (const plan of local.v1Plans) {
        const detail = { version: 'v1', planId: plan.id, symbol: plan.symbol };
        const ownedOrders = local.orders.filter(order => order.execution_epoch === 'day_trading' && order.plan_id === plan.id);
        const knownOrders = new Set([plan.entry_parent_broker_order_id, plan.protective_stop_broker_order_id,
            plan.protective_target_broker_order_id, ...ownedOrders.map(order => order.broker_order_id)].filter(Boolean));
        const localRows = local.v1Fills.filter(fill => fill.plan_id === plan.id || knownOrders.has(fill.broker_order_id));
        const relevantGroups = new Set(localRows.map(fill => canonicalHistoryExecutionId(fill.activity_id)));
        if (localRows.some(fill => fill.correction_of || fill.is_bust)
            || [...relevantGroups].some(key => v1.conflicts.includes(key))) {
            issue('MANUAL_FILL_REVIEW_REQUIRED', detail, 'error'); continue;
        }
        if (localRows.some(fill => (fill.plan_id != null && fill.plan_id !== plan.id) || !brokerById.has(canonicalHistoryExecutionId(fill.activity_id))
            || !sameFill(fill, brokerById.get(canonicalHistoryExecutionId(fill.activity_id))))) {
            issue('PLAN_BROKER_EVIDENCE_INCOMPLETE', detail, 'error'); continue;
        }
        const entryIds = new Set(broker.filter(fill => fill.side === 'buy' && fill.symbol === plan.symbol
            && (fill.broker_order_id === plan.entry_parent_broker_order_id || localRows.some(row => row.side === 'buy' && canonicalHistoryExecutionId(row.activity_id) === fill.activity_id)))
            .map(fill => fill.activity_id));
        if (!entryIds.size) { issue('ENTRY_BASIS_UNAVAILABLE', detail); continue; }
        const first = broker.find(fill => entryIds.has(fill.activity_id));
        if (!validCoverage || !Number.isFinite(stamp(plan.created_at))
            || stamp(coverage.after) > Math.min(stamp(plan.created_at), stamp(first.executed_at))) {
            issue('PLAN_HISTORY_COVERAGE_INCOMPLETE', detail, 'error'); continue;
        }
        let balance = 0; let bought = 0; let invalid = false;
        const cycle = [];
        for (const fill of broker.filter(row => row.symbol === plan.symbol && stamp(row.executed_at) >= stamp(first.executed_at))) {
            if (fill.side === 'buy' && !entryIds.has(fill.activity_id)) { invalid = true; break; }
            const assignments = v1.groups.get(fill.activity_id) || [];
            if (assignments.some(row => row.correction_of || row.is_bust || (row.plan_id != null && row.plan_id !== plan.id))
                || v1.conflicts.includes(fill.activity_id) || v2.groups.has(fill.activity_id) || v2Owned.has(fill.broker_order_id)
                || local.orders.some(order => order.broker_order_id === fill.broker_order_id
                    && (order.execution_epoch !== 'day_trading' || (order.plan_id != null && order.plan_id !== plan.id)))) { invalid = true; break; }
            cycle.push(fill);
            if (fill.side === 'buy') { balance += fill.qty; bought += fill.qty; } else balance -= fill.qty;
            if (balance < 0 || bought > plan.planned_qty) { invalid = true; break; }
            if (balance === 0) break;
        }
        const cycleIds = new Set(cycle.map(fill => fill.activity_id));
        const requiredIds = new Set([...entryIds, ...relevantGroups,
            ...broker.filter(fill => knownOrders.has(fill.broker_order_id)).map(fill => fill.activity_id)]);
        if (invalid || balance !== 0 || !cycle.length || bought === 0 || [...requiredIds].some(key => !cycleIds.has(key))) {
            issue('AMBIGUOUS_OR_UNBALANCED_HISTORY', detail, 'error'); continue;
        }
        const last = cycle.at(-1);
        const overlapping = [...local.v1Plans.filter(other => other.id !== plan.id), ...local.v2Plans].some(other => other.symbol === plan.symbol
            && stamp(other.opened_at || other.created_at) <= stamp(last.executed_at)
            && (!other.closed_at || stamp(other.closed_at) >= stamp(first.executed_at)));
        if (overlapping) { issue('OVERLAPPING_SYMBOL_HISTORY', detail, 'error'); continue; }
        if (now.getTime() - stamp(last.executed_at) < DAY_MS) { issue('PLAN_TOO_RECENT_FOR_REPAIR', detail); continue; }
        const inferred = cycle.some(fill => fill.side === 'sell' && !knownOrders.has(fill.broker_order_id)
            && !(v1.groups.get(fill.activity_id) || []).some(row => row.plan_id === plan.id));
        // No prior same-symbol activity is sufficient by itself to establish cost
        // basis. Unknown-order ownership remains a separate operator decision.
        if (inferred && broker.some(fill => fill.symbol === plan.symbol && stamp(fill.executed_at) < stamp(first.executed_at))) {
            issue('PRIOR_SYMBOL_EXPOSURE_REVIEW_REQUIRED', detail, 'error'); continue;
        }
        const entryCost = cycle.filter(fill => fill.side === 'buy').reduce((sum, fill) => sum + fill.qty * fill.price, 0);
        const proceeds = cycle.filter(fill => fill.side === 'sell').reduce((sum, fill) => sum + fill.qty * fill.price, 0);
        const pnl = round(proceeds - entryCost);
        let exitReason = plan.exit_reason;
        if (!exitReason && !inferred) {
            if (last.broker_order_id === plan.protective_stop_broker_order_id) exitReason = 'stop_loss';
            else if (last.broker_order_id === plan.protective_target_broker_order_id) exitReason = 'take_profit';
            else {
                const role = ownedOrders.find(order => order.broker_order_id === last.broker_order_id)?.leg_role;
                if (['time_exit', 'repair_exit', 'emergency_flatten'].includes(role)) exitReason = role;
            }
        }
        const patch = { state: 'closed', filled_entry_qty: bought, filled_exit_qty: bought,
            avg_entry_price: entryCost / bought, avg_exit_price: proceeds / bought,
            realized_pnl: pnl, realized_r: plan.planned_risk_dollars > 0 ? round(pnl / plan.planned_risk_dollars) : null,
            opened_at: first.executed_at, closed_at: last.executed_at, exit_reason: exitReason || null };
        const inserts = cycle.filter(fill => !v1.groups.has(fill.activity_id));
        const links = cycle.flatMap(fill => (v1.groups.get(fill.activity_id) || []).filter(row => row.plan_id == null).map(row => row.id));
        if (!changed(plan, patch) && !inserts.length && !links.length) continue;
        operations.push({ planId: plan.id, symbol: plan.symbol, kind: 'restore_closed_history', requiresAttributionReview: inferred,
            missingFillCount: inserts.length, linkedFillCount: links.length, before: publicPlan(plan), after: publicPlan({ ...plan, ...patch }), patch, inserts, links });
    }
    const summary = { v1: stats(local.v1Plans, local.v1Fills, v1.groups), v2: stats(local.v2Plans, local.v2Fills, v2.groups),
        broker: { fillCount: broker.length, complete: validCoverage && !applyBlockers.includes('ALPACA_HISTORY_INCOMPLETE_BROKER_HISTORY') },
        repairablePlans: operations.length, attributionReviewPlans: operations.filter(op => op.requiresAttributionReview).length };
    const boundFacts = { coverage, broker, positions, openOrders };
    const reviewToken = digest({ local, facts: boundFacts, operations });
    return { reviewToken, summary, issues, applyBlockers, monitorModes: { v1: local.v1Monitor?.mode ?? null, v2: local.v2Monitor?.mode ?? null }, operations,
        repairs: operations.map(({ patch: _patch, inserts: _inserts, links: _links, ...visible }) => visible) };
}

function connection(sqlite) {
    return {
        all: (sql, params = []) => new Promise((resolve, reject) => sqlite.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows))),
        get: (sql, params = []) => new Promise((resolve, reject) => sqlite.get(sql, params, (error, row) => error ? reject(error) : resolve(row))),
        run: (sql, params = []) => new Promise((resolve, reject) => sqlite.run(sql, params, function done(error) { error ? reject(error) : resolve({ changes: this.changes }); })),
        close: () => new Promise((resolve, reject) => sqlite.close(error => error ? reject(error) : resolve())),
    };
}

async function readLocal(c) {
    const local = {};
    for (const [key, table] of [['v1Plans', 'alpaca_day_trade_plans'], ['v1Fills', 'alpaca_paper_fills'],
        ['v2Plans', 'alpaca_dt_v2_plans'], ['v2Fills', 'alpaca_dt_v2_fills']]) local[key] = await c.all(`SELECT * FROM ${table} ORDER BY id`);
    local.orders = await c.all(`SELECT id, broker_order_id, plan_id, execution_epoch, leg_role, status FROM alpaca_paper_orders ORDER BY id`);
    local.v1Monitor = await c.get('SELECT * FROM alpaca_monitor_state WHERE id = 1');
    local.v2Monitor = await c.get('SELECT * FROM alpaca_dt_v2_monitor_state WHERE id = 1');
    local.admissions = await c.all(`SELECT event_key FROM alpaca_dt_v2_events e WHERE action = 'entry_admitted'
        AND NOT EXISTS (SELECT 1 FROM alpaca_dt_v2_events s WHERE s.event_key = 'plan:' || e.plan_id || ':entry_settled') ORDER BY id`);
    return local;
}

function createHistoryAuditService({ getDb = () => require('../database/db').getDb(), now = () => new Date() } = {}) {
    async function transaction(fn, write = false) {
        const c = connection(getDb());
        try {
            await c.run(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
            try { const value = await fn(c); await c.run('COMMIT'); return value; }
            catch (error) { await c.run('ROLLBACK').catch(() => {}); throw error; }
        } finally { await c.close(); }
    }
    async function preview(facts) {
        return transaction(async c => {
            const { operations: _operations, ...visible } = prepareAudit(await readLocal(c), facts, now());
            return visible;
        });
    }
    async function apply(input) {
        if (input?.confirm !== 'APPLY_HISTORY_REPAIR') throw fail('CONFIRMATION_REQUIRED');
        const selected = input.selectedPlanIds;
        const attributed = input.attributionPlanIds || [];
        if (!Array.isArray(selected) || !selected.length || selected.some(id => !Number.isSafeInteger(id) || id <= 0)
            || new Set(selected).size !== selected.length || !Array.isArray(attributed) || attributed.some(id => !selected.includes(id))) throw fail('SELECTION_INVALID');
        if (!/^[a-f0-9]{64}$/.test(input.reviewToken || '')) throw fail('STALE_PREVIEW');
        const eventKey = `history_repair:${digest({ reviewToken: input.reviewToken, selected: [...selected].sort((a, b) => a - b) })}`;
        return transaction(async c => {
            const existing = await c.get('SELECT detail_json FROM alpaca_day_trade_events WHERE event_key = ?', [eventKey]);
            if (existing) return { ...JSON.parse(existing.detail_json), applied: false, replayed: true };
            const audit = prepareAudit(await readLocal(c), input, now());
            if (audit.applyBlockers.length) throw Object.assign(fail('INCOMPLETE_BROKER_HISTORY'), { code: audit.applyBlockers[0] });
            if (audit.reviewToken !== input.reviewToken) throw fail('STALE_PREVIEW');
            const operations = selected.map(id => audit.operations.find(op => op.planId === id));
            if (operations.some(op => !op)) throw fail('SELECTION_INVALID');
            if (operations.some(op => op.requiresAttributionReview && !attributed.includes(op.planId))) throw fail('ATTRIBUTION_CONFIRMATION_REQUIRED');
            let importedFillCount = 0; let linkedFillCount = 0;
            for (const op of operations) {
                for (const fill of op.inserts) {
                    await c.run(`INSERT INTO alpaca_paper_fills (activity_id, broker_order_id, plan_id, symbol, side, qty, price, executed_at, fill_type, source)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'rest_reconciliation')`,
                    [fill.activity_id, fill.broker_order_id, op.planId, fill.symbol, fill.side, fill.qty, fill.price, fill.executed_at, fill.fill_type]);
                    importedFillCount += 1;
                }
                for (const id of op.links) {
                    const result = await c.run('UPDATE alpaca_paper_fills SET plan_id = ? WHERE id = ? AND plan_id IS NULL', [op.planId, id]);
                    if (result.changes !== 1) throw fail('STALE_PREVIEW');
                    linkedFillCount += 1;
                }
                const fields = Object.keys(op.patch);
                await c.run(`UPDATE alpaca_day_trade_plans SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`, [...fields.map(field => op.patch[field]), op.planId]);
                await c.run(`INSERT INTO alpaca_day_trade_events (event_key, plan_id, event_type, action, outcome, reason, detail_json, occurred_at)
                    VALUES (?, ?, 'history_repair', 'repair_plan_history', 'closed', 'OPERATOR_REVIEWED', ?, ?)`,
                [`${eventKey}:plan:${op.planId}`, op.planId, JSON.stringify({ symbol: op.symbol,
                    from: op.before.state, to: op.after.state, filled_qty: op.after.entryQty,
                    realized_pnl: op.after.realizedPnl, realized_r: op.after.realizedR,
                    attribution: op.requiresAttributionReview ? 'operator_confirmed' : 'order_linked',
                    exit_reason: op.after.exitReason }), now().toISOString()]);
            }
            const result = { applied: true, replayed: false, repairedPlanCount: operations.length, importedFillCount, linkedFillCount };
            await c.run(`INSERT INTO alpaca_day_trade_events (event_key, event_type, action, outcome, reason, detail_json, occurred_at)
                VALUES (?, 'history_repair', 'apply_reviewed_history', 'applied', 'OPERATOR_REVIEWED', ?, ?)`,
            [eventKey, JSON.stringify(result), now().toISOString()]);
            return result;
        }, true);
    }
    async function disableLegacy({ positions, openOrders, snapshotAt, confirm } = {}) {
        if (confirm !== 'DISABLE_LEGACY') throw fail('CONFIRMATION_REQUIRED');
        if (!Array.isArray(positions) || !Array.isArray(openOrders) || positions.length || openOrders.length) throw fail('BROKER_NOT_FLAT');
        return transaction(async c => {
            if (!Number.isFinite(stamp(snapshotAt)) || now().getTime() - stamp(snapshotAt) > 60_000
                || stamp(snapshotAt) - now().getTime() > 5000) throw fail('STALE_BROKER_SNAPSHOT');
            const local = await readLocal(c);
            if (local.v1Monitor?.submission_lease_holder || local.admissions.length
                || local.v2Plans.some(plan => !TERMINAL_V2.has(plan.state))) throw fail('ACTIVE_EXECUTION');
            if (local.v1Monitor?.mode === 'disabled') return { disabled: true, alreadyDisabled: true, mode: 'disabled' };
            const occurredAt = now().toISOString();
            await c.run("UPDATE alpaca_monitor_state SET mode = 'disabled', updated_at = ? WHERE id = 1", [occurredAt]);
            await c.run(`INSERT INTO alpaca_day_trade_events (event_key, event_type, action, outcome, reason, detail_json, occurred_at)
                VALUES (?, 'mode_change', 'disable_legacy_history', 'disabled', 'OPERATOR_CONFIRMED', ?, ?)`,
            [`history_disable_legacy:${occurredAt}`, JSON.stringify({ from: local.v1Monitor?.mode, to: 'disabled' }), occurredAt]);
            return { disabled: true, alreadyDisabled: false, mode: 'disabled' };
        }, true);
    }
    return { preview, apply, disableLegacy };
}

module.exports = { createHistoryAuditService, collectBrokerHistory, canonicalHistoryExecutionId, effectiveV1HistoryFills };
