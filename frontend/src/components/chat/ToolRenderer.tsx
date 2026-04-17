import type { UIMessagePart, UIDataTypes, UITools } from 'ai'
import { getToolName } from 'ai'
import { CANSLIMScorecard } from '@/components/CANSLIMScorecard'
import { StockChart } from '@/components/StockChart'

/**
 * Represents a tool-related message part (static or dynamic tool invocation).
 * We use the broader UIMessagePart type filtered down to tool parts only.
 */
type ToolPart = Extract<UIMessagePart<UIDataTypes, UITools>, { type: `tool-${string}` | 'dynamic-tool' }>

interface ToolRendererProps {
  toolPart: ToolPart
}

/**
 * ToolRenderer — Maps AI tool invocations to specialised React components.
 *
 * This is the core of the Generative UI pattern: the AI model triggers tool
 * calls (e.g. `getCanslimAnalysis`, `getStockInfo`), and instead of rendering
 * raw JSON, we render rich interactive components.
 *
 * AI SDK v6 state values for tool parts:
 *  - 'input-streaming'  — tool arguments are still streaming in
 *  - 'input-available'  — tool arguments are complete, waiting for execution
 *  - 'output-available' — tool has returned a result (ready to render component)
 *  - 'output-error'     — tool execution failed
 *
 * Tool-to-component mapping:
 *  - getCanslimAnalysis  → <CANSLIMScorecard> (driven by selectedTicker store)
 *  - getStockInfo        → <StockChart> (driven by selectedTicker store)
 *  - getTechnicalIndicators → <StockChart>
 *  - getMarketDirection  → text summary (no dedicated chart)
 */
export function ToolRenderer({ toolPart }: ToolRendererProps) {
  const toolName = getToolName(toolPart)
  const state = toolPart.state

  // While the tool is being called, show a loading skeleton
  if (state === 'input-streaming' || state === 'input-available') {
    return (
      <ToolSkeleton toolName={toolName} />
    )
  }

  // Tool returned an error — show a compact error message
  if (state === 'output-error') {
    const errorText = 'errorText' in toolPart ? String(toolPart.errorText) : 'Tool call failed'
    return (
      <div className="text-xs text-destructive bg-destructive/10 rounded-md px-2 py-1">
        {toolName} failed: {errorText}
      </div>
    )
  }

  // Tool succeeded — map to specialised component
  if (state === 'output-available') {
    const output = 'output' in toolPart ? toolPart.output : undefined

    // AI SDK v6 UIToolInvocation uses "input" (not "args") for tool arguments
    const input = 'input' in toolPart && toolPart.input && typeof toolPart.input === 'object'
      ? (toolPart.input as Record<string, unknown>)
      : undefined;
    const symbol = input?.symbol && typeof input.symbol === 'string' ? input.symbol : undefined;

    switch (toolName) {
      case 'getCanslimAnalysis':
        // CANSLIMScorecard renders the AI's requested symbol, or falls back to selectedTicker
        return (
          <div className="w-full rounded-md overflow-hidden border border-border">
            <div className="px-2 pt-1 pb-0 text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
              CAN SLIM Analysis
            </div>
            <CANSLIMScorecard symbol={symbol} />
          </div>
        )

      case 'getStockInfo':
      case 'getTechnicalIndicators':
        // StockChart renders the AI's requested symbol, or falls back to selectedTicker
        return (
          <div className="w-full rounded-md overflow-hidden border border-border">
            <div className="px-2 pt-1 pb-0 text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
              {toolName === 'getTechnicalIndicators' ? 'Technical Analysis' : 'Stock Info'}
            </div>
            <StockChart symbol={symbol} compact />
          </div>
        )

      case 'getMarketDirection': {
        // Actual response shape: { status, ftd_detected, ftd_day?, ftd_gain_pct?, error? }
        if (output && typeof output === 'object') {
          const d = output as Record<string, unknown>
          const isBullish = d.status === 'success' && Boolean(d.ftd_detected)
          const statusLabel = isBullish
            ? 'Confirmed Uptrend'
            : d.ftd_detected === false
              ? 'No Follow-Through Day Detected'
              : 'Data Unavailable'
          const colorClass = isBullish ? 'text-green-400' : 'text-red-400'
          return (
            <div className="w-full rounded-md border border-border px-3 py-2 space-y-1">
              <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                Market Direction
              </div>
              <div className={`text-sm font-semibold ${colorClass}`}>
                {statusLabel}
              </div>
              {Boolean(d.ftd_day) && (
                <p className="text-xs text-muted-foreground">
                  Follow-Through Day: {String(d.ftd_day)}
                  {d.ftd_gain_pct != null ? ` (+${Number(d.ftd_gain_pct).toFixed(2)}%)` : ''}
                </p>
              )}
              {d.status !== 'success' && Boolean(d.error) && (
                <p className="text-xs text-destructive">{String(d.error)}</p>
              )}
            </div>
          )
        }
        return null
      }

      case 'getNews': {
        const articles = Array.isArray(output) ? output : (output && typeof output === 'object' && 'articles' in (output as Record<string, unknown>) ? (output as Record<string, unknown>).articles as unknown[] : null)
        if (articles && articles.length > 0) {
          return (
            <div className="w-full rounded-md border border-border px-3 py-2 space-y-2">
              <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                Latest News {symbol ? `— ${symbol}` : ''}
              </div>
              <ul className="space-y-1.5">
                {(articles as Record<string, unknown>[]).slice(0, 8).map((article, i) => (
                  <li key={i} className="text-xs leading-snug">
                    {article.link ? (
                      <a href={String(article.link)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        {String(article.title || 'Untitled')}
                      </a>
                    ) : (
                      <span className="text-foreground">{String(article.title || 'Untitled')}</span>
                    )}
                    {Boolean(article.publisher) && (
                      <span className="text-muted-foreground ml-1">— {String(article.publisher)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )
        }
        return null
      }

      default:
        // Unknown tool — show raw output as JSON for debugging
        return (
          <div className="w-full rounded-md border border-border px-3 py-2">
            <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide mb-1">
              {toolName}
            </div>
            <pre className="text-xs text-muted-foreground overflow-x-auto max-h-32">
              {JSON.stringify(output, null, 2)}
            </pre>
          </div>
        )
    }
  }

  return null
}

/** Animated skeleton shown while a tool call is pending */
function ToolSkeleton({ toolName }: { toolName: string }) {
  const label =
    toolName === 'getCanslimAnalysis' ? 'Running CAN SLIM analysis...' :
      toolName === 'getStockInfo' ? 'Fetching stock data...' :
        toolName === 'getTechnicalIndicators' ? 'Calculating technical indicators...' :
          toolName === 'getMarketDirection' ? 'Checking market direction...' :
          toolName === 'getNews' ? 'Fetching latest news...' :
            `Calling ${toolName}...`

  return (
    <div className="w-full rounded-md border border-border px-3 py-3 animate-pulse">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms' }} />
        <div className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
        <div className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms' }} />
        <span className="text-xs text-muted-foreground ml-1">{label}</span>
      </div>
    </div>
  )
}
