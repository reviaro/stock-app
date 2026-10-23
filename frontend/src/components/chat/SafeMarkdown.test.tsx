import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SafeMarkdown } from './SafeMarkdown'

describe('untrusted assistant Markdown', () => {
  it('never creates a resource-bearing element from images or raw HTML', () => {
    const { container } = render(<SafeMarkdown>{'![chart](https://untrusted.example/pixel?private=fictional)\n\n![inline](data:image/svg+xml;base64,AAAA)\n\n<img src="https://untrusted.example/raw"/><iframe src="https://untrusted.example/frame"></iframe>'}</SafeMarkdown>)
    expect(container.querySelector('img,iframe,video,audio,source,object,embed,link,script')).toBeNull()
    expect(container.querySelector('[src],[srcset]')).toBeNull()
    expect(screen.getByText('[Image omitted: chart]')).toBeInTheDocument()
  })

  it('keeps HTTPS citations user-initiated and strips active/local navigation', () => {
    render(<SafeMarkdown>{'[Source](https://issuer.example/filing)\n\n[script](javascript:alert%281%29) [relative](/api/alpaca-live/overview) [credentials](https://user:password@issuer.example/) [insecure](http://issuer.example/)'}</SafeMarkdown>)
    const link = screen.getByRole('link', { name: 'Source' })
    expect(link).toHaveAttribute('href', 'https://issuer.example/filing')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })
})
