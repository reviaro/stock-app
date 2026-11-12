import { afterEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EarningsReview } from './EarningsReview'

afterEach(() => vi.unstubAllGlobals())
it('distinguishes derived amounts, missing EPS and delayed facts, with links to source filings', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: 'success', data: {
    status: null, checkedAt: '2026-11-12T15:00:00Z', report: { asOf: '2026-11-12', currency: 'USD', source: 'sec_edgar',
      changes: ['Revenue grew 10.0% from the comparable quarter a year earlier.'], warnings: ['SEC financial facts lag the latest report.'],
      limitations: ['Diluted EPS is never derived.'], latestReport: { form: '10-K', url: 'https://www.sec.gov/test', filedAt: '2026-11-01' }, earningsRelease: null,
      rows: [{ start: '2026-07-01', end: '2026-09-30', revenueYoY: 10, epsYoY: null, operatingMargin: null, netMargin: null,
        metrics: { revenue: { value: 150000000, start: '2026-07-01', end: '2026-09-30', derived: true, filed: '2026-11-01', tag: 'Revenues', url: 'https://www.sec.gov/test' }, grossProfit: null, operatingIncome: null, netIncome: null, eps: null } }],
    },
  } }) })))
  render(<QueryClientProvider client={new QueryClient()}><EarningsReview symbol="TEST" /></QueryClientProvider>)
  expect(await screen.findByText('$150M*')).toBeVisible()
  expect(screen.getByText('SEC financial facts lag the latest report.')).toBeVisible()
  expect(screen.getByRole('link', { name: /Latest 10-K/ })).toHaveAttribute('href', 'https://www.sec.gov/test')
  expect(screen.getAllByText('—').length).toBe(4)
  fireEvent.click(screen.getByText('Calculation notes and filing evidence'))
  expect(screen.getByText('Diluted EPS is never derived.')).toBeVisible()
})
