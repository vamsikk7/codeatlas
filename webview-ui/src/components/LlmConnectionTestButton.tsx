/**
 * LlmConnectionTestButton.tsx - UX (2026-06-04)
 *
 * Verify-connection control for the LLM Config card on the home page.
 * Lets a user click "Test Connection" to confirm the configured LLM
 * endpoint is actually reachable BEFORE clicking Start review and
 * tripping the 15-second cost-estimate timeout (UX-22).
 *
 * State machine:
 *   idle    → "Test Connection" button visible
 *   testing → spinner, "Testing…" chip, Cancel button, 10-second timeout
 *   ok      → green "Connected" chip with latency
 *   error   → orange "Failed" chip with the underlying message
 *   timeout → orange "Timed out" chip (10s no response from extension host)
 *
 * The actual connectivity check runs in the extension host (it has the
 * API key + can issue the fetch). This component only owns the visible
 * state machine and listens for the `llmConnectionTestResult` reply.
 */

import React, { useEffect, useRef, useState } from 'react';

export interface LlmConnectionTestResult {
    ok: boolean;
    message: string;
    latencyMs?: number;
}

interface LlmConnectionTestButtonProps {
    /** Required — postMessage hook to talk to the extension host. */
    postMessage: (msg: any) => void;
    /** Result of the last test, populated by the parent when the
     *  `llmConnectionTestResult` envelope arrives. Null while idle. */
    result?: LlmConnectionTestResult | null;
    /**
     * Optional override for the timeout (ms). Default 10000. Tests use
     * a tiny value to avoid waiting in real time.
     */
    timeoutMs?: number;
    /** Optional callback fired when the user manually cancels mid-test. */
    onCancel?: () => void;
}

type Phase = 'idle' | 'testing' | 'result' | 'timeout';

export default function LlmConnectionTestButton({
    postMessage,
    result,
    timeoutMs = 10000,
    onCancel,
}: LlmConnectionTestButtonProps): JSX.Element {
    const [phase, setPhase] = useState<Phase>('idle');
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // When a result lands while we're testing, clear the timer and
    // transition to 'result'. Stale results that arrive after a
    // timeout/cancel are ignored.
    useEffect(() => {
        if (!result) return;
        if (phase !== 'testing') return;
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        setPhase('result');
    }, [result, phase]);

    const handleStart = () => {
        setPhase('testing');
        postMessage({ type: 'testLlmConnection' });
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            setPhase('timeout');
            timerRef.current = null;
        }, timeoutMs);
    };

    const handleCancel = () => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        setPhase('idle');
        onCancel?.();
    };

    // Reset back to idle so the user can run the test again from
    // any terminal state.
    const handleReset = () => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        setPhase('idle');
    };

    const baseBtn: React.CSSProperties = {
        padding: '5px 12px',
        fontSize: 12,
        background: 'transparent',
        color: 'var(--ca-text, #d4d4d8)',
        border: '1px solid var(--ca-border, #232429)',
        borderRadius: 4,
        cursor: 'pointer',
    };

    const chipBase: React.CSSProperties = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 9px',
        fontSize: 11,
        fontWeight: 500,
        borderRadius: 4,
    };

    if (phase === 'testing') {
        return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} data-testid="llm-test-testing">
                <span style={{ ...chipBase, background: 'var(--ca-bg-elev, #1c1c1f)', color: 'var(--ca-text-muted, #9ca0a8)' }}>
                    <span aria-hidden style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--ca-accent, #6c72cb)', animation: 'ca-pulse 1.2s ease-in-out infinite' }} />
                    Testing…
                </span>
                <button type="button" onClick={handleCancel} style={baseBtn} aria-label="Cancel connection test">
                    Cancel
                </button>
            </span>
        );
    }

    if (phase === 'timeout') {
        return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} data-testid="llm-test-timeout">
                <span style={{ ...chipBase, background: 'rgba(217,119,6,0.15)', color: 'var(--ca-warning, #d97706)' }}>
                    ⚠ Timed out after {Math.round(timeoutMs / 1000)}s
                </span>
                <button type="button" onClick={handleStart} style={baseBtn} aria-label="Retry connection test">
                    Retry
                </button>
                <button type="button" onClick={handleReset} style={baseBtn} aria-label="Dismiss timeout message">
                    Dismiss
                </button>
            </span>
        );
    }

    if (phase === 'result' && result) {
        if (result.ok) {
            const latency = typeof result.latencyMs === 'number' ? ` · ${result.latencyMs} ms` : '';
            return (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} data-testid="llm-test-ok">
                    <span style={{ ...chipBase, background: 'rgba(79,178,134,0.15)', color: 'var(--ca-added-text, #4fb286)' }}>
                        ✓ {result.message || 'Connected'}{latency}
                    </span>
                    <button type="button" onClick={handleStart} style={baseBtn} aria-label="Test connection again">
                        Test again
                    </button>
                </span>
            );
        }
        return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} data-testid="llm-test-error">
                <span style={{ ...chipBase, background: 'rgba(220,38,38,0.15)', color: 'var(--ca-error-text, #fca5a5)' }}>
                    ✗ {result.message || 'Connection failed'}
                </span>
                <button type="button" onClick={handleStart} style={baseBtn} aria-label="Retry connection test">
                    Retry
                </button>
            </span>
        );
    }

    return (
        <button
            type="button"
            onClick={handleStart}
            style={baseBtn}
            data-testid="llm-test-idle-btn"
            aria-label="Test LLM connection"
            title="Send a probe request to verify the configured LLM endpoint is reachable"
        >
            Test Connection
        </button>
    );
}
