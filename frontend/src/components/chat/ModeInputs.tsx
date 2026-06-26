import { MODE_INPUTS, MODE_LABELS, type ModeInputs, type ModeName } from '@/types/aiMode'

interface Props {
  mode: ModeName
  inputs: ModeInputs
  onChange: (inputs: ModeInputs) => void
  onRun: () => void
  disabled?: boolean
}

export function ModeInputsPanel({ mode, inputs, onChange, onRun, disabled }: Props) {
  const fields = MODE_INPUTS[mode]
  if (mode === 'free' || fields.length === 0) return null

  const canRun = fields.every((field) => String(inputs[field] ?? '').trim())

  return (
    <div className="data-hover rounded-md border border-border bg-card/50 p-2 space-y-2">
      <p className="text-xs font-medium text-foreground">{MODE_LABELS[mode]}</p>
      <div className="flex flex-wrap gap-2">
        {fields.map((field) => (
          <input
            key={field}
            value={(inputs[field] ?? '').toString()}
            onChange={(e) => onChange({ ...inputs, [field]: e.target.value.toUpperCase() })}
            placeholder={field}
            className="min-w-[120px] flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          />
        ))}
        <button
          type="button"
          onClick={onRun}
          disabled={disabled || !canRun}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
        >
          Run
        </button>
      </div>
    </div>
  )
}

export default ModeInputsPanel
