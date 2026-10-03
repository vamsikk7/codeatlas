/**
 * ExplorerSidebar.tsx
 *
 * Floating collapsible sidebar for browser mode.
 * Shows the 5 explorer views (Services, Features, APIs, Files, Functions)
 * as expandable sections with clickable items.
 * Progressive rendering: shows first 100 items, "Show all" button for the rest.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { formatRepoChipLabel } from '../lib/formatRepoChipLabel';

interface ExplorerItem {
    id: string;
    label: string;
    subtitle?: string;
    diff?: string;
    action?: Record<string, unknown>;
    /** UX-50g (2026-06-06) — owning repo for multi-repo workspaces. When
     *  `repos.length >= 2` the sidebar groups items under repo headers
     *  using this field. Single-repo workspaces leave it undefined. */
    repoId?: string;
}

interface ExplorerData {
    services: ExplorerItem[];
    features: ExplorerItem[];
    apis: ExplorerItem[];
    files: ExplorerItem[];
    functions: ExplorerItem[];
}

/** UX-50g — minimal repo registry the sidebar groups by. Comes from
 *  `App.tsx`'s `workspaceState.repos` when the workspace is multi-repo. */
export interface ExplorerRepoMeta {
    repoId: string;
    name: string;
    rootPath: string;
}

interface ExplorerSidebarProps {
    visible: boolean;
    onToggle: () => void;
    /** UX-50g — pass the repo registry only in multi-repo mode. When
     *  undefined / single entry, sections render flat (zero regression
     *  vs the pre-UX-50g behaviour for single-repo workspaces). */
    repos?: ExplorerRepoMeta[];
}

const INITIAL_RENDER_LIMIT = 100;

