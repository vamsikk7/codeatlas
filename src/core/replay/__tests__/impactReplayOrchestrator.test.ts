import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImpactReplayOrchestrator } from '../impactReplayOrchestrator';
import type { ChangeDetail } from '../changeLog';
import type { Snapshot, DiagramGraph } from '../../graph/graphTypes';

// Mock impact analyzer
vi.mock('../../analysis/impactAnalyzer', () => ({
    analyzeImpact: vi.fn(() => ({
        changedFiles: [],
        changedFunctionKeys: [],
        impactedFunctions: [],
        affectedClusterIds: ['cluster:auth'],
        affectedServiceIds: [],
        affectedSequenceGraphIds: ['sequence:src/auth.ts:login'],
        affectedFileGraphIds: [],
        affectedFlowGraphIds: [],
        summary: { directImpacts: 1, transitiveImpacts: 2, reviewRequired: 0, clustersAffected: 1, servicesAffected: 0 },
    })),
}));

const mockGraph: DiagramGraph = { graphId: 'test', type: 'flow', nodes: [], edges: [], anchors: {}, meta: {} };

function makeCallbacks() {
    return {
        navigate: vi.fn(),
        onStepStart: vi.fn(),
        onReplayStart: vi.fn(),
        onReplayStop: vi.fn(),
        getGraph: vi.fn(() => mockGraph),
    };
}

function makeSnapshot(): Snapshot {
    return {
        files: { 'src/auth.ts': { path: 'src/auth.ts', hash: 'x', mtime: 0, symbols: { functions: [], variables: [], imports: [] } } },
        apiIndex: {},
        graphs: {},
        clusters: { 'cluster:auth': { id: 'cluster:auth', label: 'auth', files: ['src/auth.ts'], entryPoints: [], internalCallCount: 0, externalCallCount: 0 } },
    };
}

function makeDetail(): ChangeDetail {
    return {
        filePath: 'src/auth.ts',
        changedFunctions: ['login'],
        newFunctions: [],
        deletedFunctions: [],
        updatedGraphIds: ['flow:src/auth.ts:login'],
    };
}

describe('ImpactReplayOrchestrator', () => {
    it('plays a sequence of steps for changed functions', async () => {
        const cbs = makeCallbacks();
        const replay = new ImpactReplayOrchestrator(cbs, 10); // 10ms for fast tests
        await replay.play([makeDetail()], makeSnapshot());

        expect(cbs.onReplayStart).toHaveBeenCalledTimes(1);
        expect(cbs.navigate).toHaveBeenCalled();
        expect(cbs.onReplayStop).toHaveBeenCalledTimes(1);
        // Should have navigated: flow + sequence + feature = 3 steps
        expect(cbs.navigate.mock.calls.length).toBe(3);
    });

    it('stop() aborts the replay mid-sequence', async () => {
        const cbs = makeCallbacks();
        const replay = new ImpactReplayOrchestrator(cbs, 200);

        const promise = replay.play([makeDetail()], makeSnapshot());
        // Wait a tick for first step to execute, then stop
        await new Promise(r => setTimeout(r, 50));
        replay.stop();
        await promise;

        expect(cbs.onReplayStop).toHaveBeenCalled();
        // Should have navigated fewer than the full 3 steps
        expect(cbs.navigate.mock.calls.length).toBeLessThan(3);
    });

    it('skips steps when graph does not exist', async () => {
        const cbs = makeCallbacks();
        cbs.getGraph.mockReturnValue(undefined); // No graphs exist
        const replay = new ImpactReplayOrchestrator(cbs, 10);
        await replay.play([makeDetail()], makeSnapshot());

        expect(cbs.navigate).not.toHaveBeenCalled();
        expect(cbs.onReplayStop).toHaveBeenCalled();
    });

    it('handles empty change details', async () => {
        const cbs = makeCallbacks();
        const replay = new ImpactReplayOrchestrator(cbs, 10);
        await replay.play([], makeSnapshot());

        expect(cbs.onReplayStart).not.toHaveBeenCalled();
        expect(cbs.navigate).not.toHaveBeenCalled();
    });

    it('new play() stops previous replay', async () => {
        const cbs = makeCallbacks();
        const replay = new ImpactReplayOrchestrator(cbs, 200);

        const p1 = replay.play([makeDetail()], makeSnapshot());
        await new Promise(r => setTimeout(r, 50));
        // Start a new replay — should cancel first
        const p2 = replay.play([makeDetail()], makeSnapshot());
        await Promise.all([p1, p2]);

        // replayStart should have been called at least twice (once per play call)
        expect(cbs.onReplayStart.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
});
