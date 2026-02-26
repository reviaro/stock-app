import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

// Mock asset imports to avoid jsdom URL issues
vi.mock('./assets/react.svg', () => ({ default: 'react.svg' }))
vi.mock('/vite.svg', () => ({ default: 'vite.svg' }))

import App from './App'

describe('App', () => {
  it('renders without crashing', () => {
    render(<App />)
    expect(screen.getByText('Vite + React')).toBeInTheDocument()
  })

  it('renders the count button', () => {
    render(<App />)
    expect(screen.getByRole('button', { name: /count is/i })).toBeInTheDocument()
  })
})
