import { useMutation } from '@tanstack/react-query'
import type { PortfolioLabRequest, PortfolioLabResult } from '@/types/portfolioLab'

async function runAnalysis(payload: PortfolioLabRequest): Promise<PortfolioLabResult> {
  const response = await fetch('/api/portfolio-lab/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const json = await response.json()
  if (!response.ok || json.status !== 'success') {
    throw new Error(json.error || `Portfolio Lab request failed (${response.status})`)
  }
  if (json.data?.read_only !== true || json.data?.execution_enabled !== false) {
    throw new Error('Portfolio Lab safety contract is missing')
  }
  return json.data as PortfolioLabResult
}

export function usePortfolioLabAnalysis() {
  return useMutation<PortfolioLabResult, Error, PortfolioLabRequest>({ mutationFn: runAnalysis })
}
