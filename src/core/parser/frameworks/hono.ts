/**
 * frameworks/hono.ts — Hono framework plugin
 * (Issue #703, Phase 2 PR-10 — eighth per-framework extraction.)
 *
 * Hono is a Cloudflare Workers / Deno / Bun-friendly web framework with a
 * fluent API that mirrors Express almost exactly:
 *
 *   import { Hono } from 'hono';
 *   const app = new Hono();
 *   app.get('/users', (c) => c.json([…]));
 *   app.post('/users', (c) => c.json({}));
 *
 * Because the call-site shape is identical to Express's `app.get(...)`,
 * this pattern is a partial overlap with the Express/Koa/Fastify pattern
 * in `JS_PATTERNS` (which also matches `app.get(...)`). Pre-#703 both
 * patterns lived inline and the dispatcher dedup'd via the seen-route
 * set. The extraction preserves the same shape verbatim — the partial
 * overlap is intentional pre-existing behaviour and removing it would
 * change `verify:real` output.
 *
 * No import gating: Hono and Express both bind to `app`, and the
 * dispatcher's `seen` set handles the dedup downstream. Adding an
 * `import 'hono'` gate here would silently drop hits in Express apps —
 * exactly the kind of byte-identical drift the non-regression contract
 * forbids.
 */

import type { FrameworkPlugin } from './types';

export const honoPlugin: FrameworkPlugin = {
    id: 'hono',
    name: 'Hono',
    languages: ['javascript', 'typescript'],
    patterns: [
        // app.get('/path', handler) — also matches Express; dispatcher dedups.
        {
            callPattern: /\bapp\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
            extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
            skipInsideTemplate: true,
        },
    ],
};
