/**
 * replayCommands.ts — Issue #358 Row 7a (2026-06-07).
 *
 * Extracted from `src/extension.ts` to shrink the god module. Owns the
 * seven timeline / live-impact replay command registrations that all
 * dispatch into the `CommitTimelineReplay` orchestrator or the live
 * `ImpactReplayOrchestrator`:
 *
 *   - codeatlas.timelineReplay   → open the commit-range picker
 *   - codeatlas.toggleLiveReplay → flip live-impact replay on/off
 *   - codeatlas.replayFromFile   → focused replay from Changed Items sidebar
 *   - codeatlas.replayPrev       → step backwards (keyboard-bound)
 *   - codeatlas.replayNext       → step forwards (keyboard-bound)
 *   - codeatlas.replayToggle     → pause / resume
 *   - codeatlas.replayStop       → stop + clear active state
 *
 * Mechanical extraction — NO behavior change. The mutable closure state
 * that the original inline blocks read (`gitDiffState`, `liveReplayEnabled`)
 * is plumbed through as a getter / setter pair so the commands always
 * observe the live extension-host value rather than a stale snapshot.
 *
 * Wire by pushing the returned disposables into `context.subscriptions`
 * from `extension.ts::activate`.
 */

import * as vscode from 'vscode';
import { listCommits, listBranches, mergeBase } from '../core/git/gitReader';
import { analytics } from '../analytics/mixpanelService';
import type { CommitTimelineReplay } from '../core/replay/commitTimelineReplay';
import type { ImpactReplayOrchestrator } from '../core/replay/impactReplayOrchestrator';
import type { WsBridge } from '../server/wsBridge';
import type { PersistedGitDiffState } from '../core/storage/gitDiffStore';

export interface ReplayCommandDeps {
    commitTimelineReplay: CommitTimelineReplay;
    replayOrchestrator: ImpactReplayOrchestrator;
    wsBridge: WsBridge | undefined;
    workspaceRoot: string;
    /** Read the LIVE gitDiffState — a closure var in extension.ts. */
    getGitDiffState: () => PersistedGitDiffState | null;
    /** Read the LIVE liveReplayEnabled flag. */
    getLiveReplayEnabled: () => boolean;
    /** Flip the live flag. */
    setLiveReplayEnabled: (value: boolean) => void;
    /** Gate browser-only actions; mirror of the helper in extension.ts. */
    requireBrowserOrPromptWelcome: (actionName: string) => boolean;
    /** Broadcast a notification to all connected browser clients. */
    notifyBrowser: (level: 'info' | 'warning' | 'error', message: string) => void;
}

export function registerReplayCommands(deps: ReplayCommandDeps): vscode.Disposable[] {
    const {
        commitTimelineReplay,
        replayOrchestrator,
        wsBridge,
        workspaceRoot,
        getGitDiffState,
        getLiveReplayEnabled,
        setLiveReplayEnabled,
        requireBrowserOrPromptWelcome,
        notifyBrowser,
    } = deps;

    return [
        vscode.commands.registerCommand('codeatlas.timelineReplay', async () => {
            analytics.track('timeline_replay_picker_opened');
            // Picker is browser-only UI; require a browser tab before doing
            // expensive git work. If no tab is open, prompt the welcome page
            // and bail; the user reopens browser, runs the command again.
            if (!requireBrowserOrPromptWelcome('Timeline Replay')) return;
            const commits = listCommits(workspaceRoot, 50);
            if (commits.length < 2) {
                analytics.track('timeline_replay_insufficient_commits', { commit_count: commits.length });
                analytics.notification('timeline_replay_insufficient_commits', 'warning');
                vscode.window.showWarningMessage('CodeAtlas: Need at least 2 commits for timeline replay.');
                notifyBrowser('warning', 'Need at least 2 commits for timeline replay.');
                return;
            }
            const branches = listBranches(workspaceRoot);
            const currentBranch = branches.find(b => b.isCurrent)?.name ?? 'HEAD';
            // Auto-detect merge-base with main/master for baseline marker.
            const mainBranch = branches.find(b => b.name === 'main' || b.name === 'master')?.name;
            const baselineHash = mainBranch && mainBranch !== currentBranch
                ? (mergeBase(workspaceRoot, mainBranch, 'HEAD') ?? commits[commits.length - 1]?.hash)
                : commits[commits.length - 1]?.hash;
            const msg = { type: 'showCommitRangePicker' as const, commits, branches, currentBranch, baselineHash };
            wsBridge?.broadcast(msg);
        }),

        vscode.commands.registerCommand('codeatlas.toggleLiveReplay', () => {
            const next = !getLiveReplayEnabled();
            setLiveReplayEnabled(next);
            if (!next) replayOrchestrator.stop();
            const state = next ? 'enabled' : 'disabled';
            vscode.window.showInformationMessage(`CodeAtlas: Live Impact Replay ${state}.`);
            notifyBrowser('info', `Live Impact Replay ${state}.`);
        }),

        // Focused replay from Changed Items sidebar.
        vscode.commands.registerCommand('codeatlas.replayFromFile', (item?: any) => {
            const filePath = item?.filePath as string | undefined;
            const gitDiffState = getGitDiffState();
            if (filePath && gitDiffState) {
                commitTimelineReplay.playFocused(filePath, {
                    diffedGraphs: gitDiffState.diffedGraphs,
                    baseHash: gitDiffState.baseHash,
                    headHash: gitDiffState.headHash,
                    baseLabel: gitDiffState.baseLabel,
                    headLabel: gitDiffState.headLabel,
                });
            }
        }),

        // Replay keyboard shortcuts (active only when codeatlas:replayActive is set).
        vscode.commands.registerCommand('codeatlas.replayPrev', () => commitTimelineReplay.prevStep()),
        vscode.commands.registerCommand('codeatlas.replayNext', () => commitTimelineReplay.nextStep()),
        vscode.commands.registerCommand('codeatlas.replayToggle', () => {
            if (commitTimelineReplay.isPaused) commitTimelineReplay.resume();
            else commitTimelineReplay.pause();
        }),
        vscode.commands.registerCommand('codeatlas.replayStop', () => commitTimelineReplay.stop()),
    ];
}
