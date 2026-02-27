import { useRef, useEffect, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Send, Square, Trash2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useFinancialAgent } from '@/hooks/useFinancialAgent'
import { Message } from './Message'

/** Suggested prompt pills shown when the chat is empty */
const SUGGESTED_PROMPTS = [
  'Analyze AAPL with CANSLIM criteria',
  'What is the current market direction?',
  'Technical indicators for NVDA',
  'Compare MSFT and GOOGL fundamentals',
]

/**
 * ChatPanel — Main AI interaction interface.
 *
 * Renders a scrollable message history and a text input. Each message is
 * rendered via the <Message> component, which delegates tool invocations to
 * <ToolRenderer> for Generative UI (charts, scorecards, etc.).
 *
 * Uses AI SDK v6 `useFinancialAgent` hook:
 * - `sendMessage({ text })` instead of `handleSubmit` form events.
 * - `status` ('ready' | 'submitted' | 'streaming' | 'error') instead of `isLoading`.
 */
export function ChatPanel() {
  const { messages, setMessages, sendMessage, isLoading, stop, error } = useFinancialAgent()
  const [inputValue, setInputValue] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const isEmpty = messages.length === 0

  function handleSend() {
    const text = inputValue.trim()
    if (!text || isLoading) return
    sendMessage({ text })
    setInputValue('')
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Submit on Enter (Shift+Enter inserts a newline)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleSuggestedPrompt(prompt: string) {
    if (isLoading) return
    sendMessage({ text: prompt })
  }

  return (
    <Card className="h-full flex flex-col min-h-[400px]">
      <CardHeader className="pb-2 pt-3 px-4 flex flex-row items-center justify-between shrink-0 space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          AI Financial Analyst
        </CardTitle>
        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-muted-foreground hover:text-destructive"
            onClick={() => setMessages([])}
            title="Clear conversation"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </CardHeader>

      <CardContent className="flex flex-col flex-1 overflow-hidden p-3 gap-3">
        {/* Message list */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto space-y-2 pr-1"
          style={{ minHeight: 0 }}
        >
          {isEmpty && (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-center py-8">
              <p className="text-muted-foreground text-sm">
                Ask me anything about stocks, market conditions, or CAN SLIM analysis.
              </p>
              <div className="flex flex-wrap gap-2 justify-center">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => handleSuggestedPrompt(prompt)}
                    className="text-xs px-3 py-1.5 rounded-full border border-border bg-muted/40 hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors"
                    disabled={isLoading}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          <AnimatePresence initial={false}>
            {messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
          </AnimatePresence>

          {/* Error display */}
          {error && (
            <div className="text-xs text-destructive bg-destructive/10 rounded-md p-2 mt-2">
              Error: {error.message || 'Something went wrong. Please try again.'}
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="flex gap-2 items-end shrink-0">
          <textarea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about a stock, sector, or market condition..."
            rows={1}
            className="flex-1 min-h-[36px] max-h-[120px] resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            disabled={isLoading}
          />

          {isLoading ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={stop}
              title="Stop generation"
              className="shrink-0"
            >
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              disabled={!inputValue.trim()}
              onClick={handleSend}
              title="Send message"
              className="shrink-0"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export default ChatPanel
