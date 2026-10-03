/**
 * PrWatcherCard.tsx — #851 (2026-06-12, ADR-045).
 *
 * Home-page card controlling the PR watcher for the current repo: when ON,
 * the backend polls GitHub for open pull requests and posts a CodeAtlas
 * review (inline comments + summary, ADR-044) once per PR head sha.
 *
 * Status is driven by the `prWatcherStatus` WS message — broadcast on
 * request, after a toggle, and on every watcher state change (poll
 * start/end). `status: null` means this surface can't run a watcher.
 */
import React, { useEffect, useState } from 'react';

export interface PrWatcherStatusWire {
    enabled: boolean;
    repoSlug: string | null;
    tokenPresent: boolean;
    llmKeyPresent: boolean;
    intervalMs: number;
    lastPollAt: number | null;
    lastResult: string | null;
    lastError: string | null;
    reviewedCount: number;
    polling: boolean;
}

interface PrWatcherCardProps {
    postMessage: (msg: any) => void;
}

function prereqWarning(s: PrWatcherStatusWire): string | null {
    if (!s.repoSlug) return 'No GitHub remote detected on this repo.';
    if (!s.tokenPresent) return 'No GitHub token — set GITHUB_TOKEN (or sign in to GitHub in VS Code).';
    if (!s.llmKeyPresent) return 'No LLM API key — configure one in the LLM section below.';
    return null;
}

export function PrWatcherCard({ postMessage }: PrWatcherCardProps) {
    const [status, setStatus] = useState<PrWatcherStatusWire | null | undefined>(undefined);

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const msg = event.data;
            if (msg?.type === 'prWatcherStatus') {
                setStatus(msg.status ?? null);
            }
        };
        window.addEventListener('message', onMessage);
        postMessage({ type: 'getPrWatcherStatus' });
        return () => window.removeEventListener('message', onMessage);
        // postMessage is stable (useCallback in HomePage) — mount-only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Surface can't run a watcher (or hasn't answered yet) — render nothing
    // rather than a dead control.
    if (status === undefined || status === null) return null;

    const warning = prereqWarning(status);
    const toggle = () => postMessage({ type: 'setPrWatcherEnabled', enabled: !status.enabled });

    return (
        <div
            className="ca-prwatcher-card"
            data-testid="pr-watcher-card"
            style={{
                background: 'var(--ca-surface, #131316)',
                border: '1px solid var(--ca-border, #232429)',
                borderRadius: 8,
                padding: '12px 14px',
                marginTop: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span aria-hidden="true">🔁</span>
                <span style={{ fontWeight: 600, color: 'var(--ca-text)' }}>PR Watcher</span>
                {status.enabled && (
                    <span style={{
                        fontSize: 11, padding: '1px 8px', borderRadius: 10,
                        background: status.polling ? 'rgba(108,114,203,0.18)' : 'rgba(16,185,129,0.18)',
                        color: status.polling ? 'var(--ca-accent, #6c72cb)' : 'var(--ca-success, #10b981)',
                    }}>
                        {status.polling ? 'polling…' : 'watching'}
                    </span>
                )}
                <button
                    data-testid="pr-watcher-toggle"
                    onClick={toggle}
                    title={status.enabled
                        ? 'Stop watching — no more automatic PR reviews.'
                        : 'Start watching — open PRs get a CodeAtlas review automatically.'}
                    style={{
                        marginLeft: 'auto',
                        fontSize: 12,
                        padding: '3px 12px',
                        borderRadius: 12,
                        cursor: 'pointer',
                        border: '1px solid var(--ca-border, #232429)',
                        background: status.enabled ? 'rgba(16,185,129,0.18)' : 'transparent',
                        color: status.enabled ? 'var(--ca-success, #10b981)' : 'var(--ca-text-muted, #9ca0a8)',
                    }}
                >
                    {status.enabled ? 'On' : 'Off'}
                </button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--ca-text-dim, #9ca0a8)' }}>
                {status.repoSlug
                    ? <>Auto-reviews open PRs on <code>{status.repoSlug}</code> — inline comments + an updating summary, once per push.</>
                    : 'Auto-reviews open pull requests on this repo.'}
            </div>
            {warning && (
                <div data-testid="pr-watcher-warning" style={{ fontSize: 12, color: 'var(--ca-warning, #f59e0b)' }}>
                    ⚠️ {warning}
                </div>
            )}
            {status.enabled && status.lastResult && (
                <div data-testid="pr-watcher-result" style={{ fontSize: 12, color: 'var(--ca-text-muted, #9ca0a8)' }}>
                    Last poll: {status.lastResult}
                </div>
            )}
            {status.lastError && !warning && (
                <div data-testid="pr-watcher-error" style={{ fontSize: 12, color: 'var(--ca-error, #ef4444)' }}>
                    {status.lastError}
                </div>
            )}
            {status.reviewedCount > 0 && (
                <div style={{ fontSize: 11, color: 'var(--ca-text-dim, #9ca0a8)' }}>
                    {status.reviewedCount} PR head{status.reviewedCount === 1 ? '' : 's'} reviewed so far.
                </div>
            )}
        </div>
    );
}
