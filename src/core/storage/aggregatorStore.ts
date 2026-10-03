/**
 * ADR-034 Phase A — `monorepo.db` aggregator store (#786 — Phase A: per-repo DB foundation (ADR-034)).
 *
 * Backs the workspace-wide registry + cross-repo tables that live next to
 * each `state.db`. Phase A populates only the registry, workspace-mode,
 * and workspace-scope graph tables; cross-repo readers return empties.
 *
 * Persistence model mirrors `SqliteStore` (sql.js + atomic .tmp + rename)
 * but with no GitRefProvider integration and a much narrower table set.
 * Shares the WASM loader with SqliteStore so init cost is amortised.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Database } from 'sql.js';

import { loadSqlJs } from './sqliteStore';
import {
    MONOREPO_DDL,
    MONOREPO_PRAGMAS,
    MONOREPO_SCHEMA_VERSION,
    MONOREPO_DB_FILE,
} from './monorepoDbSchema';
import type {
    IAggregatorStore,
    RepoRow,
    SharedExternalRow,
    SharedSchemaRow,
    CrossRepoHttpEdgeRow,
    RepoSummary,
    SavedApiTestingChain,
} from './storeInterfaces';
import { defaultCrossRepoRegistry, type CrossRepoAnalyzerRegistry } from '../sync/crossRepoAnalyzer';
import { normaliseRoutePath } from '../analysis/crossRepoHttpAnalyzer';

const STORAGE_DIR = '.codeatlas';
const MODE_OVERRIDE_FILE = 'workspace-mode.json';

export class AggregatorStore implements IAggregatorStore {
    private readonly storageDir: string;
    private readonly dbPath: string;
    private readonly inMemoryOnly: boolean;
    private db: Database | null = null;
    private log: (msg: string) => void = () => { /* noop */ };

    /**
     * @param workspaceRoot absolute path to the workspace folder
     * @param opts.inMemoryOnly skip on-disk reads/writes — used by tests +
     *     the MCP standalone in-memory mode (#351 parallel)
     * @param opts.storageDirName override the default `.codeatlas` — the
     *     standalone MCP package passes `.codeatlas-sa` to coexist with the
     *     extension's `.codeatlas`
     */
    constructor(
        workspaceRoot: string,
        opts: { inMemoryOnly?: boolean; storageDirName?: string } = {},
    ) {
        this.storageDir = path.join(workspaceRoot, opts.storageDirName ?? STORAGE_DIR);
        this.dbPath = path.join(this.storageDir, MONOREPO_DB_FILE);
        this.inMemoryOnly = opts.inMemoryOnly ?? false;
    }

    setLogger(logger: (msg: string) => void): void {
        this.log = logger;
    }

    /** Open or create the on-disk monorepo.db and apply schema. */
    async init(): Promise<void> {
        const SQL = await loadSqlJs();
        if (this.inMemoryOnly) {
            this.db = new SQL.Database();
        } else {
            if (!fs.existsSync(this.storageDir)) {
                fs.mkdirSync(this.storageDir, { recursive: true });
            }
            if (fs.existsSync(this.dbPath)) {
                try {
                    this.db = new SQL.Database(new Uint8Array(fs.readFileSync(this.dbPath)));
                } catch (err: any) {
                    this.log(`[AggregatorStore] DB at ${this.dbPath} is corrupt (${err?.message ?? err}); starting fresh`);
                    this.db = new SQL.Database();
                }
            } else {
                this.db = new SQL.Database();
            }
        }
        this.applySchema();
        this.applyPragmas();
        this.recordSchemaVersion();
    }

    private applySchema(): void {
        if (!this.db) throw new Error('[AggregatorStore] applySchema before init');
        for (const stmt of MONOREPO_DDL) this.db.exec(stmt);
    }

    private applyPragmas(): void {
        if (!this.db) return;
        for (const p of MONOREPO_PRAGMAS) this.db.exec(p);
    }

    private recordSchemaVersion(): void {
        if (!this.db) return;
        this.db.exec(
            `INSERT OR REPLACE INTO schema_version (component, version) VALUES ('monorepo', ${MONOREPO_SCHEMA_VERSION})`,
        );
    }

    // ─── IPersistentStore ────────────────────────────────────────────────

    save(): void {
        if (this.inMemoryOnly) return;
        if (!this.db) throw new Error('[AggregatorStore] save() before init');
        const tmp = this.dbPath + '.tmp';
        const bytes = this.db.export();
        fs.writeFileSync(tmp, Buffer.from(bytes));
        fs.renameSync(tmp, this.dbPath);
    }

    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    getDbPath(): string { return this.dbPath; }

    getSchemaVersion(): number { return MONOREPO_SCHEMA_VERSION; }

    // ─── Repo registry ───────────────────────────────────────────────────

    listRepos(): ReadonlyArray<RepoRow> {
        if (!this.db) throw new Error('[AggregatorStore] listRepos before init');
        const res = this.db.exec(`SELECT repo_id, name, root_path, realpath_hash, technology, status,
            last_init_at, error_message, fallback_state_path, state_db_schema_version,
            summary_schema_version, diff FROM repos ORDER BY root_path`);
        if (!res.length) return [];
        return res[0].values.map((row) => ({
            repoId: row[0] as string,
            name: row[1] as string,
            rootPath: row[2] as string,
            realpathHash: row[3] as string,
            technology: (row[4] as string | null) ?? null,
            status: row[5] as RepoRow['status'],
            lastInitAt: (row[6] as number | null) ?? 0,
            errorMessage: (row[7] as string | null) ?? null,
            fallbackStatePath: (row[8] as string | null) ?? null,
            stateDbSchemaVersion: row[9] as number,
            summarySchemaVersion: row[10] as number,
            diff: (row[11] as RepoRow['diff']) ?? null,
        }));
    }

    getRepo(repoId: string): RepoRow | undefined {
        return this.listRepos().find((r) => r.repoId === repoId);
    }

    upsertRepo(row: RepoRow): void {
        if (!this.db) throw new Error('[AggregatorStore] upsertRepo before init');
        const stmt = this.db.prepare(
            `INSERT INTO repos (repo_id, name, root_path, realpath_hash, technology,
                status, last_init_at, error_message, fallback_state_path,
                state_db_schema_version, summary_schema_version, diff)
             VALUES ($id, $name, $rootPath, $hash, $tech, $status, $lastInit,
                     $err, $fallback, $stateVer, $sumVer, $diff)
             ON CONFLICT(repo_id) DO UPDATE SET
                name = excluded.name,
                root_path = excluded.root_path,
                realpath_hash = excluded.realpath_hash,
                technology = excluded.technology,
                status = excluded.status,
                last_init_at = excluded.last_init_at,
                error_message = excluded.error_message,
                fallback_state_path = excluded.fallback_state_path,
                state_db_schema_version = excluded.state_db_schema_version,
                summary_schema_version = excluded.summary_schema_version,
                diff = excluded.diff`,
        );
        stmt.run({
            $id: row.repoId,
            $name: row.name,
            $rootPath: row.rootPath,
            $hash: row.realpathHash,
            $tech: row.technology,
            $status: row.status,
            $lastInit: row.lastInitAt,
            $err: row.errorMessage,
            $fallback: row.fallbackStatePath,
            $stateVer: row.stateDbSchemaVersion,
            $sumVer: row.summarySchemaVersion,
            $diff: row.diff,
        });
        stmt.free();
    }

    deleteRepo(repoId: string): void {
        if (!this.db) throw new Error('[AggregatorStore] deleteRepo before init');
        const stmt = this.db.prepare(`DELETE FROM repos WHERE repo_id = ?`);
        stmt.run([repoId]);
        stmt.free();
    }

    // ─── Workspace mode ──────────────────────────────────────────────────

    getWorkspaceMode(): 'auto' | 'single' | 'multi' {
        // Override file wins. Fall back to settings table. Default 'auto'.
        const overridePath = path.join(this.storageDir, MODE_OVERRIDE_FILE);
        if (!this.inMemoryOnly && fs.existsSync(overridePath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
                if (parsed && (parsed.mode === 'single' || parsed.mode === 'multi' || parsed.mode === 'auto')) {
                    return parsed.mode;
                }
                this.log(`[AggregatorStore] workspace-mode.json malformed at ${overridePath}; falling back to auto`);
            } catch (err: any) {
                this.log(`[AggregatorStore] workspace-mode.json parse error (${err?.message ?? err}); falling back to auto`);
            }
        }
        if (!this.db) return 'auto';
        const res = this.db.exec(`SELECT value_json FROM settings WHERE key='workspace_mode'`);
        if (!res.length || !res[0].values.length) return 'auto';
        try {
            const parsed = JSON.parse(res[0].values[0][0] as string);
            if (parsed === 'single' || parsed === 'multi') return parsed;
        } catch { /* fall through */ }
        return 'auto';
    }

    setWorkspaceMode(mode: 'auto' | 'single' | 'multi'): void {
        if (!this.db) throw new Error('[AggregatorStore] setWorkspaceMode before init');
        const stmt = this.db.prepare(
            `INSERT INTO settings (key, value_json) VALUES ('workspace_mode', ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
        );
        stmt.run([JSON.stringify(mode)]);
        stmt.free();
    }

    // ─── Workspace-scope graphs ──────────────────────────────────────────

    getWorkingGraph(graphId: string): any | undefined {
        if (!this.db) return undefined;
        const stmt = this.db.prepare(`SELECT graph_json FROM graphs WHERE graph_id = ?`);
        stmt.bind([graphId]);
        if (stmt.step()) {
            const row = stmt.get();
            stmt.free();
            try { return JSON.parse(row[0] as string); }
            catch { return undefined; }
        }
        stmt.free();
        return undefined;
    }

    updateWorkingGraph(graphId: string, graph: any): void {
        if (!this.db) throw new Error('[AggregatorStore] updateWorkingGraph before init');
        const stmt = this.db.prepare(
            `INSERT INTO graphs (graph_id, graph_json) VALUES (?, ?)
             ON CONFLICT(graph_id) DO UPDATE SET graph_json = excluded.graph_json`,
        );
        stmt.run([graphId, JSON.stringify(graph)]);
        stmt.free();
    }

    removeWorkingGraph(graphId: string): void {
        if (!this.db) throw new Error('[AggregatorStore] removeWorkingGraph before init');
        const stmt = this.db.prepare(`DELETE FROM graphs WHERE graph_id = ?`);
        stmt.run([graphId]);
        stmt.free();
    }

    iterateWorkingGraphs(cb: (graphId: string, graph: any) => void): void {
        if (!this.db) return;
        const res = this.db.exec(`SELECT graph_id, graph_json FROM graphs`);
        if (!res.length) return;
        for (const row of res[0].values) {
            try { cb(row[0] as string, JSON.parse(row[1] as string)); }
            catch { /* skip malformed row */ }
        }
    }

    // ─── Cross-repo readers (Phase A: empty stubs) ───────────────────────

    listSharedExternals(): ReadonlyArray<SharedExternalRow> {
        if (!this.db) return [];
        const res = this.db.exec(`SELECT provider_id, name, category, consumers_json, diff FROM shared_externals`);
        if (!res.length) return [];
        return res[0].values.map((row) => ({
            providerId: row[0] as string,
            name: row[1] as string,
            category: row[2] as string,
            consumers: safeJsonArray(row[3] as string),
            diff: (row[4] as string | null) ?? null,
        }));
    }

    listSharedSchemas(): ReadonlyArray<SharedSchemaRow> {
        if (!this.db) return [];
        const res = this.db.exec(`SELECT engine, table_name, consumers_json, diff FROM shared_schemas`);
        if (!res.length) return [];
        return res[0].values.map((row) => ({
            engine: row[0] as string,
            tableName: row[1] as string,
            consumers: safeJsonArray(row[2] as string),
            diff: (row[3] as string | null) ?? null,
        }));
    }

    listCrossRepoHttpEdges(): ReadonlyArray<CrossRepoHttpEdgeRow> {
        if (!this.db) return [];
        const res = this.db.exec(`SELECT source_repo, target_repo, method, route, diff FROM cross_repo_http_edges`);
        if (!res.length) return [];
        return res[0].values.map((row) => ({
            sourceRepo: row[0] as string,
            targetRepo: row[1] as string,
            method: row[2] as string,
            route: row[3] as string,
            diff: (row[4] as string | null) ?? null,
        }));
    }

    getRepoSummary(repoId: string): RepoSummary | undefined {
        if (!this.db) return undefined;
        const stmt = this.db.prepare(`SELECT summary_json FROM repo_summaries WHERE repo_id = ?`);
        stmt.bind([repoId]);
        if (stmt.step()) {
            const row = stmt.get();
            stmt.free();
            try { return JSON.parse(row[0] as string) as RepoSummary; }
            catch { return undefined; }
        }
        stmt.free();
        return undefined;
    }

    setRepoSummary(repoId: string, summary: RepoSummary): void {
        if (!this.db) throw new Error('[AggregatorStore] setRepoSummary before init');
        const stmt = this.db.prepare(
            `INSERT INTO repo_summaries (repo_id, summary_json, summary_schema_version, received_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(repo_id) DO UPDATE SET
                summary_json = excluded.summary_json,
                summary_schema_version = excluded.summary_schema_version,
                received_at = excluded.received_at`,
        );
        stmt.run([repoId, JSON.stringify(summary), summary.schemaVersion, Date.now()]);
        stmt.free();
    }

    // ─── Phase C cross-repo writes ───────────────────────────────────────

    upsertSharedExternal(row: SharedExternalRow): void {
        if (!this.db) throw new Error('[AggregatorStore] upsertSharedExternal before init');
        const stmt = this.db.prepare(
            `INSERT INTO shared_externals (provider_id, name, category, consumers_json, diff)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(provider_id) DO UPDATE SET
                name = excluded.name,
                category = excluded.category,
                consumers_json = excluded.consumers_json,
                diff = excluded.diff`,
        );
        stmt.run([
            row.providerId, row.name, row.category,
            JSON.stringify([...row.consumers].sort()),
            row.diff ?? null,
        ]);
        stmt.free();
    }

    removeSharedExternal(providerId: string): void {
        if (!this.db) throw new Error('[AggregatorStore] removeSharedExternal before init');
        const stmt = this.db.prepare(`DELETE FROM shared_externals WHERE provider_id = ?`);
        stmt.run([providerId]);
        stmt.free();
    }

    upsertSharedSchema(row: SharedSchemaRow): void {
        if (!this.db) throw new Error('[AggregatorStore] upsertSharedSchema before init');
        const stmt = this.db.prepare(
            `INSERT INTO shared_schemas (engine, table_name, consumers_json, diff)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(engine, table_name) DO UPDATE SET
                consumers_json = excluded.consumers_json,
                diff = excluded.diff`,
        );
        stmt.run([
            row.engine, row.tableName,
            JSON.stringify([...row.consumers].sort()),
            row.diff ?? null,
        ]);
        stmt.free();
    }

    removeSharedSchema(engine: string, tableName: string): void {
        if (!this.db) throw new Error('[AggregatorStore] removeSharedSchema before init');
        const stmt = this.db.prepare(`DELETE FROM shared_schemas WHERE engine = ? AND table_name = ?`);
        stmt.run([engine, tableName]);
        stmt.free();
    }

    upsertCrossRepoHttpEdge(row: CrossRepoHttpEdgeRow): void {
        if (!this.db) throw new Error('[AggregatorStore] upsertCrossRepoHttpEdge before init');
        const stmt = this.db.prepare(
            `INSERT INTO cross_repo_http_edges (source_repo, target_repo, method, route, diff)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(source_repo, target_repo, method, route) DO UPDATE SET
                diff = excluded.diff`,
        );
        stmt.run([row.sourceRepo, row.targetRepo, row.method, row.route, row.diff ?? null]);
        stmt.free();
    }

    removeCrossRepoHttpEdgesFromSource(sourceRepo: string): void {
        if (!this.db) throw new Error('[AggregatorStore] removeCrossRepoHttpEdgesFromSource before init');
        const stmt = this.db.prepare(`DELETE FROM cross_repo_http_edges WHERE source_repo = ?`);
        stmt.run([sourceRepo]);
        stmt.free();
    }

    /**
     * Optional registry override — tests inject a fresh registry to
     * isolate analyzer interactions. Defaults to the module-scoped
     * `defaultCrossRepoRegistry` which is populated at extension boot.
     */
    private analyzerRegistry: CrossRepoAnalyzerRegistry = defaultCrossRepoRegistry;
    setAnalyzerRegistry(registry: CrossRepoAnalyzerRegistry): void {
        this.analyzerRegistry = registry;
    }

    applySummary(repoId: string, summary: RepoSummary): void {
        if (!this.db) throw new Error('[AggregatorStore] applySummary before init');
        const prior = this.getRepoSummary(repoId);
        this.setRepoSummary(repoId, summary);
        this.analyzerRegistry.runAll(repoId, summary, prior, this, (msg) => this.log(msg));
        // 2026-06-09 — propagate the summary's technology bucket onto the
        // `repos.technology` column so `listRepos()` + `buildWorkspaceMapGraph`
        // render the correct framework badge per node. Phase B's
        // `inferTechnology` left this column null; without this step the
        // workspace L1 / Map labels all show "«null»" (or fall back to
        // 'unknown') even after every per-repo summary has landed.
        if (summary.technology && summary.technology !== 'unknown') {
            try {
                const stmt = this.db.prepare(
                    `UPDATE repos SET technology = ? WHERE repo_id = ?`,
                );
                stmt.run([summary.technology, repoId]);
                stmt.free();
            } catch (err: any) {
                this.log(`[AggregatorStore] technology propagate failed for ${repoId}: ${err?.message ?? err}`);
            }
        }
        // ADR-034 Phase J — diff fields are derived state. Recompute after
        // every analyzer chain so the L1 + workspace map see fresh badges.
        try { this.recomputeDiffs(); }
        catch (err: any) { this.log(`[AggregatorStore] recomputeDiffs failed: ${err?.message ?? err}`); }
        // 2026-06-09 — persist after every applySummary. Without this,
        // the technology-propagation UPDATE + diff recompute only landed
        // on disk when WorkspaceOrchestrator did its periodic save (or
        // VS Code quit), so `monorepo.db.repos.technology` showed as
        // `null` to any concurrent reader (browser tab opened mid-init,
        // second VS Code window). Cheap — `db.export()` is in-memory.
        try { this.save(); }
        catch (err: any) { this.log(`[AggregatorStore] save after applySummary failed: ${err?.message ?? err}`); }
    }

    // ─── Phase G — workspace review guidelines ───────────────────────────

    getWorkspaceReviewGuidelines(): { text: string; hash: string; updatedAt: number } {
        if (!this.db) return { text: '', hash: '', updatedAt: 0 };
        const res = this.db.exec(`SELECT text, hash, updated_at FROM workspace_review_guidelines WHERE id = 1`);
        if (!res.length || !res[0].values.length) return { text: '', hash: '', updatedAt: 0 };
        const row = res[0].values[0];
        return {
            text: (row[0] as string | null) ?? '',
            hash: (row[1] as string | null) ?? '',
            updatedAt: (row[2] as number | null) ?? 0,
        };
    }

    setWorkspaceReviewGuidelines(text: string): { text: string; hash: string; updatedAt: number } {
        if (!this.db) throw new Error('[AggregatorStore] setWorkspaceReviewGuidelines before init');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const crypto = require('crypto');
        const hash = text ? crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) : '';
        const updatedAt = Date.now();
        const stmt = this.db.prepare(
            `INSERT INTO workspace_review_guidelines (id, text, hash, updated_at)
             VALUES (1, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                text = excluded.text,
                hash = excluded.hash,
                updated_at = excluded.updated_at`,
        );
        stmt.run([text, hash, updatedAt]);
        stmt.free();
        return { text, hash, updatedAt };
    }

    // ─── Phase G — workspace-scope AI review findings ────────────────────

    listWorkspaceFindings(): ReadonlyArray<{
        findingId: string;
        graphId: string;
        finding: any;
        status: string;
        createdAt: number;
        updatedAt: number;
    }> {
        if (!this.db) return [];
        const res = this.db.exec(
            `SELECT finding_id, graph_id, finding_json, status, created_at, updated_at
             FROM workspace_ai_review_findings ORDER BY created_at`,
        );
        if (!res.length) return [];
        return res[0].values.map((row) => ({
            findingId: row[0] as string,
            graphId: row[1] as string,
            finding: safeJsonObject(row[2] as string),
            status: row[3] as string,
            createdAt: (row[4] as number | null) ?? 0,
            updatedAt: (row[5] as number | null) ?? 0,
        }));
    }

    upsertWorkspaceFinding(row: {
        findingId: string;
        graphId: string;
        finding: any;
        status: string;
        createdAt?: number;
    }): void {
        if (!this.db) throw new Error('[AggregatorStore] upsertWorkspaceFinding before init');
        const now = Date.now();
        const stmt = this.db.prepare(
            `INSERT INTO workspace_ai_review_findings
                (finding_id, graph_id, finding_json, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(finding_id) DO UPDATE SET
                graph_id = excluded.graph_id,
                finding_json = excluded.finding_json,
                status = excluded.status,
                updated_at = excluded.updated_at`,
        );
        stmt.run([
            row.findingId, row.graphId, JSON.stringify(row.finding ?? {}),
            row.status, row.createdAt ?? now, now,
        ]);
        stmt.free();
    }

    removeWorkspaceFinding(findingId: string): void {
        if (!this.db) throw new Error('[AggregatorStore] removeWorkspaceFinding before init');
        const stmt = this.db.prepare(`DELETE FROM workspace_ai_review_findings WHERE finding_id = ?`);
        stmt.run([findingId]);
        stmt.free();
    }

    // ─── Phase J baseline accessors ──────────────────────────────────────

    listBaselineSharedExternals(): ReadonlyArray<SharedExternalRow> {
        if (!this.db) return [];
        const res = this.db.exec(
            `SELECT provider_id, name, category, consumers_json, diff
             FROM baseline_shared_externals ORDER BY provider_id`,
        );
        if (!res.length) return [];
        return res[0].values.map((row) => ({
            providerId: row[0] as string,
            name: row[1] as string,
            category: row[2] as string,
            consumers: safeJsonArray(row[3] as string),
            diff: (row[4] as string | null) ?? null,
        }));
    }

    listBaselineSharedSchemas(): ReadonlyArray<SharedSchemaRow> {
        if (!this.db) return [];
        const res = this.db.exec(
            `SELECT engine, table_name, consumers_json, diff
             FROM baseline_shared_schemas ORDER BY engine, table_name`,
        );
        if (!res.length) return [];
        return res[0].values.map((row) => ({
            engine: row[0] as string,
            tableName: row[1] as string,
            consumers: safeJsonArray(row[2] as string),
            diff: (row[3] as string | null) ?? null,
        }));
    }

    listBaselineCrossRepoHttpEdges(): ReadonlyArray<CrossRepoHttpEdgeRow> {
        if (!this.db) return [];
        const res = this.db.exec(
            `SELECT source_repo, target_repo, method, route, diff
             FROM baseline_cross_repo_http_edges
             ORDER BY source_repo, target_repo, method, route`,
        );
        if (!res.length) return [];
        return res[0].values.map((row) => ({
            sourceRepo: row[0] as string,
            targetRepo: row[1] as string,
            method: row[2] as string,
            route: row[3] as string,
            diff: (row[4] as string | null) ?? null,
        }));
    }

    getBaselineRepoSummary(repoId: string): RepoSummary | undefined {
        if (!this.db) return undefined;
        const stmt = this.db.prepare(
            `SELECT summary_json FROM baseline_repo_summaries WHERE repo_id = ?`,
        );
        stmt.bind([repoId]);
        if (stmt.step()) {
            const row = stmt.get();
            stmt.free();
            try { return JSON.parse(row[0] as string) as RepoSummary; }
            catch { return undefined; }
        }
        stmt.free();
        return undefined;
    }

    /**
     * Rotate working → baseline atomically. All five baseline_* tables
     * are TRUNCATEd + repopulated from their working counterparts in one
     * SQLite transaction. Working `.diff` fields stay populated — after
     * rotation the next analyzer run computes diff against the now-fresh
     * baseline (everything compares 'unchanged' immediately post-rotate).
     */
    recomputeDiffs(): void {
        if (!this.db) throw new Error('[AggregatorStore] recomputeDiffs before init');

        const consumerSetEqual = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
            if (a.length !== b.length) return false;
            const sortedA = [...a].sort();
            const sortedB = [...b].sort();
            for (let i = 0; i < sortedA.length; i++) {
                if (sortedA[i] !== sortedB[i]) return false;
            }
            return true;
        };

        // shared_externals
        {
            const working = this.listSharedExternals();
            const baselineByKey = new Map(
                this.listBaselineSharedExternals().map((b) => [b.providerId, b]),
            );
            for (const w of working) {
                const b = baselineByKey.get(w.providerId);
                let diff: 'added' | 'modified' | 'unchanged' = 'unchanged';
                if (!b) diff = 'added';
                else if (!consumerSetEqual(w.consumers, b.consumers)) diff = 'modified';
                if (diff !== (w.diff ?? 'unchanged')) {
                    this.upsertSharedExternal({ ...w, diff });
                }
                baselineByKey.delete(w.providerId);
            }
            // Remaining baseline entries → deleted placeholders in working.
            for (const b of baselineByKey.values()) {
                this.upsertSharedExternal({
                    providerId: b.providerId,
                    name: b.name,
                    category: b.category,
                    consumers: [],
                    diff: 'deleted',
                });
            }
        }

        // shared_schemas
        {
            const working = this.listSharedSchemas();
            const key = (e: string, t: string) => `${e} ${t}`;
            const baselineByKey = new Map(
                this.listBaselineSharedSchemas().map((b) => [key(b.engine, b.tableName), b]),
            );
            for (const w of working) {
                const k = key(w.engine, w.tableName);
                const b = baselineByKey.get(k);
                let diff: 'added' | 'modified' | 'unchanged' = 'unchanged';
                if (!b) diff = 'added';
                else if (!consumerSetEqual(w.consumers, b.consumers)) diff = 'modified';
                if (diff !== (w.diff ?? 'unchanged')) {
                    this.upsertSharedSchema({ ...w, diff });
                }
                baselineByKey.delete(k);
            }
            for (const b of baselineByKey.values()) {
                this.upsertSharedSchema({
                    engine: b.engine,
                    tableName: b.tableName,
                    consumers: [],
                    diff: 'deleted',
                });
            }
        }

        // cross_repo_http_edges — keyed by full tuple. Diff is presence-only
        // since the edge row carries no payload beyond identity.
        {
            const working = this.listCrossRepoHttpEdges();
            const key = (r: { sourceRepo: string; targetRepo: string; method: string; route: string }) =>
                `${r.sourceRepo} ${r.targetRepo} ${r.method} ${r.route}`;
            const baselineByKey = new Map(
                this.listBaselineCrossRepoHttpEdges().map((b) => [key(b), b]),
            );
            // #817 (2026-06-11) — hash-staleness for edges present in BOTH
            // working and baseline: compare the PRODUCER's working-vs-
            // baseline summary hash for the api the edge consumes. Before
            // this, the diff was presence-only and recomputeDiffs (running
            // after the analyzer chain inside every applySummary) silently
            // OVERWROTE the UX-67c analyzer's `modified` re-stamp —
            // producer surface changes never survived on the row, so the
            // #817 push had no transition to broadcast. Deriving the value
            // here keeps the Phase J "diff is derived state" philosophy
            // AND makes revert-clear automatic (hashes equal → unchanged).
            const summaryCache = new Map<string, { w: RepoSummary | undefined; b: RepoSummary | undefined }>();
            const producerHash = (summary: RepoSummary | undefined, method: string, route: string): string | undefined => {
                if (!summary?.apiHashes) return undefined;
                const want = `${method.toUpperCase()}|${normaliseRoutePath(route)}`;
                for (const api of summary.apis ?? []) {
                    if (`${api.method.toUpperCase()}|${normaliseRoutePath(api.route)}` === want) {
                        return summary.apiHashes[api.apiId];
                    }
                }
                return undefined;
            };
            for (const w of working) {
                const k = key(w);
                const exists = baselineByKey.has(k);
                let diff: 'added' | 'modified' | 'unchanged' = 'added';
                if (exists) {
                    let cached = summaryCache.get(w.targetRepo);
                    if (!cached) {
                        cached = { w: this.getRepoSummary(w.targetRepo), b: this.getBaselineRepoSummary(w.targetRepo) };
                        summaryCache.set(w.targetRepo, cached);
                    }
                    const hashNow = producerHash(cached.w, w.method, w.route);
                    const hashBase = producerHash(cached.b, w.method, w.route);
                    diff = (hashNow !== undefined && hashBase !== undefined && hashNow !== hashBase)
                        ? 'modified'
                        : 'unchanged';
                }
                if (diff !== (w.diff ?? 'unchanged')) {
                    this.upsertCrossRepoHttpEdge({ ...w, diff });
                }
                baselineByKey.delete(k);
            }
            for (const b of baselineByKey.values()) {
                this.upsertCrossRepoHttpEdge({
                    sourceRepo: b.sourceRepo,
                    targetRepo: b.targetRepo,
                    method: b.method,
                    route: b.route,
                    diff: 'deleted',
                });
            }
        }
    }

    // ─── Phase I — per-repo settings (dev_base_url) ──────────────────────

    getDevBaseUrl(repoId: string): string {
        if (!this.db) return '';
        const stmt = this.db.prepare(`SELECT dev_base_url FROM repo_settings WHERE repo_id = ?`);
        stmt.bind([repoId]);
        if (stmt.step()) {
            const row = stmt.get();
            stmt.free();
            return (row[0] as string | null) ?? '';
        }
        stmt.free();
        return '';
    }

    setDevBaseUrl(repoId: string, url: string): void {
        if (!this.db) throw new Error('[AggregatorStore] setDevBaseUrl before init');
        const stmt = this.db.prepare(
            `INSERT INTO repo_settings (repo_id, dev_base_url, settings_json, updated_at)
             VALUES (?, ?, '{}', ?)
             ON CONFLICT(repo_id) DO UPDATE SET
                dev_base_url = excluded.dev_base_url,
                updated_at = excluded.updated_at`,
        );
        stmt.run([repoId, url, Date.now()]);
        stmt.free();
    }

    // ─── Phase I — saved API-testing chains ──────────────────────────────

    listApiTestingChains(): ReadonlyArray<SavedApiTestingChain> {
        if (!this.db) return [];
        const res = this.db.exec(
            `SELECT chain_id, name, steps_json, env_text, updated_at
             FROM api_testing_chains ORDER BY updated_at DESC`,
        );
        if (!res.length) return [];
        return res[0].values.map((row) => ({
            chainId: row[0] as string,
            name: row[1] as string,
            stepsJson: row[2] as string,
            envText: (row[3] as string | null) ?? '',
            updatedAt: (row[4] as number | null) ?? 0,
        }));
    }

    getApiTestingChain(chainId: string): SavedApiTestingChain | undefined {
        if (!this.db) return undefined;
        const stmt = this.db.prepare(
            `SELECT chain_id, name, steps_json, env_text, updated_at
             FROM api_testing_chains WHERE chain_id = ?`,
        );
        stmt.bind([chainId]);
        if (stmt.step()) {
            const row = stmt.get();
            stmt.free();
            return {
                chainId: row[0] as string,
                name: row[1] as string,
                stepsJson: row[2] as string,
                envText: (row[3] as string | null) ?? '',
                updatedAt: (row[4] as number | null) ?? 0,
            };
        }
        stmt.free();
        return undefined;
    }

    saveApiTestingChain(chain: SavedApiTestingChain): void {
        if (!this.db) throw new Error('[AggregatorStore] saveApiTestingChain before init');
        const stmt = this.db.prepare(
            `INSERT INTO api_testing_chains (chain_id, name, steps_json, env_text, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(chain_id) DO UPDATE SET
                name = excluded.name,
                steps_json = excluded.steps_json,
                env_text = excluded.env_text,
                updated_at = excluded.updated_at`,
        );
        stmt.run([
            chain.chainId, chain.name, chain.stepsJson, chain.envText,
            chain.updatedAt || Date.now(),
        ]);
        stmt.free();
    }

    deleteApiTestingChain(chainId: string): void {
        if (!this.db) throw new Error('[AggregatorStore] deleteApiTestingChain before init');
        const stmt = this.db.prepare(`DELETE FROM api_testing_chains WHERE chain_id = ?`);
        stmt.run([chainId]);
        stmt.free();
    }

    /**
     * #817 (2026-06-11) — true when a baseline rotation has ever happened
     * (any baseline_* row exists). Used by the init pipeline to rotate
     * ONCE on first init: without a baseline every cross-repo edge reads
     * `added` forever (rotation previously only happened on manual
     * resync), which made the hash-staleness diff meaningless.
     */
    hasBaseline(): boolean {
        if (!this.db) return false;
        try {
            const stmt = this.db.prepare(`SELECT
                (SELECT count(*) FROM baseline_repo_summaries)
                + (SELECT count(*) FROM baseline_cross_repo_http_edges)
                + (SELECT count(*) FROM baseline_shared_externals)`);
            stmt.step();
            const row = stmt.get();
            stmt.free();
            return Number(row[0]) > 0;
        } catch {
            return false;
        }
    }

    rotateBaseline(): void {
        if (!this.db) throw new Error('[AggregatorStore] rotateBaseline before init');
        this.db.exec('BEGIN TRANSACTION');
        try {
            this.db.exec(`DELETE FROM baseline_shared_externals`);
            this.db.exec(`INSERT INTO baseline_shared_externals (provider_id, name, category, consumers_json, diff)
                          SELECT provider_id, name, category, consumers_json, NULL FROM shared_externals`);
            this.db.exec(`DELETE FROM baseline_shared_schemas`);
            this.db.exec(`INSERT INTO baseline_shared_schemas (engine, table_name, consumers_json, diff)
                          SELECT engine, table_name, consumers_json, NULL FROM shared_schemas`);
            this.db.exec(`DELETE FROM baseline_cross_repo_http_edges`);
            this.db.exec(`INSERT INTO baseline_cross_repo_http_edges (source_repo, target_repo, method, route, diff)
                          SELECT source_repo, target_repo, method, route, NULL FROM cross_repo_http_edges`);
            this.db.exec(`DELETE FROM baseline_repo_summaries`);
            this.db.exec(`INSERT INTO baseline_repo_summaries (repo_id, summary_json, summary_schema_version, received_at)
                          SELECT repo_id, summary_json, summary_schema_version, received_at FROM repo_summaries`);
            this.db.exec(`DELETE FROM baseline_graphs`);
            this.db.exec(`INSERT INTO baseline_graphs (graph_id, graph_json)
                          SELECT graph_id, graph_json FROM graphs`);
            // Working .diff fields are cleared here too — analyzers
            // recompute on the next apply against the now-fresh baseline.
            this.db.exec(`UPDATE shared_externals SET diff = NULL`);
            this.db.exec(`UPDATE shared_schemas SET diff = NULL`);
            this.db.exec(`UPDATE cross_repo_http_edges SET diff = NULL`);
            this.db.exec('COMMIT');
        } catch (err: any) {
            try { this.db.exec('ROLLBACK'); } catch { /* best-effort */ }
            throw err;
        }
    }
}

function safeJsonObject(s: string): any {
    try { return JSON.parse(s); } catch { return {}; }
}

function safeJsonArray(s: string): ReadonlyArray<string> {
    try {
        const parsed = JSON.parse(s);
        return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
    } catch {
        return [];
    }
}
