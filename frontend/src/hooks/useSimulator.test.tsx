import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useSimTrade } from './useSimulator'

beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks() })
function mount(account = 2) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: 3 } } })
  return renderHook(() => useSimTrade(account), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
}
test('lookup reconciles a stored fill without another POST; 404 retains the intention', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(503, null))
  const hook = mount()
  await act(async () => { await expect(hook.result.current.mutateAsync(intent)).rejects.toThrow() })
  const key = hook.result.current.pendingOrder!.client_order_id
  fetcher.mockResolvedValueOnce(response(404, null))
  await act(async () => { await hook.result.current.reconcileOrder() })
  expect(hook.result.current.pendingOrder!.client_order_id).toBe(key)
  fetcher.mockResolvedValueOnce(response(200, { result: { id: 42, price: 125 } }))
  await act(async () => { expect(await hook.result.current.reconcileOrder()).toEqual({ id: 42, price: 125 }) })
  expect(fetcher.mock.calls[2][0]).toBe(`/api/simulator/orders/${key}?account_id=2`)
  expect(hook.result.current.pendingOrder).toBeNull()
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
})

test.each([400, 409])('definitive %i rejection permits a distinct new intention', async status => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(status, null)).mockResolvedValueOnce(response(200, { id: 3 }))
  const hook = mount()
  await act(async () => { await expect(hook.result.current.mutateAsync(intent)).rejects.toThrow() })
  expect(hook.result.current.pendingOrder).toBeNull()
  await act(async () => { await hook.result.current.mutateAsync(intent) })
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).client_order_id).not.toBe(JSON.parse(fetcher.mock.calls[1][1]!.body as string).client_order_id)
})

const intent = { type: 'buy' as const, symbol: 'AAPL', shares: 2, price: 123 }
const response = (status: number, data: unknown) => new Response(JSON.stringify(status === 200 ? { status: 'success', data } : { status: 'error', error: 'Rejected' }), { status })

test('ambiguous submission survives remount and retries the identical body and key only on request', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Network lost')).mockResolvedValue(response(200, { id: 42 }))
  const first = mount()
  await act(async () => { await expect(first.result.current.mutateAsync(intent)).rejects.toThrow() })
  expect(fetcher).toHaveBeenCalledTimes(1)
  const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string)
  expect(body).toMatchObject({ account_id: 2, symbol: 'AAPL', shares: 2 })
  expect(body.client_order_id).toEqual(expect.any(String))
  expect(body).not.toHaveProperty('price')
  first.unmount()
  const second = mount()
  expect(second.result.current.pendingOrder).toMatchObject({ client_order_id: body.client_order_id })
  await act(async () => { await expect(second.result.current.mutateAsync({ ...intent, shares: 3 })).rejects.toThrow(/unresolved/i) })
  expect(fetcher).toHaveBeenCalledTimes(1)
  await act(async () => { await second.result.current.retryOrder() })
  expect(fetcher.mock.calls[1][1]!.body).toBe(fetcher.mock.calls[0][1]!.body)
  expect(second.result.current.pendingOrder).toBeNull()
})
