/**
 * lazyGraphMap.ts
 *
 * Memory-bounded lazy map for `Snapshot.graphs`. On hydrate we load only
 * graph IDs (a Set<string>); graph bodies are fetched from SQLite on demand
 * with a small LRU cache. The LazyGraphMap is exposed to consumers via a
 * Proxy so that the existing `snapshot.graphs[id]` access pattern keeps
 * working — most call sites need zero changes.
 *
 * Iterators (`Object.entries(snap.graphs)`, `Object.values`, etc.) WILL
 * still trigger a fetch per graph through the Proxy, but the LRU caps
 * peak memory and the streaming `forEachGraph` API on SnapshotStore is
 * the correct path for cascade operations on huge workspaces.
 *
 * Writes (`snap.graphs[id] = g`, `delete snap.graphs[id]`) are buffered
 * in a dirty set + tombstone set; `flushDirty(refId)` writes them to
 * SQLite during `SnapshotStore.save()`. This means save() only re-writes
 * graphs that actually changed — a major speedup over the previous
 * "DELETE-all-then-INSERT-all" pattern.
 */

import type { DiagramGraph } from '../graph/graphTypes';
import type { SqliteStore } from './sqliteStore';

export type SnapshotKind = 'baseline' | 'working';

const DEFAULT_LRU_LIMIT = 100;

export class LazyGraphMap {
    private readonly sqlite: SqliteStore;
    private readonly kind: SnapshotKind;
    private readonly lruLimit: number;

    /** All graph IDs known to exist in this snapshot — populated at hydrate. */
    private readonly ids: Set<string> = new Set();
    /** Hot cache of recently-accessed graphs. Bounded by lruLimit. */
    private readonly cache: Map<string, DiagramGraph> = new Map();
    /** MRU order: most-recently-touched at the end. */
    private readonly lru: string[] = [];
    /** Pending writes from the in-memory side; persisted on flushDirty(). */
    private readonly dirty: Map<string, DiagramGraph> = new Map();
    /** Pending deletes; applied on flushDirty(). */
    private readonly tombstones: Set<string> = new Set();

    constructor(sqlite: SqliteStore, kind: SnapshotKind, lruLimit: number = DEFAULT_LRU_LIMIT) {
        this.sqlite = sqlite;
        this.kind = kind;
        this.lruLimit = lruLimit;
    }

    /** Replace the known-id set after a hydrate. Clears dirty/cache state. */
    resetWithIds(ids: Iterable<string>): void {
        this.ids.clear();
        for (const id of ids) this.ids.add(id);
        this.cache.clear();
        this.lru.length = 0;
        this.dirty.clear();
        this.tombstones.clear();
    }

    get(id: string): DiagramGraph | undefined {
        if (this.tombstones.has(id)) return undefined;
        if (this.dirty.has(id)) return this.dirty.get(id);
        if (this.cache.has(id)) {
            this.touch(id);
            return this.cache.get(id);
        }
        if (!this.ids.has(id)) return undefined;
        if (!this.sqlite.isOpen()) return undefined;
        const row = this.sqlite.get(
            `SELECT graph_json FROM graphs WHERE snapshot_kind = ? AND graph_id = ?`,
            [this.kind, id],
        );
        if (!row || typeof row.graph_json !== 'string') return undefined;
        let parsed: DiagramGraph;
        try {
            parsed = JSON.parse(row.graph_json) as DiagramGraph;
        } catch {
            return undefined;
        }
        this.cache.set(id, parsed);
        this.lru.push(id);
        this.evictIfNeeded();
        return parsed;
    }

    set(id: string, graph: DiagramGraph): void {
        this.dirty.set(id, graph);
        this.tombstones.delete(id);
        this.ids.add(id);
        // Keep cache in sync so reads after set return the latest.
        this.cache.set(id, graph);
        this.touch(id);
        this.evictIfNeeded();
    }

    delete(id: string): boolean {
        const had = this.ids.has(id) || this.dirty.has(id);
        this.dirty.delete(id);
        this.cache.delete(id);
        this.tombstones.add(id);
        this.ids.delete(id);
        const idx = this.lru.indexOf(id);
        if (idx >= 0) this.lru.splice(idx, 1);
        return had;
    }

    has(id: string): boolean {
        if (this.tombstones.has(id)) return false;
        return this.ids.has(id);
    }

    keys(): string[] {
        // Return a snapshot of the keyspace. Tombstones already removed from ids.
        return Array.from(this.ids);
    }

    size(): number {
        return this.ids.size;
    }

