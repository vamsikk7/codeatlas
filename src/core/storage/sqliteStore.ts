/**
 * sqliteStore.ts
 *
 * SQLite-backed (sql.js / WASM) consolidated persistence for everything that
 * used to live across `.codeatlas/state.json`, `git-diff-state.json`,
 * `llm-names.json`, `change-log.json`, and the comments cache.
 *
 * Design principles (per Issue #348 + user direction):
 *  1. **One backend** — every persisted store goes through this class. No
 *     parallel JSON write paths.
 *  2. **git_ref tagging** — every row that represents user-meaningful state
 *     carries a FK to `git_refs(id)`. The SHA of HEAD at save time is the
 *     anchor; the `pre-git` sentinel is used for non-repo / no-commits.
 *  3. **Cascade clear** — `Storage.clear()` is `DELETE FROM git_refs`. FK
 *     `ON DELETE CASCADE` then nukes every child row. There is no half-
 *     cleared state ever.
 *  4. **Schema versioning** — `PRAGMA user_version` drives migrations on
 *     open. Bump `CURRENT_SCHEMA_VERSION` whenever a CREATE/ALTER lands.
 *  5. **Atomic on-disk write** — sql.js is in-memory; `flush()` exports
 *     the DB bytes and writes them via tmp + rename so a crash mid-flush
 *     never leaves a torn file.
 */

import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { GitRefProvider, PRE_GIT_REF } from './gitRefProvider';

const STORAGE_DIR = '.codeatlas';
const DB_FILE = 'state.db';

/** Bump when schema changes incompatibly. */
export const CURRENT_SCHEMA_VERSION = 10;

const SCHEMA_V1 = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS git_refs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sha          TEXT    NOT NULL UNIQUE,
    captured_at  INTEGER NOT NULL
);

