import { useEffect, useRef, useState, useCallback } from 'react'
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type LineData,
  type LineWidth,
  type Time,
} from 'lightweight-charts'
import { useTickerStore } from '@/lib/store'
import { useStockHistory, useTechnicalData } from '@/hooks/useMarketData'

// Indicator display configuration
interface IndicatorConfig {
  key: 'sma50' | 'sma200' | 'ema21'
  label: string
  color: string
  lineWidth: LineWidth
}

const INDICATORS: IndicatorConfig[] = [
  { key: 'sma50',  label: 'SMA 50',  color: '#f59e0b', lineWidth: 1 }, // amber-400
  { key: 'sma200', label: 'SMA 200', color: '#3b82f6', lineWidth: 1 }, // blue-500
  { key: 'ema21',  label: 'EMA 21',  color: '#a855f7', lineWidth: 1 }, // purple-500
]

export function StockChart() {
  const selectedTicker = useTickerStore((s) => s.selectedTicker)

  // Data hooks
  const { data: historyData, isLoading: histLoading, error: histError } = useStockHistory(selectedTicker)
  const { data: technicalData } = useTechnicalData(selectedTicker)

  // Chart DOM refs
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const lineSeriesRefs = useRef<Partial<Record<string, ISeriesApi<'Line'>>>>({})

  // Indicator visibility state
  const [visible, setVisible] = useState<Record<string, boolean>>({
    sma50: true,
    sma200: true,
    ema21: true,
  })

  const toggleIndicator = useCallback((key: string) => {
    setVisible((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      const series = lineSeriesRefs.current[key]
      if (series) {
        series.applyOptions({ visible: next[key] })
      }
      return next
    })
  }, [])

  // ---- Chart initialization ----
  useEffect(() => {
    if (!chartContainerRef.current) return

    const container = chartContainerRef.current

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight || 400,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#9ca3af', // gray-400 for dark theme
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(255, 255, 255, 0.2)' },
        horzLine: { color: 'rgba(255, 255, 255, 0.2)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        timeVisible: true,
        secondsVisible: false,
      },
    })

    chartRef.current = chart

    // Candlestick series
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',       // green-500
      downColor: '#ef4444',     // red-500
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    })
    candleSeriesRef.current = candleSeries

    // Add a line series per indicator
    for (const ind of INDICATORS) {
      const lineSeries = chart.addSeries(LineSeries, {
        color: ind.color,
        lineWidth: ind.lineWidth,
        visible: true,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      lineSeriesRefs.current[ind.key] = lineSeries
    }

    // ResizeObserver for fluid container responsiveness
    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries.length || !chartRef.current) return
      const { width, height } = entries[0].contentRect
      chartRef.current.applyOptions({ width, height })
    })

    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      lineSeriesRefs.current = {}
    }
  }, []) // Chart created once — data updated in separate effects

  // ---- Candlestick data update ----
  useEffect(() => {
    const series = candleSeriesRef.current
    if (!series || !historyData?.data?.length) return

    const candles: CandlestickData<Time>[] = historyData.data.map((pt) => ({
      // Normalise ISO datetime to YYYY-MM-DD for lightweight-charts Time
      time: pt.date.slice(0, 10) as Time,
      open:  pt.open,
      high:  pt.high,
      low:   pt.low,
      close: pt.close,
    }))

    // Deduplicate dates (keep last) and sort ascending — required by lightweight-charts
    const byDate = new Map<string, CandlestickData<Time>>()
    for (const c of candles) {
      byDate.set(c.time as string, c)
    }
    const sorted = Array.from(byDate.values()).sort((a, b) =>
      (a.time as string).localeCompare(b.time as string),
    )

    series.setData(sorted)
    chartRef.current?.timeScale().fitContent()
  }, [historyData])

  // ---- Technical indicator data update ----
  useEffect(() => {
    if (!technicalData?.charts || !historyData?.data?.length) return

    const charts = technicalData.charts
    const dates = historyData.data.map((pt) => pt.date.slice(0, 10))
    // Use the last N dates aligned with the chart series (backend returns last 60)
    const chartDates = dates.slice(-60)

    const toLineData = (
      values: (number | null)[],
      alignDates: string[],
    ): LineData<Time>[] => {
      const result: LineData<Time>[] = []
      const len = Math.min(values.length, alignDates.length)
      for (let i = 0; i < len; i++) {
        const val = values[i]
        if (val !== null && val !== undefined && isFinite(val)) {
          result.push({ time: alignDates[i] as Time, value: val })
        }
      }
      return result
    }

    for (const ind of INDICATORS) {
      const series = lineSeriesRefs.current[ind.key]
      if (!series) continue

      const raw = charts[ind.key] as (number | null)[] | undefined
      if (!raw?.length) continue

      const lineData = toLineData(raw, chartDates)
      if (lineData.length > 0) {
        series.setData(lineData)
      }
    }
  }, [technicalData, historyData])

  // ---- Render ----
  return (
    <div className="relative w-full h-full min-h-[400px] flex flex-col">
      {/* Indicator toggle controls */}
      <div className="absolute top-2 right-2 z-10 flex gap-1">
        {INDICATORS.map((ind) => (
          <button
            key={ind.key}
            onClick={() => toggleIndicator(ind.key)}
            className={`px-2 py-0.5 rounded text-xs font-medium border transition-opacity ${
              visible[ind.key]
                ? 'opacity-100'
                : 'opacity-40'
            }`}
            style={{
              borderColor: ind.color,
              color: ind.color,
              backgroundColor: visible[ind.key]
                ? `${ind.color}22`
                : 'transparent',
            }}
            title={`Toggle ${ind.label}`}
          >
            {ind.label}
          </button>
        ))}
      </div>

      {/* Ticker label */}
      <div className="absolute top-2 left-2 z-10 text-sm font-semibold text-muted-foreground">
        {selectedTicker}
        {histLoading && (
          <span className="ml-2 text-xs text-muted-foreground/60">Loading...</span>
        )}
        {histError && (
          <span className="ml-2 text-xs text-red-400">Error loading data</span>
        )}
      </div>

      {/* Chart container */}
      <div
        ref={chartContainerRef}
        className="w-full h-full"
        style={{ minHeight: '400px' }}
      />
    </div>
  )
}

export default StockChart
