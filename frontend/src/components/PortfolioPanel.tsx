import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { usePortfolio } from '@/hooks/usePortfolio'
import { MemoDrawer } from '@/components/MemoDrawer'
import { useMemosListQuery } from '@/hooks/useMemo'
import { RiskRulesDrawer } from '@/components/RiskRulesDrawer'
import { StopLossEditor } from '@/components/StopLossEditor'
import { RecordTransactionForm } from '@/components/RecordTransactionForm'
import { useDeleteTransaction } from '@/hooks/useTransactions'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

function fmt(n: number | null, decimals = 2) {
  if (n == null) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function fmtPct(n: number | null) {
  if (n == null) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

export function PortfolioPanel() {
  const { data, isLoading, isError } = usePortfolio()
  const deleteTransaction = useDeleteTransaction()
  const [showAdd, setShowAdd] = useState(false)
  const [showRules, setShowRules] = useState(false)
  const [memoSymbol, setMemoSymbol] = useState<string | null>(null)
  const { data: memos } = useMemosListQuery()
  const memoMap = new Map((memos ?? []).map(m => [m.symbol, m]))
  const summary = data?.summary
  const holdings = data?.holdings ?? []
  const transactions = data?.recentTransactions ?? []
  const totalValue = summary?.totalValue ?? 0
  const totalPnl = (summary?.realizedPnl ?? 0) + (summary?.unrealizedPnl ?? 0)
  const totalPnlPct = totalValue > 0 ? (totalPnl / totalValue) * 100 : 0

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle>Portfolio</CardTitle>
            {summary && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Value: <span className="font-mono text-foreground">${fmt(totalValue)}</span>
                <span className={`ml-2 font-mono ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {totalPnl >= 0 ? '+' : ''}${fmt(totalPnl)} ({fmtPct(totalPnlPct)})
                </span>
                <span className={`ml-2 ${summary.cashPct != null && data?.rules && summary.cashPct < data.rules.target_cash_pct ? 'text-amber-400' : ''}`}>
                  Cash: {summary.cashPct == null ? '—' : `${fmt(summary.cashPct, 1)}%`}
                </span>
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowRules(true)} className="data-hover text-xs px-2 py-0.5 rounded-md border border-border text-muted-foreground hover:text-foreground">
              ⚙ Rules
            </button>
            <button
              type="button"
              onClick={() => setShowAdd(v => !v)}
              className={[
                'data-hover text-xs px-2 py-0.5 rounded-md border',
                showAdd
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-transparent text-muted-foreground border-border hover:border-primary hover:text-foreground',
              ].join(' ')}
            >
              + Add
            </button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-3 flex-1 overflow-y-auto min-h-0 pb-4 space-y-2">
        <AnimatePresence>
          {showAdd && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
              <RecordTransactionForm onClose={() => setShowAdd(false)} />
            </motion.div>
          )}
        </AnimatePresence>

        {isLoading && <p className="text-muted-foreground text-sm">Loading portfolio...</p>}
        {isError && <p className="text-destructive text-sm">Failed to load portfolio.</p>}
        {!isLoading && !isError && (!holdings || holdings.length === 0) && (
          <p className="text-muted-foreground text-sm">No positions yet. Click "+ Add" to track a trade.</p>
        )}

        {holdings.map((pos, i) => {
          const isGain = (pos.pnl ?? 0) >= 0
          const pricePct = pos.currentPrice && pos.avg_cost > 0
            ? ((pos.currentPrice - pos.avg_cost) / pos.avg_cost) * 100
            : null
          const weight = totalValue > 0 && pos.currentValue != null
            ? (pos.currentValue / totalValue) * 100
            : null

          return (
            <motion.div
              key={pos.symbol}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, transition: { delay: i * 0.03, duration: 0.18 } }}
              className="data-hover group flex items-center justify-between rounded-lg border border-border/70 bg-card/50 px-3 py-2 gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-semibold text-sm text-foreground">{pos.symbol}</span>
                  <Badge variant="secondary" className="text-[10px] py-0 px-1.5">
                    {pos.shares} sh @ ${fmt(pos.avg_cost)}
                  </Badge>
                  {weight != null && (
                    <span className="text-[10px] text-muted-foreground">{fmt(weight, 1)}% of portfolio</span>
                  )}
                  {pos.breaches.map((breach, idx) => (
                    <Badge key={`${breach.kind}-${idx}`} variant="destructive" className="text-[10px] py-0 px-1">
                      {breach.kind === 'position' ? `Position ${fmt(breach.actual, 1)}%` :
                        breach.kind === 'risk_per_trade' ? `Risk ${fmt(breach.actual, 2)}%` :
                        breach.kind === 'sector' ? `${breach.sector} ${fmt(breach.actual, 1)}%` :
                        `Cash ${fmt(breach.actual, 1)}%`}
                    </Badge>
                  ))}
                </div>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  {pos.currentPrice != null && (
                    <span className="text-xs font-mono text-foreground">${fmt(pos.currentPrice)}</span>
                  )}
                  {pos.pnl != null && (
                    <span className={`text-xs font-mono font-semibold ${isGain ? 'text-green-400' : 'text-red-400'}`}>
                      {isGain ? '+' : ''}${fmt(pos.pnl)} ({fmtPct(pricePct)})
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground">Cost ${fmt(pos.total_cost)}</span>
                  <StopLossEditor symbol={pos.symbol} stopLoss={pos.stop_loss} />
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setMemoSymbol(pos.symbol) }}
                  title={memoMap.has(pos.symbol) ? 'Edit memo' : 'Add memo'}
                  className={[
                    'text-[10px] px-1.5 py-0.5 rounded border shrink-0',
                    memoMap.has(pos.symbol) ? 'border-primary text-primary' : 'border-border text-muted-foreground',
                  ].join(' ')}
                >
                  📝
                </button>
              </div>
            </motion.div>
          )
        })}

        {transactions.length > 0 && (
          <div className="pt-3 mt-3 border-t border-border/70 space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Recent Transactions</p>
            {transactions.map((txn) => (
              <div key={txn.id} className="data-hover flex items-center justify-between rounded-md border border-border/60 px-2 py-1.5 text-xs">
                <div className="min-w-0">
                  <span className="font-medium text-foreground">{txn.type.toUpperCase()}</span>
                  <span className="ml-2 text-muted-foreground">{txn.symbol ?? 'Cash'} · {txn.txn_date}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-foreground">${fmt(txn.amount)}</span>
                  <button type="button" onClick={() => deleteTransaction.mutate(txn.id)} className="text-muted-foreground hover:text-destructive">
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <MemoDrawer symbol={memoSymbol} open={!!memoSymbol} onOpenChange={(o) => { if (!o) setMemoSymbol(null) }} />
      <RiskRulesDrawer open={showRules} onOpenChange={setShowRules} rules={data?.rules ?? null} />
    </Card>
  )
}

export default PortfolioPanel
