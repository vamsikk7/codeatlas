/**
 * replayHandlers.ts
 *
 * Issues #173, #174, #194: Replay message handlers extracted from extension.ts.
 * Handles requestChangeLog, navigateToChangeEntry, stopReplay, startTimelineReplay,
 * timelineReplayControl, timelineReplaySpeed, requestTimelineCommits,
 * replayWorkingDiff, replayCurrentDiff, requestPrDiffReplay,
 * requestBranchDiffReplay, and replayFromFile.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { HandlerContext, MessageHandler } from './handlerContext';
import { withErrorHandling } from './handlerContext';
import { listCommits, listBranches, mergeBase } from '../core/git/gitReader';
import { workingDiffersFromBaseline, buildWorkingDiffBundle } from './replayWorkingChanges';
import { replayNoWorkingChangesMessage } from './replayMessages';
import { analytics } from '../analytics/mixpanelService';

/**
 * Register all replay-related message handlers with the message router.
 *
 * @param register - Function to register a (messageType, handler, module) triple
 * @param ctx - Shared handler context
 */
export function registerReplayHandlers(
    register: (messageType: string, handler: MessageHandler, module: string) => void,
    ctx: HandlerContext,
): void {
    const MODULE = 'ReplayHandlers';
    // #547: replay handlers rely on `ctx.changeLog`, `ctx.commitTimelineReplay`,
    // and `ctx.replayOrchestrator` — all extension-only services tied to the
    // VS Code SCM provider. The standalone runs its own replay engine in
    // `src/standalone/replay.ts` + `src/standalone/gitDiff.ts`. Skip
    // registration off-extension to avoid null-deref via the (now-optional)
    // services.
    if (!ctx.context) return;

    // ── requestChangeLog ───────────────────────────────────────────────────
    register('requestChangeLog', (_message, sourcePanelId) => {
        try {
            const entries = ctx.changeLog!.getAll();
            const msg = { type: 'changeLogFull' as const, entries };
            ctx.panelManager!.sendToPanel(sourcePanelId, msg);
            if (sourcePanelId.startsWith('ws:') && ctx.wsBridge) {
                ctx.wsBridge.sendTo(sourcePanelId.slice(3), msg);
            }
        } catch (err: any) {
            const message = err?.message ?? String(err);
            ctx.log(`[${MODULE}] requestChangeLog error: ${message}`);
            ctx.notifyBrowser('error', `requestChangeLog failed: ${message.slice(0, 150)}`);
        }
    }, MODULE);

    // ── navigateToChangeEntry ──────────────────────────────────────────────
    register('navigateToChangeEntry', (message, sourcePanelId) => {
        try {
            const entry = ctx.changeLog!.getById(message.entryId);
            if (entry) {
                const graph = ctx.snapshotStore.getWorking().graphs[entry.primaryGraphId];
                if (graph) {
                    const mode = entry.primaryGraphId.startsWith('flow:') ? 'flow' as const
                        : entry.primaryGraphId.startsWith('sequence:') ? 'sequence' as const
                        : 'file' as const;
                    ctx.panelManager!.navigatePanel(
                        sourcePanelId,
                        entry.primaryGraphId,
                        mode,
                        graph,
                        `${entry.changedFunctions[0] ?? entry.filePath}`,
                    );
                }
            }
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            ctx.log(`[${MODULE}] navigateToChangeEntry error: ${msg}`);
            ctx.notifyBrowser('error', `navigateToChangeEntry failed: ${msg.slice(0, 150)}`);
        }
    }, MODULE);

    // ── stopReplay ─────────────────────────────────────────────────────────
    register('stopReplay', () => {
        try {
            analytics.track('replay_stopped', { kind: 'impact' });
            ctx.replayOrchestrator!.stop();
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            ctx.log(`[${MODULE}] stopReplay error: ${msg}`);
        }
    }, MODULE);

    // ── startTimelineReplay ────────────────────────────────────────────────
    register('startTimelineReplay', (message) => {
        analytics.track('timeline_replay_started', { commit_count: Array.isArray(message.commits) ? message.commits.length : 0 });
        withErrorHandling(ctx, 'startTimelineReplay', async () => {
            await ctx.commitTimelineReplay!.play(message.commits);
        });
    }, MODULE);

    // ── timelineReplayControl ──────────────────────────────────────────────
    register('timelineReplayControl', (message) => {
        try {
            analytics.track('timeline_replay_control', { action: String(message.action ?? 'unknown') });
            switch (message.action) {
                case 'pause': ctx.commitTimelineReplay!.pause(); break;
                case 'resume': ctx.commitTimelineReplay!.resume(); break;
                case 'stop': ctx.commitTimelineReplay!.stop(); break;
                case 'skipCommit': ctx.commitTimelineReplay!.skipCommit(); break;
                case 'next': ctx.commitTimelineReplay!.nextStep(); break;
                case 'prev': ctx.commitTimelineReplay!.prevStep(); break;
            }
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            ctx.log(`[${MODULE}] timelineReplayControl error: ${msg}`);
        }
    }, MODULE);

    // ── timelineReplaySpeed ────────────────────────────────────────────────
    register('timelineReplaySpeed', (message) => {
        try {
            ctx.commitTimelineReplay!.setSpeed(message.speedMs);
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            ctx.log(`[${MODULE}] timelineReplaySpeed error: ${msg}`);
        }
    }, MODULE);

    // ── requestTimelineCommits ─────────────────────────────────────────────
    register('requestTimelineCommits', (message, sourcePanelId) => {
        try {
            const branchName = message.branch;
            // UX-63f (2026-06-09) — per-repo Timeline Replay. When repoId
            // is supplied, resolve the sub-repo path so `listCommits` /
            // `listBranches` / `mergeBase` use that tree.
            const reqRepoId = String((message as any).repoId ?? '');
            let gitRoot = ctx.workspaceRoot;
            if (reqRepoId && ctx.aggregatorStore) {
                try {
                    const repos = ctx.aggregatorStore.listRepos();
                    const matched = repos.find((r: any) => r.name === reqRepoId || r.repoId === reqRepoId || r.rootPath === reqRepoId);
                    if (matched?.rootPath) {
                        gitRoot = path.join(ctx.workspaceRoot, matched.rootPath);
                        ctx.log(`[${MODULE}] requestTimelineCommits: scoped to per-repo gitRoot=${matched.rootPath}`);
                    }
                } catch (err: any) {
                    ctx.log(`[${MODULE}] requestTimelineCommits per-repo resolve failed: ${err?.message ?? err}`);
                }
            }
            const commits = listCommits(gitRoot, 50, branchName);
            const branches = listBranches(gitRoot);
            const mainBranch = branches.find(b => b.name === 'main' || b.name === 'master')?.name;
            const baselineHash = mainBranch && mainBranch !== branchName
                ? (mergeBase(gitRoot, mainBranch, branchName) ?? commits[commits.length - 1]?.hash)
                : commits[commits.length - 1]?.hash;
            const msg = {
                type: 'showCommitRangePicker' as const,
                commits,
                branches,
                currentBranch: branchName,
                baselineHash,
            };
            if (sourcePanelId.startsWith('ws:') && ctx.wsBridge) {
                ctx.wsBridge.sendTo(sourcePanelId.slice(3), msg);
            } else {
                ctx.panelManager!.sendToPanel(sourcePanelId, msg);
            }
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            ctx.log(`[${MODULE}] requestTimelineCommits error: ${msg}`);
            ctx.notifyBrowser('error', `requestTimelineCommits failed: ${msg.slice(0, 150)}`);
        }
    }, MODULE);

    // ── replayWorkingDiff ──────────────────────────────────────────────────
    register('replayWorkingDiff', (message) => {
        try {
            analytics.track('replay_working_changes_requested');
            // UX-63a (2026-06-09) — per-repo replay. When `repoId` is set
            // and the workspace is multi-repo, source the baseline / working
            // pair from the per-repo store so the diff is bounded by THAT
            // sub-repo's history rather than the (empty) workspace store.
            // Workspace-level replay (single-repo, or multi-repo "all
            // repos") still uses ctx.snapshotStore unchanged.
            const reqRepoId = String((message as any).repoId ?? '');
            let store: any = ctx.snapshotStore;
            let scopedRepo: string | undefined;
            if (reqRepoId && ctx.aggregatorStore && ctx.repoStoreRegistry) {
                try {
                    const repos = ctx.aggregatorStore.listRepos();
                    const matched = repos.find((r: any) => r.name === reqRepoId || r.repoId === reqRepoId || r.rootPath === reqRepoId);
                    if (matched?.rootPath) {
                        const absPath = path.join(ctx.workspaceRoot, matched.rootPath);
                        const repoStore: any = ctx.repoStoreRegistry.getRepoStore(absPath);
                        if (repoStore && typeof repoStore.getWorking === 'function') {
                            store = repoStore;
                            scopedRepo = matched.name ?? matched.rootPath ?? reqRepoId;
                            ctx.log(`[${MODULE}] replayWorkingDiff: routed to per-repo store ${scopedRepo}`);
                        }
                    }
                } catch (err: any) {
                    ctx.log(`[${MODULE}] replayWorkingDiff per-repo resolve failed: ${err?.message ?? err}`);
                }
            }
            const baseline = store.getBaseline();
            const working = store.getWorking();
            // Bundle construction lives in `replayWorkingChanges.ts` so the
            // T3 timeline-replay scenarios import the SAME helper rather than
            // re-implementing this logic in tests (Issue #377).
            const workingDiffed = buildWorkingDiffBundle(baseline, working);
            // Issue 337: trust the file-content snapshot, not stale graph
            // annotations.
            const hasChanges = workingDiffersFromBaseline(baseline, working);
            if (hasChanges) {
                // Issue 355 (Bug 1): publish the working-changes diff into
                // gitDiffState so AI Review (which reads ctx.getGitDiffState!(message?.repoId))
                // can see the diff. Without this the user gets "No diff data
                // available" when triggering AI Review on Working Changes —
                // even though the replay panel is showing the diff just fine.
                const gitDiffState = {
                    baseHash: 'baseline',
                    headHash: 'working',
                    baseLabel: scopedRepo ? `Baseline (${scopedRepo})` : 'Baseline',
                    headLabel: scopedRepo ? `Working uncommitted (${scopedRepo})` : 'Working (uncommitted)',
                    diffedGraphs: workingDiffed,
                    apiIndex: { ...(baseline.apiIndex ?? {}), ...(working.apiIndex ?? {}) },
                    // UX-63a — surface the scoped repo so downstream
                    // consumers (e.g. AI Review scope picker, replay HUD
                    // label, future per-repo gitDiffState keying) can
                    // distinguish a per-repo session from workspace.
                    scopedRepo,
                };
                ctx.setGitDiffState!(gitDiffState);
                // Bug 1 follow-up: also broadcast setGitDiffContext to every
                // open panel + browser client so the AI Review button surfaces
                // alongside the replay badge. Mirrors what the commit/branch/PR
                // diff flows already do via broadcastGitDiffContext().
                vscode.commands.executeCommand('setContext', 'codeatlas:gitDiffActive', true);
                const ctxMsg = {
                    type: 'setGitDiffContext' as const,
                    baseHash: gitDiffState.baseHash,
                    headHash: gitDiffState.headHash,
                    baseLabel: gitDiffState.baseLabel,
                    headLabel: gitDiffState.headLabel,
                };
                ctx.panelManager!.broadcastMessage(ctxMsg);
                if (ctx.wsBridge?.hasClients()) ctx.wsBridge.broadcast(ctxMsg);
                // #818 (2026-06-11) — cross-repo coda. When a SCOPED repo is
                // replayed in a multi-repo workspace and its API surface
                // changed, append frames walking the direct consumers.
                // Frames are built by the shared core (R7 parity with the
                // standalone). Best-effort: a coda failure never blocks the
                // main replay.
                let codaFrames: any[] = [];
                if (scopedRepo && ctx.aggregatorStore && ctx.repoStoreRegistry) {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const { buildCrossRepoCodaFrames } = require('../core/replay/crossRepoCoda');
                        const maxConsumers = vscode.workspace.getConfiguration('codeatlas').get<number>('replayCodaMaxConsumers', 5);
                        const perRepoStores = new Map<string, any>();
                        for (const r of ctx.aggregatorStore.listRepos()) {
                            try {
                                perRepoStores.set(r.repoId, ctx.repoStoreRegistry.getRepoStore(path.join(ctx.workspaceRoot, r.rootPath)));
                            } catch { /* repo store open failed — its frames skip */ }
                        }
                        const workspaceL1 = ctx.aggregatorStore.getWorkingGraph('microservice:workspace')
                            ?? workingDiffed['microservice:workspace']
                            ?? null;
                        codaFrames = buildCrossRepoCodaFrames({
                            aggregator: ctx.aggregatorStore,
                            producer: scopedRepo,
                            perRepoStores,
                            workspaceL1,
                            maxConsumers,
                            log: ctx.log,
                        });
                        if (codaFrames.length > 0) {
                            ctx.log(`[${MODULE}] #818 coda: ${codaFrames.length} cross-repo frame(s) appended for ${scopedRepo}`);
                        }
                    } catch (err: any) {
                        ctx.log(`[${MODULE}] #818 coda build failed (non-fatal): ${err?.message ?? err}`);
                    }
                }
                ctx.commitTimelineReplay!.playFromDiffResult({
                    diffedGraphs: workingDiffed,
                    baseHash: 'baseline',
                    headHash: 'working',
                    baseLabel: 'Baseline',
                    headLabel: 'Working (uncommitted)',
                    codaFrames,
                });
                if (!ctx.commitTimelineReplay!.isPlaying) {
                    analytics.track('replay_working_changes_no_layers');
                    vscode.window.showInformationMessage('CodeAtlas: No changed layers to replay.');
                    ctx.notifyBrowser('info', 'No changed layers to replay.');
                } else {
                    analytics.track('replay_working_changes_started', {
                        diffed_graphs_count: Object.keys(workingDiffed).length,
                    });
                }
            } else {
                analytics.track('replay_working_changes_no_changes');
                // BUG-POLAR-28: on a bare multi-repo replay the workspace store is
                // empty by design — tell the user to pick a repo, not "edit files".
                const isMultiRepo = !!(ctx.aggregatorStore && ctx.repoStoreRegistry);
                const noChangesMsg = replayNoWorkingChangesMessage({ isMultiRepo, hasRepoScope: !!scopedRepo });
                vscode.window.showInformationMessage(`CodeAtlas: ${noChangesMsg}`);
                ctx.notifyBrowser('info', noChangesMsg);
            }
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            ctx.log(`[${MODULE}] replayWorkingDiff error: ${msg}`);
            ctx.notifyBrowser('error', `replayWorkingDiff failed: ${msg.slice(0, 150)}`);
        }
    }, MODULE);

    // ── replayCurrentDiff ──────────────────────────────────────────────────
    register('replayCurrentDiff', (message) => {
        try {
            const gitDiffState = ctx.getGitDiffState!((message as any)?.repoId);
            analytics.track('replay_current_diff_requested', { has_diff: !!gitDiffState });
            if (gitDiffState) {
                ctx.commitTimelineReplay!.playFromDiffResult({
                    diffedGraphs: gitDiffState.diffedGraphs,
                    baseHash: gitDiffState.baseHash,
                    headHash: gitDiffState.headHash,
                    baseLabel: gitDiffState.baseLabel,
                    headLabel: gitDiffState.headLabel,
                });
                if (!ctx.commitTimelineReplay!.isPlaying) {
                    ctx.notifyBrowser('info', 'No changed layers to replay in this diff.');
                }
            } else {
                ctx.notifyBrowser('warning', 'No active diff to replay. Run Compare Commits or PR Diff first.');
            }
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            ctx.log(`[${MODULE}] replayCurrentDiff error: ${msg}`);
            ctx.notifyBrowser('error', `replayCurrentDiff failed: ${msg.slice(0, 150)}`);
        }
    }, MODULE);

    // ── requestPrDiffReplay ────────────────────────────────────────────────
    register('requestPrDiffReplay', (message, sourcePanelId) => {
        analytics.track('replay_pr_diff_requested');
        withErrorHandling(ctx, 'requestPrDiffReplay', async () => {
            ctx.setReplayAfterDiff!(true);
            // UX-63d — forward optional repoId for per-repo PR replay.
            await ctx.handleRequestPrDiff!(sourcePanelId, (message as any).repoId);
        });
    }, MODULE);

    // ── requestBranchDiffReplay ────────────────────────────────────────────
    register('requestBranchDiffReplay', (message, sourcePanelId) => {
        analytics.track('replay_branch_diff_requested');
        withErrorHandling(ctx, 'requestBranchDiffReplay', async () => {
            ctx.setReplayAfterDiff!(true);
            // UX-63e — forward optional repoId for per-repo Branch replay.
            await ctx.handleRequestBranchDiff!(sourcePanelId, (message as any).repoId);
        });
    }, MODULE);

    // ── replayFromFile ─────────────────────────────────────────────────────
    register('replayFromFile', (message) => {
        try {
            analytics.track('replay_from_file_requested', { file_path: String(message.filePath ?? '').slice(0, 200) });
            const gitDiffState = ctx.getGitDiffState!(message?.repoId);
            if (gitDiffState && message.filePath) {
                ctx.commitTimelineReplay!.playFocused(message.filePath, {
                    diffedGraphs: gitDiffState.diffedGraphs,
                    baseHash: gitDiffState.baseHash,
                    headHash: gitDiffState.headHash,
                    baseLabel: gitDiffState.baseLabel,
                    headLabel: gitDiffState.headLabel,
                });
                if (!ctx.commitTimelineReplay!.isPlaying) {
                    ctx.notifyBrowser('info', 'No changed layers found for this file.');
                }
            } else if (!gitDiffState) {
                ctx.notifyBrowser('warning', 'No active diff. Run Compare Commits or PR Diff first.');
            }
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            ctx.log(`[${MODULE}] replayFromFile error: ${msg}`);
            ctx.notifyBrowser('error', `replayFromFile failed: ${msg.slice(0, 150)}`);
        }
    }, MODULE);
}
