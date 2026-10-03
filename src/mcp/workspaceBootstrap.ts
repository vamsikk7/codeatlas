/**
 * workspaceBootstrap.ts — make the MCP server self-sufficient.
 *
 * When CodeAtlas is registered as an MCP plugin in Claude / Codex / Gemini,
 * the user shouldn't have to open VS Code first. This module:
 *   1. detects whether the workspace looks like a codebase
 *   2. acquires an exclusive write-lock so we don't fight a running VS Code
 *      instance
 *   3. if no .codeatlas/state.db exists, runs SyncOrchestrator.initialize()
 *      headlessly (same path the VS Code extension uses)
 *   4. starts a debounced file watcher that calls rebuildFile() per change
 *   5. exposes a status accessor so tools can return `{status: "initializing"|
 *      "ready"|"not_a_codebase"|"read_only"}` without waiting for init.
 *
 * Designed to be safe in three scenarios:
 *   - First-ever launch on a fresh repo (init + watch + read-write)
 *   - Subsequent launch with existing state.db (load + watch + read-write)
 *   - VS Code already running and writing (load + read-only, no watch)
 */
import * as fs from 'fs';
import * as path from 'path';
import { SnapshotStore } from '../core/storage/snapshotStore';
import { SyncOrchestrator } from '../core/sync/syncOrchestrator';
import { CommentStore } from '../core/storage/commentStore';
import { acquireWorkspaceLockPreferred, type AcquiredLock } from '../core/storage/workspaceLock';
import { AggregatorStore } from '../core/storage/aggregatorStore';
import { MONOREPO_DB_FILE } from '../core/storage/monorepoDbSchema';
import type { RepoRow } from '../core/storage/storeInterfaces';
import { WorkspaceScanner } from '../core/scanner/workspaceScanner';

export type BootstrapStatus =
    | { status: 'not_a_codebase'; scanned: number; supportedFiles: number; reason: string }
    | { status: 'initializing'; startedAt: number }
    | { status: 'ready'; fileCount: number; apiCount: number; graphCount: number; mode: 'read_write' | 'read_only'; warning?: string }
    | { status: 'error'; message: string };

// File extensions the workspace scanner indexes. Mirrors the language set in
// CLAUDE.md framework coverage — keep this list in sync with the scanner if
// a new language lands.
const SUPPORTED_EXTS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
    '.py', '.pyw',
    '.java', '.kt', '.kts',
    '.go', '.rs',
    '.cs',
    '.php',
    '.rb',
    '.swift',
    '.dart',
]);

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'out', 'target',
    'coverage', '__pycache__', '.venv', 'venv', '.codeatlas', '.codeatlas-sa', '.vscode',
    '.gradle', '.idea', 'bin', 'obj', 'Pods', 'DerivedData',
]);

export interface BootstrapOptions {
    /** Skip the auto-init step even if no state.db exists. Useful for
     *  read-only consumers that just want to query whatever's there. */
    readOnly?: boolean;
    /** Max files to scan when classifying the workspace as a codebase. Cap
     *  prevents DOS on enormous directory trees. */
    maxScan?: number;
    /** Logger for status / progress messages. Defaults to console.error so
     *  the MCP stdio channel stays clean. */
    log?: (msg: string) => void;
    /**
     * Override the snapshot storage directory. The default `.codeatlas` is
     * shared with the VS Code extension; the standalone npm package passes
     * `.codeatlas-sa` to avoid SQLite WAL lock contention when both run on
     * the same workspace.
     */
    storageDirName?: string;
    /** #829b — read-only external-reload poll interval (ms). Default 2000;
     *  tests pass a short value. */
    externalReloadPollMs?: number;
    /**
     * ADR-034 multi-repo MCP support — when the workspace is multi-repo and
     * this is set, the named repo (matched by `RepoRow.name` or `rootPath`)
     * becomes the primary store backing `getStore()`. Defaults to the first
     * repo sorted alphabetically by rootPath. Single-repo workspaces ignore
     * this option entirely.
     */
    repo?: string;
}

/**
 * ADR-034 multi-repo MCP — populated when the workspace has a
 * `.codeatlas/monorepo.db`. Exposes the aggregator + every per-repo store
 * so tools can iterate, look up, or scope to a specific repo.
 */
