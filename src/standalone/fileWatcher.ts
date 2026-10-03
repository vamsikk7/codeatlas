/**
 * fileWatcher.ts — standalone replacement for
 * `vscode.workspace.createFileSystemWatcher` + the extension's git-ref
 * watchers. Wraps `chokidar` and forwards lifecycle events to the same
 * `SyncOrchestrator` entry points the extension uses, so cascade rebuild
 * behavior in standalone mode is identical to running in VS Code.
 *
 * INVARIANT: chokidar's `awaitWriteFinish` waits for the file to stabilize
 * before firing `change`, matching VS Code's debounced behavior.
 *
 * NOTE on platform compat: chokidar uses native fsevents on macOS,
 * inotify on Linux, ReadDirectoryChangesW on Windows. The `usePolling`
 * fallback is auto-enabled by chokidar on network filesystems and some
 * containerized runtimes; we don't need to detect them manually.
 */

import * as path from 'node:path';
import type { FSWatcher } from 'chokidar';

export interface OrchestratorCallbacks {
    /** Called when a tracked source file's content changes. */
    handleFileSave?: (filePath: string) => void | Promise<unknown>;
    /** Called when a new source file appears in the workspace. */
    handleFileCreated?: (filePath: string) => void | Promise<unknown>;
    /** Called when a tracked source file is deleted. */
    handleFileDeleted?: (filePath: string) => void | Promise<unknown>;
    /**
     * Called when `.git/HEAD` or `.git/logs/HEAD` change — e.g. on commit,
     * branch switch, reset. The extension uses this to re-baseline.
     */
    handleGitRefChange?: () => void | Promise<unknown>;
}

export interface FileWatcherOptions {
    workspaceRoot: string;
    /** chokidar `ignored` patterns (relative globs). */
    ignore: string[];
    callbacks: OrchestratorCallbacks;
    /**
     * Inject a custom chokidar implementation (tests pass an in-memory
     * mock). Defaults to the real chokidar.
     */
    chokidarImpl?: typeof import('chokidar');
    /** Stderr logger (matches the rest of the standalone module). */
    log?: (msg: string) => void;
}

export interface StandaloneFileWatcher {
    /**
     * Stop both the source-file watcher and the git-ref watcher. Resolves
     * when both have closed their underlying handles.
     */
    stop: () => Promise<void>;
    /**
     * Exposed for diagnostics + tests. Tells whether the watcher is
     * currently active.
     */
    isActive: () => boolean;
}

/**
 * Start watching `workspaceRoot` + the two git-state files. Returns a
 * handle the caller uses on shutdown.
 */
