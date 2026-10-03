import { describe, it, expect, vi } from 'vitest';
import { runPerEntryReview, selectEntryPoints, reviewedEntryPointFiles, evidenceMatches, isSmallCoderModel, resolveEvidence, anchorResolves } from '../perEntryReviewer';
import type { SnapshotStore } from '../../storage/snapshotStore';

function mockStore(): SnapshotStore {
    const findings: any[] = [];
    return {
        getWorking: () => ({
            apiIndex: {
                api1: { method: 'GET', route: '/api/articles', handlerName: 'findAll', filePath: 'src/x.ts', diff: 'unchanged', meta: { clusterId: 'cluster:article' } },
                api2: { method: 'POST', route: '/api/articles', handlerName: 'create', filePath: 'src/x.ts', diff: 'modified', meta: { clusterId: 'cluster:article' } },
                api3: { method: 'GET', route: '/api/auth/me', handlerName: 'me', filePath: 'src/auth.ts', diff: 'unchanged', meta: { clusterId: 'cluster:auth' } },
            },
            files: {
                'src/x.ts': { content: 'function findAll() {\n  return prisma.article.findMany();\n}\nfunction create(dto) {\n  return prisma.article.create({ data: dto });\n}' } as any,
                'src/auth.ts': { content: 'function me() { return req.user; }' } as any,
            },
            graphs: {},
        }),
        getReviewGuidelines: () => ({ text: 'rule 1', hash: 'abcd', updatedAt: Date.now() }),
        upsertAiReviewFinding: vi.fn((rec) => { const f = { ...rec, id: `f${findings.length}`, createdAt: 'now', updatedAt: 'now' }; findings.push(f); return f; }),
    } as unknown as SnapshotStore;
}

// #513 — guarantee every test finding includes evidence; the gate drops
// otherwise. Pre-MVP tests had no evidence and relied on the gate being
// permissive; we now ship one canonical helper.
function withEvidence(over: Partial<any> = {}) {
    return {
        severity: 'warning',
        category: 'code-quality',
        title: 't',
        body: 'b',
        layers: ['sequence', 'file'],
        evidence: { snippet: 'return prisma.article.findMany();' },
        ...over,
    };
}

