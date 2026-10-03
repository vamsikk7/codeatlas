/**
 * fileWatcher.test.ts — verifies the chokidar-backed file watcher fans
 * lifecycle events to the orchestrator callbacks the extension already
 * has. We inject a mock chokidar so the test doesn't depend on filesystem
 * timing — the contract under test is the WIRING (which event triggers
 * which callback), not chokidar itself.
 */
import { describe, it, expect, vi } from 'vitest';
import { startStandaloneFileWatcher } from '../fileWatcher';

type Handler = (...args: unknown[]) => void;

function makeMockChokidar() {
    const sourceListeners = new Map<string, Handler>();
    const gitListeners = new Map<string, Handler>();
    let sourceClosed = false;
    let gitClosed = false;

    // chokidar.watch is called twice: once for the source watcher, once for git.
    let callCount = 0;
    const chokidarImpl = {
        watch: vi.fn((_target: unknown, _opts: unknown) => {
            callCount++;
            // Capture which call this watcher belongs to at construction time
            // — the outer `callCount` keeps incrementing, so a late `close()`
            // would otherwise misroute.
            const isSourceWatcher = callCount === 1;
            const listeners = isSourceWatcher ? sourceListeners : gitListeners;
            const watcher: any = {
                on(event: string, handler: Handler) {
                    listeners.set(event, handler);
                    return watcher;
                },
                async close() {
                    if (isSourceWatcher) sourceClosed = true;
                    else gitClosed = true;
                },
            };
            return watcher;
        }),
    } as any;

    function fireSource(event: string, fp: string) { sourceListeners.get(event)?.(fp); }
    function fireGit(event: string, fp: string) { gitListeners.get(event)?.(fp); }

    return {
        chokidarImpl,
        fireSource,
        fireGit,
        isClosed: () => ({ source: sourceClosed, git: gitClosed }),
        watchCalls: () => chokidarImpl.watch.mock.calls,
    };
}

