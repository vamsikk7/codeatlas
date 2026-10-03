import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommitTimelineReplay, type CommitInfo, type CommitDiffResult } from '../commitTimelineReplay';
import type { DiagramGraph, Snapshot } from '../../graph/graphTypes';

const mockGraph: DiagramGraph = { graphId: 'test', type: 'flow', nodes: [{ id: 'n1', type: 'function', label: 'fn', diff: 'modified' }], edges: [], anchors: {}, meta: {} };
const mockMicroGraph: DiagramGraph = { graphId: 'microservice:workspace', type: 'microservice', nodes: [{ id: 's1', type: 'service', label: 'svc', diff: 'modified' }], edges: [], anchors: {}, meta: {} };
const mockFeatureGraph: DiagramGraph = { graphId: 'feature:workspace', type: 'feature', nodes: [{ id: 'c1', type: 'cluster', label: 'auth', diff: 'modified' }], edges: [], anchors: {}, meta: {} };
const mockSeqGraph: DiagramGraph = { graphId: 'sequence:src/auth.ts:handleLogin', type: 'sequence', nodes: [{ id: 'p1', type: 'participant', label: 'handler', diff: 'modified' }], edges: [], anchors: {}, meta: {} };
const mockApiListGraph: DiagramGraph = {
    graphId: 'api-list:auth', type: 'api-list', nodes: [], edges: [], anchors: {},
    meta: { apis: [{ apiId: 'login', diff: 'modified' }], clusterLabel: 'Auth' },
};

function makeCommits(count: number): CommitInfo[] {
    return Array.from({ length: count }, (_, i) => ({
        hash: `hash${i}`, shortHash: `h${i}`, subject: `commit ${i}`, author: 'test', relativeDate: `${i}m ago`,
    }));
}

function makeDiffResult(): CommitDiffResult {
    return {
        diffedGraphs: {
            'flow:src/auth.ts:login': { ...mockGraph, graphId: 'flow:src/auth.ts:login' },
            'file:src/auth.ts': { ...mockGraph, graphId: 'file:src/auth.ts', type: 'file' },
            'sequence:src/auth.ts:handleLogin': mockSeqGraph,
            'feature:workspace': mockFeatureGraph,
            'api-list:auth': mockApiListGraph,
            'microservice:workspace': mockMicroGraph,
        },
        headSnapshot: { files: {}, apiIndex: {}, graphs: {} },
        baseSnapshot: { files: {}, apiIndex: {}, graphs: {} },
    };
}

function makeCallbacks() {
    return {
        navigate: vi.fn(),
        setDiffContext: vi.fn(),
        clearDiffContext: vi.fn(),
        onStepStart: vi.fn(),
        onCommitStart: vi.fn(),
        onReplayEnd: vi.fn(),
        onPaused: vi.fn(),
        onResumed: vi.fn(),
    };
}

/** Wait for a condition to become true (poll-based). */
function waitFor(fn: () => boolean, timeout = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            if (fn()) { resolve(); return; }
            if (Date.now() - start > timeout) { reject(new Error('waitFor timeout')); return; }
            setTimeout(check, 5);
        };
        check();
    });
}

