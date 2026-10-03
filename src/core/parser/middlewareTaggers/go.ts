/**
 * middlewareTaggers/go.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Per-framework middleware tagger split from `middlewareTaggers.ts`.
 * See sibling files + `./index.ts` for the full set.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * UX-41 (2026-06-05) — Go middleware chains for Gin / Echo / Chi /
 * Fiber.
 *
 * Captures `<recv>.Use(arg1, arg2, ...)` calls and attaches each
 * parsed middleware reference to every HTTP route registered on the
 * SAME receiver `<recv>`. Args are recognised in four forms:
 *
 *   - bare identifier: `jwtAuth`            → `jwtAuth`
 *   - call: `AuthMiddleware()`              → `AuthMiddleware`
 *   - member: `middleware.Logger`           → `middleware.Logger`
 *   - member call: `gin.Recovery()`         → `gin.Recovery`
 *
 * Auth derivation: any middleware whose bare name matches
 * `Jwt.*` / `Auth.*` / `RequireAuth.*` / `BasicAuth.*` /
 * `BearerAuth.*` / `OAuth.*` sets `meta.auth = 'required'`.
 *
 * V1 scope: only `.Use(...)` chains on the SAME receiver as the
 * route. Group middleware (`router.Group("/api", mw)`) and per-route
 * varargs (`r.GET("/x", mw1, h)`) land in follow-up.
 */
const GO_USE_RE = /\b(\w+)\s*\.\s*Use\s*\(([^)]*)\)/g;
const GO_VERB_AFTER_OFFSET_RE = /^(\w+)\s*\.\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Get|Post|Put|Patch|Delete|Head|Options|Any|Handle|HandleFunc|All)\b/;
const GO_AUTH_MIDDLEWARE_RE = /^(?:.*[Jj]wt|.*[Aa]uth|RequireAuth|BasicAuth|BearerAuth|OAuth|RequireLogin)/;

// UX-41 Phase 2 (2026-06-05) — Go group middleware. The Gin / Chi /
// Fiber / Echo group constructor takes a path then varargs of
// middleware: `group := r.Group("/api", mw1, mw2)`. Routes registered
// on `group` should pick up `mw1, mw2`. We track the group variable
// name and the middlewares from its declaration.
const GO_GROUP_RE = /\b(\w+)\s*:?=\s*(\w+)\s*\.\s*Group\s*\(\s*"[^"]*"\s*((?:,\s*[^)]+)?)\)/g;

// UX-41 Phase 2 (2026-06-05) — per-route varargs.
// `r.GET("/admin", mw1, mw2, handler)` — args after the path are
// middlewares + handler. Last arg is the handler. We capture the full
// arg list and the regex passes it through `parseGoUseArgs`-like
// tokenization, then drop the LAST entry as the handler.
const GO_ROUTE_VARARGS_RE = /\b(\w+)\s*\.\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Get|Post|Put|Patch|Delete|Head|Options|Any|Handle|HandleFunc|All)\s*\(\s*"([^"]*)"\s*,\s*([^)]+)\)/g;

