/**
 * ScopePicker.tsx — UX-50a (2026-06-06)
 *
 * Per-layer scope picker for the HomePage cards. The component is
 * deliberately layer-agnostic: each card supplies its own item list
 * (services / clusters / files / functions) plus the on-pick callback;
 * the picker handles search, keyboard nav, the multi-repo grouping
 * column, and the single-item shortcut (skip the modal when only one
 * item is available).
 *
 * Rendering rules:
 *  - `items.length === 1`  → the caller is expected to skip the modal
 *                            and dispatch directly. The component still
 *                            renders if mounted, but tests assert the
 *                            HomePage gates it before mounting.
 *  - `groupBy === 'repo'`  → items grouped under repo headers. Group
 *                            headers come from `repos[]`. Items without
 *                            a known repoId land under an "Unknown" tail
 *                            group so we never silently hide them.
 *  - `groupBy === null`    → flat list (used in single-repo workspaces).
 *
 * Keyboard: ArrowUp/Down navigate, Enter picks, Escape cancels.
 * Click on the overlay also cancels (mirrors SearchPicker convention).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { formatRepoChipLabel, type RepoChipMeta } from '../lib/formatRepoChipLabel';

export interface ScopePickerItem {
    id: string;
    label: string;
    /** Single-line meta shown to the right of the label (e.g. file path or "5 APIs"). */
    subtitle?: string;
    /** Set in multi-repo workspaces so the picker can group + render the chip. */
    repoId?: string;
    /** Pass-through diff state for visual cues; not required. */
    diff?: string;
    /** Opaque payload the caller dispatches verbatim on pick. */
    action?: unknown;
}

export interface ScopePickerRepoMeta extends RepoChipMeta {
    repoId: string;
}

export interface ScopePickerProps {
    title: string;
    placeholder?: string;
    items: ScopePickerItem[];
    /** Optional repo registry; required when `groupBy === 'repo'`. */
    repos?: ScopePickerRepoMeta[];
    /** When 'repo', renders section headers per repo. Null → flat list. */
    groupBy: 'repo' | null;
    onPick: (item: ScopePickerItem) => void;
    onCancel: () => void;
    /** Optional empty-state caption. */
    emptyLabel?: string;
}

