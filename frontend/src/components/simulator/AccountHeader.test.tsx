import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AccountHeader } from './AccountHeader'

vi.mock('@/hooks/useSimulator', () => ({
  useSimAccount: () => ({
    data: {
      cash: 1000,
      total_value: 10175,
      unrealized_pnl: 100,
      realized_pnl: 50,
      dividend_income: 25,
      tax_bracket: 22,
    },
    isLoading: false,
  }),
  useSimDeposit: () => ({ mutate: vi.fn(), isPending: false }),
  useSetTaxBracket: () => ({ mutate: vi.fn() }),
  useSimReset: () => ({ mutate: vi.fn(), isPending: false }),
}))

test('total P&L includes dividend income', () => {
  render(<AccountHeader accountId={1} />)
  expect(screen.getByText('+$175.00')).toBeInTheDocument()
})
