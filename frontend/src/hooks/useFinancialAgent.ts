import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'

/**
 * Transport that sends messages to the backend Express AI streaming endpoint.
 * Targets POST /api/ai/chat (proxied by Vite dev server to http://localhost:3002).
 *
 * Using DefaultChatTransport allows explicit API URL configuration independent
 * of the default '/api/chat' that useChat falls back to.
 */
const financialAgentTransport = new DefaultChatTransport({
  api: '/api/ai/chat',
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
  const { messages, sendMessage, status, error, stop } = useChat({
    transport: financialAgentTransport,
  })

  const isLoading = status === 'submitted' || status === 'streaming'

  return {
    messages,
    sendMessage,
    isLoading,
    status,
    error,
    stop,
  }
}
