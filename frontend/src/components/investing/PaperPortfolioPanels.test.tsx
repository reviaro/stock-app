import { afterEach, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PaperPortfolioPanels } from './PaperPortfolioPanels'
import { paperFillsCsv } from '@/lib/paperPortfolio'
import type { PaperPortfolio } from '@/types/alpacaPortfolio'

const fixture = (): PaperPortfolio => ({
  environment: 'paper', checkedAt: '2026-01-10T16:00:00Z', period: '1M', cash: 850, equity: 1180, cashPct: 72.03,
  positions: [{ symbol: 'TEST', qty: 3.125, avgCost: 100, price: 110, value: 343.75, priceChange: 10, priceChangePct: 10,
    unrealizedPnl: 31.25, unrealizedPnlPct: 10, weightPct: 29.13, managedQty: 3.125, heldSince: '2026-01-01T16:00:00Z' }],
  unrealizedPnl: 31.25, realizedPnl: 40, realizedExitCount: 1, winRatePct: 100, fifoAvailable: true,
  periodReturnPct: -1.67, observedEquityDrawdownPct: -1.67,
  history: [{ date: '2026-01-02T21:00:00Z', equity: 1200, profitLoss: 0, returnPct: 0 }, { date: '2026-01-05T21:00:00Z', equity: 1180, profitLoss: -20, returnPct: -1.67 }],
  trades: [{ id: 'synthetic-fill', orderId: 'synthetic-order', symbol: 'TEST', side: 'buy', qty: 3.125, price: 100, amount: 312.5, date: '2026-01-01T16:00:00Z', origin: 'Long-term investing', reason: 'Synthetic durable investment thesis.' }],
  actions: [], fillHistoryComplete: true, fillsAvailable: true, warnings: [],
})
const ok = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 })
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><PaperPortfolioPanels /></QueryClientProvider>)
}
afterEach(() => vi.restoreAllMocks())

test('shows broker holdings, equity observations, contribution and thesis-linked executions', async () => {
  const data = fixture(); data.actions = data.trades
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok(data))
  mount(); await screen.findByText('Simulated Holdings')
  expect(screen.getByText('Buffett Review')).toBeInTheDocument()
  expect(screen.getByText('Trade History')).toBeInTheDocument()
  const holdings = within(screen.getByRole('region', { name: 'Alpaca paper holdings' }))
  expect(holdings.getByText('$343.75')).toBeInTheDocument()
  expect(holdings.getByText('+$10.00 (10%)')).toBeInTheDocument()
  expect(holdings.getByText('9d')).toBeInTheDocument()
  expect(screen.getByText('Synthetic durable investment thesis.')).toBeInTheDocument()
  expect(screen.getByRole('img', { name: /Alpaca paper account equity/ })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Daily equity observations', hidden: true })).toHaveTextContent('$1,180.00')
  expect(fetcher).toHaveBeenCalledWith('/api/alpaca-paper/long-term/portfolio?period=1M', { credentials: 'same-origin' })
})

test('filters fills, switches period and refreshes using only read-only paper routes', async () => {
  const data = fixture()
  data.trades.push({ ...data.trades[0], id: 'other-fill', symbol: 'DEMO', side: 'sell', amount: 400 })
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => ok({ ...data, period: String(input).endsWith('3M') ? '3M' : '1M' }))
  mount(); await screen.findByText('Trade History')
  fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'demo' } })
  const history = within(screen.getByRole('region', { name: 'Alpaca paper trade history' }))
  expect(history.queryByText('TEST')).not.toBeInTheDocument()
  expect(history.getByText('$400.00')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'buy' } })
  expect(screen.getByText('No trades match these filters.')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Equity history period'), { target: { value: '3M' } })
  await screen.findByText('Broker P&L · 3 months')
  const count = fetcher.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio' }))
  await waitFor(() => expect(fetcher.mock.calls.length).toBe(count + 1))
  expect(fetcher.mock.calls.every(([url, options]) => String(url).startsWith('/api/alpaca-paper/long-term/portfolio?') && !options?.method)).toBe(true)
})

test('shows coverage warnings and unavailable estimates without inventing zero returns', async () => {
  const data = fixture()
  Object.assign(data, { trades: [], history: [], fillsAvailable: false, fillHistoryComplete: false, fifoAvailable: false, realizedPnl: null, realizedExitCount: null, winRatePct: null, periodReturnPct: null, observedEquityDrawdownPct: null, warnings: ['Broker fills are unavailable.'] })
  data.positions[0].heldSince = null
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok(data))
  mount(); await screen.findByText('Trade History')
  expect(screen.getByRole('status')).toHaveTextContent('Broker fills are unavailable.')
  expect(screen.getByText('Trade history is unavailable.')).toBeInTheDocument()
  expect(screen.getByText('No broker equity observations available for this period.')).toBeInTheDocument()
  expect(screen.getByText('Realized · FIFO estimate').parentElement).toHaveTextContent('—')
  expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled()
})

test('reports connection errors and permits a manual retry', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ status: 'error', error: 'Paper account mismatch.' }), { status: 503 })).mockResolvedValue(ok(fixture()))
  mount()
  expect(await screen.findByRole('alert')).toHaveTextContent('Paper account mismatch.')
  expect(screen.queryByText('No open Alpaca paper positions.')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh portfolio' }))
  await screen.findByText('Simulated Holdings')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

test('CSV preserves fractional fills, quotes notes and neutralizes spreadsheet formulas', () => {
  const data = fixture(); data.trades[0].reason = ' =SUM(1,2)\n"synthetic"'
  const csv = paperFillsCsv(data.trades)
  expect(csv).toContain('"3.125","100","312.5"')
  expect(csv).toContain('"\' =SUM(1,2)\n""synthetic"""')
  expect(csv).toContain('Date (UTC)')
})
