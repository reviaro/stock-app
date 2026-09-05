import { useState } from 'react'
import { useSimAccount, useSimDeposit, useSetTaxBracket, useSimReset } from '@/hooks/useSimulator'

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const TAX_BRACKETS = [10, 12, 22, 24, 32, 35, 37]

interface Props {
  accountId: number
}

export function AccountHeader({ accountId }: Props) {
  const { data: account, isLoading } = useSimAccount(accountId)
  const deposit = useSimDeposit(accountId)
  const setTaxBracket = useSetTaxBracket(accountId)
  const reset = useSimReset(accountId)
  const [depositInput, setDepositInput] = useState('')
  const [showDeposit, setShowDeposit] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  if (isLoading) return <div className="h-14 rounded-lg border border-border bg-card/60 animate-pulse" />

  const totalPnl = (account?.unrealized_pnl ?? 0) + (account?.realized_pnl ?? 0) + (account?.dividend_income ?? 0)

  return (
    <div className="rounded-lg border border-border bg-card/60 px-4 py-3 flex flex-wrap items-center gap-4">
      <div>
        <p className="text-xs text-muted-foreground">Cash</p>
        <p className="font-mono text-sm font-semibold">${fmt(account?.cash ?? 0)}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Total Value</p>
        <p className="font-mono text-sm font-semibold">${fmt(account?.total_value ?? 0)}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Total P&amp;L</p>
        <p className={`font-mono text-sm font-semibold ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {totalPnl >= 0 ? '+' : ''}${fmt(totalPnl)}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Unrealized</p>
        <p className={`font-mono text-sm ${(account?.unrealized_pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {(account?.unrealized_pnl ?? 0) >= 0 ? '+' : ''}${fmt(account?.unrealized_pnl ?? 0)}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Realized</p>
        <p className={`font-mono text-sm ${(account?.realized_pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {(account?.realized_pnl ?? 0) >= 0 ? '+' : ''}${fmt(account?.realized_pnl ?? 0)}
        </p>
      </div>

      <div className="ml-auto flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <p className="text-xs text-muted-foreground">Tax Bracket</p>
          <select
            value={account?.tax_bracket ?? 22}
            onChange={(e) => setTaxBracket.mutate(Number(e.target.value))}
            className="rounded-md border border-border bg-secondary px-2 py-0.5 text-xs"
          >
            {TAX_BRACKETS.map((b) => (
              <option key={b} value={b}>{b}%</option>
            ))}
          </select>
        </div>

        {showDeposit ? (
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="any"
              value={depositInput}
              onChange={(e) => setDepositInput(e.target.value)}
              placeholder="Amount"
              className="w-24 rounded-md border border-border bg-secondary px-2 py-0.5 text-xs"
            />
            <button
              type="button"
              onClick={() => {
                const amount = Number(depositInput)
                if (amount > 0) {
                  deposit.mutate(amount)
                  setDepositInput('')
                  setShowDeposit(false)
                }
              }}
              disabled={deposit.isPending}
              className="data-hover text-xs px-2 py-0.5 rounded-md bg-primary text-primary-foreground"
            >
              {deposit.isPending ? '…' : 'Add'}
            </button>
            <button type="button" onClick={() => setShowDeposit(false)} className="data-hover text-xs px-2 py-0.5 rounded-md border border-border text-muted-foreground">
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowDeposit(true)}
            className="data-hover text-xs px-2 py-0.5 rounded-md border border-border text-muted-foreground hover:text-foreground"
          >
            + Deposit
          </button>
        )}

        {showResetConfirm ? (
          <div className="flex items-center gap-1">
            <span className="text-xs text-destructive">Wipe all trades?</span>
            <button
              type="button"
              onClick={() => { reset.mutate(); setShowResetConfirm(false) }}
              disabled={reset.isPending}
              className="text-xs px-2 py-0.5 rounded-md bg-destructive text-destructive-foreground"
            >
              {reset.isPending ? '…' : 'Yes, reset'}
            </button>
            <button type="button" onClick={() => setShowResetConfirm(false)} className="text-xs px-2 py-0.5 rounded-md border border-border text-muted-foreground">
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            className="data-hover text-xs px-2 py-0.5 rounded-md border border-border text-muted-foreground hover:text-destructive"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  )
}
