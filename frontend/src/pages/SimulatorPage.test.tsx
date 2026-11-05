import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SimulatorPage } from './SimulatorPage'

vi.mock('@/components/simulator/HoldingsPanel', () => ({ HoldingsPanel: ({ accountId }: { accountId: number }) => <div>Holdings account {accountId}</div> }))
vi.mock('@/components/simulator/TradePanel', () => ({ TradePanel: ({ accountId }: { accountId: number }) => <div>Trade account {accountId}</div> }))
vi.mock('@/components/simulator/TransactionHistory', () => ({ TransactionHistory: () => <div /> }))
vi.mock('@/components/simulator/SimulatorReviewPanel', () => ({ SimulatorReviewPanel: () => <div /> }))
vi.mock('@/components/simulator/ReinvestmentPanel', () => ({ ReinvestmentPanel: () => <div>Compounding Loaded</div> }))
vi.mock('@/pages/AlpacaPaperPage', () => ({ AlpacaPaperPage: () => <div>Alpaca long-term allocation</div> }))
vi.mock('@/hooks/useSimulator', () => ({
  useSimAccount: () => ({
    data: { id: 1, cash: 0, total_value: 0, unrealized_pnl: 0, realized_pnl: 0, tax_bracket: 22 },
    isLoading: false,
  }),
  useSimDeposit: () => ({ mutate: vi.fn(), isPending: false }),
  useSetTaxBracket: () => ({ mutate: vi.fn(), isPending: false }),
  useSimReset: () => ({ mutate: vi.fn(), isPending: false }),
}))

describe('SimulatorPage', () => {
  it('keeps local trading in long-term account 1 and removes the Day Trading tab', () => {
    render(<SimulatorPage />)
    expect(screen.getByText('Long-Term Investing')).toBeInTheDocument()
    expect(screen.getByText('Holdings account 1')).toBeInTheDocument()
    expect(screen.getByText('Trade account 1')).toBeInTheDocument()
    expect(screen.getByText('Compounding Loaded')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Day Trading' })).not.toBeInTheDocument()
    expect(screen.queryByText('Alpaca long-term allocation')).not.toBeInTheDocument()
  })

  it('opens Alpaca long-term allocation inside the same workspace and discards local reset confirmation', () => {
    render(<SimulatorPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(screen.getByText('Wipe all trades?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Alpaca paper' }))
    expect(screen.getByText('Alpaca long-term allocation')).toBeInTheDocument()
    expect(screen.queryByText('Holdings account 1')).not.toBeInTheDocument()
    expect(screen.queryByText('Wipe all trades?')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Local simulator' }))
    expect(screen.getByText('Holdings account 1')).toBeInTheDocument()
    expect(screen.queryByText('Wipe all trades?')).not.toBeInTheDocument()
  })
})