export default function ScopePicker({
    title, placeholder, items, repos, groupBy, onPick, onCancel, emptyLabel,
}: ScopePickerProps) {
    const [search, setSearch] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const searchRef = useRef<HTMLInputElement>(null);
    useEffect(() => { searchRef.current?.focus(); }, []);

    // Flat-filtered list — used for both the selectedIndex calc and the
    // grouped renderer (which still picks from the same filtered slice
    // before bucketing, so search hits across all groups).
    const filtered = useMemo(() => {
        if (!search) return items;
        const q = search.toLowerCase();
        return items.filter(it =>
            it.label.toLowerCase().includes(q) ||
            (it.subtitle ?? '').toLowerCase().includes(q),
        );
    }, [items, search]);
    useEffect(() => { setSelectedIndex(0); }, [filtered]);

    // Build the bucketed view when grouping. Items without a known repoId
    // go to a tail "Unknown" bucket. Within each bucket, order matches the
    // filtered list order so the global keyboard selection stays sensible.
    const groups = useMemo(() => {
        if (groupBy !== 'repo') return null;
        const repoIdToMeta = new Map<string, ScopePickerRepoMeta>(
            (repos ?? []).map(r => [r.repoId, r] as const),
        );
        type Bucket = { repoId: string | null; meta: ScopePickerRepoMeta | null; items: ScopePickerItem[] };
        const map = new Map<string | null, Bucket>();
        for (const it of filtered) {
            const key = it.repoId ?? null;
            const existing = map.get(key);
            if (existing) { existing.items.push(it); continue; }
            map.set(key, {
                repoId: key,
                meta: key && repoIdToMeta.has(key) ? repoIdToMeta.get(key)! : null,
                items: [it],
            });
        }
        // Stable order: registered repos first (matching repos[] order),
        // then unknown-bucket at the tail.
        const ordered: Bucket[] = [];
        for (const r of repos ?? []) {
            const b = map.get(r.repoId);
            if (b) { ordered.push(b); map.delete(r.repoId); }
        }
        for (const b of map.values()) ordered.push(b);
        return ordered;
    }, [filtered, groupBy, repos]);

    const handleKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(i => Math.min(i + 1, filtered.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter' && filtered[selectedIndex]) {
            onPick(filtered[selectedIndex]);
        } else if (e.key === 'Escape') {
            onCancel();
        }
    };

    const renderItemRow = (it: ScopePickerItem, flatIdx: number): React.ReactNode => (
        <button
            key={it.id}
            type="button"
            className={`ca-modal-list-item${flatIdx === selectedIndex ? ' selected' : ''}`}
            onClick={() => onPick(it)}
            onMouseEnter={() => setSelectedIndex(flatIdx)}
            data-testid="ca-scope-picker-item"
            data-scope-item-id={it.id}
        >
            <span className="ca-commit-subject" data-testid="ca-scope-item-label">{it.label}</span>
            {it.subtitle && <span className="ca-commit-meta">{it.subtitle}</span>}
            {it.diff && it.diff !== 'unchanged' && (
                <span className="ca-modal-list-item-diff" data-diff={it.diff} style={{ marginLeft: 8, fontSize: 11 }}>
                    {it.diff === 'added' ? '+' : it.diff === 'deleted' ? '−' : '~'}
                </span>
            )}
        </button>
    );

    // Index each filtered item to its position in the flat list so
    // the keyboard selection stays globally consistent across groups.
    const flatIndexById = useMemo(() => {
        const m = new Map<string, number>();
        filtered.forEach((it, i) => m.set(it.id, i));
        return m;
    }, [filtered]);

    return (
        <div
            className="ca-modal-overlay"
            onClick={onCancel}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            data-testid="ca-scope-picker"
        >
            <div className="ca-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
                <div className="ca-modal-header">
                    <h3>{title}</h3>
                    <button
                        className="ca-modal-close"
                        onClick={onCancel}
                        aria-label="Close"
                        data-testid="ca-scope-picker-close"
                    >
                        x
                    </button>
                </div>
                <input
                    ref={searchRef}
                    className="ca-modal-search"
                    type="text"
                    placeholder={placeholder ?? 'Type to filter…'}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Filter items"
                    data-testid="ca-scope-picker-search"
                />
                <div className="ca-modal-list" data-testid="ca-scope-picker-list">
                    {filtered.length === 0 && (
                        <div className="ca-modal-empty">{emptyLabel ?? `No items match "${search}"`}</div>
                    )}
                    {filtered.length > 0 && groups && (
                        <>
                            {groups.map(group => (
                                <div key={group.repoId ?? '__unknown__'} data-testid="ca-scope-picker-group">
                                    <div
                                        className="ca-scope-picker-group-header"
                                        data-testid="ca-scope-picker-group-header"
                                        style={{
                                            position: 'sticky', top: 0,
                                            padding: '6px 10px', fontSize: 11,
                                            fontWeight: 600, opacity: 0.75,
                                            background: 'var(--ca-surface-hover, #1f2937)',
                                            borderBottom: '1px solid var(--ca-border, #334155)',
                                        }}
                                    >
                                        {group.meta
                                            ? formatRepoChipLabel(group.meta)
                                            : 'Unassigned'}
                                        <span style={{ marginLeft: 6, opacity: 0.6 }}>· {group.items.length}</span>
                                    </div>
                                    {group.items.map(it => renderItemRow(it, flatIndexById.get(it.id) ?? 0))}
                                </div>
                            ))}
                        </>
                    )}
                    {filtered.length > 0 && !groups && (
                        filtered.map((it, i) => renderItemRow(it, i))
                    )}
                </div>
                <div className="ca-modal-footer">
                    <span style={{ flex: 1, fontSize: 10, color: 'var(--ca-text-muted)' }}>
                        {filtered.length} of {items.length}
                    </span>
                    <button
                        className="ca-modal-btn"
                        onClick={onCancel}
                        data-testid="ca-scope-picker-cancel"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
}
