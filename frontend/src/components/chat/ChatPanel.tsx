import { useRef, useEffect, useMemo, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Send, Square, Trash2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useFinancialAgent } from '@/hooks/useFinancialAgent'
import { Message } from './Message'
import { ModesDropdown } from './ModesDropdown'
import { ModeInputsPanel } from './ModeInputs'
import { MemoDrawer } from '@/components/MemoDrawer'
import { MODE_LABELS, type ModeInputs, type ModeName } from '@/types/aiMode'
import type { MemoInput } from '@/types/memo'

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
  const [mode, setMode] = useState<ModeName>('free')
  const [modeInputs, setModeInputs] = useState<ModeInputs>({})
  const [memoSymbol, setMemoSymbol] = useState<string | null>(null)
  const [memoDraft, setMemoDraft] = useState<MemoInput | null>(null)
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
    sendMessage(text, { mode, inputs: modeInputs })
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
    sendMessage(prompt, { mode: 'free', inputs: {} })
  }

  function runMode() {
    if (isLoading) return
    const modeText = mode === 'free' ? inputValue.trim() : `${MODE_LABELS[mode]}`
    if (!modeText) return
    sendMessage(modeText, { mode, inputs: modeInputs })
    if (mode === 'free') setInputValue('')
  }

  const latestAssistantText = useMemo(() => {
    const assistant = [...messages].reverse().find((message) => message.role === 'assistant')
    if (!assistant) return ''
    return assistant.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('')
  }, [messages])

  function parseMemoDraft(markdown: string): MemoInput {
    const out: MemoInput = {}
    const thesisMatch = markdown.match(/##\s*Thesis\s*\n([\s\S]*?)(?=\n##\s|$)/i)
    if (thesisMatch) out.thesis = thesisMatch[1].trim()
    const fairValueMatch = markdown.match(/fair_value_low[^\d]*(\d+(?:\.\d+)?)[\s\S]*?fair_value_high[^\d]*(\d+(?:\.\d+)?)/i)
    if (fairValueMatch) {
      out.fair_value_low = Number(fairValueMatch[1])
      out.fair_value_high = Number(fairValueMatch[2])
    }
    const buyBelowMatch = markdown.match(/##\s*Buy Below\s*\n(?:.*\$)?(\d+(?:\.\d+)?)/i)
    if (buyBelowMatch) out.buy_below = Number(buyBelowMatch[1])
    const sellRuleMatch = markdown.match(/##\s*Sell Rule\s*\n([\s\S]*?)(?=\n##\s|$)/i)
    if (sellRuleMatch) out.sell_rule = sellRuleMatch[1].trim()
    const invalidationMatch = markdown.match(/##\s*Invalidation\s*\n([\s\S]*?)(?=\n##\s|$)/i)
    if (invalidationMatch) out.invalidation = invalidationMatch[1].trim()
    const riskMatch = markdown.match(/##\s*Risks\s*\n([\s\S]*?)(?=\n##\s|$)/i)
    if (riskMatch) out.risks = riskMatch[1].trim()
    const convictionMatch = markdown.match(/##\s*Conviction\s*\n.*?([1-5])/i)
    if (convictionMatch) out.conviction = Number(convictionMatch[1])
    return out
  }

  return (
    <Card className="h-full flex flex-col min-h-[400px]">
        <CardHeader className="pb-2 pt-3 px-4 flex flex-row items-center justify-between shrink-0 space-y-0">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            AI Financial Analyst
          </CardTitle>
          <ModesDropdown value={mode} onChange={(next) => { setMode(next); setModeInputs({}) }} disabled={isLoading} />
        </div>
        <div className="flex items-center gap-2">
          {mode === 'decisionMemo' && modeInputs.symbol && latestAssistantText && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setMemoSymbol(modeInputs.symbol ?? null)
                setMemoDraft(parseMemoDraft(latestAssistantText))
              }}
            >
              Save to Memo
            </Button>
          )}
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
        </div>
      </CardHeader>

      <CardContent className="flex flex-col flex-1 overflow-hidden p-3 gap-3">
        <ModeInputsPanel mode={mode} inputs={modeInputs} onChange={setModeInputs} onRun={runMode} disabled={isLoading} />
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
                    className="data-hover text-xs px-3 py-1.5 rounded-full border border-border bg-muted/40 text-muted-foreground hover:text-foreground"
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
              disabled={mode === 'free' ? !inputValue.trim() : false}
              onClick={handleSend}
              title="Send message"
              className="shrink-0"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardContent>
      <MemoDrawer symbol={memoSymbol} open={!!memoSymbol} onOpenChange={(open) => { if (!open) { setMemoSymbol(null); setMemoDraft(null) } }} initialDraft={memoDraft} />
    </Card>
  )
}

export default ChatPanel
