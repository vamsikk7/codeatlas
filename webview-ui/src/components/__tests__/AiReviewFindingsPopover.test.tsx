/**
 * AiReviewFindingsPopover tests (#531 + #538–#541).
 *
 * Covers: open/close, severity filter, search, baselineRef chip, navigation,
 * the new summary chip, per-finding actions, group + single copy, resizable
 * wrapper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { useRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AiReviewFindingsPopover } from '../AiReviewFindingsPopover';
import { setFindings } from '../ai-review/aiReviewBus';
import type { AiReviewFinding } from '../ai-review/types';

function makeFinding(overrides: Partial<AiReviewFinding> = {}): AiReviewFinding {
    return {
        id: `f_${Math.random().toString(36).slice(2, 6)}`,
        entryPointId: 'GET:/health',
        bindings: [{ graphId: 'file:src/health.ts', targetId: 'health', targetType: 'node', layer: 'file' }],
        severity: 'warning',
        category: 'code-quality',
        title: 'Missing health probe',
        body: 'Add /health endpoint.',
        status: 'open',
        model: 'test',
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T00:00:00Z',
        ...overrides,
    };
}

function Host({ open = true, onClose = () => undefined, postMessage }: { open?: boolean; onClose?: () => void; postMessage?: (m: any) => void }) {
    const ref = useRef<HTMLButtonElement | null>(null);
    return (
        <div>
            <button ref={ref} data-testid="anchor">anchor</button>
            <AiReviewFindingsPopover open={open} onClose={onClose} anchorRef={ref} postMessage={postMessage} />
        </div>
    );
}

describe('AiReviewFindingsPopover', () => {
    beforeEach(() => {
        setFindings([
            makeFinding({ id: 'e1', severity: 'error', title: 'SQL injection in /admin' }),
            makeFinding({ id: 'w1', severity: 'warning', title: 'Missing CSRF' }),
            makeFinding({ id: 'i1', severity: 'info', title: 'Stale dependency' }),
        ]);
    });

    it('renders nothing when open=false', () => {
        const { container } = render(<Host open={false} />);
        expect(container.querySelector('[data-testid="ai-review-findings-popover"]')).toBeNull();
    });

    it('renders all 3 findings when filter=all', () => {
        render(<Host />);
        expect(screen.getByText('SQL injection in /admin')).toBeTruthy();
        expect(screen.getByText('Missing CSRF')).toBeTruthy();
        expect(screen.getByText('Stale dependency')).toBeTruthy();
    });

    it('filters to errors only', () => {
        render(<Host />);
        fireEvent.click(screen.getByTestId('ai-findings-filter-error'));
        expect(screen.getByText('SQL injection in /admin')).toBeTruthy();
        expect(screen.queryByText('Missing CSRF')).toBeNull();
        expect(screen.queryByText('Stale dependency')).toBeNull();
    });

    it('search filter narrows the visible list', () => {
        render(<Host />);
        fireEvent.change(screen.getByPlaceholderText('Search findings…'), { target: { value: 'csrf' } });
        expect(screen.getByText('Missing CSRF')).toBeTruthy();
        expect(screen.queryByText('SQL injection in /admin')).toBeNull();
    });

    it('renders baselineRef chip when finding has one (#534)', () => {
        setFindings([
            makeFinding({
                id: 'b1',
                title: 'With ref',
                baselineRef: { kind: 'git', ref: 'abc1234', capturedAt: '2026-05-22T00:00:00Z' },
            } as any),
        ]);
        render(<Host />);
        const chip = screen.getByTestId('ai-finding-baseline-ref');
        expect(chip.textContent).toContain('git:abc1234');
    });

    it('omits baselineRef chip when finding has no ref (#534)', () => {
        setFindings([makeFinding({ id: 'n1', title: 'No ref' })]);
        render(<Host />);
        expect(screen.queryByTestId('ai-finding-baseline-ref')).toBeNull();
    });

    it('clicking the title button navigates and closes', () => {
        const onClose = vi.fn();
        const originalHash = window.location.hash;
        try {
            render(<Host onClose={onClose} />);
            // The list now has multiple `ai-finding-row-open` buttons; pick the error row.
            const openBtns = screen.getAllByTestId('ai-finding-row-open');
            // The first open button is the highest-severity (error) row.
            fireEvent.click(openBtns[0]);
            expect(window.location.hash).toContain('#/file/src/health.ts');
            expect(onClose).toHaveBeenCalled();
        } finally {
            window.location.hash = originalHash;
        }
    });

    it('renders the layered summary chip when findings exist (#538)', () => {
        render(<Host />);
        const summary = screen.getByTestId('ai-findings-summary');
        expect(summary.textContent).toContain('Summary');
        // All three findings bind to layer=file, so summary should mention File.
        expect(summary.textContent?.toLowerCase()).toContain('file');
    });

    it('omits the summary chip when there are no open findings (#538)', () => {
        setFindings([]);
        render(<Host />);
        expect(screen.queryByTestId('ai-findings-summary')).toBeNull();
    });

    it('Resolve action posts updateAiFindingStatus (#539)', () => {
        const postMessage = vi.fn();
        render(<Host postMessage={postMessage} />);
        // First Resolve button corresponds to the first (error) row.
        const resolves = screen.getAllByTestId('ai-finding-resolve');
        fireEvent.click(resolves[0]);
        expect(postMessage).toHaveBeenCalledWith({
            type: 'updateAiFindingStatus',
            findingId: 'e1',
            status: 'resolved',
        });
    });

    it('Ignore action posts updateAiFindingStatus (#539)', () => {
        const postMessage = vi.fn();
        render(<Host postMessage={postMessage} />);
        const ignores = screen.getAllByTestId('ai-finding-ignore');
        fireEvent.click(ignores[0]);
        expect(postMessage).toHaveBeenCalledWith({
            type: 'updateAiFindingStatus',
            findingId: 'e1',
            status: 'ignored',
        });
    });

    it('Comment action opens textarea + posts addComment with source=ai (#539)', () => {
        const postMessage = vi.fn();
        render(<Host postMessage={postMessage} />);
        const comments = screen.getAllByTestId('ai-finding-comment');
        fireEvent.click(comments[0]);
        const ta = screen.getByTestId('ai-finding-comment-textarea') as HTMLTextAreaElement;
        fireEvent.change(ta, { target: { value: 'this is wrong' } });
        fireEvent.click(screen.getByTestId('ai-finding-comment-submit'));
        const call = postMessage.mock.calls.find((c: any[]) => c[0].type === 'addComment');
        expect(call).toBeTruthy();
        expect(call![0]).toMatchObject({
            type: 'addComment',
            source: 'ai',
            targetId: 'health',
        });
        expect(String(call![0].body)).toContain('this is wrong');
    });

    it('Copy single posts to clipboard (#540)', async () => {
        const postMessage = vi.fn();
        const writeText = vi.fn().mockResolvedValue(undefined);
        (navigator as any).clipboard = { writeText };
        render(<Host postMessage={postMessage} />);
        const copies = screen.getAllByTestId('ai-finding-copy');
        fireEvent.click(copies[0]);
        await new Promise((r) => setTimeout(r, 50));
        expect(writeText).toHaveBeenCalled();
        const payload = String(writeText.mock.calls[0][0]);
        expect(payload).toContain('AI Review findings');
        expect(payload).toContain('SQL injection in /admin');
    });

    it('Copy ▾ menu opens and group copy posts to clipboard (#540)', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        (navigator as any).clipboard = { writeText };
        render(<Host />);
        fireEvent.click(screen.getByTestId('ai-findings-copy-btn'));
        expect(screen.getByTestId('ai-findings-copy-menu')).toBeTruthy();
        fireEvent.click(screen.getByTestId('ai-findings-copy-error'));
        await new Promise((r) => setTimeout(r, 50));
        const payload = String(writeText.mock.calls[0][0]);
        expect(payload).toContain('SQL injection in /admin');
        // Filtered to errors — must not include the warning row.
        expect(payload).not.toContain('Missing CSRF');
    });

    it('popover wrapper has resize:both for #541', () => {
        render(<Host />);
        const popover = screen.getByTestId('ai-review-findings-popover') as HTMLDivElement;
        expect(popover.style.resize).toBe('both');
    });

    // #536 — stale-finding visibility
    describe('stale-finding visibility (#536)', () => {
        it('hides stale findings by default; toggle reveals them dimmed', () => {
            setFindings([
                makeFinding({ id: 'open1', status: 'open', title: 'Live finding' }),
                makeFinding({ id: 'stale1', status: 'stale', title: 'Old drifted finding' }),
            ]);
            render(<Host />);
            // Open finding visible; stale row hidden.
            expect(screen.getByText('Live finding')).toBeTruthy();
            expect(screen.queryByText('Old drifted finding')).toBeNull();
            // Toggle exists because at least one stale finding is present.
            const toggle = screen.getByTestId('ai-findings-stale-toggle');
            expect(toggle.textContent).toContain('Show stale (1)');
            fireEvent.click(toggle);
            // Now stale row is rendered.
            expect(screen.getByText('Old drifted finding')).toBeTruthy();
            // Stale row carries the dedicated testId + reduced opacity.
            const staleRow = screen.getByTestId('ai-finding-row-stale') as HTMLElement;
            expect(staleRow.style.opacity).toBe('0.5');
        });

        it('omits the stale toggle entirely when no stale findings exist', () => {
            setFindings([makeFinding({ id: 'open1', status: 'open' })]);
            render(<Host />);
            expect(screen.queryByTestId('ai-findings-stale-toggle')).toBeNull();
        });

        it('footer surfaces the stale count alongside open', () => {
            setFindings([
                makeFinding({ id: 'o1', status: 'open' }),
                makeFinding({ id: 's1', status: 'stale' }),
                makeFinding({ id: 's2', status: 'stale', entryPointId: 'GET:/other' }),
            ]);
            render(<Host />);
            // Footer text: "<N> shown · 1 open · 2 stale"
            const popover = screen.getByTestId('ai-review-findings-popover');
            expect(popover.textContent).toContain('1 open');
            expect(popover.textContent).toContain('2 stale');
        });

        it('stale findings are excluded from the severity-tab filter pool when toggle is OFF', () => {
            setFindings([
                makeFinding({ id: 'e1', severity: 'error', status: 'open', title: 'Open error' }),
                makeFinding({ id: 'e2', severity: 'error', status: 'stale', title: 'Stale error' }),
            ]);
            render(<Host />);
            fireEvent.click(screen.getByTestId('ai-findings-filter-error'));
            expect(screen.getByText('Open error')).toBeTruthy();
            expect(screen.queryByText('Stale error')).toBeNull();
        });
    });

    // Issue 613-UI — audit-trail history pane.
    describe('audit-trail history pane (#613-UI)', () => {
        const TRAIL = [
            { ts: '2026-05-23T08:00:00Z', fromStatus: null, toStatus: 'open', actor: 'gpt-4o-mini' },
            { ts: '2026-05-23T09:30:00Z', fromStatus: 'open', toStatus: 'resolved', actor: 'arju', note: 'fixed in PR #123' },
            { ts: '2026-05-23T11:15:00Z', fromStatus: 'resolved', toStatus: 'open', actor: 'arju', note: 'regression — reopening' },
        ] as any;

        it('hides the History button when the trail is missing or single-entry', () => {
            // No trail at all.
            setFindings([makeFinding({ id: 'no-trail', title: 'Untracked', auditTrail: undefined } as any)]);
            const { unmount } = render(<Host />);
            expect(screen.queryByTestId('ai-finding-history-btn')).toBeNull();
            unmount();
            // Single-entry trail (just the creation row).
            setFindings([makeFinding({
                id: 'one-entry',
                title: 'Single',
                auditTrail: [{ ts: 't', fromStatus: null, toStatus: 'open', actor: 'm' }],
            } as any)]);
            render(<Host />);
            expect(screen.queryByTestId('ai-finding-history-btn')).toBeNull();
        });

        it('shows the History button when the trail has 2+ entries with the trail length in the label', () => {
            setFindings([makeFinding({ id: 'multi', title: 'Multi-event finding', auditTrail: TRAIL } as any)]);
            render(<Host />);
            const btn = screen.getByTestId('ai-finding-history-btn');
            expect(btn.textContent).toContain('History (3)');
        });

        it('clicking History expands the pane with all trail entries (reverse chronological)', () => {
            setFindings([makeFinding({ id: 'multi', title: 'Multi-event finding', auditTrail: TRAIL } as any)]);
            render(<Host />);
            fireEvent.click(screen.getByTestId('ai-finding-history-btn'));
            const pane = screen.getByTestId('ai-finding-history-pane');
            expect(pane).toBeTruthy();
            const entries = screen.getAllByTestId('ai-finding-history-entry');
            expect(entries).toHaveLength(3);
            // Reverse-chronological: most recent (resolved → open) at the top.
            expect(entries[0].textContent).toContain('resolved → open');
            expect(entries[1].textContent).toContain('open → resolved');
            expect(entries[2].textContent).toContain('created (open)');
        });

        it('displays the note alongside the actor and timestamp', () => {
            setFindings([makeFinding({ id: 'noted', title: 'With note', auditTrail: TRAIL } as any)]);
            render(<Host />);
            fireEvent.click(screen.getByTestId('ai-finding-history-btn'));
            const pane = screen.getByTestId('ai-finding-history-pane');
            expect(pane.textContent).toContain('regression — reopening');
            expect(pane.textContent).toContain('arju');
        });

        it('clicking History a second time collapses the pane', () => {
            setFindings([makeFinding({ id: 'toggle', title: 't', auditTrail: TRAIL } as any)]);
            render(<Host />);
            const btn = screen.getByTestId('ai-finding-history-btn');
            fireEvent.click(btn);
            expect(screen.getByTestId('ai-finding-history-pane')).toBeTruthy();
            fireEvent.click(btn);
            expect(screen.queryByTestId('ai-finding-history-pane')).toBeNull();
        });

        it('caps the visible trail at 8 entries with an "earlier entries hidden" marker', () => {
            const longTrail = Array.from({ length: 12 }, (_, i) => ({
                ts: `2026-05-23T0${i}:00:00Z`,
                fromStatus: i === 0 ? null : 'open',
                toStatus: i === 0 ? 'open' : (i % 2 === 0 ? 'resolved' : 'open'),
                actor: `u${i}`,
            }));
            setFindings([makeFinding({ id: 'long', title: 'Long history', auditTrail: longTrail } as any)]);
            render(<Host />);
            fireEvent.click(screen.getByTestId('ai-finding-history-btn'));
            const entries = screen.getAllByTestId('ai-finding-history-entry');
            expect(entries).toHaveLength(8);
            const pane = screen.getByTestId('ai-finding-history-pane');
            expect(pane.textContent).toContain('4 earlier entries hidden');
        });
    });
});
