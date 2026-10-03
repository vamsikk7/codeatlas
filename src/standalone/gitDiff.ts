/**
 * gitDiff.ts — standalone git diff wiring (commits, branches, PRs).
 *
 * Three flows, all reduce to the same pipeline at the end:
 *   1. `requestGitDiff` → list local commits → browser picker → `commitSelected(base, head)`
 *   2. `requestBranchDiff(Replay)` → list local branches → browser picker → `branchSelected(branch)`
 *   3. `requestPrDiffReplay` → list open PRs from GitHub → browser picker → `prSelected(number)`
 *
 * The selection messages all converge on `buildCommitDiffGraphs(repo, base, head)`,
 * which produces a `CommitDiffResult` that the existing CommitTimelineReplay
 * engine can step through.
 *
 * GitHub-backed flows (PRs) take an optional token from the standalone secrets
 * store (`codeatlas.githubToken`, sourced from `GITHUB_TOKEN` / `GH_TOKEN`).
 * Public repos work unauthenticated (60 req/hr); private repos need the token.
 */

import type { SnapshotStore } from '../core/storage/snapshotStore';
import type { WsBridge } from '../server/wsBridge';
import type { SecretsStore } from './secrets';
import { listCommits, listBranches, resolveRef, mergeBase } from '../core/git/gitReader';
import { getGithubRemote, listGitHubPrs, fetchGitHubPr, ensureCommitAvailable } from '../core/git/githubReader';
import { buildCommitDiffGraphs } from '../core/git/commitDiffer';
import { CommitTimelineReplay } from '../core/replay/commitTimelineReplay';

export interface GitDiffDeps {
    workspaceRoot: string;
    snapshotStore: SnapshotStore;
    wsBridge: WsBridge;
    secrets: SecretsStore;
    log: (msg: string) => void;
}

export interface GitDiffState {
    /** Replay engine — same instance as the working-changes replayer would
     *  use. Constructed lazily so the standalone server stays cheap when
     *  git diff is never invoked. */
    timeline: CommitTimelineReplay | null;
    /** Active diff context (base / head hashes + labels) so we can broadcast
     *  `setGitDiffContext` on selection. */
    activeContext: { baseHash: string; headHash: string; baseLabel: string; headLabel: string } | null;
}

export function createGitDiffState(): GitDiffState {
    return { timeline: null, activeContext: null };
}

/**
 * Lazily construct the replay engine. Re-routes its callbacks through the
 * standalone's WS bridge so the browser HUD updates the same way the
 * extension's does.
 */
function ensureTimeline(deps: GitDiffDeps, state: GitDiffState): CommitTimelineReplay {
    if (state.timeline) return state.timeline;
    state.timeline = new CommitTimelineReplay(
        {
            navigate: (graphId, mode, graph, label) =>
                deps.wsBridge.broadcast({ type: 'navigateTo', graphId, mode, graph, label }),
            setDiffContext: (baseHash, headHash, baseLabel, headLabel) =>
                deps.wsBridge.broadcast({ type: 'setGitDiffContext', baseHash, headHash, baseLabel, headLabel }),
            clearDiffContext: () => deps.wsBridge.broadcast({ type: 'clearGitDiffContext' }),
            onStepStart: (step) => deps.wsBridge.broadcast({ type: 'replayStep', step }),
            onCommitStart: (index, total, hash, subject) =>
                deps.wsBridge.broadcast({ type: 'replayCommitStart', index, total, hash, subject }),
            onReplayEnd: () => deps.wsBridge.broadcast({ type: 'replayEnded' }),
            onPaused: () => deps.wsBridge.broadcast({ type: 'replayPaused' }),
            onResumed: () => deps.wsBridge.broadcast({ type: 'replayResumed' }),
        },
        {
            // gitOps.buildDiff: used by the engine's multi-commit `play()`
            // entry. Standalone wires it to the real commit differ so
            // multi-step commit replay actually walks the commits.
            buildDiff: (base, head) => buildCommitDiffGraphs(deps.workspaceRoot, base, head, deps.log),
        },
    );
    return state.timeline;
}

function toastError(deps: GitDiffDeps, text: string): void {
    deps.wsBridge.broadcast({ type: 'clientToast', level: 'error', text });
}
function toastWarn(deps: GitDiffDeps, text: string): void {
    deps.wsBridge.broadcast({ type: 'clientToast', level: 'warning', text });
}
function toastInfo(deps: GitDiffDeps, text: string): void {
    deps.wsBridge.broadcast({ type: 'clientToast', level: 'info', text });
}

// ─── 1. Commit picker flow ────────────────────────────────────────────────

/**
 * List up to 100 recent commits and send to the browser. Browser displays a
 * picker UI; the user's choice arrives back as `commitSelected`.
 */
