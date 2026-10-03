/**
 * workspaceLock.test.ts — covers acquire / release / stale-detection / read.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    acquireWorkspaceLock,
    readLockOwner,
    isLockHeldByLiveProcess,
    LOCK_FILE_NAME,
    PREEMPT_FILE_NAME,
    requestPreemption,
    readPreemptRequest,
    clearPreemptRequest,
    watchPreemptRequest,
    acquireWorkspaceLockPreferred,
    watchLockReclaimable,
} from '../workspaceLock';

function tmpdir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
}

describe('acquireWorkspaceLock', () => {
    it('grabs a free workspace and returns a release fn', () => {
        const dir = tmpdir();
        const lock = acquireWorkspaceLock(dir, 'unit-test');
        expect(lock).not.toBeNull();
        expect(lock!.pid).toBe(process.pid);
        expect(fs.existsSync(lock!.path)).toBe(true);
        lock!.release();
        expect(fs.existsSync(lock!.path)).toBe(false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns null when another live process holds the lock', () => {
        const dir = tmpdir();
        const lockDir = path.join(dir, '.codeatlas');
        fs.mkdirSync(lockDir, { recursive: true });
        // Stamp the file with our own PID — simulating a sibling process.
        fs.writeFileSync(
            path.join(lockDir, LOCK_FILE_NAME),
            JSON.stringify({ pid: process.pid, startedAt: Date.now(), label: 'preexisting' }),
        );
        const second = acquireWorkspaceLock(dir, 'second');
        expect(second).toBeNull();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('steals a stale lock left behind by a dead PID', () => {
        const dir = tmpdir();
        const lockDir = path.join(dir, '.codeatlas');
        fs.mkdirSync(lockDir, { recursive: true });
        // PID 1 is init/launchd — always alive on POSIX. Use a very-high PID
        // that's vanishingly unlikely to exist.
        const FAKE_DEAD_PID = 2_147_483_647;
        fs.writeFileSync(
            path.join(lockDir, LOCK_FILE_NAME),
            JSON.stringify({ pid: FAKE_DEAD_PID, startedAt: Date.now() - 60_000, label: 'ghost' }),
        );
        const lock = acquireWorkspaceLock(dir, 'stealer');
        expect(lock).not.toBeNull();
        expect(lock!.pid).toBe(process.pid);
        lock!.release();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('release is idempotent', () => {
        const dir = tmpdir();
        const lock = acquireWorkspaceLock(dir, 'idempotent');
        lock!.release();
        // Second call must not throw or recreate the file.
        expect(() => lock!.release()).not.toThrow();
        expect(fs.existsSync(lock!.path)).toBe(false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('readLockOwner returns the parsed owner', () => {
        const dir = tmpdir();
        const lock = acquireWorkspaceLock(dir, 'tagged');
        const owner = readLockOwner(dir);
        expect(owner).not.toBeNull();
        expect(owner!.pid).toBe(process.pid);
        expect(owner!.label).toBe('tagged');
        lock!.release();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('readLockOwner returns null when no lock exists', () => {
        const dir = tmpdir();
        expect(readLockOwner(dir)).toBeNull();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('isLockHeldByLiveProcess detects a live owner and a stale one', () => {
        const dir = tmpdir();
        const lockDir = path.join(dir, '.codeatlas');
        fs.mkdirSync(lockDir, { recursive: true });
        // Stale lock first.
        fs.writeFileSync(path.join(lockDir, LOCK_FILE_NAME), JSON.stringify({ pid: 2_147_483_647, startedAt: 0 }));
        expect(isLockHeldByLiveProcess(dir)).toBe(false);
        // Live lock — acquire properly.
        fs.unlinkSync(path.join(lockDir, LOCK_FILE_NAME));
        const lock = acquireWorkspaceLock(dir, 'live');
        expect(isLockHeldByLiveProcess(dir)).toBe(true);
        lock!.release();
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('preempt protocol', () => {
    it('requestPreemption writes a parsable PREEMPT_FILE', () => {
        const dir = tmpdir();
        const filePath = requestPreemption(dir, 'mcp-test');
        expect(filePath).not.toBeNull();
        const req = readPreemptRequest(dir);
        expect(req).not.toBeNull();
        expect(req!.pid).toBe(process.pid);
        expect(req!.label).toBe('mcp-test');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('readPreemptRequest returns null when no file or malformed', () => {
        const dir = tmpdir();
        expect(readPreemptRequest(dir)).toBeNull();
        fs.mkdirSync(path.join(dir, '.codeatlas'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.codeatlas', PREEMPT_FILE_NAME), 'garbage');
        expect(readPreemptRequest(dir)).toBeNull();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('clearPreemptRequest removes the file', () => {
        const dir = tmpdir();
        requestPreemption(dir);
        expect(readPreemptRequest(dir)).not.toBeNull();
        clearPreemptRequest(dir);
        expect(readPreemptRequest(dir)).toBeNull();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('watchPreemptRequest fires when a request appears', async () => {
        const dir = tmpdir();
        let received: any = null;
        const unwatch = watchPreemptRequest(dir, (req) => { received = req; }, 50);
        // Wait a tick to ensure watcher is active.
        await new Promise((r) => setTimeout(r, 80));
        requestPreemption(dir, 'late-arrival');
        await new Promise((r) => setTimeout(r, 200));
        expect(received).not.toBeNull();
        expect(received.label).toBe('late-arrival');
        unwatch();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('watchPreemptRequest fires once even if the request landed before the watcher started', async () => {
        const dir = tmpdir();
        requestPreemption(dir, 'early-bird');
        let received: any = null;
        const unwatch = watchPreemptRequest(dir, (req) => { received = req; }, 50);
        await new Promise((r) => setTimeout(r, 50));
        expect(received).not.toBeNull();
        expect(received.label).toBe('early-bird');
        unwatch();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('acquireWorkspaceLockPreferred grabs a free workspace immediately', async () => {
        const dir = tmpdir();
        const lock = await acquireWorkspaceLockPreferred(dir, 'mcp-server');
        expect(lock).not.toBeNull();
        lock!.release();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('acquireWorkspaceLockPreferred returns null when another live MCP holds the lock', async () => {
        const dir = tmpdir();
        // Stamp the lock as if a sibling MCP holds it (use our PID so it's alive).
        const lockDir = path.join(dir, '.codeatlas');
        fs.mkdirSync(lockDir, { recursive: true });
        fs.writeFileSync(
            path.join(lockDir, LOCK_FILE_NAME),
            JSON.stringify({ pid: process.pid, startedAt: Date.now(), label: 'mcp-server' }),
        );
        const result = await acquireWorkspaceLockPreferred(dir, 'mcp-server', 200);
        expect(result).toBeNull();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('acquireWorkspaceLockPreferred preempts the vscode-extension lock and acquires after release', async () => {
        const dir = tmpdir();
        const lockDir = path.join(dir, '.codeatlas');
        fs.mkdirSync(lockDir, { recursive: true });
        // Simulate extension holding the lock (use our PID).
        fs.writeFileSync(
            path.join(lockDir, LOCK_FILE_NAME),
            JSON.stringify({ pid: process.pid, startedAt: Date.now(), label: 'vscode-extension' }),
        );
        // Schedule the extension's "release" mid-acquire.
        setTimeout(() => {
            try { fs.unlinkSync(path.join(lockDir, LOCK_FILE_NAME)); } catch { /* */ }
        }, 300);
        const t0 = Date.now();
        const result = await acquireWorkspaceLockPreferred(dir, 'mcp-server', 2000, 50);
        const dt = Date.now() - t0;
        expect(result).not.toBeNull();
        // Preempt request was issued during the wait.
        // (It may have been cleared already on successful acquire — that's the expected post-state.)
        expect(readPreemptRequest(dir)).toBeNull();
        // The wait should have honoured the simulated release timing.
        expect(dt).toBeGreaterThanOrEqual(200);
        expect(dt).toBeLessThan(2000);
        result!.release();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('acquireWorkspaceLockPreferred returns null when extension doesn\'t yield in time', async () => {
        const dir = tmpdir();
        const lockDir = path.join(dir, '.codeatlas');
        fs.mkdirSync(lockDir, { recursive: true });
        fs.writeFileSync(
            path.join(lockDir, LOCK_FILE_NAME),
            JSON.stringify({ pid: process.pid, startedAt: Date.now(), label: 'vscode-extension' }),
        );
        const result = await acquireWorkspaceLockPreferred(dir, 'mcp-server', 300, 50);
        expect(result).toBeNull();
        // Preempt request file should still exist — left for a possible
        // later yield by the extension.
        expect(readPreemptRequest(dir)).not.toBeNull();
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

// #829 (2026-06-10) — reclaim watcher. After the extension yields its lock
// to a preempting MCP process, it must notice when that process exits so
// it can re-acquire, re-enable auto-update, and resync (the MCP wrote the
// DB while the extension's in-memory state was frozen).
describe('watchLockReclaimable (#829)', () => {
    it('does NOT fire while a live owner holds the lock', async () => {
        const dir = tmpdir();
        const lockDir = path.join(dir, '.codeatlas');
        fs.mkdirSync(lockDir, { recursive: true });
        // Live owner = our own PID.
        fs.writeFileSync(
            path.join(lockDir, LOCK_FILE_NAME),
            JSON.stringify({ pid: process.pid, startedAt: Date.now(), label: 'mcp-server' }),
        );
        let fired = 0;
        const unwatch = watchLockReclaimable(dir, () => { fired++; }, 30, 2);
        await new Promise((r) => setTimeout(r, 250));
        expect(fired).toBe(0);
        unwatch();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('fires once after the lock stays free for the required consecutive polls', async () => {
        const dir = tmpdir();
        const lockDir = path.join(dir, '.codeatlas');
        fs.mkdirSync(lockDir, { recursive: true });
        fs.writeFileSync(
            path.join(lockDir, LOCK_FILE_NAME),
            JSON.stringify({ pid: process.pid, startedAt: Date.now(), label: 'mcp-server' }),
        );
        let fired = 0;
        const unwatch = watchLockReclaimable(dir, () => { fired++; }, 30, 2);
        await new Promise((r) => setTimeout(r, 100));
        expect(fired).toBe(0);
        // MCP exits → lock file removed.
        fs.unlinkSync(path.join(lockDir, LOCK_FILE_NAME));
        await new Promise((r) => setTimeout(r, 300));
        expect(fired).toBe(1);
        unwatch();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('a momentary free window (lock re-taken within the grace polls) does NOT fire', async () => {
        const dir = tmpdir();
        const lockDir = path.join(dir, '.codeatlas');
        fs.mkdirSync(lockDir, { recursive: true });
        const lockPath = path.join(lockDir, LOCK_FILE_NAME);
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), label: 'mcp-server' }));
        let fired = 0;
        // Long grace (4 consecutive free polls at 50ms = 200ms of free lock).
        const unwatch = watchLockReclaimable(dir, () => { fired++; }, 50, 4);
        await new Promise((r) => setTimeout(r, 80));
        // Free for ~one poll, then a new owner grabs it (handover window).
        fs.unlinkSync(lockPath);
        await new Promise((r) => setTimeout(r, 60));
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), label: 'mcp-server-2' }));
        await new Promise((r) => setTimeout(r, 400));
        expect(fired).toBe(0);
        unwatch();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('fires when the recorded owner PID is dead (stale lock)', async () => {
        const dir = tmpdir();
        const lockDir = path.join(dir, '.codeatlas');
        fs.mkdirSync(lockDir, { recursive: true });
        const FAKE_DEAD_PID = 2_147_483_647;
        fs.writeFileSync(
            path.join(lockDir, LOCK_FILE_NAME),
            JSON.stringify({ pid: FAKE_DEAD_PID, startedAt: Date.now() - 60_000, label: 'mcp-server' }),
        );
        let fired = 0;
        const unwatch = watchLockReclaimable(dir, () => { fired++; }, 30, 2);
        await new Promise((r) => setTimeout(r, 250));
        expect(fired).toBe(1);
        unwatch();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('unwatch stops the watcher before it fires', async () => {
        const dir = tmpdir();
        // No lock at all — would fire after the grace period.
        let fired = 0;
        const unwatch = watchLockReclaimable(dir, () => { fired++; }, 30, 3);
        unwatch();
        await new Promise((r) => setTimeout(r, 250));
        expect(fired).toBe(0);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

// Per-store scoping: the VS Code extension (`.codeatlas`) and the standalone
// MCP (`.codeatlas-sa`) write DIFFERENT state.db files and must not contend or
// preempt each other. The lock/preempt files are scoped to the storage dir.
describe('per-store lock scoping (.codeatlas vs .codeatlas-sa)', () => {
    it('a lock on .codeatlas does NOT block a lock on .codeatlas-sa (same repo)', () => {
        const dir = tmpdir();
        const ext = acquireWorkspaceLock(dir, 'vscode-extension'); // default .codeatlas
        const sa = acquireWorkspaceLock(dir, 'mcp-server', '.codeatlas-sa');
        expect(ext, 'extension acquires .codeatlas').not.toBeNull();
        expect(sa, 'standalone acquires .codeatlas-sa independently').not.toBeNull();
        // Two distinct lock files.
        expect(ext!.path).toContain(path.join('.codeatlas', LOCK_FILE_NAME));
        expect(sa!.path).toContain(path.join('.codeatlas-sa', LOCK_FILE_NAME));
        expect(ext!.path).not.toBe(sa!.path);
        ext!.release();
        sa!.release();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('two holders of the SAME store still exclude each other', () => {
        const dir = tmpdir();
        const saDir = path.join(dir, '.codeatlas-sa');
        fs.mkdirSync(saDir, { recursive: true });
        // Simulate a live holder of the .codeatlas-sa store (our own PID).
        fs.writeFileSync(
            path.join(saDir, LOCK_FILE_NAME),
            JSON.stringify({ pid: process.pid, startedAt: Date.now(), label: 'mcp-server' }),
        );
        const second = acquireWorkspaceLock(dir, 'second-mcp', '.codeatlas-sa');
        expect(second, 'same-store second writer is blocked').toBeNull();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('readLockOwner / preempt files are scoped to the store', () => {
        const dir = tmpdir();
        const ext = acquireWorkspaceLock(dir, 'vscode-extension');
        expect(readLockOwner(dir)!.label).toBe('vscode-extension');      // .codeatlas
        expect(readLockOwner(dir, '.codeatlas-sa'), 'sa store is empty').toBeNull();
        // A preempt request in one store is invisible to the other.
        requestPreemption(dir, 'mcp-server', '.codeatlas-sa');
        expect(readPreemptRequest(dir, '.codeatlas-sa')).not.toBeNull();
        expect(readPreemptRequest(dir), '.codeatlas has no preempt request').toBeNull();
        clearPreemptRequest(dir, '.codeatlas-sa');
        ext!.release();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('acquireWorkspaceLockPreferred on .codeatlas-sa ignores an extension lock on .codeatlas', async () => {
        const dir = tmpdir();
        // Extension holds .codeatlas (live PID).
        const ext = acquireWorkspaceLock(dir, 'vscode-extension');
        expect(ext).not.toBeNull();
        // Standalone acquires its own .codeatlas-sa store immediately — no
        // preemption of the extension, no wait.
        const t0 = Date.now();
        const sa = await acquireWorkspaceLockPreferred(dir, 'mcp-server', 2000, 50, '.codeatlas-sa');
        expect(sa, 'standalone acquires without preempting the extension').not.toBeNull();
        expect(Date.now() - t0, 'acquired immediately, did not wait on the extension').toBeLessThan(500);
        // The extension's lock is untouched — no preempt request against it.
        expect(readPreemptRequest(dir), 'extension store got no preempt request').toBeNull();
        expect(readLockOwner(dir)!.label, 'extension still owns .codeatlas').toBe('vscode-extension');
        ext!.release();
        sa!.release();
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
