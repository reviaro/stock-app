import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useRecordSimDividend, useSetSimReinvestmentSettings, useSimAccount } from '@/hooks/useSimulator'
import type { SimReinvestmentSettings } from '@/types/simulator'

interface Props {
  accountId: number
}

function fmt(value: number | null | undefined) {
  return (value ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function ReinvestmentPanel({ accountId }: Props) {
  const { data: account, isLoading } = useSimAccount(accountId)
  const updateSettings = useSetSimReinvestmentSettings(accountId)
  const recordDividend = useRecordSimDividend(accountId)
  const [dividendMode, setDividendMode] = useState<SimReinvestmentSettings['dividend_reinvestment_mode'] | null>(null)
  const [profitMode, setProfitMode] = useState<SimReinvestmentSettings['profit_reinvestment_mode'] | null>(null)
  const [targetCashPct, setTargetCashPct] = useState<number | null>(null)
  const [showDividendForm, setShowDividendForm] = useState(false)
  const [symbol, setSymbol] = useState('')
  const [amount, setAmount] = useState('')
  const [price, setPrice] = useState('')
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10))

  if (isLoading) return <div className="h-44 rounded-lg border border-border bg-card/60 animate-pulse" />

  const settings: SimReinvestmentSettings = {
    dividend_reinvestment_mode: dividendMode ?? account?.dividend_reinvestment_mode ?? 'cash',
    profit_reinvestment_mode: profitMode ?? account?.profit_reinvestment_mode ?? 'hold_cash',
    target_cash_pct: targetCashPct ?? account?.target_cash_pct ?? 10,
  }

  async function submitDividend(event: React.FormEvent) {
    event.preventDefault()
    const upperSymbol = symbol.trim().toUpperCase()
    const numericAmount = Number(amount)
    const numericPrice = Number(price)
    if (!upperSymbol || !(numericAmount > 0) || !paymentDate || !(numericPrice > 0)) return
    try {
      await recordDividend.mutateAsync({
        symbol: upperSymbol,
        amount: numericAmount,
        price: numericPrice,
        txn_date: paymentDate,
        idempotency_key: `manual:${upperSymbol}:${paymentDate}:${numericAmount.toFixed(2)}`,
      })
    } catch {
      return
    }
    setSymbol('')
    setAmount('')
    setPrice('')
    setShowDividendForm(false)
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Compounding</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              DRIP acts when a dividend is recorded. Excess cash is flagged for the next review; it never places a blind automatic trade.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowDividendForm((open) => !open)}
            className="relative z-10 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary"
          >
            {showDividendForm ? 'Cancel dividend' : 'Record dividend'}
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-md border border-border bg-secondary/30 p-3">
            <p className="text-xs text-muted-foreground">Dividend income</p>
            <p className="font-mono text-sm font-semibold">${fmt(account?.dividend_income)}</p>
          </div>
          <div className="rounded-md border border-border bg-secondary/30 p-3">
            <p className="text-xs text-muted-foreground">Reinvested dividends</p>
            <p className="font-mono text-sm font-semibold">${fmt(account?.reinvested_dividends)}</p>
          </div>
          <div className="rounded-md border border-border bg-secondary/30 p-3">
            <p className="text-xs text-muted-foreground">Cash to redeploy</p>
            <p className="font-mono text-sm font-semibold">
              {account?.redeployable_cash == null ? 'Unavailable' : `$${fmt(account.redeployable_cash)}`}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-[1fr_1fr_140px_auto]">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Dividend treatment</span>
            <select
              aria-label="Dividend treatment"
              value={settings.dividend_reinvestment_mode}
              onChange={(event) => setDividendMode(event.target.value as 'cash' | 'drip')}
              className="w-full rounded-md border border-border bg-secondary px-2 py-1.5"
            >
              <option value="drip">Automatic DRIP</option>
              <option value="cash">Keep as cash</option>
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Realized-profit treatment</span>
            <select
              aria-label="Realized-profit treatment"
              value={settings.profit_reinvestment_mode}
              onChange={(event) => setProfitMode(event.target.value as 'hold_cash' | 'redeploy_excess')}
              className="w-full rounded-md border border-border bg-secondary px-2 py-1.5"
            >
              <option value="redeploy_excess">Redeploy above cash target</option>
              <option value="hold_cash">Hold as cash</option>
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Target cash %</span>
            <input
              aria-label="Target cash percent"
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={settings.target_cash_pct}
              onChange={(event) => setTargetCashPct(Number(event.target.value))}
              className="w-full rounded-md border border-border bg-secondary px-2 py-1.5"
            />
          </label>
          <button
            type="button"
            onClick={() => { void Promise.resolve(updateSettings.mutateAsync(settings)).catch(() => undefined) }}
            disabled={updateSettings.isPending || settings.target_cash_pct < 0 || settings.target_cash_pct > 100}
            className="relative z-10 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {updateSettings.isPending ? 'Saving…' : 'Save compounding settings'}
          </button>
        </div>
        {updateSettings.isError && <p className="text-xs text-red-400">Could not save compounding settings.</p>}

        {showDividendForm && (
          <form onSubmit={submitDividend} className="grid grid-cols-1 items-end gap-3 rounded-md border border-border p-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto]">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Symbol</span>
              <input
                aria-label="Dividend symbol"
                value={symbol}
                onChange={(event) => setSymbol(event.target.value.toUpperCase())}
                className="w-full rounded-md border border-border bg-secondary px-2 py-1.5"
                placeholder="PEP"
                required
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Total amount</span>
              <input
                aria-label="Total dividend amount"
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="w-full rounded-md border border-border bg-secondary px-2 py-1.5"
                placeholder="25.50"
                required
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Payment date</span>
              <input
                aria-label="Dividend payment date"
                type="date"
                value={paymentDate}
                onChange={(event) => setPaymentDate(event.target.value)}
                className="w-full rounded-md border border-border bg-secondary px-2 py-1.5"
                required
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">DRIP execution price</span>
              <input
                aria-label="DRIP execution price"
                type="number"
                min="0.01"
                step="0.01"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                className="w-full rounded-md border border-border bg-secondary px-2 py-1.5"
                placeholder="200.00"
                required
              />
            </label>
            <button
              type="submit"
              disabled={recordDividend.isPending}
              className="relative z-10 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {recordDividend.isPending ? 'Applying…' : 'Apply dividend'}
            </button>
            {recordDividend.isError && <p className="text-xs text-red-400 md:col-span-4">Dividend was not recorded. Check the position, amount, and whether this payment was already entered.</p>}
          </form>
        )}
      </CardContent>
    </Card>
  )
}
