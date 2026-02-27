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
    const args = 'args' in toolPart && toolPart.args ? (toolPart.args as Record<string, unknown>) : undefined
    const symbol = args?.symbol && typeof args.symbol === 'string' ? args.symbol : undefined

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
            <div className="h-[200px]">
              <StockChart symbol={symbol} />
            </div>
          </div>
        )

      case 'getMarketDirection':
        // Market direction result is compact enough to render as structured text
        if (output && typeof output === 'object') {
          const direction = output as Record<string, unknown>
          return (
            <div className="w-full rounded-md border border-border px-3 py-2 space-y-1">
              <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                Market Direction
              </div>
              {Boolean(direction.direction) && (
                <div className={`text-sm font-semibold ${String(direction.direction).includes('Uptrend') ? 'text-green-400' :
                    String(direction.direction).includes('Pressure') ? 'text-amber-400' :
                      'text-red-400'
                  }`}>
                  {String(direction.direction)}
                </div>
              )}
              {Boolean(direction.summary) && (
                <p className="text-xs text-muted-foreground">{String(direction.summary)}</p>
              )}
            </div>
          )
        }
        return null

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
