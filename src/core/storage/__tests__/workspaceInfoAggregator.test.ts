/**
 * workspaceInfoAggregator.test.ts — UX-21
 *
 * Pin the dedup-by-service.id behaviour and worker-stub exclusion so the
 * multi-repo home page never regresses to 64-instead-of-8 services.
 */

import { describe, it, expect } from 'vitest';
import {
    aggregateMultiRepoCounts,
    stripForeignServiceRows,
    type AggregatedSnapshotLite,
} from '../workspaceInfoAggregator';

function w(partial: AggregatedSnapshotLite): AggregatedSnapshotLite {
    return partial;
}

describe('aggregateMultiRepoCounts', () => {
    it('dedupes services that appear in multiple per-repo stores', () => {
        const repoA: AggregatedSnapshotLite = w({
            services: {
                'service:api': { id: 'service:api', name: 'api', rootPath: 'services/api' },
                'service:web': { id: 'service:web', name: 'web' }, // stub copy from repo A
            },
        });
        const repoB: AggregatedSnapshotLite = w({
            services: {
                'service:api': { id: 'service:api', name: 'api' }, // stub copy from repo B
                'service:web': { id: 'service:web', name: 'web', rootPath: 'apps/web' },
            },
        });

        const out = aggregateMultiRepoCounts([repoA, repoB]);
        expect(out.serviceCount).toBe(2);
        expect(out.services.map((s) => s.id).sort()).toEqual(['service:api', 'service:web']);
    });

    it('excludes worker-stub services (meta.worker = true) from the count', () => {
        const repoA: AggregatedSnapshotLite = w({
            services: {
                'service:api': { id: 'service:api', name: 'api' },
                'service:api:worker': {
                    id: 'service:api:worker',
                    name: 'Workers · api',
                    meta: { worker: true },
                },
            },
        });

        const out = aggregateMultiRepoCounts([repoA]);
        expect(out.serviceCount).toBe(1);
        expect(out.services.map((s) => s.id)).toEqual(['service:api']);
    });

    it('unions files/apis/clusters/screens by id (no double-count)', () => {
        // TICKET-MOBILE-1 — apiCount excludes UI navigation (SCREEN/NAV_ROUTE);
        // screenCount comes from `screens` (screenDetector), NOT apiIndex SCREEN
        // (which over-counts in cross-contaminated monorepos — see file header).
        const repoA: AggregatedSnapshotLite = w({
            files: { 'src/a.ts': {}, 'src/b.ts': {} },
            apiIndex: { 'api:GET:/users': { method: 'GET' }, 'screen:Home': { method: 'SCREEN' } },
            clusters: { 'cluster:auth': {} },
            screens: { 'screen:Home': {} },
        });
        const repoB: AggregatedSnapshotLite = w({
            files: { 'src/c.ts': {}, 'src/a.ts': {} }, // duplicate
            apiIndex: {
                'api:POST:/users': { method: 'POST' },
                'api:GET:/users': { method: 'GET' }, // duplicate
                'screen:Login': { method: 'SCREEN' },
            },
            clusters: { 'cluster:checkout': {}, 'cluster:auth': {} }, // duplicate
            screens: { 'screen:Login': {}, 'screen:Home': {} }, // duplicate
        });

        const out = aggregateMultiRepoCounts([repoA, repoB]);
        expect(out.fileCount).toBe(3);
        expect(out.apiCount, 'GET+POST /users, SCREEN excluded from APIs').toBe(2);
        expect(out.clusterCount).toBe(2);
        expect(out.screenCount, 'Home+Login from screens, deduped').toBe(2);
    });

    it('counts file:/flow:/sequence: graphs independently per store (no dedupe — graph ids include filepath)', () => {
        const repoA: AggregatedSnapshotLite = w({
            graphs: {
                'file:src/a.ts': {},
                'flow:src/a.ts:foo': {},
                'sequence:src/a.ts:bar': {},
                'feature:workspace': {}, // ignored
                'microservice:workspace': {}, // ignored
            },
        });
        const repoB: AggregatedSnapshotLite = w({
            graphs: {
                'file:src/b.ts': {},
                'flow:src/b.ts:baz': {},
                'sequence:src/b.ts:qux': {},
            },
        });

        const out = aggregateMultiRepoCounts([repoA, repoB]);
        expect(out.fileGraphCount).toBe(2);
        expect(out.flowGraphCount).toBe(2);
        expect(out.sequenceGraphCount).toBe(2);
    });

    it('returns zero counts on empty input', () => {
        const out = aggregateMultiRepoCounts([]);
        expect(out).toEqual({
            fileCount: 0,
            apiCount: 0,
            serviceCount: 0,
            clusterCount: 0,
            screenCount: 0,
            fileGraphCount: 0,
            flowGraphCount: 0,
            sequenceGraphCount: 0,
            services: [],
        });
    });

    // #831 (2026-06-11) — CONTRACT CHANGE: this test previously asserted
    // that two rootPath-less same-id records across stores collapse to one
    // ("avoid name churn"). That exact collapse was the #831 bug — live
    // per-repo detectors emit rootPath '' for each repo's OWN service, so
    // two sub-repos both exposing `service:main` read as "1 SERVICE".
    // Bare records now count per store; first occurrence still wins for
    // naming WITHIN a store (the original churn concern).
    it('bare same-id records across stores count per store; in-store duplicates keep the first name', () => {
        const repoA: AggregatedSnapshotLite = w({
            services: { 'service:api': { id: 'service:api', name: 'api (real)' } },
        });
        const repoB: AggregatedSnapshotLite = w({
            services: { 'service:api': { id: 'service:api', name: 'api (sibling)' } },
        });
        const out = aggregateMultiRepoCounts([repoA, repoB]);
        expect(out.serviceCount).toBe(2);
        expect(out.services.map((s) => s.name).sort()).toEqual(['api (real)', 'api (sibling)']);
    });

    // #831 (2026-06-11) — two sub-repos legitimately exposing the SAME
    // service id (`service:main` is the default for any single-service
    // repo) must count as TWO services, not collapse to one. Stubs keep
    // deduping because a stub mirrors the real record's rootPath.
    it('same service id with DIFFERENT rootPaths counts per repo (#831)', () => {
        const out = aggregateMultiRepoCounts([
            { files: {}, apiIndex: {}, clusters: {}, screens: {}, graphs: {}, services: {
                'service:main': { id: 'service:main', name: 'main', rootPath: 'producer' },
            } } as any,
            { files: {}, apiIndex: {}, clusters: {}, screens: {}, graphs: {}, services: {
                'service:main': { id: 'service:main', name: 'main', rootPath: 'consumer' },
            } } as any,
        ]);
        expect(out.serviceCount).toBe(2);
        expect(out.services.map(s => s.rootPath).sort()).toEqual(['consumer', 'producer']);
    });

    it('same service id with the SAME rootPath still dedupes (stub mirror) (#831)', () => {
        const out = aggregateMultiRepoCounts([
            { files: {}, apiIndex: {}, clusters: {}, screens: {}, graphs: {}, services: {
                'service:main': { id: 'service:main', name: 'main', rootPath: 'producer' },
            } } as any,
            { files: {}, apiIndex: {}, clusters: {}, screens: {}, graphs: {}, services: {
                'service:main': { id: 'service:main', name: 'main (stub)', rootPath: 'producer' },
            } } as any,
        ]);
        expect(out.serviceCount).toBe(1);
    });
// #831 live shape — per-repo detectors run repo-relative, so BOTH
    // records carry rootPath ''. Same id from different stores = 2.
    it('same service id with EMPTY rootPath in different stores counts per store (#831 live shape)', () => {
        const out = aggregateMultiRepoCounts([
            { files: {}, apiIndex: {}, clusters: {}, screens: {}, graphs: {}, services: {
                'service:main': { id: 'service:main', name: 'main', rootPath: '' },
            } } as any,
            { files: {}, apiIndex: {}, clusters: {}, screens: {}, graphs: {}, services: {
                'service:main': { id: 'service:main', name: 'main', rootPath: '' },
            } } as any,
        ]);
        expect(out.serviceCount).toBe(2);
    });

    it('legacy sibling stub (no rootPath) is absorbed by a real record with the same id (#831)', () => {
        const out = aggregateMultiRepoCounts([
            { files: {}, apiIndex: {}, clusters: {}, screens: {}, graphs: {}, services: {
                'service:api': { id: 'service:api', name: 'api', rootPath: 'services/api' },
            } } as any,
            { files: {}, apiIndex: {}, clusters: {}, screens: {}, graphs: {}, services: {
                'service:api': { id: 'service:api', name: 'api' }, // stub copy
            } } as any,
        ]);
        expect(out.serviceCount).toBe(1);
    });
});

