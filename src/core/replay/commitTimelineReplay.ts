/**
 * commitTimelineReplay.ts
 *
 * Replays a sequence of commits as a cinematic visualization.
 * For each commit pair, builds a diff snapshot and navigates through
 * diagram layers: L5 Flow → L4 File → L3 Sequence → L2a Feature → L2b API List → L1 System.
 *
 * Supports prev/next manual step navigation that auto-pauses auto-play.
 * Auto-pauses at the last step instead of ending — user navigates freely
 * and must explicitly stop to close the replay.
 */

import type { DiagramGraph, Snapshot } from '../graph/graphTypes';
import { parseGraphId, isGraphIdOfType } from '../graph/graphIdBuilder';
import { analytics } from '../../analytics/mixpanelService';

type ViewMode = 'sequence' | 'file' | 'flow' | 'feature' | 'microservice' | 'api-list' | 'health' | 'map' | 'domain' | 'tour';

export interface CommitInfo {
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    relativeDate: string;
}

export interface CommitDiffResult {
    diffedGraphs: Record<string, DiagramGraph>;
    headSnapshot: Snapshot;
    baseSnapshot: Snapshot;
}

export interface CommitReplayStep {
    commitHash: string;
    commitSubject: string;
    commitIndex: number;
    totalCommits: number;
    graphId: string;
    mode: ViewMode;
    label: string;
    layer: string;
    changedEntity: string;
    globalIndex: number;
    totalSteps: number;
    // #818 (2026-06-11) — cross-repo coda annotations. Present only on
    // coda frames appended after the per-repo replay; the player renders
    // a 🔗 chip + "Skip coda" control when `replayKind` is set.
    replayKind?: 'cross-repo-coda';
    codaProducer?: string;
    codaConsumer?: string;
}

interface ReplayCallbacks {
    navigate: (graphId: string, mode: ViewMode, graph: DiagramGraph, label: string) => void;
    setDiffContext: (baseHash: string, headHash: string, baseLabel: string, headLabel: string) => void;
    clearDiffContext: () => void;
    onStepStart: (step: CommitReplayStep) => void;
    onCommitStart: (index: number, total: number, hash: string, subject: string) => void;
    onReplayEnd: () => void;
    onPaused: () => void;
    onResumed: () => void;
}

interface GitOps {
    buildDiff: (base: string, head: string) => Promise<CommitDiffResult>;
}

/**
 * Per-layer step caps for commit replay. Exported (Issue 392 — Step-builder count caps not pinned) so a T3
 * scenario can pin them — silently changing a cap (e.g. dropping L5 to 1)
 * would otherwise ship unnoticed because every existing test asserts
 * "≥ 1 step per layer fired", not exact counts.
 */
export const MAX_FN_STEPS = 3;
export const MAX_FILE_STEPS = 3;
export const MAX_SEQ_STEPS = 2;
export const MAX_API_LIST_STEPS = 2;

/** Internal step with commit-pair tracking for diff context switching. */
interface InternalStep extends CommitReplayStep {
    diffPairIndex: number;
}

export class CommitTimelineReplay {
    private _isPlaying = false;
    private _isPaused = false;
    // BUG-REPLAY-SLOW-UPFRONT — true while the background diff-build loop is still
    // producing steps. When we hit the last BUILT step but more are coming, we wait
    // (don't auto-pause / end) instead of blocking the first frame on the full build.
    private _building = false;
    // Resolves when the background diff-build loop finishes — lets a test (or a
    // "jump to an as-yet-unbuilt commit" action) await full availability.
    private _buildPromise: Promise<void> = Promise.resolve();
    private autoPlayTimer: ReturnType<typeof setTimeout> | null = null;
    private stepDurationMs: number;

    // Pre-built step list and caches for prev/next navigation
    private allSteps: InternalStep[] = [];
    private diffCache = new Map<number, CommitDiffResult>();
    private pairContexts = new Map<number, { baseHash: string; headHash: string; baseLabel: string; headLabel: string }>();
    private currentStepIndex = -1;
    private activeDiffPairIndex = -1;

    constructor(
        private callbacks: ReplayCallbacks,
        private gitOps: GitOps,
        stepDurationMs = 2000,
    ) {
        this.stepDurationMs = stepDurationMs;
    }

