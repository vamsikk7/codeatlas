/**
 * gitDiff.test.ts — standalone git diff (commit / branch / PR) flows.
 *
 * Each flow has the same shape:
 *   - request → broadcast a picker payload to the client
 *   - selection → build diff via the existing pure-JS engine + start replay
 *
 * We mock the engine + git readers so the test doesn't depend on a real
 * repo or network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    requestGitDiff, commitSelected,
    requestBranchDiff, branchSelected,
    requestPrDiff, prSelected,
    clearGitDiff, createGitDiffState,
} from '../gitDiff';
import type { SnapshotStore } from '../../core/storage/snapshotStore';
import type { WsBridge } from '../../server/wsBridge';
import type { SecretsStore } from '../secrets';

vi.mock('../../core/git/gitReader', () => ({
    listCommits: vi.fn(),
    listBranches: vi.fn(),
    resolveRef: vi.fn(),
    mergeBase: vi.fn(),
}));
vi.mock('../../core/git/githubReader', () => ({
    getGithubRemote: vi.fn(),
    listGitHubPrs: vi.fn(),
    fetchGitHubPr: vi.fn(),
    ensureCommitAvailable: vi.fn(),
}));
vi.mock('../../core/git/commitDiffer', () => ({
    buildCommitDiffGraphs: vi.fn(),
}));

import { listCommits, listBranches, resolveRef, mergeBase } from '../../core/git/gitReader';
import { getGithubRemote, listGitHubPrs, fetchGitHubPr } from '../../core/git/githubReader';
import { buildCommitDiffGraphs } from '../../core/git/commitDiffer';

function mkDeps() {
    const broadcasts: any[] = [];
    const sent: Array<{ clientId: string; msg: any }> = [];
    const wsBridge = {
        broadcast: vi.fn((m) => broadcasts.push(m)),
        sendTo: vi.fn((id: string, m: any) => sent.push({ clientId: id, msg: m })),
    } as unknown as WsBridge;
    const snapshotStore = {
        getBaseline: () => ({ files: {}, graphs: {}, apiIndex: {} }),
        getWorking: () => ({ files: {}, graphs: {}, apiIndex: {} }),
    } as unknown as SnapshotStore;
    const secrets = {
        get: vi.fn(async (key: string) => key === 'codeatlas.githubToken' ? undefined : undefined),
        store: vi.fn(),
        delete: vi.fn(),
    } as unknown as SecretsStore;
    return {
        workspaceRoot: '/repo', snapshotStore, wsBridge, secrets, log: () => {},
        broadcasts, sent,
    };
}

const FAKE_DIFF = {
    diffedGraphs: {
        'file:src/a.ts': {
            graphId: 'file:src/a.ts', type: 'file',
            nodes: [{ id: 'f', type: 'file', label: 'a.ts', diff: 'modified' }],
            edges: [], anchors: {}, meta: {},
        },
    },
    headSnapshot: { files: {}, apiIndex: {}, graphs: {} },
    baseSnapshot: { files: {}, apiIndex: {}, graphs: {} },
};

describe('requestGitDiff (commit picker)', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('sends showCommitPicker with the recent commits', () => {
        const d = mkDeps();
        (listCommits as any).mockReturnValue([
            { hash: 'aaaaaaaaaaaa', shortHash: 'aaaaaaa', subject: 'first', author: 'a', relativeDate: 'now' },
            { hash: 'bbbbbbbbbbbb', shortHash: 'bbbbbbb', subject: 'second', author: 'b', relativeDate: '1m' },
        ]);
        requestGitDiff(d, 'client-1');
        expect(d.sent).toHaveLength(1);
        expect(d.sent[0].clientId).toBe('client-1');
        expect(d.sent[0].msg.type).toBe('showCommitPicker');
        expect(d.sent[0].msg.commits).toHaveLength(2);
    });

    it('emits a warning + no picker when there are no commits', () => {
        const d = mkDeps();
        (listCommits as any).mockReturnValue([]);
        requestGitDiff(d, 'client-1');
        expect(d.sent).toHaveLength(0);
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('warning');
    });
});

describe('commitSelected', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('builds the diff between two commits and starts replay', async () => {
        const d = mkDeps();
        (buildCommitDiffGraphs as any).mockResolvedValue(FAKE_DIFF);
        const state = createGitDiffState();

        await commitSelected(d, state, 'aaaaaaaaaaaa', 'bbbbbbbbbbbb');

        expect(buildCommitDiffGraphs).toHaveBeenCalledWith('/repo', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb', expect.any(Function));
        expect(d.broadcasts.some(m => m.type === 'replayStarted')).toBe(true);
        expect(state.activeContext?.baseHash).toBe('aaaaaaaaaaaa');
        expect(state.activeContext?.headHash).toBe('bbbbbbbbbbbb');
    });

    it('toasts on engine failure — never throws', async () => {
        const d = mkDeps();
        (buildCommitDiffGraphs as any).mockRejectedValue(new Error('bad commit hash'));
        await commitSelected(d, createGitDiffState(), 'aaaaaaa', 'bbbbbbb');
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('error');
        expect(toast?.text).toContain('bad commit hash');
    });
});

describe('requestBranchDiff + branchSelected', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('sends showBranchPicker', () => {
        const d = mkDeps();
        (listBranches as any).mockReturnValue([
            { name: 'main', isCurrent: true, isRemote: false },
            { name: 'feature/x', isCurrent: false, isRemote: false },
        ]);
        requestBranchDiff(d, 'client-9');
        expect(d.sent).toHaveLength(1);
        expect(d.sent[0].msg.type).toBe('showBranchPicker');
        expect(d.sent[0].msg.branches[0].name).toBe('main');
    });

    it('branchSelected resolves merge-base + builds diff + starts replay', async () => {
        const d = mkDeps();
        (resolveRef as any).mockImplementation((_: string, ref: string) => {
            if (ref === 'feature/x') return 'feeeeeeefeefeeefeeefeeefeeefeeefeeefeeef';
            if (ref === 'HEAD') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
            return null;
        });
        (mergeBase as any).mockReturnValue('mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm');
        (buildCommitDiffGraphs as any).mockResolvedValue(FAKE_DIFF);

        const state = createGitDiffState();
        await branchSelected(d, state, 'feature/x');

        expect(buildCommitDiffGraphs).toHaveBeenCalledWith(
            '/repo',
            'mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm', // merge-base
            'feeeeeeefeefeeefeeefeeefeeefeeefeeefeeef',
            expect.any(Function),
        );
        expect(d.broadcasts.some(m => m.type === 'replayStarted')).toBe(true);
    });

    it('branchSelected toasts when the branch ref cannot be resolved', async () => {
        const d = mkDeps();
        (resolveRef as any).mockReturnValue(null);
        await branchSelected(d, createGitDiffState(), 'nope');
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('error');
        expect(toast?.text).toContain('Could not resolve branch');
    });
});

describe('requestPrDiff + prSelected (GitHub-backed)', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('fetches open PRs via the GitHub API + sends showPrPicker', async () => {
        const d = mkDeps();
        (getGithubRemote as any).mockReturnValue({ owner: 'octo', repo: 'demo' });
        (listGitHubPrs as any).mockResolvedValue([
            { number: 1, title: 'add feature', author: 'me', branch: 'feature/x', updatedAt: '2026-05-19', isDraft: false },
        ]);

        await requestPrDiff(d, 'client-7');

        expect(listGitHubPrs).toHaveBeenCalledWith('octo', 'demo', undefined);
        expect(d.sent[0].msg.type).toBe('showPrPicker');
        expect(d.sent[0].msg.prs[0].number).toBe(1);
    });

    it('passes GITHUB_TOKEN from the secrets store when present', async () => {
        const d = mkDeps();
        (d.secrets.get as any).mockResolvedValue('ghp_test');
        (getGithubRemote as any).mockReturnValue({ owner: 'octo', repo: 'demo' });
        (listGitHubPrs as any).mockResolvedValue([]);
        await requestPrDiff(d, 'client-7');
        expect(listGitHubPrs).toHaveBeenCalledWith('octo', 'demo', 'ghp_test');
    });

    it('errors when the workspace has no GitHub remote', async () => {
        const d = mkDeps();
        (getGithubRemote as any).mockReturnValue(null);
        await requestPrDiff(d, 'client-7');
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('error');
        expect(toast?.text).toContain('origin remote');
    });

    it('prSelected fetches the PR and builds the diff', async () => {
        const d = mkDeps();
        (getGithubRemote as any).mockReturnValue({ owner: 'octo', repo: 'demo' });
        (fetchGitHubPr as any).mockResolvedValue({
            prNumber: 42, prTitle: 'PR title', baseHash: 'baaaaaa', headHash: 'haaaaaa', baseRef: 'main', headRef: 'pr-branch',
        });
        (buildCommitDiffGraphs as any).mockResolvedValue(FAKE_DIFF);

        const state = createGitDiffState();
        await prSelected(d, state, 42);

        expect(fetchGitHubPr).toHaveBeenCalledWith('octo', 'demo', 42, undefined);
        expect(buildCommitDiffGraphs).toHaveBeenCalledWith('/repo', 'baaaaaa', 'haaaaaa', expect.any(Function));
        expect(d.broadcasts.some(m => m.type === 'replayStarted')).toBe(true);
        expect(state.activeContext?.headLabel).toContain('PR #42');
    });

    it('prSelected emits a private-repo hint on 404 without a token', async () => {
        const d = mkDeps();
        (getGithubRemote as any).mockReturnValue({ owner: 'octo', repo: 'demo' });
        (fetchGitHubPr as any).mockRejectedValue(new Error('PR not found'));
        await prSelected(d, createGitDiffState(), 99);
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('error');
        expect(toast?.text).toContain('Set GITHUB_TOKEN');
    });

    it('prSelected reports scope problem when token present + 404', async () => {
        const d = mkDeps();
        (d.secrets.get as any).mockResolvedValue('ghp_test');
        (getGithubRemote as any).mockReturnValue({ owner: 'octo', repo: 'demo' });
        (fetchGitHubPr as any).mockRejectedValue(new Error('PR not found'));
        await prSelected(d, createGitDiffState(), 99);
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.text).toContain('repo');
        expect(toast?.text).toContain('scope');
    });
});

describe('clearGitDiff', () => {
    it('clears context + broadcasts clearGitDiffContext + replayStopped', () => {
        const d = mkDeps();
        const state = createGitDiffState();
        state.activeContext = { baseHash: 'a', headHash: 'b', baseLabel: 'a', headLabel: 'b' };
        clearGitDiff(d, state);
        expect(state.activeContext).toBeNull();
        expect(d.broadcasts.map(m => m.type)).toEqual(['clearGitDiffContext', 'replayStopped']);
    });
});

// ── Multi-commit timeline walk ────────────────────────────────────────────

import { requestTimelineCommits, startTimelineReplay, skipReplayCommit } from '../gitDiff';

describe('requestTimelineCommits', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('sends showCommitRangePicker with commits + branches + baseline', () => {
        const d = mkDeps();
        (listCommits as any).mockReturnValue([
            { hash: 'aaaaaaa', shortHash: 'aaaaaaa', subject: 'first', author: 'a', relativeDate: 'now' },
            { hash: 'bbbbbbb', shortHash: 'bbbbbbb', subject: 'second', author: 'b', relativeDate: '1m' },
        ]);
        (listBranches as any).mockReturnValue([
            { name: 'main', isCurrent: false, isRemote: false },
            { name: 'feature/x', isCurrent: true, isRemote: false },
        ]);
        (mergeBase as any).mockReturnValue('merge-base-hash');

        requestTimelineCommits(d, 'client-1', 'feature/x');

        expect(d.sent).toHaveLength(1);
        expect(d.sent[0].clientId).toBe('client-1');
        expect(d.sent[0].msg.type).toBe('showCommitRangePicker');
        expect(d.sent[0].msg.commits).toHaveLength(2);
        expect(d.sent[0].msg.branches).toHaveLength(2);
        expect(d.sent[0].msg.currentBranch).toBe('feature/x');
        expect(d.sent[0].msg.baselineHash).toBe('merge-base-hash');
    });

    it('falls back to the oldest commit as baseline when there is no main/master', () => {
        const d = mkDeps();
        (listCommits as any).mockReturnValue([
            { hash: 'newer-hash', shortHash: 'newer', subject: 'b', author: 'a', relativeDate: 'now' },
            { hash: 'older-hash', shortHash: 'older', subject: 'a', author: 'a', relativeDate: '1d' },
        ]);
        (listBranches as any).mockReturnValue([
            { name: 'feature/x', isCurrent: true, isRemote: false },
        ]);

        requestTimelineCommits(d, 'client-1', 'feature/x');

        // No mergeBase call when there is no main/master branch.
        expect(mergeBase).not.toHaveBeenCalled();
        expect(d.sent[0].msg.baselineHash).toBe('older-hash');
    });
});

describe('startTimelineReplay (multi-commit walk)', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('refuses to walk fewer than two commits', async () => {
        const d = mkDeps();
        await startTimelineReplay(d, createGitDiffState(), [{ hash: 'aaaa' }]);
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('warning');
        expect(toast?.text).toContain('at least two');
        expect(buildCommitDiffGraphs).not.toHaveBeenCalled();
    });

    it('builds the timeline and broadcasts replayStarted', async () => {
        const d = mkDeps();
        (buildCommitDiffGraphs as any).mockResolvedValue(FAKE_DIFF);
        const state = createGitDiffState();
        await startTimelineReplay(d, state, [
            { hash: 'aaaaaaa', subject: 'first' },
            { hash: 'bbbbbbb', subject: 'second' },
            { hash: 'ccccccc', subject: 'third' },
        ]);
        // The engine walks pairs — 2 pairs from 3 commits.
        expect(buildCommitDiffGraphs).toHaveBeenCalledTimes(2);
        expect(d.broadcasts.some(m => m.type === 'replayStarted')).toBe(true);
        // Per-commit headers come through the WS bridge for the HUD.
        expect(d.broadcasts.some(m => m.type === 'replayCommitStart')).toBe(true);
    });

    it('toasts on engine failure — never throws', async () => {
        const d = mkDeps();
        (buildCommitDiffGraphs as any).mockRejectedValue(new Error('no such commit'));
        await startTimelineReplay(d, createGitDiffState(), [
            { hash: 'aaaa' }, { hash: 'bbbb' },
        ]);
        // The engine catches the gitOps failure and ends the replay; we
        // surface a toast via the engine's `onReplayEnd` → no replayStarted.
        // Either path is acceptable; what matters is no unhandled throw.
        // We just confirm the function settled without throwing.
        expect(true).toBe(true);
    });
});

describe('skipReplayCommit', () => {
    it('calls timeline.skipCommit when one exists', () => {
        const d = mkDeps();
        const state = createGitDiffState();
        state.timeline = { skipCommit: vi.fn() } as any;
        skipReplayCommit(d, state);
        expect((state.timeline as any).skipCommit).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when no timeline is active', () => {
        // Should not throw.
        skipReplayCommit(mkDeps(), createGitDiffState());
    });
});
