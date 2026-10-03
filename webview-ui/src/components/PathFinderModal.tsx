/**
 * PathFinderModal.tsx — Issue #707 Path Finder UI.
 *
 * Single-modal flow: the user picks a source function and a target
 * function from the workspace's discovered functions, hits "Find Path",
 * and the modal renders the call-graph path returned by the
 * `findCallPath` server handler.
 *
 * MVP scope:
 *   - Two text-filter pickers for source + target (no right-click
 *     context menu integration yet — that's a follow-up).
 *   - "Find Path" sends `findCallPath` → server calls `traceCallPath` →
 *     broadcasts `callPathResult`.
 *   - Result panel lists each hop as `<file>::<fn>` with the
 *     edge-kind chip; empty result + truncated state surface as
 *     status banners.
 *   - Each hop is clickable — opens the flow graph for that function.
 */

import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';

export interface FunctionItem {
    id: string;        // `${filePath}:${functionName}`
    label: string;     // function name
    subtitle?: string; // file basename
    /** UX-73 (2026-06-10) — owning sub-repo for per-scope filtering. */
    repoId?: string;
}

interface PathStep {
    from: string;
    to: string;
    toFile: string;
    toFunction: string;
    confidence?: number;
    kind?: 'calls' | 'imports';
}

interface PathResult {
    fromKey: string;
    toKey: string;
    path: PathStep[];
    visited: number;
    truncated: boolean;
}

interface PathFinderModalProps {
    functions: FunctionItem[];
    initialResult: PathResult | null;
    /** Send a message to the extension/server. */
    postMessage: (msg: any) => void;
    /** Open the flow graph for the picked hop. */
    onOpenFlow: (filePath: string, functionName: string) => void;
    onCancel: () => void;
    /**
     * UX-73 (2026-06-10) — current URL-hash scope. When set the modal
     * renders an "in this repo" toggle that filters the candidate
     * lists by `repoId === scope`. Defaults ON (workspace-wide path
     * finds are rarely what the user wants when they're inside a
     * specific sub-repo).
     */
    scope?: string;
    /** Display label for the scope chip (falls back to scope). */
    scopeLabel?: string;
}

