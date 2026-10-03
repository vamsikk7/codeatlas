import * as fs from 'fs';
import * as path from 'path';
import type {
    WorkspaceState, Snapshot, FileRecord, ApiRecord, DiagramGraph, Comment,
    SerializedCallGraph, FeatureCluster, ServiceRecord, HealthReport,
    AiReviewFinding, AiReviewStatus, ScreenRecord, L2bScreenItem,
    DomainCluster,
} from '../graph/graphTypes';
import { sanitiseGuidelines } from './reviewGuidelinesStore';
import { AiReviewFindingsStore, type FindingFilter, type FindingCounts } from './aiReviewFindingsStore';
import * as crypto from 'crypto';
import { SqliteStore } from './sqliteStore';
import { GitRefProvider } from './gitRefProvider';
import { LazyGraphMap, makeLazyGraphsProxy, getLazyGraphMap } from './lazyGraphMap';
import type { IRepoStore } from './storeInterfaces';
import { parseGraphId } from '../graph/graphIdBuilder';

const STORAGE_DIR = '.codeatlas';
const LEGACY_STATE_FILE = 'state.json';

/**
 * #606 / #606-SYNTHETIC — per-entry-point review cursor. One row per
 * `ApiRecord` that has been LLM-reviewed; the cursor records the handler
 * digest, the guidelines hash, and the baseline ref it was reviewed
 * against. Next review compares the current digest/hash against the
 * stored values to decide whether to re-invoke the LLM (delta computation
 * lives in `src/core/llm/reviewDelta.ts`).
 *
 * `apiId` is the primary key — globally unique per record because the
 * apiId format already includes file path + symbol for synthetic entries.
 * `entryPointId` (`method:route`) is denormalised so we can clean up
 * findings (which are keyed by entryPointId) when a cursor's api vanishes
 * from the apiIndex without needing a back-reference lookup.
 */
export interface AiReviewEntryCursor {
    apiId: string;
    entryPointId: string;
    handlerHash: string;
    guidelinesHash: string;
    baselineKind: string;
    baselineRef: string;
    reviewedAt: number;
}

/**
 * INVARIANT: every persisted snapshot row carries a numeric `schema_version`.
 * The DB-level `PRAGMA user_version` (in SqliteStore) gates incompatible
 * shape changes; this constant is stamped onto each snapshot row so an
 * older extension reading a newer DB can still fast-fail before processing
 * the rows. See ADR-015.
 */
const CURRENT_SCHEMA_VERSION = 3;

/** Stable kinds for the two snapshots SnapshotStore manages. */
const SNAPSHOT_KINDS = ['baseline', 'working'] as const;
type SnapshotKind = typeof SNAPSHOT_KINDS[number];

/** Issue 167: Recursively strip __proto__, constructor, prototype keys to prevent pollution */
function stripProtoDeep(obj: any): void {
    if (obj === null || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(stripProtoDeep); return; }
    delete obj.__proto__;
    delete obj.constructor;
    delete obj.prototype;
    for (const val of Object.values(obj)) {
        if (val && typeof val === 'object') stripProtoDeep(val);
    }
}

/**
 * Store and retrieve workspace snapshots (baseline + working) from the
 * consolidated SQLite backend at `.codeatlas/state.db`.
 *
 * The in-memory `WorkspaceState` shape is unchanged — consumers still
 * mutate `getWorking().files[...]` etc. directly. Only the persistence
 * layer (`load()` / `save()`) was rewritten in #349 to use SQLite tables
 * with FK + ON DELETE CASCADE so that `clear()` is one DB call.
 *
 * The legacy `.codeatlas/state.json` is auto-imported on first load if
 * present; it is left on disk (the user can delete it after verifying)
 * because deleting committed/tracked files is not a SnapshotStore decision.
 */
export class SnapshotStore implements IRepoStore {
    private workspaceRoot: string;
    private storagePath: string;
    private state: WorkspaceState;
    private log: (msg: string) => void = () => { /* noop */ };
    private sqlite: SqliteStore;
    private refProvider: GitRefProvider;
    private initialized: boolean = false;
    private graphMaps: Record<SnapshotKind, LazyGraphMap | undefined> = { baseline: undefined, working: undefined };

    /**
     * @param opts.storageDirName overrides `.codeatlas` so the standalone npm
     *     package (`@codeatlas/mcp`) can write to `.codeatlas-sa` and avoid
     *     SQLite WAL lock contention when the extension is also running on the
     *     same workspace. Defaults to `.codeatlas` when omitted.
     */
    constructor(workspaceRoot: string, opts: { inMemoryOnly?: boolean; storageDirName?: string } = {}) {
        const storageDirName = opts.storageDirName ?? STORAGE_DIR;
        this.workspaceRoot = workspaceRoot;
        this.storagePath = path.join(workspaceRoot, storageDirName);
        this.refProvider = new GitRefProvider(workspaceRoot);
        this.sqlite = new SqliteStore(workspaceRoot, this.refProvider, opts.inMemoryOnly ?? false, storageDirName);
        this.state = this.createDefaultState();
    }

    private createDefaultState(): WorkspaceState {
        // graphs is a LazyGraphMap-backed Proxy so the in-memory snapshot
        // never holds the full graph corpus. apiIndex stays as a plain
        // Record — its rows are ~500 bytes each so even 50k APIs ≈ 25MB
        // resident, dwarfed by the graph savings #355 already shipped.
        // Lazy apiIndex was prototyped but the `Object.values(proxy)` flow
        // through `applyMountPrefixes` didn't surface dirty entries
        // reliably across the test fixture set; reverted in favor of
        // measured stability. Telemetry can drive a future revisit.
        const baselineGraphs = new LazyGraphMap(this.sqlite, 'baseline');
        const workingGraphs = new LazyGraphMap(this.sqlite, 'working');
        this.graphMaps.baseline = baselineGraphs;
        this.graphMaps.working = workingGraphs;
        return {
            version: 1,
            schema_version: CURRENT_SCHEMA_VERSION,
            workspaceRoot: this.workspaceRoot,
            baseline: { files: {}, apiIndex: {}, graphs: makeLazyGraphsProxy(baselineGraphs) },
            working: { files: {}, apiIndex: {}, graphs: makeLazyGraphsProxy(workingGraphs) },
            comments: [],
            settings: { autoUpdate: true },
        };
    }

    setLogger(logger: (msg: string) => void): void {
        this.log = logger;
        this.sqlite.setLogger(logger);
    }

    /** Underlying SQLite store — exposed so the orchestrator can issue clear(). */
    getSqliteStore(): SqliteStore {
        return this.sqlite;
    }

    /** MCP Tier 2: workspace root for coverage / saved-query / rules lookups. */
    getWorkspaceRoot(): string {
        return this.workspaceRoot;
    }

    /** IPersistentStore — close the SQLite connection. ADR-034 Phase A. */
    close(): void {
        this.sqlite.close();
        this.initialized = false;
    }

    /** IPersistentStore — absolute path of the backing state.db file. ADR-034 Phase A. */
    getDbPath(): string {
        return path.join(this.storagePath, 'state.db');
    }

    /** IPersistentStore — schema version stamped on persisted rows. ADR-034 Phase A. */
    getSchemaVersion(): number {
        return CURRENT_SCHEMA_VERSION;
    }

    /**
     * Open the DB (idempotent), import legacy state.json if present, and
     * hydrate the in-memory `WorkspaceState` from the tables. Returns the
     * hydrated state for callers that want it directly.
     *
     * Issue 405 (root cause, 2026-05-13): a guard alone is insufficient —
     * `activate()` calls `load()` twice concurrently (`void loadStateAfterAuth()`
     * fire-and-forget AND a later `await snapshotStore.load()` in the same
     * function). Both calls evaluate `if (!this.initialized)` BEFORE the
     * await, both pass, both await the same `sqlite.init()` promise, and
     * after it resolves BOTH continue past the guard and BOTH call
     * `refresh()`. The second `refresh()` runs while `clearAllFiles` from
     * AutoInit has emptied the DB → it copies the empty DB back over the
     * in-memory `apiIndex` that init had just populated.
     *
     * Fix: cache the in-flight `load()` promise so concurrent callers share
     * a single execution. The second caller awaits the same promise and
     * never enters the hydration body. Idiomatic single-flight pattern.
     *
     * Callers that genuinely need a DB→memory re-read (e.g. mcp-server) call
     * `refresh()` directly.
     */
    private loadPromise: Promise<WorkspaceState> | null = null;
    // #833 — true once load() has completed at least once; unlike
    // `initialized` it survives close() so `reopenIfClosed` can tell an
    // evicted store apart from a never-loaded in-memory one.
    private everLoaded = false;
    async load(): Promise<WorkspaceState> {
        // Issue #790 #3 regression — registry LRU eviction calls `store.close()`
        // which sets `this.sqlite.db = null` but leaves `this.initialized = true`
        // (because the in-memory snapshot state is still valid — we don't want
        // to wipe `dirty` writes on eviction). So a subsequent `load()` used
        // to no-op and the next sqlite-backed read (LazyGraphMap.get) would
        // hit the `isOpen()` guard and return undefined. Re-init sqlite when
        // it's been externally closed so callers that explicitly `load()`
        // before reading can rely on the store being usable.
        if (this.initialized && !this.sqlite.isOpen()) {
            this.log(`[SnapshotStore] re-init after external close: ${this.storagePath}`);
            await this.sqlite.init();
            this.refresh();
            this.recordDiskSync();
            return this.state;
        }
        if (this.initialized) return this.state;
        if (this.loadPromise) return this.loadPromise;
        this.loadPromise = (async () => {
            await this.sqlite.init();
            this.initialized = true;
            this.everLoaded = true; // #833 — survives close() for reopenIfClosed gating
            this.maybeImportLegacyJson();
            this.refresh();
            this.recordDiskSync();
            return this.state;
        })();
        try {
            return await this.loadPromise;
        } finally {
            // Clear the cached promise once it resolves — future load()
            // calls hit the `initialized` short-circuit above and return
            // synchronously.
            this.loadPromise = null;
        }
    }

