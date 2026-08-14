const PAPER_BASE_URL = 'https://paper-api.alpaca.markets';
const db = require('../database/db');
const { validatePaperOrder } = require('./alpaca_order_policy');

function getPaperCredentials(env = process.env) {
    return {
        key: env.ALPACA_PAPER_API_KEY || env.ALPACA_API_KEY,
        secret: env.ALPACA_PAPER_SECRET_KEY || env.ALPACA_API_SECRET,
    };
}

function getPaperConfiguration(env = process.env) {
    const baseUrl = env.ALPACA_TRADING_BASE_URL || PAPER_BASE_URL;
    if (baseUrl !== PAPER_BASE_URL) {
        throw new Error('Alpaca paper integration refuses any non-paper endpoint');
    }

    const credentials = getPaperCredentials(env);
    if (!credentials.key || !credentials.secret) {
        return {
            configured: false,
            environment: 'paper',
            baseUrl: PAPER_BASE_URL,
            reason: 'missing_paper_credentials',
        };
    }

    return {
        configured: true,
        environment: 'paper',
        baseUrl: PAPER_BASE_URL,
    };
}

function createPaperClient({ env = process.env, fetchImpl = global.fetch, timeoutMs = 10_000 } = {}) {
    const config = getPaperConfiguration(env);
    if (!config.configured) {
        const error = new Error('Alpaca paper credentials are not configured');
        error.code = 'ALPACA_NOT_CONFIGURED';
        throw error;
    }
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

    const credentials = getPaperCredentials(env);

    const notFound = Symbol('alpaca-paper-not-found');

    async function request(path, options = {}) {
        const response = await fetchImpl(`${PAPER_BASE_URL}${path}`, {
            method: options.method || 'GET',
            headers: {
                'APCA-API-KEY-ID': credentials.key,
                'APCA-API-SECRET-KEY': credentials.secret,
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(options.body ? { body: JSON.stringify(options.body) } : {}),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (options.allowNotFound && response.status === 404) return notFound;
        if (!response.ok) {
            const error = new Error(`Alpaca paper request failed (${response.status})`);
            error.status = response.status;
            error.code = response.status >= 400 && response.status < 500 && response.status !== 408
                ? 'ALPACA_BROKER_REJECTED'
                : 'ALPACA_BROKER_UNAVAILABLE';
            throw error;
        }
        return response.json();
    }

    return {
        getAccount: () => request('/v2/account'),
        getClock: () => request('/v2/clock'),
        getPositions: () => request('/v2/positions'),
        getOrders: () => request('/v2/orders?status=open&direction=desc'),
        getAsset: (symbol) => request(`/v2/assets/${encodeURIComponent(symbol)}`),
        getPosition: async (symbol) => {
            const result = await request(`/v2/positions/${encodeURIComponent(symbol)}`, { allowNotFound: true });
            return result === notFound ? null : result;
        },
        getOrder: (brokerOrderId) => request(`/v2/orders/${encodeURIComponent(brokerOrderId)}`),
        getOrderByClientOrderId: async (clientOrderId) => {
            const result = await request(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`, { allowNotFound: true });
            return result === notFound ? { found: false, order: null } : { found: true, order: result };
        },
        submitOrder: (order) => request('/v2/orders', { method: 'POST', body: order }),
    };
}

async function getPaperAccountSummary(options = {}) {
    const account = await createPaperClient(options).getAccount();
    return {
        connection: 'verified',
        accountStatus: account.status,
        cash: account.cash,
        equity: account.equity,
        portfolioValue: account.portfolio_value,
        buyingPower: account.buying_power,
        multiplier: account.multiplier,
    };
}

async function getPaperReconciliationSnapshot(options = {}) {
    const client = createPaperClient(options);
    const [clock, positions, openOrders] = await Promise.all([
        client.getClock(),
        client.getPositions(),
        client.getOrders(),
    ]);

    return {
        clock: {
            timestamp: clock.timestamp,
            isOpen: clock.is_open,
            nextOpen: clock.next_open,
            nextClose: clock.next_close,
        },
        positions: positions.map((position) => ({
            symbol: position.symbol,
            qty: position.qty,
            avgEntryPrice: position.avg_entry_price,
            currentPrice: position.current_price,
            marketValue: position.market_value,
            unrealizedPnl: position.unrealized_pl,
            unrealizedPnlPct: position.unrealized_plpc,
            side: position.side,
        })),
        openOrders: openOrders.map((order) => ({
            symbol: order.symbol,
            qty: order.qty,
            side: order.side,
            type: order.type,
            timeInForce: order.time_in_force,
            limitPrice: order.limit_price,
            status: order.status,
            submittedAt: order.submitted_at,
        })),
    };
}

function committedBuyCash(openOrders = [], audits = []) {
    const brokerKeys = new Set(openOrders.map((order) => order.client_order_id).filter(Boolean));
    const brokerCommitment = openOrders
        .filter((openOrder) => String(openOrder.side).toLowerCase() === 'buy')
        .reduce((total, openOrder) => {
            const qty = Number(openOrder.qty) - Number(openOrder.filled_qty || 0);
            const limitPrice = Number(openOrder.limit_price);
            if (!(qty >= 0) || !(limitPrice > 0)) {
                throw new Error('Unable to determine open buy-order cash commitments');
            }
            return total + (qty * limitPrice);
        }, 0);

    const terminalStatuses = new Set(['filled', 'canceled', 'rejected', 'expired', 'suspended', 'stopped']);
    const localCommitment = audits
        .filter((audit) => String(audit.side).toLowerCase() === 'buy')
        .filter((audit) => !terminalStatuses.has(String(audit.status).toLowerCase()))
        .filter((audit) => !brokerKeys.has(audit.idempotency_key))
        .reduce((total, audit) => {
            const qty = Number(audit.qty);
            const limitPrice = Number(audit.limit_price);
            if (!(qty > 0) || !(limitPrice > 0)) {
                throw new Error('Unable to determine local buy-order cash commitments');
            }
            return total + (qty * limitPrice);
        }, 0);

    return brokerCommitment + localCommitment;
}

async function submitPaperOrderUnlocked({ order, idempotencyKey, client = createPaperClient(), auditStore = db }) {
    const key = String(idempotencyKey || '').trim();
    if (!key) throw new Error('Alpaca paper orders require a nonempty idempotency key');
    let existingAudits = [];
    if (typeof auditStore.listAlpacaPaperOrderAudits === 'function') {
        existingAudits = await auditStore.listAlpacaPaperOrderAudits();
        if (existingAudits.some((audit) => audit.idempotency_key === key)) {
            throw new Error('duplicate Alpaca paper-order idempotency key');
        }
        if (existingAudits.some((audit) => ['pending_submission', 'submission_unknown', 'submission_failed'].includes(audit.status))) {
            const error = new Error('Alpaca paper reconciliation is required before another submission');
            error.code = 'ALPACA_RECONCILIATION_REQUIRED';
            throw error;
        }
    }

    const symbol = String(order?.symbol || '').trim().toUpperCase();
    const [account, asset, position, openOrders] = await Promise.all([
        client.getAccount(), client.getAsset(symbol), client.getPosition(symbol), client.getOrders(),
    ]);
    const positionQty = position?.side === 'long' ? Number(position.qty) : 0;
    const cashAfterCommitments = Number(account?.cash) - committedBuyCash(openOrders, existingAudits);
    const normalized = validatePaperOrder({
        order,
        account: { ...account, cash: cashAfterCommitments },
        asset,
        positionQty,
    });
    await auditStore.createAlpacaPaperOrderAudit({
        idempotency_key: key,
        symbol: normalized.symbol,
        side: normalized.side,
        qty: normalized.qty,
        order_type: normalized.type,
        time_in_force: normalized.time_in_force,
        limit_price: normalized.limit_price,
        status: 'pending_submission',
    });

    const brokerOrder = { ...normalized, client_order_id: key };
    try {
        const brokerResult = await client.submitOrder(brokerOrder);
        const brokerStatus = String(brokerResult.status || 'submitted');
        await auditStore.updateAlpacaPaperOrderAudit(key, {
            status: brokerStatus,
            broker_order_id: brokerResult.id || null,
            broker_payload: { status: brokerStatus },
        });
        return { ...normalized, status: brokerStatus };
    } catch (error) {
        const brokerRejected = error.code === 'ALPACA_BROKER_REJECTED';
        await auditStore.updateAlpacaPaperOrderAudit(key, {
            status: brokerRejected ? 'submission_rejected' : 'submission_unknown',
            broker_payload: {
                error: brokerRejected ? 'broker_rejected' : 'submission_outcome_unknown',
                status: error.status || null,
            },
        });
        if (!brokerRejected) error.code = 'ALPACA_SUBMISSION_UNKNOWN';
        throw error;
    }
}

let submissionQueue = Promise.resolve();

function submitPaperOrder(options) {
    const result = submissionQueue.then(() => submitPaperOrderUnlocked(options));
    submissionQueue = result.catch(() => undefined);
    return result;
}

async function reconcilePaperOrderAudits({ client = createPaperClient(), auditStore = db } = {}) {
    const terminalStatuses = new Set(['filled', 'canceled', 'rejected', 'expired', 'suspended', 'stopped']);
    const audits = await auditStore.listAlpacaPaperOrderAudits();
    const candidates = audits.filter((row) => !row.broker_order_id || !terminalStatuses.has(String(row.status).toLowerCase()));
    const result = { checked: 0, updated: 0, unchanged: 0, failures: 0 };

    for (const audit of candidates) {
        result.checked += 1;
        try {
            const brokerOrder = audit.broker_order_id
                ? await client.getOrder(audit.broker_order_id)
                : (await client.getOrderByClientOrderId(audit.idempotency_key)).order;
            const status = String(brokerOrder?.status || '').toLowerCase();
            const needsBrokerId = !audit.broker_order_id && Boolean(brokerOrder?.id);
            if (!status || (status === String(audit.status).toLowerCase() && !needsBrokerId)) {
                result.unchanged += 1;
                continue;
            }
            await auditStore.updateAlpacaPaperOrderAudit(audit.idempotency_key, {
                status,
                broker_order_id: brokerOrder.id || audit.broker_order_id || null,
                broker_payload: { status },
            });
            result.updated += 1;
        } catch (_error) {
            result.failures += 1;
        }
    }
    return result;
}

async function resolveMissingPaperOrderAudit({ idempotencyKey, confirmed = false, client = createPaperClient(), auditStore = db } = {}) {
    const key = String(idempotencyKey || '').trim();
    if (!key || confirmed !== true) throw new Error('explicit missing-order confirmation is required');
    const audits = await auditStore.listAlpacaPaperOrderAudits();
    const audit = audits.find((row) => row.idempotency_key === key);
    if (!audit || !['pending_submission', 'submission_unknown', 'submission_failed'].includes(audit.status)) {
        throw new Error('an unresolved Alpaca paper-order audit is required');
    }
    const lookup = await client.getOrderByClientOrderId(key);
    if (!lookup || lookup.found !== false) throw new Error('Alpaca still reports this paper order or returned an invalid response');
    await auditStore.updateAlpacaPaperOrderAudit(key, {
        status: 'submission_not_found',
        broker_payload: { status: 'submission_not_found', resolvedBy: 'explicit_operator_confirmation' },
    });
    return { status: 'submission_not_found' };
}

module.exports = { PAPER_BASE_URL, getPaperConfiguration, createPaperClient, getPaperAccountSummary, getPaperReconciliationSnapshot, submitPaperOrder, reconcilePaperOrderAudits, resolveMissingPaperOrderAudit };
