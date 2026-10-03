/**
 * ADR-034 Phase A + B — `WorkspaceOrchestrator` facade (#786, #787).
 *
 * The one entrypoint every caller (extension activation, standalone MCP,
 * tests) goes through to bootstrap a workspace.
 *
 * Phase A — single-repo passthrough:
 *   1. Ensure `.codeatlas/` exists.
 *   2. Open the aggregator (`monorepo.db`) via the registry.
 *   3. Upsert one `repos` row keyed by realpath hash, `rootPath = ''`.
 *
 * Phase B — multi-repo dispatch (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)):
 *   1. Run `detectMultiRepoMode(workspaceRoot)`.
 *   2. If multi-repo:
 *      a. For each detected sibling repo:
 *         - upsertRepo(status='parsing')
 *         - Construct a per-repo store via the injected `repoOrchestratorFactory`
 *         - Run the per-repo SyncOrchestrator init via the factory
 *         - upsertRepo(status='ready' | 'failed')
 *      b. After all repos: build skeletal L1 from the registry, write it
 *         into the aggregator's `microservice:workspace` graph, broadcast.
 *   3. If single-repo: keep Phase A behaviour byte-identical.
 *
 * The `repoOrchestratorFactory` parameter is the seam that lets unit tests
 * exercise the dispatch logic without spinning up the real parser. Defaults
 * to a noop registrar that just exercises store + registry mechanics; the
 * extension passes a real factory in production that wires SnapshotStore +
 * SyncOrchestrator + commentStore + LLM service per repo.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RepoStoreRegistry } from '../storage/repoStoreRegistry';
import { MONOREPO_SCHEMA_VERSION } from '../storage/monorepoDbSchema';
import { detectMultiRepoMode } from '../analysis/multiRepoDetector';
import type { DetectedRepo } from '../analysis/multiRepoDetector';
import { buildSkeletalL1 } from './skeletalL1';
import { RepoDispatcher } from './repoDispatcher';
import type { IAggregatorStore, IRepoStore, RepoRow } from '../storage/storeInterfaces';

export interface WorkspaceInitResult {
    mode: 'single' | 'multi';
    repoCount: number;
    /** Per-repo init durations in ms, keyed by repoId. */
    repoInitDurationsMs: Record<string, number>;
    /** Aggregator monorepo.db size on disk after init (bytes). */
    aggregatorSizeBytes: number;
    /** Total wall-clock init duration in ms. */
    totalDurationMs: number;
    /** Per-repo failures — empty when every repo's init succeeded. */
    failures: ReadonlyArray<{ repoId: string; error: string }>;
    /** ADR-034 Phase B — list of detected sibling repos when multi-repo. */
    detectedRepos: ReadonlyArray<{ repoId: string; rootPath: string; name: string }>;
}

/**
 * Per-repo init driver. Returns when the repo's `state.db` has been built.
 * Throws to signal "this repo failed" — the dispatcher catches and marks
 * the row `status='failed'`.
 *
 * Default impl is a no-op registrar — exists so unit tests can exercise the
 * dispatcher without dragging in the parser. Production passes a real
 * factory that constructs SnapshotStore + SyncOrchestrator + runs the
 * cascade.
 */
export type RepoOrchestratorRunner = (params: {
    workspaceRoot: string;
    repoRoot: string;
    repoId: string;
    registry: RepoStoreRegistry;
    log: (msg: string) => void;
}) => Promise<void>;

const NOOP_REPO_RUNNER: RepoOrchestratorRunner = async () => { /* registry-only smoke */ };

export class WorkspaceOrchestrator {
    private static currentInstance: WorkspaceOrchestrator | undefined;

