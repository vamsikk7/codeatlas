/**
 * middlewareTaggers/fastapi.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Per-framework middleware tagger split from `middlewareTaggers.ts`.
 * See sibling files + `./index.ts` for the full set.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * Issue 419 follow-up — FastAPI auth dependencies.
 *
 * FastAPI routes opt into auth via `Depends()`. Two common shapes:
 *
 *   1. Decorator-level dependency list:
 *      @router.get("/users", dependencies=[Depends(get_current_active_superuser)])
 *      def read_users(...): ...
 *
 *   2. Parameter-level dependency in handler signature:
 *      def read_me(current_user: User = Depends(get_current_user)): ...
 *
 * Both forms imply the route is `auth.required`. We recognise common
 * auth-dependency function names (`get_current_user`, `current_user`,
 * `get_current_active_user`, `get_current_active_superuser`, `verify_token`,
 * `authenticate`, `is_authenticated`, `oauth2_scheme`, `JWTBearer`, etc.)
 * and stamp `meta.auth = 'required'` on the nearest route record.
 */
const FASTAPI_AUTH_DEP_NAMES = /^(?:get_)?(?:current(?:_active)?(?:_super)?_?user|verify_token|authenticate(?:_user)?|is_authenticated|get_active_user|oauth2_scheme|JWTBearer|require_auth|require_login)$/i;

export function tagFastApiAuthDependencies(apis: ApiRecord[], source: string): void {
    // UX-37 (2026-06-04): generalised from "auth-only" to "ALL
    // Depends() into meta.middlewares". Every `Depends(X)` near a
    // route is a participant in that route's request flow, not just
    // auth-shaped ones. The UX-30 weaver renders each as a participant
    // in the L3 sequence between the API Client and the handler.
    //
    // Index of decorator-pattern routes by source offset so we can
    // find the nearest one to each Depends() match. ApiRecord.anchor.
    // span.start already points at the route's source offset
    // (see addApi:2304-2316), so use that.
    const httpRoutes: Array<{ offset: number; api: ApiRecord }> = [];
    for (const a of apis) {
        if (a.filePath && /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(a.method)) {
            const off = a.anchor?.span?.start ?? 0;
            httpRoutes.push({ offset: off, api: a });
        }
    }
    if (httpRoutes.length === 0) return;

    // Scan source for every Depends(<name>) call. Allow dotted names
    // (`Depends(deps.get_db)`) and trailing args inside the inner
    // identifier — the parsed name is the bare identifier of the
    // dependency callable.
    const dependsPattern = /Depends\s*\(\s*([\w.]+)\s*[\),]/g;
    const allSignals: Array<{ offset: number; name: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = dependsPattern.exec(source)) !== null) {
        const depName = m[1];
        // Skip when the matched name is itself `Depends` (Depends(Depends(...))) — unlikely but defensive.
        if (depName === 'Depends') continue;
        allSignals.push({ offset: m.index, name: depName });
    }
    if (allSignals.length === 0) return;

    // Find the OWNING route for each Depends — the nearest route whose
    // offset precedes the Depends call within a 1024-char proximity
    // window. FastAPI handlers fit comfortably in that window.
    const PROXIMITY = 1024;
    for (const sig of allSignals) {
        let best: { api: ApiRecord; dist: number } | null = null;
        for (const r of httpRoutes) {
            const dist = Math.abs(r.offset - sig.offset);
            if (dist > PROXIMITY) continue;
            // Prefer signals that appear AFTER the route offset
            // (decorator arguments + handler signature both come after).
            if (sig.offset < r.offset) continue;
            if (!best || dist < best.dist) best = { api: r.api, dist };
        }
        if (!best) continue;

        // Attach the dependency name to meta.middlewares (dedupe).
        const api = best.api;
        api.meta = api.meta ?? {};
        const existing = api.meta.middlewares ?? [];
        if (!existing.includes(sig.name)) existing.push(sig.name);
        api.meta.middlewares = existing;

        // Preserve the prior auth-derivation: when the Depends name is
        // auth-shaped, stamp meta.auth = 'required' on the route. The
        // bare identifier from the last `.`-segment is checked so
        // `Depends(deps.get_current_user)` also fires.
        const bare = sig.name.includes('.') ? sig.name.split('.').pop()! : sig.name;
        if (
            (FASTAPI_AUTH_DEP_NAMES.test(sig.name) || FASTAPI_AUTH_DEP_NAMES.test(bare)) &&
            api.meta.auth !== 'required'
        ) {
            api.meta.auth = 'required';
        }
    }
}