export interface MultiRepoState {
    aggregator: AggregatorStore;
    repos: ReadonlyArray<RepoRow>;
    /** repoId → opened SnapshotStore. */
    repoStores: ReadonlyMap<string, SnapshotStore>;
    /** repoId of the "primary" repo whose store backs the legacy `getStore()`. */
    primaryRepoId: string;
}

export class WorkspaceBootstrap {
    private status: BootstrapStatus;
    private store: SnapshotStore;
    private orchestrator: SyncOrchestrator | null = null;
    private watcher: fs.FSWatcher | null = null;
    private rebuildTimer: NodeJS.Timeout | null = null;
    private pendingChanges = new Set<string>();
    private lock: AcquiredLock | null = null;
    // #817 R6 — cross-repo push scheduler; set via setCrossRepoBroadcast().
    private crossRepoPush: { applyWithDelta(store: any, rid: string, apply: () => void): unknown[]; dispose(): void } | null = null;
    // #829b — read-only external-reload poller (tracks the writer process).
    private externalReloadTimer: ReturnType<typeof setInterval> | null = null;
    private onExternalReloadCb: (() => void) | null = null;
    private onReposReadyCb: (() => void | Promise<void>) | null = null;
    private readOnly: boolean;
    /** ADR-034 multi-repo state — null in single-repo workspaces. */
    private multiRepo: MultiRepoState | null = null;

    constructor(
        private workspaceRoot: string,
        private opts: BootstrapOptions = {},
    ) {
        this.readOnly = opts.readOnly === true;
        this.status = { status: 'initializing', startedAt: Date.now() };
        // Constructed against the workspace root for single-repo. In multi-
        // repo workspaces the actual primary store is opened in `start()`
        // once we've seen the aggregator's repo list. We still initialize
        // this field here because TypeScript requires it set in the ctor;
        // the multi-repo path replaces it before any consumer can read it.
        this.store = new SnapshotStore(workspaceRoot, { storageDirName: opts.storageDirName });
    }

    getStatus(): BootstrapStatus { return this.status; }
    /**
     * Single-repo workspaces: returns the only SnapshotStore.
     * Multi-repo workspaces: returns the PRIMARY repo's SnapshotStore — the
     *   one chosen by `--repo` argv or the alphabetically-first rootPath.
     *   Tools that operate on a single store get reasonable single-repo
     *   semantics by default; cross-repo tools should use `getRepoStores()`.
     */
    getStore(): SnapshotStore { return this.store; }

    // ─── ADR-034 multi-repo accessors ───────────────────────────────────
    /** Non-null when the workspace has a `.codeatlas/monorepo.db`. */
    getMultiRepo(): MultiRepoState | null { return this.multiRepo; }
    /** Convenience: every opened per-repo store keyed by repoId. */
    getRepoStores(): ReadonlyMap<string, SnapshotStore> | undefined {
        return this.multiRepo?.repoStores;
    }
    /** Convenience: the aggregator (workspace-scope graphs + repos registry). */
    getAggregator(): AggregatorStore | null { return this.multiRepo?.aggregator ?? null; }

