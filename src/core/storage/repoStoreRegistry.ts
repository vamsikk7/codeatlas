/**
 * ADR-034 Phase A — `RepoStoreRegistry` (#786 — Phase A: per-repo DB foundation (ADR-034)).
 *
 * Singleton that owns every persistent store the workspace touches in a
 * given session: one `IAggregatorStore` (never evicted) plus an
 * LRU-bounded map of `IRepoStore`s keyed by absolute repo root path.
 *
 * Phase A guarantees:
 *   - Single-repo workspaces work exactly like today — the LRU only ever
 *     holds 1 entry, evictions never trigger.
 *   - Lazy open: no I/O until `getRepoStore` is called for a given path.
 *   - Dirty-aware eviction: if the LRU candidate has a pending flush
 *     (`save()` wasn't called since the last write), we flush first and
 *     close synchronously rather than dropping unsaved state.
 *   - `setForTest` swap hook so vitest can isolate test cases.
 *
 * Phase B (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)) activates parallel construction in `WorkspaceOrchestrator`,
 * which is the first caller that exercises the LRU under load.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SnapshotStore } from './snapshotStore';
import { AggregatorStore } from './aggregatorStore';
import type { IRepoStore, IAggregatorStore } from './storeInterfaces';

/**
 * Soft cap on open per-repo stores. Configurable via
 * `codeatlas.repoStoreCacheSize` (extension setting wired in Phase B).
 * Default sized for ~30 services — large enough for any realistic
 * monorepo, small enough to bound memory.
 */
const DEFAULT_LRU_CAP = 30;

interface DirtyAware {
    /** Optional — concrete stores expose this; aggregator skips. */
    isDirty?(): boolean;
}

export class RepoStoreRegistry {
    private static singleton: RepoStoreRegistry | null = null;

    /**
     * Singleton accessor. Lazy-constructs on first use. Tests reset via
     * `setForTest(null)` in `beforeEach`.
     */
    static instance(): RepoStoreRegistry {
        if (!this.singleton) this.singleton = new RepoStoreRegistry();
        return this.singleton;
    }

    /** Test hook — pass null to reset. */
    static setForTest(instance: RepoStoreRegistry | null): void {
        this.singleton = instance;
    }

    private readonly repoStores = new Map<string, IRepoStore>();
    private readonly accessOrder: string[] = [];   // LRU order; least-recent at index 0
    private aggregator: IAggregatorStore | null = null;
    private aggregatorWorkspaceRoot: string | null = null;
    private lruCap: number = DEFAULT_LRU_CAP;
    private log: (msg: string) => void = () => { /* noop */ };
    /** Phase A: factory hook so tests can inject fake stores. */
    private repoFactory: (repoRootAbsolute: string) => IRepoStore = makeDefaultRepoFactory();
    private aggregatorFactory: (workspaceRoot: string) => IAggregatorStore = makeDefaultAggregatorFactory();

    setLogger(logger: (msg: string) => void): void { this.log = logger; }
    setLruCap(cap: number): void {
        if (cap < 1) throw new Error('[RepoStoreRegistry] lruCap must be >= 1');
        this.lruCap = cap;
    }
    /** Test hook — inject fake factory before the first getRepoStore() call. */
    setRepoFactoryForTest(f: (repoRootAbsolute: string) => IRepoStore): void { this.repoFactory = f; }
    setAggregatorFactoryForTest(f: (workspaceRoot: string) => IAggregatorStore): void { this.aggregatorFactory = f; }

    /**
     * Pre-register an already-instantiated store. Used by the extension's
     * `activate()` to seed the registry with the SnapshotStore it owns,
     * avoiding a double-open against the same `state.db`. Idempotent —
     * subsequent calls for the same key replace the entry (caller is
     * responsible for closing the displaced store).
     */
    registerRepoStore(repoRootAbsolute: string, store: IRepoStore): void {
        const key = normaliseKey(repoRootAbsolute);
        if (this.repoStores.has(key)) {
            // Move to MRU position.
            this.touch(key);
            this.repoStores.set(key, store);
            return;
        }
        this.evictIfNeeded();
        this.repoStores.set(key, store);
        this.accessOrder.push(key);
    }

    /**
     * Pre-register an already-instantiated aggregator. Symmetric to
     * `registerRepoStore` — extension uses it when it wants to own the
     * aggregator lifecycle directly.
     */
    registerAggregatorStore(workspaceRoot: string, store: IAggregatorStore): void {
        if (this.aggregator && this.aggregatorWorkspaceRoot === workspaceRoot) {
            // Replace in-place — caller closes the displaced one.
            this.aggregator = store;
            return;
        }
        if (this.aggregator) {
            try { this.aggregator.close(); } catch (err: any) {
                this.log(`[RepoStoreRegistry] error closing prior aggregator: ${err?.message ?? err}`);
            }
        }
        this.aggregator = store;
        this.aggregatorWorkspaceRoot = workspaceRoot;
    }

