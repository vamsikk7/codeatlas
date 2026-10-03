/**
 * middlewareTaggers/laravel.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Per-framework middleware tagger split from `middlewareTaggers.ts`.
 * See sibling files + `./index.ts` for the full set.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * UX-40 (2026-06-05) — Laravel middleware tagger.
 *
 * For each Laravel route (`Route::get('/x', ...)` or chained
 * `Route::middleware(...)->get('/x', ...)`), walk backward to find:
 *
 *   - Same-statement chain: `Route::middleware(['auth','verified'])->get(...)`
 *     or `Route::middleware('api')->post(...)`. The args inside
 *     `middleware(...)` are bare quoted strings.
 *   - Enclosing `Route::group(['middleware' => ['auth']], fn)` body.
 *     Group middleware applies to every nested route until the
 *     matching `});` closes the group.
 *
 * Auth derivation when the middleware name matches `auth*` / `verified` /
 * `can:*` / `permission:*` / `role:*`.
 */
const LARAVEL_AUTH_MIDDLEWARE = /^(?:auth(?:\..*)?|verified|can(?::|$)|permission(?::|$)|role(?::|$))/i;

export function tagLaravelMiddleware(apis: ApiRecord[], source: string): void {
    if (apis.length === 0) return;

    // Pre-collect group middleware ranges from
    //   Route::group(['middleware' => ...], function () { … });
    // Each group has a startOffset (after `{`) + endOffset (matching `}`).
    const groupRanges: Array<{ start: number; end: number; mws: string[] }> = [];
    // Lazy `[\s\S]*?` allows the array literal to contain nested `[...]`
    // (e.g. `['middleware' => ['auth', 'admin']]`) while still binding
    // the outer `]` correctly before `, function`.
    const groupRe = /Route\s*::\s*group\s*\(\s*\[([\s\S]*?)\]\s*,\s*function\s*\([^)]*\)\s*\{/g;
    let gm: RegExpExecArray | null;
    while ((gm = groupRe.exec(source)) !== null) {
        const arrayBody = gm[1];
        const mws = extractLaravelMiddlewareArg(arrayBody);
        if (mws.length === 0) continue;
        // Find the matching `}` (brace counter). Group body starts AFTER `{`.
        const bodyStart = gm.index + gm[0].length;
        let depth = 1;
        let i = bodyStart;
        while (i < source.length && depth > 0) {
            const ch = source[i];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            i++;
        }
        groupRanges.push({ start: bodyStart, end: i - 1, mws });
    }

    for (const api of apis) {
        if (!/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ANY)$/.test(api.method)) continue;
        const off = api.anchor?.span?.start ?? 0;
        const mws: string[] = [];

        // 1. Same-statement chain: look back from the verb's `->get(` (or
        //    `Route::get(`) to the previous `;` (or start of file) for
        //    `->middleware(...)` calls AND the head `Route::`.
        const before = source.slice(Math.max(0, off - 800), off);
        const lastSemi = before.lastIndexOf(';');
        const chainHead = lastSemi >= 0 ? before.slice(lastSemi + 1) : before;
        // The api offset itself is at `->` or `Route::`. Include a small
        // forward window so a route written as `Route::middleware(...)->get(`
        // where the api anchor lands at `->get(` also picks up the
        // middleware call to the left.
        const sameStatement = chainHead;
        const chainMwRe = /(?:Route\s*::|->)\s*middleware\s*\(([^)]*)\)/g;
        let cm: RegExpExecArray | null;
        while ((cm = chainMwRe.exec(sameStatement)) !== null) {
            const args = cm[1];
            for (const name of extractLaravelMiddlewareArg(args)) {
                if (!mws.includes(name)) mws.push(name);
            }
        }

        // 2. Enclosing group middleware.
        for (const g of groupRanges) {
            if (off >= g.start && off <= g.end) {
                for (const name of g.mws) if (!mws.includes(name)) mws.push(name);
            }
        }

        if (mws.length === 0) continue;
        api.meta = api.meta ?? {};
        const existing = api.meta.middlewares ?? [];
        // Group middleware first (outer), then per-route chain.
        // Since we collect chain first above, reorder: groups appear at
        // the END of `mws` (pushed later). Move them to the front.
        const groupMws = new Set<string>();
        for (const g of groupRanges) {
            if (off >= g.start && off <= g.end) for (const n of g.mws) groupMws.add(n);
        }
        const ordered: string[] = [];
        for (const n of mws) if (groupMws.has(n) && !ordered.includes(n)) ordered.push(n);
        for (const n of mws) if (!groupMws.has(n) && !ordered.includes(n)) ordered.push(n);
        for (const mw of existing) if (!ordered.includes(mw)) ordered.push(mw);
        api.meta.middlewares = ordered;

        if (!api.meta.auth) {
            for (const mw of ordered) {
                if (LARAVEL_AUTH_MIDDLEWARE.test(mw)) {
                    api.meta.auth = 'required';
                    break;
                }
            }
        }
    }
}

/**
 * Extract middleware names from a Laravel arg expression:
 *   - `'auth'`                      → ['auth']
 *   - `['auth', 'verified']`        → ['auth', 'verified']
 *   - `'middleware' => 'auth'`      → ['auth']  (array-key=>value form)
 *   - `'middleware' => ['a', 'b']`  → ['a', 'b']
 *   - `'auth:api'`                  → ['auth:api']  (preserves parameterised form)
 */
function extractLaravelMiddlewareArg(argSource: string): string[] {
    // If the source contains an array literal with `middleware` key,
    // extract that sub-array.
    const mwKey = /['"]middleware['"]\s*=>\s*(\[[^\]]*\]|['"][^'"]+['"])/i.exec(argSource);
    const target = mwKey ? mwKey[1] : argSource;
    const out: string[] = [];
    const strRe = /['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = strRe.exec(target)) !== null) {
        const val = m[1].trim();
        // Skip the `middleware` keyword itself if it leaked in.
        if (val === 'middleware') continue;
        if (!out.includes(val)) out.push(val);
    }
    return out;
}

