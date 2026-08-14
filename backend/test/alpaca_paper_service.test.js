const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const ENV_KEYS = [
    'ALPACA_PAPER_API_KEY',
    'ALPACA_PAPER_SECRET_KEY',
    'ALPACA_API_KEY',
    'ALPACA_API_SECRET',
    'ALPACA_TRADING_BASE_URL',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
    for (const key of ENV_KEYS) {
        if (originalEnv[key] == null) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
}

beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    delete require.cache[require.resolve('../services/alpaca_paper_service')];
});

afterEach(restoreEnv);

test('reports unconfigured without exposing credentials', () => {
    const { getPaperConfiguration } = require('../services/alpaca_paper_service');
    assert.deepStrictEqual(getPaperConfiguration(), {
        configured: false,
        environment: 'paper',
        baseUrl: 'https://paper-api.alpaca.markets',
        reason: 'missing_paper_credentials',
    });
});

test('rejects a non-paper Alpaca endpoint even when credentials exist', () => {
    process.env.ALPACA_PAPER_API_KEY = 'paper-key';
    process.env.ALPACA_PAPER_SECRET_KEY = 'paper-secret';
    process.env.ALPACA_TRADING_BASE_URL = 'https://api.alpaca.markets';
    const { getPaperConfiguration } = require('../services/alpaca_paper_service');

    assert.throws(() => getPaperConfiguration(), /paper endpoint/);
});

test('reports configured paper status without returning key material', () => {
    process.env.ALPACA_PAPER_API_KEY = 'paper-key';
    process.env.ALPACA_PAPER_SECRET_KEY = 'paper-secret';
    const { getPaperConfiguration } = require('../services/alpaca_paper_service');

    assert.deepStrictEqual(getPaperConfiguration(), {
        configured: true,
        environment: 'paper',
        baseUrl: 'https://paper-api.alpaca.markets',
    });
});

test('accepts the established ALPACA_API credential names for a paper-only client', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const requests = [];
    const { createPaperClient, getPaperConfiguration } = require('../services/alpaca_paper_service');

    assert.strictEqual(getPaperConfiguration().configured, true);
    const client = createPaperClient({
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, json: async () => ({ status: 'ACTIVE' }) };
        },
    });
    await client.getAccount();

    assert.strictEqual(requests[0].url, 'https://paper-api.alpaca.markets/v2/account');
    assert.deepStrictEqual(requests[0].options.headers, {
        'APCA-API-KEY-ID': 'paper-key',
        'APCA-API-SECRET-KEY': 'paper-secret',
    });
});

test('paper client aborts broker requests that exceed the configured deadline', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const { createPaperClient } = require('../services/alpaca_paper_service');
    const client = createPaperClient({
        timeoutMs: 5,
        fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        }),
    });

    await assert.rejects(client.getAccount(), /timed out|timeout/i);
});

test('returns a sanitized cash-based summary from the verified paper account', async () => {
    const { getPaperAccountSummary } = require('../services/alpaca_paper_service');
    const summary = await getPaperAccountSummary({
        env: { ALPACA_API_KEY: 'paper-key', ALPACA_API_SECRET: 'paper-secret' },
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({
                status: 'ACTIVE', cash: '100000.00', equity: '100120.50',
                portfolio_value: '100120.50', buying_power: '400000.00', multiplier: '4',
                account_number: 'TEST-PAPER-ACCOUNT', id: 'test-account-id',
            }),
        }),
    });

    assert.deepStrictEqual(summary, {
        connection: 'verified',
        accountStatus: 'ACTIVE',
        cash: '100000.00',
        equity: '100120.50',
        portfolioValue: '100120.50',
        buyingPower: '400000.00',
        multiplier: '4',
    });
    assert.doesNotMatch(JSON.stringify(summary), /PA32|test-account-id/);
});

