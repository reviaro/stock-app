import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PlansTable } from './PlansTable'

const plan = {
  id: 11, symbol: 'NVDA', setup: 'opening-range breakout', catalyst: 'earnings beat', thesis: 'holding above prior day high',
  invalidation: 'loss of VWAP', plannedEntryLow: 100.5, plannedEntryHigh: 100.5, plannedStop: 98, plannedTarget: 104,
  plannedQty: 10, plannedRiskDollars: 25, plannedRewardRisk: 1.4, plannedAccountRiskPct: 0.00025, state: 'error',
  filledEntryQty: 999, avgEntryPrice: 100.5, filledExitQty: 0, avgExitPrice: null, exitDeadline: '2026-09-17T19:45:00.000Z',
  exitReason: null, realizedPnl: null, realizedR: null, mfe: null, mae: null, thesisValid: null,
  reviewNotes: 'entry fills (999) exceed the planned quantity (10) for plan 11', strategyVersion: null,
  createdAt: '2026-09-17T13:30:00Z', openedAt: null, closedAt: null,
}

const { planDetail } = vi.hoisted(() => ({
  planDetail: { current: null as unknown },
}))

vi.mock('@/hooks/useAlpacaDayTrading', () => ({
  useAlpacaDayTradingPlans: () => ({ data: [plan], isLoading: false, isError: false }),
  useAlpacaDayTradingPlanDetail: (id: number | null) => ({
    data: id === 11 ? planDetail.current : undefined,
    isLoading: false,
    isError: false,
  }),
}))

describe('PlansTable', () => {
  it('expands a plan row to show detail, labelling review_notes as a system note when the plan errored', () => {
    planDetail.current = { plan, fills: [], liveOrders: null }
    render(<PlansTable />)

    expect(screen.getByText('NVDA')).toBeInTheDocument()
    fireEvent.click(screen.getByText('NVDA'))

    expect(screen.getByText(/System note \(this plan errored\)/)).toBeInTheDocument()
    expect(screen.getByText(/entry fills \(999\) exceed the planned quantity/)).toBeInTheDocument()
  })

  it('shows no live orders for a plan that is not open, without implying a broker problem', () => {
    planDetail.current = { plan, fills: [], liveOrders: null }
    render(<PlansTable />)
    fireEvent.click(screen.getByText('NVDA'))

    expect(screen.getByText(/No live orders/i)).toBeInTheDocument()
    expect(screen.queryByText(/couldn.t reach the broker/i)).not.toBeInTheDocument()
  })

  it('shows a distinct warning, not an empty section, when the broker cannot be reached to confirm live orders', () => {
    planDetail.current = { plan, fills: [], liveOrders: { unavailable: true } }
    render(<PlansTable />)
    fireEvent.click(screen.getByText('NVDA'))

    expect(screen.getByText(/couldn.t reach the broker/i)).toBeInTheDocument()
  })

  it('flags a live stop price that differs from the planned stop, and a stop leg that already filled', () => {
    planDetail.current = {
      plan,
      fills: [],
      liveOrders: {
        unavailable: false,
        entry: { status: 'filled', qty: 10, filledQty: 10, submittedAt: '2026-09-17T13:30:00Z' },
        stopLeg: { status: 'filled', stopPrice: 97, filledQty: 10 },
        targetLeg: { status: 'held', limitPrice: 104, filledQty: 0 },
      },
    }
    render(<PlansTable />)
    fireEvent.click(screen.getByText('NVDA'))

    expect(screen.getByText(/differs from planned/i)).toBeInTheDocument()
    expect(screen.getByText(/FILLED/)).toBeInTheDocument()
  })
})
