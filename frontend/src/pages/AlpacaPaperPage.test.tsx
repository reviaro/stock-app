import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { AlpacaPaperPage } from './AlpacaPaperPage'
import type { InvestingOverview } from '@/components/investing/LongTermInvestingWorkspace'

const { hooks } = vi.hoisted(() => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), reset: vi.fn(), isPending: false, isSuccess: false, data: undefined, error: null })
  return { hooks: { overview: { data: undefined as InvestingOverview | undefined, isLoading: false, isFetching: false, error: null, refetch: vi.fn() },
    security: { data: { authenticated: true, mfaConfigured: true, recentMfa: true, recentAuthUntil: new Date(Date.now() + 300000).toISOString() }, error: null, refetch: vi.fn() },
    policy: mutation(), pause: mutation(), preview: mutation(), execute: mutation(), cancel: mutation(), draft: mutation(), ownership: mutation() } }
})
vi.mock('@/hooks/useAlpacaPaperInvesting', () => ({ useAlpacaPaperInvesting: () => hooks }))
vi.mock('@/components/investing/LegacyPaperArchive', () => ({ LegacyPaperArchive: () => <div>Legacy recovery</div> }))
const baseline = (): InvestingOverview => ({ configuration: { configured: false, accountBound: false, tradingEnabled: false, environment: 'paper' },
  version: 0, policy: { budget: 0, reservePct: 10, maxPositionPct: 25, maxOrderValue: 500, minTradeValue: 25, driftPct: 2,
    maxSpreadBps: 50, fractional: true, paused: true, executionMode: 'confirm', targets: [] },
  connected: false, blockers: ['Add separate paper credentials on the server.'], positions: [], orders: [], decisions: [] })
