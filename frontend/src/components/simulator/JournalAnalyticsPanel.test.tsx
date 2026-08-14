import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { JournalAnalyticsPanel } from './JournalAnalyticsPanel'

vi.mock('@/hooks/useSimulator', () => ({
  useSimJournal: () => ({
    data: {
      analytics: {
        closed_trade_count: 3,
        win_rate_pct: 66.67,
        expectancy: 50,
        profit_factor: 2.5,
        average_r: 0.5,
        total_pnl: 150,
        by_setup: {
          breakout: { trade_count: 2, win_rate_pct: 50, expectancy: 50, average_r: 0.5, total_pnl: 100 },
        },
      },
      trades: [],
    },
    isLoading: false,
    isError: false,
  }),
}))

describe('JournalAnalyticsPanel', () => {
  it('renders expectancy, R multiples and setup evidence separately from win rate', () => {
    render(<JournalAnalyticsPanel accountId={2} />)
    expect(screen.getByRole('heading', { name: 'Structured Trade Journal' })).toBeInTheDocument()
    expect(screen.getAllByText('Expectancy')).toHaveLength(2)
    expect(screen.getAllByText('$50.00')).toHaveLength(2)
    expect(screen.getByText('Average R')).toBeInTheDocument()
    expect(screen.getAllByText('0.50R')).toHaveLength(2)
    expect(screen.getByText('breakout')).toBeInTheDocument()
  })
})
