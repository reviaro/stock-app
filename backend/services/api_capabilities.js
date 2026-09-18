'use strict';

// Session authentication is the operator boundary. Automation never inherits it
// from loopback proximity or from the legacy general-purpose bearer token.
const READ_METHODS = new Set(['GET', 'HEAD']);
const RESEARCH_PATH = /^\/(?:stock|market|canslim|quality|screener|history|watchlist)(?:\/|$)/;
const SIM_READ = /^\/simulator\/(?:accounts|account|holdings|transactions|review|risk-monitor|journal|tax-preview|trade-plans|orders\/[^/]+|risk-policy|performance|runs(?:\/[^/]+)?)(?:\/)?$/;

function accountId(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
    return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

function authorizeApiRequest(req, res, next) {
    const deny = (error) => res.status(403).json({ status: 'error', code: 'CAPABILITY_DENIED', error });
    const principal = req.auth;
    if (principal?.role === 'operator' || principal?.type === 'session') return next();
    if (!principal) return deny('authenticated capability is required');
    const read = READ_METHODS.has(req.method);
    if (principal.role !== 'simulator-agent') {
        return read ? next() : deny('operator login or a scoped simulator credential is required for mutations');
    }
    if (read && RESEARCH_PATH.test(req.path)) return next();
    if (read && req.path === '/simulator/accounts') return next();
    const requested = [req.query?.account_id, req.body?.account_id].filter((v) => v !== undefined);
    if (!requested.length || requested.some((v) => accountId(v) !== principal.account_id)) {
        return deny('explicit account_id must match the credential sleeve');
    }
    if (read && SIM_READ.test(req.path)) return next();
    if (req.method === 'POST' && ['/simulator/trade', '/simulator/decisions'].includes(req.path)) return next();
    if (req.method === 'PUT' && req.path === '/simulator/risk-policy' && principal.manage_limits === true) return next();
    return deny('this credential cannot perform that action');
}

module.exports = { authorizeApiRequest, accountId };
