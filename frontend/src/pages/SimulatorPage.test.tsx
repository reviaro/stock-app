import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SimulatorPage } from './SimulatorPage'

vi.mock('@/components/simulator/HoldingsPanel', () => ({ HoldingsPanel: () => <div /> }))
vi.mock('@/components/simulator/TradePanel', () => ({ TradePanel: () => <div /> }))
vi.mock('@/components/simulator/TransactionHistory', () => ({ TransactionHistory: () => <div /> }))
vi.mock('@/components/simulator/SimulatorReviewPanel', () => ({ SimulatorReviewPanel: () => <div /> }))
vi.mock('@/hooks/useSimulator', () => ({
  useSimSleeves: () => ({
    data: [
      { id: 1, name: 'Long-Term Investing', slug: 'long-term', tax_bracket: 22 },
      { id: 2, name: 'Day Trading', slug: 'day-trading', tax_bracket: 22 },
    ],
    isLoading: false,
  }),
  useSimAccount: () => ({
    data: { id: 1, cash: 0, total_value: 0, unrealized_pnl: 0, realized_pnl: 0, tax_bracket: 22 },
    isLoading: false,
  }),
  useSimDeposit: () => ({ mutate: vi.fn(), isPending: false }),
  useSetTaxBracket: () => ({ mutate: vi.fn(), isPending: false }),
  useSimReset: () => ({ mutate: vi.fn(), isPending: false }),
}))

describe('SimulatorPage', () => {
  it('discards a pending reset confirmation when switching sleeves', () => {
    render(<SimulatorPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(screen.getByText('Wipe all trades?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Day Trading' }))
    expect(screen.queryByText('Wipe all trades?')).not.toBeInTheDocument()
  })
})
