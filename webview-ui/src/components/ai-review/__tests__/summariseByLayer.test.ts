/**
 * summariseByLayer tests (#538)
 */

import { describe, it, expect } from 'vitest';
import { summariseByLayer } from '../summariseByLayer';
import type { AiReviewFinding } from '../types';

function mkF(overrides: Partial<AiReviewFinding> = {}): AiReviewFinding {
    return {
        id: `f_${Math.random().toString(36).slice(2, 8)}`,
        entryPointId: 'GET:/x',
        bindings: [{ graphId: 'file:src/x.ts', targetId: 'x', targetType: 'node', layer: 'file' }],
        severity: 'warning',
        category: 'code-quality',
        title: 'Some issue',
        body: 'b',
        status: 'open',
        model: 't',
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T00:00:00Z',
        ...overrides,
    };
}

describe('summariseByLayer', () => {
    it('returns empty string when no findings', () => {
        expect(summariseByLayer([])).toBe('');
    });

    it('returns empty string when all findings are non-open', () => {
        const f = mkF({ status: 'resolved' });
        expect(summariseByLayer([f])).toBe('');
    });

    it('walks layers top-down (microservice → features → … → flow)', () => {
        const findings = [
            mkF({ severity: 'error', title: 'auth bypass', bindings: [{ graphId: 'microservice:workspace', targetId: 'svc', targetType: 'node', layer: 'microservice' }] }),
            mkF({ severity: 'warning', title: 'missing csrf', bindings: [{ graphId: 'feature:cluster:auth', targetId: 'auth', targetType: 'node', layer: 'feature' }] }),
            mkF({ severity: 'info', title: 'long fn', bindings: [{ graphId: 'flow:src/x.ts:y', targetId: 'y', targetType: 'node', layer: 'flow' }] }),
        ];
        const out = summariseByLayer(findings);
        const idxMicro = out.indexOf('Microservice');
        const idxFeatures = out.indexOf('Features');
        const idxFlow = out.indexOf('Function flows');
        expect(idxMicro).toBeGreaterThanOrEqual(0);
        expect(idxFeatures).toBeGreaterThan(idxMicro);
        expect(idxFlow).toBeGreaterThan(idxFeatures);
    });

    it('emits multi-line output with section headers + indented bullets', () => {
        const out = summariseByLayer([
            mkF({ severity: 'error', title: 'auth bypass',
                bindings: [
                    { graphId: 'microservice:workspace', targetId: 'svc', targetType: 'node', layer: 'microservice' },
                    { graphId: 'feature:cluster:auth', targetId: 'auth', targetType: 'node', layer: 'feature' },
                ] }),
        ]);
        // Has line breaks
        expect(out.split('\n').length).toBeGreaterThan(3);
        // Has indented bullets (two-space prefix)
        expect(out).toMatch(/\n  • /);
    });

    it('opens with Overall + Interpretation lines (#538 inference)', () => {
        const out = summariseByLayer([
            mkF({ severity: 'error', title: 'Missing authentication on POST /admin', body: 'auth required',
                bindings: [{ graphId: 'sequence:src/a.ts:h', targetId: 'h', targetType: 'node', layer: 'sequence' }] }),
            mkF({ severity: 'error', title: 'Hardcoded JWT secret fallback', body: 'jwt secret',
                bindings: [{ graphId: 'sequence:src/a.ts:h2', targetId: 'h2', targetType: 'node', layer: 'sequence' }] }),
        ]);
        expect(out).toMatch(/^Overall:/);
        expect(out).toContain('Interpretation:');
    });

    it('stays under 500 words', () => {
        const findings = Array.from({ length: 80 }, (_, i) =>
            mkF({
                id: `f${i}`, severity: i % 3 === 0 ? 'error' : 'warning',
                entryPointId: `GET:/api/route${i}`,
                title: `Issue number ${i} with quite a long verbose title that talks about many things`,
                bindings: [
                    { graphId: `file:src/path/to/file${i}.ts`, targetId: `x${i}`, targetType: 'node', layer: 'file' },
                    { graphId: `flow:src/path/to/file${i}.ts:fn${i}`, targetId: `fn${i}`, targetType: 'node', layer: 'flow' },
                ],
            }),
        );
        const out = summariseByLayer(findings);
        const words = out.split(/\s+/).filter(Boolean);
        expect(words.length).toBeLessThanOrEqual(501);
    });

    it('names specific clusters / files / functions', () => {
        const findings = [
            mkF({ severity: 'error', title: 'Auth bypass on POST /users',
                bindings: [{ graphId: 'feature:cluster:auth', targetId: 'auth', targetType: 'node', layer: 'feature' }] }),
            mkF({ severity: 'warning', title: 'N+1 query',
                bindings: [{ graphId: 'feature:cluster:articles', targetId: 'art', targetType: 'node', layer: 'feature' }] }),
            mkF({ severity: 'info', title: 'long fn',
                bindings: [{ graphId: 'flow:src/auth.ts:login', targetId: 'login', targetType: 'node', layer: 'flow' }] }),
        ];
        const out = summariseByLayer(findings);
        expect(out).toContain('the auth cluster');
        expect(out).toContain('the articles cluster');
        expect(out).toContain('login in auth.ts');
    });

    it('names sequence routes via entryPointId rather than the raw graphId', () => {
        const out = summariseByLayer([
            mkF({
                severity: 'error',
                entryPointId: 'DELETE:/api/admin/:id',
                title: 'Missing auth',
                bindings: [{ graphId: 'sequence:src/admin.ts:anonymous@DELETE:/api/admin/:id', targetId: 'h', targetType: 'node', layer: 'sequence' }],
            }),
        ]);
        expect(out).toContain('DELETE /api/admin/:id');
    });

    it('emits a Top concerns section that lists highest-severity findings first', () => {
        const findings = [
            mkF({ id: 'a', severity: 'info', title: 'cosmetic' }),
            mkF({ id: 'b', severity: 'error', title: 'CRITICAL leak' }),
            mkF({ id: 'c', severity: 'warning', title: 'mediocre issue' }),
        ];
        const out = summariseByLayer(findings);
        expect(out).toContain('Top concerns');
        const idxCritical = out.indexOf('CRITICAL leak');
        const idxCosmetic = out.indexOf('cosmetic');
        expect(idxCritical).toBeGreaterThan(0);
        expect(idxCritical).toBeLessThan(idxCosmetic);
    });

    // ── Blast radius (theme × cluster cross-tab) ────────────────────────
    describe('Blast radius section (issue type → where it lands)', () => {
        it('emits the section header + theme × cluster bullets when findings span multiple clusters', () => {
            const findings = [
                // Two auth findings on cluster:profile
                mkF({
                    id: 'a1', severity: 'error', title: 'Missing authentication on POST profile',
                    entryPointId: 'POST:/api/profiles/:username/follow',
                    bindings: [{ graphId: 'feature:cluster:profile', targetId: 't', targetType: 'node', layer: 'feature' }],
                }),
                mkF({
                    id: 'a2', severity: 'error', title: 'auth bypass risk on DELETE follow',
                    entryPointId: 'DELETE:/api/profiles/:username/follow',
                    bindings: [{ graphId: 'feature:cluster:profile', targetId: 't', targetType: 'node', layer: 'feature' }],
                }),
                // One auth finding on cluster:article
                mkF({
                    id: 'a3', severity: 'warning', title: 'Missing auth middleware on PUT article',
                    entryPointId: 'PUT:/api/articles/:slug',
                    bindings: [{ graphId: 'feature:cluster:article', targetId: 't', targetType: 'node', layer: 'feature' }],
                }),
                // Two performance findings on cluster:article
                mkF({
                    id: 'p1', severity: 'warning', title: 'N+1 query pattern in comments',
                    entryPointId: 'GET:/api/articles/:slug/comments',
                    bindings: [{ graphId: 'feature:cluster:article', targetId: 't', targetType: 'node', layer: 'feature' }],
                }),
                mkF({
                    id: 'p2', severity: 'info', title: 'N+1 in feed query',
                    entryPointId: 'GET:/api/articles/feed',
                    bindings: [{ graphId: 'feature:cluster:article', targetId: 't', targetType: 'node', layer: 'feature' }],
                }),
            ];
            const out = summariseByLayer(findings);
            expect(out).toContain('Blast radius');
            // Theme rows render with totals.
            expect(out).toMatch(/Auth & authorization gaps \(3 findings\)/);
            expect(out).toMatch(/Performance — query patterns \(2 findings\)/);
            // Auth distribution: profile (2) before article (1).
            const profileLine = out.match(/• profile cluster: 2/);
            const articleAuthLine = out.match(/• article cluster: 1/);
            expect(profileLine).toBeTruthy();
            expect(articleAuthLine).toBeTruthy();
            // The route examples are appended after the count.
            expect(out).toContain('POST /api/profiles/:username/follow');
        });

        it('falls back to file basename when no cluster binding is present', () => {
            const findings = [
                mkF({
                    id: 'f1', severity: 'error', title: 'auth bypass in handler',
                    entryPointId: 'POST:/x',
                    bindings: [{ graphId: 'file:src/app/handlers/orphan.ts', targetId: 't', targetType: 'node', layer: 'file' }],
                }),
            ];
            const out = summariseByLayer(findings);
            expect(out).toContain('Blast radius');
            expect(out).toContain('orphan.ts');
        });

        it('skips the section entirely when no theme matches', () => {
            const findings = [
                mkF({
                    id: 'g1', severity: 'info', title: 'just a stylistic nit',
                    body: 'Consider renaming this variable to be more descriptive.',
                    category: 'code-quality',
                    bindings: [{ graphId: 'file:src/x.ts', targetId: 't', targetType: 'node', layer: 'file' }],
                }),
            ];
            const out = summariseByLayer(findings);
            // Theme keywords don't match → no Blast Radius section.
            expect(out).not.toContain('Blast radius');
        });

        it('orders themes by total finding count descending', () => {
            const findings = [
                // 1 auth
                mkF({ id: 'a1', severity: 'error', title: 'auth bypass', bindings: [{ graphId: 'feature:cluster:auth', targetId: 't', targetType: 'node', layer: 'feature' }] }),
                // 3 perf
                mkF({ id: 'p1', severity: 'warning', title: 'N+1 query in users list', bindings: [{ graphId: 'feature:cluster:users', targetId: 't', targetType: 'node', layer: 'feature' }] }),
                mkF({ id: 'p2', severity: 'warning', title: 'N+1 loop query in feed', bindings: [{ graphId: 'feature:cluster:articles', targetId: 't', targetType: 'node', layer: 'feature' }] }),
                mkF({ id: 'p3', severity: 'info', title: 'slow query in dashboard', bindings: [{ graphId: 'feature:cluster:dashboard', targetId: 't', targetType: 'node', layer: 'feature' }] }),
            ];
            const out = summariseByLayer(findings);
            const idxPerf = out.indexOf('Performance — query patterns (3 findings)');
            const idxAuth = out.indexOf('Auth & authorization gaps (1 finding)');
            expect(idxPerf).toBeGreaterThan(0);
            expect(idxAuth).toBeGreaterThan(0);
            expect(idxPerf).toBeLessThan(idxAuth); // higher count comes first
        });
    });
});
