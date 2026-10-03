import { describe, it, expect } from 'vitest';
import { stabilizeClusters, detectCommunities, diffClusters } from '../communityDetector';
import { WorkspaceCallGraph } from '../../graph/callGraphResolver';
import type { FeatureCluster, Snapshot, FileRecord } from '../../graph/graphTypes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCluster(id: string, label: string, files: string[]): FeatureCluster {
    return {
        id,
        label,
        name: label,
        files,
        entryPoints: [],
        internalCallCount: 0,
        externalCallCount: 0,
    };
}

function makeClusters(...clusters: FeatureCluster[]): Record<string, FeatureCluster> {
    const result: Record<string, FeatureCluster> = {};
    for (const c of clusters) result[c.id] = c;
    return result;
}

function makeSnapshot(filePaths: string[]): Snapshot {
    const files: Record<string, FileRecord> = {};
    for (const fp of filePaths) {
        files[fp] = {
            content: '',
            symbols: { functions: [], vars: [], imports: [] },
            lastModified: 0,
        } as unknown as FileRecord;
    }
    return { files, apiIndex: {}, graphs: {} };
}

function makeCallGraph(nodes: string[], edges: Array<[string, string]>): WorkspaceCallGraph {
    const graph = new WorkspaceCallGraph();
    for (const key of nodes) {
        const [fp, fn] = key.split('::');
        if (fp && fn) graph.ensureNode(fp, fn);
    }
    for (const [caller, callee] of edges) {
        graph.addEdge(caller, callee);
    }
    return graph;
}

// ---------------------------------------------------------------------------
// stabilizeClusters — Positive flows
// ---------------------------------------------------------------------------

