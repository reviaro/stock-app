import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SimulatorReviewPanel } from './SimulatorReviewPanel'
const { review } = vi.hoisted(() => ({ review: vi.fn() }))
vi.mock('@/hooks/useSimulator', () => ({ useSimReview: review }))
const base = { total_return_pct: 8, cash_pct: 100, total_value: 1080, unrealized_pnl: 0, realized_pnl: 80,
  position_count: 0, closed_trade_count: 1, hit_rate_pct: 100, largest_position: null,
  positions: [], recent_buffett_actions: [], observation_count: 3 }
beforeEach(() => review.mockReturnValue({ data: { ...base, twr_pct: null, observed_drawdown_pct: null,
  performance_blockers: ['unvalued_cash_flow'] } }))
describe('stored simulator performance', () => {
  it('does not present capital-relative profit as time-weighted performance when flow valuations are missing', () => {
    render(<SimulatorReviewPanel accountId={2} />)
    expect(screen.getByText('Capital-relative P&L')).toBeInTheDocument()
    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.getByText(/unvalued cash flow/)).toBeInTheDocument()
  })
  it('shows verified time-weighted performance separately from capital-relative profit', () => {
    review.mockReturnValue({ data: { ...base, twr_pct: 2.5, observed_drawdown_pct: 1.25, performance_blockers: [] } })
    render(<SimulatorReviewPanel accountId={2} />)
    expect(screen.getByText('2.50%')).toBeInTheDocument()
    expect(screen.getByText(/Observed drawdown: 1.25%/)).toBeInTheDocument()
    expect(screen.queryByText(/Measurement unavailable:/)).not.toBeInTheDocument()
  })
})
