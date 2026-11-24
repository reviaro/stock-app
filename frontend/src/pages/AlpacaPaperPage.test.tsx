import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { AlpacaPaperPage } from './AlpacaPaperPage'
import type { InvestingOverview } from '@/components/investing/LongTermInvestingWorkspace'

const { hooks } = vi.hoisted(() => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), reset: vi.fn(), isPending: false, isSuccess: false, data: undefined, error: null })
  return { hooks: { overview: { data: undefined as InvestingOverview | undefined, isLoading: false, isFetching: false, error: null, refetch: vi.fn() },
    security: { data: { authenticated: true, mfaConfigured: true, recentMfa: true, recentAuthUntil: new Date(Date.now() + 300000).toISOString() }, error: null, refetch: vi.fn() },
    manualPreview: mutation(), manualExecute: mutation(), policy: mutation(), pause: mutation(), preview: mutation(), execute: mutation(), cancel: mutation(), draft: mutation(), ownership: mutation() } }
})
vi.mock('@/hooks/useAlpacaPaperInvesting', () => ({ useAlpacaPaperInvesting: () => hooks }))
vi.mock('@/components/investing/LegacyPaperArchive', () => ({ LegacyPaperArchive: () => <div>Legacy recovery</div> }))
vi.mock('@/components/investing/PaperPortfolioPanels', () => ({ PaperPortfolioPanels: () => <div>Paper portfolio review</div> }))
const baseline = (): InvestingOverview => ({ configuration: { configured: false, accountBound: false, tradingEnabled: false, environment: 'paper' },
  version: 0, policy: { budget: 0, reservePct: 10, maxPositionPct: 25, maxOrderValue: 500, minTradeValue: 25, driftPct: 2,
    maxSpreadBps: 50, fractional: true, paused: true, executionMode: 'confirm', targets: [] },
  connected: false, blockers: ['Add separate paper credentials on the server.'], positions: [], orders: [], decisions: [] })