    /**
     * Get (or lazily open) the per-repo store for `repoRootAbsolute`.
     * Marks the entry as most-recently-used. Evicts the least-recent
     * entry if the cap is exceeded, flushing dirty state first.
     */
    getRepoStore(repoRootAbsolute: string): IRepoStore {
        const key = normaliseKey(repoRootAbsolute);
        const existing = this.repoStores.get(key);
        if (existing) {
            this.touch(key);
            return existing;
        }

        // Cap check BEFORE inserting so we don't briefly exceed.
        this.evictIfNeeded();

        const created = this.repoFactory(repoRootAbsolute);
        this.repoStores.set(key, created);
        this.accessOrder.push(key);
        return created;
    }

    /**
     * Issue #790 — like `getRepoStore` but awaits `load()` before returning.
     * Required by every caller that immediately reads `getWorking()` /
     * `getBaseline()` state — without a `load()` the per-repo `state.db`
     * is opened but the in-memory snapshot stays empty, so the caller
     * sees `services={}`, `graphs={}` even though the disk has the data.
     *
     * Idempotent: `SnapshotStore.load()` short-circuits when already
     * initialized, so repeat calls cost a Map lookup.
     */
    async getRepoStoreLoaded(repoRootAbsolute: string): Promise<IRepoStore> {
        const store = this.getRepoStore(repoRootAbsolute);
        try {
            await store.load();
        } catch (err: any) {
            this.log(`[RepoStoreRegistry] load failed for ${repoRootAbsolute}: ${err?.message ?? err}`);
        }
        return store;
    }

    /**
     * Get (or lazily open) the workspace aggregator. Never evicted —
     * even at LRU cap, the aggregator stays resident because every repo
     * write needs it for cross-repo state.
     */
    getAggregatorStore(workspaceRoot: string): IAggregatorStore {
        if (this.aggregator && this.aggregatorWorkspaceRoot === workspaceRoot) {
            return this.aggregator;
        }
        // Workspace changed (user switched folder) — close + replace.
        if (this.aggregator) {
            try { this.aggregator.close(); } catch (err: any) {
                this.log(`[RepoStoreRegistry] error closing prior aggregator: ${err?.message ?? err}`);
            }
        }
        this.aggregator = this.aggregatorFactory(workspaceRoot);
        this.aggregatorWorkspaceRoot = workspaceRoot;
        return this.aggregator;
    }

    /** Number of open per-repo stores. Telemetry / test helper. */
    getOpenStoreCount(): number { return this.repoStores.size; }

    /** Flush + close every open store. Idempotent. */
    async closeAll(): Promise<void> {
        for (const [key, store] of this.repoStores.entries()) {
            try {
                store.save();
                store.close();
            } catch (err: any) {
                this.log(`[RepoStoreRegistry] error closing repo ${key}: ${err?.message ?? err}`);
            }
        }
        this.repoStores.clear();
        this.accessOrder.length = 0;
        if (this.aggregator) {
            try {
                this.aggregator.save();
                this.aggregator.close();
            } catch (err: any) {
                this.log(`[RepoStoreRegistry] error closing aggregator: ${err?.message ?? err}`);
            }
            this.aggregator = null;
            this.aggregatorWorkspaceRoot = null;
        }
    }

    // ─── internals ───────────────────────────────────────────────────────

    private touch(key: string): void {
        const i = this.accessOrder.indexOf(key);
        if (i >= 0) this.accessOrder.splice(i, 1);
        this.accessOrder.push(key);
    }

    private evictIfNeeded(): void {
        while (this.repoStores.size >= this.lruCap) {
            const victimKey = this.accessOrder.shift();
            if (!victimKey) return;
            const victim = this.repoStores.get(victimKey);
            if (!victim) continue;
            // Dirty-aware: flush before close. Phase A: SnapshotStore doesn't
            // expose isDirty(), so we always save() defensively — cheap when
            // already clean (SqliteStore.flush bails on no pending writes).
            try {
                const dirty = (victim as DirtyAware).isDirty?.() ?? true;
                if (dirty) victim.save();
            } catch (err: any) {
                this.log(`[RepoStoreRegistry] error flushing victim ${victimKey}: ${err?.message ?? err}`);
            }
            try { victim.close(); } catch (err: any) {
                this.log(`[RepoStoreRegistry] error closing victim ${victimKey}: ${err?.message ?? err}`);
            }
            this.repoStores.delete(victimKey);
        }
    }
}

/** Normalise to forward slashes + lowercase on Windows (ADR-034 R3). */
function normaliseKey(abs: string): string {
    let k = abs.replace(/\\/g, '/');
    if (process.platform === 'win32') k = k.toLowerCase();
    return k;
}

/** Default factory: real SnapshotStore. Tests can override via setRepoFactoryForTest. */
function makeDefaultRepoFactory(): (repoRoot: string) => IRepoStore {
    return (repoRoot: string) => new SnapshotStore(repoRoot);
}

/** Default factory: real AggregatorStore. Tests can override. */
function makeDefaultAggregatorFactory(): (workspaceRoot: string) => IAggregatorStore {
    return (workspaceRoot: string) => new AggregatorStore(workspaceRoot);
}

/** Resolve the workspace's monorepo.db path without instantiating a store. */
export function getMonorepoDbPathFor(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.codeatlas', 'monorepo.db');
}

/** Exists check for callers that want to know if migration is needed. */
export function monorepoDbExists(workspaceRoot: string): boolean {
    return fs.existsSync(getMonorepoDbPathFor(workspaceRoot));
}
