/**
 * Per-repo detection coverage report.
 *
 * For each JS/TS repo, dumps detector output statistics so I can compare
 * against source patterns by hand and identify gaps.
 */
import { describe, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { detectApis, applyMountPrefixes } from '../../src/core/parser/apiDetector';
import { detectFrameworkApis } from '../../src/core/parser/frameworkDetector';
import { isBackendRepo } from './repoCategories';

const REAL_REPOS_DIR = path.resolve(__dirname, '..', 'real-repos');
const JS_TS_REPOS = [
    'js-express',
    'js-fastify',
    'js-koa',
    'js-nextjs',
    'ts-apollo',
    'ts-express-realworld',
    'ts-hono',
    'ts-nestjs',
    'ts-nuxt',
    'ts-react-native',
    'ts-remix',
    'ts-sveltekit',
    'ts-trpc',
];

// Issue 419 follow-up: also probe a Python fixture for FastAPI Depends() auth.
const PY_REPOS = ['py-fastapi'];

function walkJsTs(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage'].includes(entry.name)) continue;
            walkJsTs(p, out);
        } else if (/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(entry.name)) {
            out.push(p);
        }
    }
    return out;
}

const isCi = !!process.env.CI || !fs.existsSync(REAL_REPOS_DIR);

(isCi ? describe.skip : describe)('PER-REPO DETECTION REPORT', () => {
    for (const repo of JS_TS_REPOS) {
        if (!isBackendRepo(repo)) continue;
        const repoPath = path.join(REAL_REPOS_DIR, repo);
        if (!fs.existsSync(repoPath)) continue;
        const files = walkJsTs(repoPath);
        if (files.length === 0) continue;

        it(`${repo}: detection summary`, () => {
            const allApis: Record<string, any> = {};
            const fileContents = new Map<string, string>();
            let parseFailures = 0;
            for (const fp of files) {
                const rel = path.relative(repoPath, fp);
                try {
                    const code = fs.readFileSync(fp, 'utf-8');
                    fileContents.set(rel, code);
                    const apis = detectApis(code, rel);
                    for (const a of apis) allApis[a.apiId] = a;
                } catch { parseFailures++; }
            }
            let patched: any = allApis;
            try { patched = applyMountPrefixes(allApis, fileContents, repoPath); } catch { /* */ }
            const list = Object.values(patched) as any[];

            // Source pattern counts (greppable signals)
            let inlineArrowCalls = 0;
            let middlewareArgs = 0;
            let errorMwCalls = 0;
            let forLoops = 0;
            let routerChains = 0;
            for (const code of fileContents.values()) {
                inlineArrowCalls += (code.match(/\.(get|post|put|patch|delete|all)\s*\(\s*['"`][^'"`]+['"`][^)]{0,400}=>\s*\{/g) || []).length;
                middlewareArgs += (code.match(/\.(get|post|put|patch|delete)\s*\(\s*['"`][^'"`]+['"`]\s*,\s*\w+(?:\.\w+)*\s*,/g) || []).length;
                errorMwCalls += (code.match(/\.use\s*\(\s*(?:async\s+)?(?:function\s*[^(]*\(\s*err\b[^)]*next\b|\(\s*err\b[^)]*next\b\s*\)\s*=>)/g) || []).length;
                forLoops += (code.match(/for\s*\(\s*(?:let|var|const)\s+\w+\s*=\s*\d+;\s*\w+\s*[<=]+\s*[\w\d]+\s*;[^)]+\)\s*\{[\s\S]{0,400}?\.(get|post|put|patch|delete|all)\s*\(\s*`/g) || []).length;
                routerChains += (code.match(/Router\s*\(\s*\)\s*\.use\s*\(\s*\w+\s*\)\s*\.use\s*\(\s*\w+\s*\)/g) || []).length;
            }

            const summary = {
                files: files.length,
                parseFailures,
                totalApis: list.length,
                anonymousHandlers: list.filter(a => a.handlerName?.startsWith('anonymous@')).length,
                namedHandlers: list.filter(a => a.handlerName && !a.handlerName.startsWith('anonymous@') && a.method !== 'MIDDLEWARE').length,
                memberHandlers: list.filter(a => a.handlerName && /^\w+$/.test(a.handlerName) && !a.handlerName.startsWith('anonymous')).length,
                withMiddlewareMeta: list.filter(a => a.meta?.middlewares?.length).length,
                authRequired: list.filter(a => a.meta?.auth === 'required').length,
                authOptional: list.filter(a => a.meta?.auth === 'optional').length,
                errorMiddleware: list.filter(a => a.method === 'MIDDLEWARE' && a.meta?.error).length,
                parameterizedDynamicRange: list.filter(a => a.meta?.dynamicRange).length,
                apiPrefixed: list.filter(a => a.route.startsWith('/api/')).length,
                mountPrefixPatched: list.filter(a => a.rawRoute && a.rawRoute !== a.route).length,
                sourceSignals: {
                    inlineArrowCalls,
                    middlewareArgs,
                    errorMwCalls,
                    forLoops,
                    routerChains,
                },
            };
            console.log(`\n[${repo}]`, JSON.stringify(summary, null, 2));
        });
    }

    // Issue 419 follow-up: Python fixture probe for FastAPI Depends() auth.
    for (const repo of PY_REPOS) {
        const repoPath = path.join(REAL_REPOS_DIR, repo);
        if (!fs.existsSync(repoPath)) continue;
        const pyFiles: string[] = [];
        (function walk(dir: string) {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (['node_modules', '.git', 'dist', '__pycache__', '.venv', 'venv'].includes(e.name)) continue;
                    walk(p);
                } else if (e.name.endsWith('.py')) {
                    pyFiles.push(p);
                }
            }
        })(repoPath);
        if (pyFiles.length === 0) continue;

        it(`${repo}: FastAPI Depends() auth markers populated`, () => {
            const allApis: any[] = [];
            for (const fp of pyFiles) {
                const rel = path.relative(repoPath, fp);
                const code = fs.readFileSync(fp, 'utf-8');
                try {
                    const apis = detectFrameworkApis(code, rel, 'python');
                    for (const a of apis) allApis.push(a);
                } catch { /* */ }
            }
            const authRequired = allApis.filter(a => a.meta?.auth === 'required').length;
            const total = allApis.filter(a => /^(GET|POST|PUT|PATCH|DELETE)$/.test(a.method)).length;
            console.log(`\n[${repo}] FastAPI auth probe: ${authRequired}/${total} HTTP routes flagged auth.required`);
            // py-fastapi/backend has dozens of routes with Depends(get_current_*).
            // Expect at least a non-trivial fraction to be flagged.
            if (total > 5) {
                if (authRequired === 0) {
                    console.log(`  ⚠ expected some auth-required routes, got 0 — investigate proximity window or fixture content`);
                }
            }
        });
    }
});
