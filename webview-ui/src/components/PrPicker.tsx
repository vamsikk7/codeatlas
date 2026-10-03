/**
 * PrPicker.tsx
 *
 * Browser-mode modal for selecting a pull request to compare.
 * Shows a searchable list of open PRs fetched from GitHub API,
 * with a manual number input fallback for closed/old PRs.
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';

export interface PrListItem {
    number: number;
    title: string;
    author: string;
    branch: string;
    updatedAt: string;
    isDraft: boolean;
}

interface PrPickerProps {
    owner: string;
    repo: string;
    prs: PrListItem[];
    gitHubConnected?: boolean;
    editorUriScheme?: string;
    extensionId?: string;
    clientId?: string | null;
    isReplay?: boolean;
    onSelect: (prNumber: number) => void;
    onCancel: () => void;
}

function formatRelativeDate(iso: string): string {
    if (!iso) return '';
    try {
        const ms = Date.now() - new Date(iso).getTime();
        const mins = Math.floor(ms / 60000);
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        if (days < 30) return `${days}d ago`;
        return `${Math.floor(days / 30)}mo ago`;
    } catch { return ''; }
}

export default function PrPicker({ owner, repo, prs, gitHubConnected, editorUriScheme, extensionId, clientId, isReplay, onSelect, onCancel }: PrPickerProps) {
    const [search, setSearch] = useState('');
    const [manualMode, setManualMode] = useState(prs.length === 0);
    const [manualValue, setManualValue] = useState('');
    const [error, setError] = useState<string | null>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const manualRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (manualMode) {
            manualRef.current?.focus();
        } else {
            searchRef.current?.focus();
        }
    }, [manualMode]);

    const filtered = useMemo(() => {
        if (!search) return prs;
        const q = search.toLowerCase();
        return prs.filter(pr =>
            pr.title.toLowerCase().includes(q) ||
            String(pr.number).includes(q) ||
            pr.author.toLowerCase().includes(q) ||
            pr.branch.toLowerCase().includes(q)
        );
    }, [prs, search]);

    const handleManualSubmit = () => {
        const trimmed = manualValue.trim();
        if (!/^\d+$/.test(trimmed)) {
            setError('Enter a numeric PR number');
            return;
        }
        onSelect(parseInt(trimmed, 10));
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') onCancel();
        if (e.key === 'Enter' && manualMode) handleManualSubmit();
    };

    /**
     * Open the editor's deep link so the OS focuses VS Code/Cursor/etc.
     * BEFORE the auth dialog appears. The URI handler in the extension picks
     * up `/connect-github` and runs the same flow the WS message would have.
     * Falls back to the WS path when the editor URI scheme is unknown
     * (older extension build or unsupported environment).
     */
    const handleConnect = () => {
        if (editorUriScheme && extensionId) {
            const cid = clientId ? `?cid=${encodeURIComponent(clientId)}` : '';
            window.location.href = `${editorUriScheme}://${extensionId}/connect-github${cid}`;
        } else {
            (window as any).vscodeApi?.postMessage({ type: 'connectGitHub' });
        }
    };

    const titlePrefix = isReplay ? 'Replay PR' : 'PR Diff';
    const actionText = isReplay ? 'Replay' : 'Compare';

    return (
        <div className="ca-modal-overlay" onClick={onCancel}>
            <div className="ca-modal" onClick={e => e.stopPropagation()} onKeyDown={handleKeyDown}>
                <div className="ca-modal-header">
                    <h3>{titlePrefix} — {owner}/{repo}</h3>
                    <button className="ca-modal-close" onClick={onCancel} aria-label="Close">x</button>
                </div>
                {!gitHubConnected && (
                    <div className="ca-pr-auth-warning">
                        <span>Not connected to GitHub — private repo access limited</span>
                        <button className="ca-pr-auth-connect" onClick={handleConnect}>Connect</button>
                    </div>
                )}

                {!manualMode ? (
                    <>
                        {/* Search input */}
                        <input
                            ref={searchRef}
                            className="ca-modal-search"
                            type="text"
                            placeholder="Search PRs by title, number, or author..."
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                        />

                        {/* PR list */}
                        <div className="ca-modal-list">
                            {filtered.map(pr => (
                                <button
                                    key={pr.number}
                                    className="ca-modal-list-item"
                                    onClick={() => onSelect(pr.number)}
                                >
                                    <span className="ca-commit-hash" style={{ minWidth: 44 }}>#{pr.number}</span>
                                    <span className="ca-commit-subject">
                                        {pr.isDraft && <span style={{ opacity: 0.5, marginRight: 4 }}>DRAFT</span>}
                                        {pr.title}
                                    </span>
                                    <span className="ca-commit-meta">
                                        {pr.author} · {pr.branch} · {formatRelativeDate(pr.updatedAt)}
                                    </span>
                                </button>
                            ))}
                            {filtered.length === 0 && prs.length > 0 && (
                                <div className="ca-modal-empty">No PRs match "{search}"</div>
                            )}
                            {prs.length === 0 && (
                                <div className="ca-modal-empty">No open pull requests found. Enter a PR number manually below.</div>
                            )}
                        </div>

                        {/* Toggle to manual entry */}
                        <div className="ca-modal-footer" style={{ justifyContent: 'space-between' }}>
                            <button
                                className="ca-modal-btn"
                                style={{ fontSize: 11, color: 'var(--ca-accent)' }}
                                onClick={() => setManualMode(true)}
                            >
                                Enter PR number manually
                            </button>
                            <button className="ca-modal-btn" onClick={onCancel}>Cancel</button>
                        </div>
                    </>
                ) : (
                    <>
                        {/* Manual number input mode */}
                        <div className="ca-modal-body">
                            <label className="ca-modal-label">Pull request number</label>
                            <input
                                ref={manualRef}
                                className="ca-modal-input"
                                type="text"
                                inputMode="numeric"
                                placeholder="123"
                                value={manualValue}
                                onChange={e => { setManualValue(e.target.value); setError(null); }}
                            />
                            {error && <div className="ca-modal-error">{error}</div>}
                        </div>
                        <div className="ca-modal-footer">
                            {prs.length > 0 && (
                                <button className="ca-modal-btn" onClick={() => setManualMode(false)}>Back to list</button>
                            )}
                            <button className="ca-modal-btn" onClick={onCancel}>Cancel</button>
                            <button className="ca-modal-btn ca-modal-btn-primary" onClick={handleManualSubmit}>{actionText}</button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
