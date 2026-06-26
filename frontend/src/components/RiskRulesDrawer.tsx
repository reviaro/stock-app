import { useEffect, useState } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useSaveRiskRules } from '@/hooks/useRisk'
import type { RiskRules } from '@/types/risk'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  rules: RiskRules | null | undefined
}

export function RiskRulesDrawer({ open, onOpenChange, rules }: Props) {
  const save = useSaveRiskRules()
  const [form, setForm] = useState<RiskRules>({
    max_position_pct: 10,
    max_sector_pct: 30,
    max_risk_per_trade_pct: 1,
    target_cash_pct: 20,
  })

  useEffect(() => {
    if (rules) setForm(rules)
  }, [rules])

  const updateField = (field: keyof RiskRules, value: string) => {
    setForm((prev) => ({ ...prev, [field]: Number(value) } as RiskRules))
  }

  const handleSave = async () => {
    await save.mutateAsync(form)
    onOpenChange(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[420px] sm:max-w-none">
        <SheetHeader>
          <SheetTitle>Risk Rules</SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="text-xs font-medium">Max position %</span>
            <input className="mt-1 w-full rounded-md border border-border bg-secondary px-3 py-2 text-sm" type="number" value={form.max_position_pct} onChange={(e) => updateField('max_position_pct', e.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Max sector %</span>
            <input className="mt-1 w-full rounded-md border border-border bg-secondary px-3 py-2 text-sm" type="number" value={form.max_sector_pct} onChange={(e) => updateField('max_sector_pct', e.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Max risk per trade %</span>
            <input className="mt-1 w-full rounded-md border border-border bg-secondary px-3 py-2 text-sm" type="number" step="0.1" value={form.max_risk_per_trade_pct} onChange={(e) => updateField('max_risk_per_trade_pct', e.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Target cash %</span>
            <input className="mt-1 w-full rounded-md border border-border bg-secondary px-3 py-2 text-sm" type="number" value={form.target_cash_pct} onChange={(e) => updateField('target_cash_pct', e.target.value)} />
          </label>

          {save.isError && <p className="text-xs text-destructive">{save.error instanceof Error ? save.error.message : 'Failed to save rules'}</p>}

          <div className="flex gap-2 pt-2">
            <button onClick={handleSave} disabled={save.isPending} className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => onOpenChange(false)} className="rounded-md border border-border px-3 py-1.5 text-xs">
              Cancel
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export default RiskRulesDrawer
