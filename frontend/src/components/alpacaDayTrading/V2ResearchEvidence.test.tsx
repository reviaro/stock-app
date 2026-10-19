import { beforeEach, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { AlpacaHistoryPreview, AlpacaV2Experiments, AlpacaV2Journal } from '@/types/alpacaDayTrading'
import { V2SetupAnalyticsCard } from './V2SetupAnalyticsCard'
import { V2ExitExperimentsCard } from './V2ExitExperimentsCard'
import { V2HistoryAuditCard } from './V2HistoryAuditCard'

const { state, preview, apply, disableLegacy, create } = vi.hoisted(() => {
  const mutation = () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, isSuccess: false, error: null as Error | null })
  return {
    state: { preview: null as AlpacaHistoryPreview | null, journal: null as AlpacaV2Journal | null, experiments: { experiments: [] } as AlpacaV2Experiments },
    preview: mutation(), apply: mutation(), disableLegacy: mutation(), create: mutation(),
  }
})
vi.mock('@/hooks/useAlpacaDayTradingV2', () => ({
  useV2Journal: () => ({ data: state.journal, isLoading: false, isError: false }),
  useV2Experiments: () => ({ data: state.experiments, isLoading: false, isError: false }),
  useCreateV2Experiment: () => create,
  usePreviewAlpacaHistory: () => ({ ...preview, data: state.preview }),
  useApplyAlpacaHistory: () => apply,
  useDisableLegacyAlpacaMonitor: () => disableLegacy,
}))

function historyFixture(): AlpacaHistoryPreview {
  const counts = { planCount: 1, fillCount: 1, canonicalFillCount: 1, duplicateRows: 0, unlinkedFills: 1 }
  const before = { state: 'closed', entryQty: 0, exitQty: 0, entryPrice: null, exitPrice: null, realizedPnl: null, realizedR: null, openedAt: null, closedAt: null, exitReason: null }
  return {
    reviewToken: 'synthetic-opaque-review', monitorModes: { v1: 'disabled', v2: 'disabled' },
    summary: { v1: counts, v2: { ...counts, planCount: 0 }, broker: { fillCount: 2, complete: true }, repairablePlans: 1, attributionReviewPlans: 1 },
    issues: [{ code: 'ENTRY_BASIS_UNAVAILABLE', severity: 'warning', symbol: 'DEMO', planId: 12, message: 'Never render this raw message or private-client-id' }],
    applyBlockers: [],
    repairs: [{ planId: 12, symbol: 'DEMO', kind: 'restore_closed_history', requiresAttributionReview: true, missingFillCount: 1, linkedFillCount: 1, before, after: { ...before, entryQty: 2, exitQty: 2, entryPrice: 100, exitPrice: 101, realizedPnl: 2, openedAt: '2026-01-02T15:00:00Z', closedAt: '2026-01-02T15:30:00Z' } }],
  }
}

function journalFixture(): AlpacaV2Journal {
  const stats = { count: 1, winRate: 1, realizedPnl: 4, expectancyDollars: 4, expectancyR: 0.8, expectancyActualRiskR: 1.25 }
  return {
    analytics: {
      closedTradeCount: 1, wins: 1, losses: 0, winRate: 1, grossProfit: 4, grossLoss: 0, profitFactor: null, averageWin: 4, averageLoss: null,
      expectancyDollars: 4, expectancyR: 0.8, expectancyActualRiskR: 1.25, realizedPnl: 4, maxConsecutiveLosses: 0, maxClosedTradeDrawdownDollars: 0, averageHoldMinutes: 30,
      bySetup: { range_reclaim: stats }, byStrategyVersion: { 'reclaim-v2': stats }, byExitReason: { time_exit: stats }, byCatalyst: { earnings: stats }, byWindow: { open: stats }, bySessionDate: { '2026-01-02': stats },
      evidence: { classifiedTrades: 1, measuredTrades: 1, totalTrades: 2, sampledObservationCount: 3 },
      noTrade: { count: 0, byReason: {} }, attention: { count: 0, byCode: {} }, excludedOperatorResolved: 0, excludedIncompleteFills: 1,
      sample: { size: 1, preliminary: true, note: 'Preliminary synthetic sample.' },
    },
    trades: [{
      id: 22, symbol: 'DEMO', setup: 'Descriptive setup', setupId: 'range_reclaim', strategyVersion: 'reclaim-v2', catalyst: 'Synthetic event', catalystClass: 'earnings',
      thesis: 'Synthetic thesis', invalidation: 'Synthetic invalidation', plannedQty: 2, plannedEntryPrice: 100, plannedStop: 97.5, plannedTarget: 105, plannedRiskDollars: 5,
      exitDeadline: '2026-01-02T20:00:00Z', state: 'closed', attentionCode: null, filledEntryQty: 2, avgEntryPrice: 100, filledExitQty: 2, avgExitPrice: 102,
      exitReason: null, realizedPnl: 4, realizedR: 0.8, actualInitialRiskDollars: null, actualRiskR: null, fillEvidenceComplete: false, entryEvidence: { private_client_id: 'not-for-rendering' },
      createdAt: '2026-01-02T14:59:00Z', openedAt: '2026-01-02T15:00:00Z', closedAt: '2026-01-02T15:30:00Z',
      observations: { count: 3, mfeDollars: 0, maeDollars: null, firstAt: '2026-01-02T15:00:00Z', lastAt: '2026-01-02T15:10:00Z', complete: false, note: null },
    }],
    events: [],
  }
}

