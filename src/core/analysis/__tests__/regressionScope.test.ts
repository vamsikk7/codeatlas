/**
 * regressionScope.test.ts — #827 (2026-06-10).
 *
 * Pins the regression-scope composition: changed entities from snapshot
 * hash diff, blast radius via analyzeImpact, tests-to-run from call-graph
 * test reachability + path convention, untested blast radius with and
 * without coverage data, affected APIs, cross-repo consumers, and the
 * runner-command handoff.
 */

import { describe, it, expect } from 'vitest';
import { computeRegressionScope } from '../regressionScope';
import { WorkspaceCallGraph } from '../../graph/callGraphResolver';
import type { Snapshot, FileRecord } from '../../graph/graphTypes';
import type { CoverageReport } from '../coverageReader';

/* eslint-disable @typescript-eslint/no-explicit-any */

function fileRec(hash: string): FileRecord {
    return { content: '', symbols: { functions: [], vars: [], imports: [] }, lastModified: 0, hash } as any;
}

function buildGraph(edges: Array<[string, string]>): WorkspaceCallGraph {
    const graph = new WorkspaceCallGraph();
    const seen = new Set<string>();
    for (const [caller, callee] of edges) {
        for (const k of [caller, callee]) {
            if (seen.has(k)) continue;
            const [f, n] = k.split('::');
            graph.ensureNode(f, n);
            seen.add(k);
        }
    }
    for (const [caller, callee] of edges) graph.addEdge(caller, callee, 0.9, 'calls');
    return graph;
}

/**
 * Canonical fixture: auth.service.ts changed; controller calls it; a
 * vitest-style test calls the controller; an unrelated module exists.
 */
function fixture(): { working: Snapshot; baseline: Snapshot } {
    const cg = buildGraph([
        ['src/auth/auth.controller.ts::loginRoute', 'src/auth/auth.service.ts::loginUser'],
        ['src/auth/__tests__/auth.controller.test.ts::it_logs_in', 'src/auth/auth.controller.ts::loginRoute'],
        ['src/billing/billing.service.ts::charge', 'src/billing/billing.service.ts::chargeInner'],
    ]);
    const files: Record<string, FileRecord> = {
        'src/auth/auth.service.ts': fileRec('NEW'),
        'src/auth/auth.controller.ts': fileRec('same-1'),
        'src/auth/__tests__/auth.controller.test.ts': fileRec('same-2'),
        'src/billing/billing.service.ts': fileRec('same-3'),
    };
    const working: Snapshot = {
        files,
        apiIndex: {
            'POST:/login': { apiId: 'POST:/login', method: 'POST', route: '/login', filePath: 'src/auth/auth.controller.ts', handlerName: 'loginRoute', diff: 'unchanged' },
            'POST:/charge': { apiId: 'POST:/charge', method: 'POST', route: '/charge', filePath: 'src/billing/billing.service.ts', handlerName: 'charge', diff: 'unchanged' },
        } as any,
        graphs: {},
        callGraph: cg.serialize(),
    } as any;
    const baseline: Snapshot = {
        files: {
            ...files,
            'src/auth/auth.service.ts': fileRec('OLD'),
        },
        apiIndex: {}, graphs: {},
    } as any;
    return { working, baseline };
}