// #840 (2026-06-11) — persisted per-repo stores carry workspace-wide service
// rows (aggregator post-init pollution). Strip rows owned by OTHER repos
// before aggregation or the standalone home over-counts services.
describe('stripForeignServiceRows (#840)', () => {
    const allRoots = new Set(['repo-a', 'repo-b', 'repo-c']);

    it('drops rows whose rootPath belongs to a DIFFERENT registered repo', () => {
        const out = stripForeignServiceRows(w({
            services: {
                'service:main': { id: 'service:main', name: 'a', rootPath: '' },
                'service:b-pollution': { id: 'service:b', name: 'b', rootPath: 'repo-b' },
                'service:c-pollution': { id: 'service:c', name: 'c', rootPath: 'repo-c' },
            },
        }), 'repo-a', allRoots);
        expect(Object.keys(out.services!)).toEqual(['service:main']);
    });

    it('keeps the repo OWN row even when its rootPath equals the repo root', () => {
        const out = stripForeignServiceRows(w({
            services: { 'service:a': { id: 'service:a', name: 'a', rootPath: 'repo-a' } },
        }), 'repo-a', allRoots);
        expect(Object.keys(out.services!)).toHaveLength(1);
    });

    it('keeps legitimate multi-service rows with repo-RELATIVE rootPaths', () => {
        const out = stripForeignServiceRows(w({
            services: {
                'service:lambda1': { id: 'service:lambda1', name: 'l1', rootPath: 'functions/one' },
                'service:lambda2': { id: 'service:lambda2', name: 'l2', rootPath: 'functions/two' },
            },
        }), 'repo-a', allRoots);
        expect(Object.keys(out.services!)).toHaveLength(2);
    });

    it('returns the input unchanged when nothing is foreign (no copy churn)', () => {
        const snap = w({ services: { 'service:main': { id: 'service:main', name: 'a', rootPath: '' } } });
        expect(stripForeignServiceRows(snap, 'repo-a', allRoots)).toBe(snap);
    });

    it('end-to-end: aggregation over polluted stores counts only real services', () => {
        const storeA = stripForeignServiceRows(w({
            services: {
                'service:main': { id: 'service:main', name: 'a', rootPath: '' },
                'service:b': { id: 'service:b', name: 'b', rootPath: 'repo-b' },
            },
        }), 'repo-a', allRoots);
        const storeB = stripForeignServiceRows(w({
            services: {
                'service:main': { id: 'service:main', name: 'b', rootPath: '' },
                'service:a': { id: 'service:a', name: 'a', rootPath: 'repo-a' },
            },
        }), 'repo-b', allRoots);
        const agg = aggregateMultiRepoCounts([storeA, storeB]);
        expect(agg.serviceCount).toBe(2);
    });
});

