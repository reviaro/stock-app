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
    assert.doesNotMatch(JSON.stringify(summary), /TEST-PAPER-ACCOUNT|test-account-id/i);
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

test('explicit operator resolution rejects a key whose audit belongs to a different execution epoch', async () => {
    const { resolveMissingPaperOrderAudit } = require('../services/alpaca_paper_service');
    const updates = [];
    await assert.rejects(
        () => resolveMissingPaperOrderAudit({
            idempotencyKey: 'ltr-legacy-1',
            confirmed: true,
            expectedEpoch: 'day_trading',
            client: { getOrderByClientOrderId: async () => ({ found: false, order: null }) },
            auditStore: {
                listAlpacaPaperOrderAudits: async () => [{
                    idempotency_key: 'ltr-legacy-1', status: 'submission_unknown', execution_epoch: 'legacy_long_term',
                }],
                updateAlpacaPaperOrderAudit: async (key, update) => updates.push({ key, update }),
            },
        }),
        /does not belong to the day_trading execution epoch/,
    );
    assert.deepStrictEqual(updates, [], 'a cross-epoch resolution attempt must never write anything');
});

test('explicit operator resolution succeeds for a matching execution epoch', async () => {
    const { resolveMissingPaperOrderAudit } = require('../services/alpaca_paper_service');
    const result = await resolveMissingPaperOrderAudit({
        idempotencyKey: 'dt-nvda-entry-1',
        confirmed: true,
        expectedEpoch: 'day_trading',
        client: { getOrderByClientOrderId: async () => ({ found: false, order: null }) },
        auditStore: {
            listAlpacaPaperOrderAudits: async () => [{
                idempotency_key: 'dt-nvda-entry-1', status: 'submission_unknown', execution_epoch: 'day_trading',
            }],
            updateAlpacaPaperOrderAudit: async () => {},
        },
    });
    assert.deepStrictEqual(result, { status: 'submission_not_found' });
});

test('requests the nested bracket-order tree only when explicitly asked, preserving the default query', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const requests = [];
    const { createPaperClient } = require('../services/alpaca_paper_service');
    const client = createPaperClient({
        fetchImpl: async (url) => {
            requests.push(url);
            return { ok: true, json: async () => ([{ id: 'parent-1', legs: [{ id: 'leg-1', leg_role: 'stop_loss' }] }]) };
        },
    });

    await client.getOrders();
    assert.strictEqual(requests[0], 'https://paper-api.alpaca.markets/v2/orders?status=open&direction=desc');

    const nested = await client.getOrders({ nested: true });
    assert.strictEqual(requests[1], 'https://paper-api.alpaca.markets/v2/orders?status=open&direction=desc&nested=true');
    assert.deepStrictEqual(nested[0].legs, [{ id: 'leg-1', leg_role: 'stop_loss' }]);

    // Repair/exit reconciliation must be able to see closed orders too (e.g. verifying a
    // cancel reached a terminal state, or that a stop leg actually filled) — status=open
    // alone can't see those.
    await client.getOrders({ status: 'all', nested: true });
    assert.strictEqual(requests[2], 'https://paper-api.alpaca.markets/v2/orders?status=all&direction=desc&nested=true');
});

test('getOrder requests the nested leg tree only when explicitly asked, for discovering a bracket\'s protective legs', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const requests = [];
    const { createPaperClient } = require('../services/alpaca_paper_service');
    const client = createPaperClient({
        fetchImpl: async (url) => {
            requests.push(url);
            return { ok: true, json: async () => ({ id: 'parent-1', legs: null }) };
        },
    });

    await client.getOrder('parent-1');
    assert.strictEqual(requests[0], 'https://paper-api.alpaca.markets/v2/orders/parent-1');

    await client.getOrder('parent-1', { nested: true });
    assert.strictEqual(requests[1], 'https://paper-api.alpaca.markets/v2/orders/parent-1?nested=true');
});

