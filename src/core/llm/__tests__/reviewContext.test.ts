import { describe, it, expect } from 'vitest';
import { buildReviewContext } from '../reviewContext';
import { buildReviewSystemPrompt } from '../projectLevelReviewer';

function mockStore(opts: {
    working: Record<string, { content: string; hash: string }>;
    baseline?: Record<string, { content: string; hash: string }>;
    apiIndex?: Record<string, any>;
    guidelines?: string;
}): any {
    const baseline = opts.baseline ?? {};
    return {
        getWorking: () => ({ apiIndex: opts.apiIndex ?? {}, files: opts.working, graphs: {} }),
        getBaseline: () => ({ apiIndex: {}, files: baseline, graphs: {} }),
        getFileContent: (kind: string, fp: string) => (kind === 'working' ? opts.working[fp]?.content : baseline[fp]?.content),
        getReviewGuidelines: () => ({ text: opts.guidelines ?? '', hash: 'h', updatedAt: 0 }),
    };
}

describe('buildReviewSystemPrompt', () => {
    it('contains the precision gates, dependents reasoning, and folds in guidelines', () => {
        const sys = buildReviewSystemPrompt('always check auth on writes');
        expect(sys).toMatch(/PRECISION GATES/);
        expect(sys).toMatch(/EVIDENCE-GATED \(#948\)/);
        expect(sys).toMatch(/DEPENDENTS/);
        expect(sys).toMatch(/always check auth on writes/);
    });
});

describe('#review-context buildReviewContext', () => {
    const store = mockStore({
        working: {
            'src/a.ts': { content: 'export const a = 2;\nfunction x(){ return 1; }\n', hash: 'w' },
            'src/a.test.ts': { content: "test('x', () => {});\n", hash: 'wt' },
        },
        baseline: { 'src/a.ts': { content: 'export const a = 1;\nfunction x(){ return 1; }\n', hash: 'b' } },
        guidelines: 'store-level guideline',
    });
    const ctx = buildReviewContext({ store, changedFiles: ['src/a.ts', 'README.md'], guidelines: 'explicit g1' });

    it('carries the shared reviewer instructions (parity with extension)', () => {
        expect(ctx.instructions).toMatch(/PRECISION GATES/);
        expect(ctx.instructions).toMatch(/explicit g1/);
    });

    it('keeps the full changed-file scope but only diff-windows SOURCE files', () => {
        expect(ctx.changedFiles).toContain('src/a.ts');
        expect(ctx.changedFiles).toContain('README.md'); // full scope retained for off-diff filtering
        expect(ctx.fileDiffs.map((d) => d.filePath)).toEqual(['src/a.ts']); // README.md (non-source) excluded
    });

    it('produces a +/- diff window for the changed source file', () => {
        const d = ctx.fileDiffs.find((x) => x.filePath === 'src/a.ts')!;
        expect(d.diff).toMatch(/export const a = 2;/);
    });

    it('returns dependents + entryPacks arrays (graceful with no call graph / no entry points)', () => {
        expect(Array.isArray(ctx.dependents)).toBe(true);
        expect(Array.isArray(ctx.entryPacks)).toBe(true);
    });

    // BUG-EXP-26 — a handler-file change (views.py / *_controller.rb) must surface
    // its endpoint pack even though the ROUTE is declared in a different file
    // (urls.py / routes.rb). Entry-pack matching keys off filePath OR anchor.filePath.
    it('surfaces an entry pack when the ANCHOR (handler) file changed, not the route file', () => {
        const store2 = mockStore({
            working: {
                'app/controllers/articles_controller.rb': { content: "def index\n  @a = 1\nend\n", hash: 'w' },
                'config/routes.rb': { content: "resources :articles\n", hash: 'r' },
            },
            apiIndex: {
                'RESOURCE:/articles': {
                    apiId: 'RESOURCE:/articles', method: 'RESOURCE', route: '/articles',
                    filePath: 'config/routes.rb',
                    anchor: { filePath: 'app/controllers/articles_controller.rb' },
                },
            },
        });
        // Only the HANDLER file changed — the route file did not.
        const c = buildReviewContext({ store: store2, changedFiles: ['app/controllers/articles_controller.rb'] });
        expect(c.entryPacks.length, 'endpoint surfaced via anchor.filePath match').toBeGreaterThanOrEqual(1);
    });

    // TICKET-ANCHOR-1 residual — after the anchor passes re-anchor a route onto
    // its handler, filePath AND anchor.filePath both point at the handler and
    // the ROUTE-declaration file lives in `meta.routeDeclFile`. A change to that
    // route file (routes.rb / urls.py) must still surface the endpoint's pack.
    it('surfaces the pack when the ROUTE-DECLARATION file changes (via meta.routeDeclFile)', () => {
        const store2 = mockStore({
            working: {
                'config/routes.rb': { hash: 'r1', content: "resources :articles\n" },
                'app/controllers/articles_controller.rb': { hash: 'h1', content: 'class ArticlesController\n  def index; end\nend\n' },
            },
            apiIndex: {
                'RESOURCE:/articles': {
                    apiId: 'RESOURCE:/articles', method: 'RESOURCE', route: '/articles',
                    // Real post-anchor shape: both point at the handler...
                    filePath: 'app/controllers/articles_controller.rb',
                    anchor: { filePath: 'app/controllers/articles_controller.rb' },
                    // ...and the route file is preserved here.
                    meta: { routeDeclFile: 'config/routes.rb' },
                },
            },
        });
        // Only the ROUTE file changed — the handler did not.
        const c = buildReviewContext({ store: store2, changedFiles: ['config/routes.rb'] });
        expect(c.entryPacks.length, 'endpoint surfaced via meta.routeDeclFile match').toBeGreaterThanOrEqual(1);
    });
});
