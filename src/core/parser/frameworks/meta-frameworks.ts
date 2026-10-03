/**
 * frameworks/meta-frameworks.ts — File-system-routed meta-framework plugins
 * (Issue #703, Phase 2 PR-12 — extracts the largest cluster of patterns,
 *  five frameworks worth: Next.js, Nuxt, Remix, SvelteKit, tRPC.)
 *
 * Each of these frameworks emits route records by combining a regex over
 * the source file with a file-path heuristic — the regex picks the export
 * shape (`export async function GET`, `export const load`, …) and the
 * path is converted to a route via `inferRouteFromFilePath`. Bundling
 * them in one plugin keeps the helper import in one place and matches
 * how the inline `META_FRAMEWORK_PATTERNS` table used to organise them.
 *
 * Per-pattern coverage:
 *
 *   - **Next.js App Router** — `app/api/.../route.ts` with
 *     `export async function GET/POST/...`.
 *   - **Next.js Pages Router (API)** — `pages/api/...` with
 *     `export default function handler(...)`.
 *   - **Next.js Pages Router (data fetching)** — `getServerSideProps`,
 *     `getStaticProps`, `getStaticPaths` (inside `pages/`, outside `/api/`).
 *   - **Next.js Server Actions** — `'use server'` directive in
 *     `app/` / `actions/` / `lib/`.
 *   - **Next.js root middleware.ts** — `middleware.ts` at project /
 *     `src/` root.
 *   - **Nuxt server handlers** — `defineEventHandler` /
 *     `eventHandler` in `server/api/` / `server/routes/` /
 *     `server/middleware/`.
 *   - **Remix loaders + actions** — `export function loader` /
 *     `export const action` in `routes/` / `app/routes/`.
 *   - **SvelteKit endpoints** — `export function GET/POST/...` in
 *     `+server.ts`.
 *   - **SvelteKit page/layout server loaders** — `export const load`
 *     in `+page.server.ts` / `+layout.server.ts`.
 *   - **SvelteKit form actions** — `export const actions = { … }` in
 *     `+page.server.ts`.
 *   - **tRPC procedures** — `publicProcedure.query()` /
 *     `.mutation()`, gated by `@trpc/server` / `publicProcedure` /
 *     `createTRPCRouter` / `initTRPC` in the source.
 *
 * Suppression: pre-#703 these patterns lived in `META_FRAMEWORK_PATTERNS`
 * and did NOT have template-literal suppression (only `JS_PATTERNS` did).
 * They are extracted here WITHOUT `skipInsideTemplate` to preserve that
 * exact behaviour — adding suppression here would silently drop hits in
 * fixtures that include export statements inside markdown code fences.
 */

import type { FrameworkPlugin } from './types';
import { inferRouteFromFilePath } from '../frameworkDetector';

