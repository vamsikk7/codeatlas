/**
 * DiffFocusBar.tsx — the L2 api-list "diff focus" UI: change-filter chips
 * (feature #1), a jump-to-next-change stepper (feature #4), and a scrollbar
 * change minimap (feature #3). Pure presentation over the tested `diffFocus`
 * logic; each view (FeatureApiListView, ApiListPanel) owns the filter state +
 * scroll container and drops these in. Shown only when there are changes.
 */
import React, { useCallback, useLayoutEffect, useState } from 'react';
import { ChangeCounts, ChangeFilter, ChangeKind } from '../lib/diffFocus';

const KIND_COLOR: Record<ChangeKind, string> = {
    added: 'var(--ca-success)',
    modified: 'var(--ca-warning)',
    deleted: 'var(--ca-danger)',
    unchanged: 'var(--ca-text-muted)',
};

/** Scroll a row (by apiId) into view within `container` + flash it. */
export function jumpToApiRow(container: HTMLElement | null | undefined, apiId: string): boolean {
    if (!container || !apiId) return false;
    const sel = `[data-api-id="${(window.CSS && CSS.escape) ? CSS.escape(apiId) : apiId.replace(/"/g, '\\"')}"]`;
    const el = container.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('ca-diff-flash');
    window.setTimeout(() => el.classList.remove('ca-diff-flash'), 900);
    return true;
}

const chipBase: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 999,
    border: '1px solid var(--ca-border)', background: 'transparent',
    color: 'var(--ca-text)', cursor: 'pointer', lineHeight: 1.6, whiteSpace: 'nowrap',
};

export function DiffFocusBar({
    counts, filter, onFilterChange, changedIds, scrollContainerRef,
}: {
    counts: ChangeCounts;
    filter: ChangeFilter;
    onFilterChange: (f: ChangeFilter) => void;
    changedIds: string[];
    scrollContainerRef: React.RefObject<HTMLElement>;
}) {
    const [stepIdx, setStepIdx] = useState(0);
    if (counts.changed === 0) return null;

    const chip = (key: ChangeFilter, label: string, active: boolean, color?: string) => (
        <button
            key={key}
            type="button"
            className="ca-diff-chip"
            aria-pressed={active}
            onClick={() => onFilterChange(active && key !== 'all' ? 'all' : key)}
            style={{
                ...chipBase,
                ...(active ? { background: color ?? 'var(--ca-accent)', color: '#fff', borderColor: color ?? 'var(--ca-accent)' } : {}),
            }}
            title={key === 'changed' ? 'Show only changed entry points' : key === 'all' ? 'Show everything' : `Show only ${key}`}
        >{label}</button>
    );

    const step = (dir: 1 | -1) => {
        if (changedIds.length === 0) return;
        const next = (stepIdx + dir + changedIds.length) % changedIds.length;
        setStepIdx(next);
        jumpToApiRow(scrollContainerRef.current, changedIds[next]);
    };

    return (
        <div className="ca-diff-focus-bar" data-testid="diff-focus-bar" style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            padding: '5px 8px', borderRadius: 8, margin: '2px 0 6px',
            background: 'var(--ca-panel-2, rgba(127,127,127,0.08))',
        }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ca-text-muted)', letterSpacing: 0.3 }}>CHANGES</span>
            {chip('all', `All ${counts.total}`, filter === 'all')}
            {chip('changed', `⦿ Changed ${counts.changed}`, filter === 'changed', 'var(--ca-accent)')}
            {counts.added > 0 && chip('added', `+${counts.added}`, filter === 'added', KIND_COLOR.added)}
            {counts.deleted > 0 && chip('deleted', `−${counts.deleted}`, filter === 'deleted', KIND_COLOR.deleted)}
            {counts.modified > 0 && chip('modified', `~${counts.modified}`, filter === 'modified', KIND_COLOR.modified)}

            {changedIds.length > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }} data-testid="diff-jump-stepper">
                    <button type="button" aria-label="Previous change" title="Jump to previous change"
                        onClick={() => step(-1)} style={{ ...chipBase, padding: '2px 7px' }}>◂</button>
                    <span style={{ fontSize: 11, color: 'var(--ca-text-muted)', minWidth: 34, textAlign: 'center' }}>
                        {Math.min(stepIdx + 1, changedIds.length)}/{changedIds.length}
                    </span>
                    <button type="button" aria-label="Next change" title="Jump to next change"
                        onClick={() => step(1)} style={{ ...chipBase, padding: '2px 7px' }}>▸</button>
                </span>
            )}
        </div>
    );
}

