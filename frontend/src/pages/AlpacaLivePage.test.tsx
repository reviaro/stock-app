import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { AlpacaLivePage } from './AlpacaLivePage'
import type { LiveOverview } from '@/types/alpacaLive'

const { hooks } = vi.hoisted(() => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), reset: vi.fn(), isPending: false, isSuccess: false, data: undefined, error: null })
  return { hooks: { overview: { data: undefined as LiveOverview | undefined, isLoading: false, isFetching: false, error: null, refetch: vi.fn() },
    security: { data: { authenticated: true, mfaConfigured: true, recentMfa: true, recentAuthUntil: new Date(Date.now() + 300000).toISOString() }, error: null, refetch: vi.fn() },
    policy: mutation(), pause: mutation(), preview: mutation(), execute: mutation(), cancel: mutation(), draft: mutation(), ownership: mutation() } }
})
vi.mock('@/hooks/useAlpacaLive', () => ({ useAlpacaLive: () => hooks }))
const baseline = (): LiveOverview => ({ configuration: { configured: false, accountBound: false, tradingEnabled: false, environment: 'live' },
  version: 0, policy: { budget: 0, reservePct: 10, maxPositionPct: 25, maxOrderValue: 500, minTradeValue: 25, driftPct: 2,
    maxSpreadBps: 50, fractional: true, paused: true, executionMode: 'confirm', targets: [] },
  connected: false, blockers: ['Add separate live credentials on the server.'], positions: [], orders: [], decisions: [] })
