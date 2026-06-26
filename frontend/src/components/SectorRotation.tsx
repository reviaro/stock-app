import { useState } from 'react'
import { motion } from 'framer-motion'
import { useSectorPerformance } from '@/hooks/useSector'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { SectorPerformance } from '@/hooks/useSector'

type Period = '1M' | '3M' | '6M'

function pctColor(n: number) {
  if (n >= 5) return 'text-green-400'
  if (n >= 0) return 'text-green-300'
  if (n >= -5) return 'text-red-300'
  return 'text-red-400'
}

function getChangeKey(period: Period): keyof SectorPerformance {
  if (period === '1M') return 'change1M'
  if (period === '3M') return 'change3M'
  return 'change6M'
}

export function SectorRotation() {
  const { data, isLoading, isError } = useSectorPerformance()
  const [period, setPeriod] = useState<Period>('1M')

  const sorted = data
    ? [...data].sort((a, b) => {
        const key = getChangeKey(period)
        return (b[key] as number) - (a[key] as number)
      })
    : []

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Sector Rotation</CardTitle>
          <div className="flex gap-1">
            {(['1M', '3M', '6M'] as Period[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={[
                  'data-hover text-xs px-2 py-0.5 rounded-md border',
                  period === p
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-transparent text-muted-foreground border-border hover:border-primary hover:text-foreground',
                ].join(' ')}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-3 flex-1 overflow-y-auto min-h-0 pb-4 space-y-0.5">
        {isLoading && <p className="text-muted-foreground text-sm">Loading sectors...</p>}
        {isError && <p className="text-destructive text-sm">Failed to load sector data.</p>}
        {sorted.map((s, i) => {
          const key = getChangeKey(period)
          const val = s[key] as number
          const barWidth = Math.min(100, Math.abs(val) * 4)
          const rank = i + 1

          return (
            <motion.div
              key={s.ticker}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0, transition: { delay: i * 0.03, duration: 0.2 } }}
              className="data-hover flex items-center gap-2 rounded-lg border border-transparent px-2 py-1.5"
            >
              <span className="text-[10px] text-muted-foreground w-4 text-right shrink-0">{rank}</span>
              <div className="w-28 shrink-0">
                <p className="text-xs font-medium text-foreground leading-tight truncate">{s.name}</p>
                <p className="text-[10px] text-muted-foreground">{s.ticker}</p>
              </div>
              <div className="flex-1 relative h-3.5 rounded-full bg-muted/30 overflow-hidden">
                <div
                  className={`absolute top-0 h-full rounded-full ${val >= 0 ? 'left-0 bg-green-500/40' : 'right-0 bg-red-500/40'}`}
                  style={{ width: `${barWidth}%` }}
                />
              </div>
              <Badge
                variant="outline"
                className={`text-[11px] font-mono w-16 justify-end border-transparent shrink-0 ${pctColor(val)}`}
              >
                {val >= 0 ? '+' : ''}{val.toFixed(2)}%
              </Badge>
            </motion.div>
          )
        })}
      </CardContent>
    </Card>
  )
}

export default SectorRotation
