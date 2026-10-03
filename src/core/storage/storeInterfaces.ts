/**
 * ADR-034 Phase A — interface extraction (#786 — Phase A: per-repo DB foundation (ADR-034)).
 *
 * Promotes the lifecycle methods every persistent store shares (today
 * `SnapshotStore`, in Phase A also the new `AggregatorStore`) into a small
 * common contract, plus an `IRepoStore` view of the existing SnapshotStore
 * surface that downstream chokepoints (`storeRouter`, `WorkspaceOrchestrator`)
 * will hold polymorphically.
 *
 * The interfaces are deliberately minimal in Phase A: only the methods that
 * Phase A's chokepoint actually needs to dispatch through. The remaining ~60
 * SnapshotStore methods stay as class-specific surface — moving them all into
 * the interface would force AggregatorStore (which doesn't need them) to
 * either implement no-ops or throw, breaking LSP.
 *
 * Phase B (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)) extends `IRepoStore` with the per-repo write methods that
 * become polymorphic when multi-repo writes activate. Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) adds the
 * cross-repo registry methods to `IAggregatorStore`.
 */
import type {
    Snapshot, FileRecord, ApiRecord, DiagramGraph, WorkspaceState,
} from '../graph/graphTypes';

/**
 * Lifecycle surface shared by every persistent store backed by SQLite.
 * Phase A — `SnapshotStore` (today) and `AggregatorStore` (new) both implement
 * this.
 */
export interface IPersistentStore {
    /** Persist the in-memory state to disk (atomic via .tmp + rename). */
    save(): void;
    /** Close the underlying DB connection. Subsequent operations must re-init. */
    close(): void;
    /** Absolute path of the backing DB file on disk. */
    getDbPath(): string;
    /** Numeric schema version the store was built against. Drives migrations. */
    getSchemaVersion(): number;
}

/**
 * Per-repo store contract — what the chokepoint (`resolveStoreFor`) returns
 * for repo-scope graphIds (`file:*`, `flow:*`, `sequence:*`, `feature:<svc>`,
 * `api-list:<cluster>`). Today implemented only by `SnapshotStore`; Phase B
 * (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)) adds an in-memory fake for the multi-repo test harness.
 */
export interface IRepoStore extends IPersistentStore {
    // ─── State accessors ───────────────────────────────────────────────────
    getState(): WorkspaceState;
    getWorking(): Snapshot;
    getBaseline(): Snapshot;

    // ─── Lifecycle ─────────────────────────────────────────────────────────
    load(): Promise<WorkspaceState>;
    refresh(): void;

    // ─── Per-snapshot mutations the chokepoint dispatches ─────────────────
    updateWorkingFile(filePath: string, record: FileRecord): void;
    updateWorkingApi(apiId: string, record: ApiRecord): void;
    updateWorkingGraph(graphId: string, graph: DiagramGraph): void;
    removeWorkingFile(filePath: string): void;
    removeWorkingApi(apiId: string): void;
    removeWorkingGraph(graphId: string): void;
    updateBaselineGraph(graphId: string, graph: DiagramGraph): void;
}

/** Single row of the `repos` registry inside `monorepo.db`. */
export interface RepoRow {
    /** Stable hash of realpath; primary key. */
    repoId: string;
    /** Display name — typically the basename of `rootPath`. */
    name: string;
    /** Workspace-relative path (forward-slashed); `''` for single-repo. */
    rootPath: string;
    /** SHA-256 of the resolved realpath; survives symlinks. */
    realpathHash: string;
    /** Primary technology bucket — `nodejs` / `python` / `go` / etc. or null. */
    technology: string | null;
    /** Lifecycle status — drives the Knowledge Map progress UI in Phase B. */
    status: 'parsing' | 'ready' | 'failed' | 'stale';
    /** Unix ms when the repo last completed initialization. */
    lastInitAt: number;
    /** Last failure message — surfaced in the per-repo failure card (#790 — Phase E: failure isolation UX + multi-repo cascade tests (ADR-034)). */
    errorMessage: string | null;
    /** Local-tmp fallback path when the workspace root is read-only / NFS. */
    fallbackStatePath: string | null;
    /** Snapshot-time `state.db` schema version this repo was indexed at. */
    stateDbSchemaVersion: number;
    /** Snapshot-time summary schema version (Phase C uplifts). */
    summarySchemaVersion: number;
    /** Diff vs baseline workspace (Phase J populates; null in Phase A). */
    diff: 'added' | 'modified' | 'deleted' | 'unchanged' | null;
}

