const { generateText, streamText, pipeUIMessageStreamToResponse } = require('ai');

const UNAVAILABLE = 'AI provider unavailable. Check the configured model, API key, and provider quota.';

async function generateWithModels(models, options) {
  const {onAudit, ...request} = options;
  for (const { model, providerOptions, label } of models) {
    let generated=false;
    try {
      await onAudit?.({model:label||model.modelId,event:'request',detail:{system:request.system,prompt:request.prompt,messages:request.messages}});
      const result=await generateText({ ...request, model, providerOptions });
      generated=true;
      await onAudit?.({model:label||model.modelId,event:'result',detail:{text:result.text,steps:result.steps,usage:result.usage}});
      result.modelLabel=label||model.modelId;
      return result;
    } catch {
      if(generated || request.tools)throw new Error(UNAVAILABLE);
      // Provider errors may contain request data; don't expose them to the client.
    }
  }
  throw new Error(UNAVAILABLE);
}

async function streamWithModels(res, models, options) {
  const {onAudit, ...request} = options;
  for (const { model, providerOptions, label } of models) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    let reader;
    let committed = false;
    try {
      await onAudit?.({model:label||model.modelId,event:'request',detail:{system:request.system,messages:request.messages}});
      const result = streamText({ ...request, model, providerOptions, abortSignal: controller.signal,
        onStepFinish:async step=>{
          await onAudit?.({model:label||model.modelId,event:'step',detail:{text:step.text,toolCalls:step.toolCalls,toolResults:step.toolResults,finishReason:step.finishReason}});
          await request.onStepFinish?.(step);
        },
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
      if(!res.headersSent)res.setHeader('X-AI-Model',label||model.modelId);
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
