import type { PaperFill } from '@/types/alpacaPortfolio'

export function paperFillsCsv(trades: PaperFill[]) {
  // Keep provider strings inert when opened in spreadsheet software.
  const cell = (value: string | number | null) => {
    const raw = String(value ?? '')
    const safe = typeof value === 'string' && /^\s*[=+@-]/.test(raw) ? "'" + raw : raw
    return '"' + safe.replaceAll('"', '""') + '"'
  }
  return [['Date (UTC)', 'Type', 'Symbol', 'Shares', 'Price (USD)', 'Gross amount (USD)', 'Origin', 'Reason'],
    ...trades.map(t => [t.date, t.side, t.symbol, t.qty, t.price, t.amount, t.origin, t.reason])]
    .map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
