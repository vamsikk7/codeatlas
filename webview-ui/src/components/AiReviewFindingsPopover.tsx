/**
 * AiReviewFindingsPopover.tsx
 *
 * Floating list of the latest findings, anchored under the AI Review card's
 * "Findings" button on the home page. Each row deep-links to the layer that
 * owns the finding via {@link navigateToFinding} — the user's mental model
 * is "I see a count → open the popover → click a finding → land on the
 * exact diagram with the scoped AI Review panel already open".
 *
 * Filters: severity tabs (All / Errors / Warnings / Info) + a quick text
 * search across title + body. List capped at 25 rows for perf — the full
 * panel inside each diagram view shows everything.
 *
 * Features (post-#538/#539/#540/#541):
 *   - Layered summary chip at the top (#538) — pure-JS, <100 words.
 *   - Per-row Resolve / Ignore / Comment / Copy buttons (#539, #540).
 *   - Top "Copy ▾" dropdown for group copy (#540).
 *   - Resizable wrapper, size persisted in sessionStorage (#541).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { subscribe, getState } from './ai-review/aiReviewBus';
import { navigateToFinding, bestBinding } from './ai-review/navigate';
import { summariseByLayer } from './ai-review/summariseByLayer';
import { formatFindingsMd } from './ai-review/formatFindingsMd';
import type { AiReviewFinding, AiReviewSeverity } from './ai-review/types';

const SEV_COLOR: Record<AiReviewSeverity, string> = {
    error: '#ef4444',
    warning: '#f59e0b',
    info: '#3b82f6',
};
const SEV_BG: Record<AiReviewSeverity, string> = {
    error: 'rgba(239,68,68,0.12)',
    warning: 'rgba(245,158,11,0.12)',
    info: 'rgba(59,130,246,0.12)',
};

interface PopoverProps {
    open: boolean;
    onClose: () => void;
    /** Anchor element — popover positions relative to its bottom-left. */
    anchorRef: React.RefObject<HTMLElement | null>;
    /** Inject for tests; defaults to window.vscodeApi.postMessage. */
    postMessage?: (msg: any) => void;
}

type Filter = 'all' | AiReviewSeverity;
type CopyScope = 'all' | 'error' | 'warning' | 'info';
type ToastLevel = 'info' | 'warning' | 'error';

const SIZE_STORAGE_KEY = 'ca-aireview-popover-size';
const DEFAULT_W = 440;
const DEFAULT_H = 520;
const MIN_W = 380;
const MIN_H = 360;

function loadSize(): { w: number; h: number } {
    try {
        if (typeof window === 'undefined' || !window.sessionStorage) return { w: DEFAULT_W, h: DEFAULT_H };
        const raw = window.sessionStorage.getItem(SIZE_STORAGE_KEY);
        if (!raw) return { w: DEFAULT_W, h: DEFAULT_H };
        const parsed = JSON.parse(raw);
        const w = Number(parsed?.w) || DEFAULT_W;
        const h = Number(parsed?.h) || DEFAULT_H;
        return { w: Math.max(MIN_W, w), h: Math.max(MIN_H, h) };
    } catch { return { w: DEFAULT_W, h: DEFAULT_H }; }
}
function saveSize(w: number, h: number): void {
    try { window.sessionStorage?.setItem(SIZE_STORAGE_KEY, JSON.stringify({ w, h })); } catch { /* noop */ }
}

