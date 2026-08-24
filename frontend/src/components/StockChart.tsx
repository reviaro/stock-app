import { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  ColorType,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type LineData,
  type LineWidth,
  type Time,
} from 'lightweight-charts'
import { useTickerStore } from '@/lib/store'
import { useStockHistory, useTechnicalData } from '@/hooks/useMarketData'

/**
 * Normalizes OHLCV or line data to percentage change from the first data point.
 * Formula: normalized_value = (current_price - start_price) / start_price * 100
 * The start_price is the first price in the provided data range.
 */
function normalizeToPercent(data: LineData<Time>[]): LineData<Time>[] {
  if (!data.length) return []
  const startPrice = data[0].value
  if (startPrice === 0) return data
  return data.map((d) => ({
    time: d.time,
    value: ((d.value - startPrice) / startPrice) * 100,
  }))
}

// Indicator display configuration
interface IndicatorConfig {
  key: 'sma50' | 'sma200' | 'ema21'
  label: string
  color: string
  lineWidth: LineWidth
}

const INDICATORS: IndicatorConfig[] = [
  { key: 'sma50', label: 'SMA 50', color: '#f59e0b', lineWidth: 1 }, // amber-400
  { key: 'sma200', label: 'SMA 200', color: '#3b82f6', lineWidth: 1 }, // blue-500
  { key: 'ema21', label: 'EMA 21', color: '#a855f7', lineWidth: 1 }, // purple-500
]

// S&P 500 symbol used for comparison overlay
const SP500_SYMBOL = '^GSPC'

/** Skeleton loader shown while chart data is fetching */
function ChartSkeleton() {
  return (
    <div className="w-full h-full flex flex-col gap-3 p-4 animate-pulse">
      {/* Simulated price scale lines */}
      <div className="flex items-end gap-1 flex-1">
        {Array.from({ length: 40 }).map((_, i) => (
          <div
            key={i}
            className="flex-1 bg-muted/40 rounded-sm"
            style={{
              height: `${30 + Math.sin(i * 0.4) * 24 + ((i * 17) % 19)}%`,
              minHeight: '4px',
            }}
          />
        ))}
      </div>
      {/* Simulated time axis */}
      <div className="h-3 bg-muted/30 rounded w-full" />
    </div>
  )
}

