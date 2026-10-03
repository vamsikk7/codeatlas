/**
 * initProgressPhases tests — #918 part (a).
 */
import { describe, it, expect } from 'vitest';
import {
    INIT_PHASES,
    phaseStepIndex,
    phaseStepStatuses,
    estimateEtaSeconds,
} from '../initProgressPhases';

describe('#918 init progress phases', () => {
    it('exposes ≥3 named, ordered phases', () => {
        expect(INIT_PHASES.length).toBeGreaterThanOrEqual(3);
        expect(INIT_PHASES.map((p) => p.label)).toEqual(['Scanning', 'Parsing', 'Building', 'Finalizing']);
    });

    it('maps every orchestrator phase key to a step', () => {
        expect(phaseStepIndex('starting')).toBe(0);
        expect(phaseStepIndex('resync')).toBe(0);
        expect(phaseStepIndex('scanning')).toBe(0);
        expect(phaseStepIndex('parsing')).toBe(1);
        expect(phaseStepIndex('building')).toBe(2);
        expect(phaseStepIndex('finalizing')).toBe(3);
    });

    it('treats complete as past the last step', () => {
        expect(phaseStepIndex('complete')).toBe(INIT_PHASES.length);
    });

    it('falls back to step 0 for an unknown phase (never blanks the breadcrumb)', () => {
        expect(phaseStepIndex('totally-unknown')).toBe(0);
    });

    it('marks earlier steps done, current active, later todo', () => {
        expect(phaseStepStatuses('building')).toEqual(['done', 'done', 'active', 'todo']);
        expect(phaseStepStatuses('scanning')).toEqual(['active', 'todo', 'todo', 'todo']);
        // complete → all done.
        expect(phaseStepStatuses('complete')).toEqual(['done', 'done', 'done', 'done']);
    });

    it('extrapolates a rough ETA in the stable middle band', () => {
        // 50% in 10s → ~10s remaining.
        expect(estimateEtaSeconds(0.5, 10_000)).toBe(10);
        // 25% in 5s → total 20s → ~15s remaining.
        expect(estimateEtaSeconds(0.25, 5_000)).toBe(15);
    });

    it('returns null near the ends (low signal / finalize flush)', () => {
        expect(estimateEtaSeconds(0.02, 1_000)).toBeNull();   // too early
        expect(estimateEtaSeconds(0.97, 30_000)).toBeNull();  // finalize tail
        expect(estimateEtaSeconds(0.5, 0)).toBeNull();        // no elapsed signal
    });
});
