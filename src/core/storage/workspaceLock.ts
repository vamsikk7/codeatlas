/**
 * workspaceLock.ts — single-writer exclusion for a CodeAtlas SQLite `state.db`.
 *
 * Background: two processes writing the same SQLite file corrupt it (SQLite
 * tolerates concurrent reads, not concurrent writes). The lock file
 * `<storageDir>/.mcp-owner` (named for the MCP introduction in 5.0.0) records
 * the PID of the current writer. Stale locks (dead process) are auto-released
 * by the next acquirer.
 *
 * SCOPED TO THE STORAGE DIR. The VS Code extension writes `.codeatlas/state.db`
 * and locks `.codeatlas/.mcp-owner`; the standalone `@codeatlas/mcp` writes
 * `.codeatlas-sa/state.db` and locks `.codeatlas-sa/.mcp-owner`. Because those
 * are DIFFERENT files that can never corrupt each other, the two surfaces are
 * now fully independent — they no longer share a lock and no longer preempt
 * one another. Every function therefore takes a `storageDirName` (default
 * `.codeatlas`, so the extension's callers are unchanged). The preempt protocol
 * below still applies WITHIN a single store, e.g. a second `@codeatlas/mcp`
 * (or a second VS Code window) contending for the same `state.db`.
 *
 * Contract:
 *   - First process to call `acquireWorkspaceLock(root, label, dir)` wins → it
 *     becomes the exclusive writer of `<dir>/state.db`.
 *   - Subsequent attempts for the SAME dir fail until the holder releases or
 *     the holding PID dies. A different `dir` never contends.
 *   - `isProcessAlive(pid)` is best-effort (POSIX kill -0). Windows users get a
 *     slightly weaker stale-check (`process.kill(pid, 0)` may throw `EPERM` for
 *     another user's processes — treated as "alive").
 *
 * Keep this module side-effect-free except for the exit-hook registration
 * inside `acquireWorkspaceLock` — that's what guarantees the lock file is
 * cleaned up on normal exit signals.
 */
import * as fs from 'fs';
import * as path from 'path';

export const LOCK_FILE_NAME = '.mcp-owner';
export const PREEMPT_FILE_NAME = '.mcp-preempt';
/** Default storage dir — the VS Code extension's `.codeatlas`. The standalone
 *  npm package (`@codeatlas/mcp`) passes `.codeatlas-sa`. */
export const DEFAULT_LOCK_DIR = '.codeatlas';

export interface AcquiredLock {
    /** Absolute path to the lock file. */
    path: string;
    /** Owning PID stamped into the lock content. */
    pid: number;
    /** Release function — idempotent. */
    release: () => void;
}

export interface LockOwner {
    pid: number;
    startedAt: number;
    label?: string;
}

/**
 * Try to acquire the write lock for a workspace store. Returns null when
 * another live process already holds the lock for the SAME `storageDirName`.
 *
 * `label` is a free-form tag (e.g. 'vscode-extension', 'mcp-server') stored in
 * the lock file so a status read can tell humans which process is winning.
 * `storageDirName` scopes the lock to a specific store (default `.codeatlas`);
 * a lock on `.codeatlas` never blocks one on `.codeatlas-sa`.
 */
export function acquireWorkspaceLock(workspaceRoot: string, label?: string, storageDirName: string = DEFAULT_LOCK_DIR): AcquiredLock | null {
    const lockDir = path.join(workspaceRoot, storageDirName);
    const lockPath = path.join(lockDir, LOCK_FILE_NAME);

    const tryCreate = (): AcquiredLock | null => {
        try {
            if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
            const fd = fs.openSync(lockPath, 'wx');
            const content: LockOwner = { pid: process.pid, startedAt: Date.now(), label };
            fs.writeSync(fd, JSON.stringify(content));
            fs.closeSync(fd);
            return {
                path: lockPath,
                pid: process.pid,
                release: () => releaseLockFile(lockPath),
            };
        } catch (e: any) {
            if (e?.code !== 'EEXIST') return null;
            return null;
        }
    };

    const first = tryCreate();
    if (first) {
        registerCleanup(first.release);
        return first;
    }

    // Lock exists — see if it's stale.
    try {
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as LockOwner;
        if (typeof owner.pid === 'number' && !isProcessAlive(owner.pid)) {
            // Steal — owner died.
            try { fs.unlinkSync(lockPath); } catch { /* race with another stealer */ }
            const second = tryCreate();
            if (second) {
                registerCleanup(second.release);
                return second;
            }
        }
    } catch { /* malformed lock file — leave it, fail to acquire */ }
    return null;
}

/**
 * Inspect the lock without acquiring it. Useful for diagnostics — "who owns
 * the workspace store?" — without side effects.
 */
export function readLockOwner(workspaceRoot: string, storageDirName: string = DEFAULT_LOCK_DIR): LockOwner | null {
    const lockPath = path.join(workspaceRoot, storageDirName, LOCK_FILE_NAME);
    if (!fs.existsSync(lockPath)) return null;
    try {
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as LockOwner;
        if (typeof owner.pid !== 'number') return null;
        return owner;
    } catch {
        return null;
    }
}

