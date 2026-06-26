import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { createChart, LineSeries, ColorType, type IChartApi, type ISeriesApi, type LineData, type Time } from 'lightweight-charts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useSnapshotHistory, useManualSnapshot } from '@/hooks/useHistory'
import type { SnapshotEntry, SnapshotGroup } from '@/types/history'

function formatSlot(slot: string) {
  if (slot === 'openish') return 'Morning'
  if (slot === 'midday') return 'Midday'
  if (slot === 'closeish') return 'Close'
  if (slot === 'manual-open') return 'Manual'
  return slot
}

function formatCapturedAt(value: string) {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatMoney(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : '--'
}

function formatPercent(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : '--'
}

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[10px] leading-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  )
}

const HISTORY_RANGE_OPTIONS = [
  { value: 7, label: 'Last week' },
  { value: 15, label: 'Last 15 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 3 months' },
] as const

function MiniChart({ history }: { history: SnapshotEntry[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null)

  const data = useMemo<LineData<Time>[]>(() => {
    const sorted = history
      .slice()
      .sort((a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime())

    // Deduplicate by calendar date — keep last price per date
    // (lightweight-charts requires unique time values)
    const deduped = new Map<string, number>()
    for (const entry of sorted) {
      deduped.set(entry.captured_at.slice(0, 10), entry.price)
    }
    return Array.from(deduped.entries()).map(([time, value]) => ({
      time: time as Time,
      value,
    }))
  }, [history])

  useEffect(() => {
    if (!containerRef.current) return

    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
      seriesRef.current = null
    }

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 72,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.08)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.08)' },
      },
      leftPriceScale: { visible: false },
      rightPriceScale: { visible: false },
      timeScale: { visible: false, borderVisible: false },
      crosshair: {
        vertLine: { visible: false },
        horzLine: { visible: false },
      },
      handleScroll: false,
      handleScale: false,
    })

    const series = chart.addSeries(LineSeries, {
      color: data.length >= 2 && data[data.length - 1].value >= data[0].value ? '#22c55e' : '#ef4444',
      lineWidth: 2,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    series.setData(data)
    chart.timeScale().fitContent()

    chartRef.current = chart
    seriesRef.current = series

    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return
      chartRef.current.applyOptions({ width: containerRef.current.clientWidth, height: 72 })
      chartRef.current.timeScale().fitContent()
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [data])

  return <div ref={containerRef} className="w-full h-[72px]" />
}

