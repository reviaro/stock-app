const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createPortfolioLabRouter } = require('../routes/portfolio_lab');

const servers = [];
after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

function start(analyze) {
    const app = express();
    app.use(express.json());
    app.use('/api/portfolio-lab', createPortfolioLabRouter({ analyze }));
    const server = app.listen(0);
    servers.push(server);
    return server.address().port;
}

function post(port, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1', port, method: 'POST', path: '/api/portfolio-lab/analyze',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
            let chunks = '';
            res.on('data', (chunk) => { chunks += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks) }));
        });
        req.on('error', reject);
        req.end(data);
    });
}

test('Portfolio Lab route returns advisory analysis from the injected service', async () => {
    let received;
    const port = start(async (input) => {
        received = input;
        return { models: [], read_only: true, execution_enabled: false };
    });
    const response = await post(port, { symbols: ['AAPL', 'MSFT', 'JPM'] });
    assert.equal(response.status, 200);
    assert.deepEqual(received, { symbols: ['AAPL', 'MSFT', 'JPM'] });
    assert.equal(response.body.status, 'success');
    assert.equal(response.body.data.read_only, true);
    assert.equal(response.body.data.execution_enabled, false);
});

test('Portfolio Lab route maps validation errors without exposing a stack', async () => {
    const port = start(async () => {
        const error = new Error('symbols are invalid');
        error.statusCode = 400;
        throw error;
    });
    const response = await post(port, {});
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { status: 'error', error: 'symbols are invalid' });
});

test('Portfolio Lab route hides internal worker details', async () => {
    const port = start(async () => {
        const error = new Error('/private/path/worker.py failed inside optimizer');
        error.statusCode = 502;
        throw error;
    });
    const response = await post(port, {});
    assert.equal(response.status, 502);
    assert.deepEqual(response.body, { status: 'error', error: 'Portfolio Lab analysis failed' });
});