    /**
     * Stream every (id, graph) pair without holding more than one in memory
     * at a time (plus the LRU cache). Pending dirty writes are surfaced
     * before reaching the DB rows so callers see the latest state.
     * Callback may return `false` to stop iteration early.
     */
    forEach(cb: (id: string, graph: DiagramGraph) => void | boolean): void {
        // Surface pending dirty writes first.
        for (const [id, graph] of this.dirty) {
            if (this.tombstones.has(id)) continue;
            const r = cb(id, graph);
            if (r === false) return;
        }
        // Then DB-resident graphs not in dirty/tombstone. Skip when the
        // SqliteStore hasn't been opened (test paths construct stores
        // without a load() call); in that case all data is in `dirty`.
        if (!this.sqlite.isOpen()) return;
        const stmt = this.sqlite.prepareIterator(
            `SELECT graph_id, graph_json FROM graphs WHERE snapshot_kind = ?`,
            [this.kind],
        );
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject();
                const id = String(row.graph_id);
                if (this.dirty.has(id) || this.tombstones.has(id)) continue;
                let graph: DiagramGraph;
                try { graph = JSON.parse(String(row.graph_json)) as DiagramGraph; } catch { continue; }
                const r = cb(id, graph);
                if (r === false) return;
            }
        } finally {
            stmt.free();
        }
    }

    /** Persist pending writes/deletes to SQLite. Caller flushes the DB after. */
    flushDirty(): void {
        for (const id of this.tombstones) {
            this.sqlite.run(
                `DELETE FROM graphs WHERE snapshot_kind = ? AND graph_id = ?`,
                [this.kind, id],
            );
        }
        this.tombstones.clear();
        for (const [id, graph] of this.dirty) {
            this.sqlite.run(
                `INSERT INTO graphs (snapshot_kind, graph_id, graph_json) VALUES (?, ?, ?)
                 ON CONFLICT(snapshot_kind, graph_id) DO UPDATE SET graph_json = excluded.graph_json`,
                [this.kind, id, JSON.stringify(graph)],
            );
        }
        this.dirty.clear();
    }

    /** Forget cached graph bodies (keep IDs). Called after save() to bound memory. */
    forgetBodies(): void {
        this.cache.clear();
        this.lru.length = 0;
    }

    /** Forget every state including IDs. Used on resetWorking / clearAllFiles. */
    forgetAll(): void {
        this.ids.clear();
        this.cache.clear();
        this.lru.length = 0;
        this.dirty.clear();
        this.tombstones.clear();
    }

    /** Snapshot of pending writes — used when copying working → baseline. */
    getDirtyPayload(): { writes: Map<string, DiagramGraph>; tombstones: Set<string> } {
        return {
            writes: new Map(this.dirty),
            tombstones: new Set(this.tombstones),
        };
    }

    private touch(id: string): void {
        const idx = this.lru.indexOf(id);
        if (idx >= 0) this.lru.splice(idx, 1);
        this.lru.push(id);
    }

    private evictIfNeeded(): void {
        while (this.lru.length > this.lruLimit) {
            const oldest = this.lru.shift();
            if (oldest !== undefined && !this.dirty.has(oldest)) {
                this.cache.delete(oldest);
            }
        }
    }
}

/**
 * Build a Proxy that mimics `Record<string, DiagramGraph>` over a LazyGraphMap.
 * Allows existing `snapshot.graphs[id]` / `delete snapshot.graphs[id]` /
 * `id in snapshot.graphs` / `Object.keys(snapshot.graphs)` access patterns
 * to keep working transparently. `Object.values` / `Object.entries` will
 * fetch one graph at a time — fine for small N, slow for 20k+; cascade
 * sites should migrate to `LazyGraphMap.forEach`.
 */
const proxyToMap = new WeakMap<object, LazyGraphMap>();

export function makeLazyGraphsProxy(map: LazyGraphMap): Record<string, DiagramGraph> {
    const target = Object.create(null) as Record<string, DiagramGraph>;
    const proxy = new Proxy(target, {
        get(_t, prop) {
            if (typeof prop !== 'string') return undefined;
            return map.get(prop);
        },
        set(_t, prop, value) {
            if (typeof prop !== 'string') return false;
            map.set(prop, value as DiagramGraph);
            return true;
        },
        deleteProperty(_t, prop) {
            if (typeof prop !== 'string') return false;
            map.delete(prop);
            return true;
        },
        has(_t, prop) {
            if (typeof prop !== 'string') return false;
            return map.has(prop);
        },
        ownKeys() {
            return map.keys();
        },
        getOwnPropertyDescriptor(_t, prop) {
            if (typeof prop !== 'string') return undefined;
            if (!map.has(prop)) return undefined;
            const value = map.get(prop);
            // Issue #790 #3 follow-on — the value lookup may return
            // `undefined` when the underlying SqliteStore was closed by
            // LRU eviction (LazyGraphMap.get's `isOpen()` guard from #1).
            // Returning `undefined` from `getOwnPropertyDescriptor` then
            // hides the key from `Object.keys` / `Object.entries` even
            // though the in-memory `ids` set still tracks it — which
            // makes home-page counts under-report graphs (143 file
            // diagrams instead of 465, 1 sequence instead of 11). Report
            // `enumerable: true` whenever the key exists in the ids set;
            // the consumer is responsible for handling an undefined
            // value (the lazy reader retries against sqlite next time).
            return { enumerable: true, configurable: true, writable: true, value };
        },
    });
    // Stash the underlying map in a WeakMap (NOT on the Proxy itself —
    // assigning to the Proxy goes through the `set` handler which would
    // corrupt the LazyGraphMap keyspace).
    proxyToMap.set(proxy, map);
    return proxy;
}

