import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TradePanel } from './TradePanel'

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: 100 }),
}))
vi.mock('@/hooks/useSimulator', () => ({
  useSimTrade: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false }),
  useSimAccount: () => ({ data: { cash: 10000 } }),
  useTaxPreview: () => ({ data: null, isLoading: false }),
}))

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
    render(<TradePanel accountId={2} sellTarget={{ symbol: 'MSFT', shares: 10, avg_cost: 100, total_cost: 1000, currentPrice: 105, priceChange: 1, priceChangePct: 1, previousClose: 104, currentValue: 1050, pnl: 50, pnlPct: 5, oldest_lot_date: '2026-08-11' }} onSellClose={vi.fn()} structuredJournal />)
    expect(screen.getByLabelText('Exit reason')).toBeInTheDocument()
    expect(screen.getByLabelText('Thesis remained valid')).toBeInTheDocument()
    expect(screen.getByLabelText('Review notes')).toBeInTheDocument()
  })

  it('keeps the long-term buy form compact', () => {
    render(<TradePanel accountId={1} sellTarget={null} onSellClose={vi.fn()} structuredJournal={false} />)
    expect(screen.queryByLabelText('Setup')).not.toBeInTheDocument()
  })
})
