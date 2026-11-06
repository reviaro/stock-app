import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useAlpacaPaperInvesting, useReconcileLegacyPaperOrders } from './useAlpacaPaperInvesting'

beforeEach(() => vi.restoreAllMocks())

function mount() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return renderHook(useAlpacaPaperInvesting, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
}
const ok = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 })

test('paper allocation import and confirmed submission use only the paper endpoint and session cookie', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input).endsWith('/simulator-draft')) return ok({ sourceAccountId: 1, targets: [{ symbol: 'SPY', weightPct: 20 }], note: 'Review this draft.' })
    if (String(input).endsWith('/execute')) return ok({ order: { id: 'paper-order' } })
    return ok({ configuration: { environment: 'paper' } })
  })
  const hook = mount()
  await waitFor(() => expect(hook.result.current.overview.isSuccess).toBe(true))
  await act(async () => {
    const draft = await hook.result.current.draft.mutateAsync()
    expect(draft.sourceAccountId).toBe(1)
  })
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/policy'))).toBe(false)
  await act(async () => { await hook.result.current.execute.mutateAsync({ planId: 'reviewed-paper-plan', confirmation: 'BUY SPY PAPER' }) })
  expect(fetcher).toHaveBeenCalledWith('/api/alpaca-paper/long-term/execute', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId: 'reviewed-paper-plan', confirmation: 'BUY SPY PAPER' }),
  })
  expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('/api/alpaca-paper/long-term/'))).toBe(true)
})

test('legacy reconciliation uses the operator session without the retired order token and refreshes paper evidence', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ checked: 2, updated: 1, unchanged: 1, failures: 0 }))
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const hook = renderHook(useReconcileLegacyPaperOrders, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
  await act(async () => { await hook.result.current.mutateAsync() })
  expect(fetcher).toHaveBeenCalledWith('/api/alpaca-paper/long-term/legacy-reconcile', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['alpaca-paper'] })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['alpaca-dt-v2'] })
})