function SymbolHistoryCard({ group, dateFilter, slotFilter }: { group: SnapshotGroup; dateFilter: string; slotFilter: 'all' | 'openish' | 'midday' | 'closeish' | 'manual-open' }) {
  const filteredHistory = useMemo(() => {
    return group.history.filter((entry) => {
      if (dateFilter && entry.market_date !== dateFilter) return false
      if (slotFilter !== 'all' && entry.slot !== slotFilter) return false
      return true
    })
  }, [group.history, dateFilter, slotFilter])

  const sorted = useMemo(() => {
    return filteredHistory.slice().sort((a, b) => new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime())
  }, [filteredHistory])

  const latest = sorted[0]
  const latestScheduled = sorted.find((entry) => entry.slot !== 'manual-open')
  const dailyTable = useMemo(() => {
    const map = new Map<string, Record<string, SnapshotEntry | undefined>>()
    for (const row of filteredHistory) {
      if (!map.has(row.market_date)) {
        map.set(row.market_date, {})
      }
      map.get(row.market_date)![row.slot] = row
    }
    return Array.from(map.entries())
      .map(([date, slots]) => ({ date, slots }))
      .sort((a, b) => b.date.localeCompare(a.date))
  }, [filteredHistory])

  if (filteredHistory.length === 0) return null

  return (
    <div className="data-hover rounded-xl border border-border bg-card/50 p-4 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-foreground">{group.symbol}</h3>
            <Badge variant="secondary">{filteredHistory.length} entries</Badge>
            {latestScheduled && (
              <Badge variant="outline" className="text-[11px]">
                Last scheduled {formatCapturedAt(latestScheduled.captured_at)}
              </Badge>
            )}
          </div>
          {latest && (
            <p className="text-xs text-muted-foreground mt-1">
              Latest {formatSlot(latest.slot)} update at {formatCapturedAt(latest.captured_at)}
            </p>
          )}
        </div>
        {latest && (
          <div className="text-left sm:text-right">
            <p className="text-lg font-semibold text-foreground">${latest.price.toFixed(2)}</p>
            <p className="text-xs text-muted-foreground">
              {latest.is_carry_forward ? 'carry-forward' : latest.is_market_closed ? 'market closed' : 'live'}
            </p>
          </div>
        )}
      </div>

      <MiniChart history={filteredHistory} />

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-card">
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Date</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Morning</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Midday</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Close</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Manual</th>
            </tr>
          </thead>
          <tbody>
            {dailyTable.map(({ date, slots }) => {
              const orderedSlots = ['openish', 'midday', 'closeish', 'manual-open'] as const
              return (
                <tr key={date} className="data-hover border-b border-border/60 last:border-0">
                  <td className="px-3 py-2 text-xs text-foreground font-medium whitespace-nowrap">{date}</td>
                  {orderedSlots.map((slotKey) => {
                    const row = slots[slotKey]
                    const mutedManual = slotKey === 'manual-open'
                    return (
                      <td key={slotKey} className="px-3 py-2 text-xs whitespace-nowrap align-top">
                        {row ? (
                          <div className={`space-y-0.5 ${mutedManual ? 'opacity-70' : ''}`}>
                            <div className="font-mono text-foreground">{formatMoney(row.price)}</div>
                            <div className="text-[10px] text-muted-foreground">{formatCapturedAt(row.captured_at)}</div>
                            <div className="mt-1 min-w-[120px] space-y-0.5">
                              <MetricLine label="Open" value={formatMoney(row.open_price)} />
                              <MetricLine label="High" value={formatMoney(row.day_high)} />
                              <MetricLine label="% Open" value={formatPercent(row.change_from_open_percent)} />
                              <MetricLine label="Gap Apr22" value={formatPercent(row.gap_apr22_percent)} />
                              <MetricLine label="52W H" value={formatMoney(row.fifty_two_week_high)} />
                              <MetricLine label="52W L" value={formatMoney(row.fifty_two_week_low)} />
                              <MetricLine label="vs 52W H" value={formatPercent(row.dist_from_52wh_percent)} />
                              <MetricLine label="vs 52W L" value={formatPercent(row.dist_from_52wl_percent)} />
                            </div>
                          </div>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function HistoryPanel() {
  const snapshotMutation = useManualSnapshot()
  const [rangeDays, setRangeDays] = useState<(typeof HISTORY_RANGE_OPTIONS)[number]['value']>(30)
  const { data, isLoading, isError, error } = useSnapshotHistory(rangeDays)
  const [dateFilter, setDateFilter] = useState('')
  const [slotFilter, setSlotFilter] = useState<'all' | 'openish' | 'midday' | 'closeish' | 'manual-open'>('all')

  const availableDates = useMemo(() => {
    const dates = new Set<string>()
    for (const group of data ?? []) {
      for (const row of group.history) {
        dates.add(row.market_date)
      }
    }
    return Array.from(dates).sort((a, b) => b.localeCompare(a))
  }, [data])

  const groups = useMemo(() => {
    return (data ?? [])
      .filter((group) => group.history.length > 0)
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
  }, [data])

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <CardTitle>Daily Price History</CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={rangeDays}
              onChange={(e) => {
                setRangeDays(Number(e.target.value) as (typeof HISTORY_RANGE_OPTIONS)[number]['value'])
                setDateFilter('')
              }}
              className="data-hover text-xs px-2 py-1 rounded-md border bg-transparent text-muted-foreground border-border focus:border-primary focus:outline-none"
            >
              {HISTORY_RANGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="data-hover text-xs px-2 py-1 rounded-md border bg-transparent text-muted-foreground border-border focus:border-primary focus:outline-none"
            >
              <option value="">All dates</option>
              {availableDates.map((date) => (
                <option key={date} value={date}>{date}</option>
              ))}
            </select>
            <select
              value={slotFilter}
              onChange={(e) => setSlotFilter(e.target.value as 'all' | 'openish' | 'midday' | 'closeish' | 'manual-open')}
              className="data-hover text-xs px-2 py-1 rounded-md border bg-transparent text-muted-foreground border-border focus:border-primary focus:outline-none"
            >
              <option value="all">All slots</option>
              <option value="openish">Morning</option>
              <option value="midday">Midday</option>
              <option value="closeish">Close</option>
              <option value="manual-open">Manual</option>
            </select>
            <button
              type="button"
              onClick={() => snapshotMutation.mutate()}
              disabled={snapshotMutation.isPending}
              className="data-hover text-xs px-2 py-0.5 rounded-md border bg-transparent text-muted-foreground border-border hover:text-foreground disabled:opacity-50"
            >
              {snapshotMutation.isPending ? 'Saving…' : 'Save snapshot'}
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-3 flex-1 overflow-y-auto min-h-0 pb-4 space-y-3">
        {isLoading && <p className="text-muted-foreground text-sm">Loading daily price history...</p>}
        {isError && (
          <p className="text-destructive text-sm">
            Failed to load daily price history. {error instanceof Error ? error.message : ''}
          </p>
        )}
        {!isLoading && !isError && groups.length === 0 && (
          <p className="text-muted-foreground text-sm">No saved price history yet. Save one or wait for scheduled captures.</p>
        )}
        {groups.map((group, index) => {
          const filtered = group.history.filter((entry) => {
            if (dateFilter && entry.market_date !== dateFilter) return false
            if (slotFilter !== 'all' && entry.slot !== slotFilter) return false
            return true
          })
          if (filtered.length === 0) return null
          return (
            <motion.div
              key={group.symbol}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0, transition: { delay: index * 0.02, duration: 0.18 } }}
            >
              <SymbolHistoryCard group={group} dateFilter={dateFilter} slotFilter={slotFilter} />
            </motion.div>
          )
        })}
      </CardContent>
    </Card>
  )
}

export default HistoryPanel
