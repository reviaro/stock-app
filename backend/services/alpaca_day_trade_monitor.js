// Pure decision core (Safety Invariant #17: zero AI, and this file does no I/O at all — no
// store, no client, no network). Task 13's worker fetches fresh broker state each tick,
// builds one observation per plan, calls decidePlanAction, and is the only thing that acts on
// the decision. That split is what makes twelve scenarios testable without mocking a network
// call: every scenario here is just a different observation shape.
//
// Two tunables are placeholders, not plan-specified numbers, same as Task 6/7's:
// entryTimeoutMs (how long a partially-filled entry may sit unresolved before its remainder is
// canceled) and staleReconciliationMs (how old the last successful reconciliation may be before
// local state is untrusted). Both are Stage 4 tuning material.
const DEFAULT_MONITOR_POLICY = {
    entryTimeoutMs: 120_000,
    timeExitMinutesBeforeClose: 15,
    safetySweepMinutesBeforeClose: 5,
    staleReconciliationMs: 180_000,
};

const OPEN_LEG_STATUSES = ['new', 'accepted', 'held', 'partially_filled'];

function decision({
    action, reason, blockEntries = false, activateKillSwitch = false, healthCode = null, details = null,
}) {
    return {
        action, reason, blockEntries, activateKillSwitch, healthCode, details,
    };
}

function legRemainingQty(leg) {
    if (!leg || !OPEN_LEG_STATUSES.includes(leg.status)) return 0;
    return Number(leg.qty) - Number(leg.filled_qty || 0);
}

// The single question this asks — "does what's actually open at the broker cover the exact
// remaining position?" — is deliberately blind to *how* coverage went wrong (a leg missing
// entirely, a leg canceled, a leg partially filled leaving a stale remainder). Every one of
// those inputs produces the same repair action, which is what lets "missing leg," "target
// partial fill," and "OCO repair" share one code path instead of three.
function isFullyCovered(remainingQty, stopLeg, targetLeg) {
    return legRemainingQty(stopLeg) === remainingQty && legRemainingQty(targetLeg) === remainingQty;
}

