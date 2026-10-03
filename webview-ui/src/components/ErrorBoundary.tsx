/**
 * ErrorBoundary.tsx
 *
 * React error boundary that catches render errors in child components
 * and shows a recovery UI instead of a blank white panel.
 */

import React, { Component, ErrorInfo } from 'react';

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

class ErrorBoundary extends Component<{ children: React.ReactNode }, ErrorBoundaryState> {
    constructor(props: { children: React.ReactNode }) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('[CodeAtlas] Render error caught by ErrorBoundary:', error, errorInfo.componentStack);
    }

    handleReload = () => {
        this.setState({ hasError: false, error: null });
        // Re-request graph data from extension
        window.vscodeApi?.postMessage({ type: 'ready' });
    };

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100vh',
                    fontFamily: "'Inter', system-ui, sans-serif",
                    color: 'var(--ca-text)',
                    background: 'var(--ca-bg)',
                    padding: 32,
                    textAlign: 'center',
                    gap: 16,
                }}>
                    <div style={{ fontSize: 32, opacity: 0.5 }}>!</div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>Something went wrong</div>
                    <div style={{ fontSize: 11, color: 'var(--ca-text-muted)', maxWidth: 400 }}>
                        An error occurred while rendering the diagram. This is usually caused by unexpected data.
                    </div>
                    {this.state.error && (
                        <pre style={{
                            fontSize: 10,
                            color: 'var(--ca-danger)',
                            background: 'var(--ca-surface)',
                            border: '1px solid var(--ca-border)',
                            borderRadius: 6,
                            padding: '8px 12px',
                            maxWidth: 500,
                            overflow: 'auto',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            maxHeight: 120,
                        }}>
                            {this.state.error.message}
                        </pre>
                    )}
                    <button
                        onClick={this.handleReload}
                        style={{
                            padding: '8px 20px',
                            fontSize: 12,
                            fontWeight: 600,
                            background: 'var(--ca-accent)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 6,
                            cursor: 'pointer',
                        }}
                    >
                        Reload Diagram
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}

export default ErrorBoundary;
