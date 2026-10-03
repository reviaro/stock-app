const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateText, tool } = require('ai');
const { z } = require('zod');
const { getAIModels } = require('../services/ai_models');

const keys = { GOOGLE_GENERATIVE_AI_API_KEY: 'test-google', OPENAI_API_KEY: 'test-openai', ANTHROPIC_API_KEY: 'test-anthropic' };

test('existing Gemini configuration keeps its model order and local fallback', () => {
  const models = getAIModels(keys);
  assert.deepEqual(models.map(m => m.model.modelId), ['gemini-2.5-flash-preview-04-17', 'gemini-2.5-flash', 'qwen2.5-7b-instruct']);
  assert.equal(models[2].model.provider, 'openai.chat');
  assert.equal(getAIModels({ ...keys, AI_MODEL: 'gemini-2.5-flash', AI_LOCAL_FALLBACK: 'false' }).length, 1);
  assert.deepEqual(getAIModels({ LMSTUDIO_MODEL: 'existing-local' }).map(m => m.model.modelId), ['existing-local']);
});

test('cloud selection never silently falls back to another cloud and local fallback is opt-in', () => {
  for (const provider of ['openai', 'anthropic']) {
    const env = { ...keys, AI_PROVIDER: provider, AI_MODEL: 'chosen-model' };
    assert.equal(getAIModels(env).length, 1);
    const chain = getAIModels({ ...env, AI_LOCAL_FALLBACK: 'true', LMSTUDIO_MODEL: 'local-model' });
    assert.deepEqual(chain.map(m => m.model.modelId), ['chosen-model', 'local-model']);
    assert.equal(chain[1].model.provider, 'openai.chat');
  }
});

test('invalid or incomplete configuration fails clearly without exposing values', () => {
  assert.throws(() => getAIModels({ AI_PROVIDER: 'secret-invalid-value' }), /AI_PROVIDER must/);
  assert.throws(() => getAIModels({ ...keys, AI_LOCAL_FALLBACK: 'yes' }), /AI_LOCAL_FALLBACK must/);
  for (const provider of ['openai', 'anthropic']) {
    assert.throws(() => getAIModels({ AI_PROVIDER: provider }), /Set AI_MODEL/);
    assert.throws(() => getAIModels({ AI_PROVIDER: provider, AI_MODEL: 'chosen' }), /API_KEY/);
  }
  assert.throws(() => getAIModels({ AI_LOCAL_FALLBACK: 'false' }), /GOOGLE_GENERATIVE_AI_API_KEY/);
});

const replies = {
  gemini: { candidates: [{ content: { role: 'model', parts: [{ text: 'Ready' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } },
  openai: { id: 'resp_test', created_at: 1, model: 'chosen', output: [{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Ready', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  anthropic: { id: 'msg_test', type: 'message', role: 'assistant', model: 'chosen', content: [{ type: 'text', text: 'Ready' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
};
for (const provider of ['gemini', 'openai', 'anthropic']) {
  test(`${provider} adapter sends authenticated requests and tool schemas through the installed SDK`, async () => {
    let request;
    const [selection] = getAIModels({ ...keys, AI_PROVIDER: provider, AI_MODEL: 'chosen', AI_LOCAL_FALLBACK: 'false' }, {
      fetch: async (url, init) => {
        request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
        return new Response(JSON.stringify(replies[provider]), { headers: { 'content-type': 'application/json' } });
      },
    });
    const result = await generateText({ ...selection, prompt: 'Check risk', tools: {
      checkRisk: tool({ inputSchema: z.object({ symbol: z.string() }), execute: async () => ({ breach: true }) }),
    } });
    assert.equal(result.text, 'Ready');
    if (provider === 'openai') {
      assert.equal(request.url, 'https://api.openai.com/v1/responses');
      assert.equal(request.headers.get('authorization'), 'Bearer test-openai');
      assert.equal(request.body.store, false);
      assert.equal(request.body.tools[0].parameters.properties.symbol.type, 'string');
    } else if (provider === 'anthropic') {
      assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
      assert.equal(request.headers.get('x-api-key'), 'test-anthropic');
      assert.equal(request.body.tools[0].input_schema.properties.symbol.type, 'string');
    } else {
      assert.match(request.url, /^https:\/\/generativelanguage.googleapis.com\//);
      assert.equal(request.headers.get('x-goog-api-key'), 'test-google');
      assert.equal(request.body.tools[0].functionDeclarations[0].parameters.properties.symbol.type, 'string');
    }
  });
}

test('LM Studio uses the chat completions endpoint, without a cloud key', async () => {
  let url;
  const [selection] = getAIModels({ AI_PROVIDER: 'lmstudio', LMSTUDIO_MODEL: 'local-test' }, {
    fetch: async (input) => { url = String(input); return new Response(JSON.stringify({ id: 'chat_test', created: 1, model: 'local-test', choices: [{ index: 0, message: { role: 'assistant', content: 'Local' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }); },
  });
  const result = await generateText({ ...selection, prompt: 'Hi' });
  assert.equal(result.text, 'Local');
  assert.equal(url, 'http://localhost:1234/v1/chat/completions');
});
