import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PositionsTable } from './PositionsTable'

vi.mock('@/hooks/useAlpacaDayTrading', () => ({
  useAlpacaDayTradingSnapshot: () => ({
    data: {
      account: { cash: '50000', equity: '100000', buyingPower: '200000', status: 'ACTIVE' },
      clock: { isOpen: true, nextOpen: '', nextClose: '' },
      positions: [
        { symbol: 'NVDA', qty: '10', avgEntryPrice: '100.50', currentPrice: '101', marketValue: '1010', unrealizedPnl: '5', unrealizedPnlPct: '0.005', side: 'long', tracked: true, planId: 7 },
        { symbol: 'AAPL', qty: '3', avgEntryPrice: '200', currentPrice: '195', marketValue: '585', unrealizedPnl: '-15', unrealizedPnlPct: '-0.025', side: 'long', tracked: false, planId: null },
      ],
      activePlans: [],
      risk: { equity: '100000', cashPct: 0.5, totalOpenRiskDollars: 0, totalOpenRiskPct: 0, dailyRealizedPnl: null, dailyLossPct: null, limits: { maxPositionPct: 0.25, minCashPct: 0.1, maxRiskPerTradePct: 0.01, maxTotalOpenRiskPct: 0.02, maxDailyLossPct: 0.02 } },
      monitorHealth: { mode: 'shadow', killSwitch: false, healthCode: null, healthError: null, lastRestReconciliationAt: null },
    },
    isLoading: false,
    isError: false,
  }),
}))

describe('PositionsTable', () => {
  it('flags a position with no matching plan as untracked, distinct from a managed one', () => {
    render(<PositionsTable />)

    expect(screen.getByText('NVDA')).toBeInTheDocument()
    expect(screen.getByText('plan #7')).toBeInTheDocument()

    expect(screen.getByText('AAPL')).toBeInTheDocument()
    expect(screen.getByText('untracked')).toBeInTheDocument()
  })
})
