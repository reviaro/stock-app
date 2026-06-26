const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const TEST_DB = path.join(__dirname, 'test_txn_routes.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;

const db = require('../database/db');
const txnRouter = require('../routes/transactions');

let server;
let port;

before(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await db.initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/transactions', txnRouter);
  server = app.listen(0);
  port = server.address().port;
});

beforeEach(async () => {
  const sqlite = db.getDb();
  await new Promise((resolve) => sqlite.serialize(() => {
    sqlite.run('DELETE FROM transactions');
    sqlite.run('DELETE FROM watchlist', () => { sqlite.close(); resolve(); });
  }));
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
      res.on('end', () => {
        resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('POST /api/transactions buy', async () => {
  const response = await request('POST', '/api/transactions', {
    type: 'buy', symbol: 'AAPL', shares: 10, price: 150, txn_date: '2026-01-15',
  });
  assert.strictEqual(response.status, 200);
  assert.ok(response.body.data.id);
});

test('POST /api/transactions deposit', async () => {
  const response = await request('POST', '/api/transactions', {
    type: 'deposit', amount: 5000, txn_date: '2026-01-01',
  });
  assert.strictEqual(response.status, 200);
});

test('POST /api/transactions invalid -> 400', async () => {
  const response = await request('POST', '/api/transactions', {
    type: 'wat', txn_date: '2026-01-01',
  });
  assert.strictEqual(response.status, 400);
});

test('GET /api/transactions returns all', async () => {
  await request('POST', '/api/transactions', { type: 'deposit', amount: 5000, txn_date: '2026-01-01' });
  await request('POST', '/api/transactions', { type: 'buy', symbol: 'AAPL', shares: 1, price: 100, txn_date: '2026-01-02' });
  const response = await request('GET', '/api/transactions');
  assert.strictEqual(response.status, 200);
  assert.ok(Array.isArray(response.body.data));
  assert.ok(response.body.data.length >= 2);
});

test('GET /api/transactions?symbol=AAPL filters', async () => {
  await request('POST', '/api/transactions', { type: 'buy', symbol: 'AAPL', shares: 1, price: 100, txn_date: '2026-01-01' });
  await request('POST', '/api/transactions', { type: 'buy', symbol: 'MSFT', shares: 1, price: 300, txn_date: '2026-01-01' });
  const response = await request('GET', '/api/transactions?symbol=AAPL');
  assert.ok(response.body.data.every((txn) => txn.symbol === 'AAPL'));
});

test('DELETE /api/transactions/:id', async () => {
  const add = await request('POST', '/api/transactions', { type: 'deposit', amount: 10, txn_date: '2026-01-01' });
  const response = await request('DELETE', `/api/transactions/${add.body.data.id}`);
  assert.strictEqual(response.status, 200);
});

test('bucket auto-flip: first buy for a watchlisted symbol -> owned', async () => {
  await db.addToWatchlist('NVDA');
  await request('POST', '/api/transactions', {
    type: 'buy', symbol: 'NVDA', shares: 1, price: 500, txn_date: '2026-02-01',
  });
  const rows = await db.getWatchlist();
  const nvda = rows.find((row) => row.symbol === 'NVDA');
  assert.strictEqual(nvda.bucket, 'owned');
});

test('bucket auto-flip: full sell of holdings -> unsorted', async () => {
  await db.addToWatchlist('NVDA');
  await request('POST', '/api/transactions', {
    type: 'buy', symbol: 'NVDA', shares: 1, price: 500, txn_date: '2026-02-01',
  });
  await request('POST', '/api/transactions', {
    type: 'sell', symbol: 'NVDA', shares: 1, price: 520, txn_date: '2026-02-15',
  });
  const rows = await db.getWatchlist();
  const nvda = rows.find((row) => row.symbol === 'NVDA');
  assert.strictEqual(nvda.bucket, 'unsorted');
});
