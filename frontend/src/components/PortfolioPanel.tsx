import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { usePortfolio, useAddPosition, useRemovePosition } from '@/hooks/usePortfolio'
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

function AddPositionForm({ onClose }: { onClose: () => void }) {
  const addMutation = useAddPosition()
  const [symbol, setSymbol] = useState('')
  const [shares, setShares] = useState('')
  const [buyPrice, setBuyPrice] = useState('')
  const [buyDate, setBuyDate] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!symbol || !shares || !buyPrice) return
    try {
      await addMutation.mutateAsync({
        symbol: symbol.toUpperCase(),
        shares: Number(shares),
        buy_price: Number(buyPrice),
        buy_date: buyDate || undefined,
      })
      onClose()
    } catch { /* error shown via mutation.isError */ }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
    >
      <form onSubmit={handleSubmit} className="space-y-2 mb-3 p-3 rounded-lg border border-border bg-card/60">
        <p className="text-xs font-medium text-foreground">Add Position</p>
        <div className="grid grid-cols-2 gap-2">
          <input
            value={symbol} onChange={e => setSymbol(e.target.value)}
            placeholder="Symbol (e.g. AAPL)"
            className="col-span-2 text-xs px-2 py-1.5 rounded-md bg-secondary border border-border focus:border-primary focus:outline-none"
            required
          />
          <input
            type="number" step="any" min="0.0001"
            value={shares} onChange={e => setShares(e.target.value)}
            placeholder="Shares"
            className="text-xs px-2 py-1.5 rounded-md bg-secondary border border-border focus:border-primary focus:outline-none"
            required
          />
          <input
            type="number" step="any" min="0.0001"
            value={buyPrice} onChange={e => setBuyPrice(e.target.value)}
            placeholder="Buy price ($)"
            className="text-xs px-2 py-1.5 rounded-md bg-secondary border border-border focus:border-primary focus:outline-none"
            required
          />
          <input
            type="date"
            value={buyDate} onChange={e => setBuyDate(e.target.value)}
            className="col-span-2 text-xs px-2 py-1.5 rounded-md bg-secondary border border-border focus:border-primary focus:outline-none text-muted-foreground"
          />
        </div>
        {addMutation.isError && (
          <p className="text-xs text-destructive">{addMutation.error instanceof Error ? addMutation.error.message : 'Error'}</p>
        )}
        <div className="flex gap-2">
          <button type="submit" disabled={addMutation.isPending}
            className="text-xs px-3 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {addMutation.isPending ? 'Adding…' : 'Add'}
          </button>
          <button type="button" onClick={onClose}
            className="text-xs px-3 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors">
            Cancel
          </button>
        </div>
      </form>
    </motion.div>
  )
}

export function PortfolioPanel() {
  const { data, isLoading, isError } = usePortfolio()
  const removeMutation = useRemovePosition()
  const [showAdd, setShowAdd] = useState(false)

  const totalValue = data?.reduce((sum, p) => sum + (p.currentValue ?? p.costBasis), 0) ?? 0
  const totalCost = data?.reduce((sum, p) => sum + p.costBasis, 0) ?? 0
  const totalPnl = totalValue - totalCost
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle>Portfolio</CardTitle>
            {data && data.length > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Value: <span className="font-mono text-foreground">${fmt(totalValue)}</span>
                <span className={`ml-2 font-mono ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {totalPnl >= 0 ? '+' : ''}${fmt(totalPnl)} ({fmtPct(totalPnlPct)})
                </span>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowAdd(v => !v)}
            className={[
              'text-xs px-2 py-0.5 rounded-md border transition-colors',
              showAdd
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-transparent text-muted-foreground border-border hover:border-primary hover:text-foreground',
            ].join(' ')}
          >
            + Add
          </button>
        </div>
      </CardHeader>

      <CardContent className="px-3 flex-1 overflow-y-auto min-h-0 pb-4 space-y-2">
        <AnimatePresence>
          {showAdd && <AddPositionForm onClose={() => setShowAdd(false)} />}
        </AnimatePresence>

        {isLoading && <p className="text-muted-foreground text-sm">Loading portfolio...</p>}
        {isError && <p className="text-destructive text-sm">Failed to load portfolio.</p>}
        {!isLoading && !isError && (!data || data.length === 0) && (
          <p className="text-muted-foreground text-sm">No positions yet. Click "+ Add" to track a trade.</p>
        )}

        {data?.map((pos, i) => {
          const isGain = (pos.pnl ?? 0) >= 0
          const pricePct = pos.currentPrice && pos.buy_price > 0
            ? ((pos.currentPrice - pos.buy_price) / pos.buy_price) * 100
            : null
          const weight = totalValue > 0 && pos.currentValue != null
            ? (pos.currentValue / totalValue) * 100
            : null

          return (
            <motion.div
              key={pos.symbol}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, transition: { delay: i * 0.03, duration: 0.18 } }}
              className="group flex items-center justify-between rounded-lg border border-border/70 bg-card/50 px-3 py-2 gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-semibold text-sm text-foreground">{pos.symbol}</span>
                  <Badge variant="secondary" className="text-[10px] py-0 px-1.5">
                    {pos.shares} sh @ ${fmt(pos.buy_price)}
                  </Badge>
                  {weight != null && (
                    <span className="text-[10px] text-muted-foreground">{fmt(weight, 1)}% of portfolio</span>
                  )}
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
                  <span className="text-[10px] text-muted-foreground">Cost ${fmt(pos.costBasis)}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeMutation.mutate(pos.symbol)}
                disabled={removeMutation.isPending}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive p-1 rounded shrink-0"
                aria-label={`Remove ${pos.symbol} from portfolio`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </motion.div>
          )
        })}
      </CardContent>
    </Card>
  )
}

export default PortfolioPanel