describe('Long-term paper workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks(); hooks.manualPreview.mutateAsync.mockReset(); hooks.manualExecute.mutateAsync.mockReset(); hooks.overview.data = baseline()
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
    expect(screen.getByText('Paper portfolio review')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Broker holdings' })).not.toBeInTheDocument()
  })
  it.each(['accepted', 'timeout', 'PAPER_ORDER_UNKNOWN'])('reviews a selected saved target once, then reconciles %s', async outcome => {
    const data = baseline()
    data.connected = data.configuration.tradingEnabled = true
    data.blockers = []; data.policy.paused = false; data.policy.executionMode = 'automatic'
    data.policy.targets = [{ symbol: 'SPY', weightPct: 15 }]; hooks.overview.data = data
    hooks.manualPreview.mutateAsync.mockResolvedValue({ id: 'manual', policyVersion: data.version, blockers: [],
      expiresAt: new Date(Date.now() + 60000).toISOString(), nextOrder: { side: 'buy', symbol: 'SPY', qty: 2, limitPrice: 100, notional: 200 } })
    if (outcome === 'timeout') hooks.manualExecute.mutateAsync.mockRejectedValue(new Error('Timed out'))
    else if (outcome === 'PAPER_ORDER_UNKNOWN') hooks.manualExecute.mutateAsync.mockRejectedValue(Object.assign(new Error('PAPER_PRICE_CHANGED'), { code: outcome }))
    else hooks.manualExecute.mutateAsync.mockResolvedValue({ order: { status: 'accepted', filledQty: 0, planId: 'manual' } })
    const view = render(<AlpacaPaperPage />)
    const select = screen.getByRole('combobox', { name: 'Saved policy target' })
    expect(within(select).getByRole('option', { name: /SPY.*15%/ })).toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'SPY' } })
    const preview = screen.getByRole('button', { name: 'Preview selected buy' }); fireEvent.click(preview)
    expect(hooks.manualPreview.mutateAsync).toHaveBeenCalledWith('SPY')
    const submit = await screen.findByRole('button', { name: 'Submit selected paper buy' })
    expect(screen.getByText(/2 shares.*\$100.00.*\$200.00/)).toBeVisible()
    expect(submit).toBeDisabled(); expect(hooks.manualExecute.mutateAsync).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Type BUY SPY PAPER'), { target: { value: 'BUY SPY PAPER' } })
    fireEvent.click(submit); fireEvent.click(submit)
    expect(hooks.manualExecute.mutateAsync).toHaveBeenCalledExactlyOnceWith({ planId: 'manual', confirmation: 'BUY SPY PAPER' })
    expect(await screen.findByText(outcome !== 'accepted' ? /outcome uncertain/i : /accepted.*filled quantity: 0/i)).toBeVisible()
    expect(submit).toBeDisabled(); expect(preview).toBeDisabled()
    data.orders = [{ id: 'order', planId: 'manual', status: 'filled', symbol: 'SPY', side: 'buy', qty: 2,
      filledQty: 2, filledAvgPrice: 99, limitPrice: 100, decisionKey: null, createdAt: '', updatedAt: '' }]
    view.rerender(<AlpacaPaperPage />)
    expect(screen.getByText(/Broker status: filled.*Filled quantity: 2/)).toBeVisible()
    expect(preview).toBeEnabled(); expect(submit).toBeDisabled()
  })
  it.each(['PAPER_TARGET_CHANGED', 'PAPER_PLAN_EXPIRED', 'PAPER_PRICE_CHANGED'])('requires a new preview and confirmation after %s', async code => {
    const data = baseline(); data.connected = data.configuration.tradingEnabled = true
    data.blockers = []; data.policy.paused = false; data.policy.targets = [{ symbol: 'SPY', weightPct: 15 }]; hooks.overview.data = data
    const plan = { policyVersion: data.version, blockers: [], expiresAt: new Date(Date.now() + 60000).toISOString(),
      nextOrder: { side: 'buy', symbol: 'SPY', qty: 1, limitPrice: 100, notional: 100 } }
    hooks.manualPreview.mutateAsync.mockResolvedValueOnce({ ...plan, id: 'old' }).mockResolvedValueOnce({ ...plan, id: 'fresh' })
    hooks.manualExecute.mutateAsync.mockRejectedValueOnce(Object.assign(new Error('Review changed.'), { code }))
    render(<AlpacaPaperPage />)
    fireEvent.change(screen.getByLabelText('Saved policy target'), { target: { value: 'SPY' } })
    const preview = screen.getByRole('button', { name: 'Preview selected buy' })
    fireEvent.click(preview)
    fireEvent.change(await screen.findByLabelText('Type BUY SPY PAPER'), { target: { value: 'BUY SPY PAPER' } })
    const submitName = { name: 'Submit selected paper buy' }
    fireEvent.click(screen.getByRole('button', submitName))
    expect(await screen.findByText(/Review changed\./)).toBeVisible()
    expect(screen.queryByRole('button', submitName)).not.toBeInTheDocument()
    expect(preview).toBeEnabled(); fireEvent.click(preview)
    expect(await screen.findByLabelText('Type BUY SPY PAPER')).toHaveValue('')
    expect(screen.getByRole('button', submitName)).toBeDisabled()
    expect(hooks.manualExecute.mutateAsync).toHaveBeenCalledExactlyOnceWith({ planId: 'old', confirmation: 'BUY SPY PAPER' })
  })
  it.each(['expired', 'blocked', 'wrong target'])('refuses a %s selected buy plan despite exact confirmation', async reason => {
    const data = baseline(); data.connected = data.configuration.tradingEnabled = true
    data.blockers = []; data.policy.paused = false; data.policy.targets = [{ symbol: 'SPY', weightPct: 15 }]; hooks.overview.data = data
    hooks.manualPreview.mutateAsync.mockResolvedValue({ id: 'manual', policyVersion: data.version,
      blockers: reason === 'blocked' ? ['Spread exceeds policy'] : [], expiresAt: new Date(Date.now() + (reason === 'expired' ? -1 : 60000)).toISOString(),
      nextOrder: { side: 'buy', symbol: reason === 'wrong target' ? 'QQQ' : 'SPY', qty: 1, limitPrice: 100, notional: 100 } })
    render(<AlpacaPaperPage />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Saved policy target' }), { target: { value: 'SPY' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview selected buy' }))
    fireEvent.change(await screen.findByLabelText('Type BUY SPY PAPER'), { target: { value: 'BUY SPY PAPER' } })
    if (reason === 'blocked') expect(screen.getByText('Spread exceeds policy')).toBeVisible()
    if (reason === 'expired') expect(screen.getByText(/— expired/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Submit selected paper buy' })).toBeDisabled()
    expect(hooks.manualExecute.mutateAsync).not.toHaveBeenCalled()
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
  it('shows the agent cap, tags and usage on Paper and saves them', () => {
    hooks.overview.data = { ...baseline(), policy: { ...baseline().policy, budget: 1000, agentPicksMaxPct: 20,
      targets: [{ symbol: 'AAPL', weightPct: 20 }, { symbol: 'QQQ', weightPct: 5, source: 'agent' }] } }
    render(<AlpacaPaperPage />)
    expect(screen.getByLabelText('Agent picks total (%)')).toHaveValue(20)
    expect(screen.getByText('Added by agent')).toBeVisible()
    expect(screen.getByText('Agent picks: 5% of 20%')).toBeVisible()
    fireEvent.change(screen.getByLabelText('Agent picks total (%)'), { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save paper policy' }))
    expect(hooks.policy.mutate).toHaveBeenCalledWith(expect.objectContaining({ policy: expect.objectContaining({ agentPicksMaxPct: 15,
      targets: [{ symbol: 'AAPL', weightPct: 20 }, { symbol: 'QQQ', weightPct: 5, source: 'agent' }] }) }))
  })
  it('defaults a missing agent cap to 0 and hides the usage line without agent picks', () => {
    render(<AlpacaPaperPage />)
    expect(screen.getByLabelText('Agent picks total (%)')).toHaveValue(0)
    expect(screen.queryByText(/Agent picks:/)).not.toBeInTheDocument()
  })
  it('editing an agent row symbol clears its tag', () => {
    hooks.overview.data = { ...baseline(), policy: { ...baseline().policy, budget: 1000, agentPicksMaxPct: 20,
      targets: [{ symbol: 'AAPL', weightPct: 20 }, { symbol: 'QQQ', weightPct: 5, source: 'agent' }] } }
    render(<AlpacaPaperPage />)
    fireEvent.change(screen.getByLabelText('Broker symbol 2'), { target: { value: 'vti' } })
    expect(screen.queryByText('Added by agent')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save paper policy' }))
    expect(hooks.policy.mutate).toHaveBeenCalledWith(expect.objectContaining({ policy: expect.objectContaining({
      targets: [{ symbol: 'AAPL', weightPct: 20 }, { symbol: 'VTI', weightPct: 5 }] }) }))
  })
  it('shows the requested weight on an agent decision card', () => {
    hooks.overview.data = { ...baseline(), decisions: [{ decision_key: 'synthetic-pick', symbol: 'VTI', side: 'buy', reason: 'Synthetic thesis for a new holding.',
      created_at: new Date().toISOString(), status: 'blocked', blockers: [], target_weight_pct: 8 }] }
    render(<AlpacaPaperPage />)
    expect(screen.getByText('Requested target: 8%')).toBeVisible()
  })
  it('explains why resuming stays disabled when the saved policy has no targets', () => {
    hooks.overview.data = { ...baseline(), policy: { ...baseline().policy, budget: 1000, executionMode: 'automatic' } }
    render(<AlpacaPaperPage />)
    expect(screen.queryByText(/Add at least one target weight/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pause new paper orders' }))
    fireEvent.change(screen.getByLabelText('Type ENABLE AUTOMATIC PAPER INVESTING'), { target: { value: 'ENABLE AUTOMATIC PAPER INVESTING' } })
    const save = screen.getByRole('button', { name: 'Save paper policy' })
    expect(save).toBeDisabled()
    expect(save).toHaveAccessibleDescription(/Add at least one target weight/)
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
