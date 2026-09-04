import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReinvestmentPanel } from './ReinvestmentPanel'

const updateSettings = vi.fn()
const recordDividend = vi.fn()

vi.mock('@/hooks/useSimulator', () => ({
  useSimAccount: () => ({
    data: {
      dividend_reinvestment_mode: 'drip',
      profit_reinvestment_mode: 'redeploy_excess',
      target_cash_pct: 10,
      dividend_income: 125,
      reinvested_dividends: 100,
      redeployable_cash: 450,
    },
    isLoading: false,
  }),
  useSetSimReinvestmentSettings: () => ({ mutateAsync: updateSettings, isPending: false, isError: false }),
  useRecordSimDividend: () => ({ mutateAsync: recordDividend, isPending: false, isError: false }),
}))

describe('ReinvestmentPanel', () => {
  beforeEach(() => {
    updateSettings.mockReset()
    recordDividend.mockReset()
  })

  it('shows compounding totals and saves per-sleeve settings', async () => {
    render(<ReinvestmentPanel accountId={1} />)

    expect(screen.getByText('Compounding')).toBeInTheDocument()
    expect(screen.getByText('$125.00')).toBeInTheDocument()
    expect(screen.getByText('$100.00')).toBeInTheDocument()
    expect(screen.getByText('$450.00')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Dividend treatment'), { target: { value: 'cash' } })
    fireEvent.change(screen.getByLabelText('Realized-profit treatment'), { target: { value: 'hold_cash' } })
    fireEvent.change(screen.getByLabelText('Target cash percent'), { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save compounding settings' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      dividend_reinvestment_mode: 'cash',
      profit_reinvestment_mode: 'hold_cash',
      target_cash_pct: 15,
    }))
  })

  it('records a dividend with a deterministic manual reference', async () => {
    render(<ReinvestmentPanel accountId={1} />)

    fireEvent.click(screen.getByRole('button', { name: 'Record dividend' }))
    fireEvent.change(screen.getByLabelText('Dividend symbol'), { target: { value: 'pep' } })
    fireEvent.change(screen.getByLabelText('Total dividend amount'), { target: { value: '25.50' } })
    fireEvent.change(screen.getByLabelText('Dividend payment date'), { target: { value: '2026-09-04' } })
    fireEvent.change(screen.getByLabelText('DRIP execution price'), { target: { value: '200' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply dividend' }))

    await waitFor(() => expect(recordDividend).toHaveBeenCalledWith({
      symbol: 'PEP',
      amount: 25.5,
      price: 200,
      txn_date: '2026-09-04',
      idempotency_key: 'manual:PEP:2026-09-04:25.50',
    }))
  })
})
