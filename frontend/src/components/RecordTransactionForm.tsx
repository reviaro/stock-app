import { useState } from 'react'
import { useAddTransaction } from '@/hooks/useTransactions'
import type { TransactionPayload } from '@/types/portfolio'

interface Props {
  defaultType?: TransactionPayload['type']
  onClose: () => void
}

export function RecordTransactionForm({ defaultType = 'buy', onClose }: Props) {
  const add = useAddTransaction()
  const [form, setForm] = useState<TransactionPayload>({
    type: defaultType,
    symbol: '',
    shares: undefined,
    price: undefined,
    amount: undefined,
    fees: 0,
    txn_date: new Date().toISOString().slice(0, 10),
    notes: '',
  })

  const isTrade = form.type === 'buy' || form.type === 'sell'
  const isDividend = form.type === 'dividend'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await add.mutateAsync({
      ...form,
      symbol: form.symbol || undefined,
      shares: form.shares ? Number(form.shares) : undefined,
      price: form.price ? Number(form.price) : undefined,
      amount: form.amount != null ? Number(form.amount) : undefined,
      fees: form.fees != null ? Number(form.fees) : 0,
    })
    onClose()
  }

  return (
    <form onSubmit={handleSubmit} className="data-hover space-y-2 rounded-lg border border-border bg-card/60 p-3">
      <div className="grid grid-cols-2 gap-2">
        <select value={form.type} onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value as TransactionPayload['type'] }))} className="col-span-2 rounded-md border border-border bg-secondary px-2 py-1.5 text-xs">
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
          <option value="dividend">Dividend</option>
          <option value="deposit">Deposit</option>
          <option value="withdrawal">Withdrawal</option>
        </select>
        {(isTrade || isDividend) && (
          <input value={form.symbol ?? ''} onChange={(e) => setForm((prev) => ({ ...prev, symbol: e.target.value.toUpperCase() }))} placeholder="Symbol" className="col-span-2 rounded-md border border-border bg-secondary px-2 py-1.5 text-xs" />
        )}
        {isTrade && (
          <>
            <input type="number" step="any" value={form.shares ?? ''} onChange={(e) => setForm((prev) => ({ ...prev, shares: Number(e.target.value) }))} placeholder="Shares" className="rounded-md border border-border bg-secondary px-2 py-1.5 text-xs" />
            <input type="number" step="any" value={form.price ?? ''} onChange={(e) => setForm((prev) => ({ ...prev, price: Number(e.target.value) }))} placeholder="Price" className="rounded-md border border-border bg-secondary px-2 py-1.5 text-xs" />
          </>
        )}
        {!isTrade && (
          <input type="number" step="any" value={form.amount ?? ''} onChange={(e) => setForm((prev) => ({ ...prev, amount: Number(e.target.value) }))} placeholder="Amount" className="col-span-2 rounded-md border border-border bg-secondary px-2 py-1.5 text-xs" />
        )}
        <input type="number" step="any" value={form.fees ?? 0} onChange={(e) => setForm((prev) => ({ ...prev, fees: Number(e.target.value) }))} placeholder="Fees" className="rounded-md border border-border bg-secondary px-2 py-1.5 text-xs" />
        <input type="date" value={form.txn_date} onChange={(e) => setForm((prev) => ({ ...prev, txn_date: e.target.value }))} className="rounded-md border border-border bg-secondary px-2 py-1.5 text-xs" />
      </div>
      {add.isError && <p className="text-xs text-destructive">{add.error instanceof Error ? add.error.message : 'Failed to add transaction'}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={add.isPending} className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50">{add.isPending ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1 text-xs">Cancel</button>
      </div>
    </form>
  )
}

export default RecordTransactionForm