export function requestGitDiff(deps: GitDiffDeps, clientId: string): void {
    const commits = listCommits(deps.workspaceRoot, 100);
    if (commits.length === 0) {
        toastWarn(deps, 'No git commits found in this repository.');
        return;
    }
    deps.wsBridge.sendTo(clientId, {
        type: 'showCommitPicker',
        commits: commits.map(c => ({
            hash: c.hash,
            shortHash: c.shortHash,
            subject: c.subject,
            author: c.author,
            relativeDate: c.relativeDate,
        })),
        mode: 'both',
    });
}

/**
 * Final stage of the commit-picker flow: build the diff between `baseHash`
 * and `headHash` and start replaying it.
 */
export async function commitSelected(
    deps: GitDiffDeps,
    state: GitDiffState,
    baseHash: string,
    headHash: string,
): Promise<void> {
    try {
        const diff = await buildCommitDiffGraphs(deps.workspaceRoot, baseHash, headHash, deps.log);
        const baseShort = baseHash.slice(0, 7);
        const headShort = headHash.slice(0, 7);
        const ctx = {
            baseHash, headHash,
            baseLabel: `${baseShort} (base)`,
            headLabel: `${headShort} (head)`,
        };
        state.activeContext = ctx;
        const timeline = ensureTimeline(deps, state);
        timeline.playFromDiffResult({ diffedGraphs: diff.diffedGraphs, ...ctx });
        deps.wsBridge.broadcast({ type: 'replayStarted' });
    } catch (err: any) {
        toastError(deps, `Commit diff failed: ${(err?.message ?? String(err)).slice(0, 200)}`);
    }
}

// ─── 2. Branch picker flow ────────────────────────────────────────────────

/**
 * List local branches and send to the browser for in-browser selection.
 */
export function requestBranchDiff(deps: GitDiffDeps, clientId: string): void {
    const branches = listBranches(deps.workspaceRoot);
    if (branches.length === 0) {
        toastWarn(deps, 'No local branches found.');
        return;
    }
    deps.wsBridge.sendTo(clientId, {
        type: 'showBranchPicker',
        branches: branches.map(b => ({ name: b.name, isCurrent: b.isCurrent, isRemote: b.isRemote })),
    });
}

/**
 * Final stage of the branch-picker flow: compute `branch...HEAD` via merge
 * base (so the diff shows what the branch changes) and replay.
 */
export async function branchSelected(deps: GitDiffDeps, state: GitDiffState, branchName: string): Promise<void> {
    try {
        const branchHash = resolveRef(deps.workspaceRoot, branchName);
        const headHash = resolveRef(deps.workspaceRoot, 'HEAD');
        if (!branchHash || !headHash) {
            toastError(deps, `Could not resolve branch ${branchName}.`);
            return;
        }
        // Merge base — gives "what the branch added relative to HEAD".
        const base = mergeBase(deps.workspaceRoot, branchHash, headHash) ?? branchHash;
        const diff = await buildCommitDiffGraphs(deps.workspaceRoot, base, branchHash, deps.log);
        const ctx = {
            baseHash: base,
            headHash: branchHash,
            baseLabel: `${base.slice(0, 7)} (merge-base)`,
            headLabel: `${branchName} (${branchHash.slice(0, 7)})`,
        };
        state.activeContext = ctx;
        const timeline = ensureTimeline(deps, state);
        timeline.playFromDiffResult({ diffedGraphs: diff.diffedGraphs, ...ctx });
        deps.wsBridge.broadcast({ type: 'replayStarted' });
    } catch (err: any) {
        toastError(deps, `Branch diff failed: ${(err?.message ?? String(err)).slice(0, 200)}`);
    }
}

// ─── 3. PR picker flow ────────────────────────────────────────────────────

/**
 * Fetch open PRs from GitHub and send to the browser for selection. Uses
 * the standalone secrets store for the GitHub token (sources GITHUB_TOKEN /
 * GH_TOKEN env var, then ~/.codeatlas/secrets.json). Public repos work
 * unauthenticated at the cost of a 60 req/hr rate limit.
 */
export async function requestPrDiff(deps: GitDiffDeps, clientId: string): Promise<void> {
    const remote = getGithubRemote(deps.workspaceRoot);
    if (!remote) {
        toastError(
            deps,
            'Could not determine GitHub repository from the origin remote. Make sure `origin` points at github.com.',
        );
        return;
    }
    const token = await deps.secrets.get('codeatlas.githubToken');
    const prs = await listGitHubPrs(remote.owner, remote.repo, token);
    deps.wsBridge.sendTo(clientId, {
        type: 'showPrPicker',
        owner: remote.owner,
        repo: remote.repo,
        prs,
    });
}

/**
 * Final stage of the PR flow: fetch base + head SHAs from GitHub, ensure
 * we have those commits locally (fetch from origin if missing), then build
 * the diff and replay.
 */
