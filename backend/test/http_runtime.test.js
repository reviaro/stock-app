'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const express = require('express');
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require('undici');
const nativeFetch = globalThis.fetch;
const http = require('../services/http_runtime');
const { createPaperClient } = require('../services/alpaca_paper_service');
const { createAlpacaMarketDataSource } = require('../services/hybrid_market_data');
const { getAIModels } = require('../services/ai_models');
const { generateText } = require('ai');

test('application HTTP paths use the patched transport without replacing global fetch', async () => {
    assert.equal(globalThis.fetch, nativeFetch);
    const previous = getGlobalDispatcher();
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.enableNetConnect(/^127\.0\.0\.1:\d+$/);
    setGlobalDispatcher(mock);
    globalThis.fetch = () => { throw new Error('application used the bundled transport'); };
    let server;
    try {
        const broker = mock.get('https://paper-api.alpaca.markets');
        broker.intercept({ path: '/v2/account' }).reply(200, { status: 'ACTIVE', cash: '1000' });
        broker.intercept({ path: '/v2/clock' }).reply(200, { is_open: true });
        mock.get('https://data.alpaca.markets')
            .intercept({ path: '/v2/stocks/TEST/trades/latest?feed=iex' })
            .reply(200, { trade: { p: 100, t: '2027-02-03T15:00:00Z' } });
        const env = { ALPACA_PAPER_API_KEY: 'synthetic-key', ALPACA_PAPER_SECRET_KEY: 'synthetic-secret' };
        assert.equal((await createPaperClient({ env }).getAccount()).status, 'ACTIVE');
        assert.equal((await createAlpacaMarketDataSource({ env })('TEST')).price, 100);

        mock.get('http://localhost:1234').intercept({ path: '/v1/chat/completions', method: 'POST' })
            .reply(200, { id: 'chat_test', created: 1, model: 'test-model', choices: [
                { index: 0, message: { role: 'assistant', content: 'Ready' }, finish_reason: 'stop' },
            ] }, { headers: { 'content-type': 'application/json' } });
        const [selection] = getAIModels({ AI_PROVIDER: 'lmstudio', AI_MODEL: 'test-model' });
        assert.equal((await generateText({ ...selection, prompt: 'Hello' })).text, 'Ready');

        mock.get('https://query2.finance.yahoo.com')
            .intercept({ path: '/v1/finance/search?q=test&quotesCount=10&newsCount=0' })
            .reply(200, { quotes: [{ symbol: 'TEST', shortname: 'Synthetic company', quoteType: 'EQUITY' }] });
        const app = express();
        app.use(require('../routes/watchlist'));
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const response = await http.fetch(`http://127.0.0.1:${server.address().port}/search/test`);
        assert.match(JSON.stringify(await response.json()), /Synthetic company/);
        mock.assertNoPendingInterceptors();
    } finally {
        globalThis.fetch = nativeFetch;
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        setGlobalDispatcher(previous);
        await mock.close();
    }
});

test('patched transport retains request headers, JSON bodies and abort behavior', async () => {
    const previous = getGlobalDispatcher();
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    try {
        mock.get('https://fixture.example.com').intercept({
            path: '/json', method: 'POST', headers: { 'x-fixture': 'yes' },
            body: body => JSON.parse(body).field === 'fixture-value',
        }).reply(200, { ok: true });
        const response = await http.fetch('https://fixture.example.com/json', {
            method: 'POST', headers: new Headers({ 'x-fixture': 'yes', 'content-type': 'application/json' }),
            body: JSON.stringify({ field: 'fixture-value' }),
        });
        assert.deepEqual(await response.json(), { ok: true });
        const abort = new AbortController();
        abort.abort();
        await assert.rejects(http.fetch('https://fixture.example.com/aborted', { signal: abort.signal }), { name: 'AbortError' });
        mock.assertNoPendingInterceptors();
    } finally { setGlobalDispatcher(previous); await mock.close(); }
});

test('SDK download DNS protection still rejects a public hostname resolving to loopback', () => {
    const source = `
        const assert = require('node:assert/strict');
        const dns = require('node:dns');
        const original = globalThis.fetch;
        let lookedUp = false;
        dns.lookup = (hostname, options, callback) => {
            assert.equal(hostname, 'download.example.com');
            lookedUp = true;
            process.nextTick(() => callback(null, [{ address: '127.0.0.1', family: 4 }]));
        };
        require('./services/ai_models');
        require('./services/alpaca_paper_service');
        const { downloadBlob } = require('@ai-sdk/provider-utils');
        assert.equal(globalThis.fetch, original);
        (async () => {
            await assert.rejects(downloadBlob(new URL('http://download.example.com/file'), {
                abortSignal: AbortSignal.timeout(1000),
            }), error => {
                const causes = [];
                for (let cause = error; cause; cause = cause.cause) causes.push(cause.message);
                assert.match(causes.join(' '), /resolved to disallowed IP address 127\.0\.0\.1/);
                return true;
            });
            assert.equal(lookedUp, true);
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ['-e', source], {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
});
