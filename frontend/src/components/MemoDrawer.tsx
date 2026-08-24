import { useEffect, useState } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useMemoQuery, useSaveMemo, useReviewMemo } from '@/hooks/useMemo'
import type { MemoInput } from '@/types/memo'

interface MemoDrawerProps {
  symbol: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  initialDraft?: MemoInput | null
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const diffMs = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diffMs / 86400000)
  if (days < 1) return 'today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

export function MemoDrawer({ symbol, open, onOpenChange, initialDraft = null }: MemoDrawerProps) {
  const { data: memo, isLoading } = useMemoQuery(symbol)
  const save = useSaveMemo(symbol || '')
  const review = useReviewMemo(symbol || '')

  const [form, setForm] = useState<MemoInput>({})
  const [draftLoading, setDraftLoading] = useState(false)
  const [pressureText, setPressureText] = useState<string | null>(null)
  const [pressureLoading, setPressureLoading] = useState(false)

  useEffect(() => {
    if (memo) {
      setForm({
        thesis: memo.thesis ?? '',
        variant_view: memo.variant_view ?? '',
        fair_value_low: memo.fair_value_low,
        fair_value_high: memo.fair_value_high,
        buy_below: memo.buy_below,
        trim_above: memo.trim_above,
        sell_rule: memo.sell_rule ?? '',
        invalidation: memo.invalidation ?? '',
        risks: memo.risks ?? '',
        conviction: memo.conviction ?? null,
      })
    } else {
      setForm({})
    }
    if (initialDraft) {
      setForm((prev) => ({ ...prev, ...initialDraft }))
    }
    setPressureText(null)
  }, [memo, symbol, initialDraft])

  if (!symbol) return null

  const handleSave = async () => {
    await save.mutateAsync(form)
    onOpenChange(false)
  }

  const handleDraft = async () => {
    setDraftLoading(true)
    try {
      const res = await fetch('/api/ai/memo-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      })
      if (!res.ok) throw new Error('Draft failed')
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.error || 'Draft failed')
      setForm(prev => ({ ...prev, ...json.data }))
    } catch (e) {
      alert(`Draft error: ${(e as Error).message}`)
    } finally {
      setDraftLoading(false)
    }
  }

  const handlePressureTest = async () => {
    setPressureLoading(true)
    setPressureText('')
    try {
      const res = await fetch('/api/ai/pressure-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      })
      if (!res.ok) throw new Error('Pressure-test failed')
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.error || 'Pressure-test failed')
      setPressureText(json.data?.bear_case || '')
    } catch (e) {
      setPressureText(`Error: ${(e as Error).message}`)
    } finally {
      setPressureLoading(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[480px] sm:max-w-none overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{symbol} — Memo</SheetTitle>
          <SheetDescription>Capture thesis, valuation, rules, and risks for {symbol}.</SheetDescription>
        </SheetHeader>

        {isLoading && <p className="text-sm text-muted-foreground mt-4">Loading…</p>}

        <div className="mt-4 space-y-4 text-sm">
          <div className="flex items-center justify-between gap-2 pb-2 border-b">
            <p className="text-xs text-muted-foreground">
              Updated {formatRelative(memo?.updated_at)} · Reviewed {formatRelative(memo?.last_reviewed_at)}
            </p>
            {memo && (
              <button onClick={() => review.mutate()} className="text-xs px-2 py-0.5 rounded border border-border hover:border-primary">
                Mark reviewed
              </button>
            )}
          </div>

          <div className="flex gap-2">
            <button onClick={handleDraft} disabled={draftLoading}
              className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50">
              {draftLoading ? 'Drafting…' : '✨ Draft with AI'}
            </button>
            <button onClick={handlePressureTest} disabled={pressureLoading || !memo}
              className="text-xs px-2 py-1 rounded border border-border hover:border-primary disabled:opacity-50"
              title={!memo ? 'Save a memo first' : ''}>
              {pressureLoading ? 'Testing…' : '🔍 Pressure-test'}
            </button>
          </div>

          <label className="block">
            <span className="text-xs font-medium">Thesis</span>
            <textarea value={form.thesis ?? ''} onChange={e => setForm(f => ({ ...f, thesis: e.target.value }))}
              rows={4} aria-label="Thesis"
              className="w-full mt-1 text-xs px-2 py-1.5 rounded-md bg-secondary border border-border" />
          </label>

          <label className="block">
            <span className="text-xs font-medium">Variant view</span>
            <textarea value={form.variant_view ?? ''} onChange={e => setForm(f => ({ ...f, variant_view: e.target.value }))}
              rows={2} aria-label="Variant view"
              placeholder="What do we believe the market may be missing?"
              className="w-full mt-1 text-xs px-2 py-1.5 rounded-md bg-secondary border border-border" />
          </label>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <label className="block">
              <span className="text-xs">FV low</span>
              <input type="number" value={form.fair_value_low ?? ''}
                onChange={e => setForm(f => ({ ...f, fair_value_low: e.target.value ? Number(e.target.value) : null }))}
                className="w-full mt-1 text-xs px-2 py-1.5 rounded-md bg-secondary border border-border" />
            </label>
            <label className="block">
              <span className="text-xs">FV high</span>
              <input type="number" value={form.fair_value_high ?? ''}
                onChange={e => setForm(f => ({ ...f, fair_value_high: e.target.value ? Number(e.target.value) : null }))}
                className="w-full mt-1 text-xs px-2 py-1.5 rounded-md bg-secondary border border-border" />
            </label>
            <label className="block">
              <span className="text-xs">Buy below</span>
              <input type="number" value={form.buy_below ?? ''}
                onChange={e => setForm(f => ({ ...f, buy_below: e.target.value ? Number(e.target.value) : null }))}
                className="w-full mt-1 text-xs px-2 py-1.5 rounded-md bg-secondary border border-border" />
            </label>
            <label className="block">
              <span className="text-xs">Trim above</span>
              <input type="number" value={form.trim_above ?? ''}
                onChange={e => setForm(f => ({ ...f, trim_above: e.target.value ? Number(e.target.value) : null }))}
                className="w-full mt-1 text-xs px-2 py-1.5 rounded-md bg-secondary border border-border" />
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-medium">Sell rule</span>
            <textarea value={form.sell_rule ?? ''} onChange={e => setForm(f => ({ ...f, sell_rule: e.target.value }))}
              rows={2} className="w-full mt-1 text-xs px-2 py-1.5 rounded-md bg-secondary border border-border" />
          </label>

          <label className="block">
            <span className="text-xs font-medium">Invalidation</span>
            <textarea value={form.invalidation ?? ''} onChange={e => setForm(f => ({ ...f, invalidation: e.target.value }))}
              rows={2} className="w-full mt-1 text-xs px-2 py-1.5 rounded-md bg-secondary border border-border" />
          </label>

          <label className="block">
            <span className="text-xs font-medium">Risks</span>
            <textarea value={form.risks ?? ''} onChange={e => setForm(f => ({ ...f, risks: e.target.value }))}
              rows={4} className="w-full mt-1 text-xs px-2 py-1.5 rounded-md bg-secondary border border-border" />
          </label>

          <label className="block">
            <span className="text-xs font-medium">Conviction (1-5)</span>
            <input type="number" min={1} max={5} value={form.conviction ?? ''}
              onChange={e => setForm(f => ({ ...f, conviction: e.target.value ? Number(e.target.value) : null }))}
              className="w-24 mt-1 text-xs px-2 py-1.5 rounded-md bg-secondary border border-border" />
          </label>

          {pressureText != null && (
            <div className="mt-2 p-2 rounded border border-amber-500/40 bg-amber-500/5">
              <p className="text-xs font-semibold mb-1">Bear case</p>
              <pre className="text-xs whitespace-pre-wrap">{pressureText}</pre>
            </div>
          )}

          <div className="flex gap-2 pt-2 border-t">
            <button onClick={handleSave} disabled={save.isPending}
              className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-50">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => onOpenChange(false)}
              className="text-xs px-3 py-1.5 rounded border border-border">
              Cancel
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export default MemoDrawer
