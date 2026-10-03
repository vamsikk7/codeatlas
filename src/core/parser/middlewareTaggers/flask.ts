/**
 * middlewareTaggers/flask.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Per-framework middleware tagger split from `middlewareTaggers.ts`.
 * See sibling files + `./index.ts` for the full set.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * UX-38 (2026-06-05) — Flask middleware detection.
 *
 * Captures three families:
 *   1. **Per-view decorators** above the handler def — `@login_required`,
 *      `@jwt_required(...)`, `@cross_origin`, `@admin_required`,
 *      `@cache.cached(...)`, `@limiter.limit(...)`, `@auth.login_required`.
 *      Member-expression form (`@limiter.limit`) keeps the full
 *      `receiver.method` so L3 lifelines stay informative.
 *   2. **App-level hooks** — `@app.before_request` / `@app.after_request` /
 *      `@app.teardown_request`. Apply to every route in the file that
 *      registers on the same `app` receiver.
 *   3. **Blueprint-level hooks** — `@<bp>.before_request` etc. Apply
 *      only to routes whose route decorator uses the SAME `<bp>`
 *      receiver. Cross-file blueprint hooks are out of scope for v1.
 *
 * Auth derivation: any middleware whose bare name matches the auth
 * regex (`login_required`, `jwt_required`, `token_required`,
 * `auth_required`) sets `meta.auth = 'required'`.
 */
const FLASK_AUTH_DECORATORS = /^(?:login_required|jwt_required|token_required|auth_required|admin_required|roles_required|requires_auth)$/i;
const FLASK_HOOK_VERBS = ['before_request', 'after_request', 'teardown_request', 'before_first_request'];
const FLASK_ROUTE_VERBS = ['route', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'add_url_rule'];

export function tagFlaskMiddleware(apis: ApiRecord[], source: string): void {
    const routeVerbsAlt = FLASK_ROUTE_VERBS.join('|');
    const ROUTE_DECORATOR_HEAD_RE = new RegExp(`^@(\\w+)\\.(?:${routeVerbsAlt})\\b`);

    const httpRoutes: Array<{ offset: number; api: ApiRecord; receiver: string }> = [];
    for (const a of apis) {
        if (!a.filePath || !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(a.method)) continue;
        const off = a.anchor?.span?.start ?? 0;
        // For Flask, the route detector anchors at the `@<recv>.route(...)`
        // decorator. The receiver name is what we need for hook scoping.
        const tail = source.slice(off, Math.min(source.length, off + 200));
        const m = ROUTE_DECORATOR_HEAD_RE.exec(tail);
        if (!m) continue;
        httpRoutes.push({ offset: off, api: a, receiver: m[1] });
    }
    if (httpRoutes.length === 0) return;

    // File-level hooks: `@<recv>.before_request` def hook_name():
    // Result: Map<receiver, string[]> in source-order.
    const hooksByReceiver = new Map<string, string[]>();
    const hookVerbsAlt = FLASK_HOOK_VERBS.join('|');
    const hookRe = new RegExp(`@(\\w+)\\.(?:${hookVerbsAlt})\\s*\\b[^\\n]*\\n+\\s*def\\s+(\\w+)\\s*\\(`, 'g');
    let hm: RegExpExecArray | null;
    while ((hm = hookRe.exec(source)) !== null) {
        const recv = hm[1];
        const fnName = hm[2];
        const list = hooksByReceiver.get(recv) ?? [];
        if (!list.includes(fnName)) list.push(fnName);
        hooksByReceiver.set(recv, list);
    }

    // Per-view decorators sit BETWEEN the route decorator and the `def`
    // statement. Walk forward from the route decorator's offset,
    // capturing every `@<name>` until we hit `def` (or run out of window).
    // Line-based to avoid `\s*` eating newlines and merging decorators.
    const DECORATOR_LINE_RE = /^[ \t]*@(\w+(?:\.\w+)?)/;
    const SKIP_NAMES = /^(property|staticmethod|classmethod|wraps|cache|cached_property|dataclass|abstractmethod|override)$/;

    for (const r of httpRoutes) {
        const forward = source.slice(r.offset, Math.min(source.length, r.offset + 800));
        const lines = forward.split('\n');
        const perViewMws: string[] = [];
        for (const line of lines) {
            if (/^\s*(?:async\s+)?def\s+\w+\s*\(/.test(line)) break;
            const m = DECORATOR_LINE_RE.exec(line);
            if (!m) continue;
            const name = m[1];
            if (name.includes('.')) {
                const [recv, verb] = name.split('.');
                if (recv === r.receiver && FLASK_ROUTE_VERBS.includes(verb)) continue;
            }
            if (SKIP_NAMES.test(name)) continue;
            if (!perViewMws.includes(name)) perViewMws.push(name);
        }

        const hookMws = hooksByReceiver.get(r.receiver) ?? [];
        // Render order: file-level hooks first (they wrap the request),
        // then per-view decorators in source order.
        const merged: string[] = [];
        for (const mw of hookMws) if (!merged.includes(mw)) merged.push(mw);
        for (const mw of perViewMws) if (!merged.includes(mw)) merged.push(mw);
        if (merged.length === 0) continue;

        r.api.meta = r.api.meta ?? {};
        const existing = r.api.meta.middlewares ?? [];
        const out = [...existing];
        for (const mw of merged) if (!out.includes(mw)) out.push(mw);
        r.api.meta.middlewares = out;

        if (!r.api.meta.auth) {
            for (const mw of merged) {
                const bare = mw.includes('.') ? mw.split('.').pop()! : mw;
                if (FLASK_AUTH_DECORATORS.test(bare)) {
                    r.api.meta.auth = 'required';
                    break;
                }
            }
        }
    }
}

