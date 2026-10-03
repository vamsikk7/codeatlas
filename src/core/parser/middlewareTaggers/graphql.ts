/**
 * middlewareTaggers/graphql.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Per-framework middleware tagger split from `middlewareTaggers.ts`.
 * See sibling files + `./index.ts` for the full set.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * UX-43 (2026-06-05) — GraphQL SDL field directives.
 *
 * Walks each GraphQL route (QUERY/MUTATION/SUBSCRIPTION) and looks
 * for a matching SDL field definition in source. Field lines have
 * the shape `<fieldName>(<args>?): <Type> @directive1 @directive2(...)`.
 * Every `@<name>` token on the same line lands in `meta.middlewares`.
 *
 * Auth derivation when a directive name matches:
 *   `auth*` / `requireAuth` / `isAuthenticated` / `hasRole` / `requiresAuth`
 */
const GRAPHQL_AUTH_DIRECTIVE_RE = /^(?:auth|requireAuth|isAuthenticated|hasRole|requiresAuth|requiresScope|hasScope|hasPermission)/i;
const GRAPHQL_METHODS = new Set(['QUERY', 'MUTATION', 'SUBSCRIPTION']);

export function tagGraphqlDirectives(apis: ApiRecord[], source: string): void {
    if (apis.length === 0) return;
    const gqlRoutes = apis.filter(a => GRAPHQL_METHODS.has(a.method) && a.route && a.route !== '/');
    if (gqlRoutes.length === 0) return;

    const lines = source.split('\n');

    for (const api of gqlRoutes) {
        // SDL routes carry a leading `/` (e.g. `/secret`) when emitted
        // by the graphql plugin's type-block extractor; strip it to
        // match against the source field name.
        const fieldName = api.route.startsWith('/') ? api.route.slice(1) : api.route;
        if (!/^[A-Za-z_][\w]*$/.test(fieldName)) continue;
        // Find a line whose first non-whitespace token is the field name
        // followed by `(` (with args) or `:` (typed without args).
        const matcher = new RegExp(`^\\s*${fieldName}\\s*[(:]`);
        let fieldLine: string | null = null;
        for (const line of lines) {
            if (matcher.test(line)) {
                fieldLine = line;
                break;
            }
        }
        if (!fieldLine) continue;
        // Capture every `@<name>` on the line.
        const directives: string[] = [];
        const directiveRe = /@([A-Za-z_]\w*)/g;
        let dm: RegExpExecArray | null;
        while ((dm = directiveRe.exec(fieldLine)) !== null) {
            if (!directives.includes(dm[1])) directives.push(dm[1]);
        }
        if (directives.length === 0) continue;
        api.meta = api.meta ?? {};
        const existing = api.meta.middlewares ?? [];
        const out = [...directives];
        for (const mw of existing) if (!out.includes(mw)) out.push(mw);
        api.meta.middlewares = out;
        if (!api.meta.auth) {
            for (const d of directives) {
                if (GRAPHQL_AUTH_DIRECTIVE_RE.test(d)) {
                    api.meta.auth = 'required';
                    break;
                }
            }
        }
    }
}

