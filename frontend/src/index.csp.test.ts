import { describe, expect, it } from 'vitest'
import html from '../index.html?raw'

describe('index CSP compatibility', () => {
  it('contains no inline scripts', () => {
    const scriptTags = html.match(/<script\b[^>]*>/gi) ?? []

    expect(scriptTags.length).toBeGreaterThan(0)
    expect(scriptTags.every((tag: string) => /\bsrc\s*=/.test(tag))).toBe(true)
  })
})
