import { StrictMode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAnalysisWorker } from './useAnalysisWorker'

const mocks = vi.hoisted(() => {
  const releaseProxy = Symbol('releaseProxy')
  const api = Object.assign(vi.fn(), {
    sortEntries: vi.fn(),
    calculateRanks: vi.fn(),
    filterByMinChange: vi.fn(),
    [releaseProxy]: vi.fn(),
  })

  return {
    releaseProxy,
    api,
    wrap: vi.fn(),
  }
})

vi.mock('comlink', () => ({
  wrap: mocks.wrap,
  releaseProxy: mocks.releaseProxy,
}))

class WorkerStub {
  terminate = vi.fn()
}

describe('useAnalysisWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.wrap.mockReturnValue(mocks.api)
    vi.stubGlobal('Worker', WorkerStub)
  })

  it('stores a callable Comlink proxy without invoking it as a React state updater', async () => {
    const { result } = renderHook(() => useAnalysisWorker(), { wrapper: StrictMode })

    await waitFor(() => expect(result.current.workerApi).toBe(mocks.api))
    expect(mocks.api).not.toHaveBeenCalled()
  })
})
