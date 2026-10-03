/**
 * frameworks/node-http.ts — Express / Koa / Fastify generic router plugin
 * (Issue #703, Phase 2 PR-11 — final extraction from `JS_PATTERNS`.)
 *
 * The three big Node HTTP frameworks (Express, Koa, Fastify) all expose
 * the same call-site shape:
 *
 *   router.get('/users', handler);
 *   app.post('/users', handler);
 *   server.put('/users/:id', handler);
 *   fastify.delete('/users/:id', handler);
 *
 * One regex catches all four binding identifiers (`router` / `app` /
 * `server` / `fastify`) crossed with the seven HTTP verbs (plus `all`).
 * Pre-#703 this lived as the single most-hit entry in `JS_PATTERNS` and
 * was the catch-all for "JS Node web framework" routing.
 *
 * No import gating is applied — the regex is broad on purpose: it's the
 * fallback that catches Express/Koa/Fastify usage even when imports are
 * indirect (re-exports, dependency-injection containers, dynamic
 * `require()`, etc.). The downside is that any custom class exposing
 * `app.get('/x', fn)` will also match; the dispatcher's `seen` set and
 * the L2b cluster/path heuristics dedup downstream. Pre-existing
 * behaviour — extraction preserves it byte-for-byte.
 *
 * `skipInsideTemplate: true` preserves the pre-#703 dispatcher
 * suppression: the inline `JS_PATTERNS` entries used to be suppressed
 * inside template literals via the `jsExpressPatterns` Set lookup. With
 * the pattern now in the registry, the explicit flag takes over.
 */

import type { FrameworkPlugin } from './types';

export const nodeHttpPlugin: FrameworkPlugin = {
    id: 'node-http',
    name: 'Node HTTP (Express / Koa / Fastify)',
    languages: ['javascript', 'typescript'],
    patterns: [
        // router|app|server|fastify .get/.post/.put/.patch/.delete/.options/.head/.all
        {
            callPattern: /\b(?:router|app|server|fastify)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
            extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
            skipInsideTemplate: true,
        },
    ],
};