export const metaFrameworksPlugin: FrameworkPlugin = {
    id: 'meta-frameworks',
    name: 'Meta-frameworks (Next.js / Nuxt / Remix / SvelteKit / tRPC)',
    languages: ['javascript', 'typescript'],
    patterns: [
        // Next.js App Router: export async function GET/POST/...
        {
            callPattern: /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/gi,
            extract: (m, ctx) => {
                const route = inferRouteFromFilePath(ctx.filePath, ['app/api/', 'src/app/api/']);
                return route ? { method: m[1].toUpperCase(), route, handlerName: m[1] } : null;
            },
        },
        // Next.js Pages Router: export default in pages/api/**
        {
            callPattern: /export\s+default\s+(?:async\s+)?function\s+(\w+)/gi,
            extract: (m, ctx) => {
                const route = inferRouteFromFilePath(ctx.filePath, ['pages/api/', 'src/pages/api/']);
                return route ? { method: 'ANY', route, handlerName: m[1] } : null;
            },
        },
        // #879 — cal.com-style method-dispatch wrapper:
        //   export default defaultHandler({ GET: …, POST: … })
        // These API handlers live under arbitrary `**/api/**` dirs (e.g.
        // packages/features/ee/workflows/api/), NOT only pages/api/, so the
        // path-gated Pages-Router pattern above misses them. Emit one entry
        // per HTTP-method key, route inferred from the nearest `api/` segment.
        // GATED on at least one HTTP-method key so a generic defaultHandler({…})
        // never matches.
        {
            callPattern: /\bdefaultHandler\s*\(\s*\{/g,
            extract: (m, ctx) => {
                const start = (m.index ?? 0) + m[0].length;
                const window = ctx.source.slice(start, start + 400);
                const end = window.indexOf('})');
                const scope = end >= 0 ? window.slice(0, end) : window;
                const methods = [...new Set(
                    [...scope.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b\s*:/g)].map((x) => x[1].toUpperCase())
                )];
                if (methods.length === 0) return null;
                const route = inferRouteFromFilePath(ctx.filePath, ['/api/', 'pages/api/', 'src/pages/api/'])
                    ?? '/' + (ctx.filePath.split('/').pop()?.replace(/\.[jt]sx?$/, '') ?? 'handler');
                return { method: methods[0], route, handlerName: 'defaultHandler', extraMethods: methods.slice(1) };
            },
        },
        // Next.js Pages Router: getServerSideProps / getStaticProps / getStaticPaths
        {
            callPattern: /export\s+(?:async\s+)?function\s+(getServerSideProps|getStaticProps|getStaticPaths)\s*\(/gi,
            extract: (m, ctx) => {
                if (!ctx.filePath.match(/(?:^|\/)(?:src\/)?pages\//)) return null;
                if (ctx.filePath.includes('/api/')) return null;
                const route = inferRouteFromFilePath(ctx.filePath, ['pages/', 'src/pages/']);
                return route ? { method: m[1] === 'getStaticPaths' ? 'STATIC_PATHS' : 'DATA_FETCH', route, handlerName: m[1] } : null;
            },
        },
        // Next.js Server Actions: 'use server' directive.
        // #901 — match each `export function` INDEPENDENTLY and gate on the
        // module-level `'use server'` directive via a bounded head-scan. The old
        // `'use server'\s*;?[\s\S]*?export function` pattern (a) spanned the
        // directive to each export — with the `g` flag `.exec` consumed up to the
        // FIRST export and then found no second directive, so only ONE action was
        // detected per file; and (b) the `[\s\S]*?` backtracked quadratically on
        // many-export files. The directive is a top-of-file statement (like
        // `'use strict'`), so a 256-char head check is correct and O(1).
        {
            callPattern: /export\s+(?:async\s+)?function\s+(\w+)/gi,
            extract: (m, ctx) => {
                if (!/['"]use server['"]/.test(ctx.source.slice(0, 256))) return null;
                if (!ctx.filePath.match(/(?:^|\/)(?:src\/)?(?:app|actions|lib)\//)) return null;
                const route = inferRouteFromFilePath(ctx.filePath, ['app/', 'src/app/', 'actions/', 'src/actions/', 'lib/', 'src/lib/']);
                if (!route) return null; // #901 — drop the whole-path fallback (synthesized junk routes)
                return { method: 'SERVER_ACTION', route, handlerName: m[1] };
            },
        },
        // Next.js root middleware.ts
        {
            callPattern: /export\s+(?:(?:async\s+)?function|const)\s+middleware/gi,
            extract: (_m, ctx) => {
                if (!ctx.filePath.match(/^(?:src\/)?middleware\.[jt]sx?$/)) return null;
                return { method: 'MIDDLEWARE', route: '/*', handlerName: 'middleware' };
            },
        },
        // Nuxt: defineEventHandler / eventHandler
        {
            callPattern: /\b(?:defineEventHandler|eventHandler)\s*\(/gi,
            extract: (_m, ctx) => {
                const route = inferRouteFromFilePath(ctx.filePath, ['server/api/', 'server/routes/', 'server/middleware/']);
                if (!route) return null;
                const methodMatch = ctx.filePath.match(/\.(\w+)\.\w+$/);
                const method = methodMatch && ['get', 'post', 'put', 'patch', 'delete'].includes(methodMatch[1])
                    ? methodMatch[1].toUpperCase() : 'GET';
                return { method, route };
            },
        },
        // Remix: loader (GET) / action (POST), function + const forms
        {
            callPattern: /export\s+(?:async\s+)?(?:function|const|let|var)\s+(loader|action)\s*[(:=]/gi,
            extract: (m, ctx) => {
                const route = inferRouteFromFilePath(ctx.filePath, ['routes/', 'app/routes/']);
                if (!route) return null;
                const method = m[1] === 'loader' ? 'GET' : 'POST';
                return { method, route, handlerName: m[1] };
            },
        },
        // SvelteKit endpoints: export function GET/POST/... in +server.ts
        {
            callPattern: /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/gi,
            extract: (m, ctx) => {
                if (!ctx.filePath.includes('+server')) return null;
                const route = inferRouteFromFilePath(ctx.filePath, ['src/routes/']);
                return route ? { method: m[1].toUpperCase(), route, handlerName: m[1] } : null;
            },
        },
        // SvelteKit page/layout server loaders: export const load in +(page|layout).server.ts
        {
            callPattern: /export\s+(?:async\s+)?(?:function|const|let)\s+(load)\s*[(:=]/gi,
            extract: (_m, ctx) => {
                if (!/\+(?:page|layout)\.server\./.test(ctx.filePath)) return null;
                const route = inferRouteFromFilePath(ctx.filePath, ['src/routes/']);
                return route ? { method: 'GET', route, handlerName: 'load' } : null;
            },
        },
        // SvelteKit form actions: export const actions = { … } in +page.server.ts
        {
            callPattern: /export\s+const\s+actions\s*[:=]\s*\{/g,
            extract: (_m, ctx) => {
                if (!/\+page\.server\./.test(ctx.filePath)) return null;
                const route = inferRouteFromFilePath(ctx.filePath, ['src/routes/']);
                if (!route) return null;
                return { method: 'POST', route, handlerName: 'action' };
            },
        },
        // tRPC: publicProcedure.query() / .mutation()
        {
            callPattern: /\.(?:query|mutation)\s*\(\s*(?:async\s*)?\(?/gi,
            extract: (m, ctx) => {
                if (!/@trpc\/server|publicProcedure|protectedProcedure|createTRPCRouter|initTRPC/.test(ctx.source)) {
                    return null;
                }
                const before = ctx.source.slice(Math.max(0, m.index! - 200), m.index!);
                const nameMatches = [...before.matchAll(/(\w+)\s*:\s*\w*[Pp]rocedure/g)];
                if (nameMatches.length === 0) return null;
                const route = nameMatches[nameMatches.length - 1][1];
                const isQuery = m[0].includes('query');
                return { method: isQuery ? 'QUERY' : 'MUTATION', route, handlerName: route };
            },
        },
    ],
};