test('cancelOrder returns a structured outcome for both a no-content success and a not-found order', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const { createPaperClient } = require('../services/alpaca_paper_service');

    const successClient = createPaperClient({
        fetchImpl: async () => ({ ok: true, status: 204, json: async () => { throw new Error('should not parse an empty body'); } }),
    });
    assert.deepStrictEqual(await successClient.cancelOrder('broker-order-1'), { canceled: true });

    const missingClient = createPaperClient({
        fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    assert.deepStrictEqual(await missingClient.cancelOrder('broker-order-gone'), { canceled: false, reason: 'not_found' });
});

test('replaceOrder returns the updated order on success and null when the order is already gone', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const requests = [];
    const { createPaperClient } = require('../services/alpaca_paper_service');

    const client = createPaperClient({
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, status: 200, json: async () => ({ id: 'broker-order-1', status: 'replaced' }) };
        },
    });
    const replaced = await client.replaceOrder('broker-order-1', { qty: '5' });
    assert.strictEqual(replaced.status, 'replaced');
    assert.strictEqual(requests[0].options.method, 'PATCH');
    assert.strictEqual(requests[0].options.body, JSON.stringify({ qty: '5' }));

    const missingClient = createPaperClient({
        fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    assert.strictEqual(await missingClient.replaceOrder('broker-order-gone', { qty: '5' }), null);
});

test('market data requests always target the fixed Alpaca data host with the IEX feed by default', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const requests = [];
    const { createPaperClient } = require('../services/alpaca_paper_service');
    const client = createPaperClient({
        fetchImpl: async (url) => {
            requests.push(url);
            return { ok: true, json: async () => ({ symbol: 'NVDA' }) };
        },
    });

    await client.getLatestQuote('NVDA');
    await client.getLatestBar('NVDA');

    assert.strictEqual(requests[0], 'https://data.alpaca.markets/v2/stocks/NVDA/quotes/latest?feed=iex');
    assert.strictEqual(requests[1], 'https://data.alpaca.markets/v2/stocks/NVDA/bars/latest?feed=iex');
});

test('paginates FILL account activities via page_size and page_token', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const requests = [];
    const { createPaperClient } = require('../services/alpaca_paper_service');
    const client = createPaperClient({
        fetchImpl: async (url) => {
            requests.push(url);
            return { ok: true, json: async () => ([]) };
        },
    });

    await client.getAccountActivities();
    assert.strictEqual(requests[0], 'https://paper-api.alpaca.markets/v2/account/activities/FILL');

    await client.getAccountActivities({ pageSize: 50, pageToken: 'cursor-abc' });
    assert.strictEqual(requests[1], 'https://paper-api.alpaca.markets/v2/account/activities/FILL?page_size=50&page_token=cursor-abc');
});

test('walks account activities forward from a restart cursor via after and direction=asc', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const requests = [];
    const { createPaperClient } = require('../services/alpaca_paper_service');
    const client = createPaperClient({
        fetchImpl: async (url) => {
            requests.push(url);
            return { ok: true, json: async () => ([]) };
        },
    });

    // page_token walks backward from the newest activity (Alpaca's default), which cannot
    // express "everything since the last successful import" — that requires after+asc, the
    // shape alpaca_monitor_state.activity_cursor / last_rest_reconciliation_at are for.
    await client.getAccountActivities({ after: '2026-09-17T13:30:00Z', direction: 'asc' });
    assert.strictEqual(
        requests[0],
        'https://paper-api.alpaca.markets/v2/account/activities/FILL?after=2026-09-17T13%3A30%3A00Z&direction=asc',
    );

    await client.getAccountActivities({ until: '2026-09-17T20:00:00Z' });
    assert.strictEqual(requests[1], 'https://paper-api.alpaca.markets/v2/account/activities/FILL?until=2026-09-17T20%3A00%3A00Z');
});

test('fetches the NYSE trading calendar with start/end query params', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const requests = [];
    const { createPaperClient } = require('../services/alpaca_paper_service');
    const client = createPaperClient({
        fetchImpl: async (url) => {
            requests.push(url);
            return { ok: true, json: async () => ([{ date: '2026-09-18', open: '09:30', close: '16:00' }]) };
        },
    });

    const entries = await client.getCalendar({ start: '2026-09-01', end: '2026-09-18' });
    assert.strictEqual(requests[0], 'https://paper-api.alpaca.markets/v2/calendar?start=2026-09-01&end=2026-09-18');
    assert.deepStrictEqual(entries, [{ date: '2026-09-18', open: '09:30', close: '16:00' }]);
});

