/**
 * OverlaysPanel.test.tsx — #826 R2b (2026-06-11).
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { OverlaysPanel, type OverlayRowState } from './OverlaysPanel';

const ROWS: OverlayRowState[] = [
    { id: 'diff', displayName: 'Diff (baseline vs working)', enabled: true, paint: 'severity', renderManaged: true },
    { id: 'comments', displayName: 'Comments', enabled: false, paint: 'badge', renderManaged: true },
    { id: 'coverage', displayName: 'Test coverage', enabled: false, paint: 'metric', renderManaged: false, emptyHint: 'No LCOV / Istanbul coverage data found — run your test suite with coverage first.', knownEmpty: true },
    { id: 'todo-comments', displayName: 'TODO / FIXME density', enabled: false, paint: 'badge', renderManaged: false },
];

describe('#826 — OverlaysPanel', () => {
    it('renders one toggle row per overlay with diff-only ON by default', () => {
        render(<OverlaysPanel overlays={ROWS} onToggle={vi.fn()} onClose={vi.fn()} />);
        expect((screen.getByTestId('ca-overlay-toggle-diff') as HTMLInputElement).checked).toBe(true);
        expect((screen.getByTestId('ca-overlay-toggle-coverage') as HTMLInputElement).checked).toBe(false);
        expect((screen.getByTestId('ca-overlay-toggle-comments') as HTMLInputElement).checked).toBe(false);
    });

    it('flipping a toggle fires onToggle with the new state', () => {
        const onToggle = vi.fn();
        render(<OverlaysPanel overlays={ROWS} onToggle={onToggle} onClose={vi.fn()} />);
        fireEvent.click(screen.getByTestId('ca-overlay-toggle-todo-comments'));
        expect(onToggle).toHaveBeenCalledWith('todo-comments', true);
    });

    it('known-empty rows show the adapter empty hint inline (not a dead toggle)', () => {
        render(<OverlaysPanel overlays={ROWS} onToggle={vi.fn()} onClose={vi.fn()} />);
        expect(screen.getByTestId('ca-overlay-empty-coverage').textContent).toContain('No LCOV');
    });

    it('soft cap: 3+ enabled overlays show the busy hint instead of blocking', () => {
        const busy = ROWS.map((r) => ({ ...r, enabled: true }));
        render(<OverlaysPanel overlays={busy} onToggle={vi.fn()} onClose={vi.fn()} />);
        expect(screen.getByTestId('ca-overlays-busy-hint').textContent).toContain('busy');
    });

    it('close button fires onClose', () => {
        const onClose = vi.fn();
        render(<OverlaysPanel overlays={ROWS} onToggle={vi.fn()} onClose={onClose} />);
        fireEvent.click(screen.getByTestId('ca-overlays-close'));
        expect(onClose).toHaveBeenCalled();
    });
});
