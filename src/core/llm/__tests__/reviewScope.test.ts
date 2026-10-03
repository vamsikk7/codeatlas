/**
 * ADR-034 Phase G (#792 — Phase G: AI Code Review per repo + workspace guidelines (ADR-034)) — reviewScope tests.
 * Pure-function tests against a fake aggregator + canned repo rows.
 */
import { describe, it, expect } from 'vitest';
import {
    routeFindingByGraphId,
    planWorkspaceReview,
    _workspaceGraphIdsForTest,
    type ReviewScope,
} from '../reviewScope';
import type { IAggregatorStore, RepoRow } from '../../storage/storeInterfaces';

function row(opts: Partial<RepoRow> & { repoId: string; rootPath: string }): RepoRow {
    return {
        repoId: opts.repoId,
        name: opts.repoId,
        rootPath: opts.rootPath,
        realpathHash: opts.repoId,
        technology: null,
        status: opts.status ?? 'ready',
        lastInitAt: 0,
        errorMessage: null,
        fallbackStatePath: null,
        stateDbSchemaVersion: 9,
        summarySchemaVersion: 1,
        diff: opts.diff ?? null,
    };
}

function fakeAggregator(repos: RepoRow[]): IAggregatorStore {
    return { listRepos: () => repos } as any;
}

// ─── routeFindingByGraphId ──────────────────────────────────────────────

describe('routeFindingByGraphId — empty / unknown', () => {
    it('empty string returns repo target', () => {
        expect(routeFindingByGraphId('', [])).toEqual({ target: 'repo' });
    });

    it('graphId with no colon returns repo target', () => {
        expect(routeFindingByGraphId('plain', [])).toEqual({ target: 'repo' });
    });
});

describe('routeFindingByGraphId — workspace-scope graphIds', () => {
    it.each(_workspaceGraphIdsForTest())(`%s → workspace target`, (id) => {
        const r = routeFindingByGraphId(id, [row({ repoId: 'a', rootPath: 'a' })]);
        expect(r.target).toBe('workspace');
        expect(r.repoId).toBeUndefined();
    });

    it('every entry in WORKSPACE_GRAPH_IDS routes to workspace', () => {
        for (const id of _workspaceGraphIdsForTest()) {
            expect(routeFindingByGraphId(id, []).target).toBe('workspace');
        }
    });
});

describe('routeFindingByGraphId — single-repo workspace', () => {
    it('any repo-scope graphId routes to the single repo (rootPath empty)', () => {
        const repos = [row({ repoId: 'only', rootPath: '' })];
        expect(routeFindingByGraphId('file:src/app.js', repos))
            .toEqual({ target: 'repo', repoId: 'only' });
        expect(routeFindingByGraphId('flow:src/app.js:login', repos))
            .toEqual({ target: 'repo', repoId: 'only' });
    });
});

describe('routeFindingByGraphId — multi-repo by path prefix', () => {
    const repos = [
        row({ repoId: 'r-alpha', rootPath: 'svc-alpha' }),
        row({ repoId: 'r-beta', rootPath: 'svc-beta' }),
    ];

    it('file:svc-alpha/src/x.ts → r-alpha', () => {
        expect(routeFindingByGraphId('file:svc-alpha/src/x.ts', repos))
            .toEqual({ target: 'repo', repoId: 'r-alpha' });
    });

    it('flow:svc-beta/src/y.ts:fn → r-beta', () => {
        expect(routeFindingByGraphId('flow:svc-beta/src/y.ts:fn', repos))
            .toEqual({ target: 'repo', repoId: 'r-beta' });
    });

    it('sequence:svc-alpha/src/x.ts:anonymous@GET:/users → r-alpha', () => {
        expect(routeFindingByGraphId('sequence:svc-alpha/src/x.ts:anonymous@GET:/users', repos))
            .toEqual({ target: 'repo', repoId: 'r-alpha' });
    });

    it('nested rootPath wins over shallower', () => {
        const nested = [
            row({ repoId: 'r-apps', rootPath: 'apps' }),
            row({ repoId: 'r-fe', rootPath: 'apps/frontend' }),
        ];
        expect(routeFindingByGraphId('file:apps/frontend/src/App.tsx', nested))
            .toEqual({ target: 'repo', repoId: 'r-fe' });
    });

    it('unmatched prefix → repo with no resolved id', () => {
        expect(routeFindingByGraphId('file:orphan/src/x.ts', repos))
            .toEqual({ target: 'repo' });
    });

    it('cluster-shape graphIds return repo with unresolved id (caller decides)', () => {
        expect(routeFindingByGraphId('feature:cluster:auth', repos))
            .toEqual({ target: 'repo' });
        expect(routeFindingByGraphId('api-list:cluster:auth', repos))
            .toEqual({ target: 'repo' });
    });
});