    /**
     * Public file-change hook for callers (the standalone browser server)
     * that own their own file watcher (chokidar) and need to feed events
     * into the orchestrator's cascade pipeline. No-op when the orchestrator
     * isn't yet constructed (init still running / read-only mode).
     *
     * The path may be relative to the workspace or absolute; the bootstrap
     * resolves either form. Failures are logged + swallowed (matches the
     * internal watcher's behavior at line 238).
     */
    /**
     * @returns `true` if the change was relevant and a rebuild ran, `false` if
     * the file was ignored (non-source noise) or there's no orchestrator. The
     * caller uses this to gate the `notifyRefresh` broadcast — BUG-EXP-14
     * follow-up: a watcher `add` burst for LICENSE/`*.md`/lockfiles used to
     * rebuild + save + summary-push + broadcast `cascadeRefresh` for EACH one,
     * a storm. The internal fs.watch already gated on `shouldIgnoreChange`; the
     * external chokidar path (which calls this) did not.
     */
    async handleFileChange(filePath: string): Promise<boolean> {
        if (!this.orchestrator) return false;
        if (shouldIgnoreChange(filePath)) return false;
        const abs = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath);
        try {
            await this.orchestrator.rebuildFile(abs);
            this.store.save();
            this.reapplySummaryWithPush();
            return true;
        } catch (e: any) {
            const log = this.opts.log ?? ((m: string) => process.stderr.write(`[mcp-bootstrap] ${m}\n`));
            log(`handleFileChange(${filePath}) failed: ${e?.message ?? e}`);
            return false;
        }
    }

    /**
     * #817 R6 (2026-06-11) — MCP standalone parity for the cross-repo push.
     * Called by the entry point once the browser server is up; broadcasts
     * `crossRepoEdgeChanged` payloads over the standalone's wsBridge using
     * the SAME shared scheduler the extension uses. Also closes a UX-67
     * parity gap: before this, the daemon never re-applied summaries on
     * save, so `cross_repo_http_edges` only refreshed on the extension side.
     */
    setCrossRepoBroadcast(broadcast: (msg: unknown) => void, enabled?: () => boolean): void {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { CrossRepoPushScheduler } = require('../core/sync/crossRepoPushScheduler');
        this.crossRepoPush?.dispose();
        this.crossRepoPush = new CrossRepoPushScheduler({
            broadcast,
            enabled,
            log: this.opts.log ?? ((m: string) => process.stderr.write(`[mcp-bootstrap] ${m}\n`)),
        });
    }

    /** Re-emit the primary repo's summary into the aggregator with edge-delta
     *  push (#817). No-op in single-repo workspaces or before init. */
    private reapplySummaryWithPush(): void {
        if (!this.multiRepo || !this.orchestrator) return;
        const log = this.opts.log ?? ((m: string) => process.stderr.write(`[mcp-bootstrap] ${m}\n`));
        const rid = this.multiRepo.primaryRepoId;
        try {
            const summary = this.orchestrator.produceSummary(rid);
            const agg = this.multiRepo.aggregator;
            if (this.crossRepoPush) {
                this.crossRepoPush.applyWithDelta(agg, rid, () => agg.applySummary(rid, summary));
            } else {
                agg.applySummary(rid, summary);
            }
        } catch (e: any) {
            log(`cross-repo summary re-apply failed (non-fatal): ${e?.message ?? e}`);
        }
    }

    async start(): Promise<BootstrapStatus> {
        const log = this.opts.log ?? ((m: string) => process.stderr.write(`[mcp-bootstrap] ${m}\n`));

        // Step 1 — workspace existence + codebase detection.
        if (!fs.existsSync(this.workspaceRoot)) {
            this.status = { status: 'error', message: `workspace not found: ${this.workspaceRoot}` };
            return this.status;
        }

        // ADR-034 multi-repo MCP — detect a workspace `.codeatlas/monorepo.db`.
        // Present = the extension indexed this as a multi-repo workspace. We
        // open the aggregator + every per-repo store and pick a primary repo
        // (matched by `opts.repo` or the alphabetically-first rootPath).
        // UX-55 (2026-06-06) — the MCP standalone defaults to
        // `.codeatlas-sa` to avoid SQLite WAL contention with the
        // VS Code extension. When that path's monorepo.db is missing
        // but the extension's `.codeatlas/monorepo.db` exists, fall back
        // to reading the extension's aggregator (read-only). Without this
        // fallback, MCP clients in a multi-repo workspace see only the
        // single workspace-root entry and the per-repo scoping that every
        // tool description advertises is undiscoverable.
        const storageDir = this.opts.storageDirName ?? '.codeatlas';
        let effectiveStorageDir = storageDir;
        let monorepoDbPath = path.join(this.workspaceRoot, storageDir, MONOREPO_DB_FILE);
        if (!fs.existsSync(monorepoDbPath) && storageDir !== '.codeatlas') {
            const fallback = path.join(this.workspaceRoot, '.codeatlas', MONOREPO_DB_FILE);
            if (fs.existsSync(fallback)) {
                log(`multi-repo: ${monorepoDbPath} missing; falling back to ${fallback} (extension storage)`);
                effectiveStorageDir = '.codeatlas';
                monorepoDbPath = fallback;
            }
        }
        // #MCP-MULTI-1 (2026-06-07): when no monorepo.db exists at all
        // (this is a first-time MCP standalone open, not a follow-up to a
        // VS Code init), run the same `detectMultiRepoMode` the workspace
        // orchestrator uses and build a fresh aggregator + per-repo
        // registrations on disk. Without this auto-bootstrap, multi-repo
        // workspaces opened by AI clients via `npx @codeatlas/mcp` fell
        // into single-repo mode silently, breaking `list_repos`,
        // `--repo` flag, and every per-repo-scoped tool.
        if (!fs.existsSync(monorepoDbPath)) {
            try {
                const { detectMultiRepoMode } = await import('../core/analysis/multiRepoDetector');
                const det = detectMultiRepoMode(this.workspaceRoot);
                if (det.isMultiRepo && det.repos.length >= 2) {
                    const { AggregatorStore } = await import('../core/storage/aggregatorStore');
                    const dirPath = path.join(this.workspaceRoot, storageDir);
                    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
                    const agg = new AggregatorStore(this.workspaceRoot, { storageDirName: storageDir });
                    await agg.init();
                    for (const r of det.repos) {
                        const repoId = require('crypto')
                            .createHash('sha256')
                            .update(path.resolve(this.workspaceRoot, r.rootPath))
                            .digest('hex')
                            .slice(0, 16);
                        agg.upsertRepo({
                            repoId,
                            name: r.name,
                            rootPath: r.rootPath,
                            realpathHash: repoId,
                            technology: 'unknown',
                            status: 'ready',
                            lastInitAt: Date.now(),
                            errorMessage: null,
                            fallbackStatePath: null,
                            stateDbSchemaVersion: 9,
                            summarySchemaVersion: 1,
                            diff: null,
                        });
                    }
                    agg.save();
                    agg.close();
                    monorepoDbPath = path.join(this.workspaceRoot, storageDir, MONOREPO_DB_FILE);
                    log(`multi-repo: auto-built aggregator at ${monorepoDbPath} with ${det.repos.length} repos (${det.repos.map(r => r.name).join(', ')})`);
                }
            } catch (err: any) {
                log(`multi-repo auto-bootstrap failed (${err?.message ?? err}); continuing in single-repo mode`);
            }
        }
        if (fs.existsSync(monorepoDbPath)) {
            try {
                await this.openMultiRepo(effectiveStorageDir, log);
            } catch (err: any) {
                log(`multi-repo open failed (${err?.message ?? err}); falling back to single-repo mode`);
                this.multiRepo = null;
            }
        }
        const scan = classifyWorkspace(this.workspaceRoot, this.opts.maxScan ?? 5000);
        if (scan.supportedFiles === 0) {
            this.status = {
                status: 'not_a_codebase',
                scanned: scan.scanned,
                supportedFiles: 0,
                reason: scan.scanned === 0
                    ? 'no files found at workspace root'
                    : `scanned ${scan.scanned} files; none matched a supported language extension`,
            };
            log(`workspace at ${this.workspaceRoot} is not a recognised codebase — MCP read-only with empty snapshot`);
            // Still load the store (will be empty) so tool calls return a
            // structured "no data" response rather than throwing.
            await this.store.load();
            return this.status;
        }

        log(`workspace scan: ${scan.scanned} files seen, ${scan.supportedFiles} indexable`);

        // Step 2 — load snapshot store.
        await this.store.load();

        // Step 3 — write-lock acquisition with MCP-preferred preemption.
        // If the extension holds the lock, MCP signals a preempt request and
        // waits up to 5s for the extension to yield. Falls back to read-only
        // only when another live MCP holds the lock OR the extension doesn't
        // yield in time.
        const lockOk = this.readOnly ? false : await this.tryAcquireLockPreferred();
        const dbExists = fs.existsSync(path.join(this.workspaceRoot, storageDir, 'state.db'));

        if (!lockOk) {
            // Read-only: don't init, don't watch. Just expose what's already there.
            const working = this.store.getWorking();
            this.status = {
                status: 'ready',
                fileCount: Object.keys(working.files ?? {}).length,
                apiCount: Object.keys(working.apiIndex ?? {}).length,
                graphCount: Object.keys(working.graphs ?? {}).length,
                mode: 'read_only',
                warning: this.readOnly
                    ? 'MCP started in read-only mode'
                    : 'another process holds the write lock — likely VS Code is open on this workspace',
            };
            log(`mode=read_only (${this.status.warning})`);
            // #829b — the sql.js image is a one-shot copy of state.db; the
            // writer process (the extension) keeps flushing new state to
            // disk. Poll + reload so this daemon's stdio tools AND browser
            // surface track the writer instead of serving frozen data.
            this.startExternalReloadPoller(log);
            return this.status;
        }

        // TICKET-PERF-1 — the write path is now committed: the primary store is
        // loaded, sub-repos are detected (`getMultiRepo()`), and the lock is
        // held, but the HEAVY `initialize()` (Step 4) hasn't run yet. Fire the
        // "repos ready" hook HERE so the caller can BIND THE HTTP/WS SERVER
        // before init — on a 10k+ file repo that removes the ~14s "connection
        // refused" window (the browser connects immediately and shows a loading
        // state; the caller broadcasts a refresh once init completes).
        try { await this.onReposReadyCb?.(); } catch { /* server-bind best-effort */ }

        // Step 4 — initialize if no state.db, else load existing.
        this.orchestrator = new SyncOrchestrator(this.workspaceRoot, this.store, new CommentStore());
        if (!dbExists || Object.keys(this.store.getWorking().files ?? {}).length === 0) {
            log('no state.db / empty snapshot — running SyncOrchestrator.initialize() …');
            const t0 = Date.now();
            try {
                const result = await this.orchestrator.initialize();
                this.store.save();
                const dt = Date.now() - t0;
                log(`initialize: ${result.fileCount} files, ${result.apiCount} APIs, ${result.graphCount} graphs in ${dt}ms`);
            } catch (e: any) {
                this.status = { status: 'error', message: `initialize failed: ${e?.message ?? e}` };
                this.releaseLock();
                return this.status;
            }
        } else {
            log(`existing snapshot loaded: ${Object.keys(this.store.getWorking().files).length} files`);
            // #829b (#818 finding) — files changed while this daemon was
            // DOWN are invisible until their next watcher event ("No
            // working changes to replay" on a dirty tree). Rebuild drifted
            // files now, bounded so a huge divergence doesn't stall start
            // (a full resync remains the recovery for that).
            await this.scanStartupDrift(log);
        }

        // Step 5 — start file watcher for incremental rebuilds.
        this.startWatcher();

        const working = this.store.getWorking();
        this.status = {
            status: 'ready',
            fileCount: Object.keys(working.files ?? {}).length,
            apiCount: Object.keys(working.apiIndex ?? {}).length,
            graphCount: Object.keys(working.graphs ?? {}).length,
            mode: 'read_write',
        };
        return this.status;
    }

    /** #829b — fires after an external write was reloaded (read-only mode).
     *  The browser entry point wires this to a workspaceInfo/cascadeRefresh
     *  broadcast so open tabs re-fetch. */
    onExternalReload(cb: () => void): void {
        this.onExternalReloadCb = cb;
    }

    /** TICKET-PERF-1 — fires inside `start()` once the primary store is loaded,
     *  sub-repos are detected, and the write-lock is held, but BEFORE the heavy
     *  `initialize()`. Lets the caller bind the HTTP/WS server early (server-
     *  first bootstrap) so browsers connect during init instead of after it. */
    onReposReady(cb: () => void | Promise<void>): void {
        this.onReposReadyCb = cb;
    }

    private startExternalReloadPoller(log: (msg: string) => void): void {
        if (this.externalReloadTimer) return;
        const pollMs = this.opts.externalReloadPollMs ?? 2000;
        this.externalReloadTimer = setInterval(() => {
            void (async () => {
                let reloaded = false;
                try {
                    if (await this.store.reloadFromDiskIfChanged()) reloaded = true;
                } catch { /* next tick retries */ }
                if (this.multiRepo) {
                    for (const s of this.multiRepo.repoStores.values()) {
                        try {
                            if (await (s as any).reloadFromDiskIfChanged?.()) reloaded = true;
                        } catch { /* next tick retries */ }
                    }
                }
                if (reloaded) {
                    log('external write detected — snapshot reloaded from disk (#829b)');
                    try { this.onExternalReloadCb?.(); } catch { /* */ }
                }
            })();
        }, pollMs);
        if (typeof this.externalReloadTimer.unref === 'function') this.externalReloadTimer.unref();
    }

    /** #829b — bounded startup drift scan for the read-write path. */
    private async scanStartupDrift(log: (msg: string) => void): Promise<void> {
        if (!this.orchestrator) return;
        const MAX_REBUILDS = 50;
        const working = this.store.getWorking();
        let drifted = 0;
        for (const [rel, rec] of Object.entries(working.files ?? {})) {
            const abs = path.join(this.workspaceRoot, rel);
            let code: string;
            try { code = fs.readFileSync(abs, 'utf-8'); } catch { continue; } // deleted → resync territory
            if (WorkspaceScanner.hashContent(code) === (rec as { hash?: string }).hash) continue;
            try {
                await this.orchestrator.rebuildFile(abs);
                drifted++;
            } catch (e: any) {
                log(`startup drift rebuild failed for ${rel}: ${e?.message ?? e}`);
            }
            if (drifted >= MAX_REBUILDS) {
                log(`startup drift scan hit the ${MAX_REBUILDS}-file cap — run a resync for full recovery`);
                break;
            }
        }
        if (drifted > 0) {
            this.store.save();
            this.reapplySummaryWithPush();
            log(`startup drift scan: rebuilt ${drifted} file(s) changed while the daemon was down`);
        }
    }

    stop(): void {
        if (this.watcher) { this.watcher.close(); this.watcher = null; }
        if (this.rebuildTimer) { clearTimeout(this.rebuildTimer); this.rebuildTimer = null; }
        if (this.externalReloadTimer) { clearInterval(this.externalReloadTimer); this.externalReloadTimer = null; }
        if (this.crossRepoPush) { this.crossRepoPush.dispose(); this.crossRepoPush = null; }
        if (this.multiRepo) {
            for (const s of this.multiRepo.repoStores.values()) {
                try { s.close(); } catch { /* ignore */ }
            }
            try { this.multiRepo.aggregator.close(); } catch { /* ignore */ }
        }
        this.releaseLock();
    }

    /**
     * ADR-034 multi-repo open sequence:
     *   1. Open the AggregatorStore at workspace/.codeatlas/monorepo.db.
     *   2. Read `aggregator.listRepos()` — the canonical repo registry.
     *   3. Open a SnapshotStore for each repo's `<repoRoot>/.codeatlas/state.db`.
     *   4. Pick the primary repo (opts.repo match by name/rootPath, else
     *      the alphabetically-first rootPath).
     *   5. Replace `this.store` with the primary store so legacy
     *      single-store consumers (every existing MCP tool) keep working
     *      against deterministic per-repo data.
     */
    private async openMultiRepo(storageDir: string, log: (msg: string) => void): Promise<void> {
        const aggregator = new AggregatorStore(this.workspaceRoot, { storageDirName: storageDir });
        await aggregator.init();
        const repos = [...aggregator.listRepos()]
            .sort((a, b) => a.rootPath.localeCompare(b.rootPath));
        if (repos.length === 0) {
            log('aggregator opened but no repos registered — treating as single-repo');
            try { aggregator.close(); } catch { /* */ }
            return;
        }

        const repoStores = new Map<string, SnapshotStore>();
        for (const row of repos) {
            const repoRoot = row.rootPath
                ? path.join(this.workspaceRoot, row.rootPath)
                : this.workspaceRoot;
            try {
                const store = new SnapshotStore(repoRoot, { storageDirName: storageDir });
                await store.load();
                repoStores.set(row.repoId, store);
            } catch (err: any) {
                log(`per-repo store open failed for ${row.name} (${row.rootPath}): ${err?.message ?? err}`);
            }
        }

        // Primary selection: explicit override wins; else alphabetical first.
        const override = this.opts.repo;
        let primary = repos[0];
        if (override) {
            const match = repos.find((r) => r.name === override || r.rootPath === override || r.repoId === override);
            if (match) primary = match;
            else log(`--repo "${override}" did not match any registered repo; falling back to "${primary.name}"`);
        }
        const primaryStore = repoStores.get(primary.repoId);
        if (!primaryStore) {
            throw new Error(`primary repo "${primary.name}" failed to open`);
        }

        this.multiRepo = {
            aggregator,
            repos,
            repoStores,
            primaryRepoId: primary.repoId,
        };
        this.store = primaryStore;

        log(
            `multi-repo workspace detected: ${repos.length} repos, primary="${primary.name}" (${primary.rootPath || '<root>'}); ` +
            `use --repo <name> to switch (available: ${repos.map((r) => r.name).join(', ')})`,
        );
    }

    private async tryAcquireLockPreferred(): Promise<boolean> {
        // Scope the lock to THIS process's storage dir (`.codeatlas-sa` for the
        // standalone npm package). The VS Code extension locks `.codeatlas`, so
        // with separate stores the two never contend or preempt each other —
        // they write different `state.db` files and can run side by side.
        const storageDir = this.opts.storageDirName ?? '.codeatlas';
        this.lock = await acquireWorkspaceLockPreferred(this.workspaceRoot, 'mcp-server', undefined, undefined, storageDir);
        return this.lock !== null;
    }

    private releaseLock(): void {
        if (this.lock) {
            this.lock.release();
            this.lock = null;
        }
    }

    private startWatcher(): void {
        const log = this.opts.log ?? ((m: string) => process.stderr.write(`[mcp-watcher] ${m}\n`));
        try {
            // fs.watch with recursive on macOS / Windows; on Linux it doesn't
            // recurse so the rebuild path will only catch root-level changes.
            // Acceptable trade-off for v1 — production users on Linux who want
            // deep watch can fall back to running VS Code or invoke `resync`.
            this.watcher = fs.watch(this.workspaceRoot, { recursive: true }, (eventType, filename) => {
                if (!filename) return;
                if (shouldIgnoreChange(filename.toString())) return;
                this.pendingChanges.add(filename.toString());
                this.scheduleRebuild();
            });
            log('file watcher started');
        } catch (e: any) {
            log(`file watcher unavailable (${e?.message ?? e}); changes won't auto-rebuild`);
        }
    }

    /** Coalesce bursts of file events into one rebuild pass per ~500ms. */
    private scheduleRebuild(): void {
        if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
        this.rebuildTimer = setTimeout(() => this.flushRebuild().catch(() => { /* */ }), 500);
    }

    private async flushRebuild(): Promise<void> {
        if (!this.orchestrator) return;
        const log = this.opts.log ?? ((m: string) => process.stderr.write(`[mcp-watcher] ${m}\n`));
        const paths = [...this.pendingChanges];
        this.pendingChanges.clear();
        for (const rel of paths) {
            const abs = path.join(this.workspaceRoot, rel);
            if (!fs.existsSync(abs)) continue;
            try {
                await this.orchestrator.rebuildFile(abs);
            } catch (e: any) {
                log(`rebuildFile(${rel}) failed: ${e?.message ?? e}`);
            }
        }
        this.store.save();
        // #817 R6 — refresh cross-repo edges + push consumer notifications.
        this.reapplySummaryWithPush();
        // Refresh the cached status counters.
        const working = this.store.getWorking();
        if (this.status.status === 'ready') {
            this.status = {
                ...this.status,
                fileCount: Object.keys(working.files ?? {}).length,
                apiCount: Object.keys(working.apiIndex ?? {}).length,
                graphCount: Object.keys(working.graphs ?? {}).length,
            };
        }
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

interface ScanResult { scanned: number; supportedFiles: number; }

/** Walk the workspace counting (a) total files seen, (b) files matching a
 *  supported language extension. Caps at `maxScan` to avoid spending forever
 *  on monorepos with millions of node_modules entries. */
export function classifyWorkspace(root: string, maxScan: number): ScanResult {
    let scanned = 0;
    let supportedFiles = 0;
    const queue: string[] = [root];
    while (queue.length > 0 && scanned < maxScan) {
        const dir = queue.shift()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (scanned >= maxScan) break;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
                queue.push(path.join(dir, e.name));
            } else if (e.isFile()) {
                scanned++;
                const ext = path.extname(e.name).toLowerCase();
                if (SUPPORTED_EXTS.has(ext)) supportedFiles++;
            }
        }
    }
    return { scanned, supportedFiles };
}

export function shouldIgnoreChange(filename: string): boolean {
    // Drop changes in skip dirs, lock files, and the codeatlas dir itself.
    const lower = filename.toLowerCase();
    if (lower.includes('.codeatlas/') || lower.includes('.codeatlas-sa/')) return true;
    if (lower.includes('node_modules/')) return true;
    if (lower.includes('/.git/') || lower.endsWith('/.git')) return true;
    // Build / output dirs — a source-extension file here (e.g. `target/*.rs`,
    // `.next/*.js`) is a generated artifact, not a watched source. Mirrors the
    // fileWatcher `ignoredFn` so this exported filter is reliable on its own.
    if (/(^|\/)(dist|build|out|target|coverage|\.next|\.nuxt|\.gradle|\.idea)(\/|$)/.test(lower)) return true;
    const ext = path.extname(filename).toLowerCase();
    return !SUPPORTED_EXTS.has(ext);
}

