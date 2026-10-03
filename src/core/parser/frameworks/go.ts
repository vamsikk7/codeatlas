/**
 * frameworks/go.ts — Go web framework plugin
 * (Issue #703, Phase 2 PR-15.)
 *
 * Covers Gin, Echo, Chi, Fiber, and the standard library's `net/http`.
 * All four frameworks share the same call-site shape, differing only
 * in verb casing (Gin/Echo use uppercase `GET/POST/...`, Chi/Fiber use
 * mixed-case `Get/Post/...`).
 *
 * Three patterns:
 *   1. Gin / Echo — `<receiver>.GET("/path", handler)` with
 *      uppercase verb. The receiver allowlist used to be limited to
 *      `r|router|group|engine|g` (Issue 357 broadened it). False
 *      positives from stdlib receivers (`http.`, `client.`, …) are
 *      rejected by the explicit blocklist.
 *   2. Chi / Fiber — `<receiver>.Get("/path", h)` with mixed-case
 *      verb, plus `Handle` / `HandleFunc` / Fiber's `All` wildcard.
 *      Same receiver blocklist.
 *   3. `net/http` — `http.HandleFunc("/path", handler)` /
 *      `http.Handle("/path", handler)`. Method is always GET (the
 *      stdlib mux is verb-agnostic; we emit GET as the conventional
 *      sentinel).
 *
 * The `goExtract` helper detects inline `func(...)` closures as the
 * second argument and emits `anonymous@<METHOD>:<route>` so the
 * orchestrator's anon-handler path picks up the closure body via
 * `findGoRouteBody`. The helper is defined locally to keep the plugin
 * self-contained (it's only used here).
 *
 * Suppression: Go patterns are not in any pre-#703 suppression set.
 * No flags applied.
 */

import type { FrameworkPlugin } from './types';

function goExtract(method: string, route: string, m: RegExpMatchArray): { method: string; route: string; handlerName?: string } {
    const tail = m.input?.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 60) ?? '';
    if (/^\s*,\s*func\s*\(/.test(tail)) {
        return { method, route, handlerName: `anonymous@${method}:${route}` };
    }
    return { method, route };
}

/**
 * #928 — parse a gorilla/mux `.Methods(...)` argument list into uppercase HTTP
 * verbs. Handles `http.MethodGet` constants AND `"GET"` literals; returns
 * `['ANY']` when the chain is absent (a verb-agnostic HandleFunc).
 */
function parseGoMethods(raw: string | undefined): string[] {
    if (!raw || !raw.trim()) return ['ANY'];
    const out: string[] = [];
    const re = /http\.Method(\w+)|"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)"|\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gi;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(raw)) !== null) {
        const v = (mm[1] || mm[2] || mm[3] || '').toUpperCase();
        if (v) out.push(v);
    }
    return out.length ? [...new Set(out)] : ['ANY'];
}

const GO_STDLIB_RECEIVERS = /^(?:http|client|tls|os|io|fmt|json|errors|strings|bytes|context|time|log|sync|sort)$/i;

export const goPlugin: FrameworkPlugin = {
    id: 'go',
    name: 'Go (Gin / Echo / Chi / Fiber / net/http)',
    languages: ['go'],
    patterns: [
        // Gin / Echo: <var>.GET("/path", handler)
        // #900 — `Handle` is deliberately NOT in this alternation; it's matched by
        // the Chi/Fiber pattern below (which maps it to a bucketed method). Having
        // it here too made `r.Handle(...)` match twice and emit the undocumented
        // `HANDLE` method.
        {
            callPattern: /\b(\w+)\s*\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any)\s*\(\s*"([^"]*)"/g,
            extract: (m) => {
                const recv = m[1];
                if (GO_STDLIB_RECEIVERS.test(recv)) return null;
                return goExtract(m[2].toUpperCase(), m[3] || '/', m);
            },
        },
        // Chi / Fiber: <var>.Get("/path", h) — mixed-case + Handle/HandleFunc + Fiber's All wildcard.
        {
            callPattern: /\b(\w+)\s*\.\s*(Get|Post|Put|Patch|Delete|Head|Options|Handle|HandleFunc|All)\s*\(\s*"([^"]*)"/g,
            extract: (m) => {
                const recv = m[1];
                if (GO_STDLIB_RECEIVERS.test(recv)) return null;
                const verb = m[2];
                // #900 — `Handle`/`HandleFunc` register a catch-all handler for any
                // verb → map to the documented `ANY` bucket (not an undocumented `HANDLE`).
                const method = (verb === 'Handle' || verb === 'HandleFunc') ? 'ANY' : verb.toUpperCase();
                return goExtract(method, m[3] || '/', m);
            },
        },
        // net/http: http.HandleFunc("/path", handler) / http.Handle(...)
        {
            callPattern: /\bhttp\s*\.\s*(HandleFunc|Handle)\s*\(\s*"([^"]+)"/g,
            extract: (m) => goExtract('GET', m[2], m),
        },
        // gorilla/mux: <router>.HandleFunc(base+"/path", h).Methods(http.MethodGet, …).
        // #928 — the route is built by STRING CONCATENATION (`baseUrl+"/cart"`),
        // which the literal-first-arg Chi/Fiber pattern above can't match, AND the
        // real verb comes from a chained `.Methods(...)`, not the call name. The
        // required `<ident> +` prefix means this never double-matches the literal
        // Chi/Fiber form (so it's gorilla-concat-specific).
        {
            callPattern: /\b(\w+)\s*\.\s*HandleFunc\s*\(\s*[\w.]+\s*\+\s*"([^"]*)"[^)]*\)\s*(?:\.\s*Methods\s*\(([^)]*)\))?/g,
            extract: (m) => {
                const recv = m[1];
                if (GO_STDLIB_RECEIVERS.test(recv)) return null;
                const route = m[2] || '/';
                const methods = parseGoMethods(m[3]);
                return { method: methods[0], route, extraMethods: methods.slice(1) };
            },
        },
    ],
};
