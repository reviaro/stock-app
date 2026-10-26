import Markdown from 'react-markdown'

function safeLink(url: string): string {
  // Model output is untrusted. Only user-initiated HTTPS links are useful
  // here; relative paths, data URLs and custom protocols are not navigation.
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : ''
  } catch {
    return ''
  }
}

export function SafeMarkdown({ children }: { children: string }) {
  return (
    <Markdown
      skipHtml
      urlTransform={(url, key) => key === 'href' ? safeLink(url) : ''}
      components={{
        // Never create an img element: even a hidden/broken image initiates a
        // request and can disclose private context embedded in its URL.
        img: ({ alt }) => <span>{alt ? `[Image omitted: ${alt}]` : '[Image omitted]'}</span>,
        a: ({ href, children: label }) => href
          ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{label}</a>
          : <span>{label}</span>,
      }}
    >
      {children}
    </Markdown>
  )
}
