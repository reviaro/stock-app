import { useState, type ReactNode } from 'react'
import { useAddTransaction } from '@/hooks/useTransactions'
import type { TransactionPayload } from '@/types/portfolio'

interface Props {
  defaultType?: TransactionPayload['type']
  onClose: () => void
}
const inputClass = 'mt-1 w-full rounded-md border border-border bg-secondary px-2 py-2 text-sm'
function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return <label className={`block text-sm ${wide ? 'col-span-2' : ''}`}>{label}{children}</label>
}
function today() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function RecordTransactionForm({ defaultType = 'buy', onClose }: Props) {
  const add = useAddTransaction()
  const [form, setForm] = useState<TransactionPayload>({ type: defaultType, symbol: '', fees: 0, txn_date: today(), notes: '' })
  const isTrade = form.type === 'buy' || form.type === 'sell'
  const isDividend = form.type === 'dividend'

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
      await add.mutateAsync({ ...form, symbol: form.symbol || undefined })
      onClose()
    } catch { /* The mutation error is shown below; preserve the entered transaction. */ }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-border bg-card/60 p-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Transaction type" wide>
          <select value={form.type} onChange={(event) => setForm((previous) => ({ ...previous, type: event.target.value as TransactionPayload['type'] }))} className={inputClass}>
            <option value="buy">Buy</option><option value="sell">Sell</option><option value="dividend">Dividend</option><option value="deposit">Deposit</option><option value="withdrawal">Withdrawal</option>
          </select>
        </Field>
        {(isTrade || isDividend) && <Field label="Symbol" wide><input required value={form.symbol ?? ''} onChange={(event) => setForm((previous) => ({ ...previous, symbol: event.target.value.toUpperCase() }))} className={inputClass} /></Field>}
        {isTrade ? <>
          <Field label="Shares"><input required type="number" min="0.00000001" step="any" value={form.shares ?? ''} onChange={(event) => setForm((previous) => ({ ...previous, shares: event.target.value ? Number(event.target.value) : undefined }))} className={inputClass} /></Field>
          <Field label="Price"><input required type="number" min="0.00000001" step="any" value={form.price ?? ''} onChange={(event) => setForm((previous) => ({ ...previous, price: event.target.value ? Number(event.target.value) : undefined }))} className={inputClass} /></Field>
        </> : <Field label="Amount" wide><input required type="number" min="0.00000001" step="any" value={form.amount ?? ''} onChange={(event) => setForm((previous) => ({ ...previous, amount: event.target.value ? Number(event.target.value) : undefined }))} className={inputClass} /></Field>}
        <Field label="Fees"><input type="number" min="0" step="any" value={form.fees ?? 0} onChange={(event) => setForm((previous) => ({ ...previous, fees: Number(event.target.value) }))} className={inputClass} /></Field>
        <Field label="Transaction date"><input required type="date" value={form.txn_date} onChange={(event) => setForm((previous) => ({ ...previous, txn_date: event.target.value }))} className={inputClass} /></Field>
      </div>
      {add.isError && <p role="alert" className="text-sm text-destructive">{add.error instanceof Error ? add.error.message : 'Failed to add transaction. Please try again.'}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={add.isPending} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{add.isPending ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-2 text-sm">Cancel</button>
      </div>
    </form>
  )
}
export default RecordTransactionForm
