/**
 * ADR-034 Phase D Tier-1 (#789 — Phase D: parallel per-repo parse + per-repo watcher (ADR-034)) — WorkspaceWatcher tests.
 *
 * Uses an in-memory fake watcher (injected via `watcherFactory`) so no
 * real chokidar is started. Exercises per-repo prefix dispatch,
 * nested-repo precedence, updateRepos without recreating the watcher,
 * unsubscribe, close idempotence, and error isolation.
 */
import { describe, it, expect } from 'vitest';
import { WorkspaceWatcher } from '../workspaceWatcher';
import type { MinimalWatcher } from '../workspaceWatcher';
import type { RepoRow } from '../storage/storeInterfaces';

function row(rootPath: string, repoId: string = `r-${rootPath || 'root'}`): RepoRow {
    return {
        repoId, name: rootPath || 'root', rootPath, realpathHash: repoId,
        technology: null, status: 'ready', lastInitAt: 0, errorMessage: null,
        fallbackStatePath: null, stateDbSchemaVersion: 9, summarySchemaVersion: 1,
        diff: null,
    };
}

class FakeWatcher implements MinimalWatcher {
    closed = false;
    private listeners = new Map<string, Array<(...args: any[]) => void>>();
    on(event: string, listener: (...args: any[]) => void): this {
        const arr = this.listeners.get(event) ?? [];
        arr.push(listener);
        this.listeners.set(event, arr);
        return this;
    }
    close(): Promise<void> {
        this.closed = true;
        return Promise.resolve();
    }
    /** Inject an event into the listeners. */
    fire(event: 'change' | 'add' | 'unlink' | 'error', ...args: any[]): void {
        for (const fn of this.listeners.get(event) ?? []) fn(...args);
    }
}

function makeWatcher(repos: RepoRow[], workspaceRoot = '/workspace'): { ww: WorkspaceWatcher; fake: FakeWatcher; logs: string[] } {
    const fake = new FakeWatcher();
    const logs: string[] = [];
    const ww = new WorkspaceWatcher(repos, {
        workspaceRoot,
        watcherFactory: () => fake,
        log: (msg) => logs.push(msg),
    });
    return { ww, fake, logs };
}

describe('WorkspaceWatcher — per-repo dispatch', () => {
    it('routes a change event in svc-alpha to repo-A only', () => {
        const { ww, fake } = makeWatcher([row('svc-alpha'), row('svc-beta')]);
        const events: { repoId: string; path: string; kind: string }[] = [];
        ww.on((repoId, path, kind) => events.push({ repoId, path, kind }));
        fake.fire('change', '/workspace/svc-alpha/src/server.js');
        expect(events).toEqual([
            { repoId: 'r-svc-alpha', path: 'svc-alpha/src/server.js', kind: 'change' },
        ]);
        ww.close();
    });

    it('add + unlink events both routed', () => {
        const { ww, fake } = makeWatcher([row('svc-alpha')]);
        const events: { kind: string }[] = [];
        ww.on((_id, _p, kind) => events.push({ kind }));
        fake.fire('add', '/workspace/svc-alpha/src/new.js');
        fake.fire('unlink', '/workspace/svc-alpha/src/old.js');
        expect(events.map((e) => e.kind)).toEqual(['add', 'unlink']);
        ww.close();
    });
});

describe('WorkspaceWatcher — longest-prefix match', () => {
    it('nested repo beats shallower one (apps/frontend wins over apps)', () => {
        const { ww, fake } = makeWatcher([
            row('apps', 'r-apps'),
            row('apps/frontend', 'r-fe'),
        ]);
        const events: string[] = [];
        ww.on((repoId) => events.push(repoId));
        fake.fire('change', '/workspace/apps/frontend/src/App.tsx');
        expect(events).toEqual(['r-fe']);
        ww.close();
    });

    it('single-repo (rootPath="") captures every file', () => {
        const { ww, fake } = makeWatcher([row('', 'r-only')]);
        const events: string[] = [];
        ww.on((repoId) => events.push(repoId));
        fake.fire('change', '/workspace/src/server.js');
        fake.fire('change', '/workspace/anything/deep/nested.js');
        expect(events).toEqual(['r-only', 'r-only']);
        ww.close();
    });

    it('files outside any repo prefix are dropped (with log)', () => {
        const { ww, fake, logs } = makeWatcher([row('svc-alpha')]);
        const events: string[] = [];
        ww.on((repoId) => events.push(repoId));
        fake.fire('change', '/workspace/orphan-at-root.md');
        expect(events).toEqual([]);
        expect(logs.some((m) => m.includes('no matching repo'))).toBe(true);
        ww.close();
    });

    it('paths outside the workspace are ignored', () => {
        const { ww, fake } = makeWatcher([row('svc-alpha')]);
        const events: string[] = [];
        ww.on((repoId) => events.push(repoId));
        fake.fire('change', '/some/other/place/file.js');
        expect(events).toEqual([]);
        ww.close();
    });
});

describe('WorkspaceWatcher — listener lifecycle', () => {
    it('unsubscribe stops further events', () => {
        const { ww, fake } = makeWatcher([row('svc-alpha')]);
        const events: string[] = [];
        const off = ww.on((id) => events.push(id));
        fake.fire('change', '/workspace/svc-alpha/a.js');
        off();
        fake.fire('change', '/workspace/svc-alpha/b.js');
        expect(events).toEqual(['r-svc-alpha']);
        ww.close();
    });

    it('listener throw does not break the watcher', () => {
        const { ww, fake } = makeWatcher([row('svc-alpha')]);
        const goodEvents: string[] = [];
        ww.on(() => { throw new Error('listener boom'); });
        ww.on((id) => goodEvents.push(id));
        fake.fire('change', '/workspace/svc-alpha/x.js');
        expect(goodEvents).toEqual(['r-svc-alpha']);
        ww.close();
    });
});

describe('WorkspaceWatcher — updateRepos', () => {
    it('does not recreate chokidar (same FakeWatcher instance)', () => {
        const { ww, fake } = makeWatcher([row('svc-alpha')]);
        ww.updateRepos([row('svc-alpha'), row('svc-beta')]);
        const events: string[] = [];
        ww.on((id) => events.push(id));
        fake.fire('change', '/workspace/svc-beta/src/x.js');
        expect(events).toEqual(['r-svc-beta']);
        expect(fake.closed).toBe(false);
        ww.close();
        expect(fake.closed).toBe(true);
    });

    it('drops a removed repo from routing', () => {
        const { ww, fake } = makeWatcher([row('svc-alpha'), row('svc-beta')]);
        ww.updateRepos([row('svc-alpha')]);   // svc-beta dropped
        const events: string[] = [];
        ww.on((id) => events.push(id));
        fake.fire('change', '/workspace/svc-beta/leftover.js');
        expect(events).toEqual([]);
        ww.close();
    });
});

describe('WorkspaceWatcher — close', () => {
    it('close is idempotent', async () => {
        const { ww, fake } = makeWatcher([row('svc-alpha')]);
        await ww.close();
        await ww.close();
        expect(fake.closed).toBe(true);
    });

    it('events after close are dropped', () => {
        const { ww, fake } = makeWatcher([row('svc-alpha')]);
        const events: string[] = [];
        ww.on((id) => events.push(id));
        ww.close();
        fake.fire('change', '/workspace/svc-alpha/x.js');
        expect(events).toEqual([]);
    });
});