beforeEach(() => {
  state.preview = null
  state.journal = journalFixture()
  state.experiments = { experiments: [] }
  for (const mutation of [preview, apply, disableLegacy, create]) {
    mutation.mutate.mockReset(); mutation.reset.mockReset()
    mutation.isPending = false; mutation.isError = false; mutation.isSuccess = false; mutation.error = null
  }
})

test('analytics separates risk denominators and preserves missing evidence and real zero values', () => {
  const { container } = render(<V2SetupAnalyticsCard />)
  expect(screen.getByText('Expectancy / authorized risk').parentElement).toHaveTextContent('0.80R')
  expect(screen.getByText('Expectancy / fill risk').parentElement).toHaveTextContent('1.25R')
  expect(screen.getByText(/1 of 2 trades classified/)).toHaveTextContent('3 sampled observations')
  expect(screen.getByRole('region', { name: 'By stable setup' })).toHaveTextContent('range_reclaim')
  expect(screen.getByRole('region', { name: 'By strategy version' })).toHaveTextContent('reclaim-v2')
  fireEvent.click(screen.getByText('Closed trade evidence (1)'))
  const evidence = screen.getByRole('region', { name: 'Closed trade evidence' })
  expect(evidence).toHaveTextContent('$0.00 / —')
  expect(evidence).toHaveTextContent('Risk —')
  expect(evidence).toHaveTextContent('Unknown')
  expect(evidence).toHaveTextContent('Incomplete coverage')
  expect(container).not.toHaveTextContent('not-for-rendering')
  expect(container).not.toHaveTextContent('private_client_id')
})