test('URL-encodes broker order ids containing characters that are not URL-safe', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const requests = [];
    const { createPaperClient } = require('../services/alpaca_paper_service');
    const client = createPaperClient({
        fetchImpl: async (url) => {
            requests.push(url);
            return { ok: true, status: 204, json: async () => ({}) };
        },
    });

    await client.cancelOrder('order id/with space&more');
    assert.strictEqual(requests[0], 'https://paper-api.alpaca.markets/v2/orders/order%20id%2Fwith%20space%26more');
});

test('classifies a cancel-order timeout as ambiguous and a definite rejection as rejected', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const { createPaperClient } = require('../services/alpaca_paper_service');

    const ambiguousClient = createPaperClient({
        fetchImpl: async () => ({ ok: false, status: 408, json: async () => ({}) }),
    });
    await assert.rejects(ambiguousClient.cancelOrder('broker-order-1'), (err) => err.code === 'ALPACA_BROKER_UNAVAILABLE');

    const rejectedClient = createPaperClient({
        fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({}) }),
    });
    await assert.rejects(rejectedClient.cancelOrder('broker-order-1'), (err) => err.code === 'ALPACA_BROKER_REJECTED');
});

test('does not leak API credentials in a broker error when a request fails', async () => {
    process.env.ALPACA_API_KEY = 'super-secret-key-value';
    process.env.ALPACA_API_SECRET = 'super-secret-secret-value';
    const { createPaperClient } = require('../services/alpaca_paper_service');
    const client = createPaperClient({
        fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });

    await assert.rejects(client.getAccount(), (err) => {
        const message = `${err.message} ${err.stack}`;
        return !message.includes('super-secret-key-value') && !message.includes('super-secret-secret-value');
    });
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

test('P1: captures broker rejection code and message from JSON 403 response', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const { createPaperClient } = require('../services/alpaca_paper_service');
    const client = createPaperClient({
        fetchImpl: async () => ({
            ok: false,
            status: 403,
            text: async () => JSON.stringify({
                code: 40310000,
                message: 'insufficient qty available for order (requested: 10, available: 0)',
            }),
            json: async () => ({
                code: 40310000,
                message: 'insufficient qty available for order (requested: 10, available: 0)',
            }),
        }),
    });

    await assert.rejects(
        () => client.submitOrder({ symbol: 'MRNA', qty: 10, side: 'sell', type: 'market', time_in_force: 'day' }),
        (err) => {
            assert.strictEqual(err.status, 403);
            assert.strictEqual(err.code, 'ALPACA_BROKER_REJECTED');
            assert.strictEqual(err.brokerCode, 40310000);
            assert.strictEqual(err.brokerMessage, 'insufficient qty available for order (requested: 10, available: 0)');
            assert.match(err.message, /^Alpaca paper request failed \(403\): insufficient qty/);
            return true;
        },
    );
});

test('P2: non-JSON error body sets trimmed brokerMessage, and body read failure falls back safely', async () => {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const { createPaperClient } = require('../services/alpaca_paper_service');

    const clientRawText = createPaperClient({
        fetchImpl: async () => ({
            ok: false,
            status: 500,
            text: async () => '   internal server error   \n',
        }),
    });

    await assert.rejects(
        () => clientRawText.getAccount(),
        (err) => {
            assert.strictEqual(err.status, 500);
            assert.strictEqual(err.brokerCode, null);
            assert.strictEqual(err.brokerMessage, 'internal server error');
            assert.strictEqual(err.message, 'Alpaca paper request failed (500): internal server error');
            return true;
        },
    );

    const clientFailingBody = createPaperClient({
        fetchImpl: async () => ({
            ok: false,
            status: 502,
            text: async () => { throw new Error('stream broken'); },
        }),
    });

    await assert.rejects(
        () => clientFailingBody.getAccount(),
        (err) => {
            assert.strictEqual(err.status, 502);
            assert.strictEqual(err.brokerCode, null);
            assert.strictEqual(err.brokerMessage, null);
            assert.strictEqual(err.message, 'Alpaca paper request failed (502)');
            return true;
        },
    );
});

