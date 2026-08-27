import { beforeEach, describe, expect, it } from 'vitest'
import { applySavedTheme } from './theme'

describe('applySavedTheme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  it('defaults to dark mode when no preference has been saved', () => {
    applySavedTheme()
    expect(document.documentElement).toHaveClass('dark')
  })

  it('applies the saved light preference', () => {
    localStorage.setItem('theme', 'light')
    applySavedTheme()
    expect(document.documentElement).not.toHaveClass('dark')
  })
})