export function isLockHeldByLiveProcess(workspaceRoot: string, storageDirName: string = DEFAULT_LOCK_DIR): boolean {
    const owner = readLockOwner(workspaceRoot, storageDirName);
    if (!owner) return false;
    return isProcessAlive(owner.pid);
}

function releaseLockFile(lockPath: string): void {
    try {
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as LockOwner;
        if (owner.pid === process.pid) fs.unlinkSync(lockPath);
    } catch { /* gone or unreadable — nothing to do */ }
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        // `EPERM` means the process exists but we lack permission to signal —
        // treat as alive (someone else's process; we shouldn't steal it).
        if (e?.code === 'EPERM') return true;
        return false;
    }
}

let cleanupRegistered = false;
const releaseFns = new Set<() => void>();
function registerCleanup(release: () => void): void {
    releaseFns.add(release);
    if (cleanupRegistered) return;
    cleanupRegistered = true;
    const runAll = () => { for (const r of releaseFns) try { r(); } catch { /* */ } };
    process.on('exit', runAll);
    process.on('SIGINT', () => { runAll(); process.exit(130); });
    process.on('SIGTERM', () => { runAll(); process.exit(143); });
}

// ─── Preempt protocol — MCP-preferred priority (WITHIN one store) ───────────
//
// Design: a process holds the store's write lock. When a preferred process
// (the standalone MCP) starts on the SAME store and finds the lock held by a
// VS Code extension, it gives itself precedence:
//
//   1. It writes `<dir>/.mcp-preempt` with its own PID + timestamp.
//   2. The extension is watching that file via fs.watchFile and reacts by
//      releasing its lock + disabling auto-update (going read-only for the
//      rest of its session).
//   3. The MCP polls for the lock file to disappear, then acquires.
//   4. The MCP removes `.mcp-preempt` on successful acquire so future restarts
//      don't see a stale request.
//
// NOTE: since the lock + preempt files are now scoped per storage dir, the
// extension (`.codeatlas`) and the standalone (`.codeatlas-sa`) live in
// SEPARATE stores and never see each other's preempt files — so this protocol
// only fires when two processes genuinely share one `state.db` (e.g. two
// `@codeatlas/mcp` on the same `.codeatlas-sa`, or a legacy embedded MCP that
// deliberately shares `.codeatlas` with the extension host).
//
// The preempt file format mirrors LockOwner so the same parser is reusable.

export interface PreemptRequest {
    pid: number;
    requestedAt: number;
    label?: string;
}

/** Write a preempt-request file for a store. Returns the absolute path on
 *  success, null if the parent directory cannot be created. Overwrites any
 *  existing request so a stuck-process MCP can re-issue. */
export function requestPreemption(workspaceRoot: string, label = 'mcp-server', storageDirName: string = DEFAULT_LOCK_DIR): string | null {
    try {
        const dir = path.join(workspaceRoot, storageDirName);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, PREEMPT_FILE_NAME);
        const payload: PreemptRequest = { pid: process.pid, requestedAt: Date.now(), label };
        fs.writeFileSync(filePath, JSON.stringify(payload));
        return filePath;
    } catch {
        return null;
    }
}

/** Read a store's preempt-request file. Returns null when absent or malformed. */
export function readPreemptRequest(workspaceRoot: string, storageDirName: string = DEFAULT_LOCK_DIR): PreemptRequest | null {
    const filePath = path.join(workspaceRoot, storageDirName, PREEMPT_FILE_NAME);
    if (!fs.existsSync(filePath)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PreemptRequest;
        if (typeof data.pid !== 'number') return null;
        return data;
    } catch {
        return null;
    }
}

/** Remove a store's preempt-request file (called after a successful acquire). */
export function clearPreemptRequest(workspaceRoot: string, storageDirName: string = DEFAULT_LOCK_DIR): void {
    const filePath = path.join(workspaceRoot, storageDirName, PREEMPT_FILE_NAME);
    try { fs.unlinkSync(filePath); } catch { /* not there is fine */ }
}

/** Watch a store's preempt-request file. The callback fires once when a request
 *  appears (or is rewritten). Returns an `unwatch` function. Uses fs.watchFile
 *  (polling-based) for cross-platform reliability — same as the bootstrap
 *  watcher pattern. */
export function watchPreemptRequest(
    workspaceRoot: string,
    onRequest: (req: PreemptRequest) => void,
    pollIntervalMs = 250,
    storageDirName: string = DEFAULT_LOCK_DIR,
): () => void {
    const dir = path.join(workspaceRoot, storageDirName);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, PREEMPT_FILE_NAME);
    let fired = false;
    const handler = () => {
        if (fired) return;
        const req = readPreemptRequest(workspaceRoot, storageDirName);
        if (req) {
            fired = true;
            try { onRequest(req); } catch { /* swallow */ }
        }
    };
    fs.watchFile(filePath, { interval: pollIntervalMs, persistent: false }, handler);
    // Run once immediately so a request that landed before watch start still fires.
    handler();
    return () => {
        try { fs.unwatchFile(filePath, handler); } catch { /* */ }
    };
}