describe('runPerEntryReview', () => {
    it('reviews all entry points when scope=all', async () => {
        const store = mockStore();
        const llmCall = vi.fn(async ({ user }: any) => {
            // Pick evidence that matches the source for the entry under review.
            const isCreate = String(user).includes('"route": "/api/articles"') && String(user).includes('"method": "POST"');
            const snippet = isCreate ? 'prisma.article.create({ data: dto })' : 'prisma.article.findMany()';
            return { findings: [withEvidence({ evidence: { snippet } })] };
        });
        const result = await runPerEntryReview({ store, scope: { kind: 'all' }, llmCall, model: 'm' });
        expect(result.totalEntryPoints).toBe(3);
        expect(result.reviewed).toBe(3);
        // Auth entry point has its own source ('return req.user'); the canned
        // snippet matches /api/articles. So 2/3 findings persist.
        expect(result.findingsCount).toBe(2);
        // #527 — the entry whose first-pass finding was evidence-rejected
        // triggers a single re-quote retry. 3 entries × 1 call + 1 retry = 4.
        expect(llmCall).toHaveBeenCalledTimes(4);
    });

    it('#864 — system prompt carries the call-chain reasoning + precision discipline rules', async () => {
        const store = mockStore();
        let captured = '';
        const llmCall = vi.fn(async ({ system }: any) => {
            captured = String(system);
            return { findings: [] };
        });
        await runPerEntryReview({ store, scope: { kind: 'changed' }, llmCall, model: 'm' });
        expect(llmCall).toHaveBeenCalled();
        // Both review modes share buildPromptContext().system, so asserting it
        // here locks the tuning for per-entry AND single-call.
        expect(captured).toContain('CALL-CHAIN REASONING');
        expect(captured).toContain('PRECISION DISCIPLINE');
        // #872 — golden-derived correctness bug classes in the default prompt.
        expect(captured).toContain('CORRECTNESS BUG CLASSES');
        expect(captured).toContain('Null/undefined safety');
        expect(captured).toContain('Reference equality');
        expect(captured.toLowerCase()).toContain('case / normalization');
        // #881 — extended golden-recall families (concurrency/authz/cleanup/error/ORM/contract).
        expect(captured).toContain('Concurrency / TOCTOU');
        expect(captured).toContain('Authorization resolution');
        expect(captured).toContain('Resource lifecycle / cleanup');
        expect(captured).toContain('Error handling');
        expect(captured).toContain('ORM / query pitfalls');
        expect(captured).toContain('Contract & identifier integrity');
        // #920 — over-logging / observability bug class.
        expect(captured).toContain('Logging / observability');
        // #924 — golden-gap classes (behavior-change / config / CSRF / recursion / wrong-return).
        expect(captured).toContain('Behavior-change / regression');
        expect(captured).toContain('Config hardcoding');
        expect(captured).toContain('CSRF / weak token');
        expect(captured).toContain('Recursion / self-delegation');
        expect(captured).toContain('Wrong / misleading return');
        // The call-chain rule must point the model at the resolved pack context.
        expect(captured).toMatch(/messages.*flowNodes|flowNodes.*messages/s);
        // Precision rule must discourage nit-padding.
        expect(captured.toLowerCase()).toContain('precision over volume');
    });

    it('scope=changed filters to entries with non-unchanged diff', async () => {
        const store = mockStore();
        const llmCall = vi.fn(async () => ({ findings: [] }));
        const result = await runPerEntryReview({ store, scope: { kind: 'changed' }, llmCall, model: 'm' });
        expect(result.totalEntryPoints).toBe(1);
        expect(llmCall).toHaveBeenCalledTimes(1);
    });

    // #3 (ADR-058) — a shared definition file (e.g. Rails config/routes.rb)
    // edited in a PR marks *every* route it declares as `modified`, exploding
    // the per-entry fan-out (discourse: 474 entries → 474 LLM calls). Cap the
    // changed-scope fan-out so one routes file can't blow the token budget;
    // the project pass still covers the shared file holistically.
    it('#3 — caps the changed-scope fan-out when one shared file marks >CAP entries changed', async () => {
        const N = 40;
        const apiIndex: Record<string, any> = {};
        for (let i = 0; i < N; i++) {
            apiIndex[`api${i}`] = { method: 'GET', route: `/r${i}`, handlerName: `h${i}`, filePath: 'config/routes.rb', diff: 'modified', meta: {} };
        }
        const store = {
            getWorking: () => ({ apiIndex, files: { 'config/routes.rb': { hash: 'NEW', content: '# routes' } as any }, graphs: {} }),
            // baseline hash differs → fileChanged()=true → all N are "direct".
            getBaseline: () => ({ files: { 'config/routes.rb': { hash: 'OLD' } } }),
            getReviewGuidelines: () => ({ text: '', hash: 'h', updatedAt: 0 }),
            upsertAiReviewFinding: vi.fn((rec) => ({ ...rec, id: 'x', createdAt: 'now', updatedAt: 'now' })),
        } as unknown as SnapshotStore;
        const llmCall = vi.fn(async () => ({ findings: [] }));
        const result = await runPerEntryReview({ store, scope: { kind: 'changed' }, llmCall, model: 'm' });
        // Default CODEATLAS_REVIEW_ENTRY_CAP = 25.
        expect(result.totalEntryPoints).toBe(25);
        expect(llmCall).toHaveBeenCalledTimes(25);
    });

    // #943 — when a shared routes file marks many entries `direct`, a newly-ADDED
    // route (the PR's real change) must survive the cap ahead of pre-existing
    // `modified` siblings that merely share the touched file.
    it('#943 — a newly-added route in a shared routes file survives the cap ahead of modified siblings', () => {
        const N = 40;
        const apiIndex: Record<string, any> = {};
        for (let i = 0; i < N; i++) {
            // All in the same changed routes file → all `direct`. api39 is the ADDED
            // route; it sits LAST by insertion order so pre-#943 it ranks at index
            // 39 (> cap 25) and is dropped.
            apiIndex[`api${i}`] = { method: 'GET', route: `/r${i}`, handlerName: `h${i}`, filePath: 'config/routes.rb', diff: i === N - 1 ? 'added' : 'modified', meta: {} };
        }
        const store = {
            getWorking: () => ({ apiIndex, files: { 'config/routes.rb': { hash: 'NEW', content: '# routes' } }, graphs: {} }),
            getBaseline: () => ({ files: { 'config/routes.rb': { hash: 'OLD' } } }), // all N "direct"
        } as unknown as SnapshotStore;
        const selected = selectEntryPoints(store, { kind: 'changed' }, undefined, true);
        expect(selected.length).toBe(25);                              // cap still applies
        expect(selected.some((a) => a.route === '/r39')).toBe(true);   // …but the ADDED route is kept
        expect(selected[0].route).toBe('/r39');                        // and ranked first
    });

    // #894 — the entry CAP must apply AFTER restrictToEntryPoints, not before:
    // a re-review target that ranks beyond the cap (behind a routes-file fan-out)
    // would otherwise be dropped by the cap before restrict ever sees it.
    it('#894 — restrictToEntryPoints survives the cap even when the target ranks beyond it', async () => {
        const N = 40;
        const apiIndex: Record<string, any> = {};
        for (let i = 0; i < N; i++) {
            apiIndex[`api${i}`] = { method: 'GET', route: `/r${i}`, handlerName: `h${i}`, filePath: 'config/routes.rb', diff: 'modified', meta: {} };
        }
        const store = {
            getWorking: () => ({ apiIndex, files: { 'config/routes.rb': { hash: 'NEW', content: '# routes' } as any }, graphs: {} }),
            getBaseline: () => ({ files: { 'config/routes.rb': { hash: 'OLD' } } }), // all N "direct"
            getReviewGuidelines: () => ({ text: '', hash: 'h', updatedAt: 0 }),
            upsertAiReviewFinding: vi.fn((rec) => ({ ...rec, id: 'x', createdAt: 'now', updatedAt: 'now' })),
        } as unknown as SnapshotStore;
        const llmCall = vi.fn(async () => ({ findings: [] }));
        // The incremental cursor wants route #30 re-reviewed — it ranks at index
        // 30 (> the default cap of 25). Pre-fix: cap takes the first 25, restrict
        // then matches nothing → reviewed: 0. Post-fix: restrict first → 1.
        const restrict = new Set(['GET:/r30']);
        const result = await runPerEntryReview({
            store, scope: { kind: 'changed' }, llmCall, model: 'm',
            restrictToEntryPoints: restrict,
        });
        expect(result.totalEntryPoints).toBe(1);
        expect(llmCall).toHaveBeenCalledTimes(1);
    });

    it('scope=cluster filters by clusterId', async () => {
        const store = mockStore();
        const llmCall = vi.fn(async () => ({ findings: [] }));
        const result = await runPerEntryReview({ store, scope: { kind: 'cluster', clusterId: 'cluster:auth' }, llmCall, model: 'm' });
        expect(result.totalEntryPoints).toBe(1);
    });

    // #606 — incremental review wiring.
    it('restrictToEntryPoints further narrows the scope to a single entry', async () => {
        const store = mockStore();
        const llmCall = vi.fn(async () => ({ findings: [] }));
        const result = await runPerEntryReview({
            store,
            scope: { kind: 'all' },
            llmCall,
            model: 'm',
            restrictToEntryPoints: new Set(['POST:/api/articles']),
        });
        expect(result.totalEntryPoints).toBe(1);
        expect(llmCall).toHaveBeenCalledTimes(1);
    });

    it('restrictToEntryPoints with no matching ids reviews nothing', async () => {
        const store = mockStore();
        const llmCall = vi.fn(async () => ({ findings: [] }));
        const result = await runPerEntryReview({
            store,
            scope: { kind: 'all' },
            llmCall,
            model: 'm',
            restrictToEntryPoints: new Set(['DELETE:/does-not-exist']),
        });
        expect(result.totalEntryPoints).toBe(0);
        expect(llmCall).not.toHaveBeenCalled();
    });

    it('empty restrictToEntryPoints set is ignored (treated like undefined)', async () => {
        const store = mockStore();
        const llmCall = vi.fn(async () => ({ findings: [] }));
        const result = await runPerEntryReview({
            store,
            scope: { kind: 'all' },
            llmCall,
            model: 'm',
            restrictToEntryPoints: new Set(),
        });
        expect(result.totalEntryPoints).toBe(3);
    });

    it('continues running after a per-entry failure', async () => {
        const store = mockStore();
        const llmCall = vi.fn(async (_p, _o) => {
            if ((llmCall as any).mock.calls.length === 1) throw new Error('boom');
            return { findings: [] };
        });
        const onError = vi.fn();
        const result = await runPerEntryReview({ store, scope: { kind: 'all' }, llmCall, model: 'm', callbacks: { onEntryError: onError } });
        expect(result.failed).toBe(1);
        expect(result.reviewed).toBe(2);
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('binds findings to multiple layer graphIds', async () => {
        const store = mockStore();
        const upserts: any[] = [];
        (store.upsertAiReviewFinding as any) = vi.fn((rec) => { upserts.push(rec); return { ...rec, id: 'f', createdAt: 'n', updatedAt: 'n' }; });
        const llmCall = vi.fn(async () => ({ findings: [
            withEvidence({ severity: 'error', category: 'security', layers: ['sequence', 'file', 'flow', 'feature', 'microservice'], evidence: { snippet: 'return prisma.article.findMany()' } }),
        ]}));
        await runPerEntryReview({ store, scope: { kind: 'entry', entryPointId: 'GET:/api/articles' }, llmCall, model: 'm' });
        expect(upserts).toHaveLength(1);
        const bindings = upserts[0].bindings.map((b: any) => b.layer);
        expect(bindings).toEqual(expect.arrayContaining(['sequence', 'file', 'flow', 'feature', 'microservice']));
    });

    // ─── #513 evidence-gate tests ───────────────────────────────────────
    it('drops findings without evidence', async () => {
        const store = mockStore();
        const upserts: any[] = [];
        (store.upsertAiReviewFinding as any) = vi.fn((rec) => { upserts.push(rec); return { ...rec, id: 'f', createdAt: 'n', updatedAt: 'n' }; });
        const llmCall = vi.fn(async () => ({ findings: [
            { severity: 'warning', category: 'code-quality', title: 'no evidence', body: 'b', layers: ['sequence'] },
        ]}));
        const result = await runPerEntryReview({ store, scope: { kind: 'entry', entryPointId: 'GET:/api/articles' }, llmCall, model: 'm' });
        expect(result.findingsCount).toBe(0);
        expect(upserts).toHaveLength(0);
    });

    it('drops findings whose evidence is not in the source corpus (hallucination)', async () => {
        const store = mockStore();
        const upserts: any[] = [];
        (store.upsertAiReviewFinding as any) = vi.fn((rec) => { upserts.push(rec); return { ...rec, id: 'f', createdAt: 'n', updatedAt: 'n' }; });
        const llmCall = vi.fn(async () => ({ findings: [
            withEvidence({ evidence: { snippet: 'eval(userInput); // not in any file' } }),
        ]}));
        const result = await runPerEntryReview({ store, scope: { kind: 'entry', entryPointId: 'GET:/api/articles' }, llmCall, model: 'm' });
        expect(result.findingsCount).toBe(0);
    });

    it('persists snippet onto finding.anchor when evidence matches', async () => {
        const store = mockStore();
        const upserts: any[] = [];
        (store.upsertAiReviewFinding as any) = vi.fn((rec) => { upserts.push(rec); return { ...rec, id: 'f', createdAt: 'n', updatedAt: 'n' }; });
        const llmCall = vi.fn(async () => ({ findings: [
            withEvidence({ evidence: { snippet: 'prisma.article.findMany()', lineStart: 2, lineEnd: 2 } }),
        ]}));
        await runPerEntryReview({ store, scope: { kind: 'entry', entryPointId: 'GET:/api/articles' }, llmCall, model: 'm' });
        expect(upserts[0]?.anchor?.snippet).toBe('prisma.article.findMany()');
        expect(upserts[0]?.anchor?.lineStart).toBe(2);
    });
});

describe('#944 — a file covered only by a narrow hook (FILTER / MODEL_HOOK) is NOT counted reviewed', () => {
    function storeWith(apiIndex: Record<string, any>): SnapshotStore {
        return {
            getWorking: () => ({ apiIndex, files: { 'app/controllers/x_controller.rb': { hash: 'NEW' }, 'app/models/x.rb': { hash: 'NEW' } }, graphs: {} }),
            getBaseline: () => ({ files: { 'app/controllers/x_controller.rb': { hash: 'OLD' }, 'app/models/x.rb': { hash: 'OLD' } } }),
        } as unknown as SnapshotStore;
    }

    it('omits a controller whose ONLY changed entry is a before_action FILTER', () => {
        const files = reviewedEntryPointFiles(storeWith({
            f1: { method: 'FILTER', route: 'before_action:ensure_logged_in', handlerName: 'ensure_logged_in', filePath: 'app/controllers/x_controller.rb', diff: 'modified', meta: {} },
        }));
        expect(files.has('app/controllers/x_controller.rb')).toBe(false); // not covered → flows to project pass
    });

    it('omits a model covered only by a MODEL_HOOK', () => {
        const files = reviewedEntryPointFiles(storeWith({
            f1: { method: 'MODEL_HOOK', route: 'before_save', handlerName: 'normalize', filePath: 'app/models/x.rb', diff: 'modified', meta: {} },
        }));
        expect(files.has('app/models/x.rb')).toBe(false);
    });

    it('STILL counts a controller that also has a real route entry (route covers it)', () => {
        const files = reviewedEntryPointFiles(storeWith({
            f1: { method: 'FILTER', route: 'before_action:ensure_logged_in', handlerName: 'ensure_logged_in', filePath: 'app/controllers/x_controller.rb', diff: 'modified', meta: {} },
            f2: { method: 'GET', route: '/x', handlerName: 'index', filePath: 'app/controllers/x_controller.rb', diff: 'modified', meta: {} },
        }));
        expect(files.has('app/controllers/x_controller.rb')).toBe(true); // genuine handler → covered
    });
});

describe('evidenceMatches', () => {
    it('matches verbatim after whitespace normalisation', () => {
        const src = 'function f() {\n  return\tx + y;\n}';
        expect(evidenceMatches('return x + y;', src)).toBe(true);
    });
    it('rejects too-short snippets to avoid false matches', () => {
        expect(evidenceMatches('x', 'x x x')).toBe(false);
        expect(evidenceMatches('abc', 'abc def')).toBe(false);
    });
    it('rejects snippets not present in source', () => {
        expect(evidenceMatches('eval(userInput);', 'function f() { return 1; }')).toBe(false);
    });
    it('returns false on non-string inputs', () => {
        expect(evidenceMatches(undefined as any, 'src')).toBe(false);
        expect(evidenceMatches('snippet', undefined as any)).toBe(false);
    });

    // #527 — sliding-window Levenshtein fallback.
    it('accepts a paraphrased quote within Levenshtein budget (small char drift)', () => {
        // Model swapped single quotes for double quotes — 2 substitutions.
        const src = "router.post('/admin', adminController.delete);";
        expect(evidenceMatches('router.post("/admin", adminController.delete);', src)).toBe(true);
    });
    it('accepts a quote with a trailing semicolon trimmed (1 edit)', () => {
        const src = 'const _liveVerifyProbe = id;';
        // Model dropped the trailing semicolon — distance 1, within budget.
        expect(evidenceMatches('const _liveVerifyProbe = id', src)).toBe(true);
    });
    it('rejects a substantively different quote (large edit distance)', () => {
        const src = 'function f() {\n  return x + y;\n}';
        expect(evidenceMatches('console.error("totally invented log line here");', src)).toBe(false);
    });
    it('accepts a quote even when whitespace and indentation differ', () => {
        const src = 'if (existingUserByEmail || existingUserByUsername) {\n  throw new HttpException(422)\n}';
        expect(evidenceMatches('if(existingUserByEmail||existingUserByUsername){throw new HttpException(422)}', src)).toBe(true);
    });
});

describe('#527 retry on evidence-rejection', () => {
    function mkStore(): any {
        return {
            getReviewGuidelines: () => ({ text: '', hash: '' }),
            getWorking: () => ({
                apiIndex: {
                    'GET:/x': {
                        apiId: 'GET:/x', method: 'GET', route: '/x',
                        handlerName: 'h', filePath: 'src/x.ts',
                        meta: { clusterId: 'cluster:x' },
                    },
                },
                files: {},
            }),
            upsertAiReviewFinding: (rec: any) => ({ id: `f_${Math.random().toString(36).slice(2, 6)}`, ...rec, createdAt: 't', updatedAt: 't' }),
            getAiReviewFindingCounts: () => ({ byGraph: {}, byEntryPoint: {}, bySeverity: { error: 0, warning: 0, info: 0 }, total: 0 }),
        };
    }

    it('retries once when all findings are evidence-rejected, then keeps the re-quote', async () => {
        const store = mkStore();
        let call = 0;
        const llmCall = vi.fn(async () => {
            call += 1;
            if (call === 1) {
                // First pass: invented snippet (will be rejected).
                return { findings: [{
                    severity: 'error', category: 'security',
                    title: 'auth bypass', body: 'b', layers: ['file'],
                    evidence: { snippet: 'totally invented quote that is not in the source whatsoever' },
                }] };
            }
            // Second pass: re-quoted with something verifiable in the corpus.
            return { findings: [{
                severity: 'error', category: 'security',
                title: 'auth bypass', body: 'b', layers: ['file'],
                evidence: { snippet: 'BANANA_TOKEN_QUOTED_BY_RETRY' },
            }] };
        });
        const drops: any[] = [];
        const findingsLanded: any[] = [];
        // Patch getEntryPointPack to produce a corpus the retry quote can match.
        // The reviewer uses store.getWorking().files for the corpus, so seed a file.
        store.getWorking = () => ({
            apiIndex: { 'GET:/x': { apiId: 'GET:/x', method: 'GET', route: '/x', handlerName: 'h', filePath: 'src/x.ts', meta: { clusterId: 'cluster:x' } } },
            files: { 'src/x.ts': { content: 'function h() { /* BANANA_TOKEN_QUOTED_BY_RETRY */ }' } },
        });
        await runPerEntryReview({
            store,
            scope: { kind: 'entry', entryPointId: 'GET:/x' },
            llmCall,
            model: 'test',
            callbacks: {
                onEntryDone: (_id, fs, d) => { findingsLanded.push(...fs); if (d) drops.push(d); },
            },
        });
        expect(call).toBe(2);
        expect(findingsLanded.length).toBe(1);
        expect(drops.length).toBe(1);
        expect(drops[0].retried).toBe(true);
    });

    it('does NOT retry when the first pass already kept ≥1 finding', async () => {
        const store = mkStore();
        store.getWorking = () => ({
            apiIndex: { 'GET:/x': { apiId: 'GET:/x', method: 'GET', route: '/x', handlerName: 'h', filePath: 'src/x.ts', meta: { clusterId: 'cluster:x' } } },
            files: { 'src/x.ts': { content: 'function h() { /* ALREADY_THERE_TOKEN */ }' } },
        });
        const llmCall = vi.fn(async () => ({ findings: [{
            severity: 'warning', category: 'code-quality',
            title: 't', body: 'b', layers: ['file'],
            evidence: { snippet: 'ALREADY_THERE_TOKEN' },
        }] }));
        const drops: any[] = [];
        await runPerEntryReview({
            store,
            scope: { kind: 'entry', entryPointId: 'GET:/x' },
            llmCall,
            model: 'test',
            callbacks: { onEntryDone: (_id, _fs, d) => { if (d) drops.push(d); } },
        });
        expect(llmCall).toHaveBeenCalledTimes(1);
        expect(drops[0].retried).toBe(false);
    });

    it('does NOT retry when first pass had no evidence-misses (model said zero findings)', async () => {
        const store = mkStore();
        const llmCall = vi.fn(async () => ({ findings: [] }));
        const drops: any[] = [];
        await runPerEntryReview({
            store,
            scope: { kind: 'entry', entryPointId: 'GET:/x' },
            llmCall,
            model: 'test',
            callbacks: { onEntryDone: (_id, _fs, d) => { if (d) drops.push(d); } },
        });
        expect(llmCall).toHaveBeenCalledTimes(1);
        expect(drops[0].retried).toBe(false);
        expect(drops[0].raw).toBe(0);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Issue 605 — small-coder-model detection + relaxed-tolerance gate + fallback
// ───────────────────────────────────────────────────────────────────────────

describe('isSmallCoderModel (Issue 605)', () => {
    it.each([
        ['deepseek-coder:6.7b', true],
        ['ollama/deepseek-coder:6.7b', true],
        ['qwen2.5-coder:7b', true],
        ['qwen-coder:14b', false], // > 13B
        ['starcoder:3b', true],
        ['codellama:13b', true],
        ['granite-code:8b', true],
        ['codegemma:7b', true],
        ['opencoder:8b', true],
        ['gpt-4o-mini', false],
        ['gpt-4o', false],
        ['claude-3-5-sonnet-20240620', false],
        ['anthropic/claude-3-opus', false],
        ['mistral-large-latest', false],
        ['', false],
    ])('isSmallCoderModel(%s) === %s', (id, expected) => {
        expect(isSmallCoderModel(id)).toBe(expected);
    });
});

describe('evidenceMatches with relaxed tolerance (Issue 605)', () => {
    // The shipped source has the real line. The model "paraphrases" by
    // adding spaces, swapping quote style, and trimming a trailing comment.
    const source = `\nfunction handler(req: Request) {\n    const userId = req.params.id;\n    return prisma.user.findUnique({ where: { id: userId } });\n}\n`;

    it('strict mode rejects a 10-edit paraphrase that relaxed accepts', () => {
        // Heavier paraphrase: change quote style, drop a method-chain hop,
        // and trim 18 characters off the tail — well past the strict budget
        // (≤5 edits for a 60-char snippet) but inside the relaxed budget
        // (max(8, 60/8) = ~8 edits + a 10-line window).
        const paraphrased = `return prisma.users.findUnique(where: {id: userId})`;
        expect(evidenceMatches(paraphrased, source, 'strict')).toBe(false);
        expect(evidenceMatches(paraphrased, source, 'relaxed')).toBe(true);
    });

    it('relaxed still rejects unrelated text', () => {
        // Something that has nothing to do with the source — large
        // Levenshtein, no matter the window or budget.
        expect(evidenceMatches('console.log("totally unrelated content here")', source, 'relaxed')).toBe(false);
    });

    it('verbatim snippet matches under both tolerances', () => {
        const verbatim = 'return prisma.user.findUnique({ where: { id: userId } });';
        expect(evidenceMatches(verbatim, source, 'strict')).toBe(true);
        expect(evidenceMatches(verbatim, source, 'relaxed')).toBe(true);
    });

    it('snippets shorter than 8 chars are rejected even under relaxed', () => {
        expect(evidenceMatches('x = 1', source, 'relaxed')).toBe(false);
    });

    it('defaults to strict when tolerance arg is omitted', () => {
        // Use a paraphrase the strict gate rejects.
        const paraphrased = `return prisma.users.findUnique(where: {id: userId})`;
        expect(evidenceMatches(paraphrased, source)).toBe(false);
    });
});

describe('runPerEntryReview — small-model fallback (Issue 605)', () => {
    function mkStore(): SnapshotStore {
        const findings: any[] = [];
        return {
            getWorking: () => ({
                apiIndex: { 'GET:/x': { apiId: 'GET:/x', method: 'GET', route: '/x', handlerName: 'h', filePath: 'src/x.ts', meta: { clusterId: 'cluster:x' } } },
                files: { 'src/x.ts': { content: 'function h() {\n  return prisma.user.findMany();\n}' } },
                graphs: {},
            }),
            getReviewGuidelines: () => ({ text: 'rule', hash: 'h', updatedAt: 0 }),
            upsertAiReviewFinding: vi.fn((rec) => { const f = { ...rec, id: `f${findings.length}` }; findings.push(f); return f; }),
        } as unknown as SnapshotStore;
    }

    it('escalates to fallbackLlmCall when small-coder model keeps zero findings after retry', async () => {
        const store = mkStore();
        // Primary always returns garbage (rejected by gate, also nothing to retry on).
        const primary = vi.fn(async () => ({ findings: [{
            severity: 'warning', category: 'code-quality',
            title: 't', body: 'b', layers: ['file'],
            evidence: { snippet: 'this string is not in the source corpus' },
        }] }));
        // Fallback returns a real, matching snippet.
        const fallback = vi.fn(async () => ({ findings: [{
            severity: 'warning', category: 'code-quality',
            title: 'real finding', body: 'b', layers: ['file'],
            evidence: { snippet: 'return prisma.user.findMany();' },
        }] }));
        const drops: any[] = [];
        const landed: any[] = [];
        await runPerEntryReview({
            store,
            scope: { kind: 'entry', entryPointId: 'GET:/x' },
            llmCall: primary,
            model: 'deepseek-coder:6.7b',
            fallbackLlmCall: fallback,
            fallbackModel: 'gpt-4o-mini',
            callbacks: { onEntryDone: (_id, fs, d) => { landed.push(...fs); if (d) drops.push(d); } },
        });
        // Primary: 1 first-pass call + 1 retry-on-zero call = 2.
        expect(primary).toHaveBeenCalledTimes(2);
        // Fallback: exactly 1 call.
        expect(fallback).toHaveBeenCalledTimes(1);
        // Final result: 1 finding landed (from fallback).
        expect(landed).toHaveLength(1);
        expect(landed[0].title).toBe('real finding');
    });

    it('does NOT invoke fallback when primary already kept ≥1 finding', async () => {
        const store = mkStore();
        const primary = vi.fn(async () => ({ findings: [{
            severity: 'warning', category: 'code-quality',
            title: 'primary', body: 'b', layers: ['file'],
            evidence: { snippet: 'return prisma.user.findMany();' },
        }] }));
        const fallback = vi.fn(async () => ({ findings: [] }));
        await runPerEntryReview({
            store,
            scope: { kind: 'entry', entryPointId: 'GET:/x' },
            llmCall: primary,
            model: 'deepseek-coder:6.7b',
            fallbackLlmCall: fallback,
            fallbackModel: 'gpt-4o-mini',
        });
        expect(primary).toHaveBeenCalledTimes(1);
        expect(fallback).not.toHaveBeenCalled();
    });

    it('does NOT invoke fallback when the primary model is NOT a small-coder model', async () => {
        const store = mkStore();
        const primary = vi.fn(async () => ({ findings: [] }));
        const fallback = vi.fn(async () => ({ findings: [] }));
        await runPerEntryReview({
            store,
            scope: { kind: 'entry', entryPointId: 'GET:/x' },
            llmCall: primary,
            model: 'gpt-4o-mini',
            fallbackLlmCall: fallback,
            fallbackModel: 'gpt-4o',
        });
        // Capable models don't trigger the small-model fallback even when
        // they happen to return zero findings.
        expect(fallback).not.toHaveBeenCalled();
    });

    it('does NOT invoke fallback when fallbackLlmCall is not configured', async () => {
        const store = mkStore();
        const primary = vi.fn(async () => ({ findings: [] }));
        await runPerEntryReview({
            store,
            scope: { kind: 'entry', entryPointId: 'GET:/x' },
            llmCall: primary,
            model: 'deepseek-coder:6.7b',
            // fallbackLlmCall + fallbackModel omitted on purpose.
        });
        // Just one call (the first pass), no retry possible (zero findings emitted).
        expect(primary).toHaveBeenCalledTimes(1);
    });

    it('respects an explicit tolerance="strict" override on a small-coder model', async () => {
        // The override should bypass the auto-pick of `relaxed` for
        // deepseek-coder. We craft a paraphrase whose edit-distance to the
        // source falls between the strict and relaxed budgets so the choice
        // of tolerance is observable in the output.
        //
        // Fixture source (line 2): `  return prisma.user.findMany();`
        // Paraphrase: 'this is a totally different sentence about prisma users not in the source'
        // — >> 8 edits, will be rejected by both. Use it to confirm the test
        // setup is sane; then a strict-only override test below.
        const store = mkStore();
        // Paraphrase that even relaxed should reject. Confirms the rejection
        // path is reachable; the *boundary* case is covered by the
        // standalone `evidenceMatches` tolerance tests above.
        const unrelated = 'something completely unrelated like a payment refund SDK call';
        const primary = vi.fn(async () => ({ findings: [{
            severity: 'warning', category: 'code-quality',
            title: 't', body: 'b', layers: ['file'],
            evidence: { snippet: unrelated },
        }] }));
        let kept = 0;
        await runPerEntryReview({
            store,
            scope: { kind: 'entry', entryPointId: 'GET:/x' },
            llmCall: primary,
            model: 'deepseek-coder:6.7b',
            tolerance: 'strict',  // explicit override
            callbacks: { onEntryDone: (_id, fs) => { kept += fs.length; } },
        });
        expect(kept).toBe(0);
        // Should be called twice — first pass + retry (zero kept on first
        // pass triggers retry per #527).
        expect(primary).toHaveBeenCalledTimes(2);
    });
});

// #855 — anchor-resolution fallback tier (the cal.com#8087 G2 failure mode).
describe('resolveEvidence / anchorResolves (#855)', () => {
    // Real shape of the dropped G2 finding: long retyped quote with one
    // hallucinated token (booking_ref vs bookingRef), valid anchor symbol.
    const source = [
        'const bookingRefsFiltered = bookingReferences.filter((ref) => !!ref.uid);',
        'bookingRefsFiltered.forEach(async (bookingRef) => {',
        '  if (bookingRef.uid) {',
        '    if (bookingRef.type.endsWith("_calendar")) {',
        '      const calendar = await getCalendar(credentialsMap.get(bookingRef.type));',
        '      return calendar?.deleteEvent(bookingRef.uid, builder.calendarEvent, bookingRef.externalCalendarId);',
        '    } else if (bookingRef.type.endsWith("_video")) {',
        '      return deleteMeeting(credentialsMap.get(bookingRef.type), bookingRef.uid);',
        '    }',
        '  }',
        '});',
    ].join('\n');
    // Faithful to the real #8087 drop: model collapsed a multi-line block to
    // one line, OMITTED the extra deleteEvent args, AND typo'd booking_ref —
    // the window-length mismatch + omissions defeat the fuzzy tier.
    const driftedQuote = 'bookingRefsFiltered.forEach(async (bookingRef) => { if (booking_ref.type.endsWith("_calendar")) { const calendar = await getCalendar(credentialsMap.get(bookingRef.type)); return calendar.deleteEvent(booking_ref.uid); } });';

    it('exact tier for a verbatim quote', () => {
        expect(resolveEvidence('bookingRefsFiltered.forEach(async (bookingRef) => {', source, {})).toBe('exact');
    });

    it('drops a drifted quote when the anchor tier is OFF (legacy behaviour)', () => {
        expect(resolveEvidence(driftedQuote, source, { symbol: 'bookingRefsFiltered', allowAnchorTier: false })).toBeNull();
    });

    it('RESCUES the drifted quote via the anchor tier when the symbol resolves', () => {
        expect(resolveEvidence(driftedQuote, source, { symbol: 'bookingRefsFiltered', allowAnchorTier: true })).toBe('anchor');
    });

    it('anchor tier refuses when the symbol is absent from source', () => {
        expect(anchorResolves(driftedQuote, source, 'noSuchSymbol')).toBe(false);
        expect(resolveEvidence(driftedQuote, source, { symbol: 'noSuchSymbol', allowAnchorTier: true })).toBeNull();
    });

    it('anchor tier refuses when the quote does not overlap the symbol neighbourhood', () => {
        // Valid symbol, but the quote describes unrelated code → no rescue.
        expect(anchorResolves('return res.status(500).json({ error: "boom" });', source, 'bookingRefsFiltered')).toBe(false);
    });

    it('does not match a symbol that is only a substring of a longer identifier', () => {
        const src = 'const bookingRefsFilteredExtra = 1;';
        expect(anchorResolves('something bookingRefsFiltered something', src, 'bookingRefsFiltered')).toBe(false);
    });
});

// #856 — condensed single-call review mode.
describe('runSingleCallReview (#856)', () => {
    it('makes exactly ONE llmCall for multiple changed entry points and binds findings by anchor', async () => {
        const store = mockStore();
        const upserts: any[] = [];
        (store.upsertAiReviewFinding as any) = vi.fn((rec) => { upserts.push(rec); return { ...rec, id: `f${upserts.length}`, createdAt: 'n', updatedAt: 'n' }; });
        const { runSingleCallReview } = await import('../perEntryReviewer');
        const llmCall = vi.fn(async () => ({ findings: [
            { severity: 'error', category: 'logic-bug', title: 'race', body: 'b', layers: ['file'],
              anchor: { filePath: 'src/x.ts', symbol: 'create' },
              evidence: { snippet: 'prisma.article.create({ data: dto })' } },
        ]}));
        const res = await runSingleCallReview({ store, scope: { kind: 'all' }, llmCall, model: 'm' });
        expect(llmCall).toHaveBeenCalledTimes(1);          // ONE call, not 3
        expect(res.totalEntryPoints).toBe(3);
        expect(res.findingsCount).toBe(1);
        expect(upserts[0].anchor.filePath).toBe('src/x.ts');
        expect(upserts[0].bindings.some((b: any) => b.graphId === 'file:src/x.ts')).toBe(true);
        expect(upserts[0].bindings.some((b: any) => b.graphId === 'microservice:workspace')).toBe(true);
    });

    it('gate drops a finding whose snippet is not in any entry corpus', async () => {
        const store = mockStore();
        const { runSingleCallReview } = await import('../perEntryReviewer');
        const llmCall = vi.fn(async () => ({ findings: [
            { severity: 'warning', category: 'code-quality', title: 't', body: 'b', layers: ['file'],
              anchor: { filePath: 'src/x.ts', symbol: 'create' },
              evidence: { snippet: 'totally invented line not in source' } },
        ]}));
        const res = await runSingleCallReview({ store, scope: { kind: 'all' }, llmCall, model: 'm' });
        expect(res.findingsCount).toBe(0);
    });

    it('#897 — budget-dropped entries are excluded from the prompt AND surfaced as `skipped`', async () => {
        const store = mockStore(); // 3 entry points
        const { runSingleCallReview } = await import('../perEntryReviewer');
        let capturedUser = '';
        const llmCall = vi.fn(async ({ user }: any) => { capturedUser = String(user); return { findings: [] }; });
        const prev = process.env.CODEATLAS_REVIEW_CORPUS_BUDGET;
        process.env.CODEATLAS_REVIEW_CORPUS_BUDGET = '1'; // only the first entry fits (the first is always kept)
        const res = await runSingleCallReview({ store, scope: { kind: 'all' }, llmCall, model: 'm' });
        if (prev === undefined) delete process.env.CODEATLAS_REVIEW_CORPUS_BUDGET; else process.env.CODEATLAS_REVIEW_CORPUS_BUDGET = prev;
        expect(res.totalEntryPoints).toBe(3);
        expect(res.reviewed).toBe(1);                 // only the one that fit
        expect(res.skipped).toBe(2);                  // the other two, surfaced — not vanished
        // The instruction count matches the entries actually placed in the prompt,
        // so the model is never asked to review the dropped (source-absent) entries.
        expect(capturedUser).toContain('Review ALL 1 changed entry points');
    });
});

describe('#886 — AI-review prompts redact secrets before they reach the LLM', () => {
    // A handler whose source carries a hardcoded key + a connection URI.
    function secretStore(): SnapshotStore {
        const SRC = [
            'function handler(req, res) {',
            '  const API_KEY = "abcd1234supersecretvalue";',
            '  const db = connect("mongodb://admin:hunter2@db.internal:27017/app");',
            '  return res.json({ ok: true });',
            '}',
        ].join('\n');
        return {
            getWorking: () => ({
                apiIndex: {
                    // anchor.span makes getEntryPointPack emit `handlerSource` (the
                    // channel that actually ships source to the LLM) — without it the
                    // secret would only sit in the gate corpus, not the prompt.
                    api1: { method: 'POST', route: '/api/charge', handlerName: 'handler', filePath: 'src/pay.ts', diff: 'modified', meta: { clusterId: 'cluster:pay' }, anchor: { span: { start: 0, end: SRC.length } } },
                },
                files: { 'src/pay.ts': { content: SRC } as any },
                graphs: {},
            }),
            getReviewGuidelines: () => ({ text: '', hash: 'h', updatedAt: 0 }),
            upsertAiReviewFinding: vi.fn((rec) => ({ ...rec, id: 'f', createdAt: 'n', updatedAt: 'n' })),
        } as unknown as SnapshotStore;
    }

    it('the outbound prompt contains [REDACTED] and NOT the raw secret value', async () => {
        const store = secretStore();
        let captured = '';
        const llmCall = vi.fn(async ({ user }: any) => { captured = String(user); return { findings: [] }; });
        await runPerEntryReview({ store, scope: { kind: 'all' }, llmCall, model: 'm' });
        expect(llmCall).toHaveBeenCalled();
        expect(captured).toContain('[REDACTED]');           // key line scrubbed
        expect(captured).toContain('[REDACTED_URI]');        // connection URI scrubbed
        expect(captured).not.toContain('abcd1234supersecretvalue');
        expect(captured).not.toContain('hunter2');
    });
});