    get isPlaying(): boolean { return this._isPlaying; }
    get isPaused(): boolean { return this._isPaused; }

    /** Resolves once the background diff-build (lazy step build) has finished. */
    async whenBuildSettled(): Promise<void> { await this._buildPromise; }

    setSpeed(ms: number): void {
        this.stepDurationMs = Math.max(500, Math.min(10000, ms));
    }

    /**
     * Start replay: build the FIRST commit pair's diff, begin playback IMMEDIATELY,
     * then build the remaining pairs in the BACKGROUND (BUG-REPLAY-SLOW-UPFRONT).
     * Playback (~stepDurationMs/step, ~a dozen steps/pair) is slower than a single
     * per-commit diff build, so the background build stays ahead and the user never
     * waits past the first pair (~one build) instead of the whole range (was ~735s
     * for 50 commits). Resolves once playback has started; building continues after.
     */
    async play(commits: CommitInfo[]): Promise<void> {
        if (commits.length < 2) return;
        this.resetState();
        this._isPlaying = true;
        this._isPaused = false;

        const totalCommits = commits.length - 1;

        try {
            // Build pairs until we have at least one playable step, then start.
            let i = 0;
            for (; i < totalCommits; i++) {
                if (!this._isPlaying) return;
                await this.buildAndAppendPair(commits, i, totalCommits);
                if (!this._isPlaying) return;
                if (this.allSteps.length > 0) break;
            }

            if (this.allSteps.length === 0) {
                // No commit in the range produced any change steps.
                this._isPlaying = false;
                this.callbacks.onReplayEnd();
                return;
            }

            // Start playback on the first built step immediately.
            this.currentStepIndex = 0;
            this.navigateToCurrentStep();
            this.scheduleNextAdvance();

            // Build the rest in the background (non-blocking; respects _isPlaying).
            this._buildPromise = this.buildRemainingInBackground(commits, i + 1, totalCommits);
        } catch (e) {
            if (this._isPlaying) {
                this._isPlaying = false;
                this._isPaused = false;
                this._building = false;
                this.clearAutoPlayTimer();
                this.callbacks.clearDiffContext();
                this.callbacks.onReplayEnd();
            }
            throw e;
        }
    }

    /** Build one commit pair's diff, append its steps, re-patch step indices. */
    private async buildAndAppendPair(commits: CommitInfo[], i: number, totalCommits: number): Promise<void> {
        const base = commits[i];
        const head = commits[i + 1];
        this.callbacks.onCommitStart(i, totalCommits, head.hash, head.subject);
        const diffResult = await this.gitOps.buildDiff(base.hash, head.hash);
        if (!this._isPlaying) return;
        this.diffCache.set(i, diffResult);
        this.pairContexts.set(i, {
            baseHash: base.hash,
            headHash: head.hash,
            baseLabel: `${base.shortHash} ${base.subject}`,
            headLabel: `${head.shortHash} ${head.subject}`,
        });
        const steps = this.buildSteps(diffResult, head, i, totalCommits);
        for (const s of steps) {
            this.allSteps.push({ ...s, diffPairIndex: i, globalIndex: 0, totalSteps: 0 });
        }
        // Re-patch global indices + total (the list grows as pairs build).
        for (let k = 0; k < this.allSteps.length; k++) {
            this.allSteps[k].globalIndex = k;
            this.allSteps[k].totalSteps = this.allSteps.length;
        }
    }

    /** Build remaining commit pairs after playback started; re-arm auto-play as steps land. */
    private async buildRemainingInBackground(commits: CommitInfo[], startI: number, totalCommits: number): Promise<void> {
        this._building = true;
        try {
            for (let i = startI; i < totalCommits; i++) {
                if (!this._isPlaying) return; // stop() / route-away cancels the build
                await this.buildAndAppendPair(commits, i, totalCommits);
                if (!this._isPlaying) return;
                // Steps arrived — if auto-play was idling at the build frontier
                // (not user-paused, no pending timer), resume advancing.
                if (this._isPlaying && !this._isPaused && this.autoPlayTimer === null
                    && this.currentStepIndex < this.allSteps.length - 1) {
                    this.scheduleNextAdvance();
                }
            }
        } finally {
            this._building = false;
            // Build done — if playback is parked at the (now truly final) step,
            // finalize the end-of-replay auto-pause.
            if (this._isPlaying && !this._isPaused && this.currentStepIndex >= this.allSteps.length - 1) {
                this.scheduleNextAdvance();
            }
        }
    }