/**
 * #829 (2026-06-10) — reclaim watcher. After this process yields the lock
 * to a preempting MCP, it must notice when that process exits: while
 * preempted the extension's in-memory snapshots are FROZEN (auto-update
 * off) and the MCP keeps writing the DB, so any in-memory read (e.g. the
 * #827 regression scope) silently serves stale data until a resync.
 *
 * Fires `onReclaimable` ONCE when the lock is reclaimable:
 *   - the lock file's recorded owner PID is dead (stale lock), or
 *   - the lock file has been ABSENT for `graceFreePolls` consecutive
 *     polls. The grace window matters: during a preempt handover the lock
 *     is momentarily free between our release and the MCP's acquire —
 *     firing on the first free poll would make the extension re-grab the
 *     lock out from under the MCP and ping-pong ownership forever.
 *
 * Poll-based (setInterval) for cross-platform reliability, matching
 * `watchPreemptRequest`. Returns an unwatch function.
 */
export function watchLockReclaimable(
    workspaceRoot: string,
    onReclaimable: () => void,
    pollIntervalMs = 1000,
    graceFreePolls = 3,
    storageDirName: string = DEFAULT_LOCK_DIR,
): () => void {
    const lockPath = path.join(workspaceRoot, storageDirName, LOCK_FILE_NAME);
    let consecutiveFree = 0;
    let fired = false;
    const timer = setInterval(() => {
        if (fired) return;
        const fire = () => {
            fired = true;
            clearInterval(timer);
            try { onReclaimable(); } catch { /* swallow */ }
        };
        if (!fs.existsSync(lockPath)) {
            consecutiveFree++;
            if (consecutiveFree >= graceFreePolls) fire();
            return;
        }
        consecutiveFree = 0;
        const owner = readLockOwner(workspaceRoot, storageDirName);
        // Malformed lock — leave it alone (mirrors acquireWorkspaceLock).
        if (!owner) return;
        if (!isProcessAlive(owner.pid)) fire();
    }, pollIntervalMs);
    // `unref` so a forgotten watcher never keeps the process alive.
    if (typeof timer.unref === 'function') timer.unref();
    return () => {
        fired = true;
        clearInterval(timer);
    };
}

/**
 * Acquire the workspace lock with MCP-preferred preemption. Used by the
 * standalone MCP server. Flow (all scoped to `storageDirName`):
 *   - If lock is free → acquire.
 *   - If lock is held by another MCP (live) → null (downgrade to read-only).
 *   - If lock is held by the extension (live) → write a preempt request and
 *     poll for release up to `maxWaitMs`. Acquire on release, else null.
 *   - If lock is stale → steal + acquire.
 *
 * With per-store lock scoping, the standalone (`.codeatlas-sa`) never sees the
 * extension's `.codeatlas` lock, so in the normal case it simply acquires its
 * own free lock — the preempt branch only fires if something else already
 * holds the SAME store.
 */
export async function acquireWorkspaceLockPreferred(
    workspaceRoot: string,
    label: string,
    maxWaitMs = 5000,
    pollIntervalMs = 100,
    storageDirName: string = DEFAULT_LOCK_DIR,
): Promise<AcquiredLock | null> {
    const lockPath = path.join(workspaceRoot, storageDirName, LOCK_FILE_NAME);

    // Try immediate acquire first — covers the free / stale-and-stealable cases.
    const direct = acquireWorkspaceLock(workspaceRoot, label, storageDirName);
    if (direct) {
        clearPreemptRequest(workspaceRoot, storageDirName);
        return direct;
    }

    // Held by a live process. Decide based on owner label.
    const owner = readLockOwner(workspaceRoot, storageDirName);
    if (!owner || !isProcessAlive(owner.pid)) {
        // Race lost: another process either acquired or released between our
        // earlier attempt and reading. Try once more.
        const retry = acquireWorkspaceLock(workspaceRoot, label, storageDirName);
        if (retry) { clearPreemptRequest(workspaceRoot, storageDirName); return retry; }
        return null;
    }

    // Another MCP holds it — symmetry rule: don't preempt fellow MCPs.
    if (owner.label !== 'vscode-extension') return null;

    // Extension holds it — preempt.
    requestPreemption(workspaceRoot, label, storageDirName);

    // Poll for the extension to release.
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        if (!fs.existsSync(lockPath)) {
            const acquired = acquireWorkspaceLock(workspaceRoot, label, storageDirName);
            if (acquired) {
                clearPreemptRequest(workspaceRoot, storageDirName);
                return acquired;
            }
        }
        // Recheck owner — if the holder died mid-wait, fall through to steal.
        const curOwner = readLockOwner(workspaceRoot, storageDirName);
        if (curOwner && !isProcessAlive(curOwner.pid)) {
            try { fs.unlinkSync(lockPath); } catch { /* */ }
            const stolen = acquireWorkspaceLock(workspaceRoot, label, storageDirName);
            if (stolen) {
                clearPreemptRequest(workspaceRoot, storageDirName);
                return stolen;
            }
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    // Timed out. Leave the preempt-request file in place so the extension
    // can still yield (just past our window). Return null so MCP downgrades
    // to read-only for this session.
    return null;
}
