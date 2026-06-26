import { MODE_LABELS, MODE_NAMES, type ModeName } from '@/types/aiMode'

interface Props {
  value: ModeName
  onChange: (mode: ModeName) => void
  disabled?: boolean
}

export function ModesDropdown({ value, onChange, disabled }: Props) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ModeName)}
      disabled={disabled}
      className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
    >
      {MODE_NAMES.map((mode) => (
        <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>
      ))}
    </select>
  )
}

export default ModesDropdown
