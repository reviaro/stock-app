import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PortfolioLabPage } from './PortfolioLabPage'

const analyze = vi.fn()
const recordEvidence = vi.fn()
let daySleeveHoldings: Array<{ symbol: string; currentValue: number | null }> = [
  { symbol: 'NVDA', currentValue: 30000 },
  { symbol: 'AMD', currentValue: 25000 },
  { symbol: 'TSM', currentValue: 20000 },
]

vi.mock('@/hooks/usePortfolioLab', () => ({
  usePortfolioLabAnalysis: () => ({ mutateAsync: analyze, isPending: false }),
}))
vi.mock('@/hooks/useWatchlist', () => ({
  useWatchlist: () => ({ data: [{ symbol: 'AAPL' }, { symbol: 'MSFT' }, { symbol: 'JPM' }, { symbol: 'JNJ' }] }),
}))
vi.mock('@/hooks/useSimulator', () => ({
  useSimAccount: (id: number) => ({ data: { total_value: 100000, cash: id === 2 ? 10000 : 20000 } }),
  useSimHoldings: (id: number) => ({ data: id === 2 ? daySleeveHoldings : [] }),
}))
vi.mock('@/hooks/useStrategyLab', () => ({
  useStrategyExperiments: () => ({ data: [{ id: 1, name: 'Allocation models', hypothesis: 'Test allocations' }] }),
  useStrategyExperiment: (id: number | null) => ({ data: id == null ? undefined : { versions: [{ id: 7, version_number: 1 }] } }),
  useAddStrategyRun: () => ({ mutateAsync: recordEvidence, isPending: false }),
}))

const analysisResult = {
  read_only: true,
  execution_enabled: false,
  symbols: ['NVDA', 'AMD', 'TSM'],
  benchmark_model_id: 'equal_weight',
  warnings: [],
  validation: { method: 'rolling_walk_forward', train_days: 252, test_days: 63, fold_count: 4, fold_lengths_days: [63, 63, 63, 42], includes_partial_final_fold: true, out_of_sample_start: '2024-01-01', out_of_sample_end: '2025-01-01' },
  constraints: { cash_target_pct: 10, max_position_pct: 35, max_sector_pct: 55, transaction_cost_bps: 10 },
  history: { start_date: '2022-01-01', end_date: '2025-01-01', daily_price_rows: 700 },
  sectors: { NVDA: 'Technology', AMD: 'Technology', TSM: 'Technology' },
  generated_at: '2026-08-16',
  engine: { name: 'skfolio', version: '0.20.2' },
  data_quality: { provider: 'yfinance', auto_adjust: true, alignment: 'complete_shared_trading_days', forward_filled_prices: 0, dropped_incomplete_rows: 0 },
  models: [{
    id: 'equal_weight', name: 'Equal weight', status: 'success', cash_weight_pct: 10,
    max_position_pct: 30, concentration_hhi: 0.27, constraint_handling: 'post_optimization_projection',
    target_weights: [{ symbol: 'NVDA', sector: 'Technology', weight_pct: 30 }, { symbol: 'AMD', sector: 'Technology', weight_pct: 30 }, { symbol: 'TSM', sector: 'Technology', weight_pct: 30 }],
    out_of_sample: { total_return_pct: 8, benchmark_return_pct: 8, annualized_return_pct: 7.5, annualized_volatility_pct: 14, max_drawdown_pct: 9, sharpe: 0.54, turnover_pct: 20, transaction_cost_pct: 0.02 },
    current_target_turnover_pct: 15,
    strategy_lab_evidence: { run_type: 'out_of_sample', evidence_domain: 'allocation', start_date: '2024-01-01', end_date: '2025-01-01', trade_count: 0, total_return_pct: 8, benchmark_return_pct: 8, max_drawdown_pct: 9, sharpe: 0.54, notes: 'Portfolio Lab Equal weight' },
  }],
}

describe('PortfolioLabPage', () => {
  it('runs an advisory allocation comparison and records only Strategy Lab evidence', async () => {
    analyze.mockResolvedValueOnce(analysisResult)
    recordEvidence.mockResolvedValueOnce({ id: 99 })
    render(<PortfolioLabPage />)

    expect(screen.getByRole('heading', { name: 'Portfolio Lab' })).toBeInTheDocument()
    expect(screen.getByText(/read-only allocation research/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /trade|order|execute/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load Day Trading sleeve' }))
    expect(screen.getByLabelText('Selected symbols')).toHaveValue('NVDA, AMD, TSM')
    fireEvent.click(screen.getByRole('button', { name: 'Run Portfolio Lab' }))

    await waitFor(() => expect(analyze).toHaveBeenCalled())
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({
      symbols: ['NVDA', 'AMD', 'TSM'], cash_target_pct: 10, max_position_pct: 35,
    }))
    expect(await screen.findByText('Equal weight')).toBeInTheDocument()
    expect(screen.getByText('4 rolling folds')).toBeInTheDocument()

    const evidenceButton = screen.getByRole('button', { name: 'Record selected result as evidence' })
    expect(evidenceButton).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Evidence experiment'), { target: { value: '1' } })
    fireEvent.click(evidenceButton)
    await waitFor(() => expect(recordEvidence).toHaveBeenCalledWith(analysisResult.models[0].strategy_lab_evidence))
    expect(screen.getByText(/evidence recorded/i)).toBeInTheDocument()
  })

  it('refuses to turn unavailable sleeve prices into zero weights', () => {
    daySleeveHoldings = [
      { symbol: 'NVDA', currentValue: null },
      { symbol: 'AMD', currentValue: 25000 },
      { symbol: 'TSM', currentValue: 20000 },
    ]
    render(<PortfolioLabPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Load Day Trading sleeve' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/current values are unavailable/i)
    expect(screen.getByLabelText('Selected symbols')).toHaveValue('AAPL, MSFT, JPM, JNJ')
    daySleeveHoldings = [
      { symbol: 'NVDA', currentValue: 30000 },
      { symbol: 'AMD', currentValue: 25000 },
      { symbol: 'TSM', currentValue: 20000 },
    ]
  })
})