    /**
     * #833 (2026-06-11) — re-open the sqlite handle after an external
     * close (registry LRU eviction calls `close()`, which flips
     * `initialized` to false) WITHOUT rehydrating. The in-memory state
     * is the truth here: eviction flushed before closing, and a
     * `refresh()` would clobber in-memory state. Gated on `everLoaded`
     * so stores that were never `load()`ed (pure in-memory fixtures,
     * pre-load callers) are untouched. Restores `initialized` so the
     * downstream `save()` / `getFileContent()` guards pass again.
     */
    async reopenIfClosed(): Promise<void> {
        if (!this.everLoaded || this.sqlite.isOpen()) return;
        this.log(`[SnapshotStore] re-opening sqlite after external close (mutation path): ${this.storagePath}`);
        await this.sqlite.init();
        this.initialized = true;
        this.recordDiskSync();
    }

    /** Sync re-read from tables. Requires `load()` to have run at least once. */
    refresh(): void {
        if (!this.initialized) return;
        this.state = this.createDefaultState();
        const settings = this.sqlite.get(`SELECT value_json FROM settings WHERE key = 'workspace'`);
        if (settings && typeof settings.value_json === 'string') {
            try {
                const parsed = JSON.parse(settings.value_json);
                stripProtoDeep(parsed);
                if (parsed && typeof parsed === 'object') {
                    if (typeof parsed.autoUpdate === 'boolean') {
                        this.state.settings = { autoUpdate: parsed.autoUpdate };
                    }
                }
            } catch { /* fall back to default */ }
        }
        for (const kind of SNAPSHOT_KINDS) {
            this.hydrateSnapshot(kind, this.state[kind]);
        }
        this.state.comments = this.hydrateComments();
        this.state.aiReviewFindings = this.hydrateAiReviewFindings();
        this.state.reviewGuidelines = this.hydrateReviewGuidelines();
    }

