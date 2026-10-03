/**
 * ADR-034 Phase A — AggregatorStore tests (#786 — Phase A: per-repo DB foundation (ADR-034)).
 *
 * Covers DDL emission, schema-version stamping, repo registry round-trips,
 * workspace-mode override behavior, workspace-scope graph CRUD, and the
 * cross-repo empty-stub readers. All persistence tests use a tmpdir;
 * in-memory mode is exercised separately for fast iteration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AggregatorStore } from '../aggregatorStore';
import { MONOREPO_SCHEMA_VERSION, MONOREPO_DB_FILE } from '../monorepoDbSchema';
import type { RepoRow, RepoSummary } from '../storeInterfaces';

const tmpWorkspaces: string[] = [];

function makeTmpWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-test-'));
    tmpWorkspaces.push(dir);
    return dir;
}

afterEach(() => {
    while (tmpWorkspaces.length) {
        const dir = tmpWorkspaces.pop()!;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

function sampleRepo(overrides: Partial<RepoRow> = {}): RepoRow {
    return {
        repoId: 'repo-a',
        name: 'service-a',
        rootPath: 'service-a',
        realpathHash: 'aaa111',
        technology: 'nodejs',
        status: 'ready',
        lastInitAt: 1700000000000,
        errorMessage: null,
        fallbackStatePath: null,
        stateDbSchemaVersion: 9,
        summarySchemaVersion: 1,
        diff: null,
        ...overrides,
    };
}

describe('AggregatorStore — lifecycle', () => {
    it('init() creates .codeatlas/monorepo.db when absent', async () => {
        const ws = makeTmpWorkspace();
        const store = new AggregatorStore(ws);
        await store.init();
        store.save();
        const dbPath = path.join(ws, '.codeatlas', MONOREPO_DB_FILE);
        expect(fs.existsSync(dbPath)).toBe(true);
        expect(store.getDbPath()).toBe(dbPath);
        expect(store.getSchemaVersion()).toBe(MONOREPO_SCHEMA_VERSION);
        store.close();
    });

    it('honours custom storageDirName (.codeatlas-sa for the standalone MCP)', async () => {
        const ws = makeTmpWorkspace();
        const store = new AggregatorStore(ws, { storageDirName: '.codeatlas-sa' });
        await store.init();
        store.save();
        expect(fs.existsSync(path.join(ws, '.codeatlas-sa', MONOREPO_DB_FILE))).toBe(true);
        expect(fs.existsSync(path.join(ws, '.codeatlas', MONOREPO_DB_FILE))).toBe(false);
        store.close();
    });

    it('survives close + reopen (data persists)', async () => {
        const ws = makeTmpWorkspace();
        const first = new AggregatorStore(ws);
        await first.init();
        first.upsertRepo(sampleRepo());
        first.save();
        first.close();

        const second = new AggregatorStore(ws);
        await second.init();
        const repos = second.listRepos();
        expect(repos).toHaveLength(1);
        expect(repos[0].repoId).toBe('repo-a');
        expect(repos[0].name).toBe('service-a');
        second.close();
    });

    it('in-memory mode skips disk writes', async () => {
        const ws = makeTmpWorkspace();
        const store = new AggregatorStore(ws, { inMemoryOnly: true });
        await store.init();
        store.upsertRepo(sampleRepo());
        store.save();   // no-op in memory mode
        // No DB file expected.
        expect(fs.existsSync(path.join(ws, '.codeatlas', MONOREPO_DB_FILE))).toBe(false);
        // But state is queryable in-memory.
        expect(store.listRepos()).toHaveLength(1);
        store.close();
    });
});

describe('AggregatorStore — repo registry', () => {
    let ws: string;
    let store: AggregatorStore;

    beforeEach(async () => {
        ws = makeTmpWorkspace();
        store = new AggregatorStore(ws, { inMemoryOnly: true });
        await store.init();
    });

    afterEach(() => store.close());

    it('upsertRepo round-trips every field', () => {
        const row = sampleRepo({
            errorMessage: 'parse failed at src/x.ts:10',
            fallbackStatePath: '/tmp/cache/state.db',
            diff: 'modified',
        });
        store.upsertRepo(row);
        const got = store.getRepo('repo-a');
        expect(got).toEqual(row);
    });

    it('listRepos orders deterministically by rootPath', () => {
        store.upsertRepo(sampleRepo({ repoId: 'r2', rootPath: 'zeta-svc' }));
        store.upsertRepo(sampleRepo({ repoId: 'r0', rootPath: 'alpha-svc' }));
        store.upsertRepo(sampleRepo({ repoId: 'r1', rootPath: 'beta-svc' }));
        const ids = store.listRepos().map((r) => r.repoId);
        expect(ids).toEqual(['r0', 'r1', 'r2']);
    });

    it('upsertRepo overwrites by repoId', () => {
        store.upsertRepo(sampleRepo({ status: 'parsing' }));
        store.upsertRepo(sampleRepo({ status: 'ready', errorMessage: null }));
        expect(store.getRepo('repo-a')!.status).toBe('ready');
        expect(store.listRepos()).toHaveLength(1);
    });

    it('deleteRepo removes the row', () => {
        store.upsertRepo(sampleRepo());
        store.deleteRepo('repo-a');
        expect(store.listRepos()).toHaveLength(0);
        expect(store.getRepo('repo-a')).toBeUndefined();
    });

    it('getRepo returns undefined for unknown id', () => {
        expect(store.getRepo('does-not-exist')).toBeUndefined();
    });
});

describe('AggregatorStore — workspace mode', () => {
    it('defaults to "auto" when nothing set', async () => {
        const ws = makeTmpWorkspace();
        const store = new AggregatorStore(ws, { inMemoryOnly: true });
        await store.init();
        expect(store.getWorkspaceMode()).toBe('auto');
        store.close();
    });

    it('setWorkspaceMode persists to settings table', async () => {
        const ws = makeTmpWorkspace();
        const store = new AggregatorStore(ws);
        await store.init();
        store.setWorkspaceMode('multi');
        store.save();
        store.close();
        const reopened = new AggregatorStore(ws);
        await reopened.init();
        expect(reopened.getWorkspaceMode()).toBe('multi');
        reopened.close();
    });

    it('override file at .codeatlas/workspace-mode.json wins over settings', async () => {
        const ws = makeTmpWorkspace();
        const store = new AggregatorStore(ws);
        await store.init();
        store.setWorkspaceMode('multi');
        store.save();
        const overridePath = path.join(ws, '.codeatlas', 'workspace-mode.json');
        fs.writeFileSync(overridePath, JSON.stringify({ mode: 'single' }));
        expect(store.getWorkspaceMode()).toBe('single');
        store.close();
    });

    it('malformed override file falls back to "auto"', async () => {
        const ws = makeTmpWorkspace();
        const store = new AggregatorStore(ws);
        await store.init();
        fs.mkdirSync(path.join(ws, '.codeatlas'), { recursive: true });
        fs.writeFileSync(path.join(ws, '.codeatlas', 'workspace-mode.json'), '{not json');
        expect(store.getWorkspaceMode()).toBe('auto');
        store.close();
    });
});

describe('AggregatorStore — workspace-scope graphs', () => {
    let store: AggregatorStore;

    beforeEach(async () => {
        store = new AggregatorStore(makeTmpWorkspace(), { inMemoryOnly: true });
        await store.init();
    });
    afterEach(() => store.close());

    it('updateWorkingGraph + getWorkingGraph round-trip', () => {
        const g = { type: 'microservice', nodes: [{ id: 'a' }], edges: [] };
        store.updateWorkingGraph('microservice:workspace', g);
        expect(store.getWorkingGraph('microservice:workspace')).toEqual(g);
    });

    it('removeWorkingGraph deletes', () => {
        store.updateWorkingGraph('map:workspace', { nodes: [] });
        store.removeWorkingGraph('map:workspace');
        expect(store.getWorkingGraph('map:workspace')).toBeUndefined();
    });

    it('iterateWorkingGraphs visits every row', () => {
        store.updateWorkingGraph('microservice:workspace', { kind: 'L1' });
        store.updateWorkingGraph('map:workspace', { kind: 'map' });
        const seen: string[] = [];
        store.iterateWorkingGraphs((id) => seen.push(id));
        seen.sort();
        expect(seen).toEqual(['map:workspace', 'microservice:workspace']);
    });
});

describe('AggregatorStore — repo summaries', () => {
    it('setRepoSummary + getRepoSummary round-trip', async () => {
        const store = new AggregatorStore(makeTmpWorkspace(), { inMemoryOnly: true });
        await store.init();
        const sum: RepoSummary = {
            repoId: 'repo-a',
            schemaVersion: 1,
            services: [{ id: 'main', name: 'main' }],
            externals: [],
            schemas: [],
            routes: [{ method: 'GET', route: '/api/x', filePath: 'src/x.ts' }],
        };
        store.setRepoSummary('repo-a', sum);
        const got = store.getRepoSummary('repo-a');
        expect(got).toEqual(sum);
        store.close();
    });

    it('getRepoSummary returns undefined for unknown id', async () => {
        const store = new AggregatorStore(makeTmpWorkspace(), { inMemoryOnly: true });
        await store.init();
        expect(store.getRepoSummary('missing')).toBeUndefined();
        store.close();
    });
});

describe('AggregatorStore — cross-repo readers (Phase A: empty stubs)', () => {
    it('listSharedExternals returns empty array on fresh DB', async () => {
        const store = new AggregatorStore(makeTmpWorkspace(), { inMemoryOnly: true });
        await store.init();
        expect(store.listSharedExternals()).toEqual([]);
        store.close();
    });

    it('listSharedSchemas returns empty array on fresh DB', async () => {
        const store = new AggregatorStore(makeTmpWorkspace(), { inMemoryOnly: true });
        await store.init();
        expect(store.listSharedSchemas()).toEqual([]);
        store.close();
    });

    it('listCrossRepoHttpEdges returns empty array on fresh DB', async () => {
        const store = new AggregatorStore(makeTmpWorkspace(), { inMemoryOnly: true });
        await store.init();
        expect(store.listCrossRepoHttpEdges()).toEqual([]);
        store.close();
    });
});
