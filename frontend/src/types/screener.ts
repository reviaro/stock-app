export interface ScreenerCandidate {
  symbol: string
  name: string
  sector: string
  price: number | null
  changePercent: number | null
  forwardPE: number | null
  qualityComposite: number | null
  score: number
  confidence: number
  action: 'Candidate' | 'Research' | 'Wait' | 'Avoid'
  reasons: string[]
  red_flags: string[]
  hasThesis: boolean
}