    constructor(
        public readonly workspaceRoot: string,
        private readonly registry: RepoStoreRegistry,
        private readonly log: (msg: string) => void = () => { /* noop */ },
        /**
         * ADR-034 Phase B — production wires the real per-repo init driver
         * here. Unit tests rely on the default noop to verify dispatcher
         * mechanics in isolation.
         */
        private readonly repoOrchestratorRunner: RepoOrchestratorRunner = NOOP_REPO_RUNNER,
        /**
         * ADR-034 Phase D Tier-1 — concurrency cap for parallel per-repo
         * dispatch. `1` (default) preserves Phase B's serial behaviour;
         * the extension reads `codeatlas.cascadeParallelism` and bumps
         * this to ~8 when the user opts into Tier-1.
         */
        private readonly concurrencyLimit: number = 1,
        /**
         * ADR-034 Phase D Tier-2 (#789-D2) — when set, per-repo init runs
         * in this worker_threads pool (real CPU parallelism). The Tier-2
         * post-init hook is required alongside so the main thread can
         * re-open the worker's persisted state.db and apply the produced
         * summary to the aggregator. When either is undefined the
         * dispatcher falls back to Tier-1.
         */
        private tier2Pool: import('./workerPool').WorkerPool | undefined = undefined,
        private readonly tier2PostInit:
            | ((params: {
                workspaceRoot: string;
                repoRoot: string;
                repoId: string;
                registry: RepoStoreRegistry;
                log: (msg: string) => void;
                workerResult: import('./repoWorker').WorkerResult;
            }) => Promise<void>)
            | undefined = undefined,
    ) {}

    static current(): WorkspaceOrchestrator | undefined { return WorkspaceOrchestrator.currentInstance; }
    static resetForTest(): void { WorkspaceOrchestrator.currentInstance = undefined; }

    /**
     * Swap the Tier-2 worker pool. Required for manual re-init: the extension
     * closes the startup pool after the initial init burst (memory), so the
     * pool captured at construction is dead by the time a user triggers a
     * re-init. The re-init path spins up a fresh pool, attaches it here, runs
     * `initialize()`, then detaches (passes `undefined`) + closes it. Without
     * this, `initialize()` dispatches to the closed pool and every repo fails
     * with "[WorkerPool] pool is closed; runTask rejected".
     */
    setTier2Pool(pool: import('./workerPool').WorkerPool | undefined): void {
        this.tier2Pool = pool;
    }

    /**
     * Bootstrap the workspace. Dispatches to either the single-repo path
     * (Phase A) or the multi-repo path (Phase B) based on
     * `detectMultiRepoMode()` + the workspace-mode override file.
     */
    async initialize(): Promise<WorkspaceInitResult> {
        const t0 = Date.now();
        const repoInitDurationsMs: Record<string, number> = {};
        const failures: Array<{ repoId: string; error: string }> = [];

        // Step 1 — ensure .codeatlas dir.
        const storageDir = path.join(this.workspaceRoot, '.codeatlas');
        if (!fs.existsSync(storageDir)) {
            try { fs.mkdirSync(storageDir, { recursive: true }); }
            catch (err: any) {
                this.log(`[WorkspaceOrchestrator] failed to create ${storageDir}: ${err?.message ?? err}`);
                throw err;
            }
        }

        // Step 2 — open aggregator (creates monorepo.db if absent).
        const aggregator = this.registry.getAggregatorStore(this.workspaceRoot);
        if ('init' in aggregator && typeof (aggregator as any).init === 'function') {
            await (aggregator as any).init();
        }

        // Step 3 — resolve effective mode (override file > auto-detection).
        const overrideMode = aggregator.getWorkspaceMode();
        let effectiveMode: 'single' | 'multi';
        let detectedRepos: DetectedRepo[] = [];
        if (overrideMode === 'multi') {
            effectiveMode = 'multi';
            // Override forces multi: still run the detector to populate `detectedRepos`.
            try { detectedRepos = detectMultiRepoMode(this.workspaceRoot).repos; }
            catch (err: any) { this.log(`[WorkspaceOrchestrator] detector failed under override (${err?.message ?? err})`); }
        } else if (overrideMode === 'single') {
            effectiveMode = 'single';
        } else {
            // 'auto' — let the detector decide.
            try {
                const det = detectMultiRepoMode(this.workspaceRoot);
                detectedRepos = det.repos;
                effectiveMode = det.isMultiRepo ? 'multi' : 'single';
            } catch (err: any) {
                this.log(`[WorkspaceOrchestrator] auto-detection failed (${err?.message ?? err}); falling back to single`);
                effectiveMode = 'single';
            }
        }

        // Step 4 — dispatch.
        let resultRows: ReadonlyArray<{ repoId: string; rootPath: string; name: string }> = [];
        if (effectiveMode === 'multi' && detectedRepos.length > 0) {
            resultRows = await this.initializeMulti(
                aggregator,
                detectedRepos,
                repoInitDurationsMs,
                failures,
            );
        } else {
            resultRows = this.initializeSingle(
                aggregator,
                repoInitDurationsMs,
                failures,
            );
        }

        const aggregatorSizeBytes = safeSizeOf(aggregator.getDbPath());
        WorkspaceOrchestrator.currentInstance = this;
        return {
            mode: effectiveMode,
            repoCount: resultRows.length,
            repoInitDurationsMs,
            aggregatorSizeBytes,
            totalDurationMs: Date.now() - t0,
            failures,
            detectedRepos: resultRows,
        };
    }