    pause(): void {
        if (!this._isPlaying || this._isPaused) return;
        this._isPaused = true;
        this.clearAutoPlayTimer();
        this.callbacks.onPaused();
    }

    resume(): void {
        if (!this._isPaused || !this._isPlaying) return;
        this._isPaused = false;
        this.callbacks.onResumed();
        if (this.currentStepIndex < this.allSteps.length - 1) {
            this.scheduleNextAdvance();
        }
    }

    /** Advance to next step and auto-pause. */
    nextStep(): void {
        if (!this._isPlaying || this.currentStepIndex >= this.allSteps.length - 1) return;
        const wasPaused = this._isPaused;
        this._isPaused = true;
        this.clearAutoPlayTimer();
        this.currentStepIndex++;
        this.navigateToCurrentStep();
        if (!wasPaused) this.callbacks.onPaused();
    }

    /** Go to previous step and auto-pause. */
    prevStep(): void {
        if (!this._isPlaying || this.currentStepIndex <= 0) return;
        const wasPaused = this._isPaused;
        this._isPaused = true;
        this.clearAutoPlayTimer();
        this.currentStepIndex--;
        this.navigateToCurrentStep();
        if (!wasPaused) this.callbacks.onPaused();
    }

    /** Skip to first step of the next commit pair. */
    skipCommit(): void {
        if (!this._isPlaying || this.allSteps.length === 0) return;
        const current = this.allSteps[this.currentStepIndex];
        if (!current) return;

        const nextPairIdx = current.diffPairIndex + 1;
        const nextIdx = this.allSteps.findIndex(s => s.diffPairIndex === nextPairIdx);

        if (nextIdx < 0) {
            // No more commits — go to last step and auto-pause
            this.currentStepIndex = this.allSteps.length - 1;
            this.clearAutoPlayTimer();
            this.navigateToCurrentStep();
            if (!this._isPaused) {
                this._isPaused = true;
                this.callbacks.onPaused();
            }
            return;
        }

        this.clearAutoPlayTimer();
        this.currentStepIndex = nextIdx;
        this.navigateToCurrentStep();
        if (!this._isPaused) {
            this.scheduleNextAdvance();
        }
    }

    stop(): void {
        const wasPlaying = this._isPlaying;
        const exitedAtStep = this.currentStepIndex;
        const totalSteps = this.allSteps.length;
        this.resetState();
        if (wasPlaying) {
            // ADR-030 / Gap 1: distinguish completion (natural end via
            // scheduleNextAdvance) from abandonment (user clicked stop
            // before the last step). exitedAtStep === totalSteps - 1
            // would have been completion already; anything earlier is
            // abandonment.
            if (totalSteps > 0 && exitedAtStep < totalSteps - 1) {
                analytics.track('timeline_replay_abandoned', {
                    exited_at_step: exitedAtStep,
                    total_steps: totalSteps,
                    progress_percent: Math.round((exitedAtStep / totalSteps) * 100),
                });
            }
            this.callbacks.clearDiffContext();
            this.callbacks.onReplayEnd();
        }
    }