describe('startStandaloneFileWatcher', () => {
    it('fires handleFileSave on chokidar `change`', async () => {
        const cb = vi.fn();
        const mock = makeMockChokidar();
        const w = await startStandaloneFileWatcher({
            workspaceRoot: '/repo', ignore: ['**/node_modules/**'],
            callbacks: { handleFileSave: cb },
            chokidarImpl: mock.chokidarImpl,
        });
        mock.fireSource('change', '/repo/src/a.ts');
        expect(cb).toHaveBeenCalledWith('/repo/src/a.ts');
        await w.stop();
    });

    it('fires handleFileCreated on chokidar `add`', async () => {
        const cb = vi.fn();
        const mock = makeMockChokidar();
        const w = await startStandaloneFileWatcher({
            workspaceRoot: '/repo', ignore: [],
            callbacks: { handleFileCreated: cb },
            chokidarImpl: mock.chokidarImpl,
        });
        mock.fireSource('add', '/repo/src/new.ts');
        expect(cb).toHaveBeenCalledWith('/repo/src/new.ts');
        await w.stop();
    });

    it('fires handleFileDeleted on chokidar `unlink`', async () => {
        const cb = vi.fn();
        const mock = makeMockChokidar();
        const w = await startStandaloneFileWatcher({
            workspaceRoot: '/repo', ignore: [],
            callbacks: { handleFileDeleted: cb },
            chokidarImpl: mock.chokidarImpl,
        });
        mock.fireSource('unlink', '/repo/src/gone.ts');
        expect(cb).toHaveBeenCalledWith('/repo/src/gone.ts');
        await w.stop();
    });

    it('fires handleGitRefChange on changes to .git/HEAD or .git/logs/HEAD', async () => {
        const cb = vi.fn();
        const mock = makeMockChokidar();
        const w = await startStandaloneFileWatcher({
            workspaceRoot: '/repo', ignore: [],
            callbacks: { handleGitRefChange: cb },
            chokidarImpl: mock.chokidarImpl,
        });
        mock.fireGit('change', '/repo/.git/logs/HEAD');
        expect(cb).toHaveBeenCalledTimes(1);
        mock.fireGit('add', '/repo/.git/HEAD');
        expect(cb).toHaveBeenCalledTimes(2);
        await w.stop();
    });

    it('passes a function-based ignore predicate to chokidar (#523)', async () => {
        const mock = makeMockChokidar();
        const w = await startStandaloneFileWatcher({
            workspaceRoot: '/repo',
            ignore: ['**/custom-user-pattern/**'],
            callbacks: {},
            chokidarImpl: mock.chokidarImpl,
        });
        const firstCallOpts = mock.watchCalls()[0][1] as any;
        // The fix switched from glob array → function for reliability across
        // chokidar/anymatch versions and absolute vs relative paths.
        expect(typeof firstCallOpts.ignored).toBe('function');
        // Built-in heavy directories must be rejected.
        expect(firstCallOpts.ignored('/repo/node_modules/foo/index.js')).toBe(true);
        expect(firstCallOpts.ignored('/repo/.git/HEAD')).toBe(true);
        expect(firstCallOpts.ignored('/repo/.codeatlas/state.db')).toBe(true);
        expect(firstCallOpts.ignored('/repo/.codeatlas-sa-probe/state.db')).toBe(true);
        // Source files must NOT be rejected.
        expect(firstCallOpts.ignored('/repo/src/main.ts')).toBe(false);
        // User-supplied patterns work via minimatch.
        expect(firstCallOpts.ignored('/repo/custom-user-pattern/x.ts')).toBe(true);
        await w.stop();
    });

    it('stop() closes both source and git watchers', async () => {
        const mock = makeMockChokidar();
        const w = await startStandaloneFileWatcher({
            workspaceRoot: '/repo', ignore: [],
            callbacks: {},
            chokidarImpl: mock.chokidarImpl,
        });
        expect(w.isActive()).toBe(true);
        await w.stop();
        expect(w.isActive()).toBe(false);
        expect(mock.isClosed()).toEqual({ source: true, git: true });
    });

    it('callbacks that throw do not bubble up to the chokidar listener', async () => {
        const mock = makeMockChokidar();
        const w = await startStandaloneFileWatcher({
            workspaceRoot: '/repo', ignore: [],
            callbacks: {
                handleFileSave: () => { throw new Error('boom'); },
            },
            chokidarImpl: mock.chokidarImpl,
        });
        // Should not throw — the watcher swallows + logs.
        expect(() => mock.fireSource('change', '/repo/src/a.ts')).not.toThrow();
        await w.stop();
    });

    it('survives multiple stop() calls', async () => {
        const mock = makeMockChokidar();
        const w = await startStandaloneFileWatcher({
            workspaceRoot: '/repo', ignore: [],
            callbacks: {},
            chokidarImpl: mock.chokidarImpl,
        });
        await w.stop();
        await expect(w.stop()).resolves.toBeUndefined();
    });

    // BUG-EXP-14 — the git watcher previously had NO 'error' listener, so an
    // `EMFILE` on a large repo was an unhandled EventEmitter error → the whole
    // daemon crashed. It must now register an error handler and close the watcher.
    it('handles a git-watcher error without crashing and closes it (BUG-EXP-14)', async () => {
        const mock = makeMockChokidar();
        const w = await startStandaloneFileWatcher({
            workspaceRoot: '/repo', ignore: [], callbacks: {}, chokidarImpl: mock.chokidarImpl,
        });
        expect(() => mock.fireGit('error', 'EMFILE: too many open files, watch')).not.toThrow();
        expect(mock.isClosed().git, 'git watcher closed on error').toBe(true);
        await w.stop();
    });

    it('closes the source watcher on an EMFILE error to end the storm (BUG-EXP-14)', async () => {
        const mock = makeMockChokidar();
        const w = await startStandaloneFileWatcher({
            workspaceRoot: '/repo', ignore: [], callbacks: {}, chokidarImpl: mock.chokidarImpl,
        });
        mock.fireSource('error', 'Error: EMFILE: too many open files, watch');
        expect(mock.isClosed().source, 'source watcher closed on EMFILE').toBe(true);
        await w.stop();
    });
});
