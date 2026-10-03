/**
 * ADR-034 Phase B Pass 4b (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)) — resolveStoreForPath tests.
 *
 * Pure logic — no FS, no SQL. Verifies the path → repo store mapping
 * works in single-repo, multi-repo, and unmatched-path cases.
 */
import { describe, it, expect } from 'vitest';
import { resolveStoreForPath } from '../resolveStoreForPath';
import { RepoStoreRegistry } from '../../core/storage/repoStoreRegistry';
import type { IRepoStore, IAggregatorStore, RepoRow } from '../../core/storage/storeInterfaces';

class FakeRepoStore implements Partial<IRepoStore> {
    constructor(public root: string) {}
    save(): void { /* noop */ }
    close(): void { /* noop */ }
    getDbPath(): string { return `${this.root}/state.db`; }
    getSchemaVersion(): number { return 9; }
}

function row(rootPath: string, repoId: string): RepoRow {
    return {
        repoId, name: rootPath || 'root', rootPath, realpathHash: repoId,
        technology: null, status: 'ready', lastInitAt: 0, errorMessage: null,
        fallbackStatePath: null, stateDbSchemaVersion: 9, summarySchemaVersion: 1,
        diff: null,
    };
}

function fakeAggregator(rows: RepoRow[]): IAggregatorStore {
    return {
        listRepos: () => rows,
    } as any;
}

const WS = '/workspace';

describe('resolveStoreForPath', () => {
    it('no registry/aggregator → workspace-root passthrough', () => {
        const ws = new FakeRepoStore(WS) as any;
        const result = resolveStoreForPath('src/app.js', WS, ws, undefined, undefined);
        expect(result.store).toBe(ws);
        expect(result.repoId).toBe('');
        expect(result.rootPath).toBe('');
        expect(result.repoRelativePath).toBe('src/app.js');
    });

    it('aggregator with zero rows → passthrough', () => {
        const ws = new FakeRepoStore(WS) as any;
        const reg = new RepoStoreRegistry();
        const agg = fakeAggregator([]);
        const result = resolveStoreForPath('src/app.js', WS, ws, reg, agg);
        expect(result.store).toBe(ws);
    });

    it('single-repo (1 row, rootPath="") → passthrough to workspace store', () => {
        const ws = new FakeRepoStore(WS) as any;
        const reg = new RepoStoreRegistry();
        const agg = fakeAggregator([row('', 'r-only')]);
        const result = resolveStoreForPath('src/app.js', WS, ws, reg, agg);
        expect(result.store).toBe(ws);
        expect(result.repoId).toBe('');
        expect(result.repoRelativePath).toBe('src/app.js');
    });

    it('multi-repo → longest-prefix match routes to that repo store', () => {
        const ws = new FakeRepoStore(WS) as any;
        const alpha = new FakeRepoStore(`${WS}/svc-alpha`) as any;
        const reg = new RepoStoreRegistry();
        reg.setRepoFactoryForTest((r) => r.endsWith('/svc-alpha') ? alpha : (new FakeRepoStore(r) as any));
        const agg = fakeAggregator([
            row('svc-alpha', 'r-alpha'),
            row('svc-beta', 'r-beta'),
        ]);
        const result = resolveStoreForPath('svc-alpha/src/server.js', WS, ws, reg, agg);
        expect(result.store).toBe(alpha);
        expect(result.repoId).toBe('r-alpha');
        expect(result.rootPath).toBe('svc-alpha');
        expect(result.repoRelativePath).toBe('src/server.js');
    });

    it('multi-repo nested rootPath wins over shallower one', () => {
        const ws = new FakeRepoStore(WS) as any;
        const seen: string[] = [];
        const reg = new RepoStoreRegistry();
        reg.setRepoFactoryForTest((r) => { seen.push(r); return new FakeRepoStore(r) as any; });
        const agg = fakeAggregator([
            row('apps', 'r-apps'),
            row('apps/frontend', 'r-fe'),    // nested — should win for paths under it
        ]);
        const result = resolveStoreForPath('apps/frontend/src/App.tsx', WS, ws, reg, agg);
        expect(result.repoId).toBe('r-fe');
        expect(result.rootPath).toBe('apps/frontend');
        expect(result.repoRelativePath).toBe('src/App.tsx');
        expect(seen).toContain(`${WS}/apps/frontend`);
    });

    it('unmatched path → falls back to workspace store with empty repoId', () => {
        const ws = new FakeRepoStore(WS) as any;
        const reg = new RepoStoreRegistry();
        reg.setRepoFactoryForTest((r) => new FakeRepoStore(r) as any);
        const agg = fakeAggregator([
            row('svc-alpha', 'r-alpha'),
            row('svc-beta', 'r-beta'),
        ]);
        // file at workspace root — no repo prefix matches
        const result = resolveStoreForPath('orphan-at-root.md', WS, ws, reg, agg);
        expect(result.store).toBe(ws);
        expect(result.repoId).toBe('');
    });

    it('file matching exactly a rootPath (rare edge) still resolves to that repo', () => {
        const ws = new FakeRepoStore(WS) as any;
        const reg = new RepoStoreRegistry();
        reg.setRepoFactoryForTest((r) => new FakeRepoStore(r) as any);
        const agg = fakeAggregator([row('svc-alpha', 'r-alpha')]);
        const result = resolveStoreForPath('svc-alpha', WS, ws, reg, agg);
        expect(result.repoId).toBe('r-alpha');
        expect(result.rootPath).toBe('svc-alpha');
        expect(result.repoRelativePath).toBe('');   // rebased to empty
    });

    it('aggregator listRepos throw → safe fallback to workspace store', () => {
        const ws = new FakeRepoStore(WS) as any;
        const reg = new RepoStoreRegistry();
        const agg = { listRepos: () => { throw new Error('db locked'); } } as any;
        const result = resolveStoreForPath('svc-alpha/src/x.js', WS, ws, reg, agg);
        expect(result.store).toBe(ws);
        expect(result.repoId).toBe('');
    });

    it('registry.getRepoStore throw → safe fallback', () => {
        const ws = new FakeRepoStore(WS) as any;
        const reg = new RepoStoreRegistry();
        reg.setRepoFactoryForTest(() => { throw new Error('open failed'); });
        const agg = fakeAggregator([row('svc-alpha', 'r-alpha')]);
        const result = resolveStoreForPath('svc-alpha/src/x.js', WS, ws, reg, agg);
        expect(result.store).toBe(ws);
        expect(result.repoId).toBe('');
    });
});
