import type { TaxPreview as TaxPreviewType } from '@/types/simulator'

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

interface Props {
  preview: TaxPreviewType
  isLoading?: boolean
}

export function TaxPreview({ preview, isLoading }: Props) {
  if (isLoading) return <p className="text-xs text-muted-foreground">Calculating…</p>

  const gainColor = preview.gross_gain >= 0 ? 'text-green-400' : 'text-red-400'
  const netColor = preview.after_tax_net_gain >= 0 ? 'text-green-400' : 'text-red-400'

  return (
    <div className="rounded-lg border border-border bg-card/60 p-3 space-y-1 text-xs">
      <p className="font-semibold text-muted-foreground uppercase tracking-wide mb-1">Tax Preview</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        <span className="text-muted-foreground">Proceeds</span>
        <span className="font-mono text-right">${fmt(preview.proceeds)}</span>
        <span className="text-muted-foreground">Cost Basis (FIFO)</span>
        <span className="font-mono text-right">${fmt(preview.cost_basis)}</span>
        <span className="text-muted-foreground">Gross Gain</span>
        <span className={`font-mono text-right ${gainColor}`}>
          {preview.gross_gain >= 0 ? '+' : ''}${fmt(preview.gross_gain)}
        </span>
        {preview.short_term_gain !== 0 && (
          <>
            <span className="text-muted-foreground pl-2">ST Gain / Tax</span>
            <span className="font-mono text-right">
              ${fmt(preview.short_term_gain)} / <span className="text-red-400">${fmt(preview.short_term_tax)}</span>
            </span>
          </>
        )}
        {preview.long_term_gain !== 0 && (
          <>
            <span className="text-muted-foreground pl-2">LT Gain / Tax</span>
            <span className="font-mono text-right">
              ${fmt(preview.long_term_gain)} / <span className="text-amber-400">${fmt(preview.long_term_tax)}</span>
            </span>
          </>
        )}
        <span className="text-muted-foreground font-semibold">Total Tax</span>
        <span className="font-mono text-right text-red-400">${fmt(preview.total_tax)}</span>
        <span className="text-muted-foreground font-semibold">After-Tax Net</span>
        <span className={`font-mono text-right font-semibold ${netColor}`}>
          {preview.after_tax_net_gain >= 0 ? '+' : ''}${fmt(preview.after_tax_net_gain)}
        </span>
        <span className="text-muted-foreground">Breakeven Price</span>
        <span className="font-mono text-right">${fmt(preview.breakeven_price)}</span>
      </div>
      <p className={`mt-1 font-semibold ${preview.worth_selling ? 'text-green-400' : 'text-red-400'}`}>
        {preview.worth_selling ? 'Worth selling at this price' : 'Not profitable after tax'}
      </p>
    </div>
  )
}
