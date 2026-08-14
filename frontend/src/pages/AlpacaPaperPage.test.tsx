import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AlpacaPaperPage } from './AlpacaPaperPage'

const { paperStatus } = vi.hoisted(() => ({
  paperStatus: { orderEntryEnabled: false },
}))

vi.mock('@/hooks/useAlpacaPaper', () => ({
  useAlpacaPaperStatus: () => ({
    data: {
      configured: true,
      environment: 'paper',
      baseUrl: 'https://paper-api.alpaca.markets',
      connection: 'verified',
      accountStatus: 'ACTIVE',
      cash: '100000.00',
      equity: '100000.00',
      portfolioValue: '100000.00',
      buyingPower: '400000.00',
      multiplier: '4',
      orderEntryEnabled: paperStatus.orderEntryEnabled,
    },
    isLoading: false,
    isError: false,
  }),
  useAlpacaPaperSnapshot: () => ({
    data: {
      clock: { timestamp: '2026-08-06T17:00:00-04:00', isOpen: false, nextOpen: '2026-08-07T09:30:00-04:00', nextClose: '2026-08-07T16:00:00-04:00' },
      positions: [],
      openOrders: [],
    },
    isLoading: false,
    isError: false,
  }),
}))

describe('AlpacaPaperPage', () => {
  it('permanently discloses paper-only long-only cash-only restrictions', () => {
    render(<AlpacaPaperPage />)

    expect(screen.getByRole('heading', { name: 'Alpaca Paper Broker' })).toBeInTheDocument()
    expect(screen.getByText(/Paper account — no real money/i)).toBeInTheDocument()
    expect(screen.getByText(/Long-only US equity trades using cash-only sizing/i)).toBeInTheDocument()
    expect(screen.getByText(/Margin, short sales, options, crypto, extended-hours, and advanced orders are disabled/i)).toBeInTheDocument()
    expect(screen.getByText(/Paper connection verified/i)).toBeInTheDocument()
    expect(screen.getAllByText('$100,000.00')).toHaveLength(2)
    expect(screen.getByText(/dashboard never uses it/i)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Broker reconciliation' })).toBeInTheDocument()
    expect(screen.getByText('Market:').parentElement).toHaveTextContent('Closed')
    expect(screen.getByText(/No Alpaca paper positions/i)).toBeInTheDocument()
    expect(screen.getByText(/No open Alpaca paper orders/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /submit.*order/i })).not.toBeInTheDocument()
  })

  it('visibly warns when guarded paper-order execution is enabled', () => {
    paperStatus.orderEntryEnabled = true
    render(<AlpacaPaperPage />)

    expect(screen.getByText(/Paper order execution is enabled/i)).toBeInTheDocument()
    expect(screen.getByText(/requires the independent server-side order token/i)).toBeInTheDocument()
    expect(screen.queryByText(/Order entry is intentionally disabled/i)).not.toBeInTheDocument()
    paperStatus.orderEntryEnabled = false
  })
})
