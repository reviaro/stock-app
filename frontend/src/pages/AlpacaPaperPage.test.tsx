import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { AlpacaPaperPage } from './AlpacaPaperPage'

const { v2, setMode, clearKill, resolvePlan } = vi.hoisted(() => ({
  v2: {
    status: {
      mode: 'shadow', killSwitch: false, attentionRequired: false, attentionCode: null as string | null,
      lastReconciledAt: '2026-09-23T14:59:00.000Z', lastWebsocketAt: null, sessionDate: '2026-09-23',
      heartbeatFresh: true, openPlanCount: 1, attentionPlanCount: 0,
    },
  },
  setMode: { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, isSuccess: false, error: null as Error | null },
  clearKill: { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, isSuccess: false, error: null as Error | null },
  resolvePlan: { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, isSuccess: false, error: null as Error | null },
}))

vi.mock('@/hooks/useAlpacaPaper', () => ({
  useAlpacaPaperStatus: () => ({
    data: { configured: true, environment: 'paper', baseUrl: 'https://paper-api.alpaca.markets', connection: 'verified', accountStatus: 'ACTIVE', cash: '100000.00', equity: '100000.00' },
    isLoading: false, isError: false,
  }),
}))

vi.mock('@/hooks/useAlpacaDayTradingV2', () => ({
  useV2Status: () => ({ data: v2.status, isLoading: false, isError: false }),
  useV2Snapshot: () => ({
    data: {
      account: { cash: 48995, equity: 100012, status: 'ACTIVE' },
      clock: { isOpen: true, nextOpen: '2026-09-24T13:30:00Z', nextClose: '2026-09-23T20:00:00Z' },
      positions: [{ symbol: 'NVDA', qty: 10, side: 'long', avgEntryPrice: 100.4, currentPrice: 101.6, marketValue: 1016, unrealizedPnl: 12, planId: 7 }],
      openOrders: [{ symbol: 'NVDA', side: 'sell', type: 'stop', qty: 10, filledQty: 0, status: 'new', limitPrice: null, stopPrice: 98, planOwned: true }],
      limits: { maxPositionPct: 0.25, minCashPct: 0.1, maxRiskPerTradePct: 0.01, maxTotalOpenRiskPct: 0.02 },
    },
    isLoading: false, isError: false,
  }),
  useV2Plans: () => ({
    data: [{
      id: 7, symbol: 'NVDA', setup: 'opening-range breakout', catalyst: 'earnings', thesis: 'holds range', invalidation: 'loses VWAP',
      plannedQty: 10, plannedEntryPrice: 100.5, plannedStop: 98, plannedTarget: 104, plannedRiskDollars: 25, exitDeadline: '2026-09-23T19:30:00.000Z',
      state: 'active', attentionCode: null, filledEntryQty: 10, avgEntryPrice: 100.4, filledExitQty: 0, avgExitPrice: null,
      exitReason: null, realizedPnl: null, realizedR: null, createdAt: '2026-09-23T13:40:00.000Z', openedAt: '2026-09-23T13:45:00.000Z', closedAt: null,
    }],
    isLoading: false, isError: false,
  }),
  useV2Journal: () => ({
    data: {
      analytics: {
        closedTradeCount: 3, wins: 1, losses: 2, winRate: 0.3333, grossProfit: 36, grossLoss: 35, profitFactor: 1.0286,
        averageWin: 36, averageLoss: -17.5, expectancyDollars: 0.33, expectancyR: 0.0133, realizedPnl: 1, maxConsecutiveLosses: 2, averageHoldMinutes: 40,
        bySetup: { 'opening-range breakout': { count: 3, winRate: 0.3333, realizedPnl: 1, expectancyDollars: 0.33, expectancyR: 0.0133 } },
        byCatalyst: { earnings: { count: 3, winRate: 0.3333, realizedPnl: 1, expectancyDollars: 0.33, expectancyR: 0.0133 } },
        byWindow: { open: { count: 3, winRate: 0.3333, realizedPnl: 1, expectancyDollars: 0.33, expectancyR: 0.0133 } },
        bySessionDate: { '2026-09-23': { count: 3, winRate: 0.3333, realizedPnl: 1, expectancyDollars: 0.33, expectancyR: 0.0133 } },
        noTrade: { count: 4, byReason: { NO_SETUP: 4 } }, attention: { count: 1, byCode: { CANCEL_TIMEOUT: 1 } }, excludedOperatorResolved: 0,
        sample: { size: 3, preliminary: true, note: 'Preliminary: 3 closed trades is below the 30-trade minimum; these figures are not evidence of profitability.' },
      },
      trades: [],
      events: [
        { planId: null, type: 'decision', action: 'no_trade', outcome: 'skipped', reasonCode: 'NO_SETUP', detail: { symbol: 'AMD', notes: 'no volume' }, occurredAt: '2026-09-23T13:35:00.000Z' },
        { planId: 7, type: 'fill', action: 'entry', outcome: 'buy', reasonCode: null, detail: { symbol: 'NVDA', qty: 10, price: 100.4 }, occurredAt: '2026-09-23T13:45:00.000Z' },
      ],
    },
    isLoading: false, isError: false,
  }),
  useSetV2Mode: () => setMode,
  useClearV2KillSwitch: () => clearKill,
  useResolveV2Plan: () => resolvePlan,
}))

vi.mock('@/hooks/useAlpacaDayTrading', () => ({
  useAlpacaDayTradingJournal: () => ({
    data: {
      analytics: { closed_trade_count: 9, win_rate_pct: 77.7, expectancy: 999, profit_factor: 4.2, average_r: 2.2, total_pnl: 8991, by_setup: {} },
      trades: [], events: [],
    },
    isLoading: false, isError: false,
  }),
}))

