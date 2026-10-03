/**
 * Regression — manual re-init reused a CLOSED Tier-2 worker pool.
 *
 * The extension closes the startup worker pool after the initial init burst
 * (memory). The WorkspaceOrchestrator captured that pool at construction, so a
 * later `initialize()` (triggered by "CodeAtlas: Initialize Visuals") dispatched
 * to the now-closed pool and every repo failed with
 * "[WorkerPool] pool is closed; runTask rejected" — the L1 rendered
 * "Indexing failed" for all repos while the completion notification still read
 * stale non-zero counts from the in-memory stores.
 *
 * Fix: `WorkspaceOrchestrator.setTier2Pool()` lets the re-init path attach a
 * FRESH live pool before `initialize()` (and detach + close it after). This
 * test reproduces the failure with a fake "closed" pool and asserts recovery
 * after swapping in a working pool.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceOrchestrator } from '../workspaceOrchestrator';
import { RepoStoreRegistry } from '../../storage/repoStoreRegistry';
import type { IRepoStore } from '../../storage/storeInterfaces';

const tmpWorkspaces: string[] = [];

function makeTmpWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsorch-reinitpool-'));
    tmpWorkspaces.push(dir);
    return dir;
}

function seedRepo(workspace: string, name: string): void {
    const dir = path.join(workspace, name);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.1' }));
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

/** Minimal WorkerPool stand-in — `closed` mode rejects like the real pool. */
function fakePool(mode: 'closed' | 'ok', calls: string[]): any {
    return {
        ready: async () => { /* booted */ },
        close: async () => { /* noop */ },
        runTask: async (task: { repoId: string; repoRoot: string }) => {
            if (mode === 'closed') {
                throw new Error('[WorkerPool] pool is closed; runTask rejected');
            }
            calls.push(path.basename(task.repoRoot));
            return { persisted: true, summary: { apis: [] }, durationMs: 1 };
        },
    };
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

describe('WorkspaceOrchestrator — re-init worker pool lifecycle', () => {
    it('dispatching to a CLOSED pool fails every repo (bug repro)', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc-a');
        seedRepo(ws, 'svc-b');

        const closedPool = fakePool('closed', []);
        const orch = new WorkspaceOrchestrator(
            ws, makeRegistry(), () => { /* noop */ },
            async () => { /* runner unused in worker-threads mode */ },
            4, closedPool, async () => { /* tier2PostInit stub */ },
        );

        const result = await orch.initialize();
        expect(result.mode).toBe('multi');
        expect(result.repoCount).toBe(2);
        // Every repo failed because the pool is closed.
        expect(result.failures).toHaveLength(2);
        expect(result.failures.every((f) => /pool is closed/.test(f.error))).toBe(true);
    });

    it('setTier2Pool(freshPool) before re-init recovers all repos', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc-a');
        seedRepo(ws, 'svc-b');

        // Startup: healthy pool → repos succeed.
        const startupCalls: string[] = [];
        const orch = new WorkspaceOrchestrator(
            ws, makeRegistry(), () => { /* noop */ },
            async () => { /* unused */ },
            4, fakePool('ok', startupCalls), async () => { /* postInit */ },
        );
        const first = await orch.initialize();
        expect(first.failures).toHaveLength(0);
        expect(startupCalls.sort()).toEqual(['svc-a', 'svc-b']);

        // Simulate the extension closing the startup pool after the burst.
        orch.setTier2Pool(fakePool('closed', []));
        const broken = await orch.initialize();
        expect(broken.failures).toHaveLength(2); // proves the closed pool is what breaks re-init

        // Re-init fix: attach a FRESH live pool → all repos succeed again.
        const reinitCalls: string[] = [];
        orch.setTier2Pool(fakePool('ok', reinitCalls));
        const recovered = await orch.initialize();
        expect(recovered.failures).toHaveLength(0);
        expect(reinitCalls.sort()).toEqual(['svc-a', 'svc-b']);

        // Detaching (undefined) falls back to the in-process runner, never the
        // stale closed pool — no "pool is closed" failure.
        let inProcessRan = 0;
        const orch2 = new WorkspaceOrchestrator(
            ws, makeRegistry(), () => { /* noop */ },
            async () => { inProcessRan += 1; },
            4, fakePool('closed', []), async () => { /* postInit */ },
        );
        orch2.setTier2Pool(undefined);
        const fallback = await orch2.initialize();
        expect(fallback.failures).toHaveLength(0);
        expect(inProcessRan).toBe(2);
    });
});
