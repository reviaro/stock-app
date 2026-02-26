import { useEffect, useRef } from 'react'
import {
  createChart,
  CandlestickSeries,
  ColorType,
  type IChartApi,
  type CandlestickData,
  type Time,
} from 'lightweight-charts'

// Dummy candlestick data for initial verification
const DUMMY_DATA: CandlestickData<Time>[] = [
  { time: '2024-01-02' as Time, open: 180, high: 185, low: 178, close: 183 },
  { time: '2024-01-03' as Time, open: 183, high: 188, low: 181, close: 186 },
  { time: '2024-01-04' as Time, open: 186, high: 190, low: 182, close: 184 },
  { time: '2024-01-05' as Time, open: 184, high: 187, low: 179, close: 180 },
  { time: '2024-01-08' as Time, open: 180, high: 185, low: 177, close: 183 },
  { time: '2024-01-09' as Time, open: 183, high: 192, low: 182, close: 190 },
  { time: '2024-01-10' as Time, open: 190, high: 195, low: 188, close: 193 },
  { time: '2024-01-11' as Time, open: 193, high: 197, low: 191, close: 195 },
  { time: '2024-01-12' as Time, open: 195, high: 200, low: 193, close: 198 },
  { time: '2024-01-16' as Time, open: 198, high: 202, low: 194, close: 196 },
]

interface StockChartProps {
  ticker?: string
}

export function StockChart({ ticker }: StockChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!chartContainerRef.current) return

    const container = chartContainerRef.current

    // Create chart with professional dark theme options
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

    // Add candlestick series using the v5 CandlestickSeries definition
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',       // green-500
      downColor: '#ef4444',     // red-500
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    })

    series.setData(DUMMY_DATA)
    chart.timeScale().fitContent()

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
    }
  }, [])

  return (
    <div className="relative w-full h-full min-h-[400px]">
      {ticker && (
        <div className="absolute top-2 left-2 z-10 text-sm text-muted-foreground">
          {ticker}
        </div>
      )}
      <div
        ref={chartContainerRef}
        className="w-full h-full"
        style={{ minHeight: '400px' }}
      />
    </div>
  )
}

export default StockChart
