/**
 * tier1Tools.test.ts — unit tests for Tier 1 MCP additions:
 * getFunctionSource, getApiSurfaceDiff, getPreEditBrief, getHealthReport,
 * traceCallPath.
 */
import { describe, it, expect } from 'vitest';
import type { Snapshot } from '../../core/graph/graphTypes';
import {
    getFunctionSource,
    getApiSurfaceDiff,
    getPreEditBrief,
    getHealthReport,
} from '../contextPack';
import { traceCallPath } from '../callPath';

function makeSnapshot(): Snapshot {
    return {
        files: {
            'src/auth.ts': {
                path: 'src/auth.ts', hash: 'h1', mtime: 0,
                symbols: {
                    functions: [
                        { name: 'getCurrentUser', kind: 'function', span: { start: 0, end: 50 }, signature: 'function getCurrentUser(id)', bodyText: 'return findOne(id)', stableKey: 'k1', calls: ['findOne'] },
                        { name: 'createUser', kind: 'function', span: { start: 60, end: 110 }, signature: 'function createUser(d)', bodyText: 'return insert(d)', stableKey: 'k2', calls: ['insert'] },
                    ],
                    variables: [],
                    imports: [{ source: './db', specifiers: [{ local: 'findOne', imported: 'findOne' }], span: { start: 0, end: 1 }, stableKey: 'i1' }],
                },
            },
            'src/db.ts': {
                path: 'src/db.ts', hash: 'h2', mtime: 0,
                symbols: {
                    functions: [
                        { name: 'findOne', kind: 'function', span: { start: 0, end: 50 }, signature: 'function findOne(id)', bodyText: 'return db.query(...)', stableKey: 'k3' },
                    ],
                    variables: [], imports: [],
                },
            },
        },
        apiIndex: {
            'GET:/user::src/auth.ts::getCurrentUser': {
                apiId: 'GET:/user::src/auth.ts::getCurrentUser',
                method: 'GET', route: '/user', handlerName: 'getCurrentUser', filePath: 'src/auth.ts',
                anchor: { filePath: 'src/auth.ts', span: { start: 0, end: 50 } },
                meta: { auth: 'required', middlewares: ['auth.required'] },
            },
            'POST:/users::src/auth.ts::createUser': {
                apiId: 'POST:/users::src/auth.ts::createUser',
                method: 'POST', route: '/users', handlerName: 'createUser', filePath: 'src/auth.ts',
                anchor: { filePath: 'src/auth.ts', span: { start: 60, end: 110 } },
            },
        },
        graphs: {
            'sequence:src/auth.ts:getCurrentUser': {
                graphId: 'sequence:src/auth.ts:getCurrentUser',
                type: 'sequence',
                nodes: [
                    { id: 'p1', type: 'participant', label: 'API Client', subtitle: '«actor»' },
                    { id: 'p2', type: 'participant', label: 'db.ts', subtitle: '«module»', anchor: { filePath: 'src/db.ts' } },
                ],
                edges: [], anchors: {}, meta: {},
            },
        },
        clusters: {
            'cluster:auth': { id: 'cluster:auth', label: 'auth', files: ['src/auth.ts'], entryPoints: [], internalCallCount: 0, externalCallCount: 0 },
            'cluster:db': { id: 'cluster:db', label: 'db', files: ['src/db.ts'], entryPoints: [], internalCallCount: 0, externalCallCount: 0 },
        },
        callGraph: {
            version: 2,
            nodes: {
                'src/auth.ts::getCurrentUser': {
                    key: 'src/auth.ts::getCurrentUser',
                    filePath: 'src/auth.ts', functionName: 'getCurrentUser',
                    calls: ['src/db.ts::findOne'], calledBy: [],
                    callEdges: [{ key: 'src/db.ts::findOne', confidence: 0.9, kind: 'calls' }],
                },
                'src/db.ts::findOne': {
                    key: 'src/db.ts::findOne',
                    filePath: 'src/db.ts', functionName: 'findOne',
                    calls: [], calledBy: ['src/auth.ts::getCurrentUser'],
                    callEdges: [],
                },
            },
            edges: [
                { callerKey: 'src/auth.ts::getCurrentUser', calleeKey: 'src/db.ts::findOne', confidence: 0.9, kind: 'calls' },
            ],
        },
        health: {
            deadFunctions: ['src/utils.ts::helper'],
            godFiles: [],
            highCouplingFiles: ['src/orchestrator.ts'],
            cyclicDependencies: [['a.ts', 'b.ts', 'a.ts']],
            orphanedClusters: ['cluster:legacy'],
        },
    };
}

describe('getFunctionSource', () => {
    const FAKE_SOURCE = 'function getCurrentUser(id) { return findOne(id); }\n\n// pad\nfunction createUser(d) { return insert(d); }';

    it('returns the function slice with line range', () => {
        const result = getFunctionSource(makeSnapshot(), 'src/auth.ts', 'getCurrentUser', () => FAKE_SOURCE);
        expect(result).not.toBeNull();
        expect(result!.kind).toBe('function');
        expect(result!.signature).toContain('getCurrentUser');
        expect(result!.lineRange?.startLine).toBe(1);
    });

    it('falls back to signature+bodyText when content is unavailable', () => {
        const result = getFunctionSource(makeSnapshot(), 'src/auth.ts', 'getCurrentUser', () => undefined);
        expect(result).not.toBeNull();
        expect(result!.source).toContain('function getCurrentUser');
        expect(result!.source).toContain('return findOne');
    });

    it('returns null for unknown file or symbol', () => {
        expect(getFunctionSource(makeSnapshot(), 'src/missing.ts', 'fn', () => '')).toBeNull();
        expect(getFunctionSource(makeSnapshot(), 'src/auth.ts', 'doesNotExist', () => '')).toBeNull();
    });
});

