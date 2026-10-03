/**
 * ADR-034 Phase A — RepoStoreRegistry tests (#786 — Phase A: per-repo DB foundation (ADR-034)).
 *
 * Covers lazy open, LRU eviction (with dirty-flush gate), aggregator
 * never-evicted, workspace switch close + replace, key normalisation,
 * test-isolation via setForTest. Uses fake factories so we don't touch
 * SQL.js / disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RepoStoreRegistry } from '../repoStoreRegistry';
import type { IAggregatorStore, IRepoStore } from '../storeInterfaces';

class FakeRepoStore implements Partial<IRepoStore> {
    saved = 0;
    closed = false;
    loadCalls = 0;
    constructor(public root: string) {}
    save(): void { this.saved += 1; }
    close(): void { this.closed = true; }
    getDbPath(): string { return `${this.root}/state.db`; }
    getSchemaVersion(): number { return 9; }
    // Issue #790: getRepoStoreLoaded must `await` this before returning.
    async load(): Promise<any> { this.loadCalls += 1; return {}; }
}

class FakeAggregator implements Partial<IAggregatorStore> {
    saved = 0;
    closed = false;
    constructor(public root: string) {}
    save(): void { this.saved += 1; }
    close(): void { this.closed = true; }
    getDbPath(): string { return `${this.root}/.codeatlas/monorepo.db`; }
    getSchemaVersion(): number { return 1; }
}

beforeEach(() => RepoStoreRegistry.setForTest(null));
afterEach(() => RepoStoreRegistry.setForTest(null));

function freshRegistry(): RepoStoreRegistry {
    const reg = new RepoStoreRegistry();
    reg.setRepoFactoryForTest((r) => new FakeRepoStore(r) as any);
    reg.setAggregatorFactoryForTest((r) => new FakeAggregator(r) as any);
    return reg;
}

describe('RepoStoreRegistry — lazy open', () => {
    it('does not instantiate any store until getRepoStore is called', () => {
        const reg = freshRegistry();
        let instantiations = 0;
        reg.setRepoFactoryForTest((r) => { instantiations += 1; return new FakeRepoStore(r) as any; });
        expect(instantiations).toBe(0);
        expect(reg.getOpenStoreCount()).toBe(0);

        reg.getRepoStore('/ws/repo-a');
        expect(instantiations).toBe(1);
        expect(reg.getOpenStoreCount()).toBe(1);
    });

    it('returns the same instance on repeat call (cache hit)', () => {
        const reg = freshRegistry();
        const a = reg.getRepoStore('/ws/repo-a');
        const b = reg.getRepoStore('/ws/repo-a');
        expect(a).toBe(b);
        expect(reg.getOpenStoreCount()).toBe(1);
    });

    it('normalises Windows-style separators when keying', () => {
        const reg = freshRegistry();
        const a = reg.getRepoStore('C:\\ws\\repo-a');
        const b = reg.getRepoStore('C:/ws/repo-a');
        expect(a).toBe(b);  // same key after normalisation
        expect(reg.getOpenStoreCount()).toBe(1);
    });

    it('Issue #790 — getRepoStoreLoaded() awaits load() before returning', async () => {
        const reg = freshRegistry();
        const store = await reg.getRepoStoreLoaded('/ws/repo-a') as any as FakeRepoStore;
        expect(store.loadCalls).toBe(1);
    });

    it('Issue #790 — getRepoStoreLoaded() is idempotent (cached store, repeat load)', async () => {
        const reg = freshRegistry();
        const a = await reg.getRepoStoreLoaded('/ws/repo-a') as any as FakeRepoStore;
        const b = await reg.getRepoStoreLoaded('/ws/repo-a') as any as FakeRepoStore;
        expect(a).toBe(b);
        // SnapshotStore.load() short-circuits when already loaded — we
        // still call it on every Loaded lookup. The store itself owns
        // the idempotency contract.
        expect(a.loadCalls).toBe(2);
    });

    it('Issue #790 — getRepoStoreLoaded() swallows load() failures (degraded mode)', async () => {
        const reg = freshRegistry();
        reg.setRepoFactoryForTest((r) => {
            const fake = new FakeRepoStore(r);
            (fake as any).load = async () => { throw new Error('disk wedged'); };
            return fake as any;
        });
        const store = await reg.getRepoStoreLoaded('/ws/repo-a');
        expect(store).toBeDefined();
    });
});

describe('RepoStoreRegistry — LRU eviction', () => {
    it('evicts the least-recently-used entry when cap is reached', () => {
        const reg = freshRegistry();
        reg.setLruCap(2);

        const a = reg.getRepoStore('/ws/repo-a') as any as FakeRepoStore;
        reg.getRepoStore('/ws/repo-b');
        reg.getRepoStore('/ws/repo-c');   // evicts repo-a (LRU)

        expect(a.closed).toBe(true);
        expect(reg.getOpenStoreCount()).toBe(2);

        // A new getRepoStore on repo-a re-opens (no cache hit).
        const aReopened = reg.getRepoStore('/ws/repo-a') as any as FakeRepoStore;
        expect(aReopened).not.toBe(a);
    });

    it('flushes dirty victim before close', () => {
        const reg = freshRegistry();
        reg.setLruCap(1);

        const a = reg.getRepoStore('/ws/repo-a') as any as FakeRepoStore;
        reg.getRepoStore('/ws/repo-b');   // evicts a

        expect(a.saved).toBeGreaterThanOrEqual(1);
        expect(a.closed).toBe(true);
    });

    it('touch on cache hit promotes entry to most-recently-used', () => {
        const reg = freshRegistry();
        reg.setLruCap(2);

        const a = reg.getRepoStore('/ws/repo-a') as any as FakeRepoStore;
        const b = reg.getRepoStore('/ws/repo-b') as any as FakeRepoStore;
        reg.getRepoStore('/ws/repo-a');   // touches a, makes b the LRU

        reg.getRepoStore('/ws/repo-c');   // evicts b (now LRU), not a

        expect(a.closed).toBe(false);
        expect(b.closed).toBe(true);
    });

    it('rejects lruCap < 1', () => {
        const reg = freshRegistry();
        expect(() => reg.setLruCap(0)).toThrow();
        expect(() => reg.setLruCap(-1)).toThrow();
    });
});

describe('RepoStoreRegistry — aggregator never evicted', () => {
    it('returns same aggregator on repeat call within workspace', () => {
        const reg = freshRegistry();
        const a = reg.getAggregatorStore('/ws');
        const b = reg.getAggregatorStore('/ws');
        expect(a).toBe(b);
    });

    it('keeps aggregator open even when LRU evicts every repo store', () => {
        const reg = freshRegistry();
        reg.setLruCap(1);
        const agg = reg.getAggregatorStore('/ws') as any as FakeAggregator;

        // Bounce through 5 repos with cap=1 — every previous repo is evicted.
        for (let i = 0; i < 5; i++) reg.getRepoStore(`/ws/repo-${i}`);

        // Aggregator stays accessible & unchanged.
        const aggLater = reg.getAggregatorStore('/ws');
        expect(aggLater).toBe(agg);
        expect(agg.closed).toBe(false);
    });

    it('closes prior aggregator when workspace changes', () => {
        const reg = freshRegistry();
        const first = reg.getAggregatorStore('/ws-a') as any as FakeAggregator;
        const second = reg.getAggregatorStore('/ws-b') as any as FakeAggregator;
        expect(first).not.toBe(second);
        expect(first.closed).toBe(true);
        expect(second.closed).toBe(false);
    });
});

describe('RepoStoreRegistry — closeAll', () => {
    it('flushes and closes every open store; subsequent getRepoStore re-opens fresh', async () => {
        const reg = freshRegistry();
        const a = reg.getRepoStore('/ws/repo-a') as any as FakeRepoStore;
        const b = reg.getRepoStore('/ws/repo-b') as any as FakeRepoStore;
        const agg = reg.getAggregatorStore('/ws') as any as FakeAggregator;

        await reg.closeAll();

        expect(a.closed).toBe(true);
        expect(b.closed).toBe(true);
        expect(agg.closed).toBe(true);
        expect(reg.getOpenStoreCount()).toBe(0);

        // Re-open after closeAll yields a fresh instance.
        const aRe = reg.getRepoStore('/ws/repo-a') as any as FakeRepoStore;
        expect(aRe).not.toBe(a);
    });
});

describe('RepoStoreRegistry — test isolation', () => {
    it('setForTest replaces the singleton', () => {
        const replacement = freshRegistry();
        RepoStoreRegistry.setForTest(replacement);
        expect(RepoStoreRegistry.instance()).toBe(replacement);
        RepoStoreRegistry.setForTest(null);
        // After reset, instance() yields a fresh singleton (not the replacement).
        expect(RepoStoreRegistry.instance()).not.toBe(replacement);
    });
});
