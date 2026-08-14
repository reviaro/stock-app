const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const TEST_DB = path.join(__dirname, 'test_strategy_lab_routes.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;

const db = require('../database/db');
const strategyLabRouter = require('../routes/strategy_lab');

let server;
let port;

function cleanupTestDb() {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const candidate = `${TEST_DB}${suffix}`;
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
}

before(async () => {
    cleanupTestDb();
    await db.initDb();
    const app = express();
    app.use(express.json());
    app.use('/api/strategy-lab', strategyLabRouter);
    server = app.listen(0);
    port = server.address().port;
});

beforeEach(async () => {
    const sqlite = db.getDb();
    await new Promise((resolve, reject) => {
        sqlite.exec('DELETE FROM strategy_runs; DELETE FROM strategy_versions; DELETE FROM strategy_experiments;', (err) => {
            sqlite.close((closeError) => {
                const error = err || closeError;
                error ? reject(error) : resolve();
            });
        });
    });
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    cleanupTestDb();
});

function request(method, pathname, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
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

test('HTTP registry creates, lists, and returns experiment detail', async () => {
    const created = await request('POST', '/api/strategy-lab/experiments', {
        name: 'Low volatility',
        hypothesis: 'Lower-volatility stocks produce better risk-adjusted returns.',
    });
    assert.strictEqual(created.status, 201);
    assert.ok(created.body.data.id);

    const list = await request('GET', '/api/strategy-lab/experiments');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.data.length, 1);

    const detail = await request('GET', `/api/strategy-lab/experiments/${created.body.data.id}`);
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.body.data.name, 'Low volatility');
    assert.strictEqual(detail.body.data.promotion_readiness.paper.ready, false);
});

test('HTTP registry adds versions and evidence runs but never promotes or trades', async () => {
    const experiment = await request('POST', '/api/strategy-lab/experiments', {
        name: 'Value spread', hypothesis: 'Cheap stocks outperform expensive stocks.',
    });
    const experimentId = experiment.body.data.id;
    const version = await request('POST', `/api/strategy-lab/experiments/${experimentId}/versions`, {
        rules: { entry: { field: 'pe_ratio', operator: 'lte', value: 12 } },
    });
    assert.strictEqual(version.status, 201);
    assert.strictEqual(version.body.data.version_number, 1);

    const runPayload = {
        start_date: '2023-01-01', end_date: '2023-12-31', trade_count: 30,
        total_return_pct: 11.5, benchmark_return_pct: 8, max_drawdown_pct: 7,
    };
    for (const runType of ['backtest', 'out_of_sample', 'paper']) {
        const run = await request('POST', `/api/strategy-lab/versions/${version.body.data.id}/runs`, {
            ...runPayload, run_type: runType,
        });
        assert.strictEqual(run.status, 201);
    }

    const detail = await request('GET', `/api/strategy-lab/experiments/${experimentId}`);
    assert.strictEqual(detail.body.data.promotion_readiness.live.ready, true);
    assert.strictEqual(detail.body.data.versions[0].runs.length, 3);
    assert.doesNotMatch(JSON.stringify(detail.body.data), /broker_order|order_id|promoted_at/i);
});

test('HTTP registry maps validation failures to 400 and missing records to 404', async () => {
    const invalidExperiment = await request('POST', '/api/strategy-lab/experiments', { name: '', hypothesis: '' });
    assert.strictEqual(invalidExperiment.status, 400);

    const missing = await request('GET', '/api/strategy-lab/experiments/99999');
    assert.strictEqual(missing.status, 404);

    const missingVersion = await request('POST', '/api/strategy-lab/experiments/99999/versions', { rules: { entry: true } });
    assert.strictEqual(missingVersion.status, 404);

    const invalidRun = await request('POST', '/api/strategy-lab/versions/99999/runs', {
        run_type: 'live', start_date: 'bad', end_date: 'bad', trade_count: -1,
        total_return_pct: 1, benchmark_return_pct: 1, max_drawdown_pct: 1,
    });
    assert.strictEqual(invalidRun.status, 404);
});