// #847 (2026-06-11) — one repo counted twice: its live store carried the
// generic bare `service:main` stub ALONGSIDE its real named bare service
// (`service:image-resize`), so the VSIX read 209 while the persisted truth
// was 208. Within one store, a bare generic `service:main` next to another
// bare named service is a detector stub — skip it.
describe('generic service:main stub dedupe (#847)', () => {
    it('a store with bare service:main + bare named service counts ONCE', () => {
        const agg = aggregateMultiRepoCounts([w({
            services: {
                'service:main': { id: 'service:main', name: 'main', rootPath: '' },
                'service:image-resize': { id: 'service:image-resize', name: 'image-resize', rootPath: '' },
            },
        })]);
        expect(agg.serviceCount).toBe(1);
        expect(agg.services.map(s => s.id)).toEqual(['service:image-resize']);
    });

    it('a store whose ONLY bare service is service:main still counts it', () => {
        const agg = aggregateMultiRepoCounts([w({
            services: { 'service:main': { id: 'service:main', name: 'main', rootPath: '' } },
        })]);
        expect(agg.serviceCount).toBe(1);
    });

    it('the cross-store service:main collision contract (#831) is preserved', () => {
        const agg = aggregateMultiRepoCounts([
            w({ services: { 'service:main': { id: 'service:main', name: 'a', rootPath: '' } } }),
            w({ services: { 'service:main': { id: 'service:main', name: 'b', rootPath: '' } } }),
        ]);
        expect(agg.serviceCount).toBe(2);
    });
});
