import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
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
import type { StockHistory } from '@/types'

/**
 * Normalizes OHLCV or line data to percentage change from the first data point.
 * Formula: normalized_value = (current_price - start_price) / start_price * 100
 * The start_price is the first price in the provided data range.
 */
function normalizeToPercent(data: LineData<Time>[]): LineData<Time>[] {
  if (!data.length) return []
  const startPrice = data[0].value
  if (!Number.isFinite(startPrice) || startPrice <= 0) return []
  return data.map((d) => ({
    time: d.time,
    value: ((d.value - startPrice) / startPrice) * 100,
  }))
}

/** Compare identical trading dates, so both return series share a baseline and window. */
function comparisonData(stock?: StockHistory, benchmark?: StockHistory) {
  const closes = (history?: StockHistory) => new Map(
    (history?.data ?? [])
      .filter((point) => Number.isFinite(point.close) && point.close > 0)
      .map((point) => [point.date.slice(0, 10), point.close]),
  )
  const stockCloses = closes(stock)
  const benchmarkCloses = closes(benchmark)
  const dates = [...stockCloses.keys()].filter((date) => benchmarkCloses.has(date)).sort()
  return {
    stock: normalizeToPercent(dates.map((time) => ({ time: time as Time, value: stockCloses.get(time)! }))),
    benchmark: normalizeToPercent(dates.map((time) => ({ time: time as Time, value: benchmarkCloses.get(time)! }))),
  }
}

// Indicator display configuration
interface IndicatorConfig {
  key: 'sma50' | 'sma200' | 'ema21'
  label: string
  color: string
  lineWidth: LineWidth
}

const INDICATORS: IndicatorConfig[] = [
  { key: 'sma50', label: 'SMA 50', color: '--warning', lineWidth: 1 },
  { key: 'sma200', label: 'SMA 200', color: '--info', lineWidth: 1 },
  { key: 'ema21', label: 'EMA 21', color: '--highlight', lineWidth: 1 },
]

function chartColor(token: string, fallback = '#737373') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  return value ? `hsl(${value.split(/\s+/).join(', ')})` : fallback
}

