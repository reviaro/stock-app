const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const express = require('express');
const { MockLanguageModelV3 } = require('ai/test');
const { getAIModels, AIConfigurationError } = require('../services/ai_models');

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const calls = [];
const assistant = new MockLanguageModelV3({
  doGenerate: async () => ({ content: [{ type: 'text', text: '{"thesis":"Sample memo"}' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }),
  doStream: async () => ({ stream: new ReadableStream({ start(c) {
    for (const chunk of [{ type: 'text-start', id: 'txt' }, { type: 'text-delta', id: 'txt', delta: 'Sample answer' }, { type: 'text-end', id: 'txt' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]) c.enqueue(chunk);
    c.close();
  } }) }),
});
let badConfiguration = false;
let dbCalls = 0;
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '../services/ai_models') return { AIConfigurationError, getAIModels: () => {
    if (badConfiguration) return getAIModels({ AI_PROVIDER: 'openai' });
    calls.push('selected');
    return [{ model: assistant }];
  } };
  if (request.includes('database/db')) return {
    getWatchlist: async () => { dbCalls++; return []; },
    getMemo: async () => { dbCalls++; return { thesis: 'Sample' }; },
    saveChatMessage: async () => { dbCalls++; },
    clearChatHistory: async () => {},
  };
  if (request.includes('pybridge')) return Object.fromEntries(['getStockInfo', 'getQualityMetrics', 'getTechnicalIndicators', 'getNews'].map(k => [k, async () => ({})]));
  if (request === '../services/ai_context') return { fetchStockContext: async () => ({ symbol: 'MSFT' }) };
  return originalLoad.apply(this, arguments);
};
const router = require('../routes/ai');
Module._load = originalLoad;
let server;
let origin;
before(async () => {
  const app = express(); app.use(express.json()); app.use('/api/ai', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(r => server.close(r)));
const requests = [
  ['/chat', { messages: [{ id: 'user1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }] }],
  ['/memo-draft', { symbol: 'MSFT' }],
  ['/pressure-test', { symbol: 'MSFT' }],
  ['/mode/decisionMemo', { inputs: { symbol: 'MSFT' } }],
];
for (const [path, body] of requests) {
  test(`${path} uses the selected provider and preserves its response format`, async () => {
    const count = calls.length;
    const response = await fetch(origin + '/api/ai' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /Sample/);
    assert.equal(calls.length, count + 1);
    if (path === '/chat' || path.startsWith('/mode')) assert.match(response.headers.get('content-type'), /text\/event-stream/);
    else assert.equal(JSON.parse(text).status, 'success');
  });
}
test('missing configuration rejects every generation endpoint before reading context or saving history', async () => {
  badConfiguration = true;
  const beforeCalls = dbCalls;
  try {
    for (const [path, body] of requests) {
      const response = await fetch(origin + '/api/ai' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /AI_MODEL/);
    }
    assert.equal(dbCalls, beforeCalls);
    const clear = await fetch(origin + '/api/ai/history', { method: 'DELETE' });
    assert.equal(clear.status, 200);
  } finally { badConfiguration = false; }
});
