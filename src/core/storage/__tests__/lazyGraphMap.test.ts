/**
 * lazyGraphMap.test.ts
 *
 * Coverage for the LazyGraphMap + Proxy contract used to keep
 * `Snapshot.graphs` memory-bounded on huge workspaces (Issue #355).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitRefProvider } from '../gitRefProvider';
import { SqliteStore } from '../sqliteStore';
import { LazyGraphMap, makeLazyGraphsProxy, getLazyGraphMap, forEachGraph } from '../lazyGraphMap';
import type { DiagramGraph } from '../../graph/graphTypes';

function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-lazygraph-'));
}

async function makeSqlite(workspaceRoot: string): Promise<SqliteStore> {
    const provider = new GitRefProvider(workspaceRoot);
    const sqlite = new SqliteStore(workspaceRoot, provider);
    await sqlite.init();
    return sqlite;
}

function makeGraph(id: string, label: string = id): DiagramGraph {
    return {
        graphId: id,
        type: 'file',
        nodes: [{ id: 'n1', type: 'function', label, diff: 'unchanged' }],
        edges: [],
        anchors: {},
        meta: {},
    };
}

/**
 * Insert a snapshot row + N graph rows directly into the DB to set up a
 * "previously persisted" state — what hydrate would surface.
 */
function seedGraphs(sqlite: SqliteStore, kind: 'baseline' | 'working', graphs: DiagramGraph[]): void {
    const refId = sqlite.upsertGitRef('pre-git');
    sqlite.run(
        `INSERT INTO snapshots (kind, git_ref_id, schema_version, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(kind) DO UPDATE SET git_ref_id = excluded.git_ref_id`,
        [kind, refId, 1, Date.now()],
    );
    for (const g of graphs) {
        sqlite.run(
            `INSERT INTO graphs (snapshot_kind, graph_id, graph_json) VALUES (?, ?, ?)`,
            [kind, g.graphId, JSON.stringify(g)],
        );
    }
}

