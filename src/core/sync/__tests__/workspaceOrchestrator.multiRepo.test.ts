/**
 * ADR-034 Phase B — WorkspaceOrchestrator multi-repo dispatch tests (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)).
 *
 * Exercises the multi-repo branch end-to-end against a tmpdir fixture
 * with N sibling repos. Asserts:
 *   - monorepo.db.repos has N rows post-init
 *   - skeletal microservice:workspace graph in the aggregator has N nodes
 *   - per-repo init runner is invoked once per repo
 *   - status transitions parsing → ready (or failed) per repo
 *   - single-repo workspaces are unaffected (foundation test covers)
 *   - workspace-mode override forces single even when detector says multi
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceOrchestrator } from '../workspaceOrchestrator';
import type { RepoOrchestratorRunner } from '../workspaceOrchestrator';
import { RepoStoreRegistry } from '../../storage/repoStoreRegistry';
import { AggregatorStore } from '../../storage/aggregatorStore';
import type { IRepoStore } from '../../storage/storeInterfaces';

const tmpWorkspaces: string[] = [];

function makeTmpWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsorch-multi-'));
    tmpWorkspaces.push(dir);
    return dir;
}

/** Drop a minimal manifest so the detector flags the dir as a repo. */
function seedRepo(workspace: string, name: string): void {
    const dir = path.join(workspace, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, version: '0.0.1' }, null, 2),
    );
    // A skeleton dir so the detector tags 'manifest' (and the secondary
    // skeleton signal isn't needed).
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), `module.exports = '${name}';`);
}

class FakeRepoStore implements Partial<IRepoStore> {
    saved = 0;
    constructor(public root: string) {}
    save(): void { this.saved += 1; }
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
        const dir = tmpWorkspaces.pop()!;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

describe('WorkspaceOrchestrator — multi-repo dispatch', () => {
    it('3 sibling repos → 3 rows in aggregator + 3-node skeletal L1', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc-a');
        seedRepo(ws, 'svc-b');
        seedRepo(ws, 'svc-c');

        const calls: string[] = [];
        const runner: RepoOrchestratorRunner = async ({ repoId, repoRoot }) => {
            calls.push(`${repoId}@${path.basename(repoRoot)}`);
        };

        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner);
        const result = await orch.initialize();

        expect(result.mode).toBe('multi');
        expect(result.repoCount).toBe(3);
        expect(result.failures).toHaveLength(0);
        expect(calls).toHaveLength(3);

        // Verify aggregator state from a fresh open.
        const direct = new AggregatorStore(ws);
        await direct.init();
        const repos = direct.listRepos();
        expect(repos.map((r) => r.rootPath).sort()).toEqual(['svc-a', 'svc-b', 'svc-c']);
        for (const r of repos) {
            expect(r.status).toBe('ready');
            expect(r.errorMessage).toBeNull();
            expect(r.rootPath).not.toBe('');
        }
        const skel = direct.getWorkingGraph('microservice:workspace');
        expect(skel).toBeDefined();
        expect(skel.nodes).toHaveLength(3);
        expect(skel.meta.skeletal).toBe(true);
        direct.close();
    });

    it('per-repo runner failure marks status=failed, others succeed', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc-good');
        seedRepo(ws, 'svc-bad');

        const runner: RepoOrchestratorRunner = async ({ repoRoot }) => {
            if (path.basename(repoRoot) === 'svc-bad') {
                throw new Error('parser exploded');
            }
        };

        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner);
        const result = await orch.initialize();

