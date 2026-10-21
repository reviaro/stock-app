import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useMemo, useRef, useState } from 'react'
import type { ModeInputs, ModeName } from '@/types/aiMode'

/**
 * Transport that sends messages to the backend Express AI streaming endpoint.
 * Targets POST /api/ai/chat (proxied by Vite dev server to http://localhost:3002).
 *
 * Using DefaultChatTransport allows explicit API URL configuration independent
 * of the default '/api/chat' that useChat falls back to.
 */
const createTransport = (onModel: (label: string) => void) => new DefaultChatTransport({
  fetch: async (input, init) => { const response = await fetch(input, init); const model = response.headers.get('X-AI-Model'); if (model) onModel(model); return response },
  api: '/api/ai/chat',
  prepareSendMessagesRequest({ messages, body }) {
    const mode = (body as { mode?: ModeName })?.mode ?? 'free'
    const inputs = (body as { inputs?: ModeInputs })?.inputs ?? {}
    if (mode === 'free') {
      return { api: '/api/ai/chat', body: { messages, allowPaperTrading: (body as { allowPaperTrading?: boolean })?.allowPaperTrading === true } }
    }
    return { api: `/api/ai/mode/${mode}`, body: { messages, inputs } }
  },
})

/**
 * Custom hook wrapping the Vercel AI SDK v6 `useChat` for the financial agent.
 *
 * Returns the `messages` array (UIMessage objects with `parts`), `sendMessage`
 * for submitting new text, `status` for loading/streaming state, and `stop`.
 *
 * AI SDK v6 changes from v4:
 *  - Messages use `parts` array instead of `content` + `toolInvocations`.
 *  - `sendMessage({ text })` replaces `handleSubmit` form event pattern.
 *  - `status` ('ready' | 'submitted' | 'streaming' | 'error') replaces `isLoading`.
 *  - Transport is configured separately from the hook options.
 */
export function useFinancialAgent() {
  const [modelLabel, setModelLabel] = useState('')
  const transport = useMemo(() => createTransport(setModelLabel), [])
  const modeRef = useRef<{ mode: ModeName; inputs: ModeInputs }>({ mode: 'free', inputs: {} })
  const { messages, setMessages, sendMessage, status, error, stop } = useChat({
    transport,
  })

  const isLoading = status === 'submitted' || status === 'streaming'

  function send(text: string, modeOverride?: { mode: ModeName; inputs: ModeInputs; allowPaperTrading?: boolean }) {
    const active = modeOverride ?? modeRef.current
    sendMessage({ text }, { body: active })
  }

  return {
    messages,
    setMessages,
    sendMessage: send,
    isLoading,
    status,
    error,
    stop,
    modeRef,
    modelLabel,
  }
}