// ─── planWorkspaceReview ────────────────────────────────────────────────

describe('planWorkspaceReview — kind=repo', () => {
    it('returns just that repo', () => {
        const agg = fakeAggregator([
            row({ repoId: 'a', rootPath: 'svc-a' }),
            row({ repoId: 'b', rootPath: 'svc-b' }),
        ]);
        const t = planWorkspaceReview({ kind: 'repo', repoId: 'a' }, agg);
        expect(t).toEqual([{ repoId: 'a', rootPath: 'svc-a', name: 'a' }]);
    });

    it('unknown repoId → empty', () => {
        const agg = fakeAggregator([row({ repoId: 'a', rootPath: 'a' })]);
        expect(planWorkspaceReview({ kind: 'repo', repoId: 'missing' }, agg)).toEqual([]);
    });
});

describe('planWorkspaceReview — kind=entry-point', () => {
    it('returns repo with entryPointId set', () => {
        const agg = fakeAggregator([row({ repoId: 'a', rootPath: 'svc-a' })]);
        const t = planWorkspaceReview(
            { kind: 'entry-point', repoId: 'a', entryPointId: 'GET:/users' }, agg,
        );
        expect(t).toEqual([{ repoId: 'a', rootPath: 'svc-a', name: 'a', entryPointId: 'GET:/users' }]);
    });
});

describe('planWorkspaceReview — kind=workspace', () => {
    it('returns every ready repo', () => {
        const agg = fakeAggregator([
            row({ repoId: 'a', rootPath: 'a', status: 'ready' }),
            row({ repoId: 'b', rootPath: 'b', status: 'ready' }),
            row({ repoId: 'c', rootPath: 'c', status: 'ready' }),
        ]);
        const t = planWorkspaceReview({ kind: 'workspace' }, agg);
        expect(t.map((x) => x.repoId).sort()).toEqual(['a', 'b', 'c']);
    });

    it('skips failed repos', () => {
        const agg = fakeAggregator([
            row({ repoId: 'a', rootPath: 'a', status: 'ready' }),
            row({ repoId: 'b', rootPath: 'b', status: 'failed' }),
            row({ repoId: 'c', rootPath: 'c', status: 'ready' }),
        ]);
        const t = planWorkspaceReview({ kind: 'workspace' }, agg);
        expect(t.map((x) => x.repoId)).toEqual(['a', 'c']);
    });

    it('changedOnly skips repos with diff=unchanged', () => {
        const agg = fakeAggregator([
            row({ repoId: 'a', rootPath: 'a', diff: 'modified' }),
            row({ repoId: 'b', rootPath: 'b', diff: 'unchanged' }),
            row({ repoId: 'c', rootPath: 'c', diff: 'added' }),
        ]);
        const t = planWorkspaceReview({ kind: 'workspace', changedOnly: true }, agg);
        expect(t.map((x) => x.repoId).sort()).toEqual(['a', 'c']);
    });

    it('changedOnly with all unchanged → empty', () => {
        const agg = fakeAggregator([
            row({ repoId: 'a', rootPath: 'a', diff: 'unchanged' }),
            row({ repoId: 'b', rootPath: 'b', diff: 'unchanged' }),
        ]);
        const t = planWorkspaceReview({ kind: 'workspace', changedOnly: true }, agg);
        expect(t).toEqual([]);
    });
});