    // ─── Single-repo path (Phase A, unchanged behaviour) ─────────────────

    private initializeSingle(
        aggregator: IAggregatorStore,
        repoInitDurationsMs: Record<string, number>,
        failures: Array<{ repoId: string; error: string }>,
    ): ReadonlyArray<{ repoId: string; rootPath: string; name: string }> {
        const tRepo = Date.now();
        const realpath = safeRealpath(this.workspaceRoot);
        const repoId = computeRepoId(realpath);
        const repoRow: RepoRow = {
            repoId,
            name: path.basename(this.workspaceRoot),
            rootPath: '',
            realpathHash: repoId,
            technology: null,
            status: 'ready',
            lastInitAt: Date.now(),
            errorMessage: null,
            fallbackStatePath: null,
            stateDbSchemaVersion: 9,
            summarySchemaVersion: MONOREPO_SCHEMA_VERSION,
            diff: null,
        };
        try {
            aggregator.upsertRepo(repoRow);
            aggregator.save();
        } catch (err: any) {
            this.log(`[WorkspaceOrchestrator] aggregator upsertRepo failed: ${err?.message ?? err}`);
            failures.push({ repoId, error: String(err?.message ?? err) });
        }
        repoInitDurationsMs[repoId] = Date.now() - tRepo;

        // Lazy-open the per-repo store — Phase A: the SnapshotStore at
        // workspaceRoot is the only per-repo store.
        const repoStore: IRepoStore = this.registry.getRepoStore(this.workspaceRoot);
        void repoStore;

        // Phase A keeps `microservice:workspace` graph empty in the
        // aggregator — the existing `microserviceGraphBuilder` writes the
        // full L1 into the per-repo `state.db` for single-repo workspaces.
        // Phase B writes the SKELETAL aggregator graph only in multi-repo.
        return [{ repoId, rootPath: '', name: repoRow.name }];
    }

    // ─── Multi-repo path (Phase B) ───────────────────────────────────────

