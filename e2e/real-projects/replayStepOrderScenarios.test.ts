/**
 * replayStepOrderScenarios.test.ts
 *
 * Issues #384 + #392: pin the exact step ORDER and the exact step COUNTS
 * built by `CommitTimelineReplay.buildSteps` for a canonical edit.
 *
 * Today's "≥ 1 step per layer" scenario in `timelineReplayScenarios.test.ts`
 * would pass even if `buildSteps` scrambled the order (top-down narrative
 * regressed → users see L1 first instead of the edited function) or
 * silently dropped a layer (e.g. caps changed and L5/L2b disappeared).
 * These tests close those holes.
 *
 * Production order (commitTimelineReplay.ts:485-570):
 *   L5 Flow (≤3) → L4 File (≤3) → L3 Sequence (≤2) → L2a Feature (1)
 *   → L2b API List (≤2) → L1 System (1)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { runScenario, type ScenarioResult } from './cascadeHarness';
import { PRESENT_FIXTURES } from './cascadeFixtures';
import { installFixtureSafetyGuard } from './fixtureSafety';
import { buildWorkingDiffBundle } from '../../src/handlers/replayWorkingChanges';
import {
    CommitTimelineReplay,
    MAX_FN_STEPS,
    MAX_FILE_STEPS,
    MAX_SEQ_STEPS,
    MAX_API_LIST_STEPS,
} from '../../src/core/replay/commitTimelineReplay';
import type { DiagramGraph } from '../../src/core/graph/graphTypes';

installFixtureSafetyGuard();

const TS_EXPRESS = PRESENT_FIXTURES.find(f => f.id === 'ts-express-realworld');
const d = TS_EXPRESS ? describe : describe.skip;

function collectReplaySteps(diffedGraphs: Record<string, DiagramGraph>) {
    const steps: Array<{ layer: string; graphId: string; entity: string }> = [];
    const replay = new CommitTimelineReplay(
        {
            navigate: () => {},
            setDiffContext: () => {},
            clearDiffContext: () => {},
            onStepStart: (s) => steps.push({ layer: s.layer, graphId: s.graphId, entity: s.changedEntity }),
            onCommitStart: () => {},
            onReplayEnd: () => {},
            onPaused: () => {},
            onResumed: () => {},
        },
        { buildDiff: async () => ({ diffedGraphs: {}, headSnapshot: { files: {}, apiIndex: {}, graphs: {} }, baseSnapshot: { files: {}, apiIndex: {}, graphs: {} } }) },
        10 * 60 * 1000,
    );
    replay.playFromDiffResult({
        diffedGraphs,
        baseHash: 'baseline',
        headHash: 'working',
        baseLabel: 'Baseline',
        headLabel: 'Working (uncommitted)',
    });
    let safety = 64;
    let last = steps.length;
    while (safety-- > 0) {
        replay.nextStep();
        if (steps.length === last) break;
        last = steps.length;
    }
    replay.stop();
    return steps;
}

d('replay step-order — single-function edit on auth.service.ts', () => {
    let scenario: ScenarioResult;
    let steps: Array<{ layer: string; graphId: string; entity: string }>;

    beforeAll(async () => {
        scenario = await runScenario({
            repoPath: TS_EXPRESS!.repoPath,
            edits: [
                {
                    filePath: TS_EXPRESS!.canonical.relativePath,
                    op: { op: 'addLinesToFunction', fnName: TS_EXPRESS!.canonical.fnName, lines: [`console.log('[order-probe]');`] },
                },
            ],
        });
        const bundle = buildWorkingDiffBundle(scenario.baseline, scenario.working);
        steps = collectReplaySteps(bundle);
    }, 90_000);

    afterAll(() => scenario?.dispose());

    it('step order is L5 → L4 → L3 → L2a → L2b → L1 (deepest-first narrative)', () => {
        // Map layer names to their expected position group; assert
        // monotonic non-decreasing group across the sequence.
        const groupOf = (layer: string): number => {
            if (layer === 'L5 Flow') return 0;
            if (layer === 'L4 File') return 1;
            if (layer === 'L3 Sequence') return 2;
            if (layer === 'L2a Feature') return 3;
            if (layer === 'L2b API List') return 4;
            if (layer === 'L1 System') return 5;
            throw new Error(`unknown layer: ${layer}`);
        };
        const groups = steps.map(s => groupOf(s.layer));
        const sorted = [...groups].sort((a, b) => a - b);
        expect(groups).toEqual(sorted);
    });

    it('exactly one step per layer for a single-function edit', () => {
        // For an edit touching one function in one file:
        //   L5 — 1 (only that function changed)
        //   L4 — 1 (only that file changed)
        //   L3 — 1 (one affected sequence; siblings unchanged)
        //   L2a — 1 (workspace feature graph)
        //   L2b — 1 (one cluster's api-list shows the changed route)
        //   L1 — 1 (microservice graph)
        const byLayer = new Map<string, number>();
        for (const s of steps) byLayer.set(s.layer, (byLayer.get(s.layer) ?? 0) + 1);
        expect(byLayer.get('L5 Flow')).toBe(1);
        expect(byLayer.get('L4 File')).toBe(1);
        expect(byLayer.get('L3 Sequence')).toBe(1);
        expect(byLayer.get('L2a Feature')).toBe(1);
        expect(byLayer.get('L2b API List')).toBe(1);
        expect(byLayer.get('L1 System')).toBe(1);
    });

    it('total step count is 6 (single-function edit canonical)', () => {
        expect(steps.length).toBe(6);
    });

    it('L5 step is the edited function flow', () => {
        const l5 = steps.find(s => s.layer === 'L5 Flow');
        expect(l5?.graphId).toBe(`flow:${TS_EXPRESS!.canonical.relativePath}:${TS_EXPRESS!.canonical.fnName}`);
        expect(l5?.entity).toBe(TS_EXPRESS!.canonical.fnName);
    });

    it('L4 step is the edited file', () => {
        const l4 = steps.find(s => s.layer === 'L4 File');
        expect(l4?.graphId).toBe(`file:${TS_EXPRESS!.canonical.relativePath}`);
        expect(l4?.entity).toBe(path.basename(TS_EXPRESS!.canonical.relativePath));
    });

    it('L3 step is the affected sequence (GET /user)', () => {
        const l3 = steps.find(s => s.layer === 'L3 Sequence');
        expect(l3?.graphId).toBe(TS_EXPRESS!.canonical.expectedModified.sequenceGraphId);
    });

    it('L2a + L1 steps are the workspace-level graphs', () => {
        const l2a = steps.find(s => s.layer === 'L2a Feature');
        expect(l2a?.graphId).toBe('feature:workspace');
        const l1 = steps.find(s => s.layer === 'L1 System');
        expect(l1?.graphId).toBe('microservice:workspace');
    });
});

// Issue 392 — pin the step-cap CONSTANTS. Any silent change to these
// caps would otherwise ship unnoticed: today's scenarios assert ≥1
// step per layer for a single-function edit, but the cap behaviour
// (when there are many changed functions/files) is unchecked.
describe('replay step caps — Issue 392', () => {
    it('MAX_FN_STEPS pinned at 3', () => {
        expect(MAX_FN_STEPS).toBe(3);
    });

    it('MAX_FILE_STEPS pinned at 3', () => {
        expect(MAX_FILE_STEPS).toBe(3);
    });

    it('MAX_SEQ_STEPS pinned at 2', () => {
        expect(MAX_SEQ_STEPS).toBe(2);
    });

    it('MAX_API_LIST_STEPS pinned at 2', () => {
        expect(MAX_API_LIST_STEPS).toBe(2);
    });
});
