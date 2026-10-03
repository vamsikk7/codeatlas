/**
 * Live verification against the user's test project at
 * ~/work/node-express-realworld-example-app.
 *
 * Validates the end-to-end output of apiDetector + applyMountPrefixes against
 * the actual files in the test repo (not a synthetic fixture). Skipped when
 * the project directory isn't present, so this is safe in CI.
 *
 * Asserts:
 *   - 25 random routes via Issue 414 unrolling
 *   - /api/ prefix on every controller route via Issue 417 — `routes.ts` `Router().use('/api', api)` mount-tree not captured
 *   - Auth markers (Issue 408 — Middleware (`auth.required` / `auth.optional`) invisible across L2b / L3 / L4 / L5) populated from auth.required / auth.optional
 *   - Error middleware (Issue 418 — `main.ts` error-handling middleware (`app.use((err,req,res,next)=>{})`) not surfaced) flagged from main.ts
 *   - Anonymous handler EntityRecords (Issue 409 — Inline `router.METHOD(...)` arrow-handler edits do not cascade through L4 / L5 / L3) present for every route
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectApis, applyMountPrefixes } from '../apiDetector';
import { collectTopLevelEntities } from '../symbolExtractor';

const ROOT = path.join(os.homedir(), 'work/node-express-realworld-example-app');
// CI hazard: GitHub Actions runners have `~/work/<repo-name>/` as the standard
// workspace path, and several other repos happen to land at sibling dirs with
// the same prefix. `existsSync(ROOT)` alone returned true on a CI runner that
// had `~/work/node-express-realworld-example-app/` as an empty directory (no
// `src/` inside), so `walk(path.join(ROOT, 'src'))` failed with ENOENT.
// Guard on the actual source tree we'll walk, not just the project root, and
// also wrap in a try so a future-unfinished checkout doesn't crash the test
// file at collection time.
function liveProjectPresent(): boolean {
    try {
        return fs.statSync(path.join(ROOT, 'src')).isDirectory();
    } catch {
        return false;
    }
}
const PRESENT = liveProjectPresent();

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (['node_modules', '.git', 'dist', '.codeatlas'].includes(entry.name)) continue;
            walk(p, out);
        } else if (/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(entry.name)) {
            out.push(p);
        }
    }
    return out;
}

(PRESENT ? describe : describe.skip)('live project: node-express-realworld-example-app', () => {
    // Vitest evaluates the describe callback at COLLECTION time even when
    // `describe.skip` is used (so that `it()` calls register). Guard the
    // filesystem walk behind PRESENT so it doesn't fault on CI runners
    // where `~/work/node-express-realworld-example-app` doesn't exist.
    const files = PRESENT ? walk(path.join(ROOT, 'src')) : [];
    const allApis: Record<string, any> = {};
    const fileContents = new Map<string, string>();

    if (PRESENT) {
        for (const fp of files) {
            const rel = path.relative(ROOT, fp);
            const code = fs.readFileSync(fp, 'utf-8');
            fileContents.set(rel, code);
            const apis = detectApis(code, rel);
            for (const a of apis) allApis[a.apiId] = a;
        }
    }
    const patched = PRESENT
        ? applyMountPrefixes(allApis, fileContents, ROOT) as Record<string, any>
        : {};
    const list = Object.values(patched);

    it('Issue 414: random.controller.ts emits ONE parameterized /api/random/:index record with meta.dynamicRange', () => {
        const randomRoutes = list.filter(a => /\/random\//.test(a.route));
        expect(randomRoutes).toHaveLength(1);
        expect(randomRoutes[0].route).toBe('/api/random/:index');
        expect(randomRoutes[0].method).toBe('GET');
        expect(randomRoutes[0].meta?.dynamicRange).toEqual({
            var: 'index', from: 1, to: 25, step: 1, count: 25,
        });
    });

    it('Issue 417: every controller route is prefixed with /api/', () => {
        const controllerApis = list.filter(a =>
            /\/(article|auth|profile|tag|random)\/.*controller/.test(a.filePath) &&
            a.method !== 'MIDDLEWARE',
        );
        expect(controllerApis.length).toBeGreaterThan(20);
        const unprefixed = controllerApis.filter(a => !a.route.startsWith('/api/'));
        expect(unprefixed, `expected all controller routes /api-prefixed; got unprefixed: ${unprefixed.map(a => a.route).slice(0, 5).join(', ')}`).toHaveLength(0);
    });

    it('Issue 408: auth markers populated from auth.required / auth.optional middleware', () => {
        // Source declares 22 of 26 routes authenticated. Verify both forms surface.
        const authRequired = list.filter(a => a.meta?.auth === 'required');
        const authOptional = list.filter(a => a.meta?.auth === 'optional');
        expect(authRequired.length, 'expected ≥ 8 routes with auth.required').toBeGreaterThanOrEqual(8);
        expect(authOptional.length, 'expected ≥ 6 routes with auth.optional').toBeGreaterThanOrEqual(6);

        // Specific routes
        const userGet = list.find(a => a.route === '/api/user' && a.method === 'GET');
        expect(userGet?.meta?.auth, '/api/user GET should be auth.required').toBe('required');
        expect(userGet?.meta?.middlewares).toContain('auth.required');

        const articlesGet = list.find(a => a.route === '/api/articles' && a.method === 'GET');
        expect(articlesGet?.meta?.auth, '/api/articles GET should be auth.optional').toBe('optional');
    });

    it('Issue 418: main.ts error-handling middleware detected with meta.error', () => {
        const errorMw = list.filter(a => a.method === 'MIDDLEWARE' && a.meta?.error);
        expect(errorMw.length, 'expected ≥1 error-handling middleware').toBeGreaterThanOrEqual(1);
        const mainErrorMw = errorMw.find(a => a.filePath.endsWith('main.ts'));
        expect(mainErrorMw, 'expected error-middleware in main.ts').toBeDefined();
    });

    it('Issue 409: every inline-arrow route handler surfaces as a function EntityRecord', () => {
        const ctrlPath = 'src/app/routes/article/article.controller.ts';
        const code = fileContents.get(ctrlPath);
        expect(code).toBeDefined();
        const analysis = collectTopLevelEntities(code!, ctrlPath);
        const anonFns = analysis.entities.filter(e => e.kind === 'function' && e.name.startsWith('anonymous@'));
        // The article.controller has 14 inline arrow handlers — expect them all.
        expect(anonFns.length, 'expected ≥ 14 anonymous@METHOD:route entities in article.controller.ts').toBeGreaterThanOrEqual(14);
    });

    it('Issue 407: no `router` synthetic handler artefact for random.controller', () => {
        // Pre-fix the for-loop emitted a single ApiRecord with handlerName=`router`.
        // Post-fix it emits ONE parameterized record `anonymous@GET:/random/:index`.
        const randomCtrlApis = list.filter(a => a.filePath.endsWith('random.controller.ts'));
        const synthetic = randomCtrlApis.filter(a => a.handlerName === 'router');
        expect(synthetic, 'no API should have handlerName=router after Issue 414').toHaveLength(0);
        expect(randomCtrlApis).toHaveLength(1);
        expect(randomCtrlApis[0].handlerName).toBe('anonymous@GET:/random/:index');
    });

    it('summary: route count and detection breakdown', () => {
        const summary = {
            totalApis: list.length,
            byMethod: list.reduce((acc: any, a: any) => { acc[a.method] = (acc[a.method] || 0) + 1; return acc; }, {}),
            authRequired: list.filter(a => a.meta?.auth === 'required').length,
            authOptional: list.filter(a => a.meta?.auth === 'optional').length,
            errorMiddleware: list.filter(a => a.method === 'MIDDLEWARE' && a.meta?.error).length,
            apiPrefixedRoutes: list.filter(a => a.route.startsWith('/api/')).length,
            randomParameterizedRoutes: list.filter(a => a.route === '/api/random/:index').length,
            randomDynamicCount: list.find(a => a.route === '/api/random/:index')?.meta?.dynamicRange?.count ?? 0,
        };
        console.log('Live project summary:', JSON.stringify(summary, null, 2));
        // Sanity: 4 auth + 14 article + 3 profile + 1 tag + 1 random (parameterised) + 1 main + 1 errorMw = 25
        expect(summary.totalApis).toBeGreaterThanOrEqual(24);
    });
});
