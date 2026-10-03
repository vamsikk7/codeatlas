/**
 * middlewareTaggers/rust.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Per-framework middleware tagger split from `middlewareTaggers.ts`.
 * See sibling files + `./index.ts` for the full set.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * UX-46 (2026-06-05) — Rust middleware chains.
 *
 * Captures three idioms:
 *   - Actix: `.wrap(Logger::default())` / `.wrap(AuthMiddleware)`
 *   - Axum:  `.layer(TraceLayer::new_for_http())` / `.layer(JwtLayer)`
 *   - Rocket: `.attach(Fairing::new())` / `.attach(LoggingFairing)`
 *
 * Arguments are normalized to the type stem — `Logger::default()` →
 * `Logger`, `JwtAuthLayer::new()` → `JwtAuthLayer`, bare identifier
 * kept as-is. Anonymous closures and unrecognised forms are skipped.
 *
 * Auth derivation: names matching `*Auth*` / `*Jwt*` / `*Bearer*` /
 * `RequireAuth*` set `meta.auth = 'required'`.
 */
const RUST_MIDDLEWARE_CALL_RE = /\.\s*(wrap|layer|attach)\s*\(\s*([^()]*(?:\([^()]*\)[^()]*)?)\s*\)/g;
const RUST_AUTH_MIDDLEWARE_RE = /(?:Auth|Jwt|Bearer|RequireAuth|OAuth|Session|Login)/i;

export function tagRustMiddleware(apis: ApiRecord[], source: string): void {
    if (apis.length === 0) return;

    const middlewares: string[] = [];
    RUST_MIDDLEWARE_CALL_RE.lastIndex = 0;
    let rm: RegExpExecArray | null;
    while ((rm = RUST_MIDDLEWARE_CALL_RE.exec(source)) !== null) {
        const argRaw = rm[2].trim();
        const name = normalizeRustMiddlewareArg(argRaw);
        if (!name) continue;
        if (!middlewares.includes(name)) middlewares.push(name);
    }
    if (middlewares.length === 0) return;

    let auth: 'required' | undefined;
    for (const mw of middlewares) {
        if (RUST_AUTH_MIDDLEWARE_RE.test(mw)) {
            auth = 'required';
            break;
        }
    }

    for (const api of apis) {
        if (!/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(api.method)) continue;
        api.meta = api.meta ?? {};
        const existing = api.meta.middlewares ?? [];
        const out = [...middlewares];
        for (const mw of existing) if (!out.includes(mw)) out.push(mw);
        api.meta.middlewares = out;
        if (auth && !api.meta.auth) api.meta.auth = auth;
    }
}

function normalizeRustMiddlewareArg(arg: string): string | null {
    if (!arg) return null;
    // Skip closures and async blocks.
    if (/^\s*\|/.test(arg) || /^\s*move\s/.test(arg) || /^\s*async\s/.test(arg)) return null;
    // Strip trailing function/method call: `Foo::new()` → `Foo`.
    // Strip the `::` chain so we keep the leaf type stem.
    let token = arg;
    // Drop everything from the first `(` onward.
    const parenIdx = token.indexOf('(');
    if (parenIdx >= 0) token = token.slice(0, parenIdx);
    token = token.trim();
    // `Logger::default` → `Logger`; `mod::sub::Foo` → `Foo`.
    if (token.includes('::')) token = token.split('::')[0];
    // Sanity: keep only valid identifier-looking tokens.
    if (!/^[A-Za-z_][\w]*$/.test(token)) return null;
    return token;
}

