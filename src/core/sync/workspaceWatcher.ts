/**
 * ADR-034 Phase D Tier-1 (#789 — Phase D: parallel per-repo parse + per-repo watcher (ADR-034)) — `WorkspaceWatcher`.
 *
 * Single chokidar watcher across the workspace root. On every file event,
 * finds the longest matching repo's `rootPath` and dispatches to that
 * repo's listener. Cap inotify usage at one watcher process-wide
 * regardless of repo count, so 42-repo workspaces don't hit OS
 * file-descriptor limits.
 *
 * Tier-1 ships the dispatch + per-repo prefix lookup; debouncing + the
 * actual rebuildFile() call live in the SyncOrchestrator the per-repo
 * runner already owns. WorkspaceWatcher just routes the event to the
 * right orchestrator.
 *
 * Design properties:
 *   - One chokidar instance per workspace (process-wide singleton in
 *     extension.ts)
 *   - Longest-prefix-match by `rootPath` — nested repos work
 *     (`apps/frontend/...` beats `apps/...`)
 *   - `updateRepos()` swaps the repo list without recreating the watcher
 *   - Events with no matching repo are dropped (with debug log) — root-
 *     level workspace files don't belong to any repo
 *   - Dependency-injected chokidar factory so tests can substitute an
 *     in-memory fake
 */
import * as path from 'node:path';
import type { FSWatcher } from 'chokidar';
import type { RepoRow } from '../storage/storeInterfaces';

export type WorkspaceWatcherEvent = 'change' | 'add' | 'unlink';
export type WorkspaceWatcherListener = (repoId: string, filePath: string, kind: WorkspaceWatcherEvent) => void;

export interface WorkspaceWatcherOptions {
    workspaceRoot: string;
    ignore?: string[];
    /**
     * Inject a chokidar-shaped watcher for tests. When omitted the real
     * `chokidar.watch()` is used. The shape must include `on()` and
     * `close()`.
     */
    watcherFactory?: (workspaceRoot: string, ignore: string[]) => MinimalWatcher;
    log?: (msg: string) => void;
}

/** Subset of chokidar.FSWatcher used here — keeps the type narrow for fakes. */
export interface MinimalWatcher {
    on(event: 'change' | 'add' | 'unlink' | 'error', listener: (...args: any[]) => void): this;
    close(): Promise<void> | void;
}

export class WorkspaceWatcher {
    private watcher: MinimalWatcher;
    private repos: RepoRow[];
    private listeners = new Set<WorkspaceWatcherListener>();
    private closed = false;
    private log: (msg: string) => void;
    private readonly workspaceRoot: string;

    /**
     * Sync constructor — primarily for tests (inject `watcherFactory`) and
     * for the static `create()` entry below which passes a pre-resolved
     * watcher via `watcherOverride`. Production callers should use
     * `WorkspaceWatcher.create()` to await the async chokidar import
     * (Issue #790 #6 — chokidar v5 is ESM-only).
     */
    constructor(repos: ReadonlyArray<RepoRow>, opts: WorkspaceWatcherOptions, watcherOverride?: MinimalWatcher) {
        this.workspaceRoot = opts.workspaceRoot;
        this.repos = sortByDepth(repos);
        this.log = opts.log ?? (() => { /* noop */ });
        if (watcherOverride) {
            this.watcher = watcherOverride;
        } else if (opts.watcherFactory) {
            this.watcher = opts.watcherFactory(opts.workspaceRoot, opts.ignore ?? []);
        } else {
            throw new Error(
                '[WorkspaceWatcher] No watcher provided. Use `WorkspaceWatcher.create()` in production ' +
                '(async chokidar load) or pass a sync `watcherFactory` in `opts` from tests.',
            );
        }

        this.watcher.on('change', (p: string) => this.handle('change', p));
        this.watcher.on('add', (p: string) => this.handle('add', p));
        this.watcher.on('unlink', (p: string) => this.handle('unlink', p));
        this.watcher.on('error', (err: any) => this.log(`[WorkspaceWatcher] error: ${err?.message ?? err}`));
    }

