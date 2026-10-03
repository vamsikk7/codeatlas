/**
 * ADR-034 #TDD-fix-1 — per-repo files-table bug, using REAL go-gin fixture.
 *
 * Inline-seeded tests pass; the live multirepo-smoke run did not. The
 * difference is fixture richness. Copy the real e2e/real-repos/go-gin
 * subtree into a tmp multi-repo workspace, drive WorkspaceOrchestrator
 * via the Tier-1 in-process runner (same code path extension.ts uses
 * when Tier-2 is disabled), then assert files persisted to disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceOrchestrator, type RepoOrchestratorRunner } from '../workspaceOrchestrator';
import { RepoStoreRegistry } from '../../storage/repoStoreRegistry';
import { AggregatorStore } from '../../storage/aggregatorStore';
import { SnapshotStore } from '../../storage/snapshotStore';
import { SyncOrchestrator } from '../syncOrchestrator';
import { CommentStore } from '../../storage/commentStore';

const tmpDirs: string[] = [];
const REAL_GO_GIN = path.resolve(__dirname, '../../../../e2e/real-repos/go-gin');
const REAL_JS = path.resolve(__dirname, '../../../../e2e/real-repos/js-express');

function copyDirSync(src: string, dst: string): void {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (entry.name === '.codeatlas' || entry.name === 'node_modules' || entry.name === '.git') continue;
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) copyDirSync(s, d);
        else if (entry.isFile()) fs.copyFileSync(s, d);
    }
}

beforeEach(() => {
    RepoStoreRegistry.setForTest(null);
    WorkspaceOrchestrator.resetForTest();
});

afterEach(() => {
    WorkspaceOrchestrator.resetForTest();
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
});

describe('per-repo state.db population using REAL go-gin fixture', () => {
    it('go-gin sub-repo init persists files to per-repo state.db', async () => {
        if (!fs.existsSync(REAL_GO_GIN)) {
            // CI may not have run fetch:real-projects; skip cleanly.
            return;
        }
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-gogin-'));
        tmpDirs.push(ws);

        // Build a multi-repo workspace with go-gin alongside a JS sibling so
        // the detector flags multi-repo (single repo would skip the multi
        // dispatch path entirely).
        copyDirSync(REAL_GO_GIN, path.join(ws, 'go-gin'));
        if (fs.existsSync(REAL_JS)) {
            copyDirSync(REAL_JS, path.join(ws, 'js-express'));
        } else {
            // Fallback minimal JS repo so multi-repo detector still trips.
            fs.mkdirSync(path.join(ws, 'js-express/src'), { recursive: true });
            fs.writeFileSync(path.join(ws, 'js-express/package.json'), JSON.stringify({ name: 'js-express' }));
            fs.writeFileSync(path.join(ws, 'js-express/src/index.js'), 'module.exports = 1;');
        }

        const registry = new RepoStoreRegistry();
        const aggregator = new AggregatorStore(ws);
        await aggregator.init();
        registry.registerAggregatorStore(ws, aggregator);

        const runner: RepoOrchestratorRunner = async ({ workspaceRoot, repoRoot }) => {
            const perRepoStore = new SnapshotStore(repoRoot);
            registry.registerRepoStore(repoRoot, perRepoStore);
            const perRepoOrch = new SyncOrchestrator(
                workspaceRoot,
                perRepoStore,
                new CommentStore([]),
                undefined, undefined,
                repoRoot,
            );
            perRepoOrch.setLogger(() => { /* */ });
            await perRepoStore.load();
            await perRepoOrch.initialize();
        };

        const orch = new WorkspaceOrchestrator(ws, registry, () => { /* */ }, runner);
        const result = await orch.initialize();
        expect(result.mode).toBe('multi');
        expect(result.failures, JSON.stringify(result.failures)).toHaveLength(0);

        // Re-open per-repo state.db from disk
        const goGinRoot = path.join(ws, 'go-gin');
        const reopened = new SnapshotStore(goGinRoot);
        await reopened.load();
        const working = reopened.getWorking();
        const baseline = reopened.getBaseline();
        const workingFileCount = Object.keys(working.files).length;
        const workingApiCount = Object.keys(working.apiIndex).length;
        reopened.close();

        // Bug surface: apis present but files=0 on live multirepo-smoke.
        expect(workingApiCount, `expected apis (got ${workingApiCount})`).toBeGreaterThan(0);
        expect(
            workingFileCount,
            `expected files for go-gin; got files=${workingFileCount} apis=${workingApiCount}`,
        ).toBeGreaterThan(0);
        expect(Object.keys(baseline.files).length).toBeGreaterThan(0);
        // Spot-check: known file from fixture, workspace-prefixed.
        expect(working.files['go-gin/hello.go']).toBeDefined();
    });
});