test('returns a sanitized read-only reconciliation snapshot', async () => {
    const { getPaperReconciliationSnapshot } = require('../services/alpaca_paper_service');
    const snapshot = await getPaperReconciliationSnapshot({
        env: { ALPACA_API_KEY: 'paper-key', ALPACA_API_SECRET: 'paper-secret' },
        fetchImpl: async (url) => ({
            ok: true,
            json: async () => {
                if (url.endsWith('/v2/clock')) return {
                    timestamp: '2026-08-06T17:18:29-04:00', is_open: false,
                    next_open: '2026-08-07T09:30:00-04:00', next_close: '2026-08-07T16:00:00-04:00',
                };
                if (url.endsWith('/v2/positions')) return [{
                    symbol: 'MSFT', qty: '10', avg_entry_price: '400', current_price: '405', market_value: '4050',
                    unrealized_pl: '50', unrealized_plpc: '0.0125', side: 'long', asset_id: 'private-asset-id',
                }];
                return [{
                    id: 'private-order-id', symbol: 'MSFT', qty: '5', side: 'buy', type: 'limit', time_in_force: 'day',
                    limit_price: '400', status: 'new', submitted_at: '2026-08-06T10:00:00-04:00', client_order_id: 'private-client-id',
                }];
            },
        }),
    });

    assert.deepStrictEqual(snapshot, {
        clock: { timestamp: '2026-08-06T17:18:29-04:00', isOpen: false, nextOpen: '2026-08-07T09:30:00-04:00', nextClose: '2026-08-07T16:00:00-04:00' },
        positions: [{ symbol: 'MSFT', qty: '10', avgEntryPrice: '400', currentPrice: '405', marketValue: '4050', unrealizedPnl: '50', unrealizedPnlPct: '0.0125', side: 'long' }],
        openOrders: [{ symbol: 'MSFT', qty: '5', side: 'buy', type: 'limit', timeInForce: 'day', limitPrice: '400', status: 'new', submittedAt: '2026-08-06T10:00:00-04:00' }],
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /private-asset|private-order|private-client/i);
});

test('reconciles nonterminal audit rows from the paper broker without leaking broker identifiers', async () => {
    const { reconcilePaperOrderAudits } = require('../services/alpaca_paper_service');
    const updates = [];
    const result = await reconcilePaperOrderAudits({
        client: {
            getOrder: async (brokerOrderId) => {
                assert.strictEqual(brokerOrderId, 'private-broker-order-id');
                return { id: brokerOrderId, status: 'filled', filled_qty: '1', client_order_id: 'private-client-order-id' };
            },
        },
        auditStore: {
            listAlpacaPaperOrderAudits: async () => [
                { idempotency_key: 'paper-spy-001', broker_order_id: 'private-broker-order-id', status: 'pending_new' },
                { idempotency_key: 'already-filled', broker_order_id: 'prior-order-id', status: 'filled' },
            ],
            updateAlpacaPaperOrderAudit: async (key, update) => updates.push({ key, update }),
        },
    });

    assert.deepStrictEqual(updates, [{
        key: 'paper-spy-001',
        update: { status: 'filled', broker_order_id: 'private-broker-order-id', broker_payload: { status: 'filled' } },
    }]);
    assert.deepStrictEqual(result, { checked: 1, updated: 1, unchanged: 0, failures: 0 });
    assert.doesNotMatch(JSON.stringify(result), /private|broker-order/i);
});

test('explicit operator resolution can close a broker-confirmed missing submission', async () => {
    const { resolveMissingPaperOrderAudit } = require('../services/alpaca_paper_service');
    const updates = [];
    const result = await resolveMissingPaperOrderAudit({
        idempotencyKey: 'missing-paper-order',
        confirmed: true,
        client: { getOrderByClientOrderId: async () => ({ found: false, order: null }) },
        auditStore: {
            listAlpacaPaperOrderAudits: async () => [{
                idempotency_key: 'missing-paper-order',
                status: 'submission_unknown',
            }],
            updateAlpacaPaperOrderAudit: async (key, update) => updates.push({ key, update }),
        },
    });

    assert.deepStrictEqual(result, { status: 'submission_not_found' });
    assert.deepStrictEqual(updates, [{
        key: 'missing-paper-order',
        update: {
            status: 'submission_not_found',
            broker_payload: { status: 'submission_not_found', resolvedBy: 'explicit_operator_confirmation' },
        },
    }]);
});

test('explicit missing-order resolution refuses an HTTP 200 null broker response', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const { createPaperClient, resolveMissingPaperOrderAudit } = require('../services/alpaca_paper_service');
    let updated = false;
    const client = createPaperClient({
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => null }),
    });

    await assert.rejects(resolveMissingPaperOrderAudit({
        idempotencyKey: 'null-success-response',
        confirmed: true,
        client,
        auditStore: {
            listAlpacaPaperOrderAudits: async () => [{
                idempotency_key: 'null-success-response',
                status: 'submission_unknown',
            }],
            updateAlpacaPaperOrderAudit: async () => { updated = true; },
        },
    }), /reports|invalid/i);
    assert.strictEqual(updated, false);
});