describe('Long-Term Live workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks(); hooks.overview.data = baseline()
    hooks.security.data = { authenticated: true, mfaConfigured: true, recentMfa: true, recentAuthUntil: new Date(Date.now() + 300000).toISOString() }
    for (const key of ['policy', 'pause', 'preview', 'execute', 'cancel', 'draft', 'ownership'] as const) Object.assign(hooks[key], { isPending: false, isSuccess: false, data: undefined, error: null })
  })
  it('shows disconnected setup and keeps order preview disabled before credentials', () => {
    render(<AlpacaLivePage />)
    expect(screen.getByRole('heading', { name: 'Long-Term Investing' })).toBeVisible()
    expect(screen.getByText('Live account not connected')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Build fresh preview' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Pause new live orders' })).toBeChecked()
    expect(screen.queryByLabelText(/secret/i)).not.toBeInTheDocument()
  })
  it('makes automatic mode a deliberate policy choice with exact activation confirmation', () => {
    hooks.overview.data = { ...baseline(), policy: { ...baseline().policy, budget: 1000, targets: [{ symbol: 'AAPL', weightPct: 20 }] } }
    render(<AlpacaLivePage />)
    fireEvent.click(screen.getByRole('radio', { name: /Automatic execution/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pause new live orders' }))
    expect(screen.getByRole('button', { name: 'Save live policy' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type ENABLE AUTOMATIC LIVE INVESTING'), { target: { value: 'ENABLE LIVE INVESTING' } })
    expect(screen.getByRole('button', { name: 'Save live policy' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type ENABLE AUTOMATIC LIVE INVESTING'), { target: { value: 'ENABLE AUTOMATIC LIVE INVESTING' } })
    expect(screen.getByRole('button', { name: 'Save live policy' })).toBeEnabled()
    expect(hooks.policy.mutate).not.toHaveBeenCalled()
  })
  it('requires the exact live-order phrase before submitting the immutable preview ID', () => {
    hooks.overview.data = { ...baseline(), connected: true }
    Object.assign(hooks.preview, { data: { id: 'synthetic-plan', expiresAt: new Date(Date.now() + 60000).toISOString(), blockers: [], rows: [],
      managedValue: 0, spendableCash: 1000, unmanagedValue: 0, nextOrder: { side: 'buy', symbol: 'AAPL', qty: 1, limitPrice: 100, notional: 100 } } })
    render(<AlpacaLivePage />)
    const submit = screen.getByRole('button', { name: 'Submit live limit order' })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type BUY AAPL LIVE'), { target: { value: 'BUY AAPL' } })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type BUY AAPL LIVE'), { target: { value: 'BUY AAPL LIVE' } })
    fireEvent.click(submit)
    expect(hooks.execute.mutate).toHaveBeenCalledWith({ planId: 'synthetic-plan', confirmation: 'BUY AAPL LIVE' })
  })
  it('does not submit an expired preview or an already-recorded decision', () => {
    hooks.overview.data = { ...baseline(), connected: true }
    Object.assign(hooks.preview, { data: { id: 'expired-plan', expiresAt: new Date(Date.now() - 1).toISOString(), blockers: [], rows: [],
      managedValue: 0, spendableCash: 1000, unmanagedValue: 0, nextOrder: { side: 'buy', symbol: 'AAPL', qty: 1, limitPrice: 100, notional: 100 } } })
    render(<AlpacaLivePage />)
    fireEvent.change(screen.getByLabelText('Type BUY AAPL LIVE'), { target: { value: 'BUY AAPL LIVE' } })
    expect(screen.getByRole('button', { name: 'Submit live limit order' })).toBeDisabled()
    expect(screen.getByText('Preview expired. Build a fresh preview before confirming.')).toBeVisible()
  })
  it('imports simulator symbols as an editable draft without saving or substituting a fund', async () => {
    hooks.draft.mutateAsync.mockResolvedValue({ targets: [{ symbol: 'FXAIX', weightPct: 20 }], note: 'Review this draft.' })
    render(<AlpacaLivePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Import Long-Term simulator draft' }))
    expect(await screen.findByDisplayValue('FXAIX')).toBeVisible()
    fireEvent.change(screen.getByLabelText('Broker symbol 1'), { target: { value: 'SPY' } })
    expect(screen.getByDisplayValue('SPY')).toBeVisible()
    expect(hooks.policy.mutate).not.toHaveBeenCalled()
    expect(hooks.execute.mutate).not.toHaveBeenCalled()
  })
  it('keeps saved ownership reviews disabled while orders are unpaused', () => {
    hooks.overview.data = { ...baseline(), connected: true, policy: { ...baseline().policy, paused: false }, positions: [{ symbol: 'AAPL', qty: 2, price: 100, value: 200, managedQty: 0, unrealizedPnl: 0 }] }
    render(<AlpacaLivePage />)
    const details = screen.getByText('Review ownership of existing holdings or corporate-action changes').closest('details')!
    details.open = true
    fireEvent.change(within(details).getByLabelText('Symbol to review'), { target: { value: 'AAPL' } })
    fireEvent.change(within(details).getByLabelText('Reason for ownership review'), { target: { value: 'Explicit review of existing holdings.' } })
    fireEvent.change(within(details).getByLabelText('Type MANAGE AAPL 2 LIVE'), { target: { value: 'MANAGE AAPL 2 LIVE' } })
    expect(within(details).getByRole('button', { name: 'Confirm reviewed ownership' })).toBeDisabled()
    expect(hooks.ownership.mutate).not.toHaveBeenCalled()
  })
  it('shows strategy-agent analysis and requires a fresh preview before an order can be approved', () => {
    hooks.overview.data = { ...baseline(), connected: true, decisions: [{ decision_key: 'synthetic-decision', symbol: 'AAPL', side: 'buy', reason: 'Synthetic approved strategy analysis.', created_at: new Date().toISOString() }] }
    render(<AlpacaLivePage />)
    expect(screen.getByText('Synthetic approved strategy analysis.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Review current order' }))
    expect(hooks.preview.mutate).toHaveBeenCalledWith({ decisionKey: 'synthetic-decision' })
    expect(hooks.execute.mutate).not.toHaveBeenCalled()
  })
  it('shows automatic spread refusals as blocked without asking for approval', () => {
    hooks.overview.data = { ...baseline(), connected: true, policy: { ...baseline().policy, executionMode: 'automatic' },
      decisions: [{ decision_key: 'blocked-adbe', symbol: 'ADBE', side: 'buy', reason: 'A long-term investment thesis.', created_at: new Date().toISOString(),
        status: 'blocked', blockers: ['ADBE: spread exceeds the approved limit.'] }] }
    render(<AlpacaLivePage />)
    expect(screen.getByText('Blocked')).toBeVisible()
    expect(screen.getByText('ADBE: spread exceeds the approved limit.')).toBeVisible()
    expect(screen.queryByText('Awaiting approval')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check current blockers' }))
    expect(hooks.preview.mutate).toHaveBeenCalledWith({ decisionKey: 'blocked-adbe' })
    expect(hooks.execute.mutate).not.toHaveBeenCalled()
  })
  it('shows a policy mismatch as needing fresh analysis and disables stale review', () => {
    hooks.overview.data = { ...baseline(), connected: true, decisions: [{ decision_key: 'stale-policy', symbol: 'ADBE', side: 'buy', reason: 'An older recommendation.',
      created_at: new Date().toISOString(), status: 'needs_reanalysis', blockers: ['This decision used policy 1; the current policy is 2.'] }] }
    render(<AlpacaLivePage />)
    expect(screen.getByText('Needs fresh analysis')).toBeVisible()
    expect(screen.getByText('This decision used policy 1; the current policy is 2.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review current order' })).toBeDisabled()
  })
  it('allows approval of a current recommendation after its quote preview expires', () => {
    hooks.overview.data = { ...baseline(), connected: true }
    Object.assign(hooks.preview, { data: { id: 'reviewed-plan', decisionKey: 'recommendation', expiresAt: new Date(Date.now() - 3600000).toISOString(),
      reviewExpiresAt: new Date(Date.now() + 3600000).toISOString(), blockers: [], rows: [], managedValue: 0, spendableCash: 1000, unmanagedValue: 0,
      nextOrder: { side: 'buy', symbol: 'ADBE', qty: 1, limitPrice: 250, notional: 250 } } })
    render(<AlpacaLivePage />)
    expect(screen.getByText(/Approval will refresh the checks/)).toBeVisible()
    const submit = screen.getByRole('button', { name: 'Approve & submit live order' })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type BUY ADBE LIVE'), { target: { value: 'BUY ADBE LIVE' } })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    expect(hooks.execute.mutate).toHaveBeenCalledWith({ planId: 'reviewed-plan', confirmation: 'BUY ADBE LIVE' })
  })
  it('keeps approval disabled after the recommendation review deadline', () => {
    hooks.overview.data = { ...baseline(), connected: true }
    Object.assign(hooks.preview, { data: { id: 'expired-recommendation', decisionKey: 'old-recommendation', expiresAt: new Date(Date.now() - 3600000).toISOString(),
      reviewExpiresAt: new Date(Date.now() - 1000).toISOString(), blockers: [], rows: [], managedValue: 0, spendableCash: 1000, unmanagedValue: 0,
      nextOrder: { side: 'buy', symbol: 'ADBE', qty: 1, limitPrice: 250, notional: 250 } } })
    render(<AlpacaLivePage />)
    fireEvent.change(screen.getByLabelText('Type BUY ADBE LIVE'), { target: { value: 'BUY ADBE LIVE' } })
    expect(screen.getByRole('button', { name: 'Approve & submit live order' })).toBeDisabled()
  })
  it('blocks policy and order authority after verification expires while retaining immediate pause', () => {
    hooks.security.data = { authenticated: true, mfaConfigured: true, recentMfa: false, recentAuthUntil: new Date(Date.now() - 1).toISOString() }
    hooks.overview.data = { ...baseline(), policy: { ...baseline().policy, paused: false } }
    render(<AlpacaLivePage />)
    expect(screen.getByRole('button', { name: 'Save live policy' })).toBeDisabled()
    expect(screen.getByLabelText('Verify password')).toBeVisible()
    const pause = screen.getByRole('button', { name: 'Pause new orders now' })
    expect(pause).toBeEnabled()
    fireEvent.click(pause)
    expect(hooks.pause.mutate).toHaveBeenCalledWith(0)
    expect(hooks.policy.mutate).not.toHaveBeenCalled()
  })
  it('requires authenticator setup before exposing privileged live controls', () => {
    hooks.security.data = { authenticated: true, mfaConfigured: false, recentMfa: false, recentAuthUntil: '' }
    render(<AlpacaLivePage />)
    expect(screen.getByText('Set up an authenticator on the server before authorizing live actions.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save live policy' })).toBeDisabled()
  })
})
