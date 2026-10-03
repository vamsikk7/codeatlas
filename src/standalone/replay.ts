/**
 * replay.ts — standalone timeline-replay wiring.
 *
 * Reuses the pure-JS `CommitTimelineReplay` engine. Bridges its callbacks
 * to WS broadcasts so the browser shows the same replay HUD + auto-paged
 * diagrams as the VS Code extension.
 *
 * Supports:
 *   - "Replay Working Changes" (working-vs-baseline) via `replayWorkingDiff`
 *   - `stopReplay`
 *   - `timelineReplayControl` (pause / resume / next / prev / restart)
 *   - `timelineReplaySpeed`
 *
 * #915 (2026-06-26): commit-history replay is wired via the shared
 * `buildCommitDiffGraphs` core (same as `gitDiff.ts`). The working-changes path
 * here uses `playFromDiffResult` (a pre-built single diff), so the engine's
 * multi-commit `play()` → `buildDiff` callback isn't exercised on this path —
 * but it's now correct rather than throwing, so the two replay engines agree
 * and a future caller can `play()` a commit list without hitting a dead error.
 * (The live commit-history replay UI goes through `gitDiff.ts`'s engine.)
 */

import { CommitTimelineReplay } from '../core/replay/commitTimelineReplay';
import { buildWorkingDiffBundle, workingDiffersFromBaseline } from '../handlers/replayWorkingChanges';
import { buildCommitDiffGraphs } from '../core/git/commitDiffer';
import type { SnapshotStore } from '../core/storage/snapshotStore';
import type { WsBridge } from '../server/wsBridge';

export interface ReplayDeps {
    /** Git root for commit-history `buildDiff` (#915). */
    workspaceRoot: string;
    snapshotStore: SnapshotStore;
    wsBridge: WsBridge;
    log: (msg: string) => void;
}

export interface ReplayState {
    /** Lazily constructed because the gitOps callback needs `deps.snapshotStore`. */
    timeline: CommitTimelineReplay | null;
}

export function createReplayState(): ReplayState {
    return { timeline: null };
}

function ensureTimeline(deps: ReplayDeps, state: ReplayState): CommitTimelineReplay {
    if (state.timeline) return state.timeline;

    state.timeline = new CommitTimelineReplay(
        {
            // Each event becomes a WS broadcast the webview already knows how
            // to render — same message shapes the extension uses.
            navigate: (graphId, mode, graph, label) => {
                deps.wsBridge.broadcast({ type: 'navigateTo', graphId, mode, graph, label });
            },
            setDiffContext: (baseHash, headHash, baseLabel, headLabel) => {
                deps.wsBridge.broadcast({ type: 'setGitDiffContext', baseHash, headHash, baseLabel, headLabel });
            },
            clearDiffContext: () => {
                deps.wsBridge.broadcast({ type: 'clearGitDiffContext' });
            },
            onStepStart: (step) => {
                deps.wsBridge.broadcast({ type: 'replayStep', step });
            },
            onCommitStart: (index, total, hash, subject) => {
                deps.wsBridge.broadcast({ type: 'replayCommitStart', index, total, hash, subject });
            },
            onReplayEnd: () => {
                deps.wsBridge.broadcast({ type: 'replayEnded' });
            },
            onPaused: () => {
                deps.wsBridge.broadcast({ type: 'replayPaused' });
            },
            onResumed: () => {
                deps.wsBridge.broadcast({ type: 'replayResumed' });
            },
        },
        {
            // #915 — commit-history diff via the shared core builder (parity
            // with gitDiff.ts + the VS Code extension). Replaces the old
            // "not yet supported" throw.
            buildDiff: (base, head) => buildCommitDiffGraphs(deps.workspaceRoot, base, head, deps.log),
        },
    );
    return state.timeline;
}

/**
 * #818 (2026-06-11) — multi-repo context for the cross-repo coda. When set
 * (and the producer's API surface changed), frames walking the direct
 * consumer repos are appended after the per-repo replay via the SAME
 * shared builder the extension uses (R7 parity).
 */
export interface ReplayCodaContext {
    aggregator: unknown;
    perRepoStores: ReadonlyMap<string, unknown>;
    /** The replayed (producer) repo — registry repoId or name. */
    producer: string;
    maxConsumers?: number;
}

/** Start a replay of the working-vs-baseline diff (matches the extension's
 *  `replayWorkingDiff` flow). */
export function replayWorkingChanges(deps: ReplayDeps, state: ReplayState, coda?: ReplayCodaContext): void {
    const baseline = deps.snapshotStore.getBaseline();
    const working = deps.snapshotStore.getWorking();
    if (!workingDiffersFromBaseline(baseline, working)) {
        deps.wsBridge.broadcast({
            type: 'clientToast',
            level: 'warning',
            text: 'No working changes to replay — edit a file first.',
        });
        return;
    }
    const diffedGraphs = buildWorkingDiffBundle(baseline, working);
    // #818 — best-effort coda; never blocks the main replay.
    let codaFrames: any[] = [];
    if (coda) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { buildCrossRepoCodaFrames } = require('../core/replay/crossRepoCoda');
            const workspaceL1 = (coda.aggregator as any)?.getWorkingGraph?.('microservice:workspace')
                ?? diffedGraphs['microservice:workspace']
                ?? null;
            codaFrames = buildCrossRepoCodaFrames({
                aggregator: coda.aggregator,
                producer: coda.producer,
                perRepoStores: coda.perRepoStores,
                workspaceL1,
                maxConsumers: coda.maxConsumers,
                log: deps.log,
            });
            if (codaFrames.length > 0) {
                deps.log(`[replay] #818 coda: ${codaFrames.length} cross-repo frame(s) appended for ${coda.producer}`);
            }
        } catch (err: any) {
            deps.log(`[replay] #818 coda build failed (non-fatal): ${err?.message ?? err}`);
        }
    }
    const timeline = ensureTimeline(deps, state);
    timeline.playFromDiffResult({
        diffedGraphs,
        baseHash: 'baseline',
        headHash: 'working',
        baseLabel: 'Baseline',
        headLabel: 'Working (uncommitted)',
        codaFrames,
    });
    deps.wsBridge.broadcast({ type: 'replayStarted' });
}

/** Stop the active replay. Safe to call when no replay is running. */
export function stopReplay(deps: ReplayDeps, state: ReplayState): void {
    state.timeline?.stop();
    deps.wsBridge.broadcast({ type: 'replayStopped' });
}

/** Handle pause / resume / next / prev / restart control messages from the
 *  browser. The extension's replayHandlers.ts dispatches them through
 *  `timelineReplayControl` with an `action` field; we mirror that. */
export function applyReplayControl(
    deps: ReplayDeps,
    state: ReplayState,
    action: 'pause' | 'resume' | 'next' | 'prev',
): void {
    const t = state.timeline;
    if (!t) return;
    switch (action) {
        case 'pause': t.pause(); break;
        case 'resume': t.resume(); break;
        case 'next': t.nextStep(); break;
        case 'prev': t.prevStep(); break;
        default:
            deps.log(`[replay] unknown control action: ${action}`);
    }
}

/** Adjust playback speed (per-step delay in ms). Clamped 500–10000 by the
 *  engine. */
export function setReplaySpeed(_deps: ReplayDeps, state: ReplayState, ms: number): void {
    state.timeline?.setSpeed(ms);
}