        expect(result.mode).toBe('multi');
        expect(result.repoCount).toBe(2);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].error).toMatch(/parser exploded/);

        const direct = new AggregatorStore(ws);
        await direct.init();
        const repos = direct.listRepos();
        const good = repos.find((r) => r.rootPath === 'svc-good');
        const bad = repos.find((r) => r.rootPath === 'svc-bad');
        expect(good!.status).toBe('ready');
        expect(bad!.status).toBe('failed');
        expect(bad!.errorMessage).toMatch(/parser exploded/);
        direct.close();
    });

    it('skeletal L1 is broadcast BEFORE each per-repo runner fires (status=parsing visible)', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc-a');
        seedRepo(ws, 'svc-b');

        // Capture aggregator state AT each runner invocation so we can
        // assert the skeletal-first ordering.
        const statusesSeenDuringRun: string[][] = [];
        const runner: RepoOrchestratorRunner = async () => {
            const direct = new AggregatorStore(ws);
            await direct.init();
            statusesSeenDuringRun.push(direct.listRepos().map((r) => r.status).sort());
            direct.close();
        };

        await new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner).initialize();

        // First runner sees: one repo 'parsing' (the OTHER one, since this
        // one's status flips only AFTER its runner returns) + this repo's
        // own row (also 'parsing' at this point — the runner is invoked
        // BEFORE the status flips to 'ready').
        expect(statusesSeenDuringRun[0]).toEqual(['parsing', 'parsing']);

        // Second runner sees: prior repo is now 'ready', this one is 'parsing'.
        expect(statusesSeenDuringRun[1]).toEqual(['parsing', 'ready']);
    });

    it('workspace-mode override "single" forces single-repo path even with N siblings', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc-a');
        seedRepo(ws, 'svc-b');
        seedRepo(ws, 'svc-c');
        // Override file forces single mode.
        fs.mkdirSync(path.join(ws, '.codeatlas'), { recursive: true });
        fs.writeFileSync(
            path.join(ws, '.codeatlas', 'workspace-mode.json'),
            JSON.stringify({ mode: 'single' }),
        );

        const calls: string[] = [];
        const runner: RepoOrchestratorRunner = async ({ repoId }) => { calls.push(repoId); };
        const result = await new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner).initialize();

        // Single mode → only the workspace root is registered, runner not invoked.
        expect(result.mode).toBe('single');
        expect(result.repoCount).toBe(1);
        expect(calls).toHaveLength(0);

        const direct = new AggregatorStore(ws);
        await direct.init();
        const repos = direct.listRepos();
        expect(repos).toHaveLength(1);
        expect(repos[0].rootPath).toBe('');
        direct.close();
    });

    it('workspace-mode override "multi" forces multi-repo path even with no detected siblings', async () => {
        const ws = makeTmpWorkspace();   // no siblings seeded
        fs.mkdirSync(path.join(ws, '.codeatlas'), { recursive: true });
        fs.writeFileSync(
            path.join(ws, '.codeatlas', 'workspace-mode.json'),
            JSON.stringify({ mode: 'multi' }),
        );

        const result = await new WorkspaceOrchestrator(ws, makeRegistry()).initialize();
        // Override is honoured for `mode`, but with no detected repos we fall
        // through to the single-repo register-one-row path (per the dispatcher
        // gate `effectiveMode === 'multi' && detectedRepos.length > 0`).
        // The result.mode echoes the OVERRIDE; the workspace gets a single
        // row. Phase E adds a "multi-mode requested but no repos found" toast.
        expect(result.mode).toBe('multi');
        expect(result.repoCount).toBe(1);
    });

    it('repoId is deterministic across runs (realpath hashing)', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc-a');
        seedRepo(ws, 'svc-b');

        const runner: RepoOrchestratorRunner = async () => { /* noop */ };

        await new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner).initialize();
        const first = (await openAndListRepos(ws)).map((r) => r.repoId).sort();

        await new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner).initialize();
        const second = (await openAndListRepos(ws)).map((r) => r.repoId).sort();

        expect(second).toEqual(first);
    });

    it('reconcile() drops a row when its repo dir is deleted', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc-a');
        seedRepo(ws, 'svc-b');

        const runner: RepoOrchestratorRunner = async () => { /* noop */ };
        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner);
        await orch.initialize();
        expect((await openAndListRepos(ws))).toHaveLength(2);

        fs.rmSync(path.join(ws, 'svc-b'), { recursive: true, force: true });
        await orch.reconcile();

        const repos = await openAndListRepos(ws);
        expect(repos).toHaveLength(1);
        expect(repos[0].rootPath).toBe('svc-a');
    });

    it('result.detectedRepos lists every dispatched repo with stable shape', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'alpha');
        seedRepo(ws, 'beta');

        const result = await new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, async () => { /* noop */ }).initialize();
        const rootPaths = result.detectedRepos.map((r) => r.rootPath).sort();
        expect(rootPaths).toEqual(['alpha', 'beta']);
        for (const r of result.detectedRepos) {
            expect(typeof r.repoId).toBe('string');
            expect(r.repoId.length).toBeGreaterThan(0);
            expect(typeof r.name).toBe('string');
        }
    });

    it('per-repo init durations populate repoInitDurationsMs', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc-a');
        seedRepo(ws, 'svc-b');

        const runner: RepoOrchestratorRunner = async () => {
            await new Promise((r) => setTimeout(r, 5));
        };
        const result = await new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner).initialize();
        expect(Object.keys(result.repoInitDurationsMs)).toHaveLength(2);
        for (const ms of Object.values(result.repoInitDurationsMs)) {
            expect(ms).toBeGreaterThanOrEqual(0);
        }
    });
});

async function openAndListRepos(ws: string) {
    const s = new AggregatorStore(ws);
    await s.init();
    const repos = s.listRepos();
    s.close();
    return repos;
}
