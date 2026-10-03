import { describe, it, expect, vi } from 'vitest';
import { selectProjectLevelFiles, runProjectLevelReview, selectUncoveredChangedFiles, fileTier } from '../projectLevelReviewer';
import type { SnapshotStore } from '../../storage/snapshotStore';

/** Store with a working↔baseline diff (hashes + getFileContent), for the
 *  #883 diff-aware coverage path. */
function mockStoreDiff(opts: {
    working: Record<string, { content: string; hash: string }>;
    baseline: Record<string, { content?: string; hash: string }>;
    apiIndex?: Record<string, any>;
}): SnapshotStore {
    return {
        getWorking: () => ({ apiIndex: opts.apiIndex ?? {}, files: opts.working as any, graphs: {} }),
        getBaseline: () => ({ apiIndex: {}, files: opts.baseline as any, graphs: {} }),
        getFileContent: (kind: string, fp: string) => kind === 'working' ? opts.working[fp]?.content : opts.baseline[fp]?.content,
        getReviewGuidelines: () => ({ text: '', hash: 'h', updatedAt: 0 }),
        upsertAiReviewFinding: vi.fn((rec) => ({ ...rec, id: 'f', createdAt: 'n', updatedAt: 'n' })),
    } as unknown as SnapshotStore;
}

function mockStore(files: Record<string, string>): SnapshotStore {
    return {
        getWorking: () => ({
            apiIndex: {},
            files: Object.fromEntries(Object.entries(files).map(([fp, content]) => [fp, { content } as any])),
            graphs: {},
        }),
        getReviewGuidelines: () => ({ text: 'rule one', hash: 'h1', updatedAt: Date.now() }),
        upsertAiReviewFinding: vi.fn((rec) => ({ ...rec, id: `f_${Math.random().toString(36).slice(2)}`, createdAt: 'n', updatedAt: 'n' })),
    } as unknown as SnapshotStore;
}

describe('selectProjectLevelFiles', () => {
    it('picks auth + middleware + main entry first', () => {
        const store = mockStore({
            'src/auth.ts': 'export const JWT_SECRET = ...',
            'src/middleware/errorHandler.ts': 'export function errorHandler() {}',
            'src/main.ts': 'app.listen(3000)',
            'src/routes/article/article.controller.ts': 'irrelevant',
            'src/config/database.ts': 'export const dbUrl = ...',
            'README.md': 'docs',
        });
        const files = selectProjectLevelFiles(store);
        // Auth ranks highest, then middleware, then main, then config.
        expect(files[0]).toBe('src/auth.ts');
        expect(files).toContain('src/middleware/errorHandler.ts');
        expect(files).toContain('src/main.ts');
        expect(files).toContain('src/config/database.ts');
        // Should NOT include unrelated route controllers or docs.
        expect(files.some((f) => f.includes('article.controller'))).toBe(false);
        expect(files.some((f) => f.endsWith('.md'))).toBe(false);
    });

    it('caps at MAX_FILES (6)', () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 15; i++) files[`src/middleware/m${i}.ts`] = 'x';
        const store = mockStore(files);
        expect(selectProjectLevelFiles(store).length).toBeLessThanOrEqual(6);
    });
});

describe('#945 — reviewer-instruction taxonomy reaches the system prompt', () => {
    it('includes web-security sinks, theme-refactor discriminator, cross-version, Java-null, and new-file guidance', async () => {
        const store = mockStoreDiff({
            working: { 'src/x.ts': { content: 'a\nb\nCHANGED\nd', hash: 'w' } },
            baseline: { 'src/x.ts': { content: 'a\nb\nc\nd', hash: 'b' } },
            apiIndex: {},
        });
        let sys = '';
        const llmCall = vi.fn(async ({ system }: any) => { sys = String(system); return { findings: [] }; });
        await runProjectLevelReview({ store, llmCall, model: 'm' });
        // #945.1 web-security sink taxonomy
        expect(sys).toMatch(/SSRF/);
        expect(sys).toMatch(/postMessage/);
        expect(sys).toMatch(/X-Frame-Options: ALLOWALL/);
        // #945.2 theme-refactor discriminator (dark-light-choose first-arg equality)
        expect(sys).toMatch(/dark-light-choose/);
        // #945.3/4 cross-version + lookup-key consistency
        expect(sys).toMatch(/V1 vs V2/);
        expect(sys).toMatch(/findByName/);
        // #945.5 Java Optional.get null-safety
        expect(sys).toMatch(/Optional\.get\(\)/);
        // #945.6 newly-added-file audit mode
        expect(sys).toMatch(/all-`\+` NEW FILE/);
        // #947 targeted blocks for still-missed golden
        expect(sys).toMatch(/do NOT stop at the first/);          // enumerate-all
        expect(sys).toMatch(/RELOCATES the NPE to callers/);      // non-null contract
        expect(sys).toMatch(/cache\s+poisoning on the error path/); // cache poisoning
        expect(sys).toMatch(/LITERAL placeholder string/);        // hardcoded credential default
        expect(sys).toMatch(/HTTP verb/);                          // test verb-vs-route
    });
});

