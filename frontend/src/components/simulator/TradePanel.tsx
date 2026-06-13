import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TaxPreview } from '@/components/simulator/TaxPreview'
import { useSimTrade, useTaxPreview, useSimAccount } from '@/hooks/useSimulator'
import type { SimHolding } from '@/types/simulator'

interface Props {
  sellTarget: SimHolding | null
  onSellClose: () => void
}

function BuyForm() {
  const trade = useSimTrade()
  const { data: account } = useSimAccount()
  const [symbol, setSymbol] = useState('')
  const [shares, setShares] = useState('')
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
    await trade.mutateAsync({
      type: 'buy',
      symbol: symbol.toUpperCase(),
      shares: Number(shares),
      price: currentPrice,
      txn_date: today,
    })
    setSymbol('')
    setShares('')
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
        disabled={trade.isPending || !symbol || !shares || currentPrice == null}
        className="w-full rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
      >
        {trade.isPending ? 'Placing order…' : 'Buy'}
      </button>
    </form>
  )
}

interface SellFormProps {
  holding: SimHolding
  onClose: () => void
}

function SellForm({ holding, onClose }: SellFormProps) {
  const trade = useSimTrade()
  const [shares, setShares] = useState(String(holding.shares))
  const today = new Date().toISOString().slice(0, 10)

  const sharesNum = Number(shares)
  const price = holding.currentPrice

  const { data: taxPreview, isLoading: taxLoading } = useTaxPreview(
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

export function TradePanel({ sellTarget, onSellClose }: Props) {
  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle>Trade</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto min-h-0 px-3 pb-3 space-y-4">
        {sellTarget ? (
          <SellForm holding={sellTarget} onClose={onSellClose} />
        ) : (
          <BuyForm />
        )}
      </CardContent>
    </Card>
  )
}
