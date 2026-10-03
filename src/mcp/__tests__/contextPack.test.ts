/**
 * contextPack.test.ts — unit tests for the entry-point context pack builders.
 *
 * All assertions run against a hand-rolled minimal `Snapshot` so the math
 * stays deterministic. A separate live-fixture probe is in `mcpRealRepo.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import type { Snapshot } from '../../core/graph/graphTypes';
import {
    listEntryPoints,
    getEntryPointPack,
    getDiffSummary,
    getImpactOfChange,
    getFeaturePack,
    changedLineNumbers,
    windowChangedSource,
} from '../contextPack';

function buildSnapshot(): Snapshot {
    return {
        files: {
            'src/article.controller.ts': { path: 'src/article.controller.ts', hash: 'h1', mtime: 1, symbols: { functions: [], variables: [], imports: [] } },
            'src/article.service.ts': { path: 'src/article.service.ts', hash: 'h2', mtime: 1, symbols: { functions: [], variables: [], imports: [] } },
        },
        apiIndex: {
            'GET:/articles::src/article.controller.ts::anonymous@GET:/articles': {
                apiId: 'GET:/articles::src/article.controller.ts::anonymous@GET:/articles',
                method: 'GET',
                route: '/articles',
                handlerName: 'anonymous@GET:/articles',
                filePath: 'src/article.controller.ts',
                anchor: { filePath: 'src/article.controller.ts', span: { start: 0, end: 20 } },
                meta: { auth: 'optional', middlewares: ['auth.optional'] },
            },
            'POST:/articles::src/article.controller.ts::anonymous@POST:/articles': {
                apiId: 'POST:/articles::src/article.controller.ts::anonymous@POST:/articles',
                method: 'POST',
                route: '/articles',
                handlerName: 'anonymous@POST:/articles',
                filePath: 'src/article.controller.ts',
                anchor: { filePath: 'src/article.controller.ts', span: { start: 30, end: 60 } },
                meta: { auth: 'required', middlewares: ['auth.required'] },
            },
            'JOB:job:cleanup::src/jobs/cleanup.ts::cleanupJob': {
                apiId: 'JOB:job:cleanup::src/jobs/cleanup.ts::cleanupJob',
                method: 'JOB',
                route: 'job:cleanup',
                handlerName: 'cleanupJob',
                filePath: 'src/jobs/cleanup.ts',
                anchor: { filePath: 'src/jobs/cleanup.ts', span: { start: 0, end: 0 } },
            },
        },
        graphs: {
            'sequence:src/article.controller.ts:anonymous@GET:/articles': {
                graphId: 'sequence:src/article.controller.ts:anonymous@GET:/articles',
                type: 'sequence',
                nodes: [
                    { id: 'p1', type: 'participant', label: 'API Client', subtitle: '«actor»', diff: 'unchanged' },
                    { id: 'p2', type: 'participant', label: 'article.service.ts', subtitle: '«module»', anchor: { filePath: 'src/article.service.ts' }, diff: 'modified' },
                ],
                edges: [
                    { id: 'e1', source: 'p1', target: 'p2', label: 'getArticles()', edgeType: 'message', diff: 'modified' },
                ],
                anchors: {},
                meta: {},
            },
            'flow:src/article.controller.ts:anonymous@GET:/articles': {
                graphId: 'flow:src/article.controller.ts:anonymous@GET:/articles',
                type: 'flow',
                nodes: [
                    { id: 's', type: 'terminal', label: 'Start', diff: 'unchanged' },
                    { id: 'st1', type: 'statement', label: 'await getArticles(req.query)', diff: 'modified' },
                    { id: 'e', type: 'terminal', label: 'End', diff: 'unchanged' },
                ],
                edges: [],
                anchors: {},
                meta: {},
            },
        },
        clusters: {
            'cluster:article': {
                id: 'cluster:article',
                label: 'article',
                files: ['src/article.controller.ts', 'src/article.service.ts'],
                entryPoints: [],
                internalCallCount: 0,
                externalCallCount: 0,
                serviceId: 'service:main',
                diff: 'modified',
            },
            'cluster:jobs': {
                id: 'cluster:jobs',
                label: 'jobs',
                files: ['src/jobs/cleanup.ts'],
                entryPoints: [],
                internalCallCount: 0,
                externalCallCount: 0,
                serviceId: 'service:main',
            },
        },
        services: {
            'service:main': {
                id: 'service:main',
                name: 'main',
                rootPath: '.',
                technology: 'express',
                exposedApiCount: 2,
                consumedUrls: [],
                consumedServices: [],
            },
        },
    };
}

describe('contextPack', () => {
    describe('listEntryPoints', () => {
        it('returns every entry point with cluster + service metadata', () => {
            const snap = buildSnapshot();
            const eps = listEntryPoints(snap);
            expect(eps).toHaveLength(3);
            const get = eps.find((e) => e.method === 'GET' && e.route === '/articles');
            expect(get?.clusterId).toBe('cluster:article');
            expect(get?.clusterLabel).toBe('article');
            expect(get?.serviceId).toBe('service:main');
            expect(get?.auth).toBe('optional');
            expect(get?.middlewares).toEqual(['auth.optional']);
        });

        it('filters by method, clusterId, and authRequired', () => {
            const snap = buildSnapshot();
            expect(listEntryPoints(snap, { method: 'JOB' })).toHaveLength(1);
            expect(listEntryPoints(snap, { clusterId: 'cluster:article' })).toHaveLength(2);
            expect(listEntryPoints(snap, { authRequired: true })).toHaveLength(1);
        });

        it('filters by routeContains', () => {
            const snap = buildSnapshot();
            expect(listEntryPoints(snap, { routeContains: 'job:' })).toHaveLength(1);
        });

        // #MCP-AUDIT-2 (2026-06-07): callers should be able to chain a row
        // from `list_entrypoints` directly into `generate_request_body` /
        // `generate_test_cases` / `get_function_source` without
        // reconstructing the canonical apiId by hand. Returning the
        // backing `apiId` here is the one-line fix — those tools look up
        // by apiId against `snap.apiIndex`. Skip it and callers have to
        // either run `query_snapshot 'SELECT api_id …'` or synthesize a
        // key whose format is implementation-defined.
        it('includes the apiId so callers can chain into apiId-keyed tools', () => {
            const snap = buildSnapshot();
            const eps = listEntryPoints(snap);
            const apiIds = Object.keys(snap.apiIndex ?? {});
            // Every returned entry's apiId is a real key in the apiIndex.
            for (const ep of eps) {
                expect(ep.apiId, `${ep.method} ${ep.route} missing apiId`).toBeDefined();
                expect(apiIds, `apiId ${ep.apiId} not present in apiIndex`).toContain(ep.apiId);
            }
        });
    });

    describe('getEntryPointPack', () => {
        it('returns the full pack with downstream calls + flow nodes + siblings', () => {
            const snap = buildSnapshot();
            const pack = getEntryPointPack(snap, 'GET', '/articles');
            expect(pack).not.toBeNull();
            expect(pack!.entryPoint.method).toBe('GET');
            expect(pack!.callsInto).toHaveLength(1);
            expect(pack!.callsInto[0].participant).toBe('article.service.ts');
            expect(pack!.messages).toHaveLength(1);
            expect(pack!.messages[0].label).toBe('getArticles()');
            expect(pack!.flowNodes).toHaveLength(3);
            expect(pack!.siblings).toEqual([{ method: 'POST', route: '/articles' }]);
        });

        it('surfaces the diff section when sequence or flow has modified nodes', () => {
            const snap = buildSnapshot();
            const pack = getEntryPointPack(snap, 'GET', '/articles');
            expect(pack!.diff).toBeDefined();
            expect(pack!.diff!.modifiedFunctions).toContain('article.service.ts');
            expect(pack!.diff!.modifiedMessages.length).toBeGreaterThan(0);
            expect(pack!.diff!.modifiedFlowNodes).toBe(1);
        });

        it('embeds the handler source slice when a resolver is provided', () => {
            const snap = buildSnapshot();
            const pack = getEntryPointPack(snap, 'GET', '/articles', {
                workspaceFileContent: () => 'XXXXXXXXXXXXXXXXXXXX-rest-of-file-here',
            });
            expect(pack!.handlerSource).toBe('XXXXXXXXXXXXXXXXXXXX');
        });

        it('returns null when the entry point is not found', () => {
            const snap = buildSnapshot();
            expect(getEntryPointPack(snap, 'GET', '/nope')).toBeNull();
        });
    });

    describe('getDiffSummary', () => {
        it('reports changed files and added/modified entry points vs a baseline', () => {
            const working = buildSnapshot();
            const baseline = buildSnapshot();
            // Mutate baseline: drop the POST route + change a file hash.
            baseline.files['src/article.controller.ts'].hash = 'h0';
            delete baseline.apiIndex['POST:/articles::src/article.controller.ts::anonymous@POST:/articles'];

            const summary = getDiffSummary(working, baseline);
            expect(summary.changedFiles).toContain('src/article.controller.ts');
            expect(summary.addedEntryPoints.map((e) => `${e.method} ${e.route}`)).toContain('POST /articles');
            expect(summary.modifiedEntryPoints.map((e) => `${e.method} ${e.route}`)).toContain('GET /articles');
            expect(summary.modifiedClusters.map((c) => c.id)).toContain('cluster:article');
        });
    });

    describe('getImpactOfChange', () => {
        it('lists entry points whose sequence reaches the changed file', () => {
            const snap = buildSnapshot();
            const impact = getImpactOfChange(snap, 'src/article.service.ts');
            expect(impact.entryPoints).toHaveLength(1);
            expect(impact.entryPoints[0].route).toBe('/articles');
            expect(impact.affectedSequenceIds).toContain('sequence:src/article.controller.ts:anonymous@GET:/articles');
        });

        it('returns empty when the file has no consumers', () => {
            const snap = buildSnapshot();
            const impact = getImpactOfChange(snap, 'src/unused.ts');
            expect(impact.entryPoints).toHaveLength(0);
        });
    });

    describe('getFeaturePack', () => {
        it('returns a cluster summary with all entry points', () => {
            const snap = buildSnapshot();
            const pack = getFeaturePack(snap, 'cluster:article');
            expect(pack).not.toBeNull();
            expect(pack!.cluster.label).toBe('article');
            expect(pack!.entryPoints).toHaveLength(2);
            expect(pack!.cluster.serviceId).toBe('service:main');
        });

        it('includes diff section when baseline is provided', () => {
            const working = buildSnapshot();
            const baseline = buildSnapshot();
            baseline.files['src/article.controller.ts'].hash = 'h0';
            const pack = getFeaturePack(working, 'cluster:article', baseline);
            expect(pack!.diff?.changedFiles).toContain('src/article.controller.ts');
        });

        it('returns null for an unknown cluster id', () => {
            const snap = buildSnapshot();
            expect(getFeaturePack(snap, 'cluster:nope')).toBeNull();
        });

        // #FEATURE-PACK-FALLBACK (2026-06-07) — when Louvain places a
        // service file alone in a cluster (controller landed in a
        // sibling), strict filterByClusterId returns 0 entry points
        // even though the API call chain crosses into the cluster. The
        // fix is a call-graph fallback: surface APIs whose handler
        // reaches a function inside the cluster's files.
        it('falls back via the call graph when no APIs live in the cluster files', () => {
            const snap: Snapshot = {
                files: {
                    'src/controller.ts': {
                        path: 'src/controller.ts', hash: 'h1', mtime: 1,
                        symbols: { functions: [{ name: 'anonymous@GET:/things', kind: 'function', span: { start: 0, end: 30 }, signature: '', bodyText: '', stableKey: 'function:handler' }], variables: [], imports: [] },
                    } as any,
                    'src/service.ts': {
                        path: 'src/service.ts', hash: 'h2', mtime: 1,
                        symbols: { functions: [{ name: 'listThings', kind: 'function', span: { start: 0, end: 20 }, signature: '', bodyText: '', stableKey: 'function:listThings' }], variables: [], imports: [] },
                    } as any,
                },
                apiIndex: {
                    'GET:/things::src/controller.ts::anonymous@GET:/things': {
                        apiId: 'GET:/things::src/controller.ts::anonymous@GET:/things',
                        method: 'GET', route: '/things',
                        handlerName: 'anonymous@GET:/things',
                        filePath: 'src/controller.ts',
                        anchor: { filePath: 'src/controller.ts', span: { start: 0, end: 30 } },
                    },
                },
                graphs: {},
                clusters: {
                    'cluster:things-svc': {
                        id: 'cluster:things-svc',
                        label: 'things service',
                        files: ['src/service.ts'],
                        entryPoints: [], internalCallCount: 0, externalCallCount: 0,
                        serviceId: 'service:main', diff: 'unchanged',
                    } as any,
                    'cluster:misc': {
                        id: 'cluster:misc',
                        label: 'misc',
                        files: ['src/controller.ts'],
                        entryPoints: [], internalCallCount: 0, externalCallCount: 0,
                        serviceId: 'service:main', diff: 'unchanged',
                    } as any,
                },
                services: {},
                callGraph: {
                    nodes: {
                        'src/controller.ts::anonymous@GET:/things': { key: 'src/controller.ts::anonymous@GET:/things', filePath: 'src/controller.ts', functionName: 'anonymous@GET:/things', calls: ['src/service.ts::listThings'], calledBy: [] },
                        'src/service.ts::listThings': { key: 'src/service.ts::listThings', filePath: 'src/service.ts', functionName: 'listThings', calls: [], calledBy: ['src/controller.ts::anonymous@GET:/things'] },
                    },
                    edges: [{ callerKey: 'src/controller.ts::anonymous@GET:/things', calleeKey: 'src/service.ts::listThings', confidence: 0.85, kind: 'calls' }],
                } as any,
            } as Snapshot;
            const pack = getFeaturePack(snap, 'cluster:things-svc');
            expect(pack).not.toBeNull();
            expect(pack!.entryPoints.length).toBeGreaterThan(0);
            const fallbackApi = pack!.entryPoints.find(ep => ep.method === 'GET' && ep.route === '/things');
            expect(fallbackApi, 'controller GET /things should surface via the call-graph fallback').toBeTruthy();
        });

        it('does NOT duplicate entry points already inside the cluster files', () => {
            // When both controller AND service are in the same cluster
            // the direct walk already finds the API; the fallback must
            // not add a second copy.
            const snap = buildSnapshot();
            const pack = getFeaturePack(snap, 'cluster:article');
            const ids = pack!.entryPoints.map(ep => `${ep.method} ${ep.route}`);
            const seen = new Set<string>();
            for (const id of ids) {
                expect(seen.has(id), `dup ${id}`).toBe(false);
                seen.add(id);
            }
        });

        it('returns the strict (in-cluster) entry points when both are present', () => {
            // Sanity: when the controller file IS in the cluster, the
            // strict walk returns the APIs and the fallback is a no-op.
            const snap = buildSnapshot();
            const pack = getFeaturePack(snap, 'cluster:article');
            expect(pack!.entryPoints).toHaveLength(2);
        });
    });

    // ─── #866 — diff-windowed source + lean graph trimming ──────────────────
    describe('#866 lean pack (diff-windowed source + trim)', () => {
        it('changedLineNumbers flags only added/modified working lines', () => {
            const baseline = 'a\nb\nc\nd\n';
            const working = 'a\nB2\nc\nd\nE\n'; // line 2 modified, line 5 added
            const changed = changedLineNumbers(baseline, working);
            expect(changed.has(2)).toBe(true);
            expect(changed.has(5)).toBe(true);
            expect(changed.has(1)).toBe(false);
            expect(changed.has(3)).toBe(false);
            expect(changed.has(4)).toBe(false);
        });

        it('windowChangedSource windows a large handler to changed regions with a gap marker', () => {
            // 40-line handler; lines 10 and 30 changed. Two windows, a gap
            // marker between them, and the far-away middle line dropped.
            const make = (l10: string, l30: string) => Array.from({ length: 40 }, (_, i) => {
                if (i === 9) return l10;
                if (i === 29) return l30;
                return `line${i + 1}`;
            }).join('\n');
            const baseline = make('line10', 'line30');
            const working = make('line10_CHANGED', 'line30_CHANGED_forEach_async');
            const span = { start: 0, end: working.length };
            const out = windowChangedSource(working, baseline, span, {
                contextLines: 2, maxSourceLines: 20, maxMessages: 40, maxFlowNodes: 40, maxCallsInto: 24, maxSiblings: 8,
            })!;
            expect(out).toContain('10: line10_CHANGED');
            expect(out).toContain('30: line30_CHANGED_forEach_async');
            expect(out).toContain('8: line8');   // -2 context of first change
            expect(out).toContain('32: line32'); // +2 context of second change
            expect(out).not.toContain('line20'); // middle, far from both changes → dropped
            expect(out).toMatch(/… \d+ unchanged …/); // gap between the two windows
        });

        it('windowChangedSource returns the whole (capped) handler when it is small', () => {
            const working = 'function f() {\n  return 1;\n}';
            const out = windowChangedSource(working, undefined, { start: 0, end: working.length })!;
            expect(out).toContain('1: function f() {');
            expect(out).toContain('2:   return 1;');
        });

        it('getEntryPointPack lean: windows handlerSource + caps siblings while keeping modified graph items', () => {
            const snap = buildSnapshot();
            const api = Object.values(snap.apiIndex!)[0];
            // 30-line handler body for this entry; baseline differs only on line 15.
            const handler = Array.from({ length: 30 }, (_, i) => (i === 14 ? 'doDangerousThing(async () => {})' : `stmt${i + 1}();`)).join('\n');
            const baselineHandler = handler.replace('doDangerousThing(async () => {})', 'stmt15();');
            api.anchor = { filePath: api.filePath, span: { start: 0, end: handler.length } };
            const working = (fp: string) => (fp === api.filePath ? handler : undefined);
            const baseline = (fp: string) => (fp === api.filePath ? baselineHandler : undefined);

            const pack = getEntryPointPack(snap, api.method, api.route, {
                workspaceFileContent: working,
                baselineFileContent: baseline,
                lean: { contextLines: 2, maxSourceLines: 10, maxMessages: 40, maxFlowNodes: 40, maxCallsInto: 24, maxSiblings: 8 },
            })!;
            // Source is present, windowed to the changed line, and does NOT dump all 30 lines.
            expect(pack.handlerSource).toBeDefined();
            expect(pack.handlerSource).toContain('15: doDangerousThing(async () => {})');
            expect(pack.handlerSource).not.toContain('stmt1();'); // far unchanged line trimmed
            expect(pack.siblings.length).toBeLessThanOrEqual(8);
        });

        it('getEntryPointPack without lean still returns the whole handler slice (back-compat)', () => {
            const snap = buildSnapshot();
            const api = Object.values(snap.apiIndex!)[0];
            const handler = 'function whole() {\n  return everything();\n}';
            api.anchor = { filePath: api.filePath, span: { start: 0, end: handler.length } };
            const pack = getEntryPointPack(snap, api.method, api.route, {
                workspaceFileContent: (fp) => (fp === api.filePath ? handler : undefined),
            })!;
            expect(pack.handlerSource).toBe(handler); // unchanged, no line numbers
        });
    });

    // ─── #865 — downstream participant source (scoped to the called functions) ──
    describe('#865 participant sources (called-function bodies, not whole files)', () => {
        // The GET /articles sequence calls getArticles() in article.service.ts.
        function snapWithCallee() {
            const snap = buildSnapshot();
            const serviceSrc = 'export function getArticles(q) {\n  return db.find(q); // returns ALL when q is undefined\n}\n';
            (snap.files!['src/article.service.ts'].symbols.functions as any) = [
                { name: 'getArticles', kind: 'function', span: { start: 0, end: serviceSrc.indexOf('}\n') + 1 }, signature: '', bodyText: '', stableKey: 'function:getArticles' },
            ];
            const api = snap.apiIndex!['GET:/articles::src/article.controller.ts::anonymous@GET:/articles'];
            api.anchor = { filePath: api.filePath, span: { start: 0, end: 10 } };
            const content = (fp: string) =>
                fp === 'src/article.service.ts' ? serviceSrc
                    : fp === api.filePath ? 'function h(){ return getArticles(); }'
                        : undefined;
            return { snap, content };
        }

        it('lean pack includes the called callee body from the participant file', () => {
            const { snap, content } = snapWithCallee();
            const pack = getEntryPointPack(snap, 'GET', '/articles', { workspaceFileContent: content, lean: true })!;
            expect(pack.participantSources).toBeDefined();
            const ps = pack.participantSources!.find((p) => p.functionName === 'getArticles')!;
            expect(ps, 'the called downstream function is sourced').toBeDefined();
            expect(ps.filePath).toBe('src/article.service.ts');
            expect(ps.participant).toBe('article.service.ts');
            // The callee BODY is included so a cross-file bug can be quoted...
            expect(ps.source).toContain('return db.find(q)');
            // ...but it's the function slice, not the trailing whole-file noise.
            expect(ps.source).not.toContain('export function getArticlesElsewhere');
        });

        it('is lean-only and needs a content resolver (no source channel otherwise)', () => {
            const { snap, content } = snapWithCallee();
            // No lean → no participantSources (the full-pack path is unchanged).
            expect(getEntryPointPack(snap, 'GET', '/articles', { workspaceFileContent: content })!.participantSources).toBeUndefined();
            // Lean but no resolver → nothing to slice.
            expect(getEntryPointPack(snap, 'GET', '/articles', { lean: true })!.participantSources).toBeUndefined();
        });

        it('caps the number of sourced callees (maxParticipantSources)', () => {
            const { snap, content } = snapWithCallee();
            const pack = getEntryPointPack(snap, 'GET', '/articles', {
                workspaceFileContent: content,
                lean: { contextLines: 2, maxSourceLines: 10, maxMessages: 40, maxFlowNodes: 40, maxCallsInto: 24, maxSiblings: 8, maxParticipantSources: 0, maxParticipantSourceLines: 40 },
            })!;
            expect(pack.participantSources).toBeUndefined(); // cap 0 → none
        });
    });
});
