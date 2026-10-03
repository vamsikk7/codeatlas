/**
 * crossRepoPushScheduler.test.ts — #817.2/7 (2026-06-11).
 *
 * Pins the cross-repo push core: edge-delta gating (push only on diff
 * TRANSITIONS), per-producer debounce, fan-out enumeration, revert-clear,
 * net-zero coalescing, settings gate, added/deleted edge handling.
 * Shared by the extension's WorkspaceWatcher hook and the standalone
 * bootstrap hook (parity by construction).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CrossRepoPushScheduler, type CrossRepoPushPayload } from '../crossRepoPushScheduler';
import type { IAggregatorStore } from '../../storage/storeInterfaces';

interface EdgeRow { sourceRepo: string; targetRepo: string; method: string; route: string; diff: string | null }

function makeStore(initialEdges: EdgeRow[]) {
    const state = { edges: [...initialEdges] };
    const store = {
        listRepos: () => [
            { repoId: 'prod1', name: 'auth-service', rootPath: 'auth' },
            { repoId: 'con1', name: 'gateway', rootPath: 'gateway' },
            { repoId: 'con2', name: 'reports', rootPath: 'reports' },
        ],
        listCrossRepoHttpEdges: () => [...state.edges],
    } as unknown as IAggregatorStore;
    return { store, state };
}

const EDGE = (diff: string | null, route = '/login', source = 'con1'): EdgeRow =>
    ({ sourceRepo: source, targetRepo: 'prod1', method: 'POST', route, diff });

describe('#817 — CrossRepoPushScheduler', () => {
    let broadcasts: CrossRepoPushPayload[];
    let sched: CrossRepoPushScheduler;

    beforeEach(() => {
        vi.useFakeTimers();
        broadcasts = [];
    });
    afterEach(() => {
        sched?.dispose();
        vi.useRealTimers();
    });

    function make(opts: { enabled?: () => boolean; debounceMs?: number } = {}) {
        sched = new CrossRepoPushScheduler({
            broadcast: (p) => broadcasts.push(p),
            debounceMs: opts.debounceMs ?? 2000,
            enabled: opts.enabled,
        });
        return sched;
    }

    it('R1: apply with NO diff transition → no broadcast', () => {
        const { store } = makeStore([EDGE(null)]);
        make();
        const t = sched.applyWithDelta(store, 'prod1', () => { /* edges unchanged */ });
        expect(t).toEqual([]);
        vi.advanceTimersByTime(5000);
        expect(broadcasts).toHaveLength(0);
    });

    it('R1: null→modified transition broadcasts after the debounce window', () => {
        const { store, state } = makeStore([EDGE(null)]);
        make();
        const t = sched.applyWithDelta(store, 'prod1', () => { state.edges[0] = EDGE('modified'); });
        expect(t).toHaveLength(1);
        expect(broadcasts).toHaveLength(0); // debounced — not yet
        vi.advanceTimersByTime(2100);
        expect(broadcasts).toHaveLength(1);
        const p = broadcasts[0];
        expect(p.type).toBe('crossRepoEdgeChanged');
        expect(p.producerRepoId).toBe('prod1');
        expect(p.producerRepoName).toBe('auth-service');
        expect(p.edges).toEqual([
            expect.objectContaining({ consumerRepoName: 'gateway', method: 'POST', route: '/login', diff: 'modified' }),
        ]);
    });

    it('R3: fan-out — multiple consumers in ONE payload, deterministically sorted', () => {
        const { store, state } = makeStore([EDGE(null, '/login', 'con1'), EDGE(null, '/users/:id', 'con2')]);
        make();
        sched.applyWithDelta(store, 'prod1', () => {
            state.edges = [EDGE('modified', '/login', 'con1'), EDGE('modified', '/users/:id', 'con2')];
        });
        vi.advanceTimersByTime(2100);
        expect(broadcasts).toHaveLength(1);
        expect(broadcasts[0].edges.map(e => e.consumerRepoName)).toEqual(['gateway', 'reports']);
    });

    it('R4: revert clears — modified→null transition pushes diff:null', () => {
        const { store, state } = makeStore([EDGE('modified')]);
        make();
        sched.applyWithDelta(store, 'prod1', () => { state.edges[0] = EDGE(null); });
        vi.advanceTimersByTime(2100);
        expect(broadcasts).toHaveLength(1);
        expect(broadcasts[0].edges[0].diff).toBeNull();
    });

    it('R2: two applies inside the window coalesce to ONE broadcast', () => {
        const { store, state } = makeStore([EDGE(null, '/a'), EDGE(null, '/b')]);
        make();
        sched.applyWithDelta(store, 'prod1', () => { state.edges[0] = EDGE('modified', '/a'); });
        vi.advanceTimersByTime(500);
        sched.applyWithDelta(store, 'prod1', () => { state.edges[1] = EDGE('modified', '/b'); });
        vi.advanceTimersByTime(2100);
        expect(broadcasts).toHaveLength(1);
        expect(broadcasts[0].edges).toHaveLength(2);
    });

    it('R2: net-zero inside one window (modify then revert) → NO broadcast', () => {
        const { store, state } = makeStore([EDGE(null)]);
        make();
        sched.applyWithDelta(store, 'prod1', () => { state.edges[0] = EDGE('modified'); });
        vi.advanceTimersByTime(300);
        sched.applyWithDelta(store, 'prod1', () => { state.edges[0] = EDGE(null); });
        vi.advanceTimersByTime(5000);
        expect(broadcasts).toHaveLength(0);
    });

    it('R7: enabled:false gate — apply still runs, no delta, no broadcast', () => {
        const { store, state } = makeStore([EDGE(null)]);
        make({ enabled: () => false });
        let applied = false;
        const t = sched.applyWithDelta(store, 'prod1', () => { applied = true; state.edges[0] = EDGE('modified'); });
        expect(applied).toBe(true);
        expect(t).toEqual([]);
        vi.advanceTimersByTime(5000);
        expect(broadcasts).toHaveLength(0);
    });

    it('added edge (absent→present) and deleted edge (present→gone) both transition', () => {
        const { store, state } = makeStore([EDGE(null, '/old')]);
        make();
        sched.applyWithDelta(store, 'prod1', () => { state.edges = [EDGE(null, '/new')]; });
        vi.advanceTimersByTime(2100);
        expect(broadcasts).toHaveLength(1);
        const byRoute = Object.fromEntries(broadcasts[0].edges.map(e => [e.route, e]));
        expect(byRoute['/new'].prevDiff).toBe('absent');
        expect(byRoute['/old'].diff).toBe('deleted');
    });

    it('independent producers debounce independently', () => {
        const { store, state } = makeStore([
            EDGE(null, '/login', 'con1'),
            { sourceRepo: 'con1', targetRepo: 'con2', method: 'GET', route: '/r', diff: null },
        ]);
        make();
        sched.applyWithDelta(store, 'prod1', () => { state.edges[0] = EDGE('modified'); });
        sched.applyWithDelta(store, 'con2', () => {
            state.edges[1] = { ...state.edges[1], diff: 'modified' };
        });
        vi.advanceTimersByTime(2100);
        expect(broadcasts).toHaveLength(2);
        expect(new Set(broadcasts.map(b => b.producerRepoId))).toEqual(new Set(['prod1', 'con2']));
    });

    it('dispose cancels pending broadcasts', () => {
        const { store, state } = makeStore([EDGE(null)]);
        make();
        sched.applyWithDelta(store, 'prod1', () => { state.edges[0] = EDGE('modified'); });
        sched.dispose();
        vi.advanceTimersByTime(5000);
        expect(broadcasts).toHaveLength(0);
    });
});