function ExplorerSection({ title, items, icon, defaultOpen, loading, repos }: {
    title: string;
    items: ExplorerItem[];
    icon: string;
    defaultOpen?: boolean;
    loading?: boolean;
    /** UX-50g — when supplied with ≥2 entries, items are grouped under
     *  per-repo headers (matching `formatRepoChipLabel`). When omitted or
     *  single-entry, the list renders flat as before. */
    repos?: ExplorerRepoMeta[];
}) {
    const [open, setOpen] = useState(defaultOpen ?? false);
    const [filter, setFilter] = useState('');
    const [focusIndex, setFocusIndex] = useState(-1);
    const [showAll, setShowAll] = useState(false);
    const filterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [debouncedFilter, setDebouncedFilter] = useState('');
    const listRef = useRef<HTMLDivElement>(null);

    // Cleanup debounce timer on unmount
    useEffect(() => () => { if (filterTimer.current) clearTimeout(filterTimer.current); }, []);

    const handleFilterChange = useCallback((value: string) => {
        setFilter(value);
        if (filterTimer.current) clearTimeout(filterTimer.current);
        filterTimer.current = setTimeout(() => setDebouncedFilter(value), 100);
    }, []);

    const filteredItems = useMemo(() => {
        if (!debouncedFilter) return items;
        const q = debouncedFilter.toLowerCase();
        return items.filter(item =>
            item.label.toLowerCase().includes(q) ||
            (item.subtitle?.toLowerCase().includes(q))
        );
    }, [items, debouncedFilter]);

    // Progressive rendering: show first N items, then "Show all" button
    const visibleItems = useMemo(() => {
        if (showAll || debouncedFilter || filteredItems.length <= INITIAL_RENDER_LIMIT) {
            return filteredItems;
        }
        return filteredItems.slice(0, INITIAL_RENDER_LIMIT);
    }, [filteredItems, showAll, debouncedFilter]);

    const hasMore = !showAll && !debouncedFilter && filteredItems.length > INITIAL_RENDER_LIMIT;

    const postMessage = useCallback((msg: any) => {
        (window as any).vscodeApi?.postMessage(msg);
    }, []);

    // Keyboard navigation
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setFocusIndex(i => Math.min(i + 1, visibleItems.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setFocusIndex(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter' && focusIndex >= 0 && focusIndex < visibleItems.length) {
            e.preventDefault();
            const item = visibleItems[focusIndex];
            if (item.action) postMessage(item.action);
        } else if (e.key === 'Escape') {
            setFilter('');
            setDebouncedFilter('');
            setFocusIndex(-1);
        }
    }, [visibleItems, focusIndex, postMessage]);

    useEffect(() => {
        if (focusIndex >= 0 && listRef.current) {
            const el = listRef.current.children[focusIndex] as HTMLElement;
            el?.scrollIntoView({ block: 'nearest' });
        }
    }, [focusIndex]);

    return (
        <div className="ca-explorer-section" onKeyDown={handleKeyDown}>
            <div
                className="ca-explorer-section-header"
                onClick={() => setOpen(!open)}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } }}
            >
                <span className="ca-explorer-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
                <span className="ca-explorer-section-icon" aria-hidden="true">{icon}</span>
                <span className="ca-explorer-section-title">{title}</span>
                <span className="ca-explorer-section-count">
                    {loading ? '...' : items.length}
                </span>
            </div>
            {open && (
                <div className="ca-explorer-section-body">
                    {items.length > 5 && (
                        <input
                            className="ca-explorer-filter"
                            type="text"
                            placeholder={`Filter ${title.toLowerCase()}...`}
                            value={filter}
                            onChange={(e) => handleFilterChange(e.target.value)}
                            aria-label={`Filter ${title}`}
                        />
                    )}
                    {/* Loading state */}
                    {loading && items.length === 0 && (
                        <div className="ca-explorer-loading">
                            <span className="ca-home-spinner" />
                            <span>Loading...</span>
                        </div>
                    )}
                    <div className="ca-explorer-items" ref={listRef} role="listbox" aria-label={title}>
                        {(() => {
                            // UX-50g — render the per-repo grouped view when
                            // ≥2 repos AND at least one item carries a repoId.
                            // Falls back to the flat list (legacy single-repo
                            // shape) in every other case.
                            const groupingEnabled = !!repos && repos.length >= 2
                                && visibleItems.some(it => !!it.repoId);
                            if (!groupingEnabled) {
                                return visibleItems.map((item, i) => (
                                    <div
                                        key={item.id}
                                        className={`ca-explorer-item${i === focusIndex ? ' focused' : ''}`}
                                        onClick={() => item.action && postMessage(item.action)}
                                        onMouseEnter={() => setFocusIndex(i)}
                                        title={item.subtitle || item.label}
                                        role="option"
                                        tabIndex={0}
                                        aria-selected={i === focusIndex}
                                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (item.action) postMessage(item.action); } }}
                                    >
                                        {item.diff && item.diff !== 'unchanged' && (
                                            <span className="ca-explorer-diff-badge" data-diff={item.diff} aria-label={item.diff}>
                                                {item.diff === 'added' ? '+' : item.diff === 'modified' ? '~' : '-'}
                                            </span>
                                        )}
                                        <span className="ca-explorer-item-label">{item.label}</span>
                                        {item.subtitle && (
                                            <span className="ca-explorer-item-subtitle">{item.subtitle}</span>
                                        )}
                                    </div>
                                ));
                            }
                            // Bucket by repoId in repos[] order; tail bucket
                            // collects items whose repoId is unknown or absent.
                            const repoOrder = repos!.map(r => r.repoId);
                            const buckets = new Map<string, ExplorerItem[]>();
                            for (const rid of repoOrder) buckets.set(rid, []);
                            const orphan: ExplorerItem[] = [];
                            for (const it of visibleItems) {
                                if (it.repoId && buckets.has(it.repoId)) {
                                    buckets.get(it.repoId)!.push(it);
                                } else {
                                    orphan.push(it);
                                }
                            }
                            let flatIdx = 0;
                            const out: React.ReactNode[] = [];
                            for (const rid of repoOrder) {
                                const bucket = buckets.get(rid)!;
                                if (bucket.length === 0) continue;
                                const repoMeta = repos!.find(r => r.repoId === rid)!;
                                out.push(
                                    <div
                                        key={`__hdr:${rid}`}
                                        className="ca-explorer-repo-header"
                                        data-testid="ca-explorer-repo-header"
                                        style={{
                                            padding: '4px 8px', fontSize: 10,
                                            fontWeight: 600, opacity: 0.7,
                                            background: 'var(--ca-surface-hover, transparent)',
                                            borderBottom: '1px solid var(--ca-border, #334155)',
                                            marginTop: flatIdx === 0 ? 0 : 4,
                                        }}
                                    >
                                        {formatRepoChipLabel({ repoName: repoMeta.name, rootPath: repoMeta.rootPath, repoId: rid })}
                                        <span style={{ marginLeft: 6, opacity: 0.5 }}>· {bucket.length}</span>
                                    </div>,
                                );
                                for (const item of bucket) {
                                    const myIdx = flatIdx++;
                                    out.push(
                                        <div
                                            key={item.id}
                                            className={`ca-explorer-item${myIdx === focusIndex ? ' focused' : ''}`}
                                            onClick={() => item.action && postMessage(item.action)}
                                            onMouseEnter={() => setFocusIndex(myIdx)}
                                            title={item.subtitle || item.label}
                                            role="option"
                                            tabIndex={0}
                                            aria-selected={myIdx === focusIndex}
                                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (item.action) postMessage(item.action); } }}
                                        >
                                            {item.diff && item.diff !== 'unchanged' && (
                                                <span className="ca-explorer-diff-badge" data-diff={item.diff} aria-label={item.diff}>
                                                    {item.diff === 'added' ? '+' : item.diff === 'modified' ? '~' : '-'}
                                                </span>
                                            )}
                                            <span className="ca-explorer-item-label">{item.label}</span>
                                            {item.subtitle && (
                                                <span className="ca-explorer-item-subtitle">{item.subtitle}</span>
                                            )}
                                        </div>,
                                    );
                                }
                            }
                            if (orphan.length > 0) {
                                out.push(
                                    <div
                                        key="__hdr:__orphan__"
                                        className="ca-explorer-repo-header"
                                        data-testid="ca-explorer-repo-header"
                                        style={{
                                            padding: '4px 8px', fontSize: 10,
                                            fontWeight: 600, opacity: 0.6,
                                            background: 'var(--ca-surface-hover, transparent)',
                                            borderBottom: '1px solid var(--ca-border, #334155)',
                                            marginTop: 4,
                                        }}
                                    >
                                        Unassigned <span style={{ marginLeft: 6, opacity: 0.5 }}>· {orphan.length}</span>
                                    </div>,
                                );
                                for (const item of orphan) {
                                    const myIdx = flatIdx++;
                                    out.push(
                                        <div
                                            key={item.id}
                                            className={`ca-explorer-item${myIdx === focusIndex ? ' focused' : ''}`}
                                            onClick={() => item.action && postMessage(item.action)}
                                            onMouseEnter={() => setFocusIndex(myIdx)}
                                            title={item.subtitle || item.label}
                                            role="option"
                                            tabIndex={0}
                                            aria-selected={myIdx === focusIndex}
                                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (item.action) postMessage(item.action); } }}
                                        >
                                            {item.diff && item.diff !== 'unchanged' && (
                                                <span className="ca-explorer-diff-badge" data-diff={item.diff} aria-label={item.diff}>
                                                    {item.diff === 'added' ? '+' : item.diff === 'modified' ? '~' : '-'}
                                                </span>
                                            )}
                                            <span className="ca-explorer-item-label">{item.label}</span>
                                            {item.subtitle && (
                                                <span className="ca-explorer-item-subtitle">{item.subtitle}</span>
                                            )}
                                        </div>,
                                    );
                                }
                            }
                            return out;
                        })()}
                        {/* Show all button for large lists */}
                        {hasMore && (
                            <button
                                className="ca-explorer-show-all"
                                onClick={() => setShowAll(true)}
                            >
                                Show all {filteredItems.length} items ({filteredItems.length - INITIAL_RENDER_LIMIT} more)
                            </button>
                        )}
                        {!loading && filteredItems.length === 0 && (
                            <div className="ca-explorer-empty">{filter ? 'No matches' : 'No items'}</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export default function ExplorerSidebar({ visible, onToggle, repos }: ExplorerSidebarProps) {
    const [data, setData] = useState<ExplorerData>({
        services: [], features: [], apis: [], files: [], functions: [],
    });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (event.data?.type === 'explorerData') {
                setData(event.data);
                setLoading(false);
            }
        };
        window.addEventListener('message', handleMessage);

        // Request explorer data on mount
        (window as any).vscodeApi?.postMessage({ type: 'requestExplorerData' });

        return () => window.removeEventListener('message', handleMessage);
    }, []);

    return (
        <>
            {visible && (
                <div className="ca-explorer-sidebar" role="navigation" aria-label="Explorer">
                    <div className="ca-explorer-header">
                        <span className="ca-explorer-header-title">Explorer</span>
                        <button className="ca-explorer-close" onClick={onToggle} aria-label="Close Explorer">✕</button>
                    </div>
                    <div className="ca-explorer-body">
                        <ExplorerSection title="Services" icon="🏗" items={data.services} defaultOpen={true} loading={loading} repos={repos} />
                        <ExplorerSection title="Feature Areas" icon="🧩" items={data.features} loading={loading} repos={repos} />
                        <ExplorerSection title="APIs" icon="⚡" items={data.apis} loading={loading} repos={repos} />
                        <ExplorerSection title="Files" icon="📁" items={data.files} loading={loading} repos={repos} />
                        <ExplorerSection title="Functions" icon="𝑓" items={data.functions} loading={loading} repos={repos} />
                    </div>
                </div>
            )}
        </>
    );
}
