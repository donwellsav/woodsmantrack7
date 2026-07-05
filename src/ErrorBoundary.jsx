import { Component } from 'react'

// CQ-1: A throw inside openFoliateView, buildTextMap, or highlightWord used
// to white-screen the entire app with no recovery UI. This boundary wraps
// the foliate/audio section so a localized throw shows a retry button
// instead of crashing the whole reader.
//
// Intentionally simple: no error reporting, no per-component boundaries.
// Logs to console so devs can see the failure; production users get a
// "Reload chapter" button that resets the boundary state.

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || String(error) }
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary caught:', error, info)
  }

  handleRetry = () => {
    this.setState({ hasError: false, message: '' })
    // Call the optional onRetry prop so App can re-trigger the open flow.
    if (typeof this.props.onRetry === 'function') {
      try { this.props.onRetry() } catch {}
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary" role="alert">
          <div className="error-boundary-message">
            Something went wrong loading this chapter.
          </div>
          {this.state.message && (
            <div className="error-boundary-detail">{this.state.message}</div>
          )}
          <button className="error-boundary-retry" onClick={this.handleRetry}>
            Reload chapter
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
