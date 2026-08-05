import { useSimTransactions } from '@/hooks/useSimulator'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

function fmt(n: number | null, d = 2) {
  if (n == null) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

interface Props {
  accountId: number
}

export function TransactionHistory({ accountId }: Props) {
  const { data: txns, isLoading } = useSimTransactions(accountId)

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle>Trade History</CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 overflow-x-auto">
        {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {!isLoading && (!txns || txns.length === 0) && (
          <p className="text-xs text-muted-foreground">No trades yet.</p>
        )}
        {txns && txns.length > 0 && (
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left py-1 pr-3">Date</th>
                <th className="text-left py-1 pr-3">Type</th>
                <th className="text-left py-1 pr-3">Symbol</th>
                <th className="text-right py-1 pr-3">Shares</th>
                <th className="text-right py-1 pr-3">Price</th>
                <th className="text-right py-1">Amount</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((t) => (
                <tr key={t.id} className="data-hover border-b border-border/50">
                  <td className="py-1 pr-3 text-muted-foreground">{t.txn_date}</td>
                  <td className="py-1 pr-3">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                      t.type === 'buy' ? 'bg-green-900/40 text-green-400' :
                      t.type === 'sell' ? 'bg-red-900/40 text-red-400' :
                      'bg-secondary text-muted-foreground'
                    }`}>
                      {t.type}
                    </span>
                  </td>
                  <td className="py-1 pr-3 font-semibold">{t.symbol ?? '—'}</td>
                  <td className="font-mono text-right py-1 pr-3">{fmt(t.shares)}</td>
                  <td className="font-mono text-right py-1 pr-3">{t.price != null ? `$${fmt(t.price)}` : '—'}</td>
                  <td className="font-mono text-right py-1">${fmt(t.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}