/**
 * Scrollbar change markers (feature #3): a thin track pinned to the right edge
 * of the scroll container with a colored tick per changed row, positioned by
 * the row's offset within the scrollable content. Click a tick to jump. Re-
 * measures on `version` change (filter / expand toggles move rows) + resize.
 */
export function DiffMinimap({
    scrollContainerRef, version,
}: {
    scrollContainerRef: React.RefObject<HTMLElement>;
    version: unknown;
}) {
    const [ticks, setTicks] = useState<Array<{ id: string; topPct: number; kind: ChangeKind }>>([]);

    const measure = useCallback(() => {
        const c = scrollContainerRef.current;
        if (!c) { setTicks((prev) => (prev.length ? [] : prev)); return; }
        const total = c.scrollHeight || 1;
        const rows = Array.from(c.querySelectorAll<HTMLElement>('[data-api-id][data-diff]'));
        const seen = new Set<string>();
        const next: Array<{ id: string; topPct: number; kind: ChangeKind }> = [];
        for (const el of rows) {
            const id = el.getAttribute('data-api-id') || '';
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const kind = (el.getAttribute('data-diff') as ChangeKind) || 'modified';
            next.push({ id, topPct: Math.max(0, Math.min(100, (el.offsetTop / total) * 100)), kind });
        }
        // Only update when the tick set actually changed (avoids render loops).
        setTicks((prev) => {
            if (prev.length === next.length && prev.every((p, i) => p.id === next[i].id && Math.abs(p.topPct - next[i].topPct) < 0.5)) return prev;
            return next;
        });
    }, [scrollContainerRef]);

    useLayoutEffect(() => {
        // Measure synchronously (DOM is committed) so ticks appear on first paint,
        // then again shortly after to catch rows/layout that settle late (async
        // graph pushes, font metrics, section auto-expand). A ResizeObserver keeps
        // ticks correct as the container or its content reflows.
        measure();
        const timers = [30, 120, 300].map((ms) => window.setTimeout(measure, ms));
        const c = scrollContainerRef.current;
        const ro = c && 'ResizeObserver' in window ? new ResizeObserver(() => measure()) : null;
        if (c && ro) ro.observe(c);
        return () => { timers.forEach((t) => window.clearTimeout(t)); ro?.disconnect(); };
    }, [measure, version]);

    if (ticks.length === 0) return null;
    return (
        <div className="ca-diff-minimap" data-testid="diff-minimap" aria-hidden="true" style={{
            position: 'absolute', top: 4, bottom: 4, right: 1, width: 8, zIndex: 3, pointerEvents: 'none',
        }}>
            {ticks.map((t) => (
                <button
                    key={t.id}
                    type="button"
                    title={`Jump to ${t.kind} entry point`}
                    onClick={() => jumpToApiRow(scrollContainerRef.current, t.id)}
                    style={{
                        position: 'absolute', top: `${t.topPct}%`, right: 0, width: 8, height: 4,
                        borderRadius: 2, border: 'none', padding: 0, cursor: 'pointer',
                        background: KIND_COLOR[t.kind], pointerEvents: 'auto', opacity: 0.85,
                    }}
                />
            ))}
        </div>
    );
}
