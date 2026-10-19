import { Component, type ReactNode } from 'react'

/** Keeps a failed page or downloaded chunk from taking down navigation. */
export class WorkspaceErrorBoundary extends Component<{
  children: ReactNode
  onReturn?: () => void
}, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <section role="alert" className="mx-auto my-8 max-w-lg space-y-4 rounded-lg border border-border bg-card p-6 text-card-foreground">
        <h1 className="text-xl font-semibold">This workspace could not load</h1>
        <p className="text-sm text-muted-foreground">Try again. If the problem continues, reload to get the latest version. Unsaved inputs on this page may need to be entered again.</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => this.setState({ failed: false })} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">Try again</button>
          <button type="button" onClick={() => window.location.reload()} className="rounded-md border border-border px-4 py-2 text-sm">Reload workspace</button>
          {this.props.onReturn && <button type="button" onClick={this.props.onReturn} className="rounded-md border border-border px-4 py-2 text-sm">Return to dashboard</button>}
        </div>
      </section>
    )
  }
}
