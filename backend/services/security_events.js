'use strict';

const EVENTS = new Set(['login_success', 'login_failed', 'login_rate_limited', 'reauth_success', 'reauth_failed',
    'reauth_rate_limited', 'mfa_required', 'logout', 'live_policy', 'live_pause', 'live_execute', 'live_ownership', 'live_cancel']);
const lastFloodEvent = new Map();
// Deliberately exclude request bodies, user names, IPs, cookies, tokens, symbols,
// account identifiers and broker responses. A private journal collector can alert
// on these stable event names without receiving credentials or financial data.
function emitSecurityEvent(event, { outcome, code } = {}) {
    if (!EVENTS.has(event)) return;
    if (event.endsWith('_rate_limited') || event === 'mfa_required') {
        const previous = lastFloodEvent.get(event);
        if (previous !== undefined && Date.now() - previous < 1000) return;
        lastFloodEvent.set(event, Date.now());
    }
    const record = { type: 'security', event, at: new Date().toISOString() };
    if (['success', 'refused', 'failure'].includes(outcome)) record.outcome = outcome;
    if (typeof code === 'string' && /^(?:AUTH|LIVE)_[A-Z0-9_]{1,64}$/.test(code)) record.code = code;
    try { console.info(JSON.stringify(record)); } catch { /* Logging cannot change an order or authorization outcome. */ }
}

module.exports = { emitSecurityEvent };