    /**
     * Replay an already-computed diff result (from Compare Commits / PR Diff / Branch Diff).
     * Skips the build phase entirely — starts playback instantly.
     */
    playFromDiffResult(opts: {
        diffedGraphs: Record<string, DiagramGraph>;
        baseHash: string;
        headHash: string;
        baseLabel: string;
        headLabel: string;
        /**
         * #818 (2026-06-11) — cross-repo coda frames appended after the
         * per-repo replay's last step. Pre-built server-side by
         * `buildCrossRepoCodaFrames` so both transports share them (R7).
         * Each frame's graph is registered into the diff cache; the step
         * carries `replayKind: 'cross-repo-coda'` for the player chip.
         */
        codaFrames?: Array<{
            graphId: string;
            mode: string;
            label: string;
            layer: string;
            changedEntity: string;
            graph: DiagramGraph;
            codaProducer: string;
            codaConsumer: string;
        }>;
    }): void {
        this.resetState();
        this._isPlaying = true;
        this._isPaused = false;

        const diffResult: CommitDiffResult = {
            diffedGraphs: opts.diffedGraphs,
            headSnapshot: { files: {}, apiIndex: {}, graphs: {} },
            baseSnapshot: { files: {}, apiIndex: {}, graphs: {} },
        };

        this.diffCache.set(0, diffResult);
        this.pairContexts.set(0, {
            baseHash: opts.baseHash,
            headHash: opts.headHash,
            baseLabel: opts.baseLabel,
            headLabel: opts.headLabel,
        });

        const commitStub: CommitInfo = {
            hash: opts.headHash,
            shortHash: opts.headHash.slice(0, 7),
            subject: opts.headLabel,
            author: '',
            relativeDate: '',
        };

        const steps = this.buildSteps(diffResult, commitStub, 0, 1);
        const codaFrames = opts.codaFrames ?? [];
        const total = steps.length + codaFrames.length;
        for (let i = 0; i < steps.length; i++) {
            this.allSteps.push({ ...steps[i], diffPairIndex: 0, globalIndex: i, totalSteps: total });
        }
        // #818 — append coda frames at the tail. The diff-annotated graph
        // already in the bundle wins (e.g. the workspace L1 carries diff
        // colors); the frame's own graph fills the gaps (consumer-repo
        // L3/L4 graphs the bundle never contained).
        for (let i = 0; i < codaFrames.length; i++) {
            const f = codaFrames[i];
            if (!diffResult.diffedGraphs[f.graphId]) {
                diffResult.diffedGraphs[f.graphId] = f.graph;
            }
            this.allSteps.push({
                commitHash: opts.headHash,
                commitSubject: opts.headLabel,
                commitIndex: 0,
                totalCommits: 1,
                graphId: f.graphId,
                mode: f.mode as ViewMode,
                label: f.label,
                layer: f.layer,
                changedEntity: f.changedEntity,
                replayKind: 'cross-repo-coda',
                codaProducer: f.codaProducer,
                codaConsumer: f.codaConsumer,
                diffPairIndex: 0,
                globalIndex: steps.length + i,
                totalSteps: total,
            });
        }

        if (this.allSteps.length === 0) {
            this._isPlaying = false;
            this.callbacks.onReplayEnd();
            return;
        }

        this.currentStepIndex = 0;
        this.callbacks.onCommitStart(0, 1, opts.headHash, opts.headLabel);
        this.navigateToCurrentStep();
        this.scheduleNextAdvance();
    }

    /**
     * Replay a filtered subset of an already-computed diff — only steps related to `filePath`.
     * Used for focused replay from the Changed Items sidebar.
     */
    playFocused(filePath: string, opts: {
        diffedGraphs: Record<string, DiagramGraph>;
        baseHash: string;
        headHash: string;
        baseLabel: string;
        headLabel: string;
    }): void {
        this.resetState();
        this._isPlaying = true;
        this._isPaused = false;

        const diffResult: CommitDiffResult = {
            diffedGraphs: opts.diffedGraphs,
            headSnapshot: { files: {}, apiIndex: {}, graphs: {} },
            baseSnapshot: { files: {}, apiIndex: {}, graphs: {} },
        };

        this.diffCache.set(0, diffResult);
        this.pairContexts.set(0, {
            baseHash: opts.baseHash,
            headHash: opts.headHash,
            baseLabel: opts.baseLabel,
            headLabel: opts.headLabel,
        });

        const commitStub: CommitInfo = {
            hash: opts.headHash,
            shortHash: opts.headHash.slice(0, 7),
            subject: opts.headLabel,
            author: '',
            relativeDate: '',
        };

        // Build all steps, then filter to those related to the target file
        const allStepsRaw = this.buildSteps(diffResult, commitStub, 0, 1);
        const filtered = allStepsRaw.filter(s => {
            // Always include L2a/L2b/L1 overview steps
            if (s.mode === 'feature' || s.mode === 'microservice') return true;
            // Include api-list if any of its cluster files match
            if (s.mode === 'api-list') {
                const graph = opts.diffedGraphs[s.graphId];
                const files = (graph?.meta as any)?.files as string[] | undefined;
                return files?.some(f => f === filePath) ?? false;
            }
            // Include flow/file/sequence steps that reference this file path
            return s.graphId.includes(filePath);
        });

        for (let i = 0; i < filtered.length; i++) {
            this.allSteps.push({ ...filtered[i], diffPairIndex: 0, globalIndex: i, totalSteps: filtered.length });
        }

        if (this.allSteps.length === 0) {
            this._isPlaying = false;
            this.callbacks.onReplayEnd();
            return;
        }

        this.currentStepIndex = 0;
        this.callbacks.onCommitStart(0, 1, opts.headHash, opts.headLabel);
        this.navigateToCurrentStep();
        this.scheduleNextAdvance();
    }