export function tagGoMiddleware(apis: ApiRecord[], source: string): void {
    if (apis.length === 0) return;

    // Map<receiver, middlewareNames[]> — source-order. Tracks
    // both `.Use(...)` and Phase 2 `.Group("/path", mw...)` middlewares
    // keyed by the receiver name (or the group variable name).
    const mwsByReceiver = new Map<string, string[]>();
    const append = (recv: string, names: string[]) => {
        if (names.length === 0) return;
        const list = mwsByReceiver.get(recv) ?? [];
        for (const name of names) if (!list.includes(name)) list.push(name);
        mwsByReceiver.set(recv, list);
    };

    GO_USE_RE.lastIndex = 0;
    let um: RegExpExecArray | null;
    while ((um = GO_USE_RE.exec(source)) !== null) {
        const argsRaw = um[2].trim();
        if (!argsRaw) continue;
        const parsed = parseGoUseArgs(argsRaw);
        append(um[1], parsed);
    }

    // UX-41 Phase 2 — Group middleware. `group := parent.Group("/p", mw...)`
    // makes `group` carry every mw listed after the path. Routes
    // registered on `group` pick them up via the normal receiver
    // mapping below.
    GO_GROUP_RE.lastIndex = 0;
    let gm: RegExpExecArray | null;
    while ((gm = GO_GROUP_RE.exec(source)) !== null) {
        const groupVar = gm[1];
        const tailArgs = (gm[3] ?? '').trim();
        if (!tailArgs) continue;
        // tailArgs starts with `,` because the path is followed by `, mw1, mw2`.
        const mwArgs = tailArgs.replace(/^,/, '').trim();
        if (!mwArgs) continue;
        const parsed = parseGoUseArgs(mwArgs);
        append(groupVar, parsed);
    }

    // UX-41 Phase 2 — per-route varargs. `r.GET("/path", mw1, mw2, handler)`.
    // Track per-api so we can append directly to the matching ApiRecord.
    const varargsByRoute = new Map<string, string[]>(); // key: `recv:METHOD:path`
    GO_ROUTE_VARARGS_RE.lastIndex = 0;
    let vm: RegExpExecArray | null;
    while ((vm = GO_ROUTE_VARARGS_RE.exec(source)) !== null) {
        const recv = vm[1];
        const routePath = vm[2];
        const tailArgs = (vm[3] ?? '').trim();
        if (!tailArgs) continue;
        // Drop the LAST token (the handler).
        const tokens = parseGoUseArgs(tailArgs);
        if (tokens.length < 2) continue; // need ≥1 middleware + handler
        const varargsMws = tokens.slice(0, -1);
        varargsByRoute.set(`${recv}:${routePath}`, varargsMws);
    }

    for (const api of apis) {
        if (!api.filePath || !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|HANDLE)$/.test(api.method)) continue;
        const off = api.anchor?.span?.start ?? 0;
        const head = source.slice(off, Math.min(source.length, off + 80));
        const m = GO_VERB_AFTER_OFFSET_RE.exec(head);
        if (!m) continue;
        const recv = m[1];

        const receiverMws = mwsByReceiver.get(recv) ?? [];
        const varargsMws = varargsByRoute.get(`${recv}:${api.route}`) ?? [];
        const allMws = [...receiverMws, ...varargsMws];
        if (allMws.length === 0) continue;

        api.meta = api.meta ?? {};
        const existing = api.meta.middlewares ?? [];
        const merged: string[] = [];
        for (const mw of allMws) if (!merged.includes(mw)) merged.push(mw);
        for (const mw of existing) if (!merged.includes(mw)) merged.push(mw);
        api.meta.middlewares = merged;

        if (!api.meta.auth) {
            for (const mw of allMws) {
                const bare = mw.includes('.') ? mw.split('.').pop()! : mw;
                if (GO_AUTH_MIDDLEWARE_RE.test(bare) || GO_AUTH_MIDDLEWARE_RE.test(mw)) {
                    api.meta.auth = 'required';
                    break;
                }
            }
        }
    }
}

/**
 * Parse the inside-the-parens of a Go `.Use(...)` call into a list of
 * middleware references. Tolerant of:
 *   - comma-separated args:    `a, b, c`
 *   - whitespace/newlines:     `a,\n\tb`
 *   - function calls:          `Foo()` → `Foo`
 *   - member access:           `pkg.Sym` → `pkg.Sym`
 *   - member-call:             `pkg.Sym()` → `pkg.Sym`
 *
 * Discards inline anonymous functions (`func(c) {...}`), variadic
 * spreads (`mws...`), and anything that doesn't parse as a clean
 * identifier or dotted identifier.
 */
export function parseGoUseArgs(argsRaw: string): string[] {
    const out: string[] = [];
    // Split on top-level commas. We assume the (...) of a function
    // call is already stripped (we captured `[^)]*` in GO_USE_RE).
    // That means nested function calls inside .Use() args (e.g.
    // `gin.Recovery()`) lose the `()` entirely, leaving `gin.Recovery`
    // — which is what we want.
    const parts = argsRaw.split(',').map(p => p.trim()).filter(Boolean);
    for (const p of parts) {
        // Skip anonymous functions
        if (/^func\s*\(/.test(p)) continue;
        // Strip trailing `...` (variadic) and trailing `(` from
        // truncated function calls.
        let name = p.replace(/\.\.\.$/, '').replace(/\($/, '').trim();
        // Accept dotted identifiers like `pkg.Sym` or `pkg.Sub.Sym`.
        if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(name)) continue;
        if (!out.includes(name)) out.push(name);
    }
    return out;
}

