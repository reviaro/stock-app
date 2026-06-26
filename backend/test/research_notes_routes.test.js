const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const TEST_DB = path.join(__dirname, 'test_research_notes.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;

const db = require('../database/db');
const researchNotesRouter = require('../routes/research_notes');

let server;
let port;

before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
    const app = express();
    app.use(express.json());
    app.use('/api/research-notes', researchNotesRouter);
    server = app.listen(0);
    port = server.address().port;
});

beforeEach(async () => {
    const sqlite = db.getDb();
    await new Promise((resolve, reject) => {
        sqlite.run('DELETE FROM stock_memos', [], (err) => {
            sqlite.close();
            err ? reject(err) : resolve();
        });
    });
});

after(() => {
    server.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

function request(method, pathname, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            method,
            hostname: '127.0.0.1',
            port,
            path: pathname,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data ? Buffer.byteLength(data) : 0,
            },
        }, (res) => {
            let chunks = '';
            res.on('data', (chunk) => { chunks += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

test('PUT then GET /api/research-notes/:symbol persists structured thesis fields', async () => {
    const payload = {
        thesis: 'Dominant compounder with recurring cash flow.',
        variant_view: 'Market is underestimating durable margin expansion.',
        buy_below: 150,
        trim_above: 240,
        risks: 'Valuation and regulation.',
        conviction: 4,
    };

    const put = await request('PUT', '/api/research-notes/msft', payload);
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.body.data.symbol, 'MSFT');

    const get = await request('GET', '/api/research-notes/MSFT');
    assert.strictEqual(get.status, 200);
    assert.strictEqual(get.body.data.symbol, 'MSFT');
    assert.strictEqual(get.body.data.thesis, payload.thesis);
    assert.strictEqual(get.body.data.variant_view, payload.variant_view);
    assert.strictEqual(get.body.data.buy_below, payload.buy_below);
    assert.strictEqual(get.body.data.trim_above, payload.trim_above);
    assert.strictEqual(get.body.data.risks, payload.risks);
    assert.strictEqual(get.body.data.conviction, payload.conviction);
});

test('PUT /api/research-notes/:symbol rejects invalid conviction', async () => {
    const res = await request('PUT', '/api/research-notes/AAPL', { thesis: 'x', conviction: 9 });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /conviction/);
});

test('GET /api/research-notes/:symbol returns empty structured note for unknown symbol', async () => {
    const res = await request('GET', '/api/research-notes/BRK.B');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.symbol, 'BRK.B');
    assert.strictEqual(res.body.data.thesis, null);
    assert.strictEqual(res.body.data.variant_view, null);
    assert.strictEqual(res.body.data.trim_above, null);
});
