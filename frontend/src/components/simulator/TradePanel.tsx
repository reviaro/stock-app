import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TaxPreview } from '@/components/simulator/TaxPreview'
import { useSimTrade, useTaxPreview, useSimAccount } from '@/hooks/useSimulator'
import type { SimHolding } from '@/types/simulator'

interface Props {
  accountId: number
  sellTarget: SimHolding | null
  onSellClose: () => void
  structuredJournal?: boolean
}

function BuyForm({ accountId, structuredJournal = false }: { accountId: number; structuredJournal?: boolean }) {
  const trade = useSimTrade(accountId)
  const { data: account } = useSimAccount(accountId)
  const [symbol, setSymbol] = useState('')
  const [shares, setShares] = useState('')
  const [setup, setSetup] = useState('')
  const [catalyst, setCatalyst] = useState('')
  const [thesis, setThesis] = useState('')
  const [stopPrice, setStopPrice] = useState('')
  const [targetPrice, setTargetPrice] = useState('')
  const [invalidation, setInvalidation] = useState('')
  const today = new Date().toISOString().slice(0, 10)

  const { data: priceData } = useQuery({
    queryKey: ['stock-price', symbol],
    queryFn: async () => {
      const r = await fetch(`/api/stock/${symbol.trim().toUpperCase()}`)
      if (!r.ok) return null
      const j = await r.json()
      return typeof j?.data?.price === 'number' ? j.data.price : null
    },
    enabled: symbol.trim().length > 0,
    refetchInterval: 60_000,
  })
  const currentPrice = priceData ?? null

  const estimatedCost = Number(shares) > 0 && currentPrice != null
    ? Number(shares) * currentPrice
    : null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!symbol || !shares || currentPrice == null) return
    if (structuredJournal && (!setup || !thesis || !stopPrice || !targetPrice)) return
    await trade.mutateAsync({
      type: 'buy',
      symbol: symbol.toUpperCase(),
      shares: Number(shares),
      price: currentPrice,
      txn_date: today,
      ...(structuredJournal ? {
        trade_plan: {
          setup,
          catalyst,
          thesis,
          stop_price: Number(stopPrice),
          target_price: Number(targetPrice),
          invalidation,
        },
      } : {}),
    })
    setSymbol('')
    setShares('')
    setSetup('')
    setCatalyst('')
    setThesis('')
    setStopPrice('')
    setTargetPrice('')
    setInvalidation('')
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Buy</p>
      <input
        value={symbol}
        onChange={(e) => setSymbol(e.target.value.toUpperCase())}
        placeholder="Symbol (e.g. AAPL)"
        className="w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs"
      />
      <input
        type="number"
        step="any"
        value={shares}
        onChange={(e) => setShares(e.target.value)}
        placeholder="Shares"
        className="w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs"
      />
      {structuredJournal && (
        <div className="space-y-2 rounded-md border border-border/70 bg-background/50 p-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Structured plan</p>
          <label className="block text-[11px] text-muted-foreground">Setup<input aria-label="Setup" value={setup} onChange={(e) => setSetup(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></label>
          <label className="block text-[11px] text-muted-foreground">Catalyst<input aria-label="Catalyst" value={catalyst} onChange={(e) => setCatalyst(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></label>
          <label className="block text-[11px] text-muted-foreground">Thesis<textarea aria-label="Thesis" value={thesis} onChange={(e) => setThesis(e.target.value)} rows={2} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[11px] text-muted-foreground">Hard stop<input aria-label="Hard stop" type="number" step="any" value={stopPrice} onChange={(e) => setStopPrice(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></label>
            <label className="block text-[11px] text-muted-foreground">Target<input aria-label="Target" type="number" step="any" value={targetPrice} onChange={(e) => setTargetPrice(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></label>
          </div>
          <label className="block text-[11px] text-muted-foreground">Invalidation<input aria-label="Invalidation" value={invalidation} onChange={(e) => setInvalidation(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></label>
        </div>
      )}
      <div className="text-sm text-muted-foreground">
        Current price: {currentPrice != null ? `$${currentPrice.toFixed(2)}` : '—'}
      </div>
      {estimatedCost != null && (
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Est. cost</span>
          <span className="font-mono">${estimatedCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
        </div>
      )}
      {account && estimatedCost != null && (
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Cash after</span>
          <span className={`font-mono ${account.cash - estimatedCost < 0 ? 'text-red-400' : ''}`}>
            ${Math.max(0, account.cash - estimatedCost).toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </span>
        </div>
      )}
      {trade.isError && (
        <p className="text-xs text-destructive">{trade.error instanceof Error ? trade.error.message : 'Trade failed'}</p>
      )}
      <button
        type="submit"
        disabled={trade.isPending || !symbol || !shares || currentPrice == null || (structuredJournal && (!setup || !thesis || !stopPrice || !targetPrice))}
        className="w-full rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
      >
        {trade.isPending ? 'Placing order…' : 'Buy'}
      </button>
    </form>
  )
}

interface SellFormProps {
  accountId: number
  holding: SimHolding
  onClose: () => void
  structuredJournal?: boolean
}

function SellForm({ accountId, holding, onClose, structuredJournal = false }: SellFormProps) {
  const trade = useSimTrade(accountId)
  const [shares, setShares] = useState(String(holding.shares))
  const [exitReason, setExitReason] = useState<'stop' | 'target' | 'time_exit' | 'thesis_break' | 'discretionary'>('time_exit')
  const [thesisValid, setThesisValid] = useState(true)
  const [mfe, setMfe] = useState('')
  const [mae, setMae] = useState('')
  const [reviewNotes, setReviewNotes] = useState('')
  const today = new Date().toISOString().slice(0, 10)

  const sharesNum = Number(shares)
  const price = holding.currentPrice

  const { data: taxPreview, isLoading: taxLoading } = useTaxPreview(
    accountId,
    holding.symbol,
    sharesNum,
  )

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!shares || !price) return
    await trade.mutateAsync({
      type: 'sell',
      symbol: holding.symbol,
      shares: sharesNum,
      price,
      txn_date: today,
      ...(structuredJournal ? {
        journal: {
          exit_reason: exitReason,
          thesis_valid: thesisValid,
          ...(mfe ? { mfe: Number(mfe) } : {}),
          ...(mae ? { mae: Number(mae) } : {}),
          review_notes: reviewNotes,
        },
      } : {}),
    })
    onClose()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Sell {holding.symbol}
        </p>
        <button type="button" onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">✕</button>
      </div>
      <div className="text-xs text-muted-foreground">
        Own {holding.shares} shares @ avg ${holding.avg_cost.toFixed(2)} · Current ${price != null ? price.toFixed(2) : '—'}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          step="any"
          min="0"
          max={holding.shares}
          value={shares}
          onChange={(e) => setShares(e.target.value)}
          placeholder="Shares to sell"
          className="w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs"
        />
        <button
          type="button"
          onClick={() => setShares(String(holding.shares))}
          className="text-xs px-2 py-1.5 rounded-md border border-border text-muted-foreground whitespace-nowrap"
        >
          All
        </button>
      </div>
      {structuredJournal && (
        <div className="space-y-2 rounded-md border border-border/70 bg-background/50 p-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Exit review</p>
          <label className="block text-[11px] text-muted-foreground">Exit reason<select aria-label="Exit reason" value={exitReason} onChange={(e) => setExitReason(e.target.value as typeof exitReason)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground"><option value="stop">Stop</option><option value="target">Target</option><option value="time_exit">Time exit</option><option value="thesis_break">Thesis break</option><option value="discretionary">Discretionary</option></select></label>
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground"><input aria-label="Thesis remained valid" type="checkbox" checked={thesisValid} onChange={(e) => setThesisValid(e.target.checked)} />Thesis remained valid</label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[11px] text-muted-foreground">MFE ($)<input aria-label="Maximum favorable excursion" type="number" step="any" value={mfe} onChange={(e) => setMfe(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></label>
            <label className="block text-[11px] text-muted-foreground">MAE ($)<input aria-label="Maximum adverse excursion" type="number" step="any" value={mae} onChange={(e) => setMae(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></label>
          </div>
          <label className="block text-[11px] text-muted-foreground">Review notes<textarea aria-label="Review notes" rows={2} value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></label>
        </div>
      )}
      {taxPreview && <TaxPreview preview={taxPreview} isLoading={taxLoading} />}
      {!taxPreview && taxLoading && <p className="text-xs text-muted-foreground">Calculating tax…</p>}
      {trade.isError && (
        <p className="text-xs text-destructive">{trade.error instanceof Error ? trade.error.message : 'Trade failed'}</p>
      )}
      <button
        type="submit"
        disabled={trade.isPending || !shares || !price || Number(shares) <= 0}
        className="w-full rounded-md bg-destructive px-3 py-1.5 text-xs text-destructive-foreground disabled:opacity-50"
      >
        {trade.isPending ? 'Placing order…' : `Sell ${shares} ${holding.symbol}`}
      </button>
    </form>
  )
}

export function TradePanel({ accountId, sellTarget, onSellClose, structuredJournal = false }: Props) {
  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle>Trade</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto min-h-0 px-3 pb-3 space-y-4">
        {sellTarget ? (
          <SellForm accountId={accountId} holding={sellTarget} onClose={onSellClose} structuredJournal={structuredJournal} />
        ) : (
          <BuyForm accountId={accountId} structuredJournal={structuredJournal} />
        )}
      </CardContent>
    </Card>
  )
}
