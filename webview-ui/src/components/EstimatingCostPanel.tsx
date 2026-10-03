/**
 * EstimatingCostPanel.tsx — UX-22 (2026-06-04)
 *
 * Pre-flight cost estimate UI for AI Review. Replaces the silent
 * "Estimating cost…" div that could hang indefinitely if the LLM
 * endpoint was slow or unreachable.
 *
 * Behaviour:
 * 1. Spinner + "Estimating cost…" text visible from t=0.
 * 2. Cancel button visible from t=0 so users can back out without reloading the SPA.
 * 3. After `timeoutMs` (default 15s), the panel flips to an error state
 *    with an explanatory message and a Retry button. The parent decides
 *    what Retry means (typically re-issue the cost-estimate request).
 * 4. Calling `onCancel` ends the flow.
 *
 * The component is purely UI — the actual cost-estimate request lives
 * in the parent. We only own the visible state machine + timeout.
 */

import React, { useEffect, useState } from 'react';

interface EstimatingCostPanelProps {
    /** Called when the user clicks Cancel. */
    onCancel: () => void;
    /** Called when the user clicks Retry after the timeout fires. */
    onRetry?: () => void;
    /** Milliseconds to wait before flipping to the timeout-error state. Default 15000. */
    timeoutMs?: number;
    /** Optional endpoint string used in the timeout error message. */
    endpointLabel?: string;
}

export default function EstimatingCostPanel({
    onCancel,
    onRetry,
    timeoutMs = 15000,
    endpointLabel,
}: EstimatingCostPanelProps): JSX.Element {
    const [timedOut, setTimedOut] = useState(false);

    useEffect(() => {
        if (timedOut) return;
        const handle = setTimeout(() => setTimedOut(true), timeoutMs);
        return () => clearTimeout(handle);
    }, [timeoutMs, timedOut]);

    const handleRetry = () => {
        setTimedOut(false);
        onRetry?.();
    };

    const baseStyle: React.CSSProperties = {
        marginTop: 12,
        padding: '10px 12px',
        background: 'var(--ca-bg, #0a0a0b)',
        border: '1px solid var(--ca-border, #232429)',
        borderRadius: 6,
        fontSize: 11,
        color: 'var(--ca-text-dim, #9ca0a8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
    };

    const btnStyle: React.CSSProperties = {
        padding: '4px 10px',
        background: 'transparent',
        color: 'var(--ca-text, #d4d4d8)',
        border: '1px solid var(--ca-border, #232429)',
        borderRadius: 4,
        fontSize: 11,
        cursor: 'pointer',
    };

    if (timedOut) {
        const target = endpointLabel ? ` (${endpointLabel})` : '';
        return (
            <div data-testid="ai-review-cost-timeout" style={{ ...baseStyle, borderColor: 'var(--ca-warning, #d97706)' }}>
                <span style={{ color: 'var(--ca-warning, #d97706)' }}>
                    ⚠ Cost estimate timed out after {Math.round(timeoutMs / 1000)}s. Check your LLM endpoint{target}.
                </span>
                <span style={{ display: 'inline-flex', gap: 6 }}>
                    {onRetry && (
                        <button type="button" onClick={handleRetry} style={btnStyle}>
                            Retry
                        </button>
                    )}
                    <button type="button" onClick={onCancel} style={btnStyle}>
                        Cancel
                    </button>
                </span>
            </div>
        );
    }

    return (
        <div data-testid="ai-review-cost-loading" style={baseStyle}>
            <span>Estimating cost…</span>
            <button type="button" onClick={onCancel} style={btnStyle} aria-label="Cancel cost estimate">
                Cancel
            </button>
        </div>
    );
}
