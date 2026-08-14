const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

function request(port, path = '/status') {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/api/alpaca-paper${path}`, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }).on('error', reject);
    });
}

test('GET status reports unconfigured paper integration without secrets', async () => {
    const savedKey = process.env.ALPACA_PAPER_API_KEY;
    const savedSecret = process.env.ALPACA_PAPER_SECRET_KEY;
    const savedApiKey = process.env.ALPACA_API_KEY;
    const savedApiSecret = process.env.ALPACA_API_SECRET;
    const savedUrl = process.env.ALPACA_TRADING_BASE_URL;
    delete process.env.ALPACA_PAPER_API_KEY;
    delete process.env.ALPACA_PAPER_SECRET_KEY;
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_API_SECRET;
    delete process.env.ALPACA_TRADING_BASE_URL;
    delete require.cache[require.resolve('../services/alpaca_paper_service')];
    delete require.cache[require.resolve('../routes/alpaca_paper')];

    const app = express();
    app.use('/api/alpaca-paper', require('../routes/alpaca_paper'));
    const server = app.listen(0);
    const result = await request(server.address().port);
    await new Promise((resolve) => server.close(resolve));

    if (savedKey == null) delete process.env.ALPACA_PAPER_API_KEY; else process.env.ALPACA_PAPER_API_KEY = savedKey;
    if (savedSecret == null) delete process.env.ALPACA_PAPER_SECRET_KEY; else process.env.ALPACA_PAPER_SECRET_KEY = savedSecret;
    if (savedApiKey == null) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = savedApiKey;
    if (savedApiSecret == null) delete process.env.ALPACA_API_SECRET; else process.env.ALPACA_API_SECRET = savedApiSecret;
    if (savedUrl == null) delete process.env.ALPACA_TRADING_BASE_URL; else process.env.ALPACA_TRADING_BASE_URL = savedUrl;

    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.body, {
        status: 'success',
        data: {
            configured: false,
            environment: 'paper',
            baseUrl: 'https://paper-api.alpaca.markets',
            reason: 'missing_paper_credentials',
            orderEntryEnabled: false,
        },
    });
    assert.doesNotMatch(JSON.stringify(result.body), /API-SECRET|paper-key/i);
});

test('GET status verifies the configured paper account without exposing account identifiers', async () => {
    const savedKey = process.env.ALPACA_API_KEY;
    const savedSecret = process.env.ALPACA_API_SECRET;
    const savedFetch = global.fetch;
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    global.fetch = async () => ({
        ok: true,
        json: async () => ({
            status: 'ACTIVE', cash: '100000.00', equity: '100000.00', portfolio_value: '100000.00',
            buying_power: '400000.00', multiplier: '4', account_number: 'TEST-PAPER-ACCOUNT', id: 'test-account-id',
        }),
    });
    delete require.cache[require.resolve('../services/alpaca_paper_service')];
    delete require.cache[require.resolve('../routes/alpaca_paper')];

    const app = express();
    app.use('/api/alpaca-paper', require('../routes/alpaca_paper'));
    const server = app.listen(0);
    const result = await request(server.address().port);
    await new Promise((resolve) => server.close(resolve));

    if (savedKey == null) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = savedKey;
    if (savedSecret == null) delete process.env.ALPACA_API_SECRET; else process.env.ALPACA_API_SECRET = savedSecret;
    global.fetch = savedFetch;

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.data.connection, 'verified');
    assert.strictEqual(result.body.data.cash, '100000.00');
    assert.strictEqual(result.body.data.orderEntryEnabled, false);
    assert.doesNotMatch(JSON.stringify(result.body), /PA32|test-account-id|paper-secret/i);
});

test('GET snapshot returns broker clock, positions, and open orders without private identifiers', async () => {
    const savedKey = process.env.ALPACA_API_KEY;
    const savedSecret = process.env.ALPACA_API_SECRET;
    const savedFetch = global.fetch;
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    global.fetch = async (url) => ({
        ok: true,
        json: async () => {
            if (url.endsWith('/v2/clock')) return { is_open: false, timestamp: '2026-08-06T17:00:00-04:00', next_open: '2026-08-07T09:30:00-04:00', next_close: '2026-08-07T16:00:00-04:00' };
            if (url.endsWith('/v2/positions')) return [];
            return [];
        },
    });
    delete require.cache[require.resolve('../services/alpaca_paper_service')];
    delete require.cache[require.resolve('../routes/alpaca_paper')];

    const app = express();
    app.use('/api/alpaca-paper', require('../routes/alpaca_paper'));
    const server = app.listen(0);
    const result = await request(server.address().port, '/snapshot');
    await new Promise((resolve) => server.close(resolve));

    if (savedKey == null) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = savedKey;
    if (savedSecret == null) delete process.env.ALPACA_API_SECRET; else process.env.ALPACA_API_SECRET = savedSecret;
    global.fetch = savedFetch;

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.data.clock.isOpen, false);
    assert.deepStrictEqual(result.body.data.positions, []);
    assert.deepStrictEqual(result.body.data.openOrders, []);
    assert.doesNotMatch(JSON.stringify(result.body), /paper-key|paper-secret/i);
});