/** Retrieve the LazyGraphMap behind a proxy created by `makeLazyGraphsProxy`. */
export function getLazyGraphMap(graphs: Record<string, DiagramGraph>): LazyGraphMap | undefined {
    return proxyToMap.get(graphs as unknown as object);
}

/**
 * Generic JSON-record lazy map (#356 — `AMPLITUDE_API_KEY` committed in plaintext source). Same Proxy-backed shape as
 * `LazyGraphMap` but parameterized by:
 *  - target SQLite table name
 *  - id column name
 *  - json column name
 *  - optional WHERE clause + params (e.g. `snapshot_kind = ?`)
 *
 * Used today for `apis` table; the same factory could lift to
 * `clusters`/`services` if telemetry surfaces memory pressure on those.
 */
export interface LazyRecordMapConfig<T> {
    table: string;
    idColumn: string;
    jsonColumn: string;
    where: string;        // e.g. "snapshot_kind = ?"
    whereParams: ReadonlyArray<string | number>;
    parse: (json: string) => T;
    serialize: (value: T) => string;
    /** Bound writes/deletes to this scope when flushing. */
    insertSql: string;    // e.g. "INSERT INTO apis (snapshot_kind, api_id, record_json) VALUES (?, ?, ?)
                          //       ON CONFLICT(snapshot_kind, api_id) DO UPDATE SET record_json = excluded.record_json"
    insertParams: (id: string, json: string) => ReadonlyArray<string | number>;
    deleteSql: string;
    deleteParams: (id: string) => ReadonlyArray<string | number>;
}

export class LazyRecordMap<T> {
    private readonly sqlite: SqliteStore;
    private readonly cfg: LazyRecordMapConfig<T>;
    private readonly lruLimit: number;

    private readonly ids: Set<string> = new Set();
    private readonly cache: Map<string, T> = new Map();
    private readonly lru: string[] = [];
    private readonly dirty: Map<string, T> = new Map();
    private readonly tombstones: Set<string> = new Set();

    constructor(sqlite: SqliteStore, cfg: LazyRecordMapConfig<T>, lruLimit: number = 200) {
        this.sqlite = sqlite;
        this.cfg = cfg;
        this.lruLimit = lruLimit;
    }

    resetWithIds(ids: Iterable<string>): void {
        this.ids.clear();
        for (const id of ids) this.ids.add(id);
        this.cache.clear();
        this.lru.length = 0;
        this.dirty.clear();
        this.tombstones.clear();
    }

    get(id: string): T | undefined {
        if (this.tombstones.has(id)) return undefined;
        if (this.dirty.has(id)) return this.dirty.get(id);
        if (this.cache.has(id)) {
            this.touch(id);
            return this.cache.get(id);
        }
        if (!this.ids.has(id)) return undefined;
        if (!this.sqlite.isOpen()) return undefined;
        const row = this.sqlite.get(
            `SELECT ${this.cfg.jsonColumn} as v FROM ${this.cfg.table} WHERE ${this.cfg.where} AND ${this.cfg.idColumn} = ?`,
            [...this.cfg.whereParams, id],
        );
        if (!row || typeof row.v !== 'string') return undefined;
        let parsed: T;
        try { parsed = this.cfg.parse(row.v); } catch { return undefined; }
        this.cache.set(id, parsed);
        this.lru.push(id);
        this.evictIfNeeded();
        return parsed;
    }

    set(id: string, value: T): void {
        this.dirty.set(id, value);
        this.tombstones.delete(id);
        this.ids.add(id);
        this.cache.set(id, value);
        this.touch(id);
        this.evictIfNeeded();
    }

    delete(id: string): boolean {
        const had = this.ids.has(id) || this.dirty.has(id);
        this.dirty.delete(id);
        this.cache.delete(id);
        this.tombstones.add(id);
        this.ids.delete(id);
        const idx = this.lru.indexOf(id);
        if (idx >= 0) this.lru.splice(idx, 1);
        return had;
    }