function chartTheme() {
  const text = chartColor('--muted-foreground')
  const border = chartColor('--border')
  return {
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: text },
    grid: { vertLines: { color: border }, horzLines: { color: border } },
    crosshair: { vertLine: { color: text }, horzLine: { color: text } },
    rightPriceScale: { borderColor: border },
    timeScale: { borderColor: border, timeVisible: true, secondsVisible: false },
  }
}

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
  const { data: technicalData, error: technicalError } = useTechnicalData(selectedTicker)

  // Data hook — S&P 500 (only fetches when comparison mode is active)
  const { data: sp500Data, error: comparisonError, isLoading: comparisonLoading } = useStockHistory(isComparisonMode ? SP500_SYMBOL : '')
  const currentHistory = !histError && historyData?.symbol === selectedTicker ? historyData : undefined
  const currentTechnical = !technicalError && technicalData?.symbol === selectedTicker ? technicalData : undefined
  const benchmark = !comparisonError && sp500Data?.symbol === SP500_SYMBOL ? sp500Data : undefined

  const comparison = useMemo(() => comparisonData(currentHistory, benchmark), [currentHistory, benchmark])
  const recentPrices = useMemo(() => [...(currentHistory?.data ?? [])].sort((a, b) => a.date.localeCompare(b.date)).slice(-60), [currentHistory])

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
      ...chartTheme(),
    })

    chartRef.current = chart

    // Candlestick series (normal mode)
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: chartColor('--positive'),
      downColor: chartColor('--negative'),
      borderUpColor: chartColor('--positive'),
      borderDownColor: chartColor('--negative'),
      wickUpColor: chartColor('--positive'),
      wickDownColor: chartColor('--negative'),
      visible: true,
    })
    candleSeriesRef.current = candleSeries

    // Stock line series (comparison mode — shows normalized % from start)
    const stockLineSeries = chart.addSeries(LineSeries, {
      color: chartColor('--positive'),
      lineWidth: 2 as LineWidth,
      visible: false,       // hidden by default — shown in comparison mode
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: 'percent', precision: 2, minMove: 0.01 },
    })
    stockLineSeriesRef.current = stockLineSeries

    // S&P 500 overlay line series (comparison mode — dashed grey)
    const sp500Series = chart.addSeries(LineSeries, {
      color: chartColor('--muted-foreground'),
      lineWidth: 1 as LineWidth,
      lineStyle: 2,         // dashed
      visible: false,       // hidden by default — shown in comparison mode
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'S&P 500',
      priceFormat: { type: 'percent', precision: 2, minMove: 0.01 },
    })
    sp500SeriesRef.current = sp500Series

    // Add a line series per indicator
    for (const ind of INDICATORS) {
      const lineSeries = chart.addSeries(LineSeries, {
        color: chartColor(ind.color),
        lineWidth: ind.lineWidth,
        visible: true,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      lineSeriesRefs.current[ind.key] = lineSeries
    }

    const updateTheme = () => {
      chart.applyOptions(chartTheme())
      const up = chartColor('--positive')
      const down = chartColor('--negative')
      candleSeries.applyOptions({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down })
      stockLineSeries.applyOptions({ color: up })
      sp500Series.applyOptions({ color: chartColor('--muted-foreground') })
      for (const indicator of INDICATORS) {
        lineSeriesRefs.current[indicator.key]?.applyOptions({ color: chartColor(indicator.color) })
      }
    }
    const themeObserver = new MutationObserver(updateTheme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    // ResizeObserver for fluid container responsiveness
    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries.length || !chartRef.current) return
      const { width, height } = entries[0].contentRect
      chartRef.current.applyOptions({ width, height })
    })

    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      themeObserver.disconnect()
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
    if (!series) return

    const candles: CandlestickData<Time>[] = (currentHistory?.data ?? []).map((pt) => ({
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
  }, [currentHistory, selectedTicker])

  // ---- Technical indicator data update ----
  useEffect(() => {
    const charts = currentTechnical?.charts
    const dates = (currentHistory?.data ?? []).map((pt) => pt.date.slice(0, 10))
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

      const raw = charts?.[ind.key] ?? []
      const lineData = toLineData(raw, chartDates.slice(-raw.length))
      const byDate = new Map(lineData.map((point) => [point.time as string, point]))
      series.setData([...byDate.values()].sort((a, b) => String(a.time).localeCompare(String(b.time))))
    }
  }, [currentTechnical, currentHistory, selectedTicker])

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
      // Values are already returns. A percentage scale would divide by their zero baseline again.
      chart.priceScale('right').applyOptions({ mode: PriceScaleMode.Normal })

      // Hide candlestick series; show stock line series
      // The first series also supplies the shared axis formatter, even when hidden.
      candleSeries.applyOptions({ visible: false, priceFormat: { type: 'percent', precision: 2, minMove: 0.01 } })
      stockLineSeries.applyOptions({ visible: true })

      // Hide indicator overlays (they have absolute prices, not % — would distort)
      for (const ind of INDICATORS) {
        lineSeriesRefs.current[ind.key]?.applyOptions({ visible: false })
      }

      stockLineSeries.setData(comparison.stock)
      sp500Series.setData(comparison.benchmark)
      sp500Series.applyOptions({ visible: comparison.benchmark.length > 0 })

      chart.timeScale().fitContent()
    } else {
      // Switch price scale back to Normal mode
      chart.priceScale('right').applyOptions({ mode: PriceScaleMode.Normal })

      // Show candlestick series; hide comparison line series
      candleSeries.applyOptions({ visible: true, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } })
      stockLineSeries.applyOptions({ visible: false })
      sp500Series.applyOptions({ visible: false })

      // Restore indicator overlay visibility from state
      for (const ind of INDICATORS) {
        lineSeriesRefs.current[ind.key]?.applyOptions({ visible: visible[ind.key] })
      }

      chart.timeScale().fitContent()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isComparisonMode, comparison, selectedTicker])

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
      {!compact && <div className="order-2 flex gap-2 flex-wrap px-2 pb-2">
        {/* Compare with S&P 500 toggle */}
        <button
          onClick={() => setIsComparisonMode((prev) => !prev)}
          className={`data-hover min-h-9 px-2 py-1 rounded text-xs font-medium border text-muted-foreground ${isComparisonMode ? 'bg-accent' : 'bg-transparent'}`}
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
            className={`data-hover min-h-9 px-2 py-1 rounded text-xs font-medium border ${visible[ind.key]
                ? 'bg-accent'
                : 'bg-transparent'
              }`}
            style={{
              borderColor: `hsl(var(${ind.color}))`,
              color: `hsl(var(${ind.color}))`,
              backgroundColor: visible[ind.key]
                ? `hsl(var(${ind.color}) / 0.12)`
                : 'transparent',
            }}
            title={`Toggle ${ind.label}`}
            aria-pressed={visible[ind.key]}
          >
            {ind.label}
          </button>
        ))}
      </div>}

      {/* Ticker label */}
      <div className="order-1 flex flex-wrap gap-2 px-2 py-2 text-sm font-semibold text-muted-foreground">
        {selectedTicker}
        {isComparisonMode && (
          <span className="ml-2 text-xs text-muted-foreground">vs S&P 500</span>
        )}
        {histError && <span role="alert" className="ml-2 text-xs text-destructive">Unable to load {selectedTicker} history.</span>}
        {!histLoading && !histError && !currentHistory?.data.length && <span className="ml-2 text-xs">No price history available.</span>}
        {!isComparisonMode && technicalError && <span role="alert" className="ml-2 text-xs text-destructive">Indicators unavailable.</span>}
        {isComparisonMode && comparisonLoading && <span role="status" className="ml-2 text-xs">Loading comparison…</span>}
        {isComparisonMode && comparisonError && <span role="alert" className="ml-2 text-xs text-destructive">S&amp;P 500 comparison unavailable.</span>}
        {isComparisonMode && currentHistory && benchmark && comparison.stock.length === 0 && <span className="ml-2 text-xs">No shared trading dates to compare.</span>}
      </div>

      {/* Chart container */}
      <div
        ref={chartContainerRef}
        role="img"
        aria-label={`${selectedTicker} ${isComparisonMode ? "return compared with S&P 500" : "price history"} chart. Open View price data below for daily values.`}
        className="order-3 w-full flex-1"
        style={{ minHeight: compact ? '250px' : '400px' }}
      />
      {currentHistory && <details className="order-4 px-2 py-2 text-xs">
        <summary className="cursor-pointer rounded py-2 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">View price data</summary>
        <div className="max-h-60 overflow-auto">
          {isComparisonMode ? <table className="w-full text-right">
            <caption className="py-2 text-left text-muted-foreground">Returns from the first shared trading date.</caption>
            <thead><tr><th scope="col" className="text-left">Date</th><th scope="col">{selectedTicker}</th><th scope="col">S&amp;P 500</th></tr></thead>
            <tbody>{comparison.stock.map((point, index) => <tr key={String(point.time)}><th scope="row" className="py-1 text-left font-normal">{String(point.time)}</th><td>{point.value.toFixed(2)}%</td><td>{comparison.benchmark[index].value.toFixed(2)}%</td></tr>)}</tbody>
          </table> : <table className="w-full text-right">
            <caption className="py-2 text-left text-muted-foreground">Most recent {recentPrices.length} daily prices for {selectedTicker}.</caption>
            <thead><tr><th scope="col" className="text-left">Date</th>{['Open', 'High', 'Low', 'Close'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
            <tbody>{recentPrices.map((point) => <tr key={point.date}><th scope="row" className="py-1 text-left font-normal">{point.date.slice(0, 10)}</th>{[point.open, point.high, point.low, point.close].map((value, index) => <td key={index} className="pl-2">{value.toFixed(2)}</td>)}</tr>)}</tbody>
          </table>}
        </div>
      </details>}

    </div>
  )
}

export default StockChart
