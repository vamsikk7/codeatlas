/**
 * workspaceCascadeHarness.ts
 *
 * ADR-034 Phase E Pass 3 follow-up — multi-repo T3 harness.
 *
 * Parallel to `cascadeHarness.ts` (single-repo), this driver seeds N
 * synthesized repo dirs under a shared workspace tmpdir, runs the real
 * `WorkspaceOrchestrator` + `RepoStoreRegistry` against them, and lets
 * the caller assert on the resulting `WorkspaceInitResult` + per-repo
 * `RepoRow.status` field.
 *
 * Synthesizing the repos in-process (rather than reaching into
 * `e2e/real-repos/`) keeps the harness self-contained — tests run on a
 * fresh checkout with no `npm run fetch:real-projects` prerequisite.
 *
 * Repo shapes deliberately minimal — a handful of JS files with one
 * Express route per repo + the optional injected syntax error. Enough
 * to exercise the failure-isolation contract (good repos reach
 * status='ready', bad repos land at status='failed' with non-empty
 * errorMessage, sibling repos don't get tainted by the failure).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceOrchestrator } from '../../src/core/sync/workspaceOrchestrator';
import type { RepoOrchestratorRunner } from '../../src/core/sync/workspaceOrchestrator';
import { RepoStoreRegistry } from '../../src/core/storage/repoStoreRegistry';
import { SnapshotStore } from '../../src/core/storage/snapshotStore';
import { CommentStore } from '../../src/core/storage/commentStore';
import { SyncOrchestrator } from '../../src/core/sync/syncOrchestrator';
import { setGrammarsDir, resetTreeSitterForTesting } from '../../src/core/parser/treeSitterParser';
import type { WorkspaceInitResult } from '../../src/core/sync/workspaceOrchestrator';
import type { RepoRow } from '../../src/core/storage/storeInterfaces';

export interface WorkspaceRepoSpec {
    /** Repo dir name under the workspace root (becomes RepoRow.rootPath). */
    name: string;
    /**
     * Failure-injection modes (Babel + tree-sitter are deliberately
     * fault-tolerant of syntax errors — they yield partial ASTs without
     * throwing — so we inject failures at points the orchestrator can't
     * route around).
     *
     *   'runner-throw'   — the production-equivalent runner throws before
     *                      it constructs SnapshotStore; tests the dispatcher
     *                      contract end-to-end.
     *   'store-corrupt' — pre-creates `.codeatlas` as a file (not dir) so
     *                      SnapshotStore.load fails on disk.
     */
    inject?: 'runner-throw' | 'store-corrupt';
}

export interface WorkspaceScenarioOptions {
    repos: WorkspaceRepoSpec[];
}

export interface WorkspaceScenarioResult {
    workspaceDir: string;
    registry: RepoStoreRegistry;
    orchestrator: WorkspaceOrchestrator;
    initResult: WorkspaceInitResult;
    repoRows: RepoRow[];
    /** Drop the failure injection for a repo so a subsequent retryRepo
     *  takes the success path — exercises recovery semantics. */
    clearInjection: (repoName: string) => void;
    dispose: () => Promise<void>;
}