function decidePlanAction(observation) {
    const {
        plan, position, brokerUnavailable, entryOrder, stopLeg, targetLeg, clock, monitorState, now, policy = DEFAULT_MONITOR_POLICY,
    } = observation;

    // Fail closed, and do it before anything else: if this tick's broker read failed, or our
    // last successful reconciliation is too old to trust, no other decision below may act on
    // it. A repair action computed from stale data (e.g. an OCO sized to a position that has
    // since changed) could be actively harmful, not merely unhelpful (Safety Invariant #15).
    if (brokerUnavailable) {
        return decision({ action: 'none', reason: 'broker unavailable this tick', blockEntries: true, healthCode: 'BROKER_UNAVAILABLE' });
    }
    const lastReconciliation = monitorState?.last_rest_reconciliation_at ? new Date(monitorState.last_rest_reconciliation_at) : null;
    if (!lastReconciliation || Number.isNaN(lastReconciliation.getTime()) || (now.getTime() - lastReconciliation.getTime()) > policy.staleReconciliationMs) {
        return decision({ action: 'none', reason: 'local state is stale', blockEntries: true, healthCode: 'STALE_RECONCILIATION' });
    }

    const qty = position ? Number(position.qty) : 0;

    // Collapses "both exits filled" and "unexpected short" into one check: whatever produced a
    // negative/short position — a genuine double-fill, a manual sell, a broker bug — gets the
    // identical fail-closed treatment, because phase 1 is long-only and a short position is
    // never a valid state to reason further about.
    if (qty < 0 || position?.side === 'short') {
        return decision({
            action: 'buy_to_cover', reason: 'unexpected short position', blockEntries: true, activateKillSwitch: true,
            healthCode: 'UNEXPECTED_SHORT_POSITION', details: { qty: Math.abs(qty) },
        });
    }

    if (position?.ambiguous) {
        return decision({
            action: 'flatten', reason: 'position could not be read unambiguously; safe repair cannot be proven',
            blockEntries: true, healthCode: 'REPAIR_UNPROVEN', details: { qty: Math.abs(qty) },
        });
    }

    if (qty === 0) {
        // Nothing open to protect or exit. Whether the plan should now be closed is Task 10's
        // question (it owns closing from complete broker evidence), not this function's.
        return decision({ action: 'none', reason: 'flat' });
    }

    if (clock?.next_close) {
        const nextClose = new Date(clock.next_close);
        const safetySweepAt = new Date(nextClose.getTime() - policy.safetySweepMinutesBeforeClose * 60_000);
        const timeExitAt = new Date(nextClose.getTime() - policy.timeExitMinutesBeforeClose * 60_000);
        if (now.getTime() >= safetySweepAt.getTime()) {
            return decision({
                action: 'flatten', reason: 'safety-sweep deadline passed while still not flat',
                blockEntries: true, activateKillSwitch: true, healthCode: 'SAFETY_SWEEP_VIOLATION', details: { qty },
            });
        }
        if (now.getTime() >= timeExitAt.getTime()) {
            return decision({ action: 'submit_time_exit', reason: 'time-exit window reached with an open position', blockEntries: true, details: { qty } });
        }
    }

    // Keyed on the entry order's own observed status, never on plan.state: Task 8 creates
    // every plan at 'entry_pending' and only Task 10's close ever moves it (to 'closed' or
    // 'error') -- nothing writes 'partially_entered' or 'active'. A gate on plan.state would
    // make this branch, and the generic coverage check below it, unreachable for every plan
    // that actually exists. This mirrors the same decision already made for stopLeg/targetLeg:
    // trust the fresh observation, not a persisted column nothing keeps current.
    if (entryOrder) {
        const orderQty = Number(entryOrder.qty);
        const filledQty = Number(entryOrder.filled_qty || 0);
        const isPartial = filledQty > 0 && filledQty < orderQty;
        if (entryOrder.status === 'partially_filled' && isPartial) {
            // new Date(null) coerces to epoch 0 -- a *valid* date, not NaN -- so a missing
            // timestamp must be rejected before it ever reaches the Date constructor, not
            // only after, or it reads as "56 years old" and cancels on the very next tick.
            const submittedAt = entryOrder.submitted_at == null ? null : new Date(entryOrder.submitted_at);
            if (!submittedAt || Number.isNaN(submittedAt.getTime())) {
                // A missing/unparseable submission time must not silently read as "infinitely
                // old" (new Date(null) is epoch 0) and cancel the remainder on the very next
                // tick after any partial fill.
                return decision({
                    action: 'none', reason: 'entry submission time is unavailable; cannot evaluate the resolution timeout',
                    blockEntries: true, healthCode: 'ENTRY_TIMESTAMP_UNAVAILABLE',
                });
            }
            const elapsedMs = now.getTime() - submittedAt.getTime();
            if (elapsedMs > policy.entryTimeoutMs) {
                return decision({ action: 'cancel_unfilled_remainder', reason: 'partial entry unresolved beyond the configured timeout', blockEntries: true });
            }
            return decision({ action: 'none', reason: 'partial entry still within its resolution timeout' });
        }
        if (entryOrder.status === 'canceled' && filledQty > 0 && !isFullyCovered(qty, stopLeg, targetLeg)) {
            return decision({
                action: 'attach_protective_oco', reason: 'unfilled remainder canceled; the filled quantity has no protection yet',
                blockEntries: true, details: { qty },
            });
        }
    }

    if (!isFullyCovered(qty, stopLeg, targetLeg)) {
        return decision({
            action: 'attach_protective_oco', reason: 'open position is not fully covered by protective orders',
            blockEntries: true, details: { qty },
        });
    }

    return decision({ action: 'none', reason: 'healthy bracket' });
}

module.exports = { decidePlanAction, DEFAULT_MONITOR_POLICY };
