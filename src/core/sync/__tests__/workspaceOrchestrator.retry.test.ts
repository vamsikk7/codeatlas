/**
 * ADR-034 Phase E (#790 — Phase E: failure isolation UX + multi-repo cascade tests (ADR-034)) — WorkspaceOrchestrator.retryRepo tests.
 *
 * Exercises the per-repo retry path against a tmpdir multi-repo fixture.
 * Uses a controllable RepoOrchestratorRunner so we can deterministically
 * pass/fail individual repos and verify status transitions land.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceOrchestrator, type RepoOrchestratorRunner } from '../workspaceOrchestrator';
import { RepoStoreRegistry } from '../../storage/repoStoreRegistry';
import { AggregatorStore } from '../../storage/aggregatorStore';
import type { IRepoStore } from '../../storage/storeInterfaces';

const tmpWorkspaces: string[] = [];

function makeTmpWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsorch-retry-'));
    tmpWorkspaces.push(dir);
    return dir;
}

function seedRepo(workspace: string, name: string): void {
    const dir = path.join(workspace, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'i.js'), `module.exports = '${name}';`);
}

class FakeRepoStore implements Partial<IRepoStore> {
    constructor(public root: string) {}
    save(): void { /* noop */ }
    close(): void { /* noop */ }
    getDbPath(): string { return `${this.root}/state.db`; }
    getSchemaVersion(): number { return 9; }
}

function makeRegistry(): RepoStoreRegistry {
    const reg = new RepoStoreRegistry();
    reg.setRepoFactoryForTest((r) => new FakeRepoStore(r) as any);
    return reg;
}

beforeEach(() => {
    RepoStoreRegistry.setForTest(null);
    WorkspaceOrchestrator.resetForTest();
});

afterEach(() => {
    WorkspaceOrchestrator.resetForTest();
    while (tmpWorkspaces.length) {
        try { fs.rmSync(tmpWorkspaces.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

async function openRepos(ws: string) {
    const s = new AggregatorStore(ws);
    await s.init();
    const r = s.listRepos();
    s.close();
    return r;
}

describe('WorkspaceOrchestrator.retryRepo — happy path', () => {
    it('retry a previously-failed repo → status flips back to ready', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'good');
        seedRepo(ws, 'flaky');

        let failNext = true;
        const runner: RepoOrchestratorRunner = async ({ repoRoot }) => {
            if (path.basename(repoRoot) === 'flaky' && failNext) {
                throw new Error('first time fails');
            }
        };
        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner);
        await orch.initialize();

        const before = await openRepos(ws);
        const flaky = before.find((r) => r.rootPath === 'flaky')!;
        expect(flaky.status).toBe('failed');

        // Re-arm the runner so the retry succeeds.
        failNext = false;
        const result = await orch.retryRepo(flaky.repoId);
        expect(result.status).toBe('ready');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);

        const after = await openRepos(ws);
        const recovered = after.find((r) => r.repoId === flaky.repoId)!;
        expect(recovered.status).toBe('ready');
        expect(recovered.errorMessage).toBeNull();
    });

    it('retry on ready repo → re-runs (force re-init); status ends ready', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc');
        seedRepo(ws, 'other');   // 2 sibs needed to trigger multi-repo mode
        const calls: string[] = [];
        const runner: RepoOrchestratorRunner = async ({ repoId }) => { calls.push(repoId); };
        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner);
        await orch.initialize();
        const repos = await openRepos(ws);
        const svc = repos.find((r) => r.rootPath === 'svc')!;
        expect(calls.length).toBeGreaterThanOrEqual(2);   // both repos parsed initially
        const initialCount = calls.length;

        const result = await orch.retryRepo(svc.repoId);
        expect(result.status).toBe('ready');
        expect(calls).toHaveLength(initialCount + 1);   // retry adds one more
    });
});

