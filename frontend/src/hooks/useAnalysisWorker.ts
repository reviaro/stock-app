import * as Comlink from 'comlink'
import { useEffect, useRef, useState } from 'react'
import type { Remote } from 'comlink'
import type { WatchlistEntry } from '@/types'
import type { SortCriteria, SortField, RankedEntry } from '../workers/analysis.worker.ts'

/**
 * The async interface of the analysis worker API as seen from the main thread.
 * Each method returns a Promise because it communicates across the worker bridge.
 */
export interface AnalysisWorkerApi {
  sortEntries(entries: WatchlistEntry[], criteria: SortCriteria[]): Promise<WatchlistEntry[]>
  calculateRanks(entries: WatchlistEntry[], field: SortField): Promise<RankedEntry[]>
  filterByMinChange(entries: WatchlistEntry[], minChangePercent: number): Promise<WatchlistEntry[]>
}

/**
 * Hook that creates, wraps, and manages the lifecycle of the analysis Web Worker.
 *
 * Usage:
 * ```tsx
 * const { workerApi, isReady } = useAnalysisWorker()
 *
 * useEffect(() => {
 *   if (!workerApi || !data) return
 *   workerApi.sortEntries(data, [{ field: 'changePercent', direction: 'desc' }])
 *     .then(setSorted)
 * }, [workerApi, data])
 * ```
 *
 * The worker is automatically terminated when the consuming component unmounts.
 */
export function useAnalysisWorker() {
  const workerRef = useRef<Worker | null>(null)
  const [workerApi, setWorkerApi] = useState<Remote<AnalysisWorkerApi> | null>(null)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/analysis.worker.ts', import.meta.url),
      { type: 'module' }
    )

    const api = Comlink.wrap<AnalysisWorkerApi>(worker)
    workerRef.current = worker
    setWorkerApi(api)
    setIsReady(true)

    return () => {
      // Release Comlink proxy and terminate the underlying worker thread to prevent leaks
      api[Comlink.releaseProxy]()
      worker.terminate()
      workerRef.current = null
      setWorkerApi(null)
      setIsReady(false)
    }
  }, [])

  return { workerApi, isReady }
}