test('history audit never previews or applies automatically', () => {
  render(<V2HistoryAuditCard />)
  expect(preview.mutate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Review history audit' }))
  expect(preview.mutate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Preview history discrepancies' }))
  expect(preview.mutate).toHaveBeenCalledTimes(1)
  expect(apply.mutate).not.toHaveBeenCalled()
})

test('a repair needs selection, separate attribution and exact confirmation; opaque review material stays hidden', () => {
  state.preview = historyFixture()
  const { container } = render(<V2HistoryAuditCard />)
  fireEvent.click(screen.getByRole('button', { name: 'Review history audit' }))
  const button = screen.getByRole('button', { name: 'Apply selected history repairs' })
  const confirm = screen.getByLabelText('Type APPLY_HISTORY_REPAIR to confirm')
  const ownership = screen.getByLabelText('I confirm these fills belong to DEMO v1 plan #12')
  expect(button).toBeDisabled()
  expect(ownership).toBeDisabled()
  fireEvent.click(screen.getByLabelText('Select DEMO v1 plan #12'))
  fireEvent.change(confirm, { target: { value: 'APPLY_HISTORY_REPAIR' } })
  expect(button).toBeDisabled()
  fireEvent.click(ownership)
  expect(confirm).toHaveValue('')
  fireEvent.change(confirm, { target: { value: 'apply_history_repair' } })
  expect(button).toBeDisabled()
  fireEvent.change(confirm, { target: { value: 'APPLY_HISTORY_REPAIR' } })
  fireEvent.click(button)
  expect(apply.mutate.mock.calls[0][0]).toEqual({ reviewToken: 'synthetic-opaque-review', selectedPlanIds: [12], attributionPlanIds: [12], confirm: 'APPLY_HISTORY_REPAIR' })
  expect(container).not.toHaveTextContent('synthetic-opaque-review')
  expect(container).not.toHaveTextContent('Never render')
  expect(container).not.toHaveTextContent('private-client-id')
  expect(screen.getByRole('region', { name: 'DEMO plan 12 proposed changes' })).toHaveTextContent('Unknown')
})

test('refreshing clears reviewed choices and a failed apply locks the old preview', () => {
  state.preview = historyFixture()
  const { rerender } = render(<V2HistoryAuditCard />)
  fireEvent.click(screen.getByRole('button', { name: 'Review history audit' }))
  fireEvent.click(screen.getByLabelText('Select DEMO v1 plan #12'))
  fireEvent.click(screen.getByLabelText('I confirm these fills belong to DEMO v1 plan #12'))
  fireEvent.change(screen.getByLabelText('Type APPLY_HISTORY_REPAIR to confirm'), { target: { value: 'APPLY_HISTORY_REPAIR' } })
  fireEvent.click(screen.getByRole('button', { name: 'Load a new preview' }))
  expect(screen.getByLabelText('Select DEMO v1 plan #12')).not.toBeChecked()
  expect(screen.getByLabelText('Type APPLY_HISTORY_REPAIR to confirm')).toHaveValue('')
  apply.isError = true
  apply.error = Object.assign(new Error('raw broker details'), { code: 'ALPACA_HISTORY_STALE_PREVIEW' })
  rerender(<V2HistoryAuditCard />)
  expect(screen.getByRole('button', { name: 'Apply selected history repairs' })).toBeDisabled()
  expect(screen.getByLabelText('Select DEMO v1 plan #12')).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveTextContent('out of date')
  expect(screen.getByRole('alert')).not.toHaveTextContent('raw broker details')
})

test('blocked history cannot apply and legacy disable requires its own exact confirmation', () => {
  state.preview = historyFixture()
  state.preview.applyBlockers = ['ALPACA_HISTORY_MONITORS_ENABLED']
  state.preview.monitorModes.v1 = 'shadow'
  render(<V2HistoryAuditCard />)
  fireEvent.click(screen.getByRole('button', { name: 'Review history audit' }))
  expect(screen.getByLabelText('Select DEMO v1 plan #12')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Apply selected history repairs' })).toBeDisabled()
  const disable = screen.getByRole('button', { name: 'Disable retired v1 monitor' })
  expect(disable).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Type DISABLE_LEGACY to confirm'), { target: { value: 'disable_legacy' } })
  expect(disable).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Type DISABLE_LEGACY to confirm'), { target: { value: 'DISABLE_LEGACY' } })
  fireEvent.click(disable)
  expect(disableLegacy.mutate).toHaveBeenCalledTimes(1)
  expect(apply.mutate).not.toHaveBeenCalled()
})

test('experiments validate bounded parameters and send only the selected future hypothesis', () => {
  render(<V2ExitExperimentsCard />)
  fireEvent.click(screen.getByText('Define a future experiment'))
  const start = screen.getByRole('button', { name: 'Start shadow experiment' })
  expect(start).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Experiment name'), { target: { value: 'Synthetic ATR hypothesis' } })
  fireEvent.change(screen.getByLabelText('Assumed cost per side (0–100 bps)'), { target: { value: '' } })
  expect(start).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Assumed cost per side (0–100 bps)'), { target: { value: '5' } })
  fireEvent.change(screen.getByLabelText('Exit hypothesis'), { target: { value: 'atr_target' } })
  fireEvent.change(screen.getByLabelText('ATR multiple (0.25–10)'), { target: { value: '0.1' } })
  expect(start).toBeDisabled()
  fireEvent.change(screen.getByLabelText('ATR multiple (0.25–10)'), { target: { value: '1.5' } })
  fireEvent.click(start)
  expect(create.mutate.mock.calls[0][0]).toEqual({ name: 'Synthetic ATR hypothesis', setupId: '*', strategyVersion: '*', durationDays: 30, minTrades: 30, costBps: 5, kind: 'atr_target', parameters: { atrMultiple: 1.5 } })
  expect(screen.getByText(/never changes broker orders or execution mode/)).toBeInTheDocument()
})

test('shadow results show sample coverage, missing estimates, and per-side cost assumptions', () => {
  state.experiments.experiments = [{
    id: 1, name: 'Synthetic stalled progress', setupId: '*', strategyVersion: '*', kind: 'stall_exit', parameters: { afterMinutes: 30, minimumProgressR: 0.25 }, minTrades: 30, costBps: 5, createdAt: '2026-01-02T15:00:00Z', endsAt: '2026-02-01T15:00:00Z',
    results: { status: 'collecting', eligibleCount: 0, excludedCount: 2, triggeredCount: 0, baselineGrossPnl: null, baselineNetPnl: null, shadowGrossPnl: null, shadowNetPnl: null, differenceNetPnl: null, meanDifferenceNetPnl: null, minimumTradesMet: false, exclusions: { incomplete_evidence: 2 } },
  }]
  render(<V2ExitExperimentsCard />)
  expect(screen.getByText('Preliminary sample')).toBeInTheDocument()
  expect(screen.getByText(/Cost assumption: 5 bps per side/)).toBeInTheDocument()
  expect(screen.getByText(/incomplete evidence \(2\)/)).toBeInTheDocument()
  const table = screen.getByRole('region', { name: 'Synthetic stalled progress estimated outcomes' })
  expect(within(table).getAllByRole('cell', { name: '—' })).toHaveLength(4)
  expect(table).not.toHaveTextContent('$0.00')
})
