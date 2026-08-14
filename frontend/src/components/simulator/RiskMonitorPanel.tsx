import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useSimRiskMonitor } from '@/hooks/useSimulator'

interface Props { accountId: number }

const severityClass: Record<string, string> = {
  critical: 'border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-200',
  warning: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-100',
  info: 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-100',
}

const sourceLabel: Record<string, string> = {
  alpaca_iex: 'Alpaca IEX',
  alpaca_sip: 'Alpaca SIP',
  yfinance: 'yfinance fallback',
  unavailable: 'Unavailable',
}

function formatMarketState(value: string | null) {
  if (!value) return 'Unknown session'
  return value.charAt(0) + value.slice(1).toLowerCase()
}

export function RiskMonitorPanel({ accountId }: Props) {
  const { data, isLoading, isError } = useSimRiskMonitor(accountId)

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle><h2>Position Risk Monitor</h2></CardTitle>
          <span className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground">Read-only</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-3 pb-4">
        <p className="text-xs text-muted-foreground">
          Checks documented stops, targets, missing plans, and quote health. It never submits or closes an order.
        </p>
        {isLoading && <p className="text-xs text-muted-foreground">Checking open positions…</p>}
        {isError && <p className="text-xs text-destructive">Risk monitor unavailable. Treat open positions as unmonitored.</p>}
        {data?.positions.map((position) => (
          <div key={position.symbol} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs">
            <strong>{position.symbol}</strong>
            <span className="text-muted-foreground">
              {sourceLabel[position.data_source] || position.data_source} · {formatMarketState(position.market_state)}
            </span>
          </div>
        ))}
        {data && data.alerts.length === 0 && (
          <div className="rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-200">
            No stop, target, plan, or quote-health alerts at the last check.
          </div>
        )}
        {data?.alerts.map((item, index) => (
          <div key={`${item.symbol}-${item.type}-${index}`} className={`rounded-md border px-3 py-2 text-xs ${severityClass[item.severity] || severityClass.warning}`}>
            <div className="flex items-center justify-between gap-2">
              <strong>{item.symbol} · {item.type.replaceAll('_', ' ')}</strong>
              <span className="uppercase text-[10px] font-semibold">{item.severity}</span>
            </div>
            <p className="mt-1">{item.message}</p>
          </div>
        ))}
        {data && <p className="text-[10px] text-muted-foreground">Last checked: {new Date(data.checked_at).toLocaleString()}</p>}
      </CardContent>
    </Card>
  )
}
