import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DayTradingJournalCard } from './DayTradingJournalCard'

const analytics = {
  closed_trade_count: 3, win_rate_pct: 50, expectancy: 10, profit_factor: 1.2, average_r: 0.5, total_pnl: 20,
  by_setup: { breakout: { trade_count: 2, win_rate_pct: 66.7, expectancy: 8, average_r: 0.4, total_pnl: 15 } },
}

const events = [
  {
    source: 'semantic', eventKey: 'decision:1', planId: null, eventType: 'strategy_decision', action: 'no_trade',
    outcome: 'skipped', reason: 'setup_not_confirmed', detail: { symbol: 'NVDA' }, occurredAt: '2026-09-21T13:00:00.000Z',
  },
  {
    source: 'semantic', eventKey: 'anomaly:1', planId: 3, eventType: 'anomaly', action: 'reconcile_fill',
    outcome: 'unresolved', reason: 'orphan_fill', detail: { symbol: 'AMD' }, occurredAt: '2026-09-21T14:00:00.000Z',
  },
  {
    source: 'fill', eventKey: undefined, planId: 3, eventType: 'fill', action: 'sell',
    outcome: 'partial_fill', reason: null, detail: { symbol: 'AMD' }, occurredAt: '2026-09-21T14:05:00.000Z',
  },
]

const { journal } = vi.hoisted(() => ({
  journal: { current: null as unknown, isLoading: false, isError: false },
}))

vi.mock('@/hooks/useAlpacaDayTrading', () => ({
  useAlpacaDayTradingJournal: () => ({ data: journal.current, isLoading: journal.isLoading, isError: journal.isError }),
}))

describe('DayTradingJournalCard', () => {
  it('shows a loading state before analytics arrive', () => {
    journal.current = undefined
    journal.isLoading = true
    journal.isError = false
    render(<DayTradingJournalCard />)
    expect(screen.getByText(/Loading journal/i)).toBeInTheDocument()
  })

  it('renders analytics, the by-setup table, and the event timeline from the nested response shape', () => {
    journal.current = { analytics, trades: [], events }
    journal.isLoading = false
    journal.isError = false
    render(<DayTradingJournalCard />)

    expect(screen.getByText('3')).toBeInTheDocument() // closed trade count
    expect(screen.getByText('breakout')).toBeInTheDocument()
    // newest event first
    const timelineItems = screen.getAllByText(/NVDA|AMD/)
    expect(timelineItems[0]).toHaveTextContent('AMD')
  })

  it('filters the timeline by event source', () => {
    journal.current = { analytics, trades: [], events }
    journal.isLoading = false
    journal.isError = false
    render(<DayTradingJournalCard />)

    fireEvent.change(screen.getByLabelText(/Filter timeline by event source/i), { target: { value: 'fill' } })
    expect(screen.queryByText('setup_not_confirmed')).not.toBeInTheDocument()
    expect(screen.getByText('fill')).toBeInTheDocument()
  })

  it('U1: renders broker message when present, and no Broker line when absent', () => {
    const eventWithBrokerMessage = {
      source: 'semantic', eventKey: 'action:fail', planId: 3, eventType: 'monitor_action', action: 'submit_time_exit',
      outcome: 'failed', reason: 'broker_rejected',
      detail: { symbol: 'MRNA', broker_message: 'insufficient qty available for order (requested: 10, available: 0)' },
      occurredAt: '2026-09-22T19:46:00.000Z',
    }
    const eventWithoutBrokerMessage = {
      source: 'semantic', eventKey: 'action:ok', planId: 4, eventType: 'monitor_action', action: 'submit_time_exit',
      outcome: 'flat_verified', reason: null, detail: { symbol: 'SNDK' },
      occurredAt: '2026-09-22T19:46:01.000Z',
    }

    journal.current = { analytics, trades: [], events: [eventWithBrokerMessage, eventWithoutBrokerMessage] }
    journal.isLoading = false
    journal.isError = false
    render(<DayTradingJournalCard />)

    expect(screen.getByText(/Broker: insufficient qty available for order/i)).toBeInTheDocument()
    const allBrokerMentions = screen.queryAllByText(/Broker:/i)
    expect(allBrokerMentions).toHaveLength(1)
  })
})