export function StockChart({ symbol, compact = false }: { symbol?: string; compact?: boolean }) {
  const storeTicker = useTickerStore((s) => s.selectedTicker)
  const selectedTicker = symbol || storeTicker

  // Comparison mode state
  const [isComparisonMode, setIsComparisonMode] = useState(false)

  // Data hooks — target stock
  const { data: historyData, isLoading: histLoading, error: histError } = useStockHistory(selectedTicker)
  const { data: technicalData } = useTechnicalData(selectedTicker)

  // Data hook — S&P 500 (only fetches when comparison mode is active)
  const { data: sp500Data } = useStockHistory(isComparisonMode ? SP500_SYMBOL : '')

  // Chart DOM refs
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  // Stock line series — used in comparison mode instead of candlestick
  const stockLineSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  // S&P 500 overlay line series
  const sp500SeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
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
  // Created once — separate effects handle data updates.
  // ResizeObserver keeps dimensions in sync with the container.
  // Cleanup: resizeObserver.disconnect() + chart.remove() + null all refs.
  // This ensures no duplicate charts appear on re-renders or StrictMode double-mount.
  useEffect(() => {
    if (!chartContainerRef.current) return

    const container = chartContainerRef.current

    // Guard: if a chart already exists (e.g. StrictMode double-invoke), remove it first.
    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      stockLineSeriesRef.current = null
      sp500SeriesRef.current = null
      lineSeriesRefs.current = {}
    }

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

    // Candlestick series (normal mode)
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',       // green-500
      downColor: '#ef4444',     // red-500
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      visible: true,
    })
    candleSeriesRef.current = candleSeries

    // Stock line series (comparison mode — shows normalized % from start)
    const stockLineSeries = chart.addSeries(LineSeries, {
      color: '#22c55e',     // green-500, matches candlestick up color
      lineWidth: 2 as LineWidth,
      visible: false,       // hidden by default — shown in comparison mode
      priceLineVisible: false,
      lastValueVisible: true,
    })
    stockLineSeriesRef.current = stockLineSeries

    // S&P 500 overlay line series (comparison mode — dashed grey)
    const sp500Series = chart.addSeries(LineSeries, {
      color: '#6b7280',     // gray-500 — subtle reference line
      lineWidth: 1 as LineWidth,
      lineStyle: 2,         // dashed
      visible: false,       // hidden by default — shown in comparison mode
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'S&P 500',
    })
    sp500SeriesRef.current = sp500Series

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
      // Always remove the chart and null refs to prevent memory leaks and
      // duplicate chart creation during rapid ticker switching or HMR reloads.
      if (chartRef.current) {
        chartRef.current.remove()
        chartRef.current = null
      }
      candleSeriesRef.current = null
      stockLineSeriesRef.current = null
      sp500SeriesRef.current = null
      lineSeriesRefs.current = {}
    }
  }, []) // Chart created once — data updated in separate effects

  // ---- Candlestick data update (normal mode) ----
  useEffect(() => {
    const series = candleSeriesRef.current
    if (!series || !historyData?.data?.length) return

    const candles: CandlestickData<Time>[] = historyData.data.map((pt) => ({
      // Normalise ISO datetime to YYYY-MM-DD for lightweight-charts Time
      time: pt.date.slice(0, 10) as Time,
      open: pt.open,
      high: pt.high,
      low: pt.low,
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

  // ---- Comparison mode effect ----
  // Switches between candlestick (normal) and normalized line (comparison) views.
  // When isComparisonMode changes, or when data arrives in comparison mode, this
  // effect updates visibility, price scale mode, and series data.
  useEffect(() => {
    const chart = chartRef.current
    const candleSeries = candleSeriesRef.current
    const stockLineSeries = stockLineSeriesRef.current
    const sp500Series = sp500SeriesRef.current

    if (!chart || !candleSeries || !stockLineSeries || !sp500Series) return

    if (isComparisonMode) {
      // Switch price scale to Percentage mode — both series start at 0%
      chart.priceScale('right').applyOptions({ mode: PriceScaleMode.Percentage })

      // Hide candlestick series; show stock line series
      candleSeries.applyOptions({ visible: false })
      stockLineSeries.applyOptions({ visible: true })

      // Hide indicator overlays (they have absolute prices, not % — would distort)
      for (const ind of INDICATORS) {
        lineSeriesRefs.current[ind.key]?.applyOptions({ visible: false })
      }

      // Populate stock line series from historyData (use close prices)
      if (historyData?.data?.length) {
        const byDate = new Map<string, LineData<Time>>()
        for (const pt of historyData.data) {
          const d: LineData<Time> = { time: pt.date.slice(0, 10) as Time, value: pt.close }
          byDate.set(pt.date.slice(0, 10), d)
        }
        const sorted = Array.from(byDate.values()).sort((a, b) =>
          (a.time as string).localeCompare(b.time as string),
        )
        const normalized = normalizeToPercent(sorted)
        if (normalized.length > 0) {
          stockLineSeries.setData(normalized)
        }
      }

      // Populate S&P 500 series if data is available
      if (sp500Data?.data?.length) {
        const byDate = new Map<string, LineData<Time>>()
        for (const pt of sp500Data.data) {
          const d: LineData<Time> = { time: pt.date.slice(0, 10) as Time, value: pt.close }
          byDate.set(pt.date.slice(0, 10), d)
        }
        const sorted = Array.from(byDate.values()).sort((a, b) =>
          (a.time as string).localeCompare(b.time as string),
        )
        const normalized = normalizeToPercent(sorted)
        if (normalized.length > 0) {
          sp500Series.setData(normalized)
          sp500Series.applyOptions({ visible: true })
        }
      } else {
        // SP500 data not yet loaded — hide until it arrives
        sp500Series.applyOptions({ visible: false })
      }

      chart.timeScale().fitContent()
    } else {
      // Switch price scale back to Normal mode
      chart.priceScale('right').applyOptions({ mode: PriceScaleMode.Normal })

      // Show candlestick series; hide comparison line series
      candleSeries.applyOptions({ visible: true })
      stockLineSeries.applyOptions({ visible: false })
      sp500Series.applyOptions({ visible: false })

      // Restore indicator overlay visibility from state
      for (const ind of INDICATORS) {
        lineSeriesRefs.current[ind.key]?.applyOptions({ visible: visible[ind.key] })
      }

      chart.timeScale().fitContent()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isComparisonMode, historyData, sp500Data])

  // ---- Render ----
  return (
    <div className={`relative w-full h-full flex flex-col ${compact ? 'min-h-[280px]' : 'min-h-[400px]'}`}>
      {/* Loading skeleton — overlays the chart container while data fetches */}
      <AnimatePresence>
        {histLoading && (
          <motion.div
            key="chart-skeleton"
            className="absolute inset-0 z-20 bg-card rounded-md overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.3 } }}
          >
            <ChartSkeleton />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Indicator toggle controls — hidden in compact (chat) mode */}
      {!compact && <div className="absolute top-2 right-2 z-10 flex gap-1 flex-wrap justify-end max-w-[60%]">
        {/* Compare with S&P 500 toggle */}
        <button
          onClick={() => setIsComparisonMode((prev) => !prev)}
          className={`data-hover px-2 py-0.5 rounded text-xs font-medium border ${isComparisonMode ? 'opacity-100' : 'opacity-60'
            }`}
          style={{
            borderColor: '#6b7280',
            color: '#6b7280',
            backgroundColor: isComparisonMode ? 'rgba(107, 114, 128, 0.15)' : 'transparent',
          }}
          title="Compare with S&P 500"
          aria-pressed={isComparisonMode}
        >
          Compare with S&P 500
        </button>

        {/* Indicator toggles — hidden in comparison mode */}
        {!isComparisonMode && INDICATORS.map((ind) => (
          <button
            key={ind.key}
            onClick={() => toggleIndicator(ind.key)}
            className={`data-hover px-2 py-0.5 rounded text-xs font-medium border ${visible[ind.key]
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
      </div>}

      {/* Ticker label */}
      <div className="absolute top-2 left-2 z-10 text-sm font-semibold text-muted-foreground">
        {selectedTicker}
        {isComparisonMode && (
          <span className="ml-2 text-xs text-gray-400">vs S&P 500</span>
        )}
        {histError && (
          <span className="ml-2 text-xs text-red-400">Error loading data</span>
        )}
      </div>

      {/* Chart container */}
      <div
        ref={chartContainerRef}
        className="w-full h-full"
        style={{ minHeight: compact ? '250px' : '400px' }}
      />
    </div>
  )
}

export default StockChart