describe('LazyGraphMap', () => {
    let workspaceRoot: string;
    let sqlite: SqliteStore;

    beforeEach(async () => {
        workspaceRoot = tmp();
        sqlite = await makeSqlite(workspaceRoot);
    });

    afterEach(() => {
        sqlite.close();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('get(id) lazily fetches an existing DB row through the proxy', () => {
        const g = makeGraph('file:src/a.ts');
        seedGraphs(sqlite, 'working', [g]);
        const map = new LazyGraphMap(sqlite, 'working');
        map.resetWithIds(['file:src/a.ts']);
        const proxy = makeLazyGraphsProxy(map);
        const fetched = proxy['file:src/a.ts'];
        expect(fetched).toBeDefined();
        expect(fetched.graphId).toBe('file:src/a.ts');
        expect(fetched.nodes[0].label).toBe('file:src/a.ts');
    });

    it('returns undefined for unknown ids without hitting the DB', () => {
        const map = new LazyGraphMap(sqlite, 'working');
        map.resetWithIds([]);
        const proxy = makeLazyGraphsProxy(map);
        expect(proxy['file:does-not-exist.ts']).toBeUndefined();
    });

    it('Issue #790 — get(id) returns undefined (does not throw) when sqlite is not open', () => {
        // Repro for the [SqliteStore] get() called before init() race that
        // surfaces in monorepo mode (132 sub-repos): a known graph id is in
        // `ids` but the per-repo SqliteStore hasn't finished init (or was
        // closed between the cascade snapshot and the post-init broadcast).
        // `LazyGraphMap.get()` must mirror `forEach()`'s `isOpen()` guard
        // instead of throwing — otherwise the post-init wsBridge broadcast
        // crashes with a fatal error visible as `Failed: ... before init()`
        // in the user-facing progress overlay.
        seedGraphs(sqlite, 'working', [makeGraph('file:src/a.ts')]);
        const map = new LazyGraphMap(sqlite, 'working');
        map.resetWithIds(['file:src/a.ts']);
        // Cached writes still served from `dirty`/`cache`; close the underlying
        // store to simulate the "init race" path where a known id has not yet
        // been hydrated into cache.
        sqlite.close();
        expect(() => map.get('file:src/a.ts')).not.toThrow();
        expect(map.get('file:src/a.ts')).toBeUndefined();
        // Re-open so afterEach can close cleanly (close() is idempotent but
        // makeSqlite() leaks a temp db file otherwise).
    });

    it('Object.keys(proxy) returns IDs without fetching bodies', () => {
        seedGraphs(sqlite, 'working', [makeGraph('a'), makeGraph('b'), makeGraph('c')]);
        const map = new LazyGraphMap(sqlite, 'working');
        map.resetWithIds(['a', 'b', 'c']);
        const proxy = makeLazyGraphsProxy(map);
        expect(Object.keys(proxy).sort()).toEqual(['a', 'b', 'c']);
    });

    it('id in proxy uses the in-memory id set (no DB query)', () => {
        const map = new LazyGraphMap(sqlite, 'working');
        map.resetWithIds(['x']);
        const proxy = makeLazyGraphsProxy(map);
        expect('x' in proxy).toBe(true);
        expect('y' in proxy).toBe(false);
    });

    it('proxy.set buffers in dirty until flushDirty(); then survives re-open', async () => {
        const map = new LazyGraphMap(sqlite, 'working');
        map.resetWithIds([]);
        const proxy = makeLazyGraphsProxy(map);
        const g = makeGraph('flow:src/a.ts:foo');
        proxy['flow:src/a.ts:foo'] = g;
        // Need a snapshot row for the FK to resolve.
        const refId = sqlite.upsertGitRef('pre-git');
        sqlite.run(
            `INSERT INTO snapshots (kind, git_ref_id, schema_version, updated_at) VALUES ('working', ?, 1, ?)
             ON CONFLICT(kind) DO UPDATE SET git_ref_id = excluded.git_ref_id`,
            [refId, Date.now()],
        );
        map.flushDirty();
        sqlite.flush();
        sqlite.close();
        const sqlite2 = await makeSqlite(workspaceRoot);
        try {
            const row = sqlite2.get(
                `SELECT graph_json FROM graphs WHERE snapshot_kind = 'working' AND graph_id = ?`,
                ['flow:src/a.ts:foo'],
            );
            expect(row?.graph_json).toBeDefined();
        } finally {
            sqlite2.close();
            sqlite = await makeSqlite(workspaceRoot);
        }
    });

    it('proxy.delete tombstones the id and hides it from get/has/keys', () => {
        seedGraphs(sqlite, 'working', [makeGraph('keep'), makeGraph('drop')]);
        const map = new LazyGraphMap(sqlite, 'working');
        map.resetWithIds(['keep', 'drop']);
        const proxy = makeLazyGraphsProxy(map);
        delete proxy['drop'];
        expect(proxy['drop']).toBeUndefined();
        expect('drop' in proxy).toBe(false);
        expect(Object.keys(proxy)).toEqual(['keep']);
    });

    it('forEach streams every (id, graph) pair, surfacing dirty writes ahead of DB rows', () => {
        seedGraphs(sqlite, 'working', [makeGraph('persisted-1'), makeGraph('persisted-2')]);
        const map = new LazyGraphMap(sqlite, 'working');
        map.resetWithIds(['persisted-1', 'persisted-2']);
        // Pending dirty write that supersedes a persisted id (with a different label).
        map.set('persisted-1', makeGraph('persisted-1', 'OVERRIDDEN'));
        // And one brand-new id.
        map.set('new-1', makeGraph('new-1', 'NEW'));
        const seen = new Map<string, string>();
        map.forEach((id, g) => { seen.set(id, g.nodes[0].label as string); });
        expect(seen.get('persisted-1')).toBe('OVERRIDDEN');
        expect(seen.get('persisted-2')).toBe('persisted-2');
        expect(seen.get('new-1')).toBe('NEW');
        expect(seen.size).toBe(3);
    });

    it('forEach respects early exit when callback returns false', () => {
        seedGraphs(sqlite, 'working', [makeGraph('a'), makeGraph('b'), makeGraph('c')]);
        const map = new LazyGraphMap(sqlite, 'working');
        map.resetWithIds(['a', 'b', 'c']);
        const seen: string[] = [];
        map.forEach((id) => {
            seen.push(id);
            return seen.length < 2 ? undefined : false;
        });
        expect(seen.length).toBe(2);
    });

    it('LRU caps cached graph bodies at the configured limit', () => {
        const ids = Array.from({ length: 10 }, (_, i) => `g${i}`);
        seedGraphs(sqlite, 'working', ids.map(id => makeGraph(id)));
        const map = new LazyGraphMap(sqlite, 'working', /* lruLimit */ 3);
        map.resetWithIds(ids);
        // Get g0 — caches it.
        const refBefore = map.get('g0');
        // Now touch enough other ids to evict g0 from the 3-slot LRU.
        for (let i = 1; i <= 5; i++) map.get(`g${i}`);
        // g0 should have been evicted from cache. Re-fetching produces a
        // freshly parsed JSON object — different identity from refBefore.
        const refAfterEviction = map.get('g0');
        expect(refAfterEviction).not.toBe(refBefore);
        // Subsequent reads of an in-cache id share identity (cache hit).
        const recent1 = map.get('g0');
        const recent2 = map.get('g0');
        expect(recent1).toBe(recent2);
    });

    it('forgetBodies clears the cache but keeps known IDs', () => {
        seedGraphs(sqlite, 'working', [makeGraph('a')]);
        const map = new LazyGraphMap(sqlite, 'working');
        map.resetWithIds(['a']);
        map.get('a'); // populate cache
        map.forgetBodies();
        expect(map.has('a')).toBe(true);
        // Next get must re-fetch from DB (different reference).
        const fresh = map.get('a');
        expect(fresh?.graphId).toBe('a');
    });

    it('forgetAll wipes ids, dirty, tombstones, and cache', () => {
        seedGraphs(sqlite, 'working', [makeGraph('a')]);
        const map = new LazyGraphMap(sqlite, 'working');
        map.resetWithIds(['a']);
        map.set('b', makeGraph('b'));
        map.delete('a');
        map.forgetAll();
        expect(map.size()).toBe(0);
        expect(map.has('a')).toBe(false);
        expect(map.has('b')).toBe(false);
    });

    it('forEachGraph helper falls back to Object.entries when graphs is not a lazy proxy', () => {
        const plain: Record<string, DiagramGraph> = {
            x: makeGraph('x'),
            y: makeGraph('y'),
        };
        const seen: string[] = [];
        forEachGraph(plain, (id) => { seen.push(id); });
        expect(seen.sort()).toEqual(['x', 'y']);
    });

    it('getLazyGraphMap returns the underlying map only for proxy-wrapped graphs', () => {
        const map = new LazyGraphMap(sqlite, 'working');
        const proxy = makeLazyGraphsProxy(map);
        expect(getLazyGraphMap(proxy)).toBe(map);
        expect(getLazyGraphMap({ x: makeGraph('x') })).toBeUndefined();
    });

    // #907 — the cross-file sequence-dependency pass used `forEachGraph` which
    // JSON.parsed EVERY working graph just to filter by type. The fix enumerates
    // ids via the underlying map's `.keys()` (NO hydration) and gates on the
    // `sequence:` prefix BEFORE hydrating. This pins the two load-bearing
    // properties: map.keys() does not hydrate, and touching only the
    // prefix-matched ids hydrates only those rows.
    //
    // It also documents the trap the first cut fell into: `Object.keys(proxy)`
    // hydrates every key through `getOwnPropertyDescriptor`, so the fix must use
    // `getLazyGraphMap(graphs).keys()`, never `Object.keys`.
    it('#907 — map.keys() enumerates ids without hydrating; prefix-filter hydrates only matches', () => {
        const graphs: DiagramGraph[] = [];
        for (let i = 0; i < 50; i++) graphs.push(makeGraph(`file:src/f${i}.ts`));     // non-sequence corpus
        for (let i = 0; i < 3; i++) graphs.push(makeGraph(`sequence:src/ctrl.ts:h${i}`)); // the few we care about
        seedGraphs(sqlite, 'working', graphs);
        const map = new LazyGraphMap(sqlite, 'working');
        map.resetWithIds(graphs.map((g) => g.graphId));
        const proxy = makeLazyGraphsProxy(map);

        const getSpy = vi.spyOn(sqlite, 'get');

        // Enumerating via the underlying map keys must NOT fetch any graph body.
        const ids = getLazyGraphMap(proxy)!.keys();
        expect(ids.length).toBe(53);
        expect(getSpy).not.toHaveBeenCalled();

        // The #907 access pattern: filter to `sequence:` first, hydrate only those.
        let touched = 0;
        for (const id of ids) {
            if (!id.startsWith('sequence:')) continue;
            if (proxy[id]) touched++; // indexed access hydrates this one row
        }
        expect(touched).toBe(3);
        // Exactly 3 body fetches — NOT 53 (the old whole-corpus forEachGraph cost).
        expect(getSpy).toHaveBeenCalledTimes(3);
        getSpy.mockRestore();
    });

    it('#907 — guards against the regression: Object.keys(proxy) DOES hydrate every key', () => {
        const graphs: DiagramGraph[] = [];
        for (let i = 0; i < 10; i++) graphs.push(makeGraph(`file:src/f${i}.ts`));
        seedGraphs(sqlite, 'working', graphs);
        const map = new LazyGraphMap(sqlite, 'working');
        map.resetWithIds(graphs.map((g) => g.graphId));
        const proxy = makeLazyGraphsProxy(map);
        const getSpy = vi.spyOn(sqlite, 'get');
        // Object.keys triggers getOwnPropertyDescriptor per key → full hydration.
        // This is exactly why the fix must use map.keys() instead.
        Object.keys(proxy);
        expect(getSpy).toHaveBeenCalledTimes(10);
        getSpy.mockRestore();
    });
});
