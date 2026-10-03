/**
 * UpstreamChangesChip.test.tsx — #817.5 (2026-06-11).
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { UpstreamChangesChip, type UpstreamChangeEntry } from './UpstreamChangesChip';

const CHANGES: UpstreamChangeEntry[] = [
    { producerRepoName: 'auth-service', consumerRepoName: 'gateway', method: 'POST', route: '/login' },
    { producerRepoName: 'auth-service', consumerRepoName: 'reports', method: 'GET', route: '/users/:id' },
];

describe('#817 — UpstreamChangesChip', () => {
    it('renders nothing for an empty change list', () => {
        render(<UpstreamChangesChip changes={[]} onOpen={vi.fn()} onDismiss={vi.fn()} />);
        expect(screen.queryByTestId('ca-upstream-changes-chip')).toBeNull();
    });

    it('renders the count + consumer names', () => {
        render(<UpstreamChangesChip changes={CHANGES} onOpen={vi.fn()} onDismiss={vi.fn()} />);
        const chip = screen.getByTestId('ca-upstream-changes-chip');
        expect(chip.textContent).toContain('2 upstream changes');
        expect(chip.textContent).toContain('gateway');
        expect(chip.textContent).toContain('reports');
    });

    it('clicking the body opens the FIRST affected consumer', () => {
        const onOpen = vi.fn();
        render(<UpstreamChangesChip changes={CHANGES} onOpen={onOpen} onDismiss={vi.fn()} />);
        fireEvent.click(screen.getByTestId('ca-upstream-changes-open'));
        expect(onOpen).toHaveBeenCalledWith('gateway');
    });

    it('dismiss fires without opening', () => {
        const onOpen = vi.fn();
        const onDismiss = vi.fn();
        render(<UpstreamChangesChip changes={CHANGES} onOpen={onOpen} onDismiss={onDismiss} />);
        fireEvent.click(screen.getByTestId('ca-upstream-changes-dismiss'));
        expect(onDismiss).toHaveBeenCalled();
        expect(onOpen).not.toHaveBeenCalled();
    });
});
