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
}))

vi.mock('@/hooks/useAlpacaDayTrading', () => ({
  useAlpacaDayTradingMonitorHealth: () => ({
    data: {
      mode: 'shadow',
      killSwitch: false,
      healthCode: null,
      healthError: null,
      lastRestReconciliationAt: '2026-09-17T14:00:00.000Z',
      lastWebsocketEventAt: null,
      lastWebsocketReconnectAt: null,
      lastSyncedThrough: null,
      sessionDate: null,
      lastFlattenSweepAt: null,
    },
    isLoading: false,
    isError: false,
  }),
  useAlpacaDayTradingSnapshot: () => ({
    data: {
      account: { cash: '50000.00', equity: '100000.00', buyingPower: '200000.00', status: 'ACTIVE' },
      clock: { isOpen: true, nextOpen: '2026-09-18T13:30:00Z', nextClose: '2026-09-17T20:00:00Z' },
      positions: [],
      activePlans: [],
      risk: {
        equity: '100000.00',
        cashPct: 0.5,
        totalOpenRiskDollars: 0,
        totalOpenRiskPct: 0,
        dailyRealizedPnl: null,
        dailyLossPct: null,
        dailyPnlUnavailableReason: 'the current NYSE session date has not been recorded yet',
        limits: { maxPositionPct: 0.25, minCashPct: 0.10, maxRiskPerTradePct: 0.01, maxTotalOpenRiskPct: 0.02, maxDailyLossPct: 0.02 },
      },
      monitorHealth: { mode: 'shadow', killSwitch: false, healthCode: null, healthError: null, lastRestReconciliationAt: '2026-09-17T14:00:00.000Z' },
    },
    isLoading: false,
    isError: false,
  }),
  useAlpacaDayTradingPlans: () => ({ data: [], isLoading: false, isError: false }),
  useAlpacaDayTradingPlanDetail: () => ({ data: undefined, isLoading: false, isError: false }),
  useAlpacaDayTradingJournal: () => ({
    data: { closed_trade_count: 0, win_rate_pct: null, expectancy: null, profit_factor: null, average_r: null, total_pnl: 0, by_setup: {} },
    isLoading: false,
    isError: false,
  }),
  useSetAlpacaDayTradingMode: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, isSuccess: false }),
  useClearAlpacaDayTradingKillSwitch: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, isSuccess: false }),
}))

describe('AlpacaPaperPage', () => {
  it('discloses paper-only bracket-order restrictions and shows Day Trading dashboard panels', () => {
    render(<AlpacaPaperPage />)

    expect(screen.getByRole('heading', { name: 'Alpaca Day Trading' })).toBeInTheDocument()
    expect(screen.getByText(/Paper account — no real money/i)).toBeInTheDocument()
    expect(screen.getByText(/Long-only US equity bracket orders/i)).toBeInTheDocument()
    expect(screen.getByText(/Paper connection verified/i)).toBeInTheDocument()

    expect(screen.getByRole('heading', { name: 'Monitor health' })).toBeInTheDocument()
    expect(screen.getAllByText('shadow').length).toBeGreaterThan(0)

    expect(screen.getByRole('heading', { name: 'Account & risk' })).toBeInTheDocument()
    expect(screen.getByText(/Unavailable/i)).toBeInTheDocument()

    expect(screen.getByRole('heading', { name: /Broker positions/ })).toBeInTheDocument()
    expect(screen.getByText(/No open Alpaca positions/i)).toBeInTheDocument()

    expect(screen.getByRole('heading', { name: /Plans/ })).toBeInTheDocument()
    expect(screen.getByText(/No plans match this filter/i)).toBeInTheDocument()

    expect(screen.getByRole('heading', { name: 'Day Trading journal' })).toBeInTheDocument()
  })
})