    private async initializeMulti(
        aggregator: IAggregatorStore,
        detected: ReadonlyArray<DetectedRepo>,
        repoInitDurationsMs: Record<string, number>,
        failures: Array<{ repoId: string; error: string }>,
    ): Promise<ReadonlyArray<{ repoId: string; rootPath: string; name: string }>> {
        const resultRows: Array<{ repoId: string; rootPath: string; name: string }> = [];

        // First pass — upsert all repos as `parsing` so the skeletal L1
        // shows them as "still indexing" while we work through them. This
        // lets the browser render the topology immediately.
        const repoRows: Map<string, RepoRow> = new Map();
        for (const r of detected) {
            const repoAbs = path.join(this.workspaceRoot, r.rootPath);
            const realpath = safeRealpath(repoAbs);
            const repoId = computeRepoId(realpath);
            const row: RepoRow = {
                repoId,
                name: r.name,
                rootPath: r.rootPath,
                realpathHash: repoId,
                technology: inferTechnology(r),
                status: 'parsing',
                lastInitAt: Date.now(),
                errorMessage: null,
                fallbackStatePath: null,
                stateDbSchemaVersion: 9,
                summarySchemaVersion: MONOREPO_SCHEMA_VERSION,
                diff: null,
            };
            try {
                aggregator.upsertRepo(row);
                repoRows.set(repoId, row);
            } catch (err: any) {
                this.log(`[WorkspaceOrchestrator] failed to upsert ${r.rootPath} (${err?.message ?? err})`);
                failures.push({ repoId, error: String(err?.message ?? err) });
            }
        }

        // Write the initial skeletal L1 + save aggregator so any concurrent
        // reader (e.g. browser tab opened mid-init) sees the topology.
        this.writeSkeletalL1(aggregator);
        try { aggregator.save(); } catch (err: any) {
            this.log(`[WorkspaceOrchestrator] aggregator save (initial skeletal) failed: ${err?.message ?? err}`);
        }

        // Second pass — per-repo init via RepoDispatcher (Phase D Tier-1).
        // Concurrency is capped at `this.concurrencyLimit` (default 1 =
        // serial — preserves Phase B behaviour; bumped to ~8 when the
        // extension opts into Tier-1 via `codeatlas.cascadeParallelism`).
        // Failures land in result.failures; never abort the batch.
        const rowsForDispatch: RepoRow[] = Array.from(repoRows.values());
        const dispatcher = new RepoDispatcher(this.registry, this.log);
        const useTier2 = !!(this.tier2Pool && this.tier2PostInit);
        if (useTier2) {
            this.log(`[WorkspaceOrchestrator] dispatcher mode=worker-threads (Tier-2, ${rowsForDispatch.length} repos)`);
        }
        const dispatch = await dispatcher.dispatch(
            rowsForDispatch,
            this.workspaceRoot,
            this.repoOrchestratorRunner,
            {
                concurrencyLimit: this.concurrencyLimit,
                mode: useTier2 ? 'worker-threads' : 'in-process',
                workerPool: this.tier2Pool,
                tier2PostInit: this.tier2PostInit,
                onRepoFinish: (repoId, _rootPath, ms) => {
                    const row = repoRows.get(repoId);
                    if (!row) return;
                    aggregator.upsertRepo({ ...row, status: 'ready', lastInitAt: Date.now() });
                    repoInitDurationsMs[repoId] = ms;
                    // Refresh skeletal L1 + save so concurrent readers
                    // (browser tab opened mid-init, second VS Code window
                    // on the same workspace) see live progress.
                    this.writeSkeletalL1(aggregator);
                    try { aggregator.save(); } catch (err: any) {
                        this.log(`[WorkspaceOrchestrator] aggregator save (per-repo) failed: ${err?.message ?? err}`);
                    }
                },
                onRepoFailed: (repoId, _rootPath, err) => {
                    const row = repoRows.get(repoId);
                    if (!row) return;
                    aggregator.upsertRepo({ ...row, status: 'failed', errorMessage: err.message, lastInitAt: Date.now() });
                    this.writeSkeletalL1(aggregator);
                    try { aggregator.save(); } catch { /* logged inside dispatcher */ }
                },
            },
        );

        // Surface per-repo durations + failures to caller's accumulators.
        for (const [repoId, ms] of Object.entries(dispatch.perRepoDurationsMs)) {
            repoInitDurationsMs[repoId] = ms;
        }
        for (const f of dispatch.failures) {
            failures.push({ repoId: f.repoId, error: f.error });
        }
        for (const row of repoRows.values()) {
            resultRows.push({ repoId: row.repoId, rootPath: row.rootPath, name: row.name });
        }

        try { aggregator.save(); } catch (err: any) {
            this.log(`[WorkspaceOrchestrator] aggregator save (final) failed: ${err?.message ?? err}`);
        }
        return resultRows;
    }

