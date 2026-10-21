const { createGoogleGenerativeAI } = require('@ai-sdk/google');
const { createOpenAI } = require('@ai-sdk/openai');
const { createAnthropic } = require('@ai-sdk/anthropic');
const http = require('./http_runtime');

class AIConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AIConfigurationError';
  }
}

// Resolve per request so configuration errors don't prevent the rest of the app
// from starting. No browser-supplied keys, model IDs, or provider URLs are used.
function getAIModels(env = process.env, { fetch = http.fetch } = {}) {
  const provider = (env.AI_PROVIDER || 'gemini').trim().toLowerCase();
  const modelId = env.AI_MODEL?.trim();
  const localFallback = env.AI_LOCAL_FALLBACK?.trim().toLowerCase();
  if (!['gemini', 'openai', 'anthropic', 'lmstudio'].includes(provider)) {
    throw new AIConfigurationError('AI_PROVIDER must be gemini, openai, anthropic, or lmstudio.');
  }
  if (localFallback && !['true', 'false'].includes(localFallback)) {
    throw new AIConfigurationError('AI_LOCAL_FALLBACK must be true or false.');
  }
  const models = [];
  function add(model, providerOptions) {
    models.push({ model, providerOptions, label: `${provider}:${model.modelId}` });
  }
  function key(name) {
    const value = env[name]?.trim();
    if (!value) throw new AIConfigurationError(`Set ${name} for AI_PROVIDER=${provider}.`);
    return value;
  }
  if (provider === 'gemini') {
    // Existing local-only installations may have no Google key.
    if (env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || localFallback === 'false') {
      const google = createGoogleGenerativeAI({ apiKey: key('GOOGLE_GENERATIVE_AI_API_KEY'), fetch });
      // Stable default for existing accounts; an explicitly pinned model is never silently substituted.
      add(google(modelId || 'gemini-2.5-flash'));
    }
  } else if (provider === 'openai' || provider === 'anthropic') {
    if (!modelId) throw new AIConfigurationError(`Set AI_MODEL to a model available in your ${provider} API account.`);
    if (provider === 'openai') {
      const openai = createOpenAI({ apiKey: key('OPENAI_API_KEY'), fetch });
      add(openai.responses(modelId), { openai: { store: false } });
    } else {
      add(createAnthropic({ apiKey: key('ANTHROPIC_API_KEY'), fetch })(modelId));
    }
  }
  // Existing Gemini installs retain the local fallback. Other clouds must opt in;
  // a failed request never silently switches to a different cloud provider.
  if (provider === 'lmstudio' || localFallback === 'true' || (provider === 'gemini' && !env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() && localFallback !== 'false')) {
    const local = createOpenAI({ baseURL: env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1', apiKey: 'lm-studio', fetch });
    const model = local.chat((provider === 'lmstudio' && modelId) || env.LMSTUDIO_MODEL || 'qwen2.5-7b-instruct');
    models.push({ model, label: `lmstudio:${model.modelId}` });
  }
  return models;
}

module.exports = { getAIModels, AIConfigurationError };