const orphanTmpdirs = new Set<string>();
let exitHookRegistered = false;
function registerExitHook(): void {
    if (exitHookRegistered) return;
    exitHookRegistered = true;
    const sweep = () => {
        for (const d of orphanTmpdirs) {
            try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
        orphanTmpdirs.clear();
    };
    process.on('exit', sweep);
}

/**
 * Build a fresh workspace tmpdir with the requested repo specs, run
 * `WorkspaceOrchestrator.initialize`, and return everything the caller
 * needs to assert outcomes.
 */
export async function runWorkspaceScenario(opts: WorkspaceScenarioOptions): Promise<WorkspaceScenarioResult> {
    if (opts.repos.length < 2) {
        throw new Error('[workspaceCascadeHarness] need ≥2 repos to exercise multi-repo mode');
    }
    resetTreeSitterForTesting();
    setGrammarsDir(path.join(process.cwd(), 'grammars'));
    registerExitHook();
    RepoStoreRegistry.setForTest(null);

    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cascade-'));
    orphanTmpdirs.add(workspaceDir);

    // Seed each repo: package.json, a tiny Express route, optional injection.
    for (const spec of opts.repos) {
        const repoDir = path.join(workspaceDir, spec.name);
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(repoDir, 'package.json'),
            JSON.stringify({ name: spec.name, version: '1.0.0', dependencies: { express: '4.18.0' } }, null, 2),
        );
        const indexPath = path.join(repoDir, 'src', 'index.js');
        const goodSource = [
            "const express = require('express');",
            'const app = express();',
            '',
            "app.get('/api/" + spec.name + "', (req, res) => {",
            "  res.json({ name: '" + spec.name + "', ok: true });",
            '});',
            '',
            'module.exports = app;',
            '',
        ].join('\n');
        fs.writeFileSync(indexPath, goodSource);
        if (spec.inject === 'store-corrupt') {
            // Create `.codeatlas` as a regular FILE in the repo root. When
            // SnapshotStore tries to mkdir + open `.codeatlas/state.db`, the
            // filesystem returns ENOTDIR / EEXIST → init throws → the repo
            // lands at status='failed' without taking the workspace down.
            fs.writeFileSync(path.join(repoDir, '.codeatlas'), 'not-a-directory');
        }
    }

    const registry = new RepoStoreRegistry();
    const messages: string[] = [];
    const log = (m: string) => { messages.push(m); };

    // Production-equivalent runner — same shape as extension.ts's
    // productionRepoRunner but without the LLM service / commentStore
    // wiring (those aren't relevant for failure isolation).
    const perRepoStores = new Map<string, SnapshotStore>();
    // Map repoRoot → injection mode so the runner can synthesize the
    // 'runner-throw' failure path without needing to read the file system.
    const injectionByRoot = new Map<string, WorkspaceRepoSpec['inject']>();
    for (const spec of opts.repos) {
        injectionByRoot.set(path.join(workspaceDir, spec.name), spec.inject);
    }
    const runner: RepoOrchestratorRunner = async ({ repoRoot, repoId, registry: reg, log: childLog }) => {
        const injection = injectionByRoot.get(repoRoot);
        if (injection === 'runner-throw') {
            childLog(`[harness-runner] ${repoId} injected runner-throw`);
            throw new Error(`harness runner-throw for ${repoId}`);
        }
        childLog(`[harness-runner] starting ${repoId} at ${repoRoot}`);
        const store = new SnapshotStore(repoRoot);
        store.setLogger(childLog);
        reg.registerRepoStore(repoRoot, store);
        perRepoStores.set(repoId, store);
        const commentStore = new CommentStore([]);
        const orch = new SyncOrchestrator(
            // Use the workspace root, not the repo root, so workspace-relative
            // paths come out the same way they do in production.
            path.dirname(repoRoot),
            store,
            commentStore,
            undefined, undefined, repoRoot,
        );
        orch.setLogger(childLog);
        await store.load();
        await orch.initialize();
        store.save();
    };

    const orchestrator = new WorkspaceOrchestrator(
        workspaceDir,
        registry,
        log,
        runner,
        Math.min(8, os.cpus().length),    // tier-1 concurrency
    );

    // Workspace-mode override so the orchestrator runs the multi-repo
    // dispatch path even on a workspace with no manifest at the root.
    fs.mkdirSync(path.join(workspaceDir, '.codeatlas'), { recursive: true });
    fs.writeFileSync(
        path.join(workspaceDir, '.codeatlas', 'workspace-mode.json'),
        JSON.stringify({ mode: 'multi' }),
    );

    const initResult = await orchestrator.initialize();
    const aggregator = registry.getAggregatorStore(workspaceDir);
    const repoRows = [...aggregator.listRepos()].sort((a, b) => a.rootPath.localeCompare(b.rootPath));

    const dispose = async () => {
        for (const s of perRepoStores.values()) {
            try { s.close(); } catch { /* ignore */ }
        }
        try { aggregator.close(); } catch { /* ignore */ }
        try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* */ }
        orphanTmpdirs.delete(workspaceDir);
        RepoStoreRegistry.setForTest(null);
    };

    const clearInjection = (repoName: string): void => {
        injectionByRoot.delete(path.join(workspaceDir, repoName));
    };

    return {
        workspaceDir,
        registry,
        orchestrator,
        initResult,
        repoRows,
        clearInjection,
        dispose,
    };
}

/**
 * Apply a follow-up edit to an existing scenario repo and rebuild it.
 * Mirrors `cascadeHarness.runScenario` — but scoped to one repo inside
 * the multi-repo workspace, so callers can assert cascade locality
 * (only the edited repo's graphs rebuild).
 */
export async function rebuildRepoFile(
    scenario: WorkspaceScenarioResult,
    repoName: string,
    repoRelativePath: string,
    newContent: string,
): Promise<{ store: SnapshotStore; rebuiltGraphIds: string[] }> {
    const repoRoot = path.join(scenario.workspaceDir, repoName);
    const absFile = path.join(repoRoot, repoRelativePath);
    fs.writeFileSync(absFile, newContent, 'utf-8');

    // Grab the per-repo store from the registry, run a rebuildFile pass.
    const store = scenario.registry.getRepoStore(repoRoot) as SnapshotStore;
    const commentStore = new CommentStore([]);
    const orch = new SyncOrchestrator(
        scenario.workspaceDir,
        store,
        commentStore,
        undefined, undefined, repoRoot,
    );
    const result = await orch.rebuildFile(absFile);
    return { store, rebuiltGraphIds: result.graphIds };
}