    has(id: string): boolean {
        if (this.tombstones.has(id)) return false;
        return this.ids.has(id);
    }

    keys(): string[] { return Array.from(this.ids); }
    size(): number { return this.ids.size; }

    forEach(cb: (id: string, value: T) => void | boolean): void {
        for (const [id, v] of this.dirty) {
            if (this.tombstones.has(id)) continue;
            if (cb(id, v) === false) return;
        }
        if (!this.sqlite.isOpen()) return;
        const stmt = this.sqlite.prepareIterator(
            `SELECT ${this.cfg.idColumn} as id, ${this.cfg.jsonColumn} as v FROM ${this.cfg.table} WHERE ${this.cfg.where}`,
            this.cfg.whereParams as any,
        );
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject();
                const id = String(row.id);
                if (this.dirty.has(id) || this.tombstones.has(id)) continue;
                let parsed: T;
                try { parsed = this.cfg.parse(String(row.v)); } catch { continue; }
                if (cb(id, parsed) === false) return;
            }
        } finally {
            stmt.free();
        }
    }

    flushDirty(): void {
        for (const id of this.tombstones) {
            this.sqlite.run(this.cfg.deleteSql, this.cfg.deleteParams(id));
        }
        this.tombstones.clear();
        for (const [id, value] of this.dirty) {
            const json = this.cfg.serialize(value);
            this.sqlite.run(this.cfg.insertSql, this.cfg.insertParams(id, json));
        }
        this.dirty.clear();
    }

    forgetBodies(): void {
        this.cache.clear();
        this.lru.length = 0;
    }

    forgetAll(): void {
        this.ids.clear();
        this.cache.clear();
        this.lru.length = 0;
        this.dirty.clear();
        this.tombstones.clear();
    }

    private touch(id: string): void {
        const idx = this.lru.indexOf(id);
        if (idx >= 0) this.lru.splice(idx, 1);
        this.lru.push(id);
    }

    private evictIfNeeded(): void {
        while (this.lru.length > this.lruLimit) {
            const oldest = this.lru.shift();
            if (oldest !== undefined && !this.dirty.has(oldest)) {
                this.cache.delete(oldest);
            }
        }
    }
}

const recordProxyToMap = new WeakMap<object, LazyRecordMap<any>>();

export function makeLazyRecordProxy<T>(map: LazyRecordMap<T>): Record<string, T> {
    const target = Object.create(null) as Record<string, T>;
    const proxy = new Proxy(target, {
        get(_t, prop) {
            if (typeof prop !== 'string') return undefined;
            return map.get(prop);
        },
        set(_t, prop, value) {
            if (typeof prop !== 'string') return false;
            map.set(prop, value as T);
            return true;
        },
        deleteProperty(_t, prop) {
            if (typeof prop !== 'string') return false;
            map.delete(prop);
            return true;
        },
        has(_t, prop) {
            if (typeof prop !== 'string') return false;
            return map.has(prop);
        },
        ownKeys() { return map.keys(); },
        getOwnPropertyDescriptor(_t, prop) {
            if (typeof prop !== 'string') return undefined;
            if (!map.has(prop)) return undefined;
            // Issue #790 #3 follow-on — see makeLazyGraphsProxy for the
            // full rationale. Report `enumerable: true` whenever the key
            // exists in `ids`; don't hide the property just because the
            // sqlite-backed value lookup returned `undefined` (closed
            // store via LRU eviction).
            const value = map.get(prop);
            return { enumerable: true, configurable: true, writable: true, value };
        },
    });
    recordProxyToMap.set(proxy, map);
    return proxy;
}

export function getLazyRecordMap<T>(rec: Record<string, T>): LazyRecordMap<T> | undefined {
    return recordProxyToMap.get(rec as unknown as object) as LazyRecordMap<T> | undefined;
}

/**
 * Stream every (id, graph) pair from a `Snapshot.graphs`, going through the
 * LazyGraphMap when one is attached (one DB row at a time, no full-corpus
 * materialization) and falling back to plain `Object.entries` for plain
 * objects (test fixtures, ephemeral snapshots from git diff).
 *
 * Use this in cascade / analysis code instead of `Object.entries(snap.graphs)`.
 * Returning `false` from the callback halts iteration.
 */
export function forEachGraph(
    graphs: Record<string, DiagramGraph>,
    cb: (id: string, graph: DiagramGraph) => void | boolean,
): void {
    const map = getLazyGraphMap(graphs);
    if (map) {
        map.forEach(cb);
        return;
    }
    for (const [id, graph] of Object.entries(graphs)) {
        const r = cb(id, graph);
        if (r === false) return;
    }
}
