import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { PortfolioResponse } from '@/types/portfolio'
import { PortfolioPanel } from './PortfolioPanel'

const state = vi.hoisted(() => ({ data: undefined as PortfolioResponse | undefined }))
vi.mock('@/hooks/usePortfolio', () => ({ usePortfolio: () => ({ data: state.data, isLoading: false, isError: false }) }))
vi.mock('@/hooks/useMemo', () => ({ useMemosListQuery: () => ({ data: [] }) }))
vi.mock('@/hooks/useTransactions', () => ({ useDeleteTransaction: () => ({ mutate: vi.fn(), isError: false, isPending: false }) }))
vi.mock('@/components/MemoDrawer', () => ({ MemoDrawer: () => null }))
vi.mock('@/components/RiskRulesDrawer', () => ({ RiskRulesDrawer: () => null }))
vi.mock('@/components/StopLossEditor', () => ({ StopLossEditor: () => null }))
vi.mock('@/components/RecordTransactionForm', () => ({ RecordTransactionForm: () => null }))
afterEach(cleanup)

describe('portfolio valuation availability', () => {
  it('shows missing quotes without inventing portfolio totals or allocation percentages', () => {
    state.data = {
      summary: { cash: 500, cashPct: null, holdingsValue: null, totalValue: null, realizedPnl: 0, unrealizedPnl: null, valuationComplete: false, missingPriceSymbols: ['TEST'] },
      holdings: [{ symbol: 'TEST', name: 'Example holding', shares: 5, avg_cost: 100, total_cost: 500, dividends_received: 0, sector: null, stop_loss: null, currentPrice: null, currentValue: null, pnl: null, pnlPct: null, breaches: [] }],
      recentTransactions: [], riskAssessment: 'incomplete',
    }
    render(<PortfolioPanel />)
    expect(screen.getByRole('status')).toHaveTextContent('Quotes unavailable for TEST')
    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.getByText('P&L unavailable')).toBeInTheDocument()
    expect(screen.getByText(/Cash: \$500.00/)).toBeInTheDocument()
    expect(screen.queryByText(/100.0%/)).not.toBeInTheDocument()
    expect(screen.queryByText(/% of portfolio/)).not.toBeInTheDocument()
    expect(screen.getByText('Quote unavailable')).toBeInTheDocument()
  })

  it('restores complete values when prices return', () => {
    state.data = {
      summary: { cash: 500, cashPct: 50, holdingsValue: 500, totalValue: 1000, realizedPnl: 0, unrealizedPnl: 0, valuationComplete: true, missingPriceSymbols: [] },
      holdings: [], recentTransactions: [], riskAssessment: 'complete',
    }
    render(<PortfolioPanel />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('$1,000.00')).toBeInTheDocument()
    expect(screen.getByText(/Cash: \$500.00 \(50.0%\)/)).toBeInTheDocument()
  })
})
