import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { useTickerStore } from '@/lib/store'
import { useCANSLIMData } from '@/hooks/useMarketData'
import type { CANSLIMCriterion } from '@/types'

const CANSLIM_LETTERS = ['C', 'A', 'N', 'S', 'L', 'I', 'M'] as const

/** Map each letter to its full criterion name for display */
const LETTER_LABELS: Record<string, string> = {
  C: 'Current Earnings',
  A: 'Annual Earnings',
  N: 'New Factors',
  S: 'Supply & Demand',
  L: 'Leader/Laggard',
  I: 'Institutional',
  M: 'Market Direction',
}

/** Score-to-color mapping per research spec */
function scoreColor(score: number): string {
  if (score >= 70) return 'text-green-400'
  if (score >= 40) return 'text-amber-400'
  return 'text-red-400'
}

/** Progress bar color variant */
function progressColor(score: number): string {
  if (score >= 70) return '[&>div]:bg-green-500'
  if (score >= 40) return '[&>div]:bg-amber-500'
  return '[&>div]:bg-red-500'
}

/** Rating-to-badge-variant mapping */
function ratingVariant(rating: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (rating === 'Excellent') return 'default'
  if (rating === 'Good') return 'secondary'
  if (rating === 'Poor') return 'destructive'
  return 'outline'
}

function CriterionRow({ letter, criterion }: { letter: string; criterion: CANSLIMCriterion }) {
  return (
    <div className="data-hover flex items-center gap-3 rounded-md border border-transparent px-2 py-1.5">
      <span className={`font-bold text-lg w-6 ${scoreColor(criterion.score)}`}>{letter}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-0.5">
          <span className="text-xs text-muted-foreground truncate">{LETTER_LABELS[letter] ?? criterion.name}</span>
          <div className="flex items-center gap-2">
            <span className={`text-sm font-semibold ${scoreColor(criterion.score)}`}>{criterion.score}</span>
            <Badge variant={criterion.status === 'Pass' ? 'default' : 'destructive'} className="text-[10px] px-1.5 py-0">
              {criterion.status}
            </Badge>
          </div>
        </div>
        <Progress value={criterion.score} className={`h-1.5 ${progressColor(criterion.score)}`} />
      </div>
    </div>
  )
}

export function CANSLIMScorecard({ symbol }: { symbol?: string }) {
  const storeTicker = useTickerStore((s) => s.selectedTicker)
  const selectedTicker = symbol || storeTicker
  const { data, isLoading, error } = useCANSLIMData(selectedTicker)

  return (
    <Card className="h-full min-h-[200px]">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            CANSLIM Scorecard
            {selectedTicker && <span className="ml-2 text-primary font-bold">{selectedTicker}</span>}
          </CardTitle>
          {data && (
            <div className="flex items-center gap-2">
              <span className={`text-2xl font-bold ${scoreColor(data.overall.score)}`}>{data.overall.score}</span>
              <Badge variant={ratingVariant(data.overall.rating)}>{data.overall.rating}</Badge>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!selectedTicker && (
          <p className="text-muted-foreground text-sm">Select a stock to view its CANSLIM analysis.</p>
        )}

        {selectedTicker && isLoading && (
          <p className="text-muted-foreground text-sm animate-pulse">Loading CANSLIM analysis...</p>
        )}

        {selectedTicker && error && (
          <p className="text-destructive text-sm">Failed to load analysis: {error instanceof Error ? error.message : 'Unknown error'}</p>
        )}

        {data && (
          <div className="space-y-0.5">
            {CANSLIM_LETTERS.map((letter) => (
              <CriterionRow key={letter} letter={letter} criterion={data.criteria[letter as keyof typeof data.criteria]} />
            ))}
            <div className="flex items-center justify-between pt-2 mt-2 border-t border-border">
              <span className="text-xs text-muted-foreground">
                {data.overall.passCount} Pass / {data.overall.failCount} Fail
              </span>
              <span className="text-[10px] text-muted-foreground">
                {new Date(data.generatedAt).toLocaleString()}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
