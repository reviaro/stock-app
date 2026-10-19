import { useState } from 'react'
import { useDeleteStopLoss, useSetStopLoss } from '@/hooks/useRisk'

interface Props {
  symbol: string
  stopLoss: number | null
}

export function StopLossEditor({ symbol, stopLoss }: Props) {
  const [value, setValue] = useState(stopLoss?.toString() ?? '')
  const setStop = useSetStopLoss()
  const clearStop = useDeleteStopLoss()

  return (
    <div className="flex flex-wrap items-center gap-1">
      <input
        type="number"
        aria-label={`Stop loss for ${symbol}`}
        min="0.01"
        step="0.01"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Stop"
        className="w-20 rounded border border-border bg-secondary px-2 py-1 text-[11px]"
      />
      <button
        type="button"
        disabled={!Number.isFinite(Number(value)) || Number(value) <= 0 || setStop.isPending || clearStop.isPending}
        onClick={() => value && setStop.mutate({ symbol, stop_loss: Number(value) })}
        className="rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
      >
        Set
      </button>
      {stopLoss != null && (
        <button
          type="button"
          onClick={() => clearStop.mutate(symbol)}
          className="rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-destructive"
        >
          Clear
        </button>
      )}
      {(setStop.isError || clearStop.isError) && <p role="alert" className="basis-full text-xs text-destructive">Unable to update the stop loss. Please try again.</p>}
    </div>
  )
}

export default StopLossEditor