export async function prSelected(deps: GitDiffDeps, state: GitDiffState, prNumber: number): Promise<void> {
    const remote = getGithubRemote(deps.workspaceRoot);
    if (!remote) {
        toastError(deps, 'Could not determine GitHub repository from the origin remote.');
        return;
    }
    try {
        const token = await deps.secrets.get('codeatlas.githubToken');
        const pr = await fetchGitHubPr(remote.owner, remote.repo, prNumber, token);
        // PRs from forks may have a head SHA we haven't fetched locally.
        // Best-effort: ensure both commits are reachable; if not, surface
        // a clear error instead of an all-deleted diff.
        try {
            ensureCommitAvailable(deps.workspaceRoot, pr.baseHash);
            ensureCommitAvailable(deps.workspaceRoot, pr.headHash);
        } catch (e: any) {
            toastError(
                deps,
                `Couldn't fetch PR commits locally: ${e?.message ?? e}. If this is a fork-based PR, fetch the source branch manually.`,
            );
            return;
        }
        const diff = await buildCommitDiffGraphs(deps.workspaceRoot, pr.baseHash, pr.headHash, deps.log);
        const ctx = {
            baseHash: pr.baseHash,
            headHash: pr.headHash,
            baseLabel: `${pr.baseRef} (base)`,
            headLabel: `PR #${pr.prNumber}: ${pr.prTitle}`,
        };
        state.activeContext = ctx;
        const timeline = ensureTimeline(deps, state);
        timeline.playFromDiffResult({ diffedGraphs: diff.diffedGraphs, ...ctx });
        deps.wsBridge.broadcast({ type: 'replayStarted' });
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        // Specific 404 messaging — usually means private repo without a token.
        if (msg.includes('not found')) {
            const hasToken = Boolean(await deps.secrets.get('codeatlas.githubToken'));
            const hint = hasToken
                ? ' (token present — check that it has the `repo` scope for private repositories)'
                : ' Set GITHUB_TOKEN env var to read private repos.';
            toastError(deps, `PR #${prNumber} not found${hint}`);
        } else {
            toastError(deps, `PR diff failed: ${msg.slice(0, 200)}`);
        }
    }
}

/** Clear the active git diff context — webview hides the HUD. */
export function clearGitDiff(deps: GitDiffDeps, state: GitDiffState): void {
    state.activeContext = null;
    state.timeline?.stop();
    deps.wsBridge.broadcast({ type: 'clearGitDiffContext' });
    deps.wsBridge.broadcast({ type: 'replayStopped' });
}

// ─── 4. Multi-commit timeline walk ────────────────────────────────────────

/**
 * `requestTimelineCommits` — list recent commits on the requested branch +
 * all branches, plus a sensible "baseline" hash (merge-base with main).
 * Browser uses this to render a commit-range picker that posts back as
 * `startTimelineReplay` with the chosen sub-list.
 */
export function requestTimelineCommits(
    deps: GitDiffDeps,
    clientId: string,
    branchName: string | undefined,
): void {
    try {
        const commits = listCommits(deps.workspaceRoot, 50, branchName);
        const branches = listBranches(deps.workspaceRoot);
        const mainBranch = branches.find(b => b.name === 'main' || b.name === 'master')?.name;
        const baselineHash = mainBranch && mainBranch !== branchName
            ? (mergeBase(deps.workspaceRoot, mainBranch, branchName ?? 'HEAD') ?? commits[commits.length - 1]?.hash)
            : commits[commits.length - 1]?.hash;
        deps.wsBridge.sendTo(clientId, {
            type: 'showCommitRangePicker',
            commits,
            branches,
            currentBranch: branchName,
            baselineHash,
        });
    } catch (err: any) {
        toastError(deps, `Couldn't list commits: ${(err?.message ?? String(err)).slice(0, 200)}`);
    }
}

/**
 * `startTimelineReplay` — auto-page through every commit in the chosen
 * range. Each consecutive pair gets diffed via the engine's `gitOps`
 * callback (which we wired to `buildCommitDiffGraphs`), and the engine
 * walks the resulting steps with the configured per-step delay.
 */
export async function startTimelineReplay(
    deps: GitDiffDeps,
    state: GitDiffState,
    commits: Array<{ hash: string; shortHash?: string; subject?: string; author?: string; relativeDate?: string }>,
): Promise<void> {
    if (!Array.isArray(commits) || commits.length < 2) {
        toastWarn(deps, 'Pick at least two commits to walk a timeline.');
        return;
    }
    const timeline = ensureTimeline(deps, state);
    try {
        await timeline.play(commits.map(c => ({
            hash: c.hash,
            shortHash: c.shortHash ?? c.hash.slice(0, 7),
            subject: c.subject ?? '',
            author: c.author ?? '',
            relativeDate: c.relativeDate ?? '',
        })));
        deps.wsBridge.broadcast({ type: 'replayStarted' });
    } catch (err: any) {
        toastError(deps, `Timeline replay failed: ${(err?.message ?? String(err)).slice(0, 200)}`);
    }
}

/**
 * `skipCommit` — jump to the first step of the next commit pair (used by
 * the browser's "next commit" replay control).
 */
export function skipReplayCommit(_deps: GitDiffDeps, state: GitDiffState): void {
    state.timeline?.skipCommit();
}