beforeEach(() => {
  v2.status = { ...v2.status, mode: 'shadow', killSwitch: false, attentionRequired: false, attentionCode: null }
  for (const m of [setMode, clearKill, resolvePlan]) {
    m.mutate.mockReset(); m.isPending = false; m.isError = false; m.isSuccess = false; m.error = null
  }
})

describe('AlpacaPaperPage (v2 strategy lab)', () => {
  it('keeps the existing page and title, and labels it as the v2 paper strategy lab with monitor state', () => {
    render(<AlpacaPaperPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'Alpaca Day Trading' })).toBeInTheDocument()
    expect(screen.getByText('Paper strategy lab — v2')).toBeInTheDocument()
    const monitor = screen.getByRole('region', { name: 'Monitor status' })
    expect(within(monitor).getByText('Current mode: Shadow')).toBeInTheDocument()
    for (const name of ['Broker snapshot', 'Active plans', 'Current positions', 'Decision journal', 'Setup analytics']) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument()
    }
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an attention-required banner that says entries are blocked', () => {
    v2.status = { ...v2.status, attentionRequired: true, attentionCode: 'CANCEL_TIMEOUT' }
    render(<AlpacaPaperPage />)
    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent(/attention required/i)
    expect(banner).toHaveTextContent(/new entries are blocked/i)
    expect(banner).toHaveTextContent('CANCEL_TIMEOUT')
  })

  it('offers Execution disabled / Shadow / Paper execute, and Paper execute cannot submit without the exact confirmation', () => {
    render(<AlpacaPaperPage />)
    const monitor = screen.getByRole('region', { name: 'Monitor status' })
    for (const label of ['Execution disabled', 'Shadow', 'Paper execute']) {
      expect(within(monitor).getByRole('radio', { name: label })).toBeInTheDocument()
    }
    fireEvent.click(within(monitor).getByRole('radio', { name: 'Paper execute' }))
    const apply = within(monitor).getByRole('button', { name: 'Apply mode' })
    expect(apply).toBeDisabled()
    const confirm = within(monitor).getByLabelText(/type paper_execute to confirm/i)
    fireEvent.change(confirm, { target: { value: 'PAPER_EXECUTE' } })
    expect(apply).toBeDisabled()
    fireEvent.change(confirm, { target: { value: 'paper_execute' } })
    expect(apply).toBeEnabled()
    fireEvent.click(apply)
    expect(setMode.mutate).toHaveBeenCalledTimes(1)
    expect(setMode.mutate.mock.calls[0][0]).toEqual({ mode: 'paper_execute', confirm: 'paper_execute' })
  })

  it('locks every mode control while a mode change is pending', () => {
    setMode.isPending = true
    render(<AlpacaPaperPage />)
    const monitor = screen.getByRole('region', { name: 'Monitor status' })
    for (const radio of within(monitor).getAllByRole('radio')) expect(radio).toBeDisabled()
    expect(within(monitor).getByRole('button', { name: /applying/i })).toBeDisabled()
  })

  it('never shows raw broker identifiers or raw error text, even when a control request fails', () => {
    setMode.isError = true
    setMode.error = Object.assign(new Error('Alpaca paper request failed (503) https://paper-api.alpaca.markets/v2/orders 9f1c2d3e-1111-4222-8333-444455556666'), { code: 'ALPACA_V2_BROKER_UNAVAILABLE' })
    const { container } = render(<AlpacaPaperPage />)
    const text = container.textContent || ''
    expect(text).not.toMatch(/9f1c2d3e|paper-api\.alpaca\.markets\/v2|request failed/)
    expect(screen.getByText(/the broker could not be read/i)).toBeInTheDocument()
  })

  it('keeps v1 history read-only and visibly segregated from v2 results', () => {
    render(<AlpacaPaperPage />)
    const history = screen.getByRole('region', { name: 'Historical v1 (read-only)' })
    const analytics = screen.getByRole('region', { name: 'Setup analytics' })
    expect(within(analytics).queryByText(/8,991/)).not.toBeInTheDocument()
    expect(within(analytics).getByText(/Preliminary/)).toBeInTheDocument()
    expect(within(history).queryAllByRole('button').filter((b) => !/show|hide/i.test(b.textContent || ''))).toHaveLength(0)
    expect(history).toHaveTextContent(/not included in v2/i)
  })

  it('has no token or password inputs anywhere on the page', () => {
    const { container } = render(<AlpacaPaperPage />)
    expect(container.querySelector('input[type="password"]')).toBeNull()
    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument()
  })

  it('requires the exact CLEAR confirmation to clear a latch', () => {
    v2.status = { ...v2.status, killSwitch: true, attentionRequired: true, attentionCode: 'BROKER_UNREADABLE' }
    render(<AlpacaPaperPage />)
    const monitor = screen.getByRole('region', { name: 'Monitor status' })
    const button = within(monitor).getByRole('button', { name: /clear kill switch and attention/i })
    expect(button).toBeDisabled()
    fireEvent.change(within(monitor).getByLabelText(/type CLEAR to confirm/i), { target: { value: 'clear' } })
    expect(button).toBeDisabled()
    fireEvent.change(within(monitor).getByLabelText(/type CLEAR to confirm/i), { target: { value: 'CLEAR' } })
    fireEvent.click(button)
    expect(clearKill.mutate).toHaveBeenCalledTimes(1)
  })
})