describe('#948–#952 — false-positive precision gates reach the system prompt', () => {
    it('includes evidence-gating, diff-scoped, verify-before-absent, redaction, and production-first rules', async () => {
        const store = mockStoreDiff({
            working: { 'src/x.ts': { content: 'a\nb\nCHANGED\nd', hash: 'w' } },
            baseline: { 'src/x.ts': { content: 'a\nb\nc\nd', hash: 'b' } },
            apiIndex: {},
        });
        let sys = '';
        const llmCall = vi.fn(async ({ system }: any) => { sys = String(system); return { findings: [] }; });
        await runProjectLevelReview({ store, llmCall, model: 'm' });
        expect(sys).toMatch(/PRECISION GATES/);
        expect(sys).toMatch(/EVIDENCE-GATED \(#948\)/);            // suppress speculative findings
        expect(sys).toMatch(/DIFF-SCOPED \(#949\)/);              // no findings on context code
        expect(sys).toMatch(/VERIFY-BEFORE-ABSENT \(#950\)/);     // existence cross-check
        expect(sys).toMatch(/PRODUCTION-FIRST \(#951\)/);         // test-file de-prioritization
        expect(sys).toMatch(/REDACTION \(#952\)/);                // [REDACTED] is not a bug
        expect(sys).toMatch(/\[REDACTED\]/);
    });
});

describe('#946 — dependency-aware diff context reaches the prompt', () => {
    it('attaches an off-screen interface implementer of a changed type + DEPENDENTS guidance', async () => {
        const IFACE = 'export class CalendarService { createEvent(e, credentialId) {} }\n';
        const LARK = 'export class LarkService { createEvent(e) {} }\n'; // stale — missing credentialId
        const store = {
            getWorking: () => ({
                apiIndex: {},
                graphs: {},
                callGraph: undefined,
                files: {
                    'src/lib/CalendarService.ts': { content: IFACE, hash: 'w', symbols: { functions: [
                        { name: 'CalendarService', kind: 'class', span: { start: 0, end: IFACE.length }, signature: 'class CalendarService', bodyText: '' },
                    ] } },
                    'src/lib/apps/lark.ts': { content: LARK, hash: 'w2', symbols: { functions: [
                        { name: 'LarkService', kind: 'class', span: { start: 0, end: LARK.length }, signature: 'class LarkService', bodyText: '', implementsInterfaces: ['CalendarService'] },
                    ] } },
                },
            }),
            getBaseline: () => ({ apiIndex: {}, graphs: {}, files: {
                'src/lib/CalendarService.ts': { content: 'export class CalendarService { createEvent(e) {} }\n', hash: 'b' },
                'src/lib/apps/lark.ts': { content: LARK, hash: 'w2' },
            } }),
            getFileContent: (kind: string, fp: string) => (kind === 'working' ? store.getWorking() : store.getBaseline()).files[fp]?.content,
            getReviewGuidelines: () => ({ text: '', hash: 'h', updatedAt: 0 }),
            upsertAiReviewFinding: vi.fn((rec: any) => ({ ...rec, id: 'f', createdAt: 'n', updatedAt: 'n' })),
        } as unknown as SnapshotStore;
        let sys = '', user = '';
        const llmCall = vi.fn(async ({ system, user: u }: any) => { sys = String(system); user = String(u); return { findings: [] }; });
        await runProjectLevelReview({ store, llmCall, model: 'm' });
        // system: the #946 DEPENDENTS guidance block
        expect(sys).toMatch(/DEPENDENTS — dependency-aware cross-file reasoning/);
        expect(sys).toMatch(/sibling-impl/);
        // user: the off-screen stale implementer is co-located as a dependent
        const payload = JSON.parse(user);
        expect(payload.dependents).toBeDefined();
        const impl = payload.dependents[0].dependents.find((d: any) => d.relation === 'implementer');
        expect(impl).toBeDefined();
        expect(impl.file).toBe('src/lib/apps/lark.ts');
        expect(impl.snippet).toContain('LarkService');
    });
});

describe('runProjectLevelReview', () => {
    // #942 refinement — an unrelated subsystem must not be packed into the same
    // review call as the PR's changed core (cal.com#11059: salesforce co-located
    // with the OAuth golden raised false positives 2→7).
    it('#942 — splits an unrelated subsystem out of the changed-core batch (under byte budget)', async () => {
        const lines = (marker: string, n: number) => marker + '\n' + `const ${marker.toLowerCase()} = 1;\n`.repeat(n);
        const working: Record<string, { content: string; hash: string }> = {};
        const baseline: Record<string, { content?: string; hash: string }> = {};
        // 6 OAuth-core files (~21k windowed, ≥ softFill 18k) + 2 TINY salesforce files.
        // Total stays well under MAX_TOTAL_BYTES (30k), so byte-budget alone CANNOT
        // split them — only the subsystem break can. Different subsystem keys:
        // packages/app-store/_utils vs packages/app-store/salesforce.
        for (let i = 0; i < 6; i++) { const fp = `packages/app-store/_utils/oauth/file${i}.ts`; working[fp] = { content: lines('OAUTHCORE', 120), hash: 'w' + i }; baseline[fp] = { hash: 'b' + i }; }
        for (let i = 0; i < 2; i++) { const fp = `packages/app-store/salesforce/lib/file${i}.ts`; working[fp] = { content: lines('SALESFORCEFP', 3), hash: 'sw' + i }; baseline[fp] = { hash: 'sb' + i }; }
        const store = mockStoreDiff({ working, baseline, apiIndex: {} });
        const calls: string[] = [];
        const llmCall = vi.fn(async ({ user }: any) => { calls.push(String(user)); return { findings: [] }; });
        await runProjectLevelReview({ store, llmCall, model: 'm' });
        expect(calls.length).toBeGreaterThanOrEqual(2); // a split happened…
        const oauthCall = calls.find((u) => u.includes('OAUTHCORE'));
        expect(oauthCall).toBeDefined();
        expect(oauthCall).not.toContain('SALESFORCEFP'); // …and the unrelated subsystem is NOT in the core's call
    });

    it('runs LLM, gates on evidence, persists findings with workspace + file bindings', async () => {
        const store = mockStore({
            'src/auth.ts': 'export const JWT_SECRET = process.env.JWT_SECRET || "superSecret";',
            'src/main.ts': 'app.use((err, req, res, next) => { res.status(500).send(err.message); });',
        });
        const upserts: any[] = [];
        (store.upsertAiReviewFinding as any) = vi.fn((rec) => { upserts.push(rec); return { ...rec, id: 'f', createdAt: 'n', updatedAt: 'n' }; });
        const llmCall = vi.fn(async () => ({
            findings: [
                {
                    severity: 'error', category: 'security',
                    title: 'Hardcoded JWT fallback', body: 'falls back to a known string',
                    filePath: 'src/auth.ts', symbol: 'JWT_SECRET',
                    // #886 — the shared redactor scrubs `JWT_SECRET = process.env.JWT_SECRET`
                    // (it matches the SECRET keyword), so the model can only quote the
                    // surviving hardcoded fallback literal. The gate redacts the corpus
                    // identically, so this still matches.
                    evidence: { snippet: '|| "superSecret"' },
                },
                // Hallucinated file → must drop
                {
                    severity: 'warning', category: 'code-quality',
                    title: 'Made-up issue', body: '',
                    filePath: 'src/does-not-exist.ts',
                    evidence: { snippet: 'fake snippet' },
                },
                // Evidence not in source → must drop
                {
                    severity: 'warning', category: 'security',
                    title: 'No grounding', body: '',
                    filePath: 'src/auth.ts',
                    evidence: { snippet: 'eval(userInput);' },
                },
            ],
        }));

        const result = await runProjectLevelReview({ store, llmCall, model: 'm' });
        expect(result.reviewed).toBe(true);
        expect(result.findingsCount).toBe(1);  // only the real one
        expect(upserts).toHaveLength(1);
        const f = upserts[0];
        expect(f.severity).toBe('error');
        expect(f.bindings.some((b: any) => b.graphId === 'microservice:workspace')).toBe(true);
        expect(f.bindings.some((b: any) => b.graphId === 'file:src/auth.ts')).toBe(true);
        expect(f.anchor.snippet).toContain('superSecret');
    });

    it('returns reviewed=false when no project-level files exist', async () => {
        const store = mockStore({ 'src/routes/article/article.controller.ts': 'x' });
        const llmCall = vi.fn();
        const result = await runProjectLevelReview({ store, llmCall, model: 'm' });
        expect(result.reviewed).toBe(false);
        expect(llmCall).not.toHaveBeenCalled();
    });

    it('catches LLM errors gracefully', async () => {
        const store = mockStore({ 'src/auth.ts': 'export const x = 1;' });
        const llmCall = vi.fn(async () => { throw new Error('boom'); });
        const result = await runProjectLevelReview({ store, llmCall, model: 'm' });
        expect(result.reviewed).toBe(false);
        expect(result.findingsCount).toBe(0);
    });

    it('requires findings to name an in-bundle filePath', async () => {
        const store = mockStore({ 'src/auth.ts': 'const x = "secret";' });
        const upserts: any[] = [];
        (store.upsertAiReviewFinding as any) = vi.fn((rec) => { upserts.push(rec); return { ...rec, id: 'f', createdAt: 'n', updatedAt: 'n' }; });
        const llmCall = vi.fn(async () => ({ findings: [
            { severity: 'warning', category: 'security', title: 't', body: 'b', filePath: '', evidence: { snippet: 'const x' } },
        ]}));
        const result = await runProjectLevelReview({ store, llmCall, model: 'm' });
        expect(result.findingsCount).toBe(0);
        expect(upserts).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// #883 — diff-aware coverage: review the changed files no entry point covers.
// ---------------------------------------------------------------------------
describe('#883 — diff-aware coverage pass', () => {
    it('selectUncoveredChangedFiles returns changed, non-entry, source files only', () => {
        const store = mockStoreDiff({
            working: {
                'src/services/booking.ts': { content: 'x', hash: 'NEW1' },   // changed, no entry → included
                'src/services/unchanged.ts': { content: 'y', hash: 'SAME' }, // unchanged → excluded
                'src/routes/handler.ts': { content: 'h', hash: 'NEW2' },     // changed but entry-anchored → excluded
                'src/notes.md': { content: 'doc', hash: 'NEW3' },            // not source → excluded
            },
            baseline: {
                'src/services/booking.ts': { hash: 'OLD1' },
                'src/services/unchanged.ts': { hash: 'SAME' },
                'src/routes/handler.ts': { hash: 'OLD2' },
                'src/notes.md': { hash: 'OLD3' },
            },
            apiIndex: { a1: { method: 'POST', route: '/x', handlerName: 'h', filePath: 'src/routes/handler.ts', diff: 'modified' } },
        });
        expect(selectUncoveredChangedFiles(store)).toEqual(['src/services/booking.ts']);
    });

    it('reviews a changed non-entry file (its code reaches the model) and persists the finding', async () => {
        const store = mockStoreDiff({
            working: { 'src/services/booking.ts': { content: 'function cancel(events) {\n  events.forEach(async (e) => await del(e));\n}', hash: 'NEW' } },
            baseline: { 'src/services/booking.ts': { hash: 'OLD' } },
            apiIndex: {},
        });
        let sentUser = '';
        const llmCall = vi.fn(async ({ user }: any) => { sentUser = String(user); return { findings: [
            { severity: 'error', category: 'logic-bug', title: 'forEach async', body: 'race', filePath: 'src/services/booking.ts', evidence: { snippet: 'events.forEach(async' } },
        ]}; });
        const result = await runProjectLevelReview({ store, llmCall, model: 'm' });
        expect(result.changedReviewed).toBe(1);
        expect(sentUser).toContain('src/services/booking.ts');   // the file's code was sent
        expect(sentUser).toContain('events.forEach(async');      // the changed line is in the window
        expect(result.findingsCount).toBe(1);
    });

    it('caps the changed-file fan-out and reports overflow (no silent truncation)', async () => {
        const working: Record<string, { content: string; hash: string }> = {};
        const baseline: Record<string, { hash: string }> = {};
        for (let i = 0; i < 10; i++) { working[`src/s${i}.ts`] = { content: `code ${i}`, hash: `N${i}` }; baseline[`src/s${i}.ts`] = { hash: `O${i}` }; }
        const store = mockStoreDiff({ working, baseline, apiIndex: {} });
        const llmCall = vi.fn(async () => ({ findings: [] }));
        const prev = process.env.CODEATLAS_REVIEW_CHANGED_FILE_CAP;
        process.env.CODEATLAS_REVIEW_CHANGED_FILE_CAP = '4';
        const result = await runProjectLevelReview({ store, llmCall, model: 'm' });
        if (prev === undefined) delete process.env.CODEATLAS_REVIEW_CHANGED_FILE_CAP; else process.env.CODEATLAS_REVIEW_CHANGED_FILE_CAP = prev;
        expect(result.changedReviewed).toBe(4);
        expect(result.overflow).toBe(6);
    });

    it('#884 — orders production logic before presentation before tests', () => {
        const mk = (hash: string) => ({ content: 'x', hash });
        const store = mockStoreDiff({
            working: {
                'src/api_test.go': mk('N1'),            // test → last
                'src/components/Widget.tsx': mk('N2'),  // presentation → mid
                'src/services/billing.go': mk('N3'),    // production → first
                'src/__tests__/foo.spec.ts': mk('N4'),  // test → last
                'src/core/engine.py': mk('N5'),         // production → first
            },
            baseline: {
                'src/api_test.go': { hash: 'O1' }, 'src/components/Widget.tsx': { hash: 'O2' },
                'src/services/billing.go': { hash: 'O3' }, 'src/__tests__/foo.spec.ts': { hash: 'O4' },
                'src/core/engine.py': { hash: 'O5' },
            },
            apiIndex: {},
        });
        const files = selectUncoveredChangedFiles(store);
        const tiers = files.map(fileTier);
        // non-decreasing tier order: production(0) → presentation(1) → test(2)
        expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
        // both production files rank ahead of the presentation + test files
        expect(files.slice(0, 2).sort()).toEqual(['src/core/engine.py', 'src/services/billing.go']);
        expect(fileTier(files[files.length - 1])).toBe(2);
    });

    // #944 — a changed controller surfaced only as an inherited before_action
    // FILTER entry must still reach the project pass (its update/destroy diff was
    // otherwise reviewed by neither pass — discourse#10 G2).
    it('#944 — a changed file covered only by a FILTER entry flows to the project pass', () => {
        const mk = (hash: string) => ({ content: 'x', hash });
        const store = mockStoreDiff({
            working: { 'app/controllers/embeddable_hosts_controller.rb': mk('N1') },
            baseline: { 'app/controllers/embeddable_hosts_controller.rb': { hash: 'O1' } },
            // the controller's ONLY entry is an inherited before_action FILTER hook
            apiIndex: { f1: { method: 'FILTER', route: 'before_action:ensure_logged_in', handlerName: 'ensure_logged_in', filePath: 'app/controllers/embeddable_hosts_controller.rb', diff: 'modified', meta: {} } as any },
        });
        // pre-#944 this was excluded as "reviewed per-entry" and reached neither pass
        expect(selectUncoveredChangedFiles(store)).toContain('app/controllers/embeddable_hosts_controller.rb');
    });

    // #942 — within a tier, coupled files in the same package must be ADJACENT so
    // they land in the same byte-budget batch (cross-file reasoning preserved).
    it('#942 — clusters same-directory production files together (path secondary sort)', () => {
        const mk = (hash: string) => ({ content: 'x', hash });
        // Interleave two packages by insertion (hash) order; the impl + interface in
        // .../permissions/ must end up contiguous, not scattered around .../events/.
        const store = mockStoreDiff({
            working: {
                'svc/permissions/AdminPermissions.java': mk('N1'),
                'svc/events/EventBus.java': mk('N2'),
                'svc/permissions/ClientPermissionsV2.java': mk('N3'),
                'svc/events/EventListener.java': mk('N4'),
            },
            baseline: {
                'svc/permissions/AdminPermissions.java': { hash: 'O1' }, 'svc/events/EventBus.java': { hash: 'O2' },
                'svc/permissions/ClientPermissionsV2.java': { hash: 'O3' }, 'svc/events/EventListener.java': { hash: 'O4' },
            },
            apiIndex: {},
        });
        const files = selectUncoveredChangedFiles(store);
        // deterministic (tier, path) order → same-package files are contiguous
        expect(files).toEqual([
            'svc/events/EventBus.java',
            'svc/events/EventListener.java',
            'svc/permissions/AdminPermissions.java',
            'svc/permissions/ClientPermissionsV2.java',
        ]);
        // the two .../permissions/ files are adjacent (indices differ by exactly 1)
        const i1 = files.indexOf('svc/permissions/AdminPermissions.java');
        const i2 = files.indexOf('svc/permissions/ClientPermissionsV2.java');
        expect(Math.abs(i1 - i2)).toBe(1);
    });

    it('with no diff (working === baseline) degrades to the infra-only pass', async () => {
        const store = mockStoreDiff({
            working: { 'src/auth.ts': { content: 'const JWT = "x";', hash: 'SAME' } },
            baseline: { 'src/auth.ts': { content: 'const JWT = "x";', hash: 'SAME' } },
            apiIndex: {},
        });
        const llmCall = vi.fn(async () => ({ findings: [] }));
        const result = await runProjectLevelReview({ store, llmCall, model: 'm' });
        expect(result.changedReviewed).toBe(0);   // nothing changed
        expect(result.infraReviewed).toBe(1);      // auth.ts picked by the infra heuristic
    });

    it('#893 — counts files dropped by the batch ceiling into overflow (no silent drop)', async () => {
        // Each file windows to a >MAX_TOTAL_BYTES blob (80 long, all-changed lines),
        // so every file forces its own batch. With the batch ceiling pinned to 1, only
        // the first file is reviewed and the other 4 must surface as overflow — not vanish.
        const big = (tag: string) => Array.from({ length: 80 }, (_, i) => `${tag}_${i}_${tag.repeat(120)}`).join('\n');
        const working: Record<string, { content: string; hash: string }> = {};
        const baseline: Record<string, { content: string; hash: string }> = {};
        for (let i = 0; i < 5; i++) {
            working[`src/svc${i}.ts`] = { content: big(`WORK${i}`), hash: `N${i}` };
            baseline[`src/svc${i}.ts`] = { content: big(`BASE${i}`), hash: `O${i}` };
        }
        const store = mockStoreDiff({ working, baseline, apiIndex: {} });
        const llmCall = vi.fn(async () => ({ findings: [] }));
        const prevB = process.env.CODEATLAS_REVIEW_PROJECT_BATCHES;
        const prevC = process.env.CODEATLAS_REVIEW_CHANGED_FILE_CAP;
        process.env.CODEATLAS_REVIEW_PROJECT_BATCHES = '1';   // only one batch allowed
        process.env.CODEATLAS_REVIEW_CHANGED_FILE_CAP = '50'; // file cap must not be what truncates
        const result = await runProjectLevelReview({ store, llmCall, model: 'm' });
        if (prevB === undefined) delete process.env.CODEATLAS_REVIEW_PROJECT_BATCHES; else process.env.CODEATLAS_REVIEW_PROJECT_BATCHES = prevB;
        if (prevC === undefined) delete process.env.CODEATLAS_REVIEW_CHANGED_FILE_CAP; else process.env.CODEATLAS_REVIEW_CHANGED_FILE_CAP = prevC;
        expect(llmCall).toHaveBeenCalledTimes(1);  // exactly one batch went to the model
        expect(result.batches).toBe(1);
        expect(result.files.length).toBe(1);       // one file actually reviewed
        expect(result.overflow).toBe(4);           // the other four are reported, not dropped silently
    });
});

// ---------------------------------------------------------------------------
// #930 — the project pass was diff-BLIND: at review-pr init the baseline's
// content lives only in the in-memory snapshot (SQLite baseline rows are
// content=NULL until a post-forget rotateBaseline), so getFileContent('baseline')
// returned undefined and every modified non-entry file degraded to a markerless
// numbered dump. Plus new files / shell+sql files / over-tight windows.
// ---------------------------------------------------------------------------
describe('#930 — project pass shows a real diff', () => {
    it('falls back to in-memory baseline content when getFileContent(baseline) is null, so a modified file shows +/- markers', async () => {
        const baselineContent = 'a\nb\nc\nd\ne';
        const workingContent = 'a\nb\nCHANGED\nd\ne';
        const store = {
            getWorking: () => ({ apiIndex: {}, files: { 'src/svc.ts': { content: workingContent, hash: 'w' } }, graphs: {} }),
            // in-memory baseline DOES carry content (the JSON-cloned snapshot)...
            getBaseline: () => ({ apiIndex: {}, files: { 'src/svc.ts': { content: baselineContent, hash: 'b' } }, graphs: {} }),
            // ...but the SQLite-backed getFileContent('baseline') is null at review-pr init.
            getFileContent: (kind: string) => (kind === 'working' ? workingContent : undefined),
            getReviewGuidelines: () => ({ text: '', hash: 'h', updatedAt: 0 }),
            upsertAiReviewFinding: vi.fn((rec) => ({ ...rec, id: 'f' })),
        } as unknown as SnapshotStore;
        let sentUser = '';
        const llmCall = vi.fn(async ({ user }: any) => { sentUser = String(user); return { findings: [] }; });
        await runProjectLevelReview({ store, llmCall, model: 'm' });
        expect(llmCall).toHaveBeenCalled();
        expect(sentUser).toContain('+3: CHANGED'); // added line marked
        expect(sentUser).toContain('-     c');       // removed line marked
    });

    // #22345 — a changed block's correctness can hinge on a nearby UNCHANGED
    // binding/guard. The widened context window (10) keeps such load-bearing
    // lines in-window instead of collapsing them into a `… N unchanged …` gap.
    it('#22345 — keeps a load-bearing unchanged line ~8 lines from a change in-window', async () => {
        // binding on line 8; the change on line 16 depends on it (8-line gap).
        const lines: string[] = [];
        for (let i = 1; i <= 18; i++) {
            if (i === 8) lines.push('  const userIdsFromOrg = teamsFromOrg.length > 0 ? load() : [];');
            else lines.push(`  const filler${i} = ${i};`);
        }
        const baseline = lines.join('\n');
        const working = lines.map((l, idx) => (idx === 15 ? '  return userIdsFromOrg.map(x => x.id); // CHANGED' : l)).join('\n');
        const mk = (content: string) => ({
            getWorking: () => ({ apiIndex: {}, files: { 'src/insights.ts': { content: working, hash: 'w' } }, graphs: {} }),
            getBaseline: () => ({ apiIndex: {}, files: { 'src/insights.ts': { content: baseline, hash: 'b' } }, graphs: {} }),
            getFileContent: (kind: string) => (kind === 'working' ? working : baseline),
            getReviewGuidelines: () => ({ text: '', hash: 'h', updatedAt: 0 }),
            upsertAiReviewFinding: vi.fn((rec: any) => ({ ...rec, id: 'f' })),
        } as unknown as SnapshotStore);
        let sentUser = '';
        const llmCall = vi.fn(async ({ user }: any) => { sentUser = String(user); return { findings: [] }; });
        await runProjectLevelReview({ store: mk(working), llmCall, model: 'm' });
        // the binding the change depends on is present (not collapsed into a gap)
        expect(sentUser).toContain('userIdsFromOrg = teamsFromOrg.length > 0');
        expect(sentUser).toContain('CHANGED');

        // control: at the OLD 6-line context the same binding falls into a gap
        sentUser = '';
        process.env.CODEATLAS_REVIEW_WINDOW_CONTEXT = '6';
        await runProjectLevelReview({ store: mk(working), llmCall, model: 'm' });
        delete process.env.CODEATLAS_REVIEW_WINDOW_CONTEXT;
        expect(sentUser).not.toContain('userIdsFromOrg = teamsFromOrg.length > 0');
    });

    it('a brand-new changed file is shown all-`+` under a NEW FILE banner (not unmarked code)', async () => {
        const store = mockStoreDiff({
            working: { 'src/new.ts': { content: 'export const x = 1;\nconst y = 2;', hash: 'w' } },
            baseline: {}, // absent in baseline = new file
            apiIndex: {},
        });
        let sentUser = '';
        const llmCall = vi.fn(async ({ user }: any) => { sentUser = String(user); return { findings: [] }; });
        await runProjectLevelReview({ store, llmCall, model: 'm' });
        expect(sentUser).toContain('NEW FILE');
        expect(sentUser).toContain('+1: export const x = 1;');
    });

    it('includes shell + sql changed files in the changed-file pass (logic lives there too)', () => {
        const store = mockStoreDiff({
            working: {
                'scripts/test-webhooks.sh': { content: "sed -i '' s/a/b/ f", hash: 'w1' },
                'db/migrate/001_init.sql': { content: 'ALTER TABLE x ADD c int', hash: 'w2' },
                'README.md': { content: 'docs', hash: 'w3' },
            },
            baseline: {
                'scripts/test-webhooks.sh': { hash: 'b1' },
                'db/migrate/001_init.sql': { hash: 'b2' },
                'README.md': { hash: 'b3' },
            },
            apiIndex: {},
        });
        const files = selectUncoveredChangedFiles(store);
        expect(files).toContain('scripts/test-webhooks.sh');
        expect(files).toContain('db/migrate/001_init.sql');
        expect(files).not.toContain('README.md'); // docs still excluded
    });

    it('window cap is env-tunable — a big change overflows loudly at the configured limit', async () => {
        const work = Array.from({ length: 120 }, (_, i) => `W${i}`).join('\n');
        const base = Array.from({ length: 120 }, (_, i) => `B${i}`).join('\n'); // every line changed
        const store = mockStoreDiff({
            working: { 'src/big.ts': { content: work, hash: 'w' } },
            baseline: { 'src/big.ts': { content: base, hash: 'b' } },
            apiIndex: {},
        });
        let sentUser = '';
        const llmCall = vi.fn(async ({ user }: any) => { sentUser = String(user); return { findings: [] }; });
        const prev = process.env.CODEATLAS_REVIEW_WINDOW_MAX_LINES;
        process.env.CODEATLAS_REVIEW_WINDOW_MAX_LINES = '20';
        await runProjectLevelReview({ store, llmCall, model: 'm' });
        if (prev === undefined) delete process.env.CODEATLAS_REVIEW_WINDOW_MAX_LINES; else process.env.CODEATLAS_REVIEW_WINDOW_MAX_LINES = prev;
        expect(sentUser).toContain('NOT shown'); // overflow marked at the 20-line cap, never silently dropped
    });
});

// ---------------------------------------------------------------------------
// #931 — a changed presentation component (.tsx/.jsx/.vue/.svelte) that got a
// spurious frontend entry-point extraction (e.g. a `useMutation()` tagged
// method:NETWORK) was treated as "covered per-entry" and dropped from the
// project pass, so its real diff was never shown (only a degenerate handler
// slice). Presentation files now always route through the project pass.
// ---------------------------------------------------------------------------
describe('#931 — changed presentation components reach the project pass', () => {
    it('includes a changed .tsx even when an apiIndex entry anchors it (frontend mis-detection)', () => {
        const store = mockStoreDiff({
            working: {
                'apps/web/components/dialog/AddGuestsDialog.tsx': { content: 'x', hash: 'N1' }, // entry-anchored .tsx
                'src/services/booking.ts': { content: 'y', hash: 'N2' },                       // entry-anchored .ts
            },
            baseline: {
                'apps/web/components/dialog/AddGuestsDialog.tsx': { hash: 'O1' },
                'src/services/booking.ts': { hash: 'O2' },
            },
            apiIndex: {
                a1: { method: 'NETWORK', route: 'mutation', handlerName: 'useMutation', filePath: 'apps/web/components/dialog/AddGuestsDialog.tsx', diff: 'modified' },
                a2: { method: 'POST', route: '/book', handlerName: 'book', filePath: 'src/services/booking.ts', diff: 'modified' },
            },
        });
        const files = selectUncoveredChangedFiles(store);
        // The presentation component is rescued into the project pass...
        expect(files).toContain('apps/web/components/dialog/AddGuestsDialog.tsx');
        // ...while a genuinely entry-anchored backend .ts stays covered per-entry (excluded).
        expect(files).not.toContain('src/services/booking.ts');
    });

    it('#934 — a changed file whose entry is BEYOND the per-entry cap falls through to the project pass', () => {
        const working: Record<string, { content: string; hash: string }> = {};
        const baseline: Record<string, { hash: string }> = {};
        const apiIndex: Record<string, any> = {};
        for (let i = 0; i < 5; i++) {
            working[`app/c${i}.rb`] = { content: `code ${i}`, hash: `N${i}` };
            baseline[`app/c${i}.rb`] = { hash: `O${i}` };
            apiIndex[`a${i}`] = { method: 'GET', route: `/r${i}`, handlerName: `h${i}`, filePath: `app/c${i}.rb`, diff: 'modified' };
        }
        const store = mockStoreDiff({ working, baseline, apiIndex });
        const prev = process.env.CODEATLAS_REVIEW_ENTRY_CAP;
        process.env.CODEATLAS_REVIEW_ENTRY_CAP = '3'; // only the first 3 entries get reviewed per-entry
        const files = selectUncoveredChangedFiles(store);
        if (prev === undefined) delete process.env.CODEATLAS_REVIEW_ENTRY_CAP; else process.env.CODEATLAS_REVIEW_ENTRY_CAP = prev;
        // The 2 entries beyond the cap are reviewed by NEITHER pass otherwise → rescued here.
        expect(files).toContain('app/c3.rb');
        expect(files).toContain('app/c4.rb');
        // A file whose entry IS within the cap stays covered per-entry (excluded).
        expect(files).not.toContain('app/c0.rb');
    });
});

// ---------------------------------------------------------------------------
// #933 — changed style/template files (.scss/.css/.erb/...) were excluded from
// SOURCE_EXT, so styling + template bugs (an inverted color lightness, an `end if`
// in an ERB view) never reached the reviewer. They now ride the project pass,
// tiered as presentation (after logic, before tests).
// ---------------------------------------------------------------------------
describe('#933 — style + template files are reviewed', () => {
    it('includes changed .scss / .erb / .hbs in the changed-file pass, tiered after logic', () => {
        const store = mockStoreDiff({
            working: {
                'app/assets/stylesheets/header.scss': { content: 'color: scale-color($primary, 70%);', hash: 'w1' },
                'app/views/embed/show.html.erb': { content: '<%= link %><% end if %>', hash: 'w2' },
                'app/templates/topic.hbs': { content: '{{title}}', hash: 'w3' },
                'app/services/billing.rb': { content: 'def charge; end', hash: 'w4' },
                'app/assets/vendor.min.css': { content: '.a{x:1}', hash: 'w5' },
            },
            baseline: {
                'app/assets/stylesheets/header.scss': { hash: 'b1' },
                'app/views/embed/show.html.erb': { hash: 'b2' },
                'app/templates/topic.hbs': { hash: 'b3' },
                'app/services/billing.rb': { hash: 'b4' },
                'app/assets/vendor.min.css': { hash: 'b5' },
            },
            apiIndex: {},
        });
        const files = selectUncoveredChangedFiles(store);
        expect(files).toContain('app/assets/stylesheets/header.scss');
        expect(files).toContain('app/views/embed/show.html.erb'); // .html.erb ends in .erb
        expect(files).toContain('app/templates/topic.hbs');
        expect(files).toContain('app/assets/vendor.min.css');
        // Production logic (.rb) is tier 0 and ranks before the style/template files (tier 1).
        expect(fileTier('app/services/billing.rb')).toBe(0);
        expect(fileTier('app/assets/stylesheets/header.scss')).toBe(1);
        expect(fileTier('app/views/embed/show.html.erb')).toBe(1);
        expect(files.indexOf('app/services/billing.rb')).toBeLessThan(files.indexOf('app/assets/stylesheets/header.scss'));
    });

    it('#937 — includes changed i18n files (.properties/.po/.xliff/.arb), tiered as presentation', () => {
        const store = mockStoreDiff({
            working: {
                'src/main/resources/messages_lt.properties': { content: 'login=Accesso', hash: 'w1' },
                'locales/de.po': { content: 'msgstr "Hallo"', hash: 'w2' },
                'i18n/app_fr.arb': { content: '{"hello":"Bonjour"}', hash: 'w3' },
                'src/main/java/Login.java': { content: 'class Login {}', hash: 'w4' },
            },
            baseline: {
                'src/main/resources/messages_lt.properties': { hash: 'b1' },
                'locales/de.po': { hash: 'b2' },
                'i18n/app_fr.arb': { hash: 'b3' },
                'src/main/java/Login.java': { hash: 'b4' },
            },
            apiIndex: {},
        });
        const files = selectUncoveredChangedFiles(store);
        expect(files).toContain('src/main/resources/messages_lt.properties');
        expect(files).toContain('locales/de.po');
        expect(files).toContain('i18n/app_fr.arb');
        expect(fileTier('src/main/resources/messages_lt.properties')).toBe(1); // presentation tier
        // Java logic ranks before the i18n files.
        expect(files.indexOf('src/main/java/Login.java')).toBeLessThan(files.indexOf('locales/de.po'));
    });
});