    /**
     * ADR-034 Phase E (#790 — Phase E: failure isolation UX + multi-repo cascade tests (ADR-034)) — re-run ONE repo's init in isolation.
     * Sibling repos and the aggregator's cross-repo tables are untouched
     * except for the per-repo row's status transitions and the analyzers'
     * sparse updates after the new summary lands.
     *
     * Idempotent semantics:
     *   - status='parsing' → no-op (already in flight); returns the current
     *     status without re-dispatching
     *   - status='ready' → force re-run (user clicked "Retry" / re-init)
     *   - status='failed' / 'stale' → re-run (the common case)
     *   - repo dir missing → drop the row + return 'deleted'
     *
     * The retry is dispatched through the same `repoOrchestratorRunner`
     * the initial init used, so the per-repo store + SyncOrchestrator are
     * (re)constructed identically. The caller (extension.ts) receives the
     * final status via the return value AND via the broadcast skeletal-L1
     * refresh that fires inside this method.
     */
    async retryRepo(repoId: string): Promise<{ status: 'ready' | 'failed' | 'parsing' | 'deleted'; durationMs: number; error?: string }> {
        const t0 = Date.now();
        const aggregator = this.registry.getAggregatorStore(this.workspaceRoot);
        // Lazy-init the aggregator if no prior initialize() ran on this
        // orchestrator (e.g. retry called from a fresh process restart,
        // or a test constructing a second orchestrator).
        if ('init' in aggregator && typeof (aggregator as any).init === 'function') {
            try { await (aggregator as any).init(); } catch { /* idempotent re-open */ }
        }
        const row = aggregator.getRepo(repoId);
        if (!row) {
            return { status: 'deleted', durationMs: Date.now() - t0, error: `repo ${repoId} not in registry` };
        }

        // Repo dir vanished — drop the row + return 'deleted' so the UI
        // removes the card.
        const repoAbs = row.rootPath ? path.join(this.workspaceRoot, row.rootPath) : this.workspaceRoot;
        if (!fs.existsSync(repoAbs)) {
            aggregator.deleteRepo(repoId);
            this.writeSkeletalL1(aggregator);
            try { aggregator.save(); } catch (err: any) {
                this.log(`[WorkspaceOrchestrator] retryRepo save-after-delete failed: ${err?.message ?? err}`);
            }
            return { status: 'deleted', durationMs: Date.now() - t0 };
        }

        if (row.status === 'parsing') {
            // In-flight — no-op. Caller polls the next workspaceInfo
            // broadcast to see the resolution.
            return { status: 'parsing', durationMs: Date.now() - t0 };
        }

        // Mark parsing + broadcast so the UI shows the spinner immediately.
        aggregator.upsertRepo({ ...row, status: 'parsing', errorMessage: null, lastInitAt: Date.now() });
        this.writeSkeletalL1(aggregator);
        try { aggregator.save(); } catch (err: any) {
            this.log(`[WorkspaceOrchestrator] retryRepo save-after-parsing failed: ${err?.message ?? err}`);
        }

        try {
            await this.repoOrchestratorRunner({
                workspaceRoot: this.workspaceRoot,
                repoRoot: repoAbs,
                repoId,
                registry: this.registry,
                log: this.log,
            });
            aggregator.upsertRepo({ ...row, status: 'ready', errorMessage: null, lastInitAt: Date.now() });
            this.writeSkeletalL1(aggregator);
            aggregator.save();
            return { status: 'ready', durationMs: Date.now() - t0 };
        } catch (err: any) {
            const msg = String(err?.message ?? err);
            this.log(`[WorkspaceOrchestrator] retryRepo ${repoId} failed: ${msg}`);
            aggregator.upsertRepo({ ...row, status: 'failed', errorMessage: msg, lastInitAt: Date.now() });
            this.writeSkeletalL1(aggregator);
            try { aggregator.save(); } catch { /* logged earlier */ }
            return { status: 'failed', durationMs: Date.now() - t0, error: msg };
        }
    }

    private writeSkeletalL1(aggregator: IAggregatorStore): void {
        try {
            const repos = aggregator.listRepos();
            // BUG-L1-CROSSREPO-EDGE: pass the aggregator's cross-repo HTTP edges so
            // the workspace L1 draws consumer->provider links. Early calls (before the
            // cross-repo second pass) see [] and draw nodes only; the final call after
            // the second pass carries the detected edges.
            let httpEdges: ReadonlyArray<any> = [];
            try { httpEdges = aggregator.listCrossRepoHttpEdges?.() ?? []; } catch { /* skip */ }
            const graph = buildSkeletalL1(repos, this.workspaceRoot, httpEdges);
            aggregator.updateWorkingGraph(graph.graphId, graph);
        } catch (err: any) {
            this.log(`[WorkspaceOrchestrator] writeSkeletalL1 failed: ${err?.message ?? err}`);
        }
    }

    // ─── Reconcile / resync — Phase A stubs (B-aware where it matters) ──

    async reconcile(): Promise<void> {
        if (!fs.existsSync(this.workspaceRoot)) {
            this.log(`[WorkspaceOrchestrator] workspace root ${this.workspaceRoot} no longer exists — closing all`);
            await this.registry.closeAll();
            WorkspaceOrchestrator.currentInstance = undefined;
            return;
        }
        const aggregator = this.registry.getAggregatorStore(this.workspaceRoot);
        const repos = aggregator.listRepos();
        for (const r of repos) {
            // Drop rows whose dir was deleted; refresh the rest.
            const repoAbs = r.rootPath ? path.join(this.workspaceRoot, r.rootPath) : this.workspaceRoot;
            if (!fs.existsSync(repoAbs)) {
                aggregator.deleteRepo(r.repoId);
                continue;
            }
            aggregator.upsertRepo({ ...r, lastInitAt: Date.now(), status: 'ready' });
        }
        // Refresh skeletal L1 to reflect any drops.
        if (repos.length > 1) this.writeSkeletalL1(aggregator);
        aggregator.save();
    }