describe('getApiSurfaceDiff', () => {
    it('reports added/removed/contractChanges between snapshots', () => {
        const working = makeSnapshot();
        const baseline = makeSnapshot();
        // Add a new route in working, remove POST /users from working.
        working.apiIndex['DELETE:/user::src/auth.ts::deleteUser'] = {
            apiId: 'DELETE:/user::src/auth.ts::deleteUser',
            method: 'DELETE', route: '/user', handlerName: 'deleteUser', filePath: 'src/auth.ts',
            anchor: { filePath: 'src/auth.ts' },
            meta: { auth: 'required' },
        };
        delete working.apiIndex['POST:/users::src/auth.ts::createUser'];
        // Change the contract on GET /user: drop auth.required.
        working.apiIndex['GET:/user::src/auth.ts::getCurrentUser'].meta = { auth: 'optional', middlewares: ['auth.optional'] };

        const diff = getApiSurfaceDiff(working, baseline);
        expect(diff.counts.added).toBe(1);
        expect(diff.counts.removed).toBe(1);
        expect(diff.counts.contractChanges).toBe(1);
        expect(diff.added[0].route).toBe('/user');
        expect(diff.added[0].method).toBe('DELETE');
        expect(diff.removed[0].route).toBe('/users');
        const change = diff.contractChanges[0];
        expect(change.previousAuth).toBe('required');
        expect(change.currentAuth).toBe('optional');
    });

    it('returns empty counts when snapshots are identical', () => {
        const snap = makeSnapshot();
        const diff = getApiSurfaceDiff(snap, snap);
        expect(diff.counts).toEqual({ added: 0, removed: 0, contractChanges: 0 });
    });
});

describe('getPreEditBrief', () => {
    it('returns a comprehensive brief with source, impact, siblings, imports', () => {
        const snap = makeSnapshot();
        const brief = getPreEditBrief(snap, snap, 'src/auth.ts', 'getCurrentUser', () => 'function getCurrentUser(id){return findOne(id)}');
        expect(brief).not.toBeNull();
        expect(brief!.target.filePath).toBe('src/auth.ts');
        expect(brief!.target.symbolName).toBe('getCurrentUser');
        expect(brief!.source).not.toBeNull();
        expect(brief!.siblingFunctions).toContain('createUser');
        expect(brief!.importsUsed).toContain('./db');
        expect(brief!.approximateTokens).toBeGreaterThan(0);
    });

    it('handles file-only brief (no symbol)', () => {
        const snap = makeSnapshot();
        const brief = getPreEditBrief(snap, snap, 'src/auth.ts', undefined, () => '');
        expect(brief).not.toBeNull();
        expect(brief!.source).toBeUndefined();
    });

    it('returns null for unknown file', () => {
        const snap = makeSnapshot();
        expect(getPreEditBrief(snap, snap, 'src/missing.ts', undefined, () => '')).toBeNull();
    });

    it('surfaces diff when file hash differs from baseline', () => {
        const working = makeSnapshot();
        const baseline = makeSnapshot();
        working.files['src/auth.ts'].hash = 'h-new';
        const brief = getPreEditBrief(working, baseline, 'src/auth.ts', 'getCurrentUser', () => '');
        expect(brief!.diff?.fileChanged).toBe(true);
        expect(brief!.diff?.hash).toBe('h-new');
        expect(brief!.diff?.baselineHash).toBe('h1');
    });
});

describe('getHealthReport', () => {
    it('returns the snapshot health report', () => {
        const report = getHealthReport(makeSnapshot());
        expect(report).not.toBeNull();
        expect(report!.deadFunctions).toContain('src/utils.ts::helper');
        expect(report!.highCouplingFiles).toContain('src/orchestrator.ts');
    });

    it('returns null when health is missing', () => {
        const snap = makeSnapshot();
        delete snap.health;
        expect(getHealthReport(snap)).toBeNull();
    });
});

describe('traceCallPath', () => {
    it('finds a direct one-hop path', () => {
        const result = traceCallPath(makeSnapshot(), 'src/auth.ts', 'getCurrentUser', 'src/db.ts', 'findOne');
        expect(result.path).toHaveLength(1);
        expect(result.path[0].toFunction).toBe('findOne');
        expect(result.path[0].kind).toBe('calls');
        expect(result.path[0].confidence).toBe(0.9);
    });

    it('returns empty path when no route exists', () => {
        const result = traceCallPath(makeSnapshot(), 'src/auth.ts', 'createUser', 'src/db.ts', 'findOne');
        // createUser has no call graph edge to findOne in this fixture.
        expect(result.path).toHaveLength(0);
    });

    it('returns empty for unknown endpoints', () => {
        const result = traceCallPath(makeSnapshot(), 'src/missing.ts', 'fn', 'src/db.ts', 'findOne');
        expect(result.path).toHaveLength(0);
        expect(result.visited).toBe(0);
    });

    it('truncates at maxDepth', () => {
        // Pathological: search a depth of 0 → should fail to reach
        const result = traceCallPath(makeSnapshot(), 'src/auth.ts', 'getCurrentUser', 'src/db.ts', 'findOne', 0);
        // depth 0 means we cannot expand from source; path empty, truncated.
        expect(result.path).toHaveLength(0);
        expect(result.truncated).toBe(true);
    });
});
