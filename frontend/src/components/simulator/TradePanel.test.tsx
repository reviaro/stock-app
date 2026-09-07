import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TradePanel } from './TradePanel'

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  retryOrder: vi.fn(),
  reconcileOrder: vi.fn(),
  useQuery: vi.fn((): { data: number | null } => ({ data: 100 })),
  pending: null as { type: string; symbol: string; shares: number; account_id: number; client_order_id: string } | null,
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: mocks.useQuery,
}))
vi.mock('@/hooks/useSimulator', () => ({
  useSimTrade: () => ({ mutateAsync: mocks.mutateAsync, isPending: false, isError: false, pendingOrder: mocks.pending, retryOrder: mocks.retryOrder, reconcileOrder: mocks.reconcileOrder }),
  useSimAccount: () => ({ data: { cash: 10000 } }),
  useTaxPreview: () => ({ data: null, isLoading: false }),
}))

const holding = { symbol: 'MSFT', shares: 10, avg_cost: 100, total_cost: 1000, currentPrice: 105, priceChange: 1, priceChangePct: 1, previousClose: 104, currentValue: 1050, pnl: 50, pnlPct: 5, oldest_lot_date: '2026-08-11' }

describe('TradePanel structured day-trade fields', () => {
  it('shows measurable setup, thesis, stop, target and invalidation fields for day trading', () => {
    render(<TradePanel accountId={2} sellTarget={null} onSellClose={vi.fn()} structuredJournal />)
    expect(screen.getByLabelText('Setup')).toBeInTheDocument()
    expect(screen.getByLabelText('Thesis')).toBeInTheDocument()
    expect(screen.getByLabelText('Hard stop')).toBeInTheDocument()
    expect(screen.getByLabelText('Target')).toBeInTheDocument()
    expect(screen.getByLabelText('Invalidation')).toBeInTheDocument()
  })

  it('collects exit reason and thesis validity when closing a structured trade', () => {
    render(<TradePanel accountId={2} sellTarget={holding} onSellClose={vi.fn()} structuredJournal />)
    expect(screen.getByLabelText('Exit reason')).toBeInTheDocument()
    expect(screen.getByLabelText('Thesis remained valid')).toBeInTheDocument()
    expect(screen.getByLabelText('Review notes')).toBeInTheDocument()
  })

  it('keeps the long-term buy form compact', () => {
    render(<TradePanel accountId={1} sellTarget={null} onSellClose={vi.fn()} structuredJournal={false} />)
    expect(screen.queryByLabelText('Setup')).not.toBeInTheDocument()
  })
})

describe('TradePanel order intention handling', () => {
  beforeEach(() => {
    mocks.mutateAsync.mockReset()
    mocks.retryOrder.mockReset()
    mocks.reconcileOrder.mockReset()
    mocks.useQuery.mockReset()
    mocks.useQuery.mockImplementation(() => ({ data: 100 }))
    mocks.pending = null
  })

  it('submits a buy intention without a client price or date — the server prices the order', async () => {
    mocks.mutateAsync.mockResolvedValueOnce({ id: 1 })
    render(<TradePanel accountId={2} sellTarget={null} onSellClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Symbol (e.g. AAPL)'), { target: { value: 'AAPL' } })
    fireEvent.change(screen.getByPlaceholderText('Shares'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }))
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1))
    expect(mocks.mutateAsync).toHaveBeenCalledWith(expect.not.objectContaining({ price: expect.anything(), txn_date: expect.anything() }))
    expect(mocks.mutateAsync.mock.calls[0][0]).toMatchObject({ type: 'buy', symbol: 'AAPL', shares: 2 })
  })

  it('submits a sell intention without a client price or date', async () => {
    mocks.mutateAsync.mockResolvedValueOnce({ id: 2 })
    render(<TradePanel accountId={2} sellTarget={holding} onSellClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Sell 10 MSFT/ }))
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1))
    expect(mocks.mutateAsync).toHaveBeenCalledWith(expect.not.objectContaining({ price: expect.anything(), txn_date: expect.anything() }))
    expect(mocks.mutateAsync.mock.calls[0][0]).toMatchObject({ type: 'sell', symbol: 'MSFT', shares: 10 })
  })

  it('allows a buy even when the client-side price feed is unavailable — the server prices fills', async () => {
    mocks.mutateAsync.mockResolvedValueOnce({ id: 5 })
    mocks.useQuery.mockReturnValueOnce({ data: null })
    render(<TradePanel accountId={2} sellTarget={null} onSellClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Symbol (e.g. AAPL)'), { target: { value: 'AAPL' } })
    fireEvent.change(screen.getByPlaceholderText('Shares'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }))
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledWith({ type: 'buy', symbol: 'AAPL', shares: 2 }))
  })

  it('blocks new orders while an unresolved order is pending and offers retry with the same key', () => {
    mocks.pending = { type: 'buy', symbol: 'AAPL', shares: 2, account_id: 2, client_order_id: 'key-1' }
    render(<TradePanel accountId={2} sellTarget={null} onSellClose={vi.fn()} />)
    expect(screen.getByText(/order outcome is unknown/i)).toBeInTheDocument()
    expect(screen.getByText(/AAPL/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Buy' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /retry order/i }))
    expect(mocks.retryOrder).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /check status/i }))
    expect(mocks.reconcileOrder).toHaveBeenCalledTimes(1)
    expect(mocks.mutateAsync).not.toHaveBeenCalled()
  })

  it('says when the server has no fill and keeps the intention keyed', async () => {
    mocks.reconcileOrder.mockResolvedValueOnce(null)
    mocks.pending = { type: 'buy', symbol: 'AAPL', shares: 2, account_id: 2, client_order_id: 'key-1' }
    render(<TradePanel accountId={2} sellTarget={null} onSellClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /check status/i }))
    expect(await screen.findByText(/no fill for this order yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry order/i })).toBeInTheDocument()
  })

  it('returns to the trade form once the pending order is resolved', () => {
    mocks.pending = { type: 'buy', symbol: 'AAPL', shares: 2, account_id: 2, client_order_id: 'key-1' }
    const view = render(<TradePanel accountId={2} sellTarget={null} onSellClose={vi.fn()} />)
    mocks.pending = null
    view.rerender(<TradePanel accountId={2} sellTarget={null} onSellClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Buy' })).toBeInTheDocument()
  })
})