    // ── Private ──────────────────────────────────────────────────

    private resetState(): void {
        this._isPlaying = false;
        this._isPaused = false;
        this._building = false;
        this.clearAutoPlayTimer();
        this.allSteps = [];
        this.diffCache.clear();
        this.pairContexts.clear();
        this.currentStepIndex = -1;
        this.activeDiffPairIndex = -1;
    }

    private scheduleNextAdvance(): void {
        this.clearAutoPlayTimer();
        if (!this._isPlaying || this._isPaused) return;
        if (this.currentStepIndex >= this.allSteps.length - 1) {
            // At the last BUILT step. If the background build is still producing
            // more (BUG-REPLAY-SLOW-UPFRONT), wait at the frontier — the build loop
            // re-arms advance when new steps land. Don't auto-pause/complete yet.
            if (this._building) return;
            // Reached the genuine last step — auto-pause, don't end.
            // ADR-030 / Gap 1: track that replay completed naturally
            // (user watched every step). Distinct from stop() below
            // which fires `replay_abandoned`.
            analytics.track('timeline_replay_completed', {
                total_steps: this.allSteps.length,
            });
            this._isPaused = true;
            this.callbacks.onPaused();
            return;
        }

        this.autoPlayTimer = setTimeout(() => {
            this.autoPlayTimer = null;
            if (!this._isPlaying || this._isPaused) return;
            this.currentStepIndex++;
            this.navigateToCurrentStep();
            this.scheduleNextAdvance();
        }, this.stepDurationMs);
    }

    private clearAutoPlayTimer(): void {
        if (this.autoPlayTimer) {
            clearTimeout(this.autoPlayTimer);
            this.autoPlayTimer = null;
        }
    }

    private navigateToCurrentStep(): void {
        const step = this.allSteps[this.currentStepIndex];
        if (!step) return;

        // Switch diff context if commit pair changed
        if (step.diffPairIndex !== this.activeDiffPairIndex) {
            const ctx = this.pairContexts.get(step.diffPairIndex);
            if (ctx) {
                this.callbacks.setDiffContext(ctx.baseHash, ctx.headHash, ctx.baseLabel, ctx.headLabel);
                this.activeDiffPairIndex = step.diffPairIndex;
            }
        }

        this.callbacks.onCommitStart(step.commitIndex, step.totalCommits, step.commitHash, step.commitSubject);

        const diffResult = this.diffCache.get(step.diffPairIndex);
        const graph = diffResult?.diffedGraphs[step.graphId];
        if (!graph) return;

        this.callbacks.onStepStart(step);
        this.callbacks.navigate(step.graphId, step.mode, graph, step.label);
    }

