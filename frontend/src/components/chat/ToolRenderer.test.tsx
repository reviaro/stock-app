import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToolRenderer } from './ToolRenderer'
import type { UIMessagePart, UIDataTypes, UITools } from 'ai'

// ---- Mocks ----------------------------------------------------------------

// Mock CANSLIMScorecard and StockChart to avoid complex dependency chains
// in unit tests. We only care that ToolRenderer renders the right component
// based on the tool name.
vi.mock('@/components/CANSLIMScorecard', () => ({
  CANSLIMScorecard: () => <div data-testid="canslim-scorecard">CANSLIMScorecard</div>,
}))

vi.mock('@/components/StockChart', () => ({
  StockChart: () => <div data-testid="stock-chart">StockChart</div>,
}))

// ---- Helpers ---------------------------------------------------------------

type ToolPart = Extract<UIMessagePart<UIDataTypes, UITools>, { type: `tool-${string}` | 'dynamic-tool' }>

function makeToolPart(toolName: string, state: string, extra: Record<string, unknown> = {}): ToolPart {
  return {
    type: 'dynamic-tool',
    toolName,
    toolCallId: `tc-${toolName}-test`,
    state,
    ...extra,
  } as ToolPart
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  })
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  )
}

// ---- Tests -----------------------------------------------------------------

describe('ToolRenderer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('loading states', () => {
    it('shows skeleton while input is streaming', () => {
      const toolPart = makeToolPart('getCanslimAnalysis', 'input-streaming')
      renderWithProviders(<ToolRenderer toolPart={toolPart} />)
      expect(screen.getByText(/Running CAN SLIM analysis/i)).toBeInTheDocument()
    })

    it('shows skeleton while input is available but not yet executed', () => {
      const toolPart = makeToolPart('getStockInfo', 'input-available', {
        input: { symbol: 'AAPL' },
      })
      renderWithProviders(<ToolRenderer toolPart={toolPart} />)
      expect(screen.getByText(/Fetching stock data/i)).toBeInTheDocument()
    })

    it('shows skeleton with correct label for getTechnicalIndicators', () => {
      const toolPart = makeToolPart('getTechnicalIndicators', 'input-streaming')
      renderWithProviders(<ToolRenderer toolPart={toolPart} />)
      expect(screen.getByText(/Calculating technical indicators/i)).toBeInTheDocument()
    })

    it('shows skeleton with correct label for getMarketDirection', () => {
      const toolPart = makeToolPart('getMarketDirection', 'input-available', {
        input: {},
      })
      renderWithProviders(<ToolRenderer toolPart={toolPart} />)
      expect(screen.getByText(/Checking market direction/i)).toBeInTheDocument()
    })
  })

  describe('error state', () => {
    it('shows error message when tool output-error', () => {
      const toolPart = makeToolPart('getCanslimAnalysis', 'output-error', {
        errorText: 'Python bridge timeout',
      })
      renderWithProviders(<ToolRenderer toolPart={toolPart} />)
      expect(screen.getByText(/getCanslimAnalysis failed/i)).toBeInTheDocument()
      expect(screen.getByText(/Python bridge timeout/i)).toBeInTheDocument()
    })
  })

  describe('output-available: component mapping', () => {
    it('renders CANSLIMScorecard for getCanslimAnalysis', () => {
      const toolPart = makeToolPart('getCanslimAnalysis', 'output-available', {
        output: { symbol: 'AAPL', overall: { score: 75 } },
      })
      renderWithProviders(<ToolRenderer toolPart={toolPart} />)
      expect(screen.getByTestId('canslim-scorecard')).toBeInTheDocument()
      expect(screen.getByText(/CAN SLIM Analysis/i)).toBeInTheDocument()
    })

    it('renders StockChart for getStockInfo', () => {
      const toolPart = makeToolPart('getStockInfo', 'output-available', {
        output: { symbol: 'AAPL', price: 180 },
      })
      renderWithProviders(<ToolRenderer toolPart={toolPart} />)
      expect(screen.getByTestId('stock-chart')).toBeInTheDocument()
      expect(screen.getByText(/Stock Info/i)).toBeInTheDocument()
    })

    it('renders StockChart for getTechnicalIndicators', () => {
      const toolPart = makeToolPart('getTechnicalIndicators', 'output-available', {
        output: { symbol: 'NVDA', current: { rsi: 62 } },
      })
      renderWithProviders(<ToolRenderer toolPart={toolPart} />)
      expect(screen.getByTestId('stock-chart')).toBeInTheDocument()
      expect(screen.getByText(/Technical Analysis/i)).toBeInTheDocument()
    })

    it('renders market direction summary for getMarketDirection', () => {
      const toolPart = makeToolPart('getMarketDirection', 'output-available', {
        output: {
          direction: 'Confirmed Uptrend',
          summary: 'Follow-through day detected on Nasdaq.',
        },
      })
      renderWithProviders(<ToolRenderer toolPart={toolPart} />)
      expect(screen.getByText('Market Direction')).toBeInTheDocument()
      expect(screen.getByText('Confirmed Uptrend')).toBeInTheDocument()
      expect(screen.getByText(/Follow-through day detected/i)).toBeInTheDocument()
    })

    it('renders raw JSON for unknown tool names', () => {
      const toolPart = makeToolPart('someUnknownTool', 'output-available', {
        output: { key: 'value' },
      })
      renderWithProviders(<ToolRenderer toolPart={toolPart} />)
      expect(screen.getByText(/someUnknownTool/)).toBeInTheDocument()
      // Raw JSON should be visible in a <pre> tag
      expect(screen.getByText(/"key": "value"/)).toBeInTheDocument()
    })

    it('renders null when output is missing for getMarketDirection', () => {
      const toolPart = makeToolPart('getMarketDirection', 'output-available', {
        output: null,
      })
      const { container } = renderWithProviders(<ToolRenderer toolPart={toolPart} />)
      expect(container.firstChild).toBeNull()
    })
  })

  describe('null output for unknown states', () => {
    it('renders nothing for unexpected state values', () => {
      // Simulate an unexpected state that doesn't match any branch
      const toolPart = makeToolPart('getCanslimAnalysis', 'approval-requested')
      const { container } = renderWithProviders(<ToolRenderer toolPart={toolPart} />)
      // approval-requested is not handled — component should return null
      expect(container.firstChild).toBeNull()
    })
  })
})
