const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_stocks_routes.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;

const express = require('express');
const db = require('../database/db');
const memosRouter = require('../routes/memos');

let server;
let port;

before(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await db.initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/memos', memosRouter);
  server = app.listen(0);
  port = server.address().port;
});

after(() => {
  server.close();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      method, hostname: '127.0.0.1', port, path: pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 },
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('PUT then GET a memo', async () => {
  const put = await request('PUT', '/api/memos/AAPL', { thesis: 'good', conviction: 4 });
  assert.strictEqual(put.status, 200);
  const got = await request('GET', '/api/memos/AAPL');
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.body.data.thesis, 'good');
});

test('GET missing memo returns 404', async () => {
  const got = await request('GET', '/api/memos/NOPE');
  assert.strictEqual(got.status, 404);
});

test('POST reviewed updates timestamp', async () => {
  await request('PUT', '/api/memos/MSFT', { thesis: 'x' });
  const r = await request('POST', '/api/memos/MSFT/reviewed');
  assert.strictEqual(r.status, 200);
  const got = await request('GET', '/api/memos/MSFT');
  assert.ok(got.body.data.last_reviewed_at);
});

test('DELETE memo', async () => {
  await request('PUT', '/api/memos/TSLA', { thesis: 'x' });
  const d = await request('DELETE', '/api/memos/TSLA');
  assert.strictEqual(d.status, 200);
  const got = await request('GET', '/api/memos/TSLA');
  assert.strictEqual(got.status, 404);
});

test('LIST memos', async () => {
  const r = await request('GET', '/api/memos');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
});