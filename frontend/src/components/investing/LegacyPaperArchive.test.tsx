import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { LegacyPaperArchive } from './LegacyPaperArchive'
import type { LegacyPaperReconciliation } from '@/hooks/useAlpacaPaperInvesting'

const { disable, status, retire, transfer, reconcile } = vi.hoisted(() => ({
  reconcile: { mutate: vi.fn(), isPending: false, error: null, data: undefined as LegacyPaperReconciliation | undefined },
  transfer: { mutate: vi.fn(), reset: vi.fn(), isPending: false, isSuccess: false, error: null },
  retire: { mutate: vi.fn(), isPending: false, isSuccess: false, error: null },
  disable: { mutate: vi.fn(), isPending: false, isError: false, isSuccess: false, error: null },
  status: vi.fn(() => ({ data: { mode: 'paper_execute', openPlanCount: 2 }, isLoading: false, isError: false })),
}))
vi.mock('@/hooks/useAlpacaPaperInvesting', () => ({ useRetirePaperDayTrading: () => retire, useTransferLegacyPaperHolding: () => transfer, useReconcileLegacyPaperOrders: () => reconcile }))
vi.mock('@/hooks/useAlpacaDayTradingV2', () => ({ useV2Status: status, useSetV2Mode: () => disable }))
vi.mock('@/components/alpacaDayTrading/V2ActivePlansCard', () => ({ V2ActivePlansCard: () => <div>Legacy plan recovery</div> }))
vi.mock('@/components/alpacaDayTrading/V2HistoryAuditCard', () => ({ V2HistoryAuditCard: () => <div>Historical evidence audit</div> }))
vi.mock('@/components/alpacaDayTrading/V2DecisionJournalCard', () => ({ V2DecisionJournalCard: () => <div>Legacy v2 decisions</div> }))
vi.mock('@/components/alpacaDayTrading/DayTradingJournalCard', () => ({ DayTradingJournalCard: () => <div>Legacy v1 decisions</div> }))

beforeEach(() => { vi.clearAllMocks(); reconcile.data = undefined })