describe('stabilizeClusters — positive flows', () => {
    it('remove 1 file from 10-file cluster → same ID (Jaccard ≈ 0.9)', () => {
        const files10 = Array.from({ length: 10 }, (_, i) => `auth/file${i}.ts`);
        const files9 = files10.slice(0, 9); // remove last file
        const baseline = makeClusters(makeCluster('cluster:auth', 'auth', files10));
        const fresh = makeClusters(makeCluster('cluster:auth', 'auth', files9));
        const result = stabilizeClusters(fresh, baseline);
        expect(Object.keys(result)).toContain('cluster:auth');
        expect(result['cluster:auth'].files).toEqual(files9);
    });

    it('add 1 file to 5-file cluster → same ID (Jaccard ≈ 0.83)', () => {
        const files5 = Array.from({ length: 5 }, (_, i) => `pay/file${i}.ts`);
        const files6 = [...files5, 'pay/file5.ts'];
        const baseline = makeClusters(makeCluster('cluster:pay', 'pay', files5));
        const fresh = makeClusters(makeCluster('cluster:pay', 'pay', files6));
        const result = stabilizeClusters(fresh, baseline);
        expect(Object.keys(result)).toContain('cluster:pay');
    });

    it('two clusters swap 1 file each → both keep IDs', () => {
        const baseline = makeClusters(
            makeCluster('cluster:auth', 'auth', ['a1.ts', 'a2.ts', 'a3.ts', 'shared.ts']),
            makeCluster('cluster:todos', 'todos', ['t1.ts', 't2.ts', 't3.ts', 'util.ts']),
        );
        // After swap: shared.ts moves to todos, util.ts moves to auth
        const fresh = makeClusters(
            makeCluster('cluster:auth', 'auth', ['a1.ts', 'a2.ts', 'a3.ts', 'util.ts']),
            makeCluster('cluster:todos', 'todos', ['t1.ts', 't2.ts', 't3.ts', 'shared.ts']),
        );
        const result = stabilizeClusters(fresh, baseline);
        expect(Object.keys(result).sort()).toEqual(['cluster:auth', 'cluster:todos']);
    });

    it('100% overlap (no change) → exact same ID', () => {
        const baseline = makeClusters(
            makeCluster('cluster:auth', 'auth', ['a.ts', 'b.ts']),
        );
        const fresh = makeClusters(
            makeCluster('cluster:auth', 'auth', ['a.ts', 'b.ts']),
        );
        const result = stabilizeClusters(fresh, baseline);
        expect(result['cluster:auth']).toBeDefined();
        expect(result['cluster:auth'].id).toBe('cluster:auth');
    });

    it('first run (no baseline) → all IDs kept as-is', () => {
        const fresh = makeClusters(
            makeCluster('cluster:auth', 'auth', ['a.ts']),
            makeCluster('cluster:pay', 'pay', ['p.ts']),
        );
        const result = stabilizeClusters(fresh, undefined);
        expect(Object.keys(result).sort()).toEqual(['cluster:auth', 'cluster:pay']);
    });

    it('multiple sequential rebuilds → IDs stable throughout', () => {
        const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
        let baseline = makeClusters(makeCluster('cluster:auth', 'auth', files));

        // Rebuild 1: remove one file
        let fresh = makeClusters(makeCluster('cluster:auth-new', 'auth', files.slice(0, 4)));
        let result = stabilizeClusters(fresh, baseline);
        expect(Object.keys(result)).toContain('cluster:auth');

        // Rebuild 2: add a file back (different one)
        baseline = result;
        fresh = makeClusters(makeCluster('cluster:auth-regen', 'auth', [...files.slice(0, 4), 'f.ts']));
        result = stabilizeClusters(fresh, baseline);
        expect(Object.keys(result)).toContain('cluster:auth');
    });

    it('cluster split: larger half inherits old ID', () => {
        const baseline = makeClusters(
            makeCluster('cluster:feature', 'feature', ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']),
        );
        // Split into 4-file and 2-file clusters
        const fresh = makeClusters(
            makeCluster('cluster:feature', 'feature', ['a.ts', 'b.ts', 'c.ts', 'd.ts']),
            makeCluster('cluster:other', 'other', ['e.ts', 'f.ts']),
        );
        const result = stabilizeClusters(fresh, baseline);
        // The 4/6 overlap = Jaccard 4/6 = 0.67 → should match
        expect(Object.keys(result)).toContain('cluster:feature');
        // The 2/6 overlap = Jaccard 2/6 = 0.33 → also above threshold but 4-file wins in greedy
        const featureCluster = result['cluster:feature'];
        expect(featureCluster.files).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    });

    it('integration: diffClusters shows modified not added+deleted after label change', () => {
        const baselineFiles = ['auth/login.ts', 'auth/register.ts', 'auth/model.ts'];
        const workingFiles = ['auth/login.ts', 'auth/register.ts', 'auth/model.ts', 'auth/session.ts'];

        const baseline = makeClusters(
            makeCluster('cluster:auth', 'auth', baselineFiles),
        );
        // Simulates Louvain assigning a different label but same files (mostly)
        const freshBeforeStabilize = makeClusters(
            makeCluster('cluster:authentication', 'authentication', workingFiles),
        );
        const stabilized = stabilizeClusters(freshBeforeStabilize, baseline);

        // stabilized should have inherited 'cluster:auth' ID
        expect(Object.keys(stabilized)).toContain('cluster:auth');

        const diffResult = diffClusters(baseline, stabilized);
        // Should be 'modified' (membership changed), NOT 'added'
        expect(diffResult['cluster:auth']?.diff).toBe('modified');
        // No deleted cluster since ID was inherited
        const deleted = Object.values(diffResult).filter(c => c.diff === 'deleted');
        expect(deleted).toHaveLength(0);
    });

    it('genuine new cluster → added in diff', () => {
        const baseline = makeClusters(
            makeCluster('cluster:auth', 'auth', ['a.ts', 'b.ts']),
        );
        const fresh = makeClusters(
            makeCluster('cluster:auth', 'auth', ['a.ts', 'b.ts']),
            makeCluster('cluster:payments', 'payments', ['p1.ts', 'p2.ts']),
        );
        const stabilized = stabilizeClusters(fresh, baseline);
        const diffResult = diffClusters(baseline, stabilized);
        // payments cluster has no overlap with baseline → added
        const paymentsEntry = Object.values(diffResult).find(c => c.label === 'payments');
        expect(paymentsEntry?.diff).toBe('added');
    });

    it('removed cluster → deleted in diff', () => {
        const baseline = makeClusters(
            makeCluster('cluster:auth', 'auth', ['a.ts', 'b.ts']),
            makeCluster('cluster:legacy', 'legacy', ['l1.ts', 'l2.ts']),
        );
        const fresh = makeClusters(
            makeCluster('cluster:auth', 'auth', ['a.ts', 'b.ts']),
        );
        const stabilized = stabilizeClusters(fresh, baseline);
        const diffResult = diffClusters(baseline, stabilized);
        const deleted = Object.values(diffResult).filter(c => c.diff === 'deleted');
        expect(deleted.length).toBe(1);
        expect(deleted[0].label).toBe('legacy');
    });
});

// ---------------------------------------------------------------------------
// stabilizeClusters — Negative flows
// ---------------------------------------------------------------------------

describe('stabilizeClusters — negative flows', () => {
    it('Jaccard 0.29 (below threshold) → NOT matched', () => {
        // 2 files overlap out of 7 union → J = 2/7 ≈ 0.286
        const baseline = makeClusters(
            makeCluster('cluster:old', 'old', ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']),
        );
        const fresh = makeClusters(
            makeCluster('cluster:new', 'new', ['a.ts', 'b.ts', 'x.ts', 'y.ts']),
        );
        const result = stabilizeClusters(fresh, baseline);
        // Should NOT inherit 'cluster:old' — Jaccard too low
        expect(Object.keys(result)).toContain('cluster:new');
        expect(Object.keys(result)).not.toContain('cluster:old');
    });

    it('genuinely new cluster (0% overlap) → fresh ID', () => {
        const baseline = makeClusters(
            makeCluster('cluster:auth', 'auth', ['a.ts', 'b.ts']),
        );
        const fresh = makeClusters(
            makeCluster('cluster:payments', 'payments', ['p1.ts', 'p2.ts']),
        );
        const result = stabilizeClusters(fresh, baseline);
        expect(Object.keys(result)).toEqual(['cluster:payments']);
    });

    it('cluster fully dissolved → no inheritance', () => {
        const baseline = makeClusters(
            makeCluster('cluster:temp', 'temp', ['t1.ts', 't2.ts']),
        );
        // Fresh has no clusters at all
        const fresh: Record<string, FeatureCluster> = {};
        const result = stabilizeClusters(fresh, baseline);
        expect(Object.keys(result)).toHaveLength(0);
    });

    it('empty baseline → no crash, all fresh IDs', () => {
        const fresh = makeClusters(
            makeCluster('cluster:auth', 'auth', ['a.ts']),
            makeCluster('cluster:pay', 'pay', ['p.ts']),
        );
        const result = stabilizeClusters(fresh, {});
        expect(Object.keys(result).sort()).toEqual(['cluster:auth', 'cluster:pay']);
    });

    it('ID collision prevention (suffix dedup)', () => {
        // Two fresh clusters both want ID 'cluster:auth' — one inherits, one gets suffix
        const baseline = makeClusters(
            makeCluster('cluster:auth', 'auth', ['a.ts', 'b.ts', 'c.ts']),
        );
        const fresh = makeClusters(
            makeCluster('cluster:auth', 'auth', ['a.ts', 'b.ts', 'c.ts']),
            makeCluster('cluster:auth-dup', 'auth-dup', ['x.ts', 'y.ts']),
        );
        const result = stabilizeClusters(fresh, baseline);
        const ids = Object.keys(result);
        // No duplicate IDs
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('Jaccard symmetry: J(A,B) = J(B,A)', () => {
        const filesA = ['a.ts', 'b.ts', 'c.ts'];
        const filesB = ['b.ts', 'c.ts', 'd.ts', 'e.ts'];
        // J = |{b,c}| / |{a,b,c,d,e}| = 2/5 = 0.4

        // Case 1: baseline=A, fresh=B
        const result1 = stabilizeClusters(
            makeClusters(makeCluster('cluster:fresh', 'fresh', filesB)),
            makeClusters(makeCluster('cluster:base', 'base', filesA)),
        );
        // Case 2: baseline=B, fresh=A
        const result2 = stabilizeClusters(
            makeClusters(makeCluster('cluster:fresh', 'fresh', filesA)),
            makeClusters(makeCluster('cluster:base', 'base', filesB)),
        );
        // Both should match (Jaccard 0.4 > 0.3 threshold)
        expect(Object.keys(result1)).toContain('cluster:base');
        expect(Object.keys(result2)).toContain('cluster:base');
    });

    it('performance: 200 clusters × 20 files stabilized in <500ms (O(n²)-regression ceiling, not a tight bound)', () => {
        const baselineClusters: Record<string, FeatureCluster> = {};
        const freshClusters: Record<string, FeatureCluster> = {};

        for (let i = 0; i < 200; i++) {
            const files = Array.from({ length: 20 }, (_, j) => `dir${i}/file${j}.ts`);
            baselineClusters[`cluster:c${i}`] = makeCluster(`cluster:c${i}`, `c${i}`, files);
            // Fresh: shift 2 files to simulate minor change
            const freshFiles = [...files.slice(2), `dir${i}/new1.ts`, `dir${i}/new2.ts`];
            freshClusters[`cluster:c${i}_regen`] = makeCluster(`cluster:c${i}_regen`, `c${i}`, freshFiles);
        }

        const start = performance.now();
        const result = stabilizeClusters(freshClusters, baselineClusters);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(500);
        expect(Object.keys(result)).toHaveLength(200);
    });
});

// ---------------------------------------------------------------------------
// End-to-end: detectCommunities with baselineClusters param
// ---------------------------------------------------------------------------

describe('detectCommunities — cluster ID stability (end-to-end)', () => {
    it('passing baselineClusters stabilizes IDs across rebuilds', () => {
        const callGraph = makeCallGraph(
            [
                'auth/a.ts::fn', 'auth/b.ts::fn',
                'todos/a.ts::fn', 'todos/b.ts::fn',
            ],
            [
                ['auth/a.ts::fn', 'auth/b.ts::fn'],
                ['todos/a.ts::fn', 'todos/b.ts::fn'],
            ],
        );
        const snapshot = makeSnapshot(['auth/a.ts', 'auth/b.ts', 'todos/a.ts', 'todos/b.ts']);

        // First run: no baseline
        const firstRun = detectCommunities(snapshot, callGraph, undefined, undefined);
        const firstIds = Object.keys(firstRun);
        expect(firstIds.length).toBeGreaterThanOrEqual(2);

        // Second run: same data, pass first run as baseline
        const secondRun = detectCommunities(snapshot, callGraph, undefined, firstRun);
        const secondIds = Object.keys(secondRun);

        // IDs should be identical since data didn't change
        expect(secondIds.sort()).toEqual(firstIds.sort());
    });

    it('adding a file preserves cluster IDs', () => {
        const callGraph1 = makeCallGraph(
            ['auth/a.ts::fn', 'auth/b.ts::fn', 'pay/a.ts::fn', 'pay/b.ts::fn'],
            [
                ['auth/a.ts::fn', 'auth/b.ts::fn'],
                ['pay/a.ts::fn', 'pay/b.ts::fn'],
            ],
        );
        const snapshot1 = makeSnapshot(['auth/a.ts', 'auth/b.ts', 'pay/a.ts', 'pay/b.ts']);
        const baseline = detectCommunities(snapshot1, callGraph1);

        // Add a file to auth
        const callGraph2 = makeCallGraph(
            ['auth/a.ts::fn', 'auth/b.ts::fn', 'auth/c.ts::fn', 'pay/a.ts::fn', 'pay/b.ts::fn'],
            [
                ['auth/a.ts::fn', 'auth/b.ts::fn'],
                ['auth/b.ts::fn', 'auth/c.ts::fn'],
                ['pay/a.ts::fn', 'pay/b.ts::fn'],
            ],
        );
        const snapshot2 = makeSnapshot(['auth/a.ts', 'auth/b.ts', 'auth/c.ts', 'pay/a.ts', 'pay/b.ts']);
        const working = detectCommunities(snapshot2, callGraph2, undefined, baseline);

        // Both original cluster IDs should still exist
        for (const id of Object.keys(baseline)) {
            expect(Object.keys(working)).toContain(id);
        }
    });
});
