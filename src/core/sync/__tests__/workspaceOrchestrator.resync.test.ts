/**
 * ADR-034 Phase J (#795 — Phase J: Cross-repo diff propagation + workspace re-sync (ADR-034)) — WorkspaceOrchestrator.resync tests.
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsorch-resync-'));
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

// AggregatorStore import kept for type — we use the registry instance,
// not new direct opens, to avoid sql.js dual-handle drift.
void AggregatorStore;

describe('WorkspaceOrchestrator.resync — happy path', () => {
    it('all per-repo resyncs succeed → aggregatorRotated=true; baselines populated', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'svc-a');
        seedRepo(ws, 'svc-b');

        const calls: string[] = [];
        const runner: RepoOrchestratorRunner = async ({ repoId }) => { calls.push(repoId); };
        const registry = makeRegistry();
        const orch = new WorkspaceOrchestrator(ws, registry, () => { /* noop */ }, runner);
        await orch.initialize();
        const initCalls = calls.length;

        // Use the SAME aggregator instance as the orchestrator (registry).
        const agg = registry.getAggregatorStore(ws);
        agg.upsertSharedExternal({
            providerId: 'openai', name: 'OpenAI', category: 'ai',
            consumers: ['svc-a'], diff: null,
        });
        agg.save();

        const result = await orch.resync();
        expect(result.aggregatorRotated).toBe(true);
        expect(result.failures).toEqual([]);
        expect(Object.values(result.perRepoResyncs).every((v) => v === 'ok')).toBe(true);
        expect(calls.length).toBe(initCalls + 2);   // 2 more runner calls during resync

        const baseline = agg.listBaselineSharedExternals();
        expect(baseline).toHaveLength(1);
        expect(baseline[0].providerId).toBe('openai');
    });

    it('result.perRepoResyncs covers every repo', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'a');
        seedRepo(ws, 'b');
        seedRepo(ws, 'c');
        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, async () => { /* noop */ });
        await orch.initialize();
        const result = await orch.resync();
        expect(Object.keys(result.perRepoResyncs)).toHaveLength(3);
    });

    it('totalDurationMs is non-negative', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'a');
        seedRepo(ws, 'b');
        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, async () => { /* noop */ });
        await orch.initialize();
        const result = await orch.resync();
        expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    });
});

describe('WorkspaceOrchestrator.resync — failure handling', () => {
    it('one per-repo throws → aggregator NOT rotated, failures recorded', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'good');
        seedRepo(ws, 'bad');
        const runner: RepoOrchestratorRunner = async ({ repoRoot }) => {
            if (path.basename(repoRoot) === 'bad') throw new Error('resync blew up');
        };
        const registry = makeRegistry();
        const orch = new WorkspaceOrchestrator(ws, registry, () => { /* noop */ }, runner);
        await orch.initialize();

        // Seed working state so we can prove baseline DOESN'T rotate.
        const agg = registry.getAggregatorStore(ws);
        agg.upsertSharedExternal({
            providerId: 'openai', name: 'OpenAI', category: 'ai',
            consumers: ['a'], diff: null,
        });

        const result = await orch.resync();
        expect(result.aggregatorRotated).toBe(false);
        expect(result.failures.length).toBeGreaterThanOrEqual(1);
        expect(result.failures.some((f) => f.error.includes('resync blew up'))).toBe(true);

        // Baseline should be empty — rotation was skipped.
        expect(agg.listBaselineSharedExternals()).toEqual([]);
    });

    it('all per-repo fail → no baseline rotation, all failures collected', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'a');
        seedRepo(ws, 'b');
        const runner: RepoOrchestratorRunner = async () => { throw new Error('everything broken'); };
        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, runner);
        await orch.initialize();   // initial will mark both as failed
        const result = await orch.resync();
        expect(result.aggregatorRotated).toBe(false);
        expect(result.failures.length).toBeGreaterThanOrEqual(1);
        expect(Object.values(result.perRepoResyncs).every((v) => v === 'failed')).toBe(true);
    });
});

describe('WorkspaceOrchestrator.resync — no-op + idempotence', () => {
    it('resync with already-clean state → idempotent', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'a');
        seedRepo(ws, 'b');
        const registry = makeRegistry();
        const orch = new WorkspaceOrchestrator(ws, registry, () => { /* noop */ }, async () => { /* noop */ });
        await orch.initialize();

        const agg = registry.getAggregatorStore(ws);
        agg.upsertSharedExternal({
            providerId: 'x', name: 'X', category: 'ai',
            consumers: ['a'], diff: null,
        });
        agg.rotateBaseline();

        const first = await orch.resync();
        const second = await orch.resync();
        expect(first.aggregatorRotated).toBe(true);
        expect(second.aggregatorRotated).toBe(true);
    });
});

describe('WorkspaceOrchestrator.resync — single-repo workspace', () => {
    it('single-repo init still works — resync rotates baseline as for multi', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'lonely');
        // With one seeded child + workspace-root no manifest, detectMultiRepoMode
        // returns isMultiRepo=false → single-repo passthrough.
        const orch = new WorkspaceOrchestrator(ws, makeRegistry(), () => { /* noop */ }, async () => { /* noop */ });
        const initResult = await orch.initialize();
        expect(initResult.mode).toBe('single');

        const result = await orch.resync();
        // Resync iterates over aggregator's repos table — single repo row → 1 entry.
        expect(Object.keys(result.perRepoResyncs).length).toBe(1);
        expect(result.aggregatorRotated).toBe(true);
    });
});

describe('WorkspaceOrchestrator.resync — baseline + working diff alignment', () => {
    it('after resync, recomputeDiffs returns unchanged for all rows', async () => {
        const ws = makeTmpWorkspace();
        seedRepo(ws, 'a');
        seedRepo(ws, 'b');
        const registry = makeRegistry();
        const orch = new WorkspaceOrchestrator(ws, registry, () => { /* noop */ }, async () => { /* noop */ });
        await orch.initialize();

        const agg = registry.getAggregatorStore(ws);
        agg.upsertSharedExternal({
            providerId: 'openai', name: 'OpenAI', category: 'ai',
            consumers: ['a'], diff: null,
        });

        const result = await orch.resync();
        expect(result.aggregatorRotated).toBe(true);

        agg.recomputeDiffs();
        const row = agg.listSharedExternals()[0];
        // Post-rotate + recompute, working should match baseline → no diff set.
        expect(row.diff).toBeNull();
    });
});