/** Phase A: marker rows for cross-repo tables. Populated in C/J. */
export interface SharedExternalRow {
    providerId: string;
    name: string;
    category: string;
    consumers: ReadonlyArray<string>;
    diff: string | null;
}
export interface SharedSchemaRow {
    engine: string;
    tableName: string;
    consumers: ReadonlyArray<string>;
    diff: string | null;
}
export interface CrossRepoHttpEdgeRow {
    sourceRepo: string;
    targetRepo: string;
    method: string;
    route: string;
    diff: string | null;
}

// ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — `RepoSummary` moved to its dedicated module.
// Re-export so callers that imported from here keep working. Phase A's
// inline minimal shape is superseded by the Phase C richer shape.
import type { RepoSummary as _RepoSummary } from '../sync/repoSummary';
export type RepoSummary = _RepoSummary;

/**
 * Aggregator store contract — backs `monorepo.db`. Phase A ships the
 * registry + workspace-mode + workspace-scope graphs. Cross-repo readers
 * (`listSharedExternals`, `listSharedSchemas`, `listCrossRepoHttpEdges`,
 * `getRepoSummary`) are stub-returning empties in Phase A and populated in
 * Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) and Phase J (#795).
 */
export interface IAggregatorStore extends IPersistentStore {
    // ─── Repo registry ────────────────────────────────────────────────────
    listRepos(): ReadonlyArray<RepoRow>;
    getRepo(repoId: string): RepoRow | undefined;
    upsertRepo(row: RepoRow): void;
    deleteRepo(repoId: string): void;

    // ─── Workspace mode override (.codeatlas/workspace-mode.json) ────────
    getWorkspaceMode(): 'auto' | 'single' | 'multi';
    setWorkspaceMode(mode: 'auto' | 'single' | 'multi'): void;

    // ─── Workspace-scope graphs ──────────────────────────────────────────
    getWorkingGraph(graphId: string): any | undefined;
    updateWorkingGraph(graphId: string, graph: any): void;
    removeWorkingGraph(graphId: string): void;
    iterateWorkingGraphs(cb: (graphId: string, graph: any) => void): void;

    // ─── Cross-repo readers (Phase A: empty stubs) ────────────────────────
    listSharedExternals(): ReadonlyArray<SharedExternalRow>;
    listSharedSchemas(): ReadonlyArray<SharedSchemaRow>;
    listCrossRepoHttpEdges(): ReadonlyArray<CrossRepoHttpEdgeRow>;
    getRepoSummary(repoId: string): RepoSummary | undefined;
    setRepoSummary(repoId: string, summary: RepoSummary): void;

    // ─── Cross-repo writes (Phase C #788) ─────────────────────────────────
    /** Upsert / merge shared external row by providerId. */
    upsertSharedExternal(row: SharedExternalRow): void;
    /** Remove a row by providerId. */
    removeSharedExternal(providerId: string): void;
    /** Upsert / merge shared schema row by (engine, tableName). */
    upsertSharedSchema(row: SharedSchemaRow): void;
    /** Remove a row by (engine, tableName). */
    removeSharedSchema(engine: string, tableName: string): void;
    /** Upsert cross-repo HTTP edge by (source, target, method, route). */
    upsertCrossRepoHttpEdge(row: CrossRepoHttpEdgeRow): void;
    /** Remove all edges sourced from a given repo. */
    removeCrossRepoHttpEdgesFromSource(sourceRepo: string): void;

    /**
     * ADR-034 Phase C orchestration entry-point. Persists `summary` to
     * `repo_summaries`, then runs every registered `CrossRepoAnalyzer`
     * with `(repoId, summary, priorSummary, this)`. Idempotent — calling
     * twice with the same summary is a no-op (analyzers' sparse-update
     * logic short-circuits).
     */
    applySummary(repoId: string, summary: RepoSummary): void;