-- Exactly two rows expected: 'baseline' and 'working'.
CREATE TABLE IF NOT EXISTS snapshots (
    kind            TEXT    PRIMARY KEY CHECK (kind IN ('baseline', 'working')),
    git_ref_id      INTEGER NOT NULL REFERENCES git_refs(id) ON DELETE CASCADE,
    schema_version  INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

-- record_json holds metadata only (path, hash, mtime, symbols).
-- content lives in a separate column so it can be lazy-loaded — keeping it
-- out of the in-memory snapshot is the single biggest memory win for large
-- workspaces. NULL allowed for the rare metadata-only record.
CREATE TABLE IF NOT EXISTS files (
    snapshot_kind  TEXT NOT NULL REFERENCES snapshots(kind) ON DELETE CASCADE,
    path           TEXT NOT NULL,
    record_json    TEXT NOT NULL,
    content        TEXT,
    PRIMARY KEY (snapshot_kind, path)
);

CREATE TABLE IF NOT EXISTS apis (
    snapshot_kind  TEXT NOT NULL REFERENCES snapshots(kind) ON DELETE CASCADE,
    api_id         TEXT NOT NULL,
    record_json    TEXT NOT NULL,
    PRIMARY KEY (snapshot_kind, api_id)
);

CREATE TABLE IF NOT EXISTS graphs (
    snapshot_kind  TEXT NOT NULL REFERENCES snapshots(kind) ON DELETE CASCADE,
    graph_id       TEXT NOT NULL,
    graph_json     TEXT NOT NULL,
    PRIMARY KEY (snapshot_kind, graph_id)
);

CREATE TABLE IF NOT EXISTS clusters (
    snapshot_kind  TEXT NOT NULL REFERENCES snapshots(kind) ON DELETE CASCADE,
    cluster_id     TEXT NOT NULL,
    cluster_json   TEXT NOT NULL,
    PRIMARY KEY (snapshot_kind, cluster_id)
);

-- Issue #701 + #734 — business-intent Domain clusters. Sit parallel to
-- the structural 'clusters' table (Louvain output) and persist both the
-- heuristic + the optional LLM-refined output. Same shape as 'clusters'
-- so the snapshot store can reuse the bulk-DML pattern verbatim. Without
-- this table the LLM-refined names disappear on VS Code reload; the
-- heuristic alone re-derives correctly on every init.
CREATE TABLE IF NOT EXISTS domains (
    snapshot_kind  TEXT NOT NULL REFERENCES snapshots(kind) ON DELETE CASCADE,
    domain_id      TEXT NOT NULL,
    domain_json    TEXT NOT NULL,
    PRIMARY KEY (snapshot_kind, domain_id)
);

CREATE TABLE IF NOT EXISTS services (
    snapshot_kind  TEXT NOT NULL REFERENCES snapshots(kind) ON DELETE CASCADE,
    service_id     TEXT NOT NULL,
    service_json   TEXT NOT NULL,
    PRIMARY KEY (snapshot_kind, service_id)
);

-- v2 phase 3 (#484) — per-screen records for FE/mobile services.
-- Backend services produce zero rows here. Populated by the
-- screenDetector module during initialize() and per-file rebuild.
CREATE TABLE IF NOT EXISTS screens (
    snapshot_kind  TEXT NOT NULL REFERENCES snapshots(kind) ON DELETE CASCADE,
    screen_id      TEXT NOT NULL,
    screen_json    TEXT NOT NULL,
    PRIMARY KEY (snapshot_kind, screen_id)
);

-- v2 phase 4 (#485) — per-screen L2b content items for FE/mobile.
-- One row per screen; payload is a JSON array of L2bScreenItem so the
-- L2b panel can scope items to the active L2a screen with a single
-- SELECT. Backend services produce zero rows here.
CREATE TABLE IF NOT EXISTS screen_items (
    snapshot_kind  TEXT NOT NULL REFERENCES snapshots(kind) ON DELETE CASCADE,
    screen_id      TEXT NOT NULL,
    items_json     TEXT NOT NULL,
    PRIMARY KEY (snapshot_kind, screen_id)
);

-- callGraph and health are 0..1 per snapshot; one row per (kind, name).
CREATE TABLE IF NOT EXISTS singletons (
    snapshot_kind  TEXT NOT NULL REFERENCES snapshots(kind) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    payload_json   TEXT NOT NULL,
    PRIMARY KEY (snapshot_kind, name)
);

CREATE TABLE IF NOT EXISTS comments (
    id              TEXT    PRIMARY KEY,
    git_ref_id      INTEGER NOT NULL REFERENCES git_refs(id) ON DELETE CASCADE,
    comment_json    TEXT    NOT NULL,
    -- #223: append-only audit trail of historical anchor positions. Each
    -- entry is {anchor, capturedAt, reason} JSON pushed onto an array
    -- whenever reanchor() moves the comment. NULL until first re-anchor.
    anchor_history  TEXT,
    created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_cluster_names (
    membership_hash  TEXT    PRIMARY KEY,
    git_ref_id       INTEGER NOT NULL REFERENCES git_refs(id) ON DELETE CASCADE,
    name             TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_service_descriptions (
    service_id   TEXT    PRIMARY KEY,
    git_ref_id   INTEGER NOT NULL REFERENCES git_refs(id) ON DELETE CASCADE,
    description  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_api_annotations (
    api_id      TEXT    PRIMARY KEY,
    git_ref_id  INTEGER NOT NULL REFERENCES git_refs(id) ON DELETE CASCADE,
    annotation  TEXT    NOT NULL
);

-- At most one active diff session at a time → fixed PK = 1.
CREATE TABLE IF NOT EXISTS git_diff_sessions (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    base_hash   TEXT    NOT NULL,
    head_hash   TEXT    NOT NULL,
    base_label  TEXT    NOT NULL,
    head_label  TEXT    NOT NULL,
    git_ref_id  INTEGER NOT NULL REFERENCES git_refs(id) ON DELETE CASCADE,
    state_json  TEXT    NOT NULL
);

-- UX-64 Phase 3 (2026-06-09) — multi-scope diff sessions. Replaces the
-- single-row legacy table above by keying on scope (typically a sub-
-- repo name like api-svc, or "workspace" for the workspace-wide slot).
-- Allows multiple concurrent per-repo diff sessions to coexist on disk so
-- a browser tab reopened mid-flow restores the right session, rather than
-- the LAST-written one (the prior id = 1 PK constraint had no notion of
-- scope). The legacy table stays in place so older state.db files load
-- without a re-init; GitDiffStore.load() reads v2 first and falls back
-- to v1 + the legacy json file.
CREATE TABLE IF NOT EXISTS git_diff_sessions_v2 (
    scope       TEXT    PRIMARY KEY,
    base_hash   TEXT    NOT NULL,
    head_hash   TEXT    NOT NULL,
    base_label  TEXT    NOT NULL,
    head_label  TEXT    NOT NULL,
    git_ref_id  INTEGER NOT NULL REFERENCES git_refs(id) ON DELETE CASCADE,
    state_json  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS change_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id      TEXT    NOT NULL UNIQUE,
    git_ref_id    INTEGER NOT NULL REFERENCES git_refs(id) ON DELETE CASCADE,
    timestamp     INTEGER NOT NULL,
    payload_json  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_log_ts ON change_log(timestamp);

-- Never tied to a git_ref — these are workspace-wide preferences.
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value_json  TEXT NOT NULL
);

-- #498/#499 — AI review findings. snapshot_kind separates baseline vs working
-- findings, mirroring the apis/files/graphs/clusters tables. status drives
-- the open/resolved/ignored panel filter. guidelines_hash lets us invalidate
-- a finding when the user edits the guidelines.
CREATE TABLE IF NOT EXISTS ai_review_findings (
    snapshot_kind     TEXT    NOT NULL CHECK (snapshot_kind IN ('baseline', 'working')),
    id                TEXT    NOT NULL,
    git_ref_id        INTEGER NOT NULL REFERENCES git_refs(id) ON DELETE CASCADE,
    entry_point_id    TEXT    NOT NULL,
    finding_json      TEXT    NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'open',
    model             TEXT,
    guidelines_hash   TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (snapshot_kind, id)
);
CREATE INDEX IF NOT EXISTS idx_ai_findings_entry ON ai_review_findings(snapshot_kind, entry_point_id);
CREATE INDEX IF NOT EXISTS idx_ai_findings_status ON ai_review_findings(snapshot_kind, status);

-- #505 — single-row user-supplied review guidelines text (workspace-wide).
CREATE TABLE IF NOT EXISTS review_guidelines (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    text         TEXT    NOT NULL DEFAULT '',
    hash         TEXT    NOT NULL DEFAULT '',
    updated_at   INTEGER NOT NULL
);
-- #813 (2026-06-10) — per-scope guidelines for monorepo workspaces.
-- The scope column holds the sub-repo hex repoId. Workspace-wide
-- guidelines stay in the table above so legacy reads continue to
-- work without a fallback chain.
CREATE TABLE IF NOT EXISTS review_guidelines_scoped (
    scope        TEXT    PRIMARY KEY,
    text         TEXT    NOT NULL DEFAULT '',
    hash         TEXT    NOT NULL DEFAULT '',
    updated_at   INTEGER NOT NULL
);

-- #535 — last successful AI-review signature. Used to detect re-runs against
-- the same (guidelines, baseline) and skip the LLM with a "Nothing changed"
-- toast instead of producing duplicate findings.
CREATE TABLE IF NOT EXISTS ai_review_signature (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    guidelines_hash   TEXT    NOT NULL DEFAULT '',
    baseline_kind     TEXT    NOT NULL DEFAULT '',
    baseline_ref      TEXT    NOT NULL DEFAULT '',
    findings_count    INTEGER NOT NULL DEFAULT 0,
    completed_at      INTEGER NOT NULL DEFAULT 0
);

-- #606 / #606-SYNTHETIC — per-entry-point review cursor for cascade-aware
-- incremental review. Keyed by api_id (globally unique per ApiRecord —
-- includes file path + symbol for synthetic entries) so multiple call sites
-- sharing the same method:route can each track their own review state.
-- entry_point_id is denormalised alongside so finding cleanup on cursor
-- delete doesn't need an apiIndex lookup. handler_hash is a deterministic
-- digest of the entry's file content + span; when it differs from the
-- current hash the entry counts as "changed" and the LLM is invoked.
CREATE TABLE IF NOT EXISTS ai_review_entry_cursor (
    api_id            TEXT    PRIMARY KEY,
    entry_point_id    TEXT    NOT NULL,
    handler_hash      TEXT    NOT NULL,
    guidelines_hash   TEXT    NOT NULL DEFAULT '',
    baseline_kind     TEXT    NOT NULL DEFAULT '',
    baseline_ref      TEXT    NOT NULL DEFAULT '',
    reviewed_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_cursor_epid ON ai_review_entry_cursor(entry_point_id);
`;

let sqlJsModule: SqlJsStatic | null = null;

/**
 * ADR-034 Phase A — exported so `AggregatorStore` can share the same WASM
 * bootstrap (one-time module load, same lookup paths) without owning a
 * duplicate copy of the locate-WASM logic.
 */
export async function loadSqlJs(): Promise<SqlJsStatic> { return loadSqlJsImpl(); }

async function loadSqlJsImpl(): Promise<SqlJsStatic> {
    if (sqlJsModule) return sqlJsModule;
    // The WASM file is copied into dist/ alongside extension.js by esbuild.js.
    // In tests / non-bundled execution, fall back to the node_modules copy.
    const candidates = [
        path.join(__dirname, 'sql-wasm.wasm'),
        path.join(__dirname, '..', '..', '..', 'dist', 'sql-wasm.wasm'),
        path.join(__dirname, '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    ];
    const wasmPath = candidates.find(p => fs.existsSync(p));
    if (!wasmPath) {
        throw new Error('[SqliteStore] sql-wasm.wasm not found in dist/ or node_modules/');
    }
    sqlJsModule = await initSqlJs({ locateFile: () => wasmPath });
    return sqlJsModule!;
}

/** For tests that want to swap WASM bootstrapping or reset module state. */
export function _resetSqlJsForTests(): void {
    sqlJsModule = null;
}

export class SqliteStore {
    private readonly workspaceRoot: string;
    private readonly storageDir: string;
    private readonly dbPath: string;
    private readonly refProvider: GitRefProvider;
    private db: Database | null = null;
    private log: (msg: string) => void = () => { /* noop */ };
    /** #351: when true, flush() is a no-op — DB lives only in memory. */
    private inMemoryOnly: boolean;

    /**
     * @param storageDirName overrides the default `.codeatlas` directory. The
     *     standalone npm package (`@codeatlas/mcp`) passes `.codeatlas-sa` so
     *     it shares a workspace with the VS Code extension without SQLite WAL
     *     lock contention. Defaults to `.codeatlas` when omitted so the
     *     extension path is unchanged.
     */
    constructor(
        workspaceRoot: string,
        refProvider: GitRefProvider,
        inMemoryOnly: boolean = false,
        storageDirName: string = STORAGE_DIR,
    ) {
        this.workspaceRoot = workspaceRoot;
        this.storageDir = path.join(workspaceRoot, storageDirName);
        this.dbPath = path.join(this.storageDir, DB_FILE);
        this.refProvider = refProvider;
        this.inMemoryOnly = inMemoryOnly;
    }

    setLogger(logger: (msg: string) => void): void {
        this.log = logger;
        this.refProvider.setLogger(logger);
    }

    /** Open or create the on-disk DB and apply pending migrations. */
    async init(): Promise<void> {
        const SQL = await loadSqlJs();
        if (this.inMemoryOnly) {
            // #351: never read the on-disk file in memory mode — start fresh
            // every activation. Workspace scan repopulates state.
            this.db = new SQL.Database();
            this.exec('PRAGMA foreign_keys = ON;');
            this.runMigrations();
            return;
        }
        if (!fs.existsSync(this.storageDir)) {
            fs.mkdirSync(this.storageDir, { recursive: true });
        }
        if (fs.existsSync(this.dbPath)) {
            const bytes = fs.readFileSync(this.dbPath);
            try {
                this.db = new SQL.Database(new Uint8Array(bytes));
            } catch (err: any) {
                this.log(`[SqliteStore] DB at ${this.dbPath} is corrupt (${err?.message ?? err}); starting fresh`);
                this.db = new SQL.Database();
            }
        } else {
            this.db = new SQL.Database();
        }
        // Foreign keys must be re-enabled per connection.
        this.exec('PRAGMA foreign_keys = ON;');
        this.runMigrations();
    }

    /** True between `init()` and `close()`. Lets callers skip DB-backed paths. */
    isOpen(): boolean {
        return this.db !== null;
    }

    /** Close the connection. After this, only `init()` is callable. */
    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    /**
     * Persist the in-memory DB to disk under a lightweight file lock so
     * concurrent VS Code windows on the same workspace can't lose writes.
     * #191: lock is implemented as `state.db.lock` exclusive-create with
     * PID + heartbeat; stale locks (>30s mtime) are reclaimed automatically.
     * #184: POSIX uses tmp + atomic rename; on Windows `rename` falls back
     * to copy + delete with retries on EBUSY/EPERM/EACCES.
     */
    flush(): void {
        if (!this.db) throw new Error('[SqliteStore] flush() called before init()');
        // #351: skip persistence entirely in in-memory mode. State lives
        // only for the current session; reactivation walks the workspace
        // and rebuilds from source.
        if (this.inMemoryOnly) return;
        this.withFileLock(() => {
            const bytes = this.db!.export();
            const tmp = this.dbPath + '.tmp';
            fs.writeFileSync(tmp, Buffer.from(bytes));
            if (process.platform === 'win32') {
                this.flushWin32(tmp);
            } else {
                fs.renameSync(tmp, this.dbPath);
            }
        });
    }

    private withFileLock(fn: () => void): void {
        const lockPath = this.dbPath + '.lock';
        const maxAttempts = 20;
        const staleAfterMs = 30_000;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                // O_EXCL: succeeds only if the lock doesn't already exist.
                fs.writeFileSync(lockPath, `${process.pid}@${Date.now()}`, { flag: 'wx' });
                try { fn(); }
                finally {
                    try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
                }
                return;
            } catch (err: any) {
                if (err && err.code !== 'EEXIST') throw err;
                // Lock exists; check if it's stale.
                try {
                    const stat = fs.statSync(lockPath);
                    if (Date.now() - stat.mtimeMs > staleAfterMs) {
                        try { fs.unlinkSync(lockPath); } catch { /* race */ }
                        continue;
                    }
                } catch { /* lock vanished between EEXIST and statSync — retry */ }
                // Spin-wait with linear backoff (50ms × attempt).
                const start = Date.now();
                const delay = 50 * (attempt + 1);
                while (Date.now() - start < delay) { /* noop */ }
            }
        }
        // Lock acquisition failed: degrade gracefully — write directly. The
        // worst case here is the same as before #191 (last-writer-wins).
        this.log(`[SqliteStore] Lock acquisition failed after ${maxAttempts} attempts; proceeding without lock`);
        fn();
    }

    private flushWin32(tmp: string): void {
        // Windows: rename() fails with EBUSY/EPERM if the destination is
        // open. Retry up to 5 times with a short backoff, then fall back to
        // copy + delete which doesn't need exclusive access on the dest.
        const maxRetries = 5;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                fs.renameSync(tmp, this.dbPath);
                return;
            } catch (err: any) {
                const code = err && typeof err === 'object' ? err.code : '';
                if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw err;
                if (attempt === maxRetries - 1) {
                    // Last-ditch: overwrite the destination by copying tmp
                    // contents into it, then unlink tmp.
                    try {
                        fs.copyFileSync(tmp, this.dbPath);
                        fs.unlinkSync(tmp);
                        return;
                    } catch (copyErr: any) {
                        this.log(`[SqliteStore] win32 flush fallback failed: ${copyErr?.message ?? copyErr}`);
                        throw err;
                    }
                }
                // Synchronous backoff (10ms × attempt).
                const start = Date.now();
                while (Date.now() - start < 10 * (attempt + 1)) { /* spin */ }
            }
        }
    }

    /**
     * Atomically purge ALL state. After this call every table is empty,
     * including git_refs. This is the contract for resync / reinit / reset.
     *
     * NOTE: VACUUM intentionally omitted — sql.js defers VACUUM in some
     * paths and we'd rather have a deterministic clear. Compaction comes
     * for free on the next flush() since we re-export the entire DB.
     */
    clear(): void {
        if (!this.db) throw new Error('[SqliteStore] clear() called before init()');
        // Delete child tables first to be defensive against any FK config drift,
        // even though `ON DELETE CASCADE` would do the work via git_refs alone.
        this.exec(`
            DELETE FROM change_log;
            DELETE FROM git_diff_sessions;
            DELETE FROM git_diff_sessions_v2;
            DELETE FROM llm_api_annotations;
            DELETE FROM llm_service_descriptions;
            DELETE FROM llm_cluster_names;
            DELETE FROM comments;
            DELETE FROM singletons;
            DELETE FROM services;
            DELETE FROM clusters;
            DELETE FROM graphs;
            DELETE FROM apis;
            DELETE FROM files;
            DELETE FROM snapshots;
            DELETE FROM git_refs;
            DELETE FROM settings;
            DELETE FROM sqlite_sequence;
        `);
        this.refProvider.invalidate();
    }

    /**
     * Look up or insert the git_ref row for the current HEAD SHA.
     * Returns the rowid that child rows should reference.
     */
    currentGitRefId(): number {
        if (!this.db) throw new Error('[SqliteStore] currentGitRefId() called before init()');
        const sha = this.refProvider.current();
        return this.upsertGitRef(sha);
    }

    /** Insert (or fetch existing) a git_ref row by SHA. Public for tests/imports. */
    upsertGitRef(sha: string): number {
        if (!this.db) throw new Error('[SqliteStore] upsertGitRef() called before init()');
        const safeSha = sha === PRE_GIT_REF || /^[0-9a-fA-F]{40}$/.test(sha) ? sha : PRE_GIT_REF;
        const existing = this.get('SELECT id FROM git_refs WHERE sha = ?', [safeSha]);
        if (existing && typeof existing.id === 'number') return existing.id;
        this.run('INSERT INTO git_refs (sha, captured_at) VALUES (?, ?)', [safeSha, Date.now()]);
        const inserted = this.get('SELECT id FROM git_refs WHERE sha = ?', [safeSha]);
        if (!inserted || typeof inserted.id !== 'number') {
            throw new Error(`[SqliteStore] upsertGitRef failed for sha=${safeSha}`);
        }
        return inserted.id;
    }

    // ─── low-level helpers ──────────────────────────────────────────────────

    /** Execute one or more SQL statements with no result. */
    exec(sql: string): void {
        if (!this.db) throw new Error('[SqliteStore] exec() called before init()');
        this.db.exec(sql);
    }

    /** Run a parameterized statement with no result. */
    run(sql: string, params: ReadonlyArray<string | number | null>): void {
        if (!this.db) throw new Error('[SqliteStore] run() called before init()');
        const stmt = this.db.prepare(sql);
        try {
            stmt.run(params as any);
        } finally {
            stmt.free();
        }
    }

    /** Fetch the first row as an object, or undefined if no rows. */
    get(sql: string, params: ReadonlyArray<string | number | null> = []): Record<string, any> | undefined {
        if (!this.db) throw new Error('[SqliteStore] get() called before init()');
        const stmt = this.db.prepare(sql);
        try {
            stmt.bind(params as any);
            if (stmt.step()) return stmt.getAsObject();
            return undefined;
        } finally {
            stmt.free();
        }
    }

    /** Fetch all rows as an array of objects. */
    all(sql: string, params: ReadonlyArray<string | number | null> = []): Record<string, any>[] {
        if (!this.db) throw new Error('[SqliteStore] all() called before init()');
        const stmt = this.db.prepare(sql);
        const rows: Record<string, any>[] = [];
        try {
            stmt.bind(params as any);
            while (stmt.step()) rows.push(stmt.getAsObject());
            return rows;
        } finally {
            stmt.free();
        }
    }

    /**
     * Prepare a statement and return it to the caller as a streaming
     * iterator. Caller MUST call `.free()` when done. Use only for
     * cursor-style iteration (`while (stmt.step()) { stmt.getAsObject() }`)
     * — for any other shape, prefer `all()` / `get()`.
     */
    prepareIterator(sql: string, params: ReadonlyArray<string | number | null> = []): import('sql.js').Statement {
        if (!this.db) throw new Error('[SqliteStore] prepareIterator() called before init()');
        const stmt = this.db.prepare(sql);
        stmt.bind(params as any);
        return stmt;
    }

    /** Run a function inside a SAVEPOINT. Roll back on throw. */
    transaction<T>(fn: () => T): T {
        if (!this.db) throw new Error('[SqliteStore] transaction() called before init()');
        const sp = `tx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        this.exec(`SAVEPOINT ${sp}`);
        try {
            const result = fn();
            this.exec(`RELEASE SAVEPOINT ${sp}`);
            return result;
        } catch (err) {
            this.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp};`);
            throw err;
        }
    }

    // ─── migrations ─────────────────────────────────────────────────────────

    private runMigrations(): void {
        const userVersionRow = this.get('PRAGMA user_version');
        const current = userVersionRow ? Number(userVersionRow.user_version ?? 0) : 0;
        if (current > CURRENT_SCHEMA_VERSION) {
            // DB was written by a newer extension. Refuse to downgrade.
            throw new Error(`[SqliteStore] DB schema_version=${current} is newer than supported ${CURRENT_SCHEMA_VERSION}`);
        }
        if (current === CURRENT_SCHEMA_VERSION) return;
        // V0/V1 → current: SCHEMA_V1 is idempotent for tables that already
        // exist (CREATE TABLE IF NOT EXISTS). For new columns added in v2+,
        // ALTER TABLE statements run additionally.
        this.exec(SCHEMA_V1);
        if (current < 2) {
            // #223 — anchor_history column on comments. ALTER guards against
            // the column already existing on a fresh DB created above.
            const cols = this.all(`PRAGMA table_info(comments)`);
            if (!cols.some(c => c.name === 'anchor_history')) {
                this.exec(`ALTER TABLE comments ADD COLUMN anchor_history TEXT`);
            }
        }
        if (current < 3) {
            // #504 — `source` column on comments distinguishes user vs AI
            // comments. ALTER guards against the column already existing on
            // a fresh DB created above. SCHEMA_V1 already includes the
            // ai_review_findings + review_guidelines tables via IF NOT EXISTS.
            const cols = this.all(`PRAGMA table_info(comments)`);
            if (!cols.some(c => c.name === 'source')) {
                this.exec(`ALTER TABLE comments ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`);
            }
        }
        if (current < 4) {
            // #535 — ai_review_signature single-row table for dedup. SCHEMA_V1
            // already includes the CREATE; we just need to ensure it's run on
            // pre-v4 DBs that already passed the `current === CURRENT_SCHEMA_VERSION`
            // gate before this table existed. Idempotent via IF NOT EXISTS.
            this.exec(`CREATE TABLE IF NOT EXISTS ai_review_signature (
                id                INTEGER PRIMARY KEY CHECK (id = 1),
                guidelines_hash   TEXT    NOT NULL DEFAULT '',
                baseline_kind     TEXT    NOT NULL DEFAULT '',
                baseline_ref      TEXT    NOT NULL DEFAULT '',
                findings_count    INTEGER NOT NULL DEFAULT 0,
                completed_at      INTEGER NOT NULL DEFAULT 0
            );`);
        }
        if (current < 5) {
            // #606 — per-entry-point review cursor for incremental review.
            // v5 schema (now superseded by v6 — kept for the rare case where
            // a workspace migrated to v5 then was rolled back; the v5 → v6
            // block below drops and recreates with the new key).
            this.exec(`CREATE TABLE IF NOT EXISTS ai_review_entry_cursor (
                entry_point_id    TEXT    PRIMARY KEY,
                handler_hash      TEXT    NOT NULL,
                guidelines_hash   TEXT    NOT NULL DEFAULT '',
                baseline_kind     TEXT    NOT NULL DEFAULT '',
                baseline_ref      TEXT    NOT NULL DEFAULT '',
                reviewed_at       INTEGER NOT NULL
            );`);
        }
        if (current < 6) {
            // #606-SYNTHETIC — re-key the cursor table by api_id (globally
            // unique per ApiRecord) so synthetic entries that share
            // method:route across files (NETWORK useMutation, SCREEN, JOB)
            // each get their own cursor row. v5 cursors are dropped — the
            // next incremental review does a one-time full pass, then
            // resumes correctly. Acceptable because v5 hadn't shipped.
            this.exec(`DROP TABLE IF EXISTS ai_review_entry_cursor;`);
            this.exec(`CREATE TABLE IF NOT EXISTS ai_review_entry_cursor (
                api_id            TEXT    PRIMARY KEY,
                entry_point_id    TEXT    NOT NULL,
                handler_hash      TEXT    NOT NULL,
                guidelines_hash   TEXT    NOT NULL DEFAULT '',
                baseline_kind     TEXT    NOT NULL DEFAULT '',
                baseline_ref      TEXT    NOT NULL DEFAULT '',
                reviewed_at       INTEGER NOT NULL
            );`);
            this.exec(`CREATE INDEX IF NOT EXISTS idx_ai_cursor_epid ON ai_review_entry_cursor(entry_point_id);`);
        }
        if (current < 7) {
            // v2 phase 3 #484 — `screens` table for FE/mobile L2a screen
            // records. SCHEMA_V1 already includes the CREATE; this guard
            // ensures pre-v7 DBs created the table before the ADR-015
            // schema-version check fires. Idempotent via IF NOT EXISTS.
            this.exec(`CREATE TABLE IF NOT EXISTS screens (
                snapshot_kind  TEXT NOT NULL REFERENCES snapshots(kind) ON DELETE CASCADE,
                screen_id      TEXT NOT NULL,
                screen_json    TEXT NOT NULL,
                PRIMARY KEY (snapshot_kind, screen_id)
            );`);
        }
        if (current < 8) {
            // v2 phase 4 #485 — `screen_items` table for FE/mobile L2b
            // section items. Same idempotent IF NOT EXISTS pattern as
            // the screens table — guards against pre-v8 DBs that
            // already passed the user_version check before this table
            // existed.
            this.exec(`CREATE TABLE IF NOT EXISTS screen_items (
                snapshot_kind  TEXT NOT NULL REFERENCES snapshots(kind) ON DELETE CASCADE,
                screen_id      TEXT NOT NULL,
                items_json     TEXT NOT NULL,
                PRIMARY KEY (snapshot_kind, screen_id)
            );`);
        }
        if (current < 9) {
            // Issue #701 / #733 / #734 — `domains` table. Persists the
            // heuristic Domain clusters + any LLM refinements so the
            // refined names survive VS Code reload (otherwise the
            // optional LLM pass would re-run on every session). Additive
            // — pre-v9 DBs lose nothing.
            this.exec(`CREATE TABLE IF NOT EXISTS domains (
                snapshot_kind  TEXT NOT NULL REFERENCES snapshots(kind) ON DELETE CASCADE,
                domain_id      TEXT NOT NULL,
                domain_json    TEXT NOT NULL,
                PRIMARY KEY (snapshot_kind, domain_id)
            );`);
        }
        if (current < 10) {
            // #813 (2026-06-10) — per-repo review guidelines for monorepo
            // workspaces. Workspace-wide guidelines stay in the existing
            // `review_guidelines (id=1)` table; the v10 table is keyed by
            // a free-form `scope` string so each sub-repo (or any other
            // future scope key) gets its own guideline text. Additive.
            this.exec(`CREATE TABLE IF NOT EXISTS review_guidelines_scoped (
                scope        TEXT    PRIMARY KEY,
                text         TEXT    NOT NULL DEFAULT '',
                hash         TEXT    NOT NULL DEFAULT '',
                updated_at   INTEGER NOT NULL
            );`);
        }
        this.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
        this.log(`[SqliteStore] Schema migrated ${current} → ${CURRENT_SCHEMA_VERSION}`);
    }
}