export async function startStandaloneFileWatcher(
    opts: FileWatcherOptions,
): Promise<StandaloneFileWatcher> {
    const log = opts.log ?? (() => {});
    const chokidar = opts.chokidarImpl ?? (await import('chokidar'));

    // Build a fast ignore predicate that catches the common patterns reliably.
    // Glob-style `**/node_modules/**` doesn't match absolute paths consistently
    // across chokidar / anymatch versions; substring checks are robust + cheap.
    const ignorePatterns = opts.ignore ?? [];
    const ignoredFn = (fp: string): boolean => {
        // Always reject CodeAtlas's own state directories (any storage-dir
        // variant) — without this the watcher reacts to its own sqlite writes
        // and re-fires the cascade endlessly.
        if (/(^|\/)\.codeatlas(-[a-zA-Z0-9_-]+)?(\/|$)/.test(fp)) return true;
        // Hot path: common heavy directories.
        if (fp.includes('/node_modules/')) return true;
        if (fp.includes('/.git/')) return true;
        if (/\/(dist|build|out|target)\//.test(fp)) return true;
        // BUG-EXP-14 — additional heavy/build dirs that blow the fd budget on
        // large Gradle/Maven/Python/IDE repos (java-micronaut = 5288 dirs).
        if (/\/(\.gradle|\.idea|\.mvn|vendor|coverage|\.next|\.nuxt|\.venv|venv|__pycache__|\.tox|\.pytest_cache|\.terraform)\//.test(fp)) return true;
        // Per-user globs from settings — applied via minimatch when present.
        if (ignorePatterns.length > 0) {
            try {
                // Lazy-require minimatch only when user patterns exist; avoids
                // a hard import dependency for the default-only path.
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { minimatch } = require('minimatch');
                for (const pat of ignorePatterns) {
                    if (minimatch(fp, pat, { dot: true })) return true;
                }
            } catch { /* if minimatch unavailable, fall back to defaults */ }
        }
        return false;
    };

    // BUG-EXP-14 — chokidar falls back to per-directory `fs.watch` in the bundled
    // daemon (native fsevents isn't in the esbuild bundle), so a very large tree
    // (java-micronaut = 5288 dirs) exhausts the per-process fd cap → `EMFILE`
    // storms that fd-starve the WHOLE daemon (HTTP accept, sqlite, …), so it binds
    // but can never serve. Prevent it: a cheap bounded walk counts watchable dirs;
    // past the cap we DO NOT start the recursive source watcher (live file-change
    // updates are disabled — a Re-sync / reload picks up edits). The git-ref
    // watcher (2 specific files) still runs.
    const MAX_WATCH_DIRS = 2500;
    let tooManyDirs = false;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs');
        const stack: string[] = [opts.workspaceRoot];
        let count = 0;
        while (stack.length > 0 && !tooManyDirs) {
            const dir = stack.pop()!;
            let entries: any[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
            for (const e of entries) {
                if (!e.isDirectory()) continue;
                const full = path.join(dir, e.name);
                if (ignoredFn(full)) continue;
                if (++count > MAX_WATCH_DIRS) { tooManyDirs = true; break; }
                stack.push(full);
            }
        }
    } catch { /* scan failed — fall through and attempt to watch normally */ }

    let sourceWatcher: FSWatcher | undefined;
    if (tooManyDirs) {
        log(`[fileWatcher] workspace exceeds ${MAX_WATCH_DIRS} watchable dirs — live file-change updates DISABLED (use Re-sync to refresh). Prevents EMFILE fd exhaustion on very large repos.`);
    } else {
        sourceWatcher = chokidar.watch(opts.workspaceRoot, {
            ignored: ignoredFn as any,
            persistent: true,
            ignoreInitial: true,
            followSymlinks: false,
            awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
        });

        sourceWatcher.on('change', (fp) => {
            log(`[fileWatcher] change: ${fp}`);
            try { opts.callbacks.handleFileSave?.(fp); } catch (err: any) {
                log(`[fileWatcher] handleFileSave threw: ${err?.message ?? err}`);
            }
        });
        sourceWatcher.on('add', (fp) => {
            log(`[fileWatcher] add: ${fp}`);
            try { opts.callbacks.handleFileCreated?.(fp); } catch (err: any) {
                log(`[fileWatcher] handleFileCreated threw: ${err?.message ?? err}`);
            }
        });
        sourceWatcher.on('unlink', (fp) => {
            log(`[fileWatcher] unlink: ${fp}`);
            try { opts.callbacks.handleFileDeleted?.(fp); } catch (err: any) {
                log(`[fileWatcher] handleFileDeleted threw: ${err?.message ?? err}`);
            }
        });
        sourceWatcher.on('error', (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log(`[fileWatcher] chokidar error: ${msg}`);
            // fd/watch-limit errors won't recover; close to end the error storm.
            if (/EMFILE|ENFILE|ENOSPC/i.test(msg)) {
                log('[fileWatcher] fd/watch limit hit — disabling live file-change updates');
                try { sourceWatcher?.close(); } catch { /* ignore */ }
            }
        });
    }

    // Git-state watcher — fires on commits (logs/HEAD), branch switches (HEAD),
    // resets, merges, etc. Same callback in all cases; orchestrator re-baselines.
    const gitTargets = [
        path.join(opts.workspaceRoot, '.git', 'HEAD'),
        path.join(opts.workspaceRoot, '.git', 'logs', 'HEAD'),
    ];
    const gitWatcher: FSWatcher = chokidar.watch(gitTargets, {
        persistent: true,
        ignoreInitial: true,
    });
    gitWatcher.on('change', () => {
        log('[fileWatcher] git ref change');
        try { opts.callbacks.handleGitRefChange?.(); } catch (err: any) {
            log(`[fileWatcher] handleGitRefChange threw: ${err?.message ?? err}`);
        }
    });
    gitWatcher.on('add', () => {
        // .git/logs/HEAD is created on the first commit
        try { opts.callbacks.handleGitRefChange?.(); } catch { /* ignore */ }
    });
    // BUG-EXP-14 — the gitWatcher previously had NO error handler. On a large
    // repo the source watcher exhausts the per-process fd cap (`EMFILE: too many
    // open files, watch`), and the resulting `'error'` event on this
    // handler-less watcher was an unhandled EventEmitter error → the whole
    // standalone daemon process crashed (killing the browser session). A file
    // watch failure must degrade to "no live updates", never take down the
    // server — so we catch it (and close the watchers to stop the error storm).
    gitWatcher.on('error', (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[fileWatcher] git watcher error (live git-ref updates disabled): ${msg}`);
        try { gitWatcher.close(); } catch { /* ignore */ }
    });

    let active = true;
    log(`[fileWatcher] watching ${opts.workspaceRoot} (ignore: ${opts.ignore.length} patterns)`);

    return {
        async stop() {
            if (!active) return;
            active = false;
            try { await sourceWatcher?.close(); } catch { /* ignore */ }
            try { await gitWatcher.close(); } catch { /* ignore */ }
            log('[fileWatcher] stopped');
        },
        isActive() { return active; },
    };
}