    private buildSteps(
        diffResult: CommitDiffResult,
        commit: CommitInfo,
        commitIndex: number,
        totalCommits: number,
    ): Omit<CommitReplayStep, 'globalIndex' | 'totalSteps'>[] {
        const steps: Omit<CommitReplayStep, 'globalIndex' | 'totalSteps'>[] = [];
        const base = { commitHash: commit.hash, commitSubject: commit.subject, commitIndex, totalCommits };

        const changedFiles: string[] = [];
        const changedFunctions: Array<{ filePath: string; fnName: string }> = [];

        for (const [graphId, graph] of Object.entries(diffResult.diffedGraphs)) {
            // Issue #362 Phase B (2026-06-07) — structured parse.
            const parsed = parseGraphId(graphId);
            if (!parsed) continue;
            if (parsed.type === 'file') {
                const fp = parsed.parts[0] ?? '';
                if (graph.nodes.some(n => n.diff && n.diff !== 'unchanged')) changedFiles.push(fp);
            } else if (parsed.type === 'flow') {
                const filePath = parsed.parts[0] ?? '';
                const fnName = parsed.parts[1] ?? '';
                if (filePath && fnName && graph.nodes.some(n => n.diff && n.diff !== 'unchanged')) {
                    changedFunctions.push({ filePath, fnName });
                }
            }
        }

        // If a function changed, its parent file also changed — ensure L4 includes it
        // Only add if the file graph exists and has actual diff annotations
        for (const { filePath } of changedFunctions) {
            if (changedFiles.includes(filePath)) continue;
            const fg = diffResult.diffedGraphs[`file:${filePath}`];
            if (fg) changedFiles.push(filePath);
        }

        // L5 Flow — changed functions (max 3)
        for (const { filePath, fnName } of changedFunctions.slice(0, MAX_FN_STEPS)) {
            steps.push({
                ...base,
                graphId: `flow:${filePath}:${fnName}`,
                mode: 'flow',
                label: `Flow: ${fnName}`,
                layer: 'L5 Flow',
                changedEntity: fnName,
            });
        }

        // L4 File — changed files (max 3)
        for (const fp of changedFiles.slice(0, MAX_FILE_STEPS)) {
            steps.push({
                ...base,
                graphId: `file:${fp}`,
                mode: 'file',
                label: `File: ${fp.split('/').pop()}`,
                layer: 'L4 File',
                changedEntity: fp.split('/').pop() ?? fp,
            });
        }

        // L3 Sequence — affected sequence diagrams (max 2)
        let seqCount = 0;
        for (const [graphId, graph] of Object.entries(diffResult.diffedGraphs)) {
            if (seqCount >= MAX_SEQ_STEPS) break;
            const parsed = parseGraphId(graphId);
            if (parsed?.type === 'sequence' && graph.nodes.some(n => n.diff && n.diff !== 'unchanged')) {
                // The handler name is the second part — preserved verbatim
                // by the parser even when it contains its own colons
                // (e.g. `anonymous@GET:/users`). The old `.split(':').pop()`
                // returned just the trailing route fragment which was wrong
                // for routes with verbs in the handler name.
                const handler = parsed.parts[1] ?? '';
                steps.push({
                    ...base,
                    graphId,
                    mode: 'sequence',
                    label: `Sequence: ${handler}`,
                    layer: 'L3 Sequence',
                    changedEntity: handler,
                });
                seqCount++;
            }
        }

        // L2a Feature — feature diagram (if exists)
        const featureGraphId = Object.keys(diffResult.diffedGraphs).find(id => id.startsWith('feature:'));
        if (featureGraphId) {
            steps.push({
                ...base,
                graphId: featureGraphId,
                mode: 'feature',
                label: 'Feature Areas',
                layer: 'L2a Feature',
                changedEntity: 'clusters',
            });
        }

        // L2b API List — affected API lists with changed APIs (max 2)
        let apiCount = 0;
        for (const [graphId, graph] of Object.entries(diffResult.diffedGraphs)) {
            if (apiCount >= MAX_API_LIST_STEPS) break;
            if (isGraphIdOfType(graphId, 'api-list')) {
                const apis = (graph.meta as any)?.apis as any[] | undefined;
                if (apis?.some((a: any) => a.diff && a.diff !== 'unchanged')) {
                    const clusterLabel = (graph.meta as any)?.clusterLabel ?? graphId.slice('api-list:'.length);
                    steps.push({
                        ...base,
                        graphId,
                        mode: 'api-list',
                        label: `APIs: ${clusterLabel}`,
                        layer: 'L2b API List',
                        changedEntity: clusterLabel,
                    });
                    apiCount++;
                }
            }
        }

        // L1 System Design
        if (diffResult.diffedGraphs['microservice:workspace']) {
            steps.push({
                ...base,
                graphId: 'microservice:workspace',
                mode: 'microservice',
                label: 'System Design',
                layer: 'L1 System',
                changedEntity: 'services',
            });
        }

        return steps;
    }
}
