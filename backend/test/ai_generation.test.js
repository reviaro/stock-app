const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { MockLanguageModelV3 } = require('ai/test');
const { stepCountIs, tool } = require('ai');
const { z } = require('zod');
const { streamWithModels, generateWithModels } = require('../services/ai_generation');

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const finish = (reason = 'stop') => ({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage });
function stream(chunks) { return new ReadableStream({ start(c) { chunks.forEach(x => c.enqueue(x)); c.close(); } }); }
function answer(text = 'Risk checked') { return [{ type: 'text-start', id: 'txt' }, { type: 'text-delta', id: 'txt', delta: text }, { type: 'text-end', id: 'txt' }, finish()]; }
function model(chunks) { return new MockLanguageModelV3({ doStream: async () => ({ stream: stream(chunks) }) }); }
async function request(t, models, options = {}) {
  const app = express();
  app.get('/', (req, res) => streamWithModels(res, models.map(model => ({ model })), { prompt: 'Check risk', maxRetries: 0, ...options }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  return { response, text: await response.text() };
}

test('a lazy stream error falls back before headers and streams a successful answer', async t => {
  const failed = model([{ type: 'error', error: new Error('private-key-or-prompt') }]);
  const working = model(answer());
  const { response, text } = await request(t, [failed, working]);
  assert.equal(response.status, 200);
  assert.match(text, /Risk checked/);
  assert.doesNotMatch(text, /private-key-or-prompt|"type":"error"/);
  assert.equal(working.doStreamCalls.length, 1);
});

test('all failed models return a useful 503 without raw provider errors', async t => {
  const { response, text } = await request(t, [model([{ type: 'error', error: new Error('private-provider-body') }])]);
  assert.equal(response.status, 503);
  assert.match(text, /provider unavailable/);
  assert.doesNotMatch(text, /private-provider-body/);
});

test('stream failure after text starts is reported without replaying on another model', async t => {
  const backup = model(answer('must not happen'));
  const { text } = await request(t, [model([...answer().slice(0, 2), { type: 'error', error: new Error('private') }]), backup]);
  assert.match(text, /"type":"error"/);
  assert.doesNotMatch(text, /private|must not happen/);
  assert.equal(backup.doStreamCalls.length, 0);
});

test('tool execution is followed by an evidence-based answer in the same stream', async t => {
  let executions = 0;
  const assistant = new MockLanguageModelV3({ doStream: async (options) => {
    if (options.prompt.some(m => m.role === 'tool')) {
      assert.match(JSON.stringify(options.prompt), /"breach":true/);
      return { stream: stream(answer('MSFT exceeds its limit.')) };
    }
    return { stream: stream([{ type: 'tool-call', toolCallId: 'risk_1', toolName: 'checkRisk', input: '{"symbol":"MSFT"}' }, finish('tool-calls')]) };
  } });
  const { text } = await request(t, [assistant], { stopWhen: stepCountIs(5), tools: {
    checkRisk: tool({ inputSchema: z.object({ symbol: z.string() }), execute: async ({ symbol }) => { assert.equal(symbol, 'MSFT'); executions++; return { breach: true }; } }),
  } });
  assert.equal(executions, 1);
  assert.equal(assistant.doStreamCalls.length, 2);
  assert.match(text, /tool-output-available/);
  assert.match(text, /MSFT exceeds its limit/);
});

test('generation failure after a tool runs never replays that tool on a fallback model', async t => {
  let executions = 0;
  const assistant = new MockLanguageModelV3({ doStream: async options => ({ stream: stream(options.prompt.some(m => m.role === 'tool')
    ? [{ type: 'error', error: new Error('later step failed') }]
    : [{ type: 'tool-call', toolCallId: 'order_1', toolName: 'trade', input: '{}' }, finish('tool-calls')]) }) });
  const backup = model(answer());
  const { text } = await request(t, [assistant, backup], { stopWhen: stepCountIs(5), tools: {
    trade: tool({ inputSchema: z.object({}), execute: async () => { executions++; return { filled: true }; } }),
  } });
  assert.equal(executions, 1);
  assert.equal(backup.doStreamCalls.length, 0);
  assert.match(text, /"type":"error"/);
});

test('non-streaming generation uses the same ordered models and provider options', async () => {
  const failed = new MockLanguageModelV3({ doGenerate: async () => { throw new Error('private'); } });
  const working = new MockLanguageModelV3({ doGenerate: async options => {
    assert.deepEqual(options.providerOptions, { openai: { store: false } });
    return { content: [{ type: 'text', text: 'Memo' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  } });
  const result = await generateWithModels([{ model: failed }, { model: working, providerOptions: { openai: { store: false } } }], { prompt: 'Write a memo', maxRetries: 0 });
  assert.equal(result.text, 'Memo');
});
