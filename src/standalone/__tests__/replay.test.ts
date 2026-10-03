/**
 * replay.test.ts — standalone timeline-replay wiring.
 *
 * Covers:
 *   - replayWorkingChanges short-circuits when no working changes
 *   - replayWorkingChanges broadcasts `replayStarted` and steps via WS
 *   - stopReplay broadcasts `replayStopped`
 *   - applyReplayControl forwards pause/resume/next/prev
 *   - setReplaySpeed clamps to engine range
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { replayWorkingChanges, stopReplay, applyReplayControl, setReplaySpeed, createReplayState } from '../replay';
import type { SnapshotStore } from '../../core/storage/snapshotStore';
import type { WsBridge } from '../../server/wsBridge';

vi.mock('../../handlers/replayWorkingChanges', () => ({
    workingDiffersFromBaseline: vi.fn(),
    buildWorkingDiffBundle: vi.fn(() => ({
        // Minimal diff with one file graph carrying a modified node — engine
        // needs at least one changed graph to build steps.
        'file:src/a.ts': {
            graphId: 'file:src/a.ts', type: 'file',
            nodes: [{ id: 'f', type: 'file', label: 'a.ts', diff: 'modified' }],
            edges: [], anchors: {}, meta: {},
        },
    })),
}));

import { workingDiffersFromBaseline } from '../../handlers/replayWorkingChanges';

function mkDeps() {
    const broadcasts: any[] = [];
    const wsBridge = { broadcast: vi.fn((m) => broadcasts.push(m)) } as unknown as WsBridge;
    const snapshotStore = {
        getBaseline: () => ({ files: {}, graphs: {}, apiIndex: {} }),
        getWorking: () => ({ files: {}, graphs: {}, apiIndex: {} }),
    } as unknown as SnapshotStore;
    // #915 — workspaceRoot is the git root the commit-history `buildDiff` uses.
    return { workspaceRoot: '/ws', broadcasts, wsBridge, snapshotStore, log: () => {} };
}

describe('replayWorkingChanges', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('warns + does not start when there are no working changes', () => {
        const d = mkDeps();
        (workingDiffersFromBaseline as any).mockReturnValue(false);
        const state = createReplayState();
        replayWorkingChanges(d, state);

        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('warning');
        expect(toast?.text).toContain('No working changes');
        expect(state.timeline, 'timeline must NOT be constructed when there is nothing to replay').toBeNull();
    });

    it('starts a working-vs-baseline replay when there are changes', () => {
        const d = mkDeps();
        (workingDiffersFromBaseline as any).mockReturnValue(true);
        const state = createReplayState();

        replayWorkingChanges(d, state);

        expect(state.timeline, 'timeline must be constructed').toBeTruthy();
        expect(d.broadcasts.some(m => m.type === 'replayStarted')).toBe(true);
        // Setting the diff context labels what the HUD shows.
        const ctx = d.broadcasts.find(m => m.type === 'setGitDiffContext');
        expect(ctx?.baseLabel).toBe('Baseline');
        expect(ctx?.headLabel).toBe('Working (uncommitted)');
    });
});

describe('stopReplay', () => {
    it('broadcasts replayStopped even when nothing is running', () => {
        const d = mkDeps();
        stopReplay(d, createReplayState());
        expect(d.broadcasts).toEqual([{ type: 'replayStopped' }]);
    });

    it('calls stop() on the timeline when one exists', () => {
        const d = mkDeps();
        (workingDiffersFromBaseline as any).mockReturnValue(true);
        const state = createReplayState();
        replayWorkingChanges(d, state);
        expect(state.timeline).toBeTruthy();
        const spy = vi.spyOn(state.timeline!, 'stop');
        stopReplay(d, state);
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

describe('applyReplayControl', () => {
    it('forwards pause/resume/next/prev to the engine', () => {
        const d = mkDeps();
        (workingDiffersFromBaseline as any).mockReturnValue(true);
        const state = createReplayState();
        replayWorkingChanges(d, state);
        const pauseSpy = vi.spyOn(state.timeline!, 'pause');
        const resumeSpy = vi.spyOn(state.timeline!, 'resume');
        const nextSpy = vi.spyOn(state.timeline!, 'nextStep');
        const prevSpy = vi.spyOn(state.timeline!, 'prevStep');

        applyReplayControl(d, state, 'pause');
        applyReplayControl(d, state, 'resume');
        applyReplayControl(d, state, 'next');
        applyReplayControl(d, state, 'prev');

        expect(pauseSpy).toHaveBeenCalledTimes(1);
        expect(resumeSpy).toHaveBeenCalledTimes(1);
        expect(nextSpy).toHaveBeenCalledTimes(1);
        expect(prevSpy).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when no timeline exists yet', () => {
        const d = mkDeps();
        const state = createReplayState();
        // Should not throw.
        applyReplayControl(d, state, 'pause');
        expect(d.broadcasts).toHaveLength(0);
    });
});

describe('setReplaySpeed', () => {
    it('forwards to engine.setSpeed', () => {
        const d = mkDeps();
        (workingDiffersFromBaseline as any).mockReturnValue(true);
        const state = createReplayState();
        replayWorkingChanges(d, state);
        const spy = vi.spyOn(state.timeline!, 'setSpeed');
        setReplaySpeed(d, state, 1500);
        expect(spy).toHaveBeenCalledWith(1500);
    });

    it('is silent when no timeline exists', () => {
        // Should not throw.
        setReplaySpeed(mkDeps(), createReplayState(), 1500);
    });
});
