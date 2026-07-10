import { Component } from 'react'

// React error boundaries only catch synchronous render/lifecycle errors.
// Async Foliate failures are handled by App's explicit reader lifecycle.
//
// Intentionally simple: no error reporting, no per-component boundaries.
// Logs to console so devs can see the failure; production users get a
// Retry delegates to App so both failure paths remount the same fresh reader.

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
    if (typeof this.props.onRetry === 'function') this.props.onRetry()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary" role="alert">
          <div className="error-boundary-message">
            Something went wrong loading the reader.
          </div>
          {this.state.message && (
            <div className="error-boundary-detail">{this.state.message}</div>
          )}
          <button className="error-boundary-retry" onClick={this.handleRetry}>
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
