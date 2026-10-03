/**
 * FailedRepoFallback.tsx — ADR-034 Phase E Pass 3 (#790).
 *
 * Reusable error pane shown when a per-repo init fails. Extracted from the
 * inline failure block in `MicroserviceView.tsx` so the same UI can also be
 * surfaced from any drill-in (a Features/APIs/Sequence panel that lands on a
 * failed repo's empty graph would render this instead of an empty canvas).
 *
 * The component is intentionally presentational — it owns no postMessage
 * channel of its own. Callers wire `onRetry` (typically a `retryRepo`
 * message) and `onOpenLogs` (open the extension output channel). Both are
 * optional; hidden when omitted, so the card degrades cleanly in contexts
 * where retry isn't applicable.
 */

import React, { memo } from 'react';
import type { CSSProperties } from 'react';

export interface FailedRepoFallbackProps {
    /** Display name of the failed repo (basename or rootPath). */
    repoName: string;
    /** First line of the underlying failure — trimmed and ellipsised by the renderer. */
    errorMessage?: string;
    /** Compact mode for inline rendering inside an L1 service node card. */
    compact?: boolean;
    /** Retry handler (typically posts `retryRepo`). Button hidden when omitted. */
    onRetry?: () => void;
    /** Reveal the extension Output channel. Button hidden when omitted. */
    onOpenLogs?: () => void;
}

const MAX_ERR_LEN = 200;

function FailedRepoFallback({
    repoName,
    errorMessage,
    compact = false,
    onRetry,
    onOpenLogs,
}: FailedRepoFallbackProps) {
    const trimmed = errorMessage ? errorMessage.trim() : '';
    const display = trimmed.length > MAX_ERR_LEN
        ? `${trimmed.slice(0, MAX_ERR_LEN)}…`
        : trimmed;

    const containerStyle: CSSProperties = compact
        ? compactContainerStyle
        : fullContainerStyle;

    return (
        <div
            role="alert"
            aria-label={`Indexing failed for ${repoName}`}
            style={containerStyle}
        >
            <div style={headerStyle}>
                <span style={dotStyle} aria-hidden="true" />
                <span style={titleStyle}>
                    {compact ? 'Indexing failed' : `Indexing failed for ${repoName}`}
                </span>
            </div>
            {!compact && (
                <div style={subtitleStyle}>
                    CodeAtlas couldn't build this repo's diagrams. The other repos in
                    your workspace are unaffected — you can retry indexing this repo
                    once the underlying issue is resolved.
                </div>
            )}
            {display && (
                <pre
                    style={errorStyle}
                    title={trimmed}
                >
                    {display}
                </pre>
            )}
            {(onRetry || onOpenLogs) && (
                <div style={actionsStyle}>
                    {onRetry && (
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onRetry(); }}
                            style={primaryBtnStyle}
                            aria-label={`Retry indexing for ${repoName}`}
                        >
                            ↻ Retry
                        </button>
                    )}
                    {onOpenLogs && (
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onOpenLogs(); }}
                            style={secondaryBtnStyle}
                            aria-label="Open extension output channel"
                        >
                            View logs
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

// ─── Styles ──────────────────────────────────────────────────────────────

const compactContainerStyle: CSSProperties = {
    marginTop: 8,
    padding: 6,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--ca-error, #c0392b)',
    borderRadius: 6,
    background: 'rgba(192,57,43,0.08)',
    maxWidth: '100%',
};

const fullContainerStyle: CSSProperties = {
    padding: 18,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--ca-error, #c0392b)',
    borderRadius: 10,
    background: 'rgba(192,57,43,0.06)',
    color: 'var(--ca-text)',
    maxWidth: 520,
    margin: '40px auto',
};

const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: 'var(--ca-error, #c0392b)',
    fontWeight: 700,
    fontSize: 11,
};

const dotStyle: CSSProperties = {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--ca-error, #c0392b)',
};

const titleStyle: CSSProperties = {
    fontSize: 13,
};

const subtitleStyle: CSSProperties = {
    marginTop: 8,
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--ca-text-muted)',
};

const errorStyle: CSSProperties = {
    marginTop: 10,
    padding: 8,
    background: 'var(--ca-bg)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--ca-border)',
    borderRadius: 6,
    fontFamily: "'SF Mono', monospace",
    fontSize: 11,
    color: 'var(--ca-text-muted)',
    whiteSpace: 'pre-wrap',
    overflow: 'auto',
    maxHeight: 140,
};

const actionsStyle: CSSProperties = {
    marginTop: 10,
    display: 'flex',
    gap: 8,
};

const primaryBtnStyle: CSSProperties = {
    padding: '5px 12px',
    fontSize: 11,
    fontWeight: 600,
    background: 'var(--ca-accent, #6c72cb)',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
};

const secondaryBtnStyle: CSSProperties = {
    padding: '5px 12px',
    fontSize: 11,
    background: 'transparent',
    color: 'var(--ca-text)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--ca-border)',
    borderRadius: 4,
    cursor: 'pointer',
};

export default memo(FailedRepoFallback);
