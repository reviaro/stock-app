import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StockChart } from './StockChart'

const state = vi.hoisted(() => ({
  histories: {} as Record<string, { data?: unknown; error?: Error; isLoading?: boolean }>,
  technical: {} as Record<string, { data?: unknown; error?: Error }>,
  series: [] as { setData: ReturnType<typeof vi.fn>; applyOptions: ReturnType<typeof vi.fn> }[],
  scaleOptions: vi.fn(),
  chartOptions: vi.fn(),
}))
vi.mock('@/hooks/useMarketData', () => ({
  useStockHistory: (symbol: string) => state.histories[symbol] ?? {},
  useTechnicalData: (symbol: string) => state.technical[symbol] ?? {},
}))
vi.mock('lightweight-charts', () => ({
  CandlestickSeries: 'candles', LineSeries: 'line', ColorType: { Solid: 'solid' },
  PriceScaleMode: { Normal: 0, Percentage: 2 },
  createChart: () => ({
    addSeries: () => {
      const series = { setData: vi.fn(), applyOptions: vi.fn() }
      state.series.push(series)
      return series
    },
    priceScale: () => ({ applyOptions: state.scaleOptions }),
    timeScale: () => ({ fitContent: vi.fn() }),
    applyOptions: state.chartOptions,
    remove: vi.fn(),
  }),
}))
function history(symbol: string, closes: number[], start = 1) {
  return { symbol, data: closes.map((close, index) => ({
    date: `2026-01-${String(index + start).padStart(2, '0')}`, open: close, high: close, low: close, close,
  })) }
}
beforeEach(() => {
  state.histories = {}
  state.technical = {}
  state.series = []
  state.scaleOptions.mockClear()
  state.chartOptions.mockClear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('chart data integrity', () => {
  it('compares returns once from a shared date without a zero-base percentage scale', () => {
    state.histories.AAPL = { data: history('AAPL', [80, 100, 110]) }
    state.histories['^GSPC'] = { data: history('^GSPC', [200, 180], 2) }
    render(<StockChart symbol="AAPL" />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare with S&P 500' }))
    expect(state.series[1].setData).toHaveBeenLastCalledWith([
      { time: '2026-01-02', value: 0 }, { time: '2026-01-03', value: 10 },
    ])
    expect(state.series[2].setData).toHaveBeenLastCalledWith([
      { time: '2026-01-02', value: 0 }, { time: '2026-01-03', value: -10 },
    ])
    expect(state.scaleOptions).toHaveBeenLastCalledWith({ mode: 0 })
    expect(state.scaleOptions).not.toHaveBeenCalledWith({ mode: 2 })
    expect(state.series[0].applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ priceFormat: expect.objectContaining({ type: 'percent' }) }))
    fireEvent.click(screen.getByRole('button', { name: 'Compare with S&P 500' }))
    expect(state.series[0].applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ priceFormat: expect.objectContaining({ type: 'price' }) }))
  })

  it('clears candles and indicators while switching symbols and after history failure', () => {
    state.histories.AAPL = { data: history('AAPL', [100, 110]) }
    state.technical.AAPL = { data: { symbol: 'AAPL', charts: { sma50: [90, 95] } } }
    const { rerender } = render(<StockChart symbol="AAPL" />)
    expect(state.series[0].setData.mock.lastCall?.[0]).toHaveLength(2)
    expect(state.series[3].setData.mock.lastCall?.[0]).toHaveLength(2)
    state.histories.MSFT = { isLoading: true }
    rerender(<StockChart symbol="MSFT" />)
    expect(state.series[0].setData).toHaveBeenLastCalledWith([])
    expect(state.series[3].setData).toHaveBeenLastCalledWith([])
    state.histories.MSFT = { error: new Error('offline') }
    rerender(<StockChart symbol="MSFT" />)
    expect(state.series[0].setData).toHaveBeenLastCalledWith([])
    expect(screen.getByRole('alert')).toHaveTextContent('MSFT history')
  })

  it('removes old overlays when a new stock has candles but no indicator values', () => {
    state.histories.AAPL = { data: history('AAPL', [100, 110]) }
    state.technical.AAPL = { data: { symbol: 'AAPL', charts: { sma50: [90, 95] } } }
    const { rerender } = render(<StockChart symbol="AAPL" />)
    state.histories.MSFT = { data: history('MSFT', [200, 210]) }
    state.technical.MSFT = { data: { symbol: 'MSFT', charts: { sma50: [null, null] } } }
    rerender(<StockChart symbol="MSFT" />)
    expect(state.series[3].setData).toHaveBeenLastCalledWith([])
    expect(state.series[0].setData.mock.lastCall?.[0][0].close).toBe(200)
    state.technical.MSFT = { error: new Error('failed') }
    rerender(<StockChart symbol="MSFT" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Indicators unavailable')
  })

  it('updates canvas colors when the app theme changes', async () => {
    render(<StockChart symbol="AAPL" />)
    document.documentElement.style.setProperty('--muted-foreground', '0 0% 30%')
    document.documentElement.classList.toggle('dark')
    await waitFor(() => expect(state.chartOptions).toHaveBeenCalledWith(expect.objectContaining({
      layout: expect.objectContaining({ textColor: 'hsl(0, 0%, 30%)' }),
    })))
    document.documentElement.style.removeProperty('--muted-foreground')
  })

  it('clears comparison lines when the new stock or shared trading dates are missing', () => {
    state.histories.AAPL = { data: history('AAPL', [100, 110]) }
    state.histories['^GSPC'] = { data: history('^GSPC', [200, 210]) }
    const { rerender } = render(<StockChart symbol="AAPL" />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare with S&P 500' }))
    state.histories.MSFT = { data: history('MSFT', [200], 10) }
    rerender(<StockChart symbol="MSFT" />)
    expect(state.series[1].setData).toHaveBeenLastCalledWith([])
    expect(state.series[2].setData).toHaveBeenLastCalledWith([])
    expect(screen.getByText('No shared trading dates to compare.')).toBeInTheDocument()
  })
})
