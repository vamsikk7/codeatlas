/**
 * middlewareTaggers/sinatra.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Per-framework middleware tagger split from `middlewareTaggers.ts`.
 * See sibling files + `./index.ts` for the full set.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * UX-47 (2026-06-05) — Sinatra `before` hooks. Single-file Sinatra
 * apps register routes (`get '/x' do ... end`) at the top level
 * alongside `before do ... end` hooks. The hook applies to EVERY
 * route in the file (path-filtered variants `before '/admin/*' do`
 * apply only to matching routes — collected separately).
 *
 * The hook body is opaque to us; we tag a synthetic
 * `'sinatra:before'` / `'sinatra:after'` participant so the L3
 * sequence renders something meaningful. Path-filtered variants
 * use `'sinatra:before(/glob)'`.
 */
const SINATRA_HOOK_RE = /^\s*(before|after)\s*(?:['"]([^'"]+)['"]\s*)?do\b/gm;

export function tagSinatraBeforeHooks(apis: ApiRecord[], source: string): void {
    if (apis.length === 0) return;

    const globalHooks: string[] = [];
    const pathHooks: Array<{ pathPattern: RegExp; name: string }> = [];

    SINATRA_HOOK_RE.lastIndex = 0;
    let hm: RegExpExecArray | null;
    while ((hm = SINATRA_HOOK_RE.exec(source)) !== null) {
        const kind = hm[1];
        const glob = hm[2];
        if (glob) {
            // `before '/admin/*' do` — convert glob to a regex.
            const pattern = new RegExp('^' + glob.replace(/\*/g, '.*') + '$');
            pathHooks.push({ pathPattern: pattern, name: `sinatra:${kind}(${glob})` });
        } else {
            const name = `sinatra:${kind}`;
            if (!globalHooks.includes(name)) globalHooks.push(name);
        }
    }

    if (globalHooks.length === 0 && pathHooks.length === 0) return;

    for (const api of apis) {
        if (!/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(api.method)) continue;
        const matches: string[] = [...globalHooks];
        for (const ph of pathHooks) {
            if (ph.pathPattern.test(api.route)) {
                if (!matches.includes(ph.name)) matches.push(ph.name);
            }
        }
        if (matches.length === 0) continue;
        api.meta = api.meta ?? {};
        const existing = api.meta.middlewares ?? [];
        const out = [...matches];
        for (const mw of existing) if (!out.includes(mw)) out.push(mw);
        api.meta.middlewares = out;
    }
}

