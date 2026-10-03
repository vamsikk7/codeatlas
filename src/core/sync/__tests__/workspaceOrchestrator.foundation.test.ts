/**
 * ADR-034 Phase A — WorkspaceOrchestrator foundation tests (#786 — Phase A: per-repo DB foundation (ADR-034)).
 *
 * Single-repo passthrough: initialize() opens the aggregator, creates
 * monorepo.db on disk, registers one repos row keyed by realpath hash,
 * resolves the effective workspace mode, and exposes itself via
 * `current()`. reconcile() refreshes lastInitAt; resync() is a no-op
 * apart from a save.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceOrchestrator } from '../workspaceOrchestrator';
import { RepoStoreRegistry } from '../../storage/repoStoreRegistry';
import { AggregatorStore } from '../../storage/aggregatorStore';
import { MONOREPO_DB_FILE } from '../../storage/monorepoDbSchema';
import type { IRepoStore } from '../../storage/storeInterfaces';

const tmpWorkspaces: string[] = [];

function makeTmpWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsorch-test-'));
    tmpWorkspaces.push(dir);
    return dir;
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
    // Real aggregator for end-to-end DB check; fake repo store to skip
    // the heavy SnapshotStore load.
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

describe('WorkspaceOrchestrator — single-repo passthrough', () => {
    it('initialize() creates .codeatlas/monorepo.db and registers one repos row', async () => {
        const ws = makeTmpWorkspace();
        const reg = makeRegistry();
        const orch = new WorkspaceOrchestrator(ws, reg);
        const result = await orch.initialize();

        expect(result.mode).toBe('single');
        expect(result.repoCount).toBe(1);
        expect(result.failures).toHaveLength(0);
        expect(result.aggregatorSizeBytes).toBeGreaterThan(0);

        const dbPath = path.join(ws, '.codeatlas', MONOREPO_DB_FILE);
        expect(fs.existsSync(dbPath)).toBe(true);

        // Verify the aggregator's repos table now has one row.
        const direct = new AggregatorStore(ws);
        await direct.init();
        const repos = direct.listRepos();
        expect(repos).toHaveLength(1);
        expect(repos[0].rootPath).toBe('');
        expect(repos[0].name).toBe(path.basename(ws));
        expect(repos[0].status).toBe('ready');
        direct.close();
    });

    it('current() returns the most recently initialized orchestrator', async () => {
        const ws = makeTmpWorkspace();
        const orch = new WorkspaceOrchestrator(ws, makeRegistry());
        await orch.initialize();
        expect(WorkspaceOrchestrator.current()).toBe(orch);
    });

    it('initialize() is idempotent — re-running yields one repos row', async () => {
        const ws = makeTmpWorkspace();
        await new WorkspaceOrchestrator(ws, makeRegistry()).initialize();
        await new WorkspaceOrchestrator(ws, makeRegistry()).initialize();

        const direct = new AggregatorStore(ws);
        await direct.init();
        expect(direct.listRepos()).toHaveLength(1);
        direct.close();
    });

    it('realpathHash-derived repoId is deterministic across runs', async () => {
        const ws = makeTmpWorkspace();
        await new WorkspaceOrchestrator(ws, makeRegistry()).initialize();
        const direct = new AggregatorStore(ws);
        await direct.init();
        const firstId = direct.listRepos()[0].repoId;
        direct.close();

        await new WorkspaceOrchestrator(ws, makeRegistry()).initialize();
        const direct2 = new AggregatorStore(ws);
        await direct2.init();
        const secondId = direct2.listRepos()[0].repoId;
        direct2.close();

        expect(secondId).toBe(firstId);
    });

    it('workspace-mode.json override of "multi" surfaces in result.mode', async () => {
        const ws = makeTmpWorkspace();
        fs.mkdirSync(path.join(ws, '.codeatlas'), { recursive: true });
        fs.writeFileSync(
            path.join(ws, '.codeatlas', 'workspace-mode.json'),
            JSON.stringify({ mode: 'multi' }),
        );
        const result = await new WorkspaceOrchestrator(ws, makeRegistry()).initialize();
        expect(result.mode).toBe('multi');
    });

    it('reconcile() refreshes lastInitAt and detects deleted workspace', async () => {
        const ws = makeTmpWorkspace();
        const reg = makeRegistry();
        const orch = new WorkspaceOrchestrator(ws, reg);
        await orch.initialize();

        const direct1 = new AggregatorStore(ws);
        await direct1.init();
        const first = direct1.listRepos()[0].lastInitAt;
        direct1.close();

        await new Promise((r) => setTimeout(r, 5));   // ensure clock ticks
        await orch.reconcile();

        const direct2 = new AggregatorStore(ws);
        await direct2.init();
        const second = direct2.listRepos()[0].lastInitAt;
        direct2.close();

        expect(second).toBeGreaterThanOrEqual(first);
    });

    it('resync() returns a WorkspaceResyncResult (Phase J)', async () => {
        const ws = makeTmpWorkspace();
        const orch = new WorkspaceOrchestrator(ws, makeRegistry());
        await orch.initialize();
        const result = await orch.resync();
        expect(result).toBeDefined();
        expect(result.aggregatorRotated).toBe(true);
        expect(typeof result.totalDurationMs).toBe('number');
    });

    it('lazy-opens the per-repo store at workspaceRoot via the registry', async () => {
        const ws = makeTmpWorkspace();
        const reg = makeRegistry();
        let factoryCalls = 0;
        reg.setRepoFactoryForTest((r) => { factoryCalls += 1; return new FakeRepoStore(r) as any; });
        await new WorkspaceOrchestrator(ws, reg).initialize();
        expect(factoryCalls).toBe(1);
        expect(reg.getOpenStoreCount()).toBe(1);
    });
});