function FunctionPicker({
    label,
    value,
    functions,
    onSelect,
    autoFocus,
}: {
    label: string;
    value: FunctionItem | null;
    functions: FunctionItem[];
    onSelect: (item: FunctionItem) => void;
    autoFocus?: boolean;
}) {
    const [filter, setFilter] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (autoFocus) inputRef.current?.focus();
    }, [autoFocus]);

    const matches = useMemo(() => {
        if (!filter.trim()) return functions.slice(0, 50);
        const q = filter.toLowerCase();
        return functions
            .filter(f => f.label.toLowerCase().includes(q) || (f.subtitle?.toLowerCase().includes(q) ?? false))
            .slice(0, 50);
    }, [filter, functions]);

    return (
        <div className="ca-pf-picker">
            <div className="ca-pf-picker-label">{label}</div>
            {value ? (
                <div className="ca-pf-selected">
                    <div className="ca-pf-selected-text">
                        <span className="ca-pf-selected-fn">{value.label}</span>
                        {value.subtitle && <span className="ca-pf-selected-file">{value.subtitle}</span>}
                    </div>
                    <button
                        type="button"
                        className="ca-pf-clear-btn"
                        onClick={() => { setFilter(''); onSelect({ id: '', label: '', subtitle: '' }); }}
                        aria-label={`Clear ${label}`}
                    >
                        ✕
                    </button>
                </div>
            ) : (
                <>
                    <input
                        ref={inputRef}
                        className="ca-pf-input"
                        placeholder={`Filter functions…`}
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        aria-label={`${label} function filter`}
                    />
                    <div className="ca-pf-list" role="listbox" aria-label={`${label} candidates`}>
                        {matches.map(fn => (
                            <button
                                key={fn.id}
                                type="button"
                                className="ca-pf-list-item"
                                onClick={() => onSelect(fn)}
                                role="option"
                                aria-selected={false}
                            >
                                <span className="ca-pf-list-fn">{fn.label}</span>
                                {fn.subtitle && <span className="ca-pf-list-file">{fn.subtitle}</span>}
                            </button>
                        ))}
                        {matches.length === 0 && (
                            <div className="ca-pf-empty">No functions match.</div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

export default function PathFinderModal({
    functions,
    initialResult,
    postMessage,
    onOpenFlow,
    onCancel,
    scope,
    scopeLabel,
}: PathFinderModalProps) {
    const [from, setFrom] = useState<FunctionItem | null>(null);
    const [to, setTo] = useState<FunctionItem | null>(null);
    const [maxDepth, setMaxDepth] = useState(8);
    const [pending, setPending] = useState(false);
    const [result, setResult] = useState<PathResult | null>(initialResult);
    // UX-73 (2026-06-10) — per-scope toggle. Defaults ON when scope is
    // set so the "I'm inside api-svc, find a path from foo→bar" flow
    // works without any explicit clicks. The user can flip it off to
    // widen the search to cross-repo workspace-wide paths.
    const [inScope, setInScope] = useState<boolean>(Boolean(scope));
    useEffect(() => { setInScope(Boolean(scope)); }, [scope]);
    const scopedFunctions = useMemo(() => {
        if (!scope || !inScope) return functions;
        return functions.filter(f => !f.repoId || f.repoId === scope);
    }, [functions, scope, inScope]);

    useEffect(() => {
        // The server's response lands as `callPathResult` and the parent
        // App.tsx updates `initialResult`. Mirror that into local state
        // so the inline panel re-renders + we can clear `pending`.
        setResult(initialResult);
        if (initialResult !== null) setPending(false);
    }, [initialResult]);

    const handleFind = useCallback(() => {
        if (!from?.id || !to?.id || from.id === to.id) return;
        const [fromFile, fromFn] = splitId(from.id);
        const [toFile, toFn] = splitId(to.id);
        if (!fromFile || !fromFn || !toFile || !toFn) return;
        setPending(true);
        setResult(null);
        postMessage({ type: 'findCallPath', fromFile, fromFn, toFile, toFn, maxDepth });
    }, [from, to, maxDepth, postMessage]);

    const canFind = Boolean(from?.id && to?.id && from?.id !== to?.id);
    const noPath = result !== null && result.path.length === 0 && !pending;

    return (
        <div className="ca-modal-overlay ca-pf-overlay" role="dialog" aria-modal="true" aria-label="Find call path">
            <div className="ca-modal ca-pf-modal">
                <header className="ca-pf-header">
                    <span className="ca-pf-title">Find Call Path</span>
                    <button
                        type="button"
                        className="ca-pf-close"
                        onClick={onCancel}
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </header>

                {scope && (
                    <label
                        data-testid="ca-pf-scope-toggle"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 14px',
                            fontSize: 12,
                            color: 'var(--ca-text-muted)',
                            cursor: 'pointer',
                            userSelect: 'none',
                        }}
                    >
                        <input
                            type="checkbox"
                            checked={inScope}
                            onChange={e => setInScope(e.target.checked)}
                        />
                        <span>
                            Search only in <strong style={{ color: 'var(--ca-text)' }}>{scopeLabel ?? scope}</strong>
                        </span>
                    </label>
                )}
                <div className="ca-pf-pickers">
                    <FunctionPicker
                        label="From"
                        value={from}
                        functions={scopedFunctions}
                        onSelect={item => setFrom(item.id ? item : null)}
                        autoFocus
                    />
                    <div className="ca-pf-arrow" aria-hidden="true">→</div>
                    <FunctionPicker
                        label="To"
                        value={to}
                        functions={scopedFunctions}
                        onSelect={item => setTo(item.id ? item : null)}
                    />
                </div>

                <div className="ca-pf-controls">
                    <label className="ca-pf-depth">
                        Max depth
                        <input
                            type="number"
                            min={1}
                            max={20}
                            value={maxDepth}
                            onChange={e => setMaxDepth(clamp(Number(e.target.value) || 8, 1, 20))}
                            aria-label="Maximum BFS depth"
                        />
                    </label>
                    <button
                        type="button"
                        className="ca-pf-find-btn"
                        onClick={handleFind}
                        disabled={!canFind || pending}
                    >
                        {pending ? 'Finding…' : 'Find Path'}
                    </button>
                </div>

                {result && result.path.length > 0 && (
                    <div className="ca-pf-result">
                        <div className="ca-pf-result-header">
                            <strong>{result.path.length} hop{result.path.length === 1 ? '' : 's'}</strong>
                            <span className="ca-pf-result-meta">visited {result.visited}</span>
                            {result.truncated && (
                                <span className="ca-pf-result-warning">truncated at depth {maxDepth}</span>
                            )}
                        </div>
                        <ol className="ca-pf-path">
                            {result.path.map((step, i) => (
                                <li key={`${step.from}->${step.to}::${i}`} className="ca-pf-step">
                                    <button
                                        type="button"
                                        className="ca-pf-step-btn"
                                        onClick={() => onOpenFlow(step.toFile, step.toFunction)}
                                        title={`Open ${step.toFunction} in flow view`}
                                    >
                                        <span className="ca-pf-step-fn">{step.toFunction}</span>
                                        <span className="ca-pf-step-file">{step.toFile.split('/').pop()}</span>
                                    </button>
                                    {step.kind && (
                                        <span className={`ca-pf-step-kind kind-${step.kind}`}>{step.kind}</span>
                                    )}
                                    {typeof step.confidence === 'number' && step.confidence < 1 && (
                                        <span className="ca-pf-step-conf">{Math.round(step.confidence * 100)}%</span>
                                    )}
                                </li>
                            ))}
                        </ol>
                    </div>
                )}

                {noPath && (
                    <div className="ca-pf-no-path">
                        No call path found within depth {maxDepth}. Try a higher depth or a closer target.
                    </div>
                )}
            </div>
        </div>
    );
}

function splitId(id: string): [string, string] {
    const idx = id.lastIndexOf(':');
    if (idx <= 0) return ['', ''];
    return [id.slice(0, idx), id.slice(idx + 1)];
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, n));
}
