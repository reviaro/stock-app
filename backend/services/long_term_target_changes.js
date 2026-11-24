'use strict';
// Pure target arithmetic shared by agent-sized picks and operator trades.
// A change is applied to the saved policy only when its order is reserved.

const round2 = value => Math.round(value * 100) / 100;
const sum = targets => targets.reduce((total, t) => total + t.weightPct, 0);
const describe = target => target ? { weightPct: target.weightPct, ...(target.source ? { source: target.source } : {}) } : null;

function agentPicksUsedPct(policy) {
    return round2(sum((policy.targets || []).filter(t => t.source === 'agent')));
}

function applyTargetChange(policy, change) {
    const targets = policy.targets.filter(t => t.symbol !== change.symbol);
    if (change.weightPct > 0) targets.push({ symbol: change.symbol, weightPct: change.weightPct, ...(change.source ? { source: change.source } : {}) });
    return { ...policy, targets: targets.sort((a, b) => a.symbol.localeCompare(b.symbol)) };
}

function planAgentTargetChange(policy, { symbol, side, weightPct }, fail) {
    if (policy.executionMode !== 'automatic' || policy.paused) throw fail('AGENT_TARGET_MODE', 'Agent-sized picks require unpaused automatic execution.', 400);
    const existing = policy.targets.find(t => t.symbol === symbol);
    if (existing && existing.source !== 'agent') throw fail('AGENT_TARGET_OPERATOR', symbol + ' is an operator target. Send the decision without targetWeightPct.', 400);
    if (existing && Math.abs(existing.weightPct - weightPct) < 1e-9) return null;
    const current = existing?.weightPct ?? 0;
    if (side === 'buy' ? !(weightPct > current) : !(existing && weightPct < current)) {
        throw fail('AGENT_TARGET_SIDE', 'A buy must create or raise an agent target; a sell must lower an existing agent target.', 400);
    }
    // Lowering only reduces exposure, so it stays allowed even above a reduced cap.
    if (side === 'buy') {
        const others = policy.targets.filter(t => t.symbol !== symbol);
        const agentOthers = sum(others.filter(t => t.source === 'agent'));
        if (weightPct > policy.maxPositionPct + 1e-8 || agentOthers + weightPct > (policy.agentPicksMaxPct ?? 0) + 1e-8
            || sum(others) + weightPct > 100 - policy.reservePct + 1e-8) {
            throw fail('AGENT_TARGET_LIMIT', 'The requested weight exceeds the maximum position, the agent picks total or the cash reserve.', 400);
        }
    }
    return { symbol, weightPct, source: 'agent', actor: 'agent', previous: describe(existing) };
}

function planOperatorTargetChange(policy, { symbol, side, resultingWeightPct, sellsAll }) {
    const existing = policy.targets.find(t => t.symbol === symbol);
    const resulting = round2(Math.max(0, resultingWeightPct));
    // A bought position always keeps a positive target so it is never treated as a sell.
    const next = side === 'buy' ? Math.max(existing?.weightPct ?? 0, resulting, 0.01)
        : sellsAll ? 0 : Math.min(existing?.weightPct ?? Infinity, resulting);
    if (existing ? Math.abs(next - existing.weightPct) < 1e-9 : next === 0) return null;
    return { symbol, weightPct: next, ...(existing?.source ? { source: existing.source } : {}), actor: 'operator', previous: describe(existing) };
}

module.exports = { agentPicksUsedPct, applyTargetChange, planAgentTargetChange, planOperatorTargetChange };
