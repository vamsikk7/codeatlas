/**
 * SearchPicker.tsx
 *
 * Universal browser-mode search/picker modal. Replaces VS Code's showQuickPick
 * for search, function flow, and impact analysis file selection.
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';

export interface PickerItem {
    id: string;
    label: string;
    description: string;
    kind: string;
    /** UX-73 (2026-06-09) — owning repo for the per-repo scope toggle. */
    repoId?: string;
}

interface SearchPickerProps {
    title: string;
    placeholder: string;
    items: PickerItem[];
    onSelect: (item: PickerItem) => void;
    onCancel: () => void;
    /** UX-73 (2026-06-09) — current URL-hash scope. When set, the picker
     *  renders an "in this repo" checkbox that defaults ON and filters
     *  the list to items whose `repoId` matches. Items without a repoId
     *  pass through unconditionally (workspace-wide singletons). */
    scope?: string | null;
    /** Display name for the scope, used in the checkbox label. */
    scopeLabel?: string;
}

const KIND_ICONS: Record<string, string> = {
    API: '~',
    File: '#',
    Cluster: '@',
    Service: '*',
    Function: 'f',
};

export default function SearchPicker({ title, placeholder, items, onSelect, onCancel, scope, scopeLabel }: SearchPickerProps) {
    const [search, setSearch] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const searchRef = useRef<HTMLInputElement>(null);
    // UX-73 (2026-06-09) — "in this repo" toggle. Defaults ON when the
    // current URL hash carries a scope so the most common case ("I'm in
    // the api-svc scope, I want to search api-svc files") needs no clicks.
    // The user can flip it off to widen the search workspace-wide.
    const [inScope, setInScope] = useState<boolean>(Boolean(scope));

    useEffect(() => { searchRef.current?.focus(); }, []);
    // Re-default to ON whenever the scope changes (e.g. user navigates
    // to a different repo and then opens search).
    useEffect(() => { setInScope(Boolean(scope)); }, [scope]);

    const filtered = useMemo(() => {
        let base = items;
        if (scope && inScope) {
            // Keep items that belong to the active scope OR carry no repoId
            // (workspace-wide entries like "view all services" that should
            // always be visible).
            base = items.filter(item => !item.repoId || item.repoId === scope);
        }
        if (!search) return base;
        const q = search.toLowerCase();
        return base.filter(item =>
            item.label.toLowerCase().includes(q) ||
            item.description.toLowerCase().includes(q) ||
            item.kind.toLowerCase().includes(q)
        );
    }, [items, search, scope, inScope]);

    useEffect(() => { setSelectedIndex(0); }, [filtered]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(i => Math.min(i + 1, filtered.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter' && filtered[selectedIndex]) {
            onSelect(filtered[selectedIndex]);
        } else if (e.key === 'Escape') {
            onCancel();
        }
    };

    return (
        <div className="ca-modal-overlay" onClick={onCancel}>
            <div className="ca-modal" onClick={e => e.stopPropagation()} onKeyDown={handleKeyDown}>
                <div className="ca-modal-header">
                    <h3>{title}</h3>
                    <button className="ca-modal-close" onClick={onCancel} aria-label="Close">x</button>
                </div>
                <input
                    ref={searchRef}
                    className="ca-modal-search"
                    type="text"
                    placeholder={placeholder}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                />
                {scope && (
                    <label
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
                        data-testid="ca-picker-scope-toggle"
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
                <div className="ca-modal-list">
                    {filtered.map((item, i) => (
                        <button
                            key={`${item.kind}-${item.id}`}
                            className={`ca-modal-list-item${i === selectedIndex ? ' selected' : ''}`}
                            onClick={() => onSelect(item)}
                            onMouseEnter={() => setSelectedIndex(i)}
                        >
                            <span className="ca-picker-kind">{KIND_ICONS[item.kind] ?? item.kind[0]}</span>
                            <span className="ca-commit-subject">{item.label}</span>
                            <span className="ca-commit-meta">{item.description}</span>
                        </button>
                    ))}
                    {filtered.length === 0 && (
                        <div className="ca-modal-empty">No results for "{search}"</div>
                    )}
                </div>
                <div className="ca-modal-footer">
                    <span style={{ flex: 1, fontSize: 10, color: 'var(--ca-text-muted)' }}>
                        {filtered.length} item{filtered.length !== 1 ? 's' : ''}
                    </span>
                    <button className="ca-modal-btn" onClick={onCancel}>Cancel</button>
                </div>
            </div>
        </div>
    );
}