describe('CommitTimelineReplay', () => {
    it('builds steps and auto-plays through all layers including L2b and L1', async () => {
        const cbs = makeCallbacks();
        const buildDiff = vi.fn().mockResolvedValue(makeDiffResult());
        const replay = new CommitTimelineReplay(cbs, { buildDiff }, 1);

        await replay.play(makeCommits(3));

        // Wait for auto-pause at end (all steps navigated)
        await waitFor(() => cbs.onPaused.mock.calls.length > 0);

        // 2 commit pairs
        expect(buildDiff).toHaveBeenCalledTimes(2);
        // Each commit pair: L5 flow + L4 file + L3 sequence + L2a feature + L2b api-list + L1 micro = 6 steps × 2 = 12
        expect(cbs.navigate.mock.calls.length).toBe(12);
        // Diff context set per commit pair
        expect(cbs.setDiffContext).toHaveBeenCalledTimes(2);
        // Auto-paused at end, not ended
        expect(cbs.onReplayEnd).not.toHaveBeenCalled();
        expect(replay.isPlaying).toBe(true);
        expect(replay.isPaused).toBe(true);
    });

    it('renders step 1 after building only the FIRST pair — does NOT wait for the whole range (BUG-REPLAY-SLOW-UPFRONT)', async () => {
        const cbs = makeCallbacks();
        let calls = 0;
        // Pair 0 builds instantly; every later pair "hangs" (slow build). The old
        // code awaited ALL builds before showing step 1 (~735s on 50 commits) —
        // this asserts playback starts on pair 0 without waiting for the rest.
        const buildDiff = vi.fn().mockImplementation(() => {
            calls++;
            return calls === 1 ? Promise.resolve(makeDiffResult()) : new Promise<any>(() => { /* never resolves */ });
        });
        const replay = new CommitTimelineReplay(cbs, { buildDiff }, 60000);

        await replay.play(makeCommits(6)); // 5 pairs; only pair 0 resolves

        // Playback already started on step 0 of pair 0 despite pairs 1-4 unbuilt.
        expect(cbs.navigate).toHaveBeenCalledTimes(1);
        expect(cbs.onStepStart.mock.calls.at(-1)[0].globalIndex).toBe(0);
        expect(replay.isPlaying).toBe(true);
        // Pair 0 built (resolved) + pair 1 build kicked off (hanging) = 2 calls,
        // NOT all 5 — the upfront full-range build is gone.
        expect(buildDiff).toHaveBeenCalledTimes(2);

        replay.stop();
    });

    it('includes L2b API List and L1 System Design in step order', async () => {
        const cbs = makeCallbacks();
        const buildDiff = vi.fn().mockResolvedValue(makeDiffResult());
        const replay = new CommitTimelineReplay(cbs, { buildDiff }, 1);

        await replay.play(makeCommits(2));
        await waitFor(() => cbs.onPaused.mock.calls.length > 0);

        const layers = cbs.onStepStart.mock.calls.map((c: any) => c[0].layer);
        expect(layers).toEqual([
            'L5 Flow', 'L4 File', 'L3 Sequence', 'L2a Feature', 'L2b API List', 'L1 System',
        ]);
    });

    it('step objects include globalIndex and totalSteps', async () => {
        const cbs = makeCallbacks();
        const buildDiff = vi.fn().mockResolvedValue(makeDiffResult());
        const replay = new CommitTimelineReplay(cbs, { buildDiff }, 1);

        await replay.play(makeCommits(2));
        await waitFor(() => cbs.onPaused.mock.calls.length > 0);

        const steps = cbs.onStepStart.mock.calls.map((c: any) => c[0]);
        expect(steps[0].globalIndex).toBe(0);
        expect(steps[0].totalSteps).toBe(6);
        expect(steps[5].globalIndex).toBe(5);
        expect(steps[5].totalSteps).toBe(6);
    });

    it('stop() fires cleanup callbacks', async () => {
        const cbs = makeCallbacks();
        const buildDiff = vi.fn().mockResolvedValue(makeDiffResult());
        const replay = new CommitTimelineReplay(cbs, { buildDiff }, 5000);

        await replay.play(makeCommits(3));
        expect(replay.isPlaying).toBe(true);

        replay.stop();
        expect(replay.isPlaying).toBe(false);
        expect(cbs.clearDiffContext).toHaveBeenCalled();
        expect(cbs.onReplayEnd).toHaveBeenCalled();
    });

    it('pause/resume works', async () => {
        const cbs = makeCallbacks();
        const buildDiff = vi.fn().mockResolvedValue(makeDiffResult());
        const replay = new CommitTimelineReplay(cbs, { buildDiff }, 1); // fast steps

        await replay.play(makeCommits(3));
        expect(cbs.navigate.mock.calls.length).toBe(1); // first step navigated immediately

        replay.pause();
        expect(replay.isPaused).toBe(true);
        expect(cbs.onPaused).toHaveBeenCalledTimes(1);

        replay.resume();
        expect(replay.isPaused).toBe(false);
        expect(cbs.onResumed).toHaveBeenCalledTimes(1);

        // Eventually auto-play resumes and finishes
        await waitFor(() => cbs.onPaused.mock.calls.length >= 2); // paused again at end
        expect(cbs.navigate.mock.calls.length).toBe(12); // all 12 steps
    });

    it('nextStep() advances and auto-pauses', async () => {
        const cbs = makeCallbacks();
        const buildDiff = vi.fn().mockResolvedValue(makeDiffResult());
        const replay = new CommitTimelineReplay(cbs, { buildDiff }, 60000); // very slow auto-play

        await replay.play(makeCommits(2));
        expect(cbs.navigate).toHaveBeenCalledTimes(1); // first step

        // Manual next
        replay.nextStep();
        expect(cbs.navigate).toHaveBeenCalledTimes(2);
        expect(replay.isPaused).toBe(true);
        expect(cbs.onPaused).toHaveBeenCalledTimes(1); // paused from auto-play
        expect(cbs.onStepStart.mock.calls[1][0].layer).toBe('L4 File');

        // Next again (already paused, no duplicate onPaused)
        replay.nextStep();
        expect(cbs.navigate).toHaveBeenCalledTimes(3);
        expect(cbs.onPaused).toHaveBeenCalledTimes(1); // no extra pause callback
        expect(cbs.onStepStart.mock.calls[2][0].layer).toBe('L3 Sequence');

        replay.stop();
    });

    it('prevStep() goes backward and auto-pauses', async () => {
        const cbs = makeCallbacks();
        const buildDiff = vi.fn().mockResolvedValue(makeDiffResult());
        const replay = new CommitTimelineReplay(cbs, { buildDiff }, 60000);

        await replay.play(makeCommits(2));

        // Advance manually to step 2
        replay.nextStep();
        replay.nextStep();
        expect(cbs.onStepStart.mock.calls[2][0].layer).toBe('L3 Sequence');

        // Go back
        replay.prevStep();
        expect(cbs.onStepStart.mock.calls[3][0].layer).toBe('L4 File');
        expect(cbs.onStepStart.mock.calls[3][0].globalIndex).toBe(1);

        replay.prevStep();
        expect(cbs.onStepStart.mock.calls[4][0].layer).toBe('L5 Flow');
        expect(cbs.onStepStart.mock.calls[4][0].globalIndex).toBe(0);

        // prevStep at start does nothing
        replay.prevStep();
        expect(cbs.navigate.mock.calls.length).toBe(5); // no additional navigate

        replay.stop();
    });

    it('nextStep() at last step is a no-op', async () => {
        const cbs = makeCallbacks();
        const buildDiff = vi.fn().mockResolvedValue(makeDiffResult());
        const replay = new CommitTimelineReplay(cbs, { buildDiff }, 1);

        await replay.play(makeCommits(2));
        await waitFor(() => cbs.onPaused.mock.calls.length > 0);

        const navCount = cbs.navigate.mock.calls.length;
        replay.nextStep(); // already at last step
        expect(cbs.navigate.mock.calls.length).toBe(navCount); // no change
    });

    it('skipCommit() jumps to next commit pair', async () => {
        const cbs = makeCallbacks();
        const buildDiff = vi.fn().mockResolvedValue(makeDiffResult());
        const replay = new CommitTimelineReplay(cbs, { buildDiff }, 60000);

        await replay.play(makeCommits(3)); // 2 commit pairs, 12 total steps
        await replay.whenBuildSettled(); // lazy build: let pair 1 finish building
        expect(cbs.navigate).toHaveBeenCalledTimes(1); // step 0 of pair 0

        replay.skipCommit();
        // Should jump to first step of pair 1 (index 6)
        const lastStep = cbs.onStepStart.mock.calls.at(-1)[0];
        expect(lastStep.commitIndex).toBe(1);
        expect(lastStep.globalIndex).toBe(6);
        expect(lastStep.layer).toBe('L5 Flow');

        replay.stop();
    });

    it('skipCommit() at last commit goes to last step and pauses', async () => {
        const cbs = makeCallbacks();
        const buildDiff = vi.fn().mockResolvedValue(makeDiffResult());
        const replay = new CommitTimelineReplay(cbs, { buildDiff }, 60000);

        await replay.play(makeCommits(2)); // 1 commit pair
        replay.skipCommit();

        const lastStep = cbs.onStepStart.mock.calls.at(-1)[0];
        expect(lastStep.globalIndex).toBe(5); // last step
        expect(replay.isPaused).toBe(true);

        replay.stop();
    });

    it('prev/next across commit pair boundaries switches diff context', async () => {
        const cbs = makeCallbacks();
        const buildDiff = vi.fn().mockResolvedValue(makeDiffResult());
        const replay = new CommitTimelineReplay(cbs, { buildDiff }, 60000);

        await replay.play(makeCommits(3)); // 2 commit pairs
        await replay.whenBuildSettled(); // lazy build: let pair 1 finish building

        // Navigate to last step of pair 0
        for (let i = 0; i < 5; i++) replay.nextStep();
        expect(cbs.onStepStart.mock.calls.at(-1)[0].globalIndex).toBe(5);
        expect(cbs.setDiffContext).toHaveBeenCalledTimes(1); // only pair 0

        // Next step crosses into pair 1
        replay.nextStep();
        expect(cbs.onStepStart.mock.calls.at(-1)[0].globalIndex).toBe(6);
        expect(cbs.setDiffContext).toHaveBeenCalledTimes(2); // pair 1 context set

        // Prev step back to pair 0
        replay.prevStep();
        expect(cbs.onStepStart.mock.calls.at(-1)[0].globalIndex).toBe(5);
        expect(cbs.setDiffContext).toHaveBeenCalledTimes(3); // pair 0 context restored

        replay.stop();
    });

    it('resume after manual navigation continues auto-play from current position', async () => {
        const cbs = makeCallbacks();
        const buildDiff = vi.fn().mockResolvedValue(makeDiffResult());
        const replay = new CommitTimelineReplay(cbs, { buildDiff }, 1);

        await replay.play(makeCommits(2)); // 6 steps

        // Manual advance to step 2
        replay.nextStep();
        replay.nextStep();
        expect(cbs.onStepStart.mock.calls.at(-1)[0].globalIndex).toBe(2);

        // Resume — auto-play continues from step 2
        replay.resume();
        await waitFor(() => replay.isPaused); // waits for auto-pause at end

        // Should have visited all remaining steps
        const globalIndices = cbs.onStepStart.mock.calls.map((c: any) => c[0].globalIndex);
        // After resume: 3, 4, 5 should be visited
        expect(globalIndices).toContain(3);
        expect(globalIndices).toContain(4);
        expect(globalIndices).toContain(5);

        replay.stop();
    });

    it('setSpeed changes step duration', () => {
        const cbs = makeCallbacks();
        const replay = new CommitTimelineReplay(cbs, { buildDiff: vi.fn() }, 2000);
        replay.setSpeed(500);
        replay.setSpeed(100); // should clamp to 500
        replay.setSpeed(99999); // should clamp to 10000
    });

    it('handles less than 2 commits gracefully', async () => {
        const cbs = makeCallbacks();
        const replay = new CommitTimelineReplay(cbs, { buildDiff: vi.fn() }, 10);
        await replay.play(makeCommits(1));
        expect(cbs.onCommitStart).not.toHaveBeenCalled();
    });

    it('empty commits array is a no-op', async () => {
        const cbs = makeCallbacks();
        const replay = new CommitTimelineReplay(cbs, { buildDiff: vi.fn() }, 10);
        await replay.play([]);
        expect(cbs.navigate).not.toHaveBeenCalled();
    });

    describe('playFromDiffResult', () => {
        it('replays pre-computed diffedGraphs instantly without buildDiff', async () => {
            const cbs = makeCallbacks();
            const replay = new CommitTimelineReplay(cbs, { buildDiff: vi.fn() }, 1);

            const diff = makeDiffResult();
            replay.playFromDiffResult({
                diffedGraphs: diff.diffedGraphs,
                baseHash: 'abc123',
                headHash: 'def456',
                baseLabel: 'abc123 base commit',
                headLabel: 'def456 head commit',
            });

            await waitFor(() => cbs.onPaused.mock.calls.length > 0);

            // All 6 layers navigated
            expect(cbs.navigate.mock.calls.length).toBe(6);
            const layers = cbs.onStepStart.mock.calls.map((c: any) => c[0].layer);
            expect(layers).toEqual(['L5 Flow', 'L4 File', 'L3 Sequence', 'L2a Feature', 'L2b API List', 'L1 System']);
            // Diff context set once
            expect(cbs.setDiffContext).toHaveBeenCalledWith('abc123', 'def456', 'abc123 base commit', 'def456 head commit');
            // No buildDiff calls
            expect(cbs.onReplayEnd).not.toHaveBeenCalled();

            replay.stop();
        });

        it('supports prev/next after playFromDiffResult', () => {
            const cbs = makeCallbacks();
            const replay = new CommitTimelineReplay(cbs, { buildDiff: vi.fn() }, 60000);

            replay.playFromDiffResult({
                diffedGraphs: makeDiffResult().diffedGraphs,
                baseHash: 'a', headHash: 'b', baseLabel: 'a', headLabel: 'b',
            });

            expect(cbs.navigate).toHaveBeenCalledTimes(1); // first step
            replay.nextStep();
            expect(cbs.navigate).toHaveBeenCalledTimes(2);
            replay.prevStep();
            expect(cbs.navigate).toHaveBeenCalledTimes(3);
            expect(cbs.onStepStart.mock.calls[2][0].globalIndex).toBe(0);

            replay.stop();
        });

        it('empty diffedGraphs fires onReplayEnd', () => {
            const cbs = makeCallbacks();
            const replay = new CommitTimelineReplay(cbs, { buildDiff: vi.fn() }, 1);

            replay.playFromDiffResult({
                diffedGraphs: {},
                baseHash: 'a', headHash: 'b', baseLabel: 'a', headLabel: 'b',
            });

            expect(cbs.onReplayEnd).toHaveBeenCalledTimes(1);
            expect(replay.isPlaying).toBe(false);
        });

        // #818 (2026-06-11) — cross-repo coda frames appended at the tail.
        it('appends codaFrames after the per-repo steps with replayKind + adjusted totals', async () => {
            const cbs = makeCallbacks();
            const replay = new CommitTimelineReplay(cbs, { buildDiff: vi.fn() }, 1);

            const codaGraph = { graphId: 'sequence:consumer/client.js:fetchItems', type: 'sequence', nodes: [], edges: [] } as any;
            replay.playFromDiffResult({
                diffedGraphs: makeDiffResult().diffedGraphs,
                baseHash: 'a', headHash: 'b', baseLabel: 'a', headLabel: 'b',
                codaFrames: [{
                    graphId: 'sequence:consumer/client.js:fetchItems',
                    mode: 'sequence',
                    label: '🔗 producer → consumer — consuming flow (L3)',
                    layer: 'L3 Cross-repo',
                    changedEntity: 'consumer',
                    graph: codaGraph,
                    codaProducer: 'producer',
                    codaConsumer: 'consumer',
                }],
            });

            await waitFor(() => cbs.onPaused.mock.calls.length > 0);

            const steps = cbs.onStepStart.mock.calls.map((c: any) => c[0]);
            // 6 per-repo layers + 1 coda frame, totals include the coda.
            expect(steps.length).toBe(7);
            expect(steps.every((s: any) => s.totalSteps === 7)).toBe(true);
            const coda = steps[6];
            expect(coda.replayKind).toBe('cross-repo-coda');
            expect(coda.codaProducer).toBe('producer');
            expect(coda.codaConsumer).toBe('consumer');
            expect(coda.layer).toBe('L3 Cross-repo');
            // The coda graph was registered + navigated.
            const lastNav = cbs.navigate.mock.calls[cbs.navigate.mock.calls.length - 1];
            expect(lastNav[0]).toBe('sequence:consumer/client.js:fetchItems');

            replay.stop();
        });

        it('codaFrames never overwrite a diff-annotated graph already in the bundle', () => {
            const cbs = makeCallbacks();
            const replay = new CommitTimelineReplay(cbs, { buildDiff: vi.fn() }, 60000);

            const bundle = makeDiffResult().diffedGraphs;
            const bundleL1 = bundle['microservice:workspace'];
            replay.playFromDiffResult({
                diffedGraphs: bundle,
                baseHash: 'a', headHash: 'b', baseLabel: 'a', headLabel: 'b',
                codaFrames: [{
                    graphId: 'microservice:workspace',
                    mode: 'microservice',
                    label: '🔗 producer → consumer — impacted consumer (L1)',
                    layer: 'L1 Cross-repo',
                    changedEntity: 'consumer',
                    graph: { graphId: 'microservice:workspace', type: 'microservice', nodes: [], edges: [] } as any,
                    codaProducer: 'producer',
                    codaConsumer: 'consumer',
                }],
            });

            // Bundle's diff-annotated L1 wins over the frame's bare copy.
            expect(bundle['microservice:workspace']).toBe(bundleL1);
            replay.stop();
        });
    });

    describe('playFocused', () => {
        it('filters steps to only those related to the target file', async () => {
            const cbs = makeCallbacks();
            const replay = new CommitTimelineReplay(cbs, { buildDiff: vi.fn() }, 1);

            replay.playFocused('src/auth.ts', {
                diffedGraphs: makeDiffResult().diffedGraphs,
                baseHash: 'a', headHash: 'b', baseLabel: 'a', headLabel: 'b',
            });

            await waitFor(() => cbs.onPaused.mock.calls.length > 0);

            const layers = cbs.onStepStart.mock.calls.map((c: any) => c[0].layer);
            // Should include: L5 flow (src/auth.ts:login), L4 file (src/auth.ts),
            // L3 sequence (src/auth.ts:handleLogin), L2a feature, L1 system
            expect(layers).toContain('L5 Flow');
            expect(layers).toContain('L4 File');
            expect(layers).toContain('L3 Sequence');
            expect(layers).toContain('L2a Feature');
            expect(layers).toContain('L1 System');
            // Should NOT contain unrelated steps
            expect(cbs.onStepStart.mock.calls.length).toBeLessThanOrEqual(6);

            replay.stop();
        });

        it('empty match fires onReplayEnd', () => {
            const cbs = makeCallbacks();
            const replay = new CommitTimelineReplay(cbs, { buildDiff: vi.fn() }, 1);

            replay.playFocused('nonexistent/file.ts', {
                diffedGraphs: makeDiffResult().diffedGraphs,
                baseHash: 'a', headHash: 'b', baseLabel: 'a', headLabel: 'b',
            });

            // Feature + microservice steps are always included, so this won't be empty
            // But for a truly empty result, use empty diffedGraphs
            replay.stop();

            const cbs2 = makeCallbacks();
            const replay2 = new CommitTimelineReplay(cbs2, { buildDiff: vi.fn() }, 1);
            replay2.playFocused('nonexistent.ts', {
                diffedGraphs: {},
                baseHash: 'a', headHash: 'b', baseLabel: 'a', headLabel: 'b',
            });
            expect(cbs2.onReplayEnd).toHaveBeenCalledTimes(1);
        });
    });

    // Issue 370: timeline replay across new entry-point types. The replay
    // iterates `diffedGraphs` by graph type (flow/file/sequence/feature/
    // api-list/microservice) regardless of what underlying method drives
    // the graph. So a sequence graph for a Celery `@shared_task` handler,
    // or a flow graph for a Kafka consumer's `onMessage` body, gets played
    // through exactly the same way an HTTP route's diagrams do.
    describe('replay across non-HTTP entry-point types (Issue 370)', () => {
        function diffResultWithEntryPointTypes(): CommitDiffResult {
            // Same shape as the standard mock but with graph IDs that
            // reflect realistic Tier 1/2 entry-point handlers — proves the
            // step iteration is method-agnostic.
            const flow: DiagramGraph = { ...mockGraph, graphId: 'flow:app/tasks.py:send_email_task' };
            const file: DiagramGraph = { ...mockGraph, graphId: 'file:app/tasks.py', type: 'file' };
            const seq: DiagramGraph = { ...mockSeqGraph, graphId: 'sequence:app/tasks.py:send_email_task' };
            const apiList: DiagramGraph = {
                ...mockApiListGraph,
                meta: {
                    apis: [{ apiId: 'celery:send_email_task', method: 'JOB', diff: 'added' }],
                    clusterLabel: 'Async',
                },
            };
            return {
                diffedGraphs: {
                    [flow.graphId]: flow,
                    [file.graphId]: file,
                    [seq.graphId]: seq,
                    'feature:workspace': mockFeatureGraph,
                    [apiList.graphId]: apiList,
                    'microservice:workspace': mockMicroGraph,
                },
                headSnapshot: { files: {}, apiIndex: {}, graphs: {} },
                baseSnapshot: { files: {}, apiIndex: {}, graphs: {} },
            };
        }

        it('plays flow + file + sequence graphs whose IDs point at non-HTTP handlers', async () => {
            const cbs = makeCallbacks();
            const buildDiff = vi.fn().mockResolvedValue(diffResultWithEntryPointTypes());
            const replay = new CommitTimelineReplay(cbs, { buildDiff }, 1);
            await replay.play(makeCommits(2));
            await waitFor(() => cbs.onPaused.mock.calls.length > 0);

            // Should hit all 6 layers per commit pair (1 pair × 6 steps = 6 navigates).
            expect(cbs.navigate.mock.calls.length).toBe(6);

            // Confirm the navigate ids include the celery-task-derived graphs.
            const navigatedIds = cbs.navigate.mock.calls.map(call => call[0]);
            expect(navigatedIds).toContain('flow:app/tasks.py:send_email_task');
            expect(navigatedIds).toContain('file:app/tasks.py');
            expect(navigatedIds).toContain('sequence:app/tasks.py:send_email_task');
        });
    });
});