describe('Long-term paper workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks(); hooks.overview.data = baseline()
    hooks.security.data = { authenticated: true, mfaConfigured: true, recentMfa: true, recentAuthUntil: new Date(Date.now() + 300000).toISOString() }
    for (const key of ['policy', 'pause', 'preview', 'execute', 'cancel', 'draft', 'ownership'] as const) Object.assign(hooks[key], { isPending: false, isSuccess: false, data: undefined, error: null })
  })
  it('shows disconnected setup and keeps order preview disabled before credentials', () => {
    render(<AlpacaPaperPage />)
    expect(screen.getByRole('heading', { name: 'Alpaca long-term investing' })).toBeVisible()
    expect(screen.getByText('Paper account not connected')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Build fresh preview' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Pause new paper orders' })).toBeChecked()
    expect(screen.queryByLabelText(/secret/i)).not.toBeInTheDocument()
  })
  it('makes automatic mode a deliberate policy choice with exact activation confirmation', () => {
    hooks.overview.data = { ...baseline(), policy: { ...baseline().policy, budget: 1000, targets: [{ symbol: 'AAPL', weightPct: 20 }] } }
    render(<AlpacaPaperPage />)
    fireEvent.click(screen.getByRole('radio', { name: /Automatic execution/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pause new paper orders' }))
    expect(screen.getByRole('button', { name: 'Save paper policy' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type ENABLE AUTOMATIC PAPER INVESTING'), { target: { value: 'ENABLE PAPER INVESTING' } })
    expect(screen.getByRole('button', { name: 'Save paper policy' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type ENABLE AUTOMATIC PAPER INVESTING'), { target: { value: 'ENABLE AUTOMATIC PAPER INVESTING' } })
    expect(screen.getByRole('button', { name: 'Save paper policy' })).toBeEnabled()
    expect(hooks.policy.mutate).not.toHaveBeenCalled()
  })
  it('requires the exact paper-order phrase before submitting the immutable preview ID', () => {
    hooks.overview.data = { ...baseline(), connected: true }
    Object.assign(hooks.preview, { data: { id: 'synthetic-plan', expiresAt: new Date(Date.now() + 60000).toISOString(), blockers: [], rows: [],
      managedValue: 0, spendableCash: 1000, unmanagedValue: 0, nextOrder: { side: 'buy', symbol: 'AAPL', qty: 1, limitPrice: 100, notional: 100 } } })
    render(<AlpacaPaperPage />)
    const submit = screen.getByRole('button', { name: 'Submit paper limit order' })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type BUY AAPL PAPER'), { target: { value: 'BUY AAPL' } })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type BUY AAPL PAPER'), { target: { value: 'BUY AAPL PAPER' } })
    fireEvent.click(submit)
    expect(hooks.execute.mutate).toHaveBeenCalledWith({ planId: 'synthetic-plan', confirmation: 'BUY AAPL PAPER' })
  })
  it('does not submit an expired preview or an already-recorded decision', () => {
    hooks.overview.data = { ...baseline(), connected: true }
    Object.assign(hooks.preview, { data: { id: 'expired-plan', expiresAt: new Date(Date.now() - 1).toISOString(), blockers: [], rows: [],
      managedValue: 0, spendableCash: 1000, unmanagedValue: 0, nextOrder: { side: 'buy', symbol: 'AAPL', qty: 1, limitPrice: 100, notional: 100 } } })
    render(<AlpacaPaperPage />)
    fireEvent.change(screen.getByLabelText('Type BUY AAPL PAPER'), { target: { value: 'BUY AAPL PAPER' } })
    expect(screen.getByRole('button', { name: 'Submit paper limit order' })).toBeDisabled()
    expect(screen.getByText('Preview expired. Build a fresh preview before confirming.')).toBeVisible()
  })
  it('imports simulator symbols as an editable draft without saving or substituting a fund', async () => {
    hooks.draft.mutateAsync.mockResolvedValue({ targets: [{ symbol: 'FXAIX', weightPct: 20 }], note: 'Review this draft.' })
    render(<AlpacaPaperPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Import Long-Term simulator draft' }))
    expect(await screen.findByDisplayValue('FXAIX')).toBeVisible()
    fireEvent.change(screen.getByLabelText('Broker symbol 1'), { target: { value: 'SPY' } })
    expect(screen.getByDisplayValue('SPY')).toBeVisible()
    expect(hooks.policy.mutate).not.toHaveBeenCalled()
    expect(hooks.execute.mutate).not.toHaveBeenCalled()
  })
  it('keeps saved ownership reviews disabled while orders are unpaused', () => {
    hooks.overview.data = { ...baseline(), connected: true, policy: { ...baseline().policy, paused: false }, positions: [{ symbol: 'AAPL', qty: 2, price: 100, value: 200, managedQty: 0, unrealizedPnl: 0 }] }
    render(<AlpacaPaperPage />)
    const details = screen.getByText('Review ownership of existing holdings or corporate-action changes').closest('details')!
    details.open = true
    fireEvent.change(within(details).getByLabelText('Symbol to review'), { target: { value: 'AAPL' } })
    fireEvent.change(within(details).getByLabelText('Reason for ownership review'), { target: { value: 'Explicit review of existing holdings.' } })
    fireEvent.change(within(details).getByLabelText('Type MANAGE AAPL 2 PAPER'), { target: { value: 'MANAGE AAPL 2 PAPER' } })
    expect(within(details).getByRole('button', { name: 'Confirm reviewed ownership' })).toBeDisabled()
    expect(hooks.ownership.mutate).not.toHaveBeenCalled()
  })
  it('shows strategy-agent analysis and requires a fresh preview before an order can be approved', () => {
    hooks.overview.data = { ...baseline(), connected: true, decisions: [{ decision_key: 'synthetic-decision', symbol: 'AAPL', side: 'buy', reason: 'Synthetic approved strategy analysis.', created_at: new Date().toISOString() }] }
    render(<AlpacaPaperPage />)
    expect(screen.getByText('Synthetic approved strategy analysis.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Review current order' }))
    expect(hooks.preview.mutate).toHaveBeenCalledWith({ decisionKey: 'synthetic-decision' })
    expect(hooks.execute.mutate).not.toHaveBeenCalled()
  })
  it('keeps paper controls available without live authenticator verification', () => {
    hooks.security.data = { authenticated: false, mfaConfigured: false, recentMfa: false, recentAuthUntil: '' }
    render(<AlpacaPaperPage />)
    expect(screen.getByRole('button', { name: 'Save paper policy' })).toBeEnabled()
    expect(screen.queryByLabelText('Verify password')).not.toBeInTheDocument()
    expect(screen.getByText('Legacy recovery')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Alpaca Day Trading' })).not.toBeInTheDocument()
  })
})
