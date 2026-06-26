export const MODE_NAMES = ['free', 'decisionMemo', 'bearCase', 'compare', 'weeklyReview', 'monthlyReview'] as const
export type ModeName = typeof MODE_NAMES[number]

export interface ModeInputs {
  symbol?: string
  symbolA?: string
  symbolB?: string
}

export const MODE_LABELS: Record<ModeName, string> = {
  free: 'Free Chat',
  decisionMemo: 'Decision Memo',
  bearCase: 'Bear Case',
  compare: 'Compare',
  weeklyReview: 'Weekly Review',
  monthlyReview: 'Monthly Review',
}

export const MODE_INPUTS: Record<ModeName, Array<keyof ModeInputs>> = {
  free: [],
  decisionMemo: ['symbol'],
  bearCase: ['symbol'],
  compare: ['symbolA', 'symbolB'],
  weeklyReview: [],
  monthlyReview: [],
}