    /**
     * ADR-034 Phase J (#795 — Phase J: Cross-repo diff propagation + workspace re-sync (ADR-034)) — workspace-level resync. Fans out per-repo
     * resyncs, then atomically rotates the aggregator's baseline if ALL
     * per-repo resyncs succeed. If any per-repo throws, the aggregator
     * is NOT rotated; the user's pending diff signals stay intact.
     *
     * Concurrency: per-repo resyncs run sequentially through the injected
     * runner. (Phase D Tier-2 worker-pool integration is the upgrade
     * path; Tier-1 sequential is fine for typical workspaces.)
     */
    async resync(): Promise<WorkspaceResyncResult> {
        const t0 = Date.now();
        const aggregator = this.registry.getAggregatorStore(this.workspaceRoot);
        const perRepoResyncs: Record<string, 'ok' | 'failed'> = {};
        const failures: Array<{ repoId: string; error: string }> = [];

        const repos = aggregator.listRepos();
        for (const r of repos) {
            try {
                const repoAbs = r.rootPath ? path.join(this.workspaceRoot, r.rootPath) : this.workspaceRoot;
                await this.repoOrchestratorRunner({
                    workspaceRoot: this.workspaceRoot,
                    repoRoot: repoAbs,
                    repoId: r.repoId,
                    registry: this.registry,
                    log: this.log,
                });
                perRepoResyncs[r.repoId] = 'ok';
            } catch (err: any) {
                const msg = String(err?.message ?? err);
                this.log(`[WorkspaceOrchestrator] resync ${r.rootPath} failed: ${msg}`);
                perRepoResyncs[r.repoId] = 'failed';
                failures.push({ repoId: r.repoId, error: msg });
            }
        }

        // Only rotate baseline if every per-repo succeeded — preserves the
        // ADR's atomicity guarantee.
        let aggregatorRotated = false;
        if (failures.length === 0) {
            try {
                aggregator.rotateBaseline();
                aggregatorRotated = true;
            } catch (err: any) {
                this.log(`[WorkspaceOrchestrator] aggregator.rotateBaseline failed: ${err?.message ?? err}`);
                failures.push({ repoId: '<aggregator>', error: String(err?.message ?? err) });
            }
        } else {
            this.log(`[WorkspaceOrchestrator] resync aborted aggregator rotation — ${failures.length} repo(s) failed`);
        }

        // Refresh skeletal L1 + save so the browser sees the post-resync state.
        this.writeSkeletalL1(aggregator);
        try { aggregator.save(); } catch (err: any) {
            this.log(`[WorkspaceOrchestrator] resync save failed: ${err?.message ?? err}`);
        }

        return {
            perRepoResyncs,
            aggregatorRotated,
            totalDurationMs: Date.now() - t0,
            failures,
        };
    }
}

export interface WorkspaceResyncResult {
    perRepoResyncs: Record<string, 'ok' | 'failed'>;
    aggregatorRotated: boolean;
    totalDurationMs: number;
    failures: ReadonlyArray<{ repoId: string; error: string }>;
}

// ─── helpers ────────────────────────────────────────────────────────────

function computeRepoId(realpath: string): string {
    let key = realpath.replace(/\\/g, '/');
    if (process.platform === 'win32') key = key.toLowerCase();
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function safeRealpath(p: string): string {
    try { return fs.realpathSync(p); } catch { return p; }
}

function safeSizeOf(p: string): number {
    try { return fs.statSync(p).size; } catch { return 0; }
}

/**
 * Coarse technology bucket from detector signals. The per-repo init can
 * later overwrite this with a more precise tag once the parser has run.
 */
function inferTechnology(_r: DetectedRepo): string | null {
    // Phase B doesn't have the file extensions yet — Phase C populates
    // from the repo summary. Returning null is fine; the L1 renderer
    // already falls back to a neutral badge.
    return null;
}
