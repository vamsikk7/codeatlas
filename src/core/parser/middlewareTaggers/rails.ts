/**
 * middlewareTaggers/rails.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Per-framework middleware tagger split from `middlewareTaggers.ts`.
 * See sibling files + `./index.ts` for the full set.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * UX-39 (2026-06-05) — Rails controller filters as middleware.
 *
 * `before_action :foo` / `after_action :foo` / `around_action :foo`
 * declared at the class level of a `*_controller.rb` file applies to
 * every action method in that controller. The FILTER pattern in
 * single-lang.ts already emits a FILTER record per filter (visible
 * in L2b Request Hooks); this pass additionally attaches each filter's
 * symbol name to `meta.middlewares` of every HTTP route defined in
 * the same source so the L3 sequence diagram renders them as
 * participants.
 *
 * Path-gated to controller files so that:
 *   - `before_save :foo` AR callbacks in `app/models/` don't bleed.
 *   - Top-level `get '/x' do` routes in non-controller files (rare in
 *     Rails proper, common in Sinatra apps) only pick up filters
 *     when the file basename matches `*_controller.rb`.
 *
 * Auth derivation: any filter whose bare name matches
 * `authenticate.*` / `require_user.*` / `require_auth.*` /
 * `require_login.*` sets `meta.auth = 'required'`.
 */
const RAILS_FILTER_RE = /^[ \t]*(?:before|after|around)_action\s+:(\w+[!?]?)/gm;
const RAILS_AUTH_FILTER_RE = /^(?:authenticate[_!]|require_user|require_login|require_auth|require_admin|authorize)/i;

export function tagRailsControllerFilters(apis: ApiRecord[], source: string, filePath: string): void {
    if (!/_controller\.rb$/.test(filePath)) return;

    // Collect filter symbol names in source order.
    const filters: string[] = [];
    RAILS_FILTER_RE.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = RAILS_FILTER_RE.exec(source)) !== null) {
        if (!filters.includes(fm[1])) filters.push(fm[1]);
    }
    if (filters.length === 0) return;

    let authRequired = false;
    for (const f of filters) {
        if (RAILS_AUTH_FILTER_RE.test(f)) {
            authRequired = true;
            break;
        }
    }

    for (const api of apis) {
        if (!/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(api.method)) continue;
        api.meta = api.meta ?? {};
        const existing = api.meta.middlewares ?? [];
        const merged = [...filters];
        for (const mw of existing) if (!merged.includes(mw)) merged.push(mw);
        api.meta.middlewares = merged;
        if (authRequired && !api.meta.auth) api.meta.auth = 'required';
    }
}

