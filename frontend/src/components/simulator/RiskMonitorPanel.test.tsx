import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RiskMonitorPanel } from './RiskMonitorPanel'

vi.mock('@/hooks/useSimulator', () => ({
  useSimRiskMonitor: () => ({
    data: {
      read_only: true,
      execution_enabled: false,
      checked_at: '2026-08-11T15:00:00.000Z',
      market_open: true,
      alerts: [
        { type: 'stop_breached', severity: 'critical', symbol: 'XOM', message: 'XOM is at or below its documented hard stop.', current_price: 97.5, threshold: 98 },
      ],
      positions: [
        { symbol: 'XOM', current_price: 97.5, quote_timestamp: '2026-08-11T14:59:59.000Z', market_state: 'REGULAR', data_source: 'alpaca_iex' },
      ],
    },
    isLoading: false,
    isError: false,
  }),
}))

describe('RiskMonitorPanel', () => {
  it('shows risk alerts and makes the read-only boundary explicit', () => {
    render(<RiskMonitorPanel accountId={2} />)
    expect(screen.getByRole('heading', { name: 'Position Risk Monitor' })).toBeInTheDocument()
    expect(screen.getByText(/never submits or closes an order/i)).toBeInTheDocument()
    expect(screen.getByText(/XOM is at or below its documented hard stop/i)).toBeInTheDocument()
    expect(screen.getByText(/Alpaca IEX/i)).toBeInTheDocument()
    expect(screen.getByText(/Regular/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /sell|close|submit/i })).not.toBeInTheDocument()
  })
})