    /**
     * Production entry — awaits the async default chokidar load
     * (Issue #790 #6: chokidar v5 is ESM-only and must be loaded via
     * the real Node ESM loader via `import()`). Tests that pass a sync
     * `watcherFactory` via `opts` can continue using `new WorkspaceWatcher()`.
     */
    static async create(repos: ReadonlyArray<RepoRow>, opts: WorkspaceWatcherOptions): Promise<WorkspaceWatcher> {
        if (opts.watcherFactory) {
            return new WorkspaceWatcher(repos, opts);
        }
        const watcher = await defaultWatcherFactory(opts.workspaceRoot, opts.ignore ?? []);
        return new WorkspaceWatcher(repos, opts, watcher);
    }

    /**
     * Subscribe to per-repo file events. Returns an unsubscribe fn. The
     * listener fires once per `(event, file)` pair with the resolved
     * `repoId` of the owning repo.
     */
    on(listener: WorkspaceWatcherListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Update the repo registry without recreating the chokidar watcher.
     * Used when `WorkspaceOrchestrator.reconcile()` discovers a new repo
     * dir or notices one was deleted.
     */
    updateRepos(repos: ReadonlyArray<RepoRow>): void {
        this.repos = sortByDepth(repos);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.listeners.clear();
        await Promise.resolve(this.watcher.close());
    }

    // ─── internal ─────────────────────────────────────────────────────

    private handle(kind: WorkspaceWatcherEvent, absolutePath: string): void {
        if (this.closed) return;
        const rel = toWorkspaceRelative(this.workspaceRoot, absolutePath);
        if (!rel) return;
        const owner = this.resolveOwner(rel);
        if (!owner) {
            this.log(`[WorkspaceWatcher] no matching repo for ${rel} — dropping ${kind}`);
            return;
        }
        for (const listener of this.listeners) {
            try { listener(owner.repoId, rel, kind); }
            catch (err: any) { this.log(`[WorkspaceWatcher] listener threw on ${rel}: ${err?.message ?? err}`); }
        }
    }

    private resolveOwner(workspaceRelativePath: string): RepoRow | null {
        // repos already sorted depth-desc; first hit wins.
        for (const r of this.repos) {
            if (!r.rootPath) {
                // Single-repo entry — matches every file. Use only when no
                // multi-repo siblings beat it (already at the bottom of the
                // depth-sorted list).
                return r;
            }
            const prefix = r.rootPath.endsWith('/') ? r.rootPath : r.rootPath + '/';
            if (workspaceRelativePath === r.rootPath || workspaceRelativePath.startsWith(prefix)) {
                return r;
            }
        }
        return null;
    }
}

// ─── helpers ────────────────────────────────────────────────────────────

function sortByDepth(repos: ReadonlyArray<RepoRow>): RepoRow[] {
    // Deepest rootPath first so nested repos beat their parent in the
    // longest-prefix match. Empty rootPath sorts to the bottom.
    return [...repos].sort((a, b) => {
        if (!a.rootPath && b.rootPath) return 1;
        if (a.rootPath && !b.rootPath) return -1;
        return b.rootPath.length - a.rootPath.length;
    });
}

function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string | null {
    const ws = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const abs = absolutePath.replace(/\\/g, '/');
    if (!abs.startsWith(ws + '/')) return null;
    return abs.slice(ws.length + 1);
}

// Issue #790 #6 — default factory is the chokidar dynamic-import path,
// used by the MCP standalone (CLI Node process — chokidar's per-subdir
// fs.watch works fine there). The VS Code extension surface CANNOT use
// this path: live-verify on a 132-sub-repo monorepo showed every
// chokidar variant tried in the extension host (v5 default, v5
// external + dynamic import, v3 with fsevents stubbed, polling, even
// inside a worker_threads worker) fired only for root-level paths and
// silently dropped deep-tree events. The extension wires its own
// VS Code-native factory via `vscodeFileSystemWatcherFactory()` —
// see `core/sync/vscodeFileSystemWatcherFactory.ts`.
async function defaultWatcherFactory(workspaceRoot: string, ignore: string[]): Promise<MinimalWatcher> {
    const chokidar: any = await import('chokidar');
    const watch = chokidar.watch ?? chokidar.default?.watch;
    if (typeof watch !== 'function') {
        throw new Error('[WorkspaceWatcher] chokidar.watch is not a function — module shape unexpected');
    }
    const w: FSWatcher = watch(workspaceRoot, {
        ignored: ignore,
        ignoreInitial: true,
        persistent: true,
        depth: Infinity,
        awaitWriteFinish: {
            stabilityThreshold: 200,
            pollInterval: 100,
        },
    });
    return w as unknown as MinimalWatcher;
}