    // ─── ADR-034 Phase G (#792 — Phase G: AI Code Review per repo + workspace guidelines (ADR-034)) — workspace AI review guidelines ─────────
    /** Empty-string text + 0 timestamp when never written. */
    getWorkspaceReviewGuidelines(): { text: string; hash: string; updatedAt: number };
    /** Persists text + SHA-256 hash + timestamp. Empty text clears the rule. */
    setWorkspaceReviewGuidelines(text: string): { text: string; hash: string; updatedAt: number };

    // ─── ADR-034 Phase G (#792 — Phase G: AI Code Review per repo + workspace guidelines (ADR-034)) — workspace-scope AI review findings ─────
    listWorkspaceFindings(): ReadonlyArray<{
        findingId: string;
        graphId: string;
        finding: any;
        status: string;
        createdAt: number;
        updatedAt: number;
    }>;
    upsertWorkspaceFinding(row: {
        findingId: string;
        graphId: string;
        finding: any;
        status: string;
        createdAt?: number;
    }): void;
    removeWorkspaceFinding(findingId: string): void;

    // ─── ADR-034 Phase J (#795 — Phase J: Cross-repo diff propagation + workspace re-sync (ADR-034)) — baseline-mirror reads + rotation ──────
    /** Baseline mirror — last-rotated snapshot of shared_externals. */
    listBaselineSharedExternals(): ReadonlyArray<SharedExternalRow>;
    /** Baseline mirror — last-rotated snapshot of shared_schemas. */
    listBaselineSharedSchemas(): ReadonlyArray<SharedSchemaRow>;
    /** Baseline mirror — last-rotated snapshot of cross_repo_http_edges. */
    listBaselineCrossRepoHttpEdges(): ReadonlyArray<CrossRepoHttpEdgeRow>;
    /** Baseline mirror — last-rotated repo_summary for a single repo. */
    getBaselineRepoSummary(repoId: string): RepoSummary | undefined;
    /**
     * Atomically rotate working → baseline. Truncates each baseline
     * table then INSERTs from its working counterpart in a single SQL
     * transaction. Caller (WorkspaceOrchestrator.resync) wraps this
     * with the per-repo resyncs so the whole workspace baseline rotates
     * as one logical unit.
     */
    rotateBaseline(): void;

    /**
     * Compare every working cross-repo row against its baseline mirror
     * and set the `.diff` field accordingly:
     *   - added     — row exists in working only
     *   - modified  — row exists in both but `consumers_json` differs
     *   - deleted   — row exists in baseline only (placeholder row
     *                 written into working with `consumers=[]`, diff='deleted')
     *   - unchanged — same consumers set on both sides
     *
     * Called by `applySummary` after the analyzer chain so diff metadata
     * is always fresh. Idempotent — re-running with no changes leaves the
     * tables identical.
     */
    recomputeDiffs(): void;

    // ─── ADR-034 Phase I (#794 — Phase I: API Testing per repo + cross-repo chain runner (ADR-034)) — per-repo workspace settings ─────────────
    /** Returns the repo's dev base URL or empty string when unset. */
    getDevBaseUrl(repoId: string): string;
    /** Upserts the dev base URL. Empty string clears the setting. */
    setDevBaseUrl(repoId: string, url: string): void;

    // ─── ADR-034 Phase I (#794 — Phase I: API Testing per repo + cross-repo chain runner (ADR-034)) — saved API-testing chains ────────────────
    listApiTestingChains(): ReadonlyArray<SavedApiTestingChain>;
    getApiTestingChain(chainId: string): SavedApiTestingChain | undefined;
    saveApiTestingChain(chain: SavedApiTestingChain): void;
    deleteApiTestingChain(chainId: string): void;
}

/**
 * Persisted chain — minimal shape so the aggregator schema doesn't
 * couple to the runChain step type. `stepsJson` is opaque; callers
 * parse/validate against the chain runner's own schema.
 */
export interface SavedApiTestingChain {
    chainId: string;
    name: string;
    stepsJson: string;
    envText: string;
    updatedAt: number;
}