describe('WorkspaceOrchestrator.retryRepo — guard paths', () => {
    it('retry on unknown repoId → deleted status', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc');
        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, async () => { /* noop */ });
        await orch.initialize();
        const result = await orch.retryRepo('does-not-exist');
        expect(result.status).toBe('deleted');
        expect(result.error).toMatch(/not in registry/);
    });

    it('retry after repo dir was deleted → row dropped, returns deleted', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc-a');
        seedRepo(ws, 'svc-b');
        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, async () => { /* noop */ });
        await orch.initialize();
        const repos = await openRepos(ws);
        const a = repos.find((r) => r.rootPath === 'svc-a')!;

        fs.rmSync(path.join(ws, 'svc-a'), { recursive: true, force: true });
        const result = await orch.retryRepo(a.repoId);
        expect(result.status).toBe('deleted');

        const after = await openRepos(ws);
        expect(after.map((r) => r.rootPath)).toEqual(['svc-b']);
    });

    it('retry on already-parsing repo → no-op, returns parsing', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc');
        seedRepo(ws, 'other');
        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, async () => { /* noop */ });
        await orch.initialize();
        const repos = await openRepos(ws);
        const svc = repos.find((r) => r.rootPath === 'svc')!;

        // Manually flip status to parsing to simulate in-flight init.
        const agg = new AggregatorStore(ws);
        await agg.init();
        agg.upsertRepo({ ...svc, status: 'parsing' });
        agg.save();
        agg.close();

        const runner: RepoOrchestratorRunner = async () => { throw new Error('should not be called'); };
        const orchB = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner);
        const result = await orchB.retryRepo(svc.repoId);
        expect(result.status).toBe('parsing');
    });
});

describe('WorkspaceOrchestrator.retryRepo — isolation', () => {
    it('two retries on different repos run independently', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc-a');
        seedRepo(ws, 'svc-b');
        const calls: string[] = [];
        const runner: RepoOrchestratorRunner = async ({ repoId }) => { calls.push(repoId); };
        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner);
        await orch.initialize();
        const repos = await openRepos(ws);
        const a = repos.find((r) => r.rootPath === 'svc-a')!;
        const b = repos.find((r) => r.rootPath === 'svc-b')!;

        calls.length = 0;
        await Promise.all([orch.retryRepo(a.repoId), orch.retryRepo(b.repoId)]);
        expect(calls.sort()).toEqual([a.repoId, b.repoId].sort());
    });

    it('retry triggers a NEW failure → status flips to failed with new errorMessage', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc');
        seedRepo(ws, 'other');
        let attempt = 0;
        const runner: RepoOrchestratorRunner = async ({ repoRoot }) => {
            if (path.basename(repoRoot) !== 'svc') return;   // only svc fails
            attempt += 1;
            throw new Error(`attempt ${attempt} blew up`);
        };
        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner);
        await orch.initialize();
        const repos = await openRepos(ws);
        const svc = repos.find((r) => r.rootPath === 'svc')!;
        const result = await orch.retryRepo(svc.repoId);
        expect(result.status).toBe('failed');
        expect(result.error).toMatch(/attempt 2/);
        const after = await openRepos(ws);
        const svcAfter = after.find((r) => r.rootPath === 'svc')!;
        expect(svcAfter.errorMessage).toMatch(/attempt 2/);
    });
});

describe('WorkspaceOrchestrator.retryRepo — skeletal L1 refresh', () => {
    it('after successful retry, skeletal L1 reflects ready status', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc');
        seedRepo(ws, 'other');
        let firstCall = true;
        const runner: RepoOrchestratorRunner = async ({ repoRoot }) => {
            if (path.basename(repoRoot) === 'svc' && firstCall) {
                firstCall = false;
                throw new Error('first time fail');
            }
        };
        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner);
        await orch.initialize();
        const repos = await openRepos(ws);
        const svc = repos.find((r) => r.rootPath === 'svc')!;
        expect(svc.status).toBe('failed');

        await orch.retryRepo(svc.repoId);

        // Skeletal L1 in aggregator must show this repo as ready now.
        const direct = new AggregatorStore(ws);
        await direct.init();
        const graph = direct.getWorkingGraph('microservice:workspace');
        expect(graph).toBeDefined();
        const node = graph.nodes.find((n: any) => n.meta?.repoId === svc.repoId);
        expect(node).toBeDefined();
        expect(node.meta.status).toBe('ready');
        expect(node.meta.errorMessage).toBeNull();
        direct.close();
    });
});