export function AiReviewFindingsPopover({ open, onClose, anchorRef, postMessage }: PopoverProps): React.ReactElement | null {
    const [findings, setFindings] = useState<AiReviewFinding[]>(getState().findings);
    const [filter, setFilter] = useState<Filter>('all');
    const [query, setQuery] = useState('');
    const [toast, setToast] = useState<{ level: ToastLevel; text: string } | null>(null);
    const [copyMenuOpen, setCopyMenuOpen] = useState(false);
    const [commentingId, setCommentingId] = useState<string | null>(null);
    const [commentDraft, setCommentDraft] = useState('');
    // Issue 613-UI — which finding's audit trail is expanded. null = none.
    const [historyId, setHistoryId] = useState<string | null>(null);
    const [size, setSize] = useState(() => loadSize());
    // #536 — stale-finding visibility toggle; default hidden so a drift run
    // doesn't dump 30 ghosts into the popover.
    const [showStale, setShowStale] = useState(false);
    const popoverRef = useRef<HTMLDivElement | null>(null);

    const post = postMessage ?? ((msg: any) => { try { (window as any).vscodeApi?.postMessage(msg); } catch { /* noop */ } });

    useEffect(() => {
        return subscribe((s) => setFindings(s.findings.slice()));
    }, []);

    // Persist size as the user resizes — observe the wrapper.
    useEffect(() => {
        if (!open || !popoverRef.current || typeof ResizeObserver === 'undefined') return;
        const el = popoverRef.current;
        const ro = new ResizeObserver(() => {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                setSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
                saveSize(Math.round(rect.width), Math.round(rect.height));
            }
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [open]);

    // Close on outside-click / Esc.
    useEffect(() => {
        if (!open) return;
        const onDocClick = (e: MouseEvent) => {
            const t = e.target as Node | null;
            if (!t) return;
            if (popoverRef.current?.contains(t)) return;
            if (anchorRef.current?.contains(t)) return;
            onClose();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [open, onClose, anchorRef]);

    const openFindings = useMemo(() => findings.filter((f) => f.status === 'open'), [findings]);
    const staleFindings = useMemo(() => findings.filter((f) => f.status === 'stale'), [findings]);

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        // Stale rows are appended after open rows when the toggle is on; they
        // render dimmed and are excluded from the headline count.
        const pool = showStale ? [...openFindings, ...staleFindings] : openFindings;
        return pool
            .filter((f) => filter === 'all' || f.severity === filter)
            .filter((f) => q === '' || f.title.toLowerCase().includes(q) || f.body.toLowerCase().includes(q) || f.entryPointId.toLowerCase().includes(q))
            .sort((a, b) => {
                // Open before stale.
                if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
                const sevRank = { error: 0, warning: 1, info: 2 } as const;
                if (sevRank[a.severity] !== sevRank[b.severity]) return sevRank[a.severity] - sevRank[b.severity];
                return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
            })
            .slice(0, 50);
    }, [openFindings, staleFindings, filter, query, showStale]);

    const summary = useMemo(() => summariseByLayer(openFindings), [openFindings]);

    function showToast(level: ToastLevel, text: string): void {
        setToast({ level, text });
        setTimeout(() => setToast(null), 2500);
    }

    async function copyToClipboard(md: string, label: string): Promise<void> {
        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(md);
            } else if (typeof document !== 'undefined' && (document as any).execCommand) {
                const ta = document.createElement('textarea');
                ta.value = md;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                (document as any).execCommand('copy');
                document.body.removeChild(ta);
            } else {
                throw new Error('clipboard API unavailable');
            }
            showToast('info', `Copied ${label} — ${md.length.toLocaleString()} chars`);
        } catch (err: any) {
            showToast('error', `Copy failed: ${err?.message ?? err}`);
        }
    }

    function handleCopyGroup(scope: CopyScope): void {
        const subset = scope === 'all' ? openFindings : openFindings.filter((f) => f.severity === scope);
        const md = formatFindingsMd(subset, { headerNote: scope === 'all' ? undefined : `Filtered: ${scope}s only` });
        const label = scope === 'all' ? `${subset.length} findings` : `${subset.length} ${scope}${subset.length === 1 ? '' : 's'}`;
        void copyToClipboard(md, label);
        setCopyMenuOpen(false);
    }
    function handleCopyOne(f: AiReviewFinding): void {
        void copyToClipboard(formatFindingsMd([f]), '1 finding');
    }
    // Issue 612: Download findings.md to disk. Format identical to the
    // group-copy markdown — same `formatFindingsMd` helper feeds the bytes.
    function handleDownloadAll(): void {
        if (openFindings.length === 0) return;
        const md = formatFindingsMd(openFindings, { headerNote: 'CodeAtlas Code Review findings' });
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url;
        a.download = `codeatlas-findings-${ts}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    function handleResolve(f: AiReviewFinding): void {
        post({ type: 'updateAiFindingStatus', findingId: f.id, status: 'resolved' });
    }
    function handleIgnore(f: AiReviewFinding): void {
        post({ type: 'updateAiFindingStatus', findingId: f.id, status: 'ignored' });
    }
    function openComment(f: AiReviewFinding): void {
        setCommentingId(f.id);
        setCommentDraft('');
    }
    function submitComment(f: AiReviewFinding): void {
        const text = commentDraft.trim();
        if (!text) { setCommentingId(null); return; }
        const binding = bestBinding(f);
        if (!binding) return;
        post({
            type: 'addComment',
            layer: binding.layer,
            targetType: binding.targetType,
            targetId: binding.targetId,
            anchor: { filePath: (f.anchor as any)?.filePath ?? '', symbol: (f.anchor as any)?.symbol },
            body: `[AI finding] ${f.title}\n\n${text}`,
            source: 'ai',
        });
        setCommentingId(null);
        setCommentDraft('');
        showToast('info', 'Comment added');
    }

    if (!open) return null;

    return (
        <div
            ref={popoverRef}
            role="dialog"
            aria-label="AI Review findings"
            data-testid="ai-review-findings-popover"
            style={{
                position: 'absolute',
                right: 18, top: 56,
                width: `${size.w}px`,
                height: `${size.h}px`,
                minWidth: `${MIN_W}px`,
                minHeight: `${MIN_H}px`,
                maxWidth: 'min(1024px, calc(100vw - 32px))',
                maxHeight: 'min(900px, calc(100vh - 80px))',
                background: 'var(--ca-surface, #131316)',
                border: '1px solid var(--ca-border, #232429)',
                borderRadius: 8,
                boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
                zIndex: 80,
                display: 'flex', flexDirection: 'column',
                resize: 'both', overflow: 'hidden',
            }}
        >
            {/* Header — Findings label + severity filters + Copy ▾ */}
            <div style={{
                padding: '10px 12px', borderBottom: '1px solid var(--ca-border, #232429)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>Findings</div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    {(['all', 'error', 'warning', 'info'] as Filter[]).map((f) => (
                        <button
                            key={f}
                            type="button"
                            data-testid={`ai-findings-filter-${f}`}
                            onClick={() => setFilter(f)}
                            style={{
                                fontSize: 11, padding: '3px 8px', borderRadius: 4,
                                background: filter === f ? 'var(--ca-accent, #6c72cb)' : 'transparent',
                                color: filter === f ? 'white' : 'var(--ca-text-dim, #9ca0a8)',
                                border: '1px solid ' + (filter === f ? 'var(--ca-accent, #6c72cb)' : 'var(--ca-border, #232429)'),
                                cursor: 'pointer', textTransform: 'capitalize',
                            }}
                        >{f === 'all' ? 'All' : f}</button>
                    ))}
                    {/* #536 — stale toggle (only renders when at least one stale exists) */}
                    {staleFindings.length > 0 && (
                        <button
                            type="button"
                            data-testid="ai-findings-stale-toggle"
                            onClick={() => setShowStale((s) => !s)}
                            title={showStale ? 'Hide stale findings' : 'Show stale findings (from prior baselines)'}
                            style={{
                                fontSize: 11, padding: '3px 8px', borderRadius: 4, marginLeft: 6,
                                background: showStale ? 'var(--ca-accent, #6c72cb)' : 'transparent',
                                color: showStale ? 'white' : 'var(--ca-text-dim, #9ca0a8)',
                                border: '1px solid ' + (showStale ? 'var(--ca-accent, #6c72cb)' : 'var(--ca-border, #232429)'),
                                cursor: 'pointer',
                            }}
                        >{showStale ? `Hide stale (${staleFindings.length})` : `Show stale (${staleFindings.length})`}</button>
                    )}
                    {/* Issue 612 — Download findings.md to disk */}
                    <button
                        type="button"
                        data-testid="ai-findings-download-btn"
                        disabled={openFindings.length === 0}
                        onClick={handleDownloadAll}
                        title="Download findings as Markdown (.md)"
                        style={{
                            fontSize: 11, padding: '3px 8px', borderRadius: 4, marginLeft: 6,
                            background: 'transparent', color: 'var(--ca-text-dim, #9ca0a8)',
                            border: '1px solid var(--ca-border, #232429)',
                            cursor: openFindings.length === 0 ? 'default' : 'pointer',
                            opacity: openFindings.length === 0 ? 0.5 : 1,
                        }}
                    >📥 .md</button>
                    {/* Group-copy dropdown */}
                    <div style={{ position: 'relative', marginLeft: 6 }}>
                        <button
                            type="button"
                            data-testid="ai-findings-copy-btn"
                            disabled={openFindings.length === 0}
                            onClick={() => setCopyMenuOpen((o) => !o)}
                            aria-expanded={copyMenuOpen}
                            title="Copy findings to clipboard"
                            style={{
                                fontSize: 11, padding: '3px 8px', borderRadius: 4,
                                background: 'transparent', color: 'var(--ca-text-dim, #9ca0a8)',
                                border: '1px solid var(--ca-border, #232429)',
                                cursor: openFindings.length === 0 ? 'default' : 'pointer',
                                opacity: openFindings.length === 0 ? 0.5 : 1,
                            }}
                        >📋 Copy ▾</button>
                        {copyMenuOpen && (
                            <div
                                data-testid="ai-findings-copy-menu"
                                style={{
                                    position: 'absolute', top: '100%', right: 0, marginTop: 4,
                                    background: 'var(--ca-surface, #131316)',
                                    border: '1px solid var(--ca-border, #232429)',
                                    borderRadius: 6, boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
                                    zIndex: 90, minWidth: 160,
                                }}
                            >
                                {(['all', 'error', 'warning', 'info'] as CopyScope[]).map((s) => {
                                    const count = s === 'all' ? openFindings.length : openFindings.filter((f) => f.severity === s).length;
                                    return (
                                        <button
                                            key={s}
                                            type="button"
                                            data-testid={`ai-findings-copy-${s}`}
                                            disabled={count === 0}
                                            onClick={() => handleCopyGroup(s)}
                                            style={{
                                                display: 'block', width: '100%', textAlign: 'left',
                                                background: 'transparent', color: 'var(--ca-text, #ececef)',
                                                border: 'none', padding: '8px 12px', fontSize: 12,
                                                cursor: count === 0 ? 'default' : 'pointer',
                                                opacity: count === 0 ? 0.4 : 1,
                                            }}
                                        >{s === 'all' ? `All findings (${count})` : `${s.charAt(0).toUpperCase()}${s.slice(1)}s only (${count})`}</button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* #538 — layered summary chip (renders only when findings exist).
                `white-space: pre-wrap` preserves the newlines + indentation the
                summary helper builds; collapsible so it doesn't dominate the
                popover on small viewports. */}
            {summary && (
                <details
                    data-testid="ai-findings-summary"
                    open
                    style={{
                        borderBottom: '1px solid var(--ca-border, #232429)',
                        background: 'rgba(108,114,203,0.05)',
                    }}
                >
                    <summary style={{
                        cursor: 'pointer',
                        padding: '8px 12px 4px',
                        fontSize: 11, fontWeight: 700,
                        color: 'var(--ca-accent, #6c72cb)',
                        letterSpacing: '0.5px',
                        textTransform: 'uppercase',
                        userSelect: 'none',
                    }}>Summary</summary>
                    <pre
                        data-testid="ai-findings-summary-body"
                        style={{
                            padding: '4px 14px 12px',
                            margin: 0,
                            fontSize: 11, lineHeight: 1.65,
                            color: 'var(--ca-text, #ececef)',
                            fontFamily: 'inherit',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            maxHeight: 280,
                            overflowY: 'auto',
                        }}
                    >{summary}</pre>
                </details>
            )}

            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--ca-border, #232429)' }}>
                <input
                    type="text"
                    placeholder="Search findings…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Filter findings"
                    style={{
                        width: '100%', boxSizing: 'border-box',
                        background: 'var(--ca-bg, #0a0a0b)',
                        color: 'var(--ca-text, #ececef)',
                        border: '1px solid var(--ca-border, #232429)',
                        borderRadius: 6, padding: '6px 10px', fontSize: 12, outline: 'none',
                    }}
                />
            </div>
            <div
                role="list"
                style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}
            >
                {visible.length === 0 ? (
                    <div style={{
                        padding: '24px 16px', textAlign: 'center', fontSize: 12,
                        color: 'var(--ca-text-dim, #9ca0a8)',
                    }}>
                        {findings.length === 0
                            ? 'No findings yet. Start a review above.'
                            : (openFindings.length === 0 && staleFindings.length > 0 && !showStale)
                                ? 'No open findings. Toggle "Show stale" above to see prior findings.'
                                : 'No findings match this filter.'}
                    </div>
                ) : visible.map((f) => {
                    const binding = bestBinding(f);
                    const target = binding ? `${binding.layer.toUpperCase()} · ${truncate(binding.graphId, 38)}` : f.entryPointId;
                    const isCommenting = commentingId === f.id;
                    const isStale = f.status === 'stale';
                    return (
                        <div
                            key={f.id}
                            role="listitem"
                            data-testid={isStale ? 'ai-finding-row-stale' : 'ai-finding-row'}
                            style={{
                                borderBottom: '1px solid rgba(255,255,255,0.04)',
                                padding: '10px 12px',
                                opacity: isStale ? 0.5 : 1,
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                                <span
                                    title={f.severity}
                                    aria-label={f.severity}
                                    style={{
                                        flexShrink: 0, marginTop: 5,
                                        width: 9, height: 9, borderRadius: '50%',
                                        background: SEV_COLOR[f.severity],
                                        boxShadow: `0 0 0 3px ${SEV_BG[f.severity]}`,
                                    }}
                                />
                                <button
                                    type="button"
                                    data-testid="ai-finding-row-open"
                                    onClick={() => { navigateToFinding(f); onClose(); }}
                                    style={{
                                        flex: 1, textAlign: 'left',
                                        background: 'transparent', color: 'var(--ca-text, #ececef)',
                                        border: 'none', padding: 0, cursor: 'pointer',
                                        display: 'block', minWidth: 0,
                                    }}
                                >
                                    <span style={{
                                        display: 'block', fontWeight: 600, fontSize: 12, lineHeight: 1.35,
                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    }}>{f.title}</span>
                                    <span style={{
                                        display: '-webkit-box',
                                        fontSize: 11, color: 'var(--ca-text-dim, #9ca0a8)',
                                        marginTop: 2, lineHeight: 1.4,
                                        overflow: 'hidden',
                                        WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                                    } as React.CSSProperties}>{f.body}</span>
                                    <span style={{
                                        display: 'inline-flex', alignItems: 'center', gap: 6,
                                        marginTop: 4, fontSize: 10,
                                        color: 'var(--ca-text-dim, #9ca0a8)',
                                        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                                        flexWrap: 'wrap',
                                    }}>
                                        <span>{target}</span>
                                        {(f as any).baselineRef?.ref && (
                                            <span
                                                data-testid="ai-finding-baseline-ref"
                                                title={`Reviewed against ${(f as any).baselineRef.kind === 'git' ? 'commit' : 'snapshot'} ${(f as any).baselineRef.ref}${(f as any).baselineRef.capturedAt ? ` · ${new Date((f as any).baselineRef.capturedAt).toLocaleString()}` : ''}`}
                                                style={{
                                                    padding: '1px 6px',
                                                    background: 'rgba(108,114,203,0.14)',
                                                    color: 'var(--ca-accent, #6c72cb)',
                                                    borderRadius: 3, fontSize: 9, fontWeight: 700,
                                                }}
                                            >{(f as any).baselineRef.kind === 'git' ? 'git' : 'snap'}:{(f as any).baselineRef.ref}</span>
                                        )}
                                    </span>
                                </button>
                            </div>
                            {/* Per-row action row */}
                            <div style={{
                                display: 'flex', gap: 6, marginTop: 8, paddingLeft: 19,
                                flexWrap: 'wrap',
                            }}>
                                <ActionBtn testId="ai-finding-resolve" onClick={() => handleResolve(f)} title="Mark resolved">✓ Resolve</ActionBtn>
                                <ActionBtn testId="ai-finding-ignore" onClick={() => handleIgnore(f)} title="Ignore (won't show in counts)">🚫 Ignore</ActionBtn>
                                <ActionBtn testId="ai-finding-comment" onClick={() => openComment(f)} title="Add a comment linked to this finding">💬 Comment</ActionBtn>
                                <ActionBtn testId="ai-finding-copy" onClick={() => handleCopyOne(f)} title="Copy as Markdown">📋 Copy</ActionBtn>
                                {/* Issue 613-UI — show / hide the audit trail (resolve / ignore / reopen
                                    history). The button only renders when there's a multi-entry trail
                                    so single-creation findings don't add noise. */}
                                {Array.isArray(f.auditTrail) && f.auditTrail.length > 1 && (
                                    <ActionBtn
                                        testId="ai-finding-history-btn"
                                        onClick={() => setHistoryId(historyId === f.id ? null : f.id)}
                                        title="Show resolve / ignore / reopen history"
                                    >
                                        📜 History ({f.auditTrail.length})
                                    </ActionBtn>
                                )}
                            </div>
                            {/* Issue 613-UI — expanded audit-trail pane. Shows the
                                resolve / ignore / reopen history in reverse-chronological
                                order so the most recent action is at the top. */}
                            {historyId === f.id && Array.isArray(f.auditTrail) && f.auditTrail.length > 0 && (
                                <div
                                    data-testid="ai-finding-history-pane"
                                    style={{
                                        marginTop: 8, paddingLeft: 19,
                                        borderLeft: '2px solid rgba(108,114,203,0.35)',
                                        marginLeft: 4,
                                    }}
                                >
                                    {[...f.auditTrail].reverse().slice(0, 8).map((entry, idx) => (
                                        <div
                                            key={`${entry.ts}-${idx}`}
                                            data-testid="ai-finding-history-entry"
                                            style={{
                                                fontSize: 10, lineHeight: 1.5,
                                                color: 'var(--ca-text-dim, #9ca0a8)',
                                                padding: '3px 0 3px 8px',
                                                borderBottom: '1px solid rgba(255,255,255,0.04)',
                                            }}
                                        >
                                            <span style={{ color: 'var(--ca-text, #ececef)', fontWeight: 600 }}>
                                                {entry.fromStatus ? `${entry.fromStatus} → ${entry.toStatus}` : `created (${entry.toStatus})`}
                                            </span>
                                            <span style={{ marginLeft: 6 }}>· {entry.actor}</span>
                                            <span style={{ marginLeft: 6, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>
                                                · {new Date(entry.ts).toLocaleString()}
                                            </span>
                                            {entry.note && (
                                                <div style={{
                                                    marginTop: 2, paddingLeft: 12,
                                                    color: 'var(--ca-text-dim, #9ca0a8)',
                                                    fontStyle: 'italic',
                                                }}>“{entry.note}”</div>
                                            )}
                                        </div>
                                    ))}
                                    {f.auditTrail.length > 8 && (
                                        <div style={{ fontSize: 10, padding: '3px 0 3px 8px', color: 'var(--ca-text-dim, #9ca0a8)' }}>
                                            … {f.auditTrail.length - 8} earlier entries hidden
                                        </div>
                                    )}
                                </div>
                            )}
                            {isCommenting && (
                                <div style={{ marginTop: 8, paddingLeft: 19 }}>
                                    <textarea
                                        data-testid="ai-finding-comment-textarea"
                                        autoFocus
                                        value={commentDraft}
                                        onChange={(e) => setCommentDraft(e.target.value)}
                                        rows={2}
                                        placeholder="Your comment…"
                                        style={{
                                            width: '100%', boxSizing: 'border-box',
                                            background: 'var(--ca-bg, #0a0a0b)',
                                            color: 'var(--ca-text, #ececef)',
                                            border: '1px solid var(--ca-border, #232429)',
                                            borderRadius: 6, padding: '6px 8px', fontSize: 12,
                                            resize: 'vertical', minHeight: 40, outline: 'none',
                                            fontFamily: 'inherit',
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Escape') { setCommentingId(null); }
                                            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { submitComment(f); }
                                        }}
                                    />
                                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
                                        <ActionBtn onClick={() => setCommentingId(null)} title="Cancel">Cancel</ActionBtn>
                                        <ActionBtn
                                            testId="ai-finding-comment-submit"
                                            onClick={() => submitComment(f)}
                                            title="Save comment"
                                            primary
                                        >Save</ActionBtn>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            <div style={{
                padding: '8px 12px', borderTop: '1px solid var(--ca-border, #232429)',
                fontSize: 11, color: 'var(--ca-text-dim, #9ca0a8)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
                <span>
                    {visible.length} shown · {openFindings.length} open
                    {staleFindings.length > 0 && <> · {staleFindings.length} stale</>}
                </span>
                <button
                    type="button"
                    onClick={onClose}
                    style={{
                        background: 'transparent', border: 'none',
                        color: 'var(--ca-text-dim, #9ca0a8)', cursor: 'pointer', fontSize: 11,
                    }}
                >Close</button>
            </div>
            {toast && (
                <div
                    data-testid="ai-findings-toast"
                    role="status"
                    style={{
                        position: 'absolute', bottom: 36, left: '50%', transform: 'translateX(-50%)',
                        background: toast.level === 'error' ? '#7f1d1d' : 'var(--ca-accent, #6c72cb)',
                        color: 'white', fontSize: 11, padding: '6px 12px', borderRadius: 6,
                        boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
                        whiteSpace: 'nowrap',
                    }}
                >{toast.text}</div>
            )}
        </div>
    );
}

interface ActionBtnProps {
    children: React.ReactNode;
    onClick: () => void;
    title: string;
    testId?: string;
    primary?: boolean;
}
function ActionBtn({ children, onClick, title, testId, primary }: ActionBtnProps): React.ReactElement {
    return (
        <button
            type="button"
            data-testid={testId}
            onClick={onClick}
            title={title}
            style={{
                fontSize: 10, padding: '3px 7px', borderRadius: 4,
                background: primary ? 'var(--ca-accent, #6c72cb)' : 'transparent',
                color: primary ? 'white' : 'var(--ca-text-dim, #9ca0a8)',
                border: '1px solid ' + (primary ? 'var(--ca-accent, #6c72cb)' : 'var(--ca-border, #232429)'),
                cursor: 'pointer',
            }}
        >{children}</button>
    );
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}
