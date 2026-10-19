const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAsyncRouter, apiErrorHandler } = require('../services/http_errors');

let server;
let origin;
before(async () => {
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    const router = createAsyncRouter();
    router.get('/failure', async () => { await Promise.resolve(); throw new Error('PRIVATE_PROVIDER_DETAIL'); });
    router.get('/busy', async () => { throw Object.assign(new Error('private database path'), { code: 'SQLITE_BUSY' }); });
    router.get('/healthy', async (_req, res) => res.json({ status: 'success' }));
    app.use('/api', router);
    app.use(apiErrorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server?.listening) await new Promise(resolve => server.close(resolve)); });

test('rejected async handlers return sanitized JSON and leave the server responsive', async () => {
    const response = await fetch(`${origin}/api/failure`);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_PROVIDER_DETAIL/);
    assert.equal((await fetch(`${origin}/api/healthy`)).status, 200);
});

test('database contention and malformed request bodies have controlled responses', async () => {
    const busy = await fetch(`${origin}/api/busy`);
    assert.equal(busy.status, 503);
    assert.equal((await busy.json()).code, 'DATABASE_BUSY');
    const invalid = await fetch(`${origin}/api/healthy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_JSON');
    const oversized = await fetch(`${origin}/api/healthy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(2048) }) });
    assert.equal(oversized.status, 413);
});