test('loads historical recovery only on request and offers disabling but no execution activation', () => {
  render(<LegacyPaperArchive />)
  expect(status).not.toHaveBeenCalled()
  expect(screen.queryByText('Legacy plan recovery')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Show legacy paper history & recovery' }))
  expect(screen.getByText('Legacy plan recovery')).toBeInTheDocument()
  expect(screen.getByText('Historical evidence audit')).toBeInTheDocument()
  expect(screen.getByText('Legacy v1 decisions')).toBeInTheDocument()
  expect(screen.getByText('Legacy v2 decisions')).toBeInTheDocument()
  expect(screen.queryByRole('radio', { name: 'Paper execute' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Disable retired v2 monitor' }))
  expect(disable.mutate).toHaveBeenCalledWith({ mode: 'disabled', confirm: 'disabled' })
  const retirement = screen.getByRole('button', { name: 'Retire day-trading monitors' })
  expect(retirement).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Type RETIRE DAY TRADING'), { target: { value: 'RETIRE DAY TRADING' } })
  fireEvent.click(retirement)
  expect(retire.mutate).toHaveBeenCalledWith('RETIRE DAY TRADING')
})

test('transfers only the displayed broker quantity with exact confirmation and a paused policy', () => {
  const overview = { connected: true, policy: { paused: false }, positions: [{ symbol: 'AAPL', qty: 2 }] } as Parameters<typeof LegacyPaperArchive>[0]['overview']
  const { rerender } = render(<LegacyPaperArchive overview={overview} />)
  fireEvent.click(screen.getByRole('button', { name: 'Show legacy paper history & recovery' }))
  screen.getByText('Transfer settled legacy holdings').closest('details')!.open = true
  fireEvent.change(screen.getByLabelText('Legacy holding to transfer'), { target: { value: 'AAPL' } })
  fireEvent.change(screen.getByLabelText('Reason for long-term transfer'), { target: { value: 'Reviewed long-term investment thesis.' } })
  fireEvent.change(screen.getByLabelText('Type TRANSFER AAPL 2 PAPER'), { target: { value: 'TRANSFER AAPL 2 PAPER' } })
  expect(screen.getByRole('button', { name: 'Transfer reviewed holding' })).toBeDisabled()
  rerender(<LegacyPaperArchive overview={{ ...overview!, policy: { ...overview!.policy, paused: true } }} />)
  fireEvent.change(screen.getByLabelText('Type TRANSFER AAPL 2 PAPER'), { target: { value: 'TRANSFER AAPL 3 PAPER' } })
  expect(screen.getByRole('button', { name: 'Transfer reviewed holding' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Type TRANSFER AAPL 2 PAPER'), { target: { value: 'TRANSFER AAPL 2 PAPER' } })
  fireEvent.click(screen.getByRole('button', { name: 'Transfer reviewed holding' }))
  expect(transfer.mutate).toHaveBeenCalledWith({ symbol: 'AAPL', qty: 2, reason: 'Reviewed long-term investment thesis.', confirmation: 'TRANSFER AAPL 2 PAPER' })
})

test('reconciles retained legacy orders and reports incomplete broker evidence without an order confirmation', () => {
  const { rerender } = render(<LegacyPaperArchive />)
  fireEvent.click(screen.getByRole('button', { name: 'Show legacy paper history & recovery' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile legacy paper orders & plans' }))
  expect(reconcile.mutate).toHaveBeenCalledWith()
  expect(transfer.mutate).not.toHaveBeenCalled()
  reconcile.data = { checked: 3, updated: 1, unchanged: 1, failures: 1 }
  rerender(<LegacyPaperArchive />)
  expect(screen.getByRole('alert')).toHaveTextContent('Checked 3 orders; updated 1, unchanged 1.')
  expect(screen.getByRole('alert')).toHaveTextContent('1 could not be verified. Reconciliation is still required.')
})

test('distinguishes reconciled v1 plans from unchanged order audits and retained transfer history', () => {
  reconcile.data = {
    checked: 0, updated: 0, unchanged: 0, failures: 0,
    plans: { checked: 2, reconciled: 2, closed: 1, cancelled: 1, blocked: 0, skipped: 1, blockers: [] },
  }
  render(<LegacyPaperArchive />)
  fireEvent.click(screen.getByRole('button', { name: 'Show legacy paper history & recovery' }))
  const result = screen.getByRole('status', { name: 'Legacy plan reconciliation' })
  expect(result).toHaveTextContent('Checked 2 legacy v1 plans; reconciled 2 (1 closed, 1 canceled); 0 still blocked.')
  expect(result).toHaveTextContent('Transferred plans retained as history: 1.')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('shows actionable blocked-plan reasons without exposing arbitrary broker response text', () => {
  reconcile.data = {
    checked: 2, updated: 2, unchanged: 0, failures: 0,
    plans: { checked: 3, reconciled: 1, closed: 1, cancelled: 0, blocked: 2, skipped: 0, blockers: [
      { planId: 7, symbol: 'SPY', code: 'LEGACY_POSITION_OPEN', message: 'broker-private-marker' },
      { planId: 8, symbol: 'AAPL', code: 'UNRECOGNIZED_CODE', message: 'broker-private-marker' },
    ] },
  }
  render(<LegacyPaperArchive />)
  fireEvent.click(screen.getByRole('button', { name: 'Show legacy paper history & recovery' }))
  const result = screen.getByRole('alert', { name: 'Legacy plan reconciliation' })
  expect(result).toHaveTextContent('2 still blocked.')
  expect(result).toHaveTextContent('SPY · v1 plan #7: A broker position is still open.')
  expect(result).toHaveTextContent('AAPL · v1 plan #8: Review this legacy plan before retrying reconciliation.')
  expect(screen.queryByText(/broker-private-marker/)).not.toBeInTheDocument()
})
