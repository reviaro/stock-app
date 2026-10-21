import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrategyLabPage } from './StrategyLabPage'

vi.mock('@/hooks/useStrategyLab', () => ({
  useStrategyExperiments: () => ({ data: [{ id: 1, name: 'Quality at a fair price', hypothesis: 'High-ROIC firms outperform after valuation control.' }], isLoading: false }),
  useStrategyExperiment: () => ({
    data: {
      id: 1,
      name: 'Quality at a fair price',
      hypothesis: 'High-ROIC firms outperform after valuation control.',
      versions: [{ id: 7, experiment_id: 1, version_number: 1, rules: { entry: { roic_gte: 15 } }, notes: null, runs: [], promotion_readiness: { paper: { ready: false, blockers: ['missing_backtest_evidence', 'missing_out_of_sample_evidence'] }, live: { ready: false, blockers: ['missing_backtest_evidence', 'missing_out_of_sample_evidence', 'missing_paper_evidence'] } } }],
      promotion_readiness: { paper: { ready: false, blockers: ['missing_backtest_evidence', 'missing_out_of_sample_evidence'] }, live: { ready: false, blockers: ['missing_backtest_evidence', 'missing_out_of_sample_evidence', 'missing_paper_evidence'] } },
    },
    isLoading: false,
  }),
  useCreateStrategyExperiment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddStrategyVersion: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddStrategyRun: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

describe('StrategyLabPage', () => {
  it('shows versioned hypotheses, deterministic evidence gates, and no live execution controls', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok:true,json:async()=>({status:'success',data:[]})}))
    render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><StrategyLabPage /></QueryClientProvider>)
    expect(screen.getByRole('heading', { name: 'Strategy Research Lab' })).toBeInTheDocument()
    expect(screen.getByText(/manual evidence is a research record/i)).toBeInTheDocument()
    expect(screen.getAllByText('Quality at a fair price')).toHaveLength(2)
    expect(screen.getAllByText(/missing backtest evidence/i).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Rules JSON')).toBeInTheDocument()
    expect(screen.getByLabelText('Run type')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /trade live|deploy live|promote live/i })).not.toBeInTheDocument()
  })
})
