import { describe, it, expect } from 'vitest';
import { resolvePerRepoGraph } from '../perRepoGraphResolver';
import { LazyGraphMap, makeLazyGraphsProxy } from '../../storage/lazyGraphMap';
import type { DiagramGraph } from '../../graph/graphTypes';

/**
 * BUG-POLAR-1: a monorepo deep-link addresses a repo by NAME (`#/features/server`
 * → `feature:service:server`) but the repo's per-repo store keys its feature
 * graph by the SERVICE name (`feature:service:main`). The exact-name lookup +
 * `feature:workspace` fallback both miss (workspace graph is empty in multi-repo),
 * so the UI showed "0 features detected" even though the data exists.
 */
describe('resolvePerRepoGraph (BUG-POLAR-1 deep-link resolution)', () => {
    const graph = (id: string, nodes: number) => ({ graphId: id, nodes: Array.from({ length: nodes }) });

    it('falls back to ANY non-empty feature:* graph when the exact repo-name key misses', () => {
        const perRepoGraphs = {
            'feature:service:main': graph('feature:service:main', 137), // real data, keyed by service name
            'feature:workspace': graph('feature:workspace', 0),          // empty in multi-repo
            'file:server/x.py': graph('file:server/x.py', 3),            // wrong kind — ignored
        };
        const resolved = resolvePerRepoGraph(perRepoGraphs, 'feature', 'server'); // repo name, not service name
        expect(resolved?.graphId).toBe('feature:service:main');
    });

    it('prefers the exact service-name key when it exists and is non-empty', () => {
        const perRepoGraphs = {
            'feature:service:api': graph('feature:service:api', 10),
            'feature:service:worker': graph('feature:service:worker', 5),
        };
        expect(resolvePerRepoGraph(perRepoGraphs, 'feature', 'api')?.graphId).toBe('feature:service:api');
    });

    it('skips empty graphs and returns undefined when nothing of the kind has nodes', () => {
        const perRepoGraphs = {
            'feature:workspace': graph('feature:workspace', 0),
            'feature:service:main': graph('feature:service:main', 0),
        };
        expect(resolvePerRepoGraph(perRepoGraphs, 'feature', 'server')).toBeUndefined();
    });

    it('is kind-scoped — a domain lookup never returns a feature graph', () => {
        const perRepoGraphs = {
            'feature:service:main': graph('feature:service:main', 137),
            'domain:workspace': graph('domain:workspace', 14),
        };
        expect(resolvePerRepoGraph(perRepoGraphs, 'domain', 'server')?.graphId).toBe('domain:workspace');
        expect(resolvePerRepoGraph(perRepoGraphs, 'map', 'server')).toBeUndefined();
    });

    // PERF regression (2026-07-20, "slow L1→L2a open"): over a lazy SQLite-backed
    // graphs Proxy, the fallback scan MUST NOT force-fetch every graph. Reading a
    // value deserializes it; polar's `server` repo holds 14k graphs, so the old
    // `Object.entries` scan cost ~0.9s on EVERY features nav. The resolver must
    // enumerate keys fetch-free and read only the handful of `feature:*` graphs.
    it('does NOT force-fetch non-feature graphs from a lazy graph map (perf)', () => {
        // Dirty-only LazyGraphMap: values live in memory, SQLite never opened.
        const map = new LazyGraphMap({ isOpen: () => false } as never, 'working');
        const mk = (id: string, nodes: number): DiagramGraph =>
            ({ graphId: id, type: 'feature', nodes: Array.from({ length: nodes }), edges: [] } as unknown as DiagramGraph);
        // The one real feature graph (keyed by service name, not repo name)…
        map.set('feature:service:main', mk('feature:service:main', 137));
        map.set('feature:workspace', mk('feature:workspace', 0)); // empty
        // …drowned in thousands of unrelated sequence/file/flow graphs.
        for (let i = 0; i < 5000; i++) map.set(`sequence:server/f${i}.py:h`, mk(`sequence:server/f${i}.py:h`, 4));

        // Count how many graph BODIES get read.
        const origGet = map.get.bind(map);
        let fetches = 0;
        map.get = (id: string) => { fetches++; return origGet(id); };

        const proxy = makeLazyGraphsProxy(map);
        const resolved = resolvePerRepoGraph(proxy as never, 'feature', 'server');

        // Correct graph resolved…
        expect(resolved?.graphId).toBe('feature:service:main');
        // …while touching only a tiny number of graphs, NOT all 5002.
        expect(fetches).toBeLessThan(10);
    });
});
