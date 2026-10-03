/**
 * ReplayControls.test.tsx — #818 R4 (2026-06-11).
 *
 * Pins the cross-repo coda chip + Skip-coda control. Regular steps render
 * neither; coda steps render both, and Skip coda issues 'stop'.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ReplayControls from './ReplayControls';

const COMMIT = { index: 0, total: 1, hash: 'working', subject: 'Working (uncommitted)' };

const baseStep = {
    commitHash: 'working', commitSubject: 'Working (uncommitted)',
    commitIndex: 0, totalCommits: 1,
    graphId: 'flow:producer/server.js:listItems', mode: 'flow',
    label: 'L5 Flow', layer: 'L5 Flow', changedEntity: 'listItems',
    globalIndex: 0, totalSteps: 7,
};

describe('#818 — ReplayControls coda treatment', () => {
    it('regular step: no chip, no skip control', () => {
        render(<ReplayControls step={baseStep as any} commitInfo={COMMIT} paused={false} onControl={vi.fn()} onSpeedChange={vi.fn()} />);
        expect(screen.queryByTestId('ca-replay-coda-chip')).toBeNull();
        expect(screen.queryByTestId('ca-replay-skip-coda')).toBeNull();
    });

    it('coda step: 🔗 chip with producer → consumer arrow + Skip coda button', () => {
        const codaStep = {
            ...baseStep,
            graphId: 'sequence:consumer/client.js:fetchItems', mode: 'sequence',
            label: '🔗 producer → consumer — consuming flow (L3)',
            layer: 'L3 Cross-repo', changedEntity: 'consumer',
            globalIndex: 6,
            replayKind: 'cross-repo-coda' as const,
            codaProducer: 'producer', codaConsumer: 'consumer',
        };
        const onControl = vi.fn();
        render(<ReplayControls step={codaStep as any} commitInfo={COMMIT} paused={false} onControl={onControl} onSpeedChange={vi.fn()} />);
        const chip = screen.getByTestId('ca-replay-coda-chip');
        expect(chip.textContent).toContain('cross-repo');
        expect(chip.textContent).toContain('producer → consumer');

        fireEvent.click(screen.getByTestId('ca-replay-skip-coda'));
        expect(onControl).toHaveBeenCalledWith('stop');
    });
});