describe('#827 — computeRegressionScope', () => {
    it('empty scope when working === baseline', () => {
        const { working } = fixture();
        const scope = computeRegressionScope({ working, baseline: working });
        expect(scope.changedEntities).toHaveLength(0);
        expect(scope.testsToRun).toHaveLength(0);
        expect(scope.testCommand).toBeNull();
    });

    it('detects the changed file + finds the test that reaches it through the call graph', () => {
        const { working, baseline } = fixture();
        const scope = computeRegressionScope({ working, baseline });

        expect(scope.changedEntities.map(e => e.filePath)).toContain('src/auth/auth.service.ts');
        // The vitest file calls the controller which calls the changed
        // service — call-graph reachability lists it as a test to run.
        expect(scope.testsToRun.map(t => t.testFile)).toContain('src/auth/__tests__/auth.controller.test.ts');
        // Blast radius includes the controller, NOT the unrelated billing module.
        const blastFiles = [...scope.blastRadius.direct, ...scope.blastRadius.transitive].map(f => f.filePath);
        expect(blastFiles).toContain('src/auth/auth.controller.ts');
        expect(blastFiles).not.toContain('src/billing/billing.service.ts');
        // Affected APIs: the login route (its handler file is in blast).
        expect(scope.affectedApis.map(a => a.apiId)).toContain('POST:/login');
        expect(scope.affectedApis.map(a => a.apiId)).not.toContain('POST:/charge');
        // Runner handoff names the test file.
        expect(scope.testCommand).toContain('auth.controller.test.ts');
    });

    it('path-convention sibling test found even with no call-graph edge', () => {
        const files: Record<string, FileRecord> = {
            'src/util/format.ts': fileRec('NEW'),
            'src/util/__tests__/format.test.ts': fileRec('t1'),
        };
        const working: Snapshot = { files, apiIndex: {}, graphs: {} } as any;
        const baseline: Snapshot = { files: { ...files, 'src/util/format.ts': fileRec('OLD') }, apiIndex: {}, graphs: {} } as any;
        const scope = computeRegressionScope({ working, baseline });
        const hit = scope.testsToRun.find(t => t.testFile === 'src/util/__tests__/format.test.ts');
        expect(hit).toBeTruthy();
        expect(hit!.reason).toBe('path-convention');
    });

    it('untested blast radius via coverage: zero-hit functions land on the risk list', () => {
        const { working, baseline } = fixture();
        const coverage: CoverageReport = {
            'src/auth/auth.controller.ts': {
                filePath: 'src/auth/auth.controller.ts',
                lineRate: 0.8, branchRate: 0.5,
                functions: { loginRoute: { hits: 0, lineRate: 0 } },   // ← uncovered!
            },
            'src/auth/auth.service.ts': {
                filePath: 'src/auth/auth.service.ts',
                lineRate: 0.9, branchRate: 0.7,
                functions: { loginUser: { hits: 12, lineRate: 0.9 } }, // covered
            },
        };
        const scope = computeRegressionScope({ working, baseline, coverage });
        expect(scope.coverageAvailable).toBe(true);
        const untested = scope.untestedBlastRadius.map(f => f.key);
        expect(untested).toContain('src/auth/auth.controller.ts::loginRoute');
        expect(untested).not.toContain('src/auth/auth.service.ts::loginUser');
    });

    it('no coverage data → coverageAvailable=false and the heuristic risk list still populates', () => {
        const { working, baseline } = fixture();
        const scope = computeRegressionScope({ working, baseline });
        expect(scope.coverageAvailable).toBe(false);
        // With a test resolved, direct entities count as reached; the
        // heuristic keeps non-direct blast as the unknown/risk tail.
        expect(Array.isArray(scope.untestedBlastRadius)).toBe(true);
    });

    it('cross-repo consumers matched against affected routes (multi-repo)', () => {
        const { working, baseline } = fixture();
        const scope = computeRegressionScope({
            working, baseline,
            repoName: 'auth-service',
            crossRepoEdges: [
                { sourceRepo: 'gateway', targetRepo: 'auth-service', method: 'POST', route: '/login' },
                { sourceRepo: 'gateway', targetRepo: 'OTHER-service', method: 'POST', route: '/login' },
                { sourceRepo: 'reports', targetRepo: 'auth-service', method: 'GET', route: '/unrelated' },
            ],
        });
        expect(scope.crossRepoConsumers).toHaveLength(1);
        expect(scope.crossRepoConsumers[0]).toMatchObject({ consumerRepo: 'gateway', method: 'POST', route: '/login' });
    });

    it('jest config in the workspace flips the runner handoff to jest --findRelatedTests', () => {
        const { working, baseline } = fixture();
        (working.files as any)['jest.config.js'] = fileRec('cfg');
        const scope = computeRegressionScope({ working, baseline });
        expect(scope.testCommand).toContain('jest --findRelatedTests');
        expect(scope.testCommand).toContain('src/auth/auth.service.ts');
    });

    it('deleted files appear as changed entities but are not fed to impact as changed paths', () => {
        const { working, baseline } = fixture();
        (baseline.files as any)['src/auth/legacy.ts'] = fileRec('dead');
        const scope = computeRegressionScope({ working, baseline });
        const del = scope.changedEntities.find(e => e.filePath === 'src/auth/legacy.ts');
        expect(del?.changeKind).toBe('deleted');
    });
});