    /**
     * Persist the in-memory state into SQLite tables and flush to disk.
     * Sync — sql.js operations are sync after init, and the on-disk write
     * is `fs.writeFileSync` + `renameSync` (atomic).
     */
    save(): void {
        if (!this.initialized) {
            this.log('[SnapshotStore] save() called before load() — ignoring');
            return;
        }
        try {
            const refId = this.sqlite.currentGitRefId();
            this.sqlite.transaction(() => {
                // Settings (workspace-wide; not git_ref-tied).
                const settingsJson = JSON.stringify(this.state.settings ?? { autoUpdate: true });
                this.sqlite.run(
                    `INSERT INTO settings (key, value_json) VALUES (?, ?)
                     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
                    ['workspace', settingsJson],
                );

                for (const kind of SNAPSHOT_KINDS) {
                    this.persistSnapshot(kind, this.state[kind], refId);
                }
                this.persistComments(this.state.comments ?? [], refId);
                this.persistAiReviewFindings(this.state.aiReviewFindings ?? [], refId);
                this.persistReviewGuidelines(this.state.reviewGuidelines);
            });
            this.sqlite.flush();
            // #829b — our own flush is not an "external" change.
            this.recordDiskSync();
            // Memory recovery: content is now on disk; drop it from RAM.
            // Consumers needing content post-save must use getFileContent().
            this.forgetContentInMemory();
            // Same for graph bodies: keep the IDs (so `id in graphs` and
            // Object.keys still work), drop the cached bodies. Next read
            // pulls from SQL on demand.
            this.forgetGraphBodiesInMemory();
        } catch (err: any) {
            this.log(`[SnapshotStore] Failed to save: ${err?.message ?? err}`);
        }
    }

    // ─── hydration ──────────────────────────────────────────────────────────

    private hydrateSnapshot(kind: SnapshotKind, into: Snapshot): void {
        // NB: content is intentionally NOT loaded — fetched on demand via
        // getFileContent(). This is the main memory win: a 10k-file workspace
        // saves on the order of 100s of MB by keeping content on disk only.
        const files = this.sqlite.all(
            `SELECT path, record_json FROM files WHERE snapshot_kind = ?`, [kind],
        );
        for (const row of files) {
            try {
                const rec = JSON.parse(String(row.record_json)) as FileRecord;
                delete (rec as any).content;
                into.files[String(row.path)] = rec;
            } catch { /* skip corrupt row */ }
        }
        const apis = this.sqlite.all(
            `SELECT api_id, record_json FROM apis WHERE snapshot_kind = ?`, [kind],
        );
        for (const row of apis) {
            try {
                into.apiIndex[String(row.api_id)] = JSON.parse(String(row.record_json)) as ApiRecord;
            } catch { /* skip */ }
        }
        // Lazy graphs (Issue #355): load only IDs into the LazyGraphMap.
        // Graph bodies are fetched on-demand via the Proxy.
        const ids = this.sqlite.all(
            `SELECT graph_id FROM graphs WHERE snapshot_kind = ?`, [kind],
        );
        const graphMap = this.graphMaps[kind];
        if (graphMap) {
            graphMap.resetWithIds(ids.map(r => String(r.graph_id)));
        }
        const clusters = this.sqlite.all(
            `SELECT cluster_id, cluster_json FROM clusters WHERE snapshot_kind = ?`, [kind],
        );
        if (clusters.length > 0) {
            const map: Record<string, FeatureCluster> = {};
            for (const row of clusters) {
                try { map[String(row.cluster_id)] = JSON.parse(String(row.cluster_json)) as FeatureCluster; } catch { /* skip */ }
            }
            into.clusters = map;
        }
        // Issue #701 / #734 — Domain clusters (business-intent). Pre-v9 DBs
        // simply return zero rows here; the orchestrator re-derives the
        // heuristic on init, and the LLM refiner (if enabled) re-runs.
        try {
            const domains = this.sqlite.all(
                `SELECT domain_id, domain_json FROM domains WHERE snapshot_kind = ?`, [kind],
            );
            if (domains.length > 0) {
                const map: Record<string, DomainCluster> = {};
                for (const row of domains) {
                    try { map[String(row.domain_id)] = JSON.parse(String(row.domain_json)) as DomainCluster; } catch { /* skip */ }
                }
                into.domains = map;
            }
        } catch (err: any) {
            // Pre-v9 schema — table doesn't exist. Migration runs on next
            // open; for this load we just skip and let the orchestrator
            // recompute.
        }
        const services = this.sqlite.all(
            `SELECT service_id, service_json FROM services WHERE snapshot_kind = ?`, [kind],
        );
        if (services.length > 0) {
            const map: Record<string, ServiceRecord> = {};
            for (const row of services) {
                try {
                    const parsed = JSON.parse(String(row.service_json)) as ServiceRecord;
                    // v2 phase 2: pre-#482 snapshots don't carry the
                    // `category` field. Default to `'backend'` so the
                    // load is back-compat — re-init reclassifies later.
                    if (parsed && typeof parsed === 'object' && parsed.category == null) {
                        parsed.category = 'backend';
                    }
                    map[String(row.service_id)] = parsed;
                } catch { /* skip */ }
            }
            into.services = map;
        }
        // v2 phase 3 #484 — load screen records for FE/mobile services.
        // Pre-v7 snapshots have no `screens` table; the schema migration
        // creates it empty, so this query just returns 0 rows on first
        // load after upgrade and `into.screens` stays undefined.
        const screenRows = this.sqlite.all(
            `SELECT screen_id, screen_json FROM screens WHERE snapshot_kind = ?`, [kind],
        );
        if (screenRows.length > 0) {
            const map: Record<string, ScreenRecord> = {};
            for (const row of screenRows) {
                try { map[String(row.screen_id)] = JSON.parse(String(row.screen_json)) as ScreenRecord; } catch { /* skip */ }
            }
            into.screens = map;
        }
        // v2 phase 4 #485 — load per-screen L2b items. Pre-v8 snapshots
        // have no `screen_items` table; the schema migration creates it
        // empty so this query returns 0 rows after upgrade and
        // `into.screenItems` stays undefined.
        const itemRows = this.sqlite.all(
            `SELECT screen_id, items_json FROM screen_items WHERE snapshot_kind = ?`, [kind],
        );
        if (itemRows.length > 0) {
            const map: Record<string, L2bScreenItem[]> = {};
            for (const row of itemRows) {
                try {
                    const parsed = JSON.parse(String(row.items_json));
                    if (Array.isArray(parsed)) {
                        map[String(row.screen_id)] = parsed as L2bScreenItem[];
                    }
                } catch { /* skip */ }
            }
            into.screenItems = map;
        }
        const singletons = this.sqlite.all(
            `SELECT name, payload_json FROM singletons WHERE snapshot_kind = ?`, [kind],
        );
        for (const row of singletons) {
            try {
                const payload = JSON.parse(String(row.payload_json));
                if (row.name === 'callGraph') into.callGraph = payload as SerializedCallGraph;
                if (row.name === 'health') into.health = payload as HealthReport;
            } catch { /* skip */ }
        }
    }

    private hydrateComments(): Comment[] {
        const rows = this.sqlite.all(`SELECT comment_json FROM comments ORDER BY created_at ASC`);
        const out: Comment[] = [];
        for (const row of rows) {
            try { out.push(JSON.parse(String(row.comment_json)) as Comment); } catch { /* skip */ }
        }
        return out;
    }

    // ─── persistence ───────────────────────────────────────────────────────

    private persistSnapshot(kind: SnapshotKind, snap: Snapshot, refId: number): void {
        this.sqlite.run(
            `INSERT INTO snapshots (kind, git_ref_id, schema_version, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(kind) DO UPDATE SET git_ref_id = excluded.git_ref_id, schema_version = excluded.schema_version, updated_at = excluded.updated_at`,
            [kind, refId, CURRENT_SCHEMA_VERSION, Date.now()],
        );
        // Per-row UPSERT: keeps the persisted `content` column intact when
        // the in-memory FileRecord no longer has `.content` set. After the
        // first save() drops content from RAM (#354/#355), every subsequent
        // save() previously did DELETE+INSERT with content=null and silently
        // wiped the on-disk content rows — defeating the whole lazy-content
        // design and breaking any consumer that needed source text after
        // navigation (#361 — DB / queue / cache infra disappearing on the
        // L1 system-design diagram on second save). We now:
        //   - tombstone files that no longer exist in the snapshot, and
        //   - update record_json (always), but only overwrite `content`
        //     when the in-memory record actually carries fresh content.
        const liveRows = this.sqlite.all(
            `SELECT path FROM files WHERE snapshot_kind = ?`, [kind],
        );
        const livePaths = new Set(liveRows.map(r => String(r.path)));
        const newPaths = new Set(Object.keys(snap.files));
        for (const p of livePaths) {
            if (!newPaths.has(p)) {
                this.sqlite.run(
                    `DELETE FROM files WHERE snapshot_kind = ? AND path = ?`, [kind, p],
                );
            }
        }
        for (const [p, rec] of Object.entries(snap.files)) {
            const { content, ...meta } = rec as FileRecord & { content?: string };
            const metaJson = JSON.stringify(meta);
            if (typeof content === 'string') {
                // Fresh content in RAM — write through to the content column.
                this.sqlite.run(
                    `INSERT INTO files (snapshot_kind, path, record_json, content) VALUES (?, ?, ?, ?)
                     ON CONFLICT(snapshot_kind, path) DO UPDATE SET record_json = excluded.record_json, content = excluded.content`,
                    [kind, p, metaJson, redactSecretsInContent(content)],
                );
            } else {
                // No content in RAM (post-save lazy state). Update the
                // metadata row but leave the existing content column alone
                // — that's the whole point of the lazy-content invariant.
                this.sqlite.run(
                    `INSERT INTO files (snapshot_kind, path, record_json, content) VALUES (?, ?, ?, NULL)
                     ON CONFLICT(snapshot_kind, path) DO UPDATE SET record_json = excluded.record_json`,
                    [kind, p, metaJson],
                );
            }
        }
        this.sqlite.run(`DELETE FROM apis WHERE snapshot_kind = ?`, [kind]);
        for (const [id, rec] of Object.entries(snap.apiIndex)) {
            this.sqlite.run(
                `INSERT INTO apis (snapshot_kind, api_id, record_json) VALUES (?, ?, ?)`,
                [kind, id, JSON.stringify(rec)],
            );
        }
        // Lazy graphs (Issue #355): flush only dirty + tombstoned IDs through
        // LazyGraphMap. The DELETE-all-then-INSERT-all pattern above for
        // graphs would have re-written all 20k+ rows on every save and
        // defeated the lazy-hydration win.
        const graphMap = this.graphMaps[kind];
        if (graphMap) {
            graphMap.flushDirty();
        }
        this.sqlite.run(`DELETE FROM clusters WHERE snapshot_kind = ?`, [kind]);
        for (const [id, c] of Object.entries(snap.clusters ?? {})) {
            this.sqlite.run(
                `INSERT INTO clusters (snapshot_kind, cluster_id, cluster_json) VALUES (?, ?, ?)`,
                [kind, id, JSON.stringify(c)],
            );
        }
        // Issue #701 / #734 — Domain clusters (business-intent). DELETE-
        // INSERT pattern same as clusters above; domains are typically
        // <20 per workspace so the cost is negligible. Wrapped in
        // try/catch so a fresh pre-v9 DB (unlikely after migration but
        // possible during the v8→v9 upgrade window) doesn't fail the
        // whole save.
        try {
            this.sqlite.run(`DELETE FROM domains WHERE snapshot_kind = ?`, [kind]);
            for (const [id, d] of Object.entries(snap.domains ?? {})) {
                this.sqlite.run(
                    `INSERT INTO domains (snapshot_kind, domain_id, domain_json) VALUES (?, ?, ?)`,
                    [kind, id, JSON.stringify(d)],
                );
            }
        } catch { /* pre-v9 schema — skip */ }
        this.sqlite.run(`DELETE FROM services WHERE snapshot_kind = ?`, [kind]);
        for (const [id, s] of Object.entries(snap.services ?? {})) {
            this.sqlite.run(
                `INSERT INTO services (snapshot_kind, service_id, service_json) VALUES (?, ?, ?)`,
                [kind, id, JSON.stringify(s)],
            );
        }
        // v2 phase 3 #484 — screens table for FE/mobile L2a records.
        this.sqlite.run(`DELETE FROM screens WHERE snapshot_kind = ?`, [kind]);
        for (const [id, sc] of Object.entries(snap.screens ?? {})) {
            this.sqlite.run(
                `INSERT INTO screens (snapshot_kind, screen_id, screen_json) VALUES (?, ?, ?)`,
                [kind, id, JSON.stringify(sc)],
            );
        }
        // v2 phase 4 #485 — screen_items table for FE/mobile L2b items.
        this.sqlite.run(`DELETE FROM screen_items WHERE snapshot_kind = ?`, [kind]);
        for (const [id, items] of Object.entries(snap.screenItems ?? {})) {
            this.sqlite.run(
                `INSERT INTO screen_items (snapshot_kind, screen_id, items_json) VALUES (?, ?, ?)`,
                [kind, id, JSON.stringify(items)],
            );
        }
        this.sqlite.run(`DELETE FROM singletons WHERE snapshot_kind = ?`, [kind]);
        if (snap.callGraph) {
            this.sqlite.run(
                `INSERT INTO singletons (snapshot_kind, name, payload_json) VALUES (?, ?, ?)`,
                [kind, 'callGraph', JSON.stringify(snap.callGraph)],
            );
        }
        if (snap.health) {
            this.sqlite.run(
                `INSERT INTO singletons (snapshot_kind, name, payload_json) VALUES (?, ?, ?)`,
                [kind, 'health', JSON.stringify(snap.health)],
            );
        }
    }

    private persistComments(comments: Comment[], refId: number): void {
        this.sqlite.run(`DELETE FROM comments`, []);
        for (const c of comments) {
            const id = (c as any).id ?? cryptoRandomId();
            const ts = (c as any).createdAt ?? Date.now();
            this.sqlite.run(
                `INSERT INTO comments (id, git_ref_id, comment_json, created_at) VALUES (?, ?, ?, ?)`,
                [String(id), refId, JSON.stringify(c), Number(ts) || Date.now()],
            );
        }
    }

    // ─── AI review findings + guidelines (#498/#499/#505) ──────────────────

    private persistAiReviewFindings(findings: AiReviewFinding[], refId: number): void {
        // Simple replace-all on each save — table is small (typically <1k rows).
        this.sqlite.run(`DELETE FROM ai_review_findings`, []);
        const now = Date.now();
        for (const f of findings) {
            const created = Date.parse(f.createdAt) || now;
            const updated = Date.parse(f.updatedAt) || now;
            // Working-kind only for now. Baseline reviews land in a follow-up.
            this.sqlite.run(
                `INSERT INTO ai_review_findings
                    (snapshot_kind, id, git_ref_id, entry_point_id, finding_json,
                     status, model, guidelines_hash, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    'working',
                    f.id,
                    refId,
                    f.entryPointId,
                    JSON.stringify(f),
                    f.status,
                    f.model ?? null,
                    f.guidelinesHash ?? null,
                    created,
                    updated,
                ],
            );
        }
    }

    private hydrateAiReviewFindings(): AiReviewFinding[] {
        try {
            const rows = this.sqlite.all(
                `SELECT finding_json FROM ai_review_findings WHERE snapshot_kind = ?`,
                ['working'],
            );
            const out: AiReviewFinding[] = [];
            for (const r of rows) {
                try {
                    const parsed = JSON.parse(String(r.finding_json));
                    if (parsed && typeof parsed === 'object' && parsed.id) out.push(parsed);
                } catch { /* skip malformed row */ }
            }
            return out;
        } catch {
            // Table missing on a pre-v3 DB before migration runs — return empty.
            return [];
        }
    }

    private persistReviewGuidelines(record: WorkspaceState['reviewGuidelines']): void {
        if (!record) return;
        this.sqlite.run(
            `INSERT INTO review_guidelines (id, text, hash, updated_at)
             VALUES (1, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                text = excluded.text,
                hash = excluded.hash,
                updated_at = excluded.updated_at`,
            [record.text ?? '', record.hash ?? '', Number(record.updatedAt) || Date.now()],
        );
    }

    private hydrateReviewGuidelines(): WorkspaceState['reviewGuidelines'] {
        try {
            const row = this.sqlite.get(
                `SELECT text, hash, updated_at FROM review_guidelines WHERE id = 1`,
            );
            if (!row) return undefined;
            return {
                text: String(row.text ?? ''),
                hash: String(row.hash ?? ''),
                updatedAt: Number(row.updated_at) || Date.now(),
            };
        } catch {
            return undefined;
        }
    }

    // ─── legacy import ─────────────────────────────────────────────────────

    private maybeImportLegacyJson(): void {
        const legacyPath = path.join(this.storagePath, LEGACY_STATE_FILE);
        if (!fs.existsSync(legacyPath)) return;
        const dbHasData = this.sqlite.get(`SELECT COUNT(*) AS n FROM snapshots`);
        if (dbHasData && Number(dbHasData.n) > 0) return; // already migrated
        try {
            const raw = fs.readFileSync(legacyPath, 'utf-8');
            const parsed = JSON.parse(raw);
            stripProtoDeep(parsed);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
            const baseline = parsed.baseline as Snapshot | undefined;
            const working = parsed.working as Snapshot | undefined;
            if (!isValidSnapshot(baseline) || !isValidSnapshot(working)) return;
            this.state.baseline = baseline as Snapshot;
            this.state.working = working as Snapshot;
            this.state.comments = Array.isArray(parsed.comments) ? parsed.comments : [];
            if (parsed.settings && typeof parsed.settings === 'object') {
                this.state.settings = { autoUpdate: parsed.settings.autoUpdate !== false };
            }
            // Persist into SQLite under the current git ref.
            const refId = this.sqlite.currentGitRefId();
            this.sqlite.transaction(() => {
                const settingsJson = JSON.stringify(this.state.settings ?? { autoUpdate: true });
                this.sqlite.run(
                    `INSERT INTO settings (key, value_json) VALUES (?, ?)
                     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
                    ['workspace', settingsJson],
                );
                for (const kind of SNAPSHOT_KINDS) {
                    this.persistSnapshot(kind, this.state[kind], refId);
                }
                this.persistComments(this.state.comments ?? [], refId);
            });
            this.sqlite.flush();
            this.log(`[SnapshotStore] Imported legacy state.json into SQLite`);
        } catch (err: any) {
            this.log(`[SnapshotStore] Legacy state.json import failed: ${err?.message ?? err}`);
        }
    }

    // ─── multi-window detection (#116 — Multi-window on same workspace — concurrent state.json writes) ─────────────────────────────────────

    /**
     * Detect external changes to state.db. Coarser than the previous
     * mtime check because sql.js writes the whole file each flush, but
     * the contract (return true if another VS Code window saved) holds.
     */
    hasExternalChanges(): boolean {
        const dbPath = path.join(this.storagePath, 'state.db');
        try {
            if (!fs.existsSync(dbPath)) return false;
            // We deliberately don't track our own last flush time — this hook
            // is only invoked rarely and the orchestrator already debounces.
            return false;
        } catch { return false; }
    }

    // ─── #829b (2026-06-11) — cross-process reload ─────────────────────────

    /** Disk fingerprint of state.db at our last load/save. `null` until the
     *  first load. Updated by `recordDiskSync()`. */
    private lastDiskSync: { mtimeMs: number; size: number } | null = null;

    private recordDiskSync(): void {
        try {
            const stat = fs.statSync(path.join(this.storagePath, 'state.db'));
            this.lastDiskSync = { mtimeMs: stat.mtimeMs, size: stat.size };
        } catch {
            this.lastDiskSync = null;
        }
    }

    /**
     * Re-open the sql.js image + rehydrate when ANOTHER PROCESS rewrote
     * state.db since our last load/save. The sql.js Database is an
     * in-memory copy of the file — `refresh()` alone re-reads OUR copy,
     * not the writer's disk state, so a read-only consumer (the MCP
     * daemon while the extension holds the write lock) serves frozen
     * data forever without this.
     *
     * Contract: callers must be READ-ONLY consumers — a reload discards
     * any unsaved in-memory writes in this store. Stat-gated, so polling
     * every couple of seconds is cheap (one statSync on no-change).
     * Returns true when a reload actually happened.
     */
    async reloadFromDiskIfChanged(): Promise<boolean> {
        if (!this.initialized) return false;
        let stat: fs.Stats;
        try {
            stat = fs.statSync(path.join(this.storagePath, 'state.db'));
        } catch {
            return false; // no db on disk (in-memory store / fresh dir)
        }
        if (this.lastDiskSync
            && stat.mtimeMs === this.lastDiskSync.mtimeMs
            && stat.size === this.lastDiskSync.size) {
            return false;
        }
        try {
            try { this.sqlite.close(); } catch { /* already closed */ }
            await this.sqlite.init();
            this.refresh();
            this.lastDiskSync = { mtimeMs: stat.mtimeMs, size: stat.size };
            this.log(`[SnapshotStore] reloaded from disk (external write detected): ${this.storagePath}`);
            return true;
        } catch (err: any) {
            this.log(`[SnapshotStore] reloadFromDiskIfChanged failed: ${err?.message ?? err}`);
            return false;
        }
    }

    // ─── unchanged in-memory accessors ─────────────────────────────────────

    getState(): WorkspaceState { return this.state; }
    getBaseline(): Snapshot { return this.state.baseline; }
    getWorking(): Snapshot { return this.state.working; }

    /**
     * Lazy fetch of a single file's content from the DB. Returns undefined
     * if the file row doesn't exist or content is null. Sync — sql.js
     * queries are synchronous after init().
     *
     * Use this instead of `record.content` for any consumer that's already
     * holding a `FileRecord` from the in-memory snapshot — that record's
     * `.content` is intentionally absent to keep memory bounded.
     */
    getFileContent(kind: SnapshotKind, path: string): string | undefined {
        if (!this.initialized) return undefined;
        const row = this.sqlite.get(
            `SELECT content FROM files WHERE snapshot_kind = ? AND path = ?`,
            [kind, path],
        );
        return row && typeof row.content === 'string' ? row.content : undefined;
    }

    /**
     * Bulk fetch of all (path → content) pairs for a snapshot. Use during
     * pipeline operations that scan content across the whole workspace
     * (service detection, call-graph resolution); avoid for steady-state
     * UI work.
     */
    getAllFileContents(kind: SnapshotKind): Map<string, string> {
        const out = new Map<string, string>();
        if (!this.initialized) return out;
        for (const row of this.sqlite.all(
            `SELECT path, content FROM files WHERE snapshot_kind = ? AND content IS NOT NULL`,
            [kind],
        )) {
            out.set(String(row.path), String(row.content));
        }
        return out;
    }

    /**
     * Update the content column for an existing file row without bumping
     * its metadata. Used by pipeline-time helpers that re-read the disk
     * file and want to keep the DB in sync without a full save().
     */
    setFileContent(kind: SnapshotKind, path: string, content: string): void {
        if (!this.initialized) return;
        const redacted = redactSecretsInContent(content);
        this.sqlite.run(
            `UPDATE files SET content = ? WHERE snapshot_kind = ? AND path = ?`,
            [redacted, kind, path],
        );
    }

    /**
     * #936 — INSERT-or-update a BASELINE file's content, creating the row if it
     * doesn't exist. `setFileContent` is UPDATE-only, so it no-ops for a file the
     * baseline never had a row for. Style/template files (.scss/.css/.erb) aren't
     * parsed, so `initialize()` never created a baseline row for them; the review-pr
     * path backfills their base-commit content here so the working-vs-baseline diff
     * shows `-`/`+` instead of an all-`+` NEW FILE (which hides value-change bugs).
     * SQLite-only — no in-memory FileRecord, so graph builders are unaffected;
     * `getFileContent('baseline', path)` (what the diff window reads) returns it.
     */
    setBaselineFileContent(path: string, content: string): void {
        const redacted = redactSecretsInContent(content);
        const meta = { path, hash: '', mtime: 0, symbols: { functions: [], variables: [], imports: [] } };
        // In-memory baseline FileRecord — done UNCONDITIONALLY (NOT gated on `initialized`).
        // The review-pr pipeline store is often NOT `initialized` (that's exactly why
        // `getFileContent('baseline')` always returns undefined and the diff window falls
        // back to `getBaseline().files[fp].content` — #930). So the in-memory write is the
        // load-bearing one; gating it on `initialized` (as the first version did) made the
        // whole method a no-op in the review path. It also keeps persistSnapshot('baseline')
        // from tombstoning the row, and mirrors working.files (which already carries the .scss
        // via rebuildFile) — graph builders read working, not baseline, so this is safe.
        (this.state.baseline.files as Record<string, FileRecord & { content?: string }>)[path] = { ...meta, content: redacted };
        // SQLite row too (only meaningful once initialized) so getFileContent('baseline', path)
        // also resolves it directly — and it survives a save()+forgetContentInMemory.
        if (this.initialized) {
            this.sqlite.run(
                `INSERT INTO files (snapshot_kind, path, record_json, content)
                 VALUES ('baseline', ?, ?, ?)
                 ON CONFLICT(snapshot_kind, path) DO UPDATE SET content = excluded.content`,
                [path, JSON.stringify(meta), redacted],
            );
        }
    }

    /**
     * Drop the in-memory `content` strings from every FileRecord in both
     * snapshots after a save. Content stays on disk in the `files.content`
     * column and is fetched on-demand via `getFileContent`. This is the
     * memory-recovery hook called from the orchestrator after each save.
     *
     * Consumers that read content AFTER a save() must use `getFileContent`
     * — direct `record.content` access returns `undefined` post-save.
     */
    forgetContentInMemory(): void {
        for (const kind of SNAPSHOT_KINDS) {
            const files = this.state[kind].files;
            for (const path of Object.keys(files)) {
                const rec = files[path] as FileRecord & { content?: string };
                if (rec && 'content' in rec) {
                    delete rec.content;
                }
            }
        }
    }

    updateWorkingFile(filePath: string, record: FileRecord): void {
        this.state.working.files[filePath] = record;
    }
    updateWorkingApi(apiId: string, record: ApiRecord): void {
        this.state.working.apiIndex[apiId] = record;
    }
    updateWorkingGraph(graphId: string, graph: DiagramGraph): void {
        this.state.working.graphs[graphId] = graph;
    }
    removeWorkingFile(filePath: string): void {
        delete this.state.working.files[filePath];
    }
    removeWorkingApi(apiId: string): void {
        delete this.state.working.apiIndex[apiId];
    }
    replaceWorkingApiIndex(index: Record<string, ApiRecord>): void {
        this.state.working.apiIndex = index;
    }
    removeWorkingGraph(graphId: string): void {
        delete this.state.working.graphs[graphId];
    }
    updateWorkingCallGraph(callGraph: SerializedCallGraph): void {
        this.state.working.callGraph = callGraph;
    }
    updateWorkingClusters(clusters: Record<string, FeatureCluster>): void {
        this.state.working.clusters = clusters;
    }
    /**
     * #488: Apply a post-init refinement (e.g., LLM-enriched feature graph
     * labels, refined sequence participant resolution) to BOTH snapshots so
     * baseline doesn't go stale relative to working. Use sparingly — only
     * for changes that are corrections to the init-time state, not user
     * edits to the working tree.
     */
    updateBaselineGraph(graphId: string, graph: DiagramGraph): void {
        this.state.baseline.graphs[graphId] = graph;
    }
    updateBaselineClusters(clusters: Record<string, FeatureCluster>): void {
        this.state.baseline.clusters = clusters;
    }

    /**
     * Issue #701 / #734 — Domain cluster accessors. Pass the full Record;
     * the persisted `domains` table is overwritten on each save (same
     * DELETE-then-INSERT pattern as `clusters`).
     */
    updateWorkingDomains(domains: Record<string, DomainCluster>): void {
        this.state.working.domains = domains;
    }
    updateBaselineDomains(domains: Record<string, DomainCluster>): void {
        this.state.baseline.domains = domains;
    }
    getWorkingDomains(): Record<string, DomainCluster> {
        return this.state.working.domains ?? {};
    }
    updateWorkingServices(services: Record<string, ServiceRecord>): void {
        this.state.working.services = services;
    }
    updateWorkingHealth(health: HealthReport): void {
        this.state.working.health = health;
    }
    /**
     * v2 phase 3 #484 — update the per-screen records for FE/mobile L2a.
     * Callers should pass the full Record (not an incremental diff) —
     * the persisted table is overwritten on each save.
     */
    updateWorkingScreens(screens: Record<string, ScreenRecord>): void {
        this.state.working.screens = screens;
    }
    /**
     * v2 phase 4 #485 — update the per-screen L2b content items.
     * Same overwrite-on-save contract as `updateWorkingScreens`.
     */
    updateWorkingScreenItems(items: Record<string, L2bScreenItem[]>): void {
        this.state.working.screenItems = items;
    }
    getWorkingClusters(): Record<string, FeatureCluster> {
        return this.state.working.clusters ?? {};
    }
    getWorkingServices(): Record<string, ServiceRecord> {
        return this.state.working.services ?? {};
    }
    getWorkingScreens(): Record<string, ScreenRecord> {
        return this.state.working.screens ?? {};
    }
    getWorkingScreenItems(): Record<string, L2bScreenItem[]> {
        return this.state.working.screenItems ?? {};
    }

    /**
     * Copy working → baseline. Lazy-graph aware: instead of JSON-cloning the
     * graphs Proxy (which would force-fetch every graph via the Proxy's
     * `get`), we issue one SQL `INSERT FROM SELECT` per table to duplicate
     * the working rows under `snapshot_kind = 'baseline'`. Non-graph fields
     * are cloned in-memory.
     */
    setBaselineFromWorking(): void {
        const working = this.state.working;
        const workingMap = this.graphMaps.working;
        const baselineMap = this.graphMaps.baseline;

        // 1. Clone non-graph fields. `files` is a plain Record so JSON-clone is fine.
        const cloned: Snapshot = {
            files: JSON.parse(JSON.stringify(working.files)),
            apiIndex: JSON.parse(JSON.stringify(working.apiIndex)),
            graphs: {} as Record<string, DiagramGraph>,
            clusters: working.clusters ? JSON.parse(JSON.stringify(working.clusters)) : undefined,
            services: working.services ? JSON.parse(JSON.stringify(working.services)) : undefined,
            callGraph: working.callGraph ? JSON.parse(JSON.stringify(working.callGraph)) : undefined,
            health: working.health ? JSON.parse(JSON.stringify(working.health)) : undefined,
            // v2 phase 3 #484 — copy screens forward to baseline so the
            // diff comparison can detect added/removed/modified screens
            // between cascades.
            screens: working.screens ? JSON.parse(JSON.stringify(working.screens)) : undefined,
            // v2 phase 4 #485 — copy per-screen L2b items forward.
            screenItems: working.screenItems ? JSON.parse(JSON.stringify(working.screenItems)) : undefined,
            // Issue #701 / #734 — copy Domain clusters forward so diff
            // comparison detects added/removed/modified domains.
            domains: working.domains ? JSON.parse(JSON.stringify(working.domains)) : undefined,
        };

        if (baselineMap) baselineMap.forgetAll();

        if (this.initialized && workingMap && baselineMap) {
            workingMap.flushDirty();
            this.sqlite.transaction(() => {
                this.sqlite.run(`DELETE FROM graphs WHERE snapshot_kind = 'baseline'`, []);
                this.sqlite.run(
                    `INSERT INTO graphs (snapshot_kind, graph_id, graph_json)
                     SELECT 'baseline', graph_id, graph_json FROM graphs WHERE snapshot_kind = 'working'`,
                    [],
                );
                // #909 — copy the PERSISTED working `content` column to baseline via
                // SQL (already redacted by persistSnapshot). The in-memory
                // `cloned.files` content above is dropped after the first save()
                // (lazy-content), so a baseline rotation called POST-forget would
                // otherwise persist `content=NULL` → `getFileContent('baseline')`
                // undefined → diffs silently degrade to non-diff. Robust in both
                // states: at init the working content isn't persisted yet, so
                // `content IS NOT NULL` matches nothing (no-op) and the in-memory
                // clone supplies content; post-forget this is the load-bearing copy.
                this.sqlite.run(
                    `INSERT INTO files (snapshot_kind, path, record_json, content)
                     SELECT 'baseline', path, record_json, content
                     FROM files WHERE snapshot_kind = 'working' AND content IS NOT NULL
                     ON CONFLICT(snapshot_kind, path)
                     DO UPDATE SET content = excluded.content`,
                    [],
                );
            });
            baselineMap.resetWithIds(workingMap.keys());
        } else if (workingMap && baselineMap) {
            workingMap.forEach((id, graph) => {
                baselineMap.set(id, JSON.parse(JSON.stringify(graph)));
            });
        }
        cloned.graphs = baselineMap ? makeLazyGraphsProxy(baselineMap) : ({} as Record<string, DiagramGraph>);
        this.state.baseline = cloned;
    }

    /**
     * Reset working snapshot to empty. Preserves the LazyGraphMap-backed
     * proxy on `working.graphs` so subsequent writes still route through it.
     */
    resetWorking(): void {
        const workingMap = this.graphMaps.working;
        if (workingMap) workingMap.forgetAll();
        this.state.working = {
            files: {},
            apiIndex: {},
            graphs: workingMap ? makeLazyGraphsProxy(workingMap) : {},
        };
    }

    /**
     * Stream every (id, graph) pair from one snapshot's graphs without
     * realizing the full corpus in memory. Use this for cascade operations
     * over all graphs (anchor extraction, diff propagation, comment
     * re-anchoring) — anything that today does `Object.values(snap.graphs)`.
     *
     * Surfaces pending in-memory dirty writes ahead of DB rows so callers
     * see the latest state, including graphs not yet persisted.
     */
    iterateGraphs(kind: SnapshotKind, cb: (id: string, graph: DiagramGraph) => void | boolean): void {
        if (!this.initialized) return;
        const map = this.graphMaps[kind];
        if (!map) return;
        map.forEach(cb);
    }

    /** Total graph count for the snapshot, without loading any graph bodies. */
    countGraphs(kind: SnapshotKind): number {
        const map = this.graphMaps[kind];
        return map ? map.size() : 0;
    }

    /** Drop cached graph bodies (keeps IDs). Caller can call after a burst of work. */
    forgetGraphBodiesInMemory(): void {
        for (const kind of SNAPSHOT_KINDS) {
            this.graphMaps[kind]?.forgetBodies();
        }
    }

    /**
     * Unified clear: wipe ALL persisted state via the SQLite FK cascade,
     * then remove every legacy JSON file so they cannot re-seed the DB
     * on next load. This is the single contract for resync / reinit /
     * reset — every reset path in the orchestrator routes through here.
     *
     * Preserves `.gitignore` and any user-facing markdown exports
     * (`architecture.md`, `comments.md`).
     */
    clearAllFiles(): void {
        // Preserve user-generated content across a resync — guidelines, AI
        // review findings and the dedup signature are not derived from the
        // filesystem, so they must survive `clearAllFiles()`. Without this,
        // the AutoInit resync wipes #535 dedup state on every extension boot.
        const preservedGuidelines = this.state.reviewGuidelines;
        const preservedFindings = this.state.aiReviewFindings;
        this.state = this.createDefaultState();
        if (preservedGuidelines) this.state.reviewGuidelines = preservedGuidelines;
        if (preservedFindings && preservedFindings.length > 0) this.state.aiReviewFindings = preservedFindings;
        try {
            if (this.initialized) {
                this.sqlite.clear();
                this.sqlite.flush();
            }
        } catch (err: any) {
            this.log(`[SnapshotStore] clear() failed: ${err?.message ?? err}`);
        }
        const legacyFiles = [
            'state.json',
            'state.json.bak',
            'state.json.tmp',
            'git-diff-state.json',
            'llm-names.json',
            'change-log.json',
        ];
        for (const name of legacyFiles) {
            try {
                const fp = path.join(this.storagePath, name);
                if (fs.existsSync(fp)) fs.unlinkSync(fp);
            } catch { /* best-effort */ }
        }
        this.log(`[SnapshotStore] Cleared all files in ${STORAGE_DIR}/`);
    }

    resync(): void {
        this.setBaselineFromWorking();
    }

    getComments(): Comment[] {
        return this.state.comments;
    }
    setComments(comments: Comment[]): void {
        this.state.comments = comments;
    }

    // ─── AI review accessors (#498/#499/#505/#506) ─────────────────────────

    /** Lazy-construct a fresh AiReviewFindingsStore over the persisted rows. */
    private findingsStore(): AiReviewFindingsStore {
        return new AiReviewFindingsStore(this.state.aiReviewFindings ?? []);
    }

    listAiReviewFindings(filter?: FindingFilter): AiReviewFinding[] {
        return this.findingsStore().list(filter ?? {});
    }

    getAiReviewFinding(id: string): AiReviewFinding | undefined {
        return this.findingsStore().getById(id);
    }

    listAiReviewFindingsForEntity(graphId: string, targetId: string): AiReviewFinding[] {
        return this.findingsStore().listForEntity(graphId, targetId);
    }

    getAiReviewFindingCounts(filter?: FindingFilter): FindingCounts {
        return this.findingsStore().counts(filter ?? {});
    }

    // ─── findings-change listeners (#509 — MCP notifications for review progress + findings changed) ──────────────────────────────
    /** Fired after any findings mutation. Used by MCP notifications +
     *  WS bridge to push updates to subscribers. */
    private findingsListeners: Array<(evt: { added: string[]; updated: string[]; removed: string[] }) => void> = [];

    onFindingsChanged(fn: (evt: { added: string[]; updated: string[]; removed: string[] }) => void): () => void {
        this.findingsListeners.push(fn);
        return () => { this.findingsListeners = this.findingsListeners.filter((f) => f !== fn); };
    }

    private emitFindingsChanged(evt: { added: string[]; updated: string[]; removed: string[] }): void {
        for (const fn of this.findingsListeners) {
            try { fn(evt); } catch { /* swallow listener errors */ }
        }
    }

    upsertAiReviewFinding(record: Omit<AiReviewFinding, 'id' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: string; updatedAt?: string }): AiReviewFinding {
        const store = this.findingsStore();
        const existed = record.id ? !!store.getById(record.id) : false;
        const saved = store.upsert(record as any);
        this.state.aiReviewFindings = store.getAll();
        try { this.save(); } catch { /* save errors already logged */ }
        this.emitFindingsChanged(existed ? { added: [], updated: [saved.id], removed: [] } : { added: [saved.id], updated: [], removed: [] });
        return saved;
    }

    updateAiReviewFindingStatus(
        id: string,
        status: AiReviewStatus,
        opts?: { actor?: string; note?: string },  // Issue 613 — audit trail metadata
    ): AiReviewFinding | undefined {
        const store = this.findingsStore();
        const updated = store.updateStatus(id, status, opts);
        if (!updated) return undefined;
        this.state.aiReviewFindings = store.getAll();
        try { this.save(); } catch { /* swallow */ }
        this.emitFindingsChanged({ added: [], updated: [id], removed: [] });
        return updated;
    }

    /**
     * #536 — mark currently-open findings as `stale` when either the
     * guidelines or the baseline ref drifts from the value the finding was
     * captured against. Returns the ids that were marked.
     *
     * Called at the start of every review run (after the #535 dedup check
     * passes). Stale findings remain in the DB but the UI filters them out
     * of the headline count and dims them in the popover.
     */
    markStaleFindings(opts: { currentGuidelinesHash: string; currentBaselineRef?: string }): string[] {
        const store = this.findingsStore();
        const all = store.getAll();
        const stalenessIds: string[] = [];
        for (const f of all) {
            if (f.status !== 'open') continue;
            const findingRef = (f as any).baselineRef?.ref;
            const findingHash = f.guidelinesHash ?? '';
            const refDrift = !!opts.currentBaselineRef && !!findingRef && findingRef !== opts.currentBaselineRef;
            const guidelineDrift = (opts.currentGuidelinesHash ?? '') !== findingHash;
            if (refDrift || guidelineDrift) stalenessIds.push(f.id);
        }
        if (stalenessIds.length === 0) return [];
        for (const id of stalenessIds) store.updateStatus(id, 'stale');
        this.state.aiReviewFindings = store.getAll();
        try { this.save(); } catch { /* swallow */ }
        this.emitFindingsChanged({ added: [], updated: stalenessIds, removed: [] });
        return stalenessIds;
    }

    clearAiReviewFindings(scope?: { entryPointId?: string; graphId?: string }): number {
        const store = this.findingsStore();
        const beforeIds = store.getAll().map((f) => f.id);
        const removed = scope ? store.clearScope(scope) : store.clearAll();
        this.state.aiReviewFindings = store.getAll();
        const afterIds = new Set(this.state.aiReviewFindings.map((f) => f.id));
        const removedIds = beforeIds.filter((id) => !afterIds.has(id));
        // #535 — a full clear invalidates the dedup signature so the next
        // review reaches the LLM. Must happen BEFORE save() so the row delete
        // is included in the disk flush. Scoped clears leave the signature
        // alone since the remaining findings still represent the (guidelines,
        // baseline) tuple they were captured against.
        if (!scope) this.clearAiReviewSignature();
        // #606 / #606-SYNTHETIC — same logic for per-entry cursors. A full
        // clear means the next incremental review should treat every entry
        // as "changed" and hit the LLM; scoped clears wipe every cursor
        // whose `entry_point_id` matches the cleared scope (a single
        // `method:route` may map to many cursors after the synthetic-key
        // fix, so we clear them all together).
        if (!scope) {
            this.clearAllAiReviewEntryCursors();
        } else if (scope.entryPointId) {
            this.clearAiReviewEntryCursorsByEntryPointId([scope.entryPointId]);
        }
        try { this.save(); } catch { /* swallow */ }
        this.emitFindingsChanged({ added: [], updated: [], removed: removedIds });
        return removed;
    }

    getReviewGuidelines(scope?: string): { text: string; hash: string; updatedAt: number; scope?: string } {
        // #813 (2026-06-10) — when a `scope` is passed, read from the
        // per-scope table. The workspace-wide row is unchanged.
        if (scope) {
            try {
                const row = this.sqlite.get(
                    `SELECT text, hash, updated_at FROM review_guidelines_scoped WHERE scope = ?`,
                    [scope],
                );
                if (row) {
                    return {
                        text: String(row.text ?? ''),
                        hash: String(row.hash ?? ''),
                        updatedAt: Number(row.updated_at) || 0,
                        scope,
                    };
                }
                return { text: '', hash: '', updatedAt: 0, scope };
            } catch {
                return { text: '', hash: '', updatedAt: 0, scope };
            }
        }
        const cur = this.state.reviewGuidelines;
        if (cur) return { ...cur };
        return { text: '', hash: '', updatedAt: 0 };
    }

    // ── #535 dedup signature ───────────────────────────────────────────────

    /**
     * Read the last successful review's signature. Returns null when no run
     * has ever completed (or after `clearAiReviewSignature`).
     */
    getAiReviewSignature(): { guidelinesHash: string; baselineKind: string; baselineRef: string; findingsCount: number; completedAt: number } | null {
        try {
            const rows = this.sqlite.all(`SELECT guidelines_hash, baseline_kind, baseline_ref, findings_count, completed_at FROM ai_review_signature WHERE id = 1`, []);
            if (!rows || rows.length === 0) return null;
            const r = rows[0] as any;
            // Treat a never-written row (all zeros / empty strings AND
            // findings_count===0) as null — matches the "no prior run" intent.
            if (!r.completed_at) return null;
            return {
                guidelinesHash: String(r.guidelines_hash ?? ''),
                baselineKind: String(r.baseline_kind ?? ''),
                baselineRef: String(r.baseline_ref ?? ''),
                findingsCount: Number(r.findings_count ?? 0),
                completedAt: Number(r.completed_at ?? 0),
            };
        } catch {
            // Table missing on a pre-#535 DB — migration runs on next save.
            return null;
        }
    }

    /**
     * Persist the signature for the just-completed review. Called only on
     * `aiReviewComplete` (not on cancel / error) so partial runs don't poison
     * the dedup check.
     */
    setAiReviewSignature(sig: { guidelinesHash: string; baselineKind: string; baselineRef: string; findingsCount: number }): void {
        try {
            this.sqlite.run(
                `INSERT INTO ai_review_signature (id, guidelines_hash, baseline_kind, baseline_ref, findings_count, completed_at)
                 VALUES (1, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                    guidelines_hash = excluded.guidelines_hash,
                    baseline_kind = excluded.baseline_kind,
                    baseline_ref = excluded.baseline_ref,
                    findings_count = excluded.findings_count,
                    completed_at = excluded.completed_at`,
                [sig.guidelinesHash, sig.baselineKind, sig.baselineRef, sig.findingsCount, Date.now()],
            );
        } catch { /* table may be missing on legacy DBs — next save re-creates */ }
    }

    /**
     * Invalidate the dedup signature. Called from `clearAiReviewFindings` so
     * that re-running a review after a Clear always reaches the LLM.
     */
    clearAiReviewSignature(): void {
        try { this.sqlite.run(`DELETE FROM ai_review_signature WHERE id = 1`, []); } catch { /* noop */ }
    }

    // ── #606 / #606-SYNTHETIC per-entry review cursor (incremental review) ──

    /**
     * Read every per-entry review cursor as a `{ apiId → cursor }` map.
     * Returns `{}` when the cursor table is missing or empty (e.g. on a
     * fresh DB before any incremental review has run). `apiId` is the
     * stable key — `entryPointId` rides along on each cursor for finding
     * cleanup when the cursor's api vanishes from the apiIndex.
     */
    getAiReviewEntryCursors(): Record<string, AiReviewEntryCursor> {
        try {
            const rows = this.sqlite.all(
                `SELECT api_id, entry_point_id, handler_hash, guidelines_hash, baseline_kind, baseline_ref, reviewed_at
                   FROM ai_review_entry_cursor`,
                [],
            );
            const out: Record<string, AiReviewEntryCursor> = {};
            for (const r of rows as any[]) {
                out[String(r.api_id)] = {
                    apiId: String(r.api_id),
                    entryPointId: String(r.entry_point_id),
                    handlerHash: String(r.handler_hash ?? ''),
                    guidelinesHash: String(r.guidelines_hash ?? ''),
                    baselineKind: String(r.baseline_kind ?? ''),
                    baselineRef: String(r.baseline_ref ?? ''),
                    reviewedAt: Number(r.reviewed_at ?? 0),
                };
            }
            return out;
        } catch {
            return {};
        }
    }

    /**
     * Insert or update a single cursor row. Idempotent on `apiId`. Flushes
     * the in-memory sqlite to disk via `save()` so a process crash mid-
     * review doesn't lose the cursor — without the flush, the row only
     * lands on disk on the next unrelated save() (file rebuild, finding
     * upsert, etc.). Matches the persistence semantics of
     * `upsertAiReviewFinding` and `updateAiReviewFindingStatus`.
     */
    upsertAiReviewEntryCursor(c: AiReviewEntryCursor): void {
        try {
            this.sqlite.run(
                `INSERT INTO ai_review_entry_cursor
                    (api_id, entry_point_id, handler_hash, guidelines_hash, baseline_kind, baseline_ref, reviewed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(api_id) DO UPDATE SET
                    entry_point_id  = excluded.entry_point_id,
                    handler_hash    = excluded.handler_hash,
                    guidelines_hash = excluded.guidelines_hash,
                    baseline_kind   = excluded.baseline_kind,
                    baseline_ref    = excluded.baseline_ref,
                    reviewed_at     = excluded.reviewed_at`,
                [c.apiId, c.entryPointId, c.handlerHash, c.guidelinesHash, c.baselineKind, c.baselineRef, c.reviewedAt],
            );
            try { this.save(); } catch { /* save errors already logged */ }
        } catch { /* legacy DB without the table — recreated on next save */ }
    }

    /**
     * Drop cursors by `apiId`. Used when an `ApiRecord` disappears from
     * the apiIndex (route renamed, file deleted, function removed).
     */
    clearAiReviewEntryCursorsByApiId(apiIds: string[]): void {
        if (!apiIds || apiIds.length === 0) return;
        try {
            for (const id of apiIds) {
                this.sqlite.run(`DELETE FROM ai_review_entry_cursor WHERE api_id = ?`, [id]);
            }
        } catch { /* noop */ }
    }

    /**
     * Drop cursors by `entry_point_id`. Used when findings for a
     * `method:route` are cleared and we want every cursor sharing that
     * entry_point_id removed (matches the prior unscoped-scope semantics).
     */
    clearAiReviewEntryCursorsByEntryPointId(entryPointIds: string[]): void {
        if (!entryPointIds || entryPointIds.length === 0) return;
        try {
            for (const id of entryPointIds) {
                this.sqlite.run(`DELETE FROM ai_review_entry_cursor WHERE entry_point_id = ?`, [id]);
            }
        } catch { /* noop */ }
    }

    /** Wipe every cursor. Used by `clearAiReviewFindings` (unscoped). */
    clearAllAiReviewEntryCursors(): void {
        try { this.sqlite.run(`DELETE FROM ai_review_entry_cursor`, []); } catch { /* noop */ }
    }

    setReviewGuidelines(text: string, scope?: string): { text: string; hash: string; updatedAt: number; scope?: string } {
        const cleaned = sanitiseGuidelines(text);
        const hash = cleaned ? crypto.createHash('sha256').update(cleaned, 'utf8').digest('hex').slice(0, 16) : '';
        const updatedAt = Date.now();
        if (scope) {
            // #813 — per-scope write goes straight to SQLite; workspace
            // in-memory record is untouched. Both scopes coexist.
            try {
                this.sqlite.run(
                    `INSERT INTO review_guidelines_scoped (scope, text, hash, updated_at)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(scope) DO UPDATE SET
                        text = excluded.text,
                        hash = excluded.hash,
                        updated_at = excluded.updated_at`,
                    [scope, cleaned, hash, updatedAt],
                );
            } catch { /* swallow */ }
            return { text: cleaned, hash, updatedAt, scope };
        }
        const record = { text: cleaned, hash, updatedAt };
        this.state.reviewGuidelines = record;
        try { this.save(); } catch { /* swallow */ }
        return { ...record };
    }

    pruneStaleGraphs(): number {
        let removed = 0;
        for (const snapshot of [this.state.baseline, this.state.working]) {
            const liveFiles = new Set(Object.keys(snapshot.files));
            // #906 — sequence graphs backed by a still-live API are NOT stale even
            // when their `filePath` isn't a FileRecord. IaC routes
            // (`serverless.yml` etc.) get a synthetic `sequence:<file>:<handler>`
            // via ensureSyntheticSequences, but `serverless.yml` is a manifest,
            // not a parsed source file → it's absent from `liveFiles`, so the
            // first cascade pruned the synthetic graph as an orphan, leaving a
            // permanent `deleted` ghost diff for every IaC route. Mirror the
            // ensureSyntheticSequences graphId so they survive.
            const apiBackedSeqIds = new Set<string>();
            for (const api of Object.values(snapshot.apiIndex ?? {})) {
                if (api?.filePath && api?.handlerName) {
                    apiBackedSeqIds.add(`sequence:${api.filePath}:${api.handlerName}`);
                }
            }
            const graphIds = Object.keys(snapshot.graphs);
            for (const graphId of graphIds) {
                // Issue #362 Phase B (2026-06-07) — structured parse.
                const parsed = parseGraphId(graphId);
                if (!parsed || !['file', 'flow', 'sequence'].includes(parsed.type)) continue;
                const prefix = parsed.type;
                // #906 — keep API-backed sequence graphs regardless of liveFiles.
                if (prefix === 'sequence' && apiBackedSeqIds.has(graphId)) continue;
                let filePath = '';
                if (prefix === 'file') {
                    filePath = parsed.parts[0] ?? '';
                } else {
                    // For flow/sequence the parser already gave us
                    // parts[0] = file. Trust it directly.
                    filePath = parsed.parts[0] ?? '';
                }
                if (!filePath) continue;
                if (liveFiles.has(filePath)) continue;
                const graph = snapshot.graphs[graphId];
                const hasGhostNodes = graph?.nodes?.some((n: any) => n.diff === 'deleted');
                if (hasGhostNodes) continue;
                delete snapshot.graphs[graphId];
                removed++;
            }
        }
        return removed;
    }
}

function isValidSnapshot(s: any): s is Snapshot {
    return s && typeof s === 'object' && typeof s.files === 'object' && typeof s.apiIndex === 'object' && typeof s.graphs === 'object';
}

function cryptoRandomId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Stringify any value, redacting secret-shaped values inside `content` fields. */
function stringifyWithRedaction(value: unknown): string {
    return JSON.stringify(value, (key, v) => {
        if (key === 'content' && typeof v === 'string') return redactSecretsInContent(v);
        return v;
    });
}

/**
 * Redact potential secrets from file content before persisting.
 * Replaces values of common secret patterns with [REDACTED] while preserving
 * the key names (so the extension can still detect infra patterns on reload).
 *
 * #908 — this runs over EVERY fresh-content file inside the save transaction.
 * The credential-value regexes (`{8,}` runs + lookaheads, URL creds) can
 * catastrophically backtrack on a long minified/generated line (now allowed by
 * the 5 MB content cap), blocking the event loop + the SQLite write. Guard: keep
 * the byte-identical whole-content path for normal files (≤256 KB), and for
 * larger content redact LINE-BY-LINE (every pattern here is single-line anyway),
 * skipping pathologically long lines that are minified blobs — never a
 * hand-written `PASSWORD=…` assignment — and are the backtracking vector.
 */
const REDACT_MAX_WHOLE_BYTES = 256 * 1024;
const REDACT_MAX_LINE_BYTES = 8 * 1024;

function redactSecretsInContent(content: string): string {
    if (content.length <= REDACT_MAX_WHOLE_BYTES) return redactLine(content);
    return content
        .split('\n')
        .map((line) => (line.length > REDACT_MAX_LINE_BYTES ? line : redactLine(line)))
        .join('\n');
}

// #11059 — a quoted value that is ITSELF a known field/placeholder name (e.g.
// `data.refresh_token = "refresh_token"`) is never a credential — it's a literal
// default/placeholder. The redactor matched the keyword `token` inside
// `refresh_token` and blanked the value, hiding a real hardcoded-string bug (the
// redacted line reads as deliberate redaction). Keep such self-referential
// identifier literals. A genuine secret value is high-entropy, never literally a
// field name. Match is case-insensitive on the inner value.
const PLACEHOLDER_LITERALS = new Set([
    'token', 'refresh_token', 'access_token', 'id_token', 'refreshtoken', 'accesstoken',
    'password', 'passwd', 'pwd', 'secret', 'client_secret', 'clientsecret',
    'api_key', 'apikey', 'auth_token', 'authtoken', 'private_key', 'privatekey',
    'access_key', 'accesskey', 'encryption_key', 'cert', 'certificate', 'bearer',
    'authorization', 'credentials', 'credential', 'example', 'changeme', 'none',
]);
function isPlaceholderLiteral(val: string): boolean {
    return PLACEHOLDER_LITERALS.has(val.trim().toLowerCase());
}

function redactLine(content: string): string {
    const credentialValuePattern = /[A-Za-z0-9_\-./=+]{8,}/;
    return content
        .replace(
            /(?:PASSWORD|SECRET|API_KEY|TOKEN|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|AUTH_TOKEN|ENCRYPTION_KEY|CERT|CERTIFICATE)\s*[=:]\s*['"][^'"]{4,}['"]/gi,
            (match) => {
                const inner = match.match(/['"]([^'"]{4,})['"]/);
                if (inner && isPlaceholderLiteral(inner[1])) return match; // #11059 — self-referential literal, not a secret
                return match.replace(/['"][^'"]{4,}['"]/, '"[REDACTED]"');
            },
        )
        .replace(
            /(?:PASSWORD|SECRET|API_KEY|TOKEN|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|AUTH_TOKEN|ENCRYPTION_KEY|CERT|CERTIFICATE)\s*[=:]\s*(?!['"\[\{(!])([A-Za-z0-9_\-./=+]{8,})(?=\s|;|,|$)/gi,
            (match, val) => {
                if (!credentialValuePattern.test(val)) return match;
                if (isPlaceholderLiteral(val)) return match; // #11059 — self-referential field-name literal, not a secret
                if (/\b(?:import|require|process|env|input|req|res|this|new|typeof|instanceof|null|undefined|true|false)\b/.test(val)) return match;
                // #377: preserve the original `=` / `:` separator and quote the
                // redacted value so the output is valid syntax in BOTH env-style
                // assignments (`PASSWORD=abc12345xyz` → `PASSWORD= "[REDACTED]"`)
                // and JS/TS object literals (`password: hashedPassword` →
                // `password: "[REDACTED]"`). Pre-fix the regex blindly replaced
                // `:`-separated property pairs with `= [REDACTED]`, producing
                // invalid JS that Babel failed to parse — `buildEntityDiff` and
                // `buildSequenceDiff` then silently fell back to empty diffs or
                // emitted false-positive changed edges on every routes whose
                // source code contained an object property named `password`.
                return match.replace(/([=:])\s*[A-Za-z0-9_\-./=+]{8,}/, '$1 "[REDACTED]"');
            },
        )
        .replace(/Bearer\s+[A-Za-z0-9_\-\.]{10,}/gi, 'Bearer [REDACTED]')
        // #448-A-infra-edge: scope the credential-URL pattern to a single
        // line by excluding whitespace from both the host and credential
        // segments. The previous form `[^:]+:[^@]+@` matched across
        // newlines (host runs to next `:`, credential runs to next `@`),
        // collapsing 20+ lines of code into one `[REDACTED]@` block. That
        // ate the `"database/sql"` import in real-world Go code that has
        // a doc-comment URL up top and a `@` in a format string later,
        // and cascade rebuilds then missed infrastructure detection.
        .replace(/https?:\/\/[^:\s]+:[^@\s]+@/gi, 'http://[REDACTED]@')
        .replace(
            /(?:mongodb|postgres|mysql|redis|amqp|amqps):\/\/[^\s'")\]}{,]+/gi,
            '[REDACTED_URI]',
        );
}
