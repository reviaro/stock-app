const { generateText, streamText, pipeUIMessageStreamToResponse } = require('ai');

const UNAVAILABLE = 'AI provider unavailable. Check the configured model, API key, and provider quota.';

async function generateWithModels(models, options) {
  for (const { model, providerOptions } of models) {
    try {
      return await generateText({ ...options, model, providerOptions });
    } catch {
      // Provider errors may contain request data; don't expose them to the client.
    }
  }
  throw new Error(UNAVAILABLE);
}

async function streamWithModels(res, models, options) {
  for (const { model, providerOptions } of models) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    let reader;
    let committed = false;
    try {
      const result = streamText({ ...options, model, providerOptions, abortSignal: controller.signal,
        onError: () => {},
      });
      reader = result.toUIMessageStream({ onError: () => UNAVAILABLE }).getReader();
      const prefix = [];
      // SDK streams are lazy. Check the first useful event before sending HTTP
      // headers so authentication/rate-limit failures can actually fall back.
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error(UNAVAILABLE);
        if (value.type === 'error') throw new Error(UNAVAILABLE);
        prefix.push(value);
        if (!['start', 'start-step'].includes(value.type)) break;
      }
      // Never replay a conversation after text or tool input starts: a tool can
      // change simulator state, and a retry could execute the intention twice.
      committed = true;
      await pipeUIMessageStreamToResponse({ response: res, stream: new ReadableStream({
        async pull(controller) {
          if (prefix.length) { controller.enqueue(prefix.shift()); return; }
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel() { abort(); return reader.cancel(); },
      }) });
      return;
    } catch {
      if (committed || res.headersSent || res.destroyed) return;
    } finally {
      abort();
      if (reader) await reader.cancel().catch(() => {});
      res.removeListener('close', abort);
    }
  }
  if (!res.headersSent && !res.destroyed) res.status(503).json({ error: UNAVAILABLE });
}

module.exports = { generateWithModels, streamWithModels };
