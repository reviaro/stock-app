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
    <div className="flex items-center gap-1">
      <input
        type="number"
        step="0.01"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Stop"
        className="w-20 rounded border border-border bg-secondary px-2 py-1 text-[11px]"
      />
      <button
        type="button"
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
    </div>
  )
}

export default StopLossEditor
