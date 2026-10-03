/**
 * timelineReplayScenarios.test.ts
 *
 * Scenario-tier regressions for Timeline Replay on working changes.
 * Uses `cascadeHarness` + `cascadeFixtures` to apply a scripted edit per
 * fixture, then drives the end-to-end replay pipeline.
 *
 * Catches:
 *  - the "No working changes to replay" bug fixed today
 *    (workingDiffersFromBaseline was comparing the lazy-dropped .content
 *    instead of the always-present .hash),
 *  - any future drift in CommitTimelineReplay.playFromDiffResult / buildSteps,
 *  - any future drift in `buildWorkingDiffBundle` — the test imports the SAME
 *    function the live handler uses (Issue #377), so prod-vs-test drift is
 *    structurally impossible.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { runScenario, workingDiffersByHash, type ScenarioResult } from './cascadeHarness';
import { PRESENT_FIXTURES, probeLinesFor, type ScenarioFixture } from './cascadeFixtures';
import { installFixtureSafetyGuard } from './fixtureSafety';
import {
    workingDiffersFromBaseline,
    buildWorkingDiffBundle,
} from '../../src/handlers/replayWorkingChanges';
import { CommitTimelineReplay } from '../../src/core/replay/commitTimelineReplay';
import type { DiagramGraph } from '../../src/core/graph/graphTypes';

installFixtureSafetyGuard();

if (PRESENT_FIXTURES.length === 0) {
    describe.skip('timeline replay scenarios (no fixtures present)', () => {
        it('placeholder', () => { /* noop */ });
    });
}

for (const fixture of PRESENT_FIXTURES) {
    runTimelineReplayScenarioFor(fixture);
}

function runTimelineReplayScenarioFor(f: ScenarioFixture): void {
    describe(`timeline replay scenarios — ${f.id} (${f.language}/${f.framework})`, () => {
        let scenario: ScenarioResult;

        beforeAll(async () => {
            scenario = await runScenario({
                repoPath: f.repoPath,
                edits: [
                    {
                        filePath: f.canonical.relativePath,
                        op: { op: 'addLinesToFunction', fnName: f.canonical.fnName, lines: probeLinesFor(f) },
                    },
                ],
            });
        }, 60_000);

        afterAll(() => scenario?.dispose());

        it('workingDiffersFromBaseline returns true on the post-edit snapshot (catches today\'s .content vs .hash bug)', () => {
            expect(workingDiffersFromBaseline(scenario.baseline, scenario.working)).toBe(true);
            expect(workingDiffersByHash(scenario.baseline, scenario.working)).toBe(true);
        });

        it('playFromDiffResult builds at least one step per layer for a real-fixture working diff', () => {
            const diffedGraphs = buildWorkingDiffBundle(scenario.baseline, scenario.working);
            const steps = collectReplaySteps(diffedGraphs);
            expect(steps.length).toBeGreaterThan(0);

            const layers = new Set(steps.map(s => s.layer));
            expect(layers.has('L4 File')).toBe(true);
            expect(layers.has('L3 Sequence')).toBe(true);
            expect(layers.has('L2a Feature')).toBe(true);
            expect(layers.has('L1 System')).toBe(true);
        });

        it(`the edited file ${f.canonical.relativePath} appears at L4 step layer with the file name in changedEntity`, () => {
            const diffedGraphs = buildWorkingDiffBundle(scenario.baseline, scenario.working);
            const steps = collectReplaySteps(diffedGraphs);
            const l4 = steps.find(s => s.layer === 'L4 File');
            expect(l4).toBeDefined();
            expect(l4!.graphId).toBe(`file:${f.canonical.relativePath}`);
            expect(l4!.entity).toBe(path.basename(f.canonical.relativePath));
        });
    });
}

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
        10 * 60 * 1000, // 10 minutes — autoplay must never fire during the test.
    );
    replay.playFromDiffResult({
        diffedGraphs,
        baseHash: 'baseline',
        headHash: 'working',
        baseLabel: 'Baseline',
        headLabel: 'Working (uncommitted)',
    });
    // Walk through all steps manually.
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
