/**
 * middlewareTaggers/nestjs.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Per-framework middleware tagger split from `middlewareTaggers.ts`.
 * See sibling files + `./index.ts` for the full set.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * UX-34 (2026-06-04) — NestJS middleware decorators.
 *
 * NestJS exposes four decorators that declare the per-route middleware
 * chain:
 *   - `@UseGuards(JwtAuthGuard)`        — auth / authorization check
 *   - `@UseInterceptors(LoggingInterceptor)` — wraps handler (pre + post)
 *   - `@UsePipes(ValidationPipe)`       — transforms request data
 *   - `@UseFilters(HttpExceptionFilter)` — catches throws
 *
 * Both method-level (sibling to the route decorator) and class-level
 * (sibling to `@Controller`) usages are honoured. When BOTH are present,
 * class-level guards run BEFORE method-level (per NestJS semantics).
 *
 * Also stamps `meta.auth = 'required'` when any guard name looks like
 * an auth guard (`JwtAuthGuard`, `AuthGuard`, etc.).
 */
const NESTJS_MIDDLEWARE_DECORATORS = ['UseGuards', 'UseInterceptors', 'UsePipes', 'UseFilters'] as const;
const NESTJS_AUTH_GUARD_RE = /(?:^|\.)(Jwt|Auth|Authentication|Bearer|Basic|JwtAuth|Session|Api(?:Key)?|Token)(?:Auth)?Guard$/i;

export function tagNestJsMiddleware(apis: ApiRecord[], source: string): void {
    // Cheap skip: file must mention at least one of the decorators.
    if (!/@(UseGuards|UseInterceptors|UsePipes|UseFilters)\s*\(/.test(source)) return;

    // Class-level decorators apply to every method in the class. Build
    // a map of class start-offset → middleware names by scanning all
    // `@UseGuards(...)/@UseInterceptors(...)/...` that sit immediately
    // before an `export class` / `class` keyword.
    const classMws = collectNestJsClassMiddleware(source);

    // Find each route's method body span by scanning forward from the
    // route decorator's source offset for the first identifier followed
    // by `(` (the method name). The chain of sibling decorators sits
    // between the route decorator's offset and the method-name token.
    for (const api of apis) {
        if (!/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ALL|CONTROLLER)$/.test(api.method)) continue;
        if (api.method === 'CONTROLLER') continue; // class marker — no middleware on the prefix itself
        const routeOffset = api.anchor?.span?.start ?? 0;

        // Method-level: scan from the route decorator forward up to ~600
        // chars (typically all sibling decorators fit in that window).
        const window = source.slice(routeOffset, routeOffset + 800);
        const methodMws: string[] = [];
        for (const decoratorName of NESTJS_MIDDLEWARE_DECORATORS) {
            const re = new RegExp(`@${decoratorName}\\s*\\(([^)]*)\\)`, 'g');
            let m: RegExpExecArray | null;
            while ((m = re.exec(window)) !== null) {
                const args = m[1];
                // Args are a comma-separated list of identifiers (possibly
                // dotted member-access). Strip whitespace + split.
                const names = args.split(',').map(s => s.trim()).filter(Boolean);
                for (const n of names) {
                    // Strip arg list / new-call shape: `new XPipe()` → `XPipe`.
                    const cleaned = n.replace(/^new\s+/, '').replace(/\(.*$/, '').trim();
                    if (cleaned && !methodMws.includes(cleaned)) methodMws.push(cleaned);
                }
            }
        }

        // Class-level: which class does this route belong to? Find the
        // enclosing class by walking back from routeOffset looking for
        // the nearest `class` keyword. Use the same offset semantics as
        // `collectNestJsClassMiddleware` so the lookup hits.
        const classMwsForRoute: string[] = [];
        const classBeforeRe = /\bclass\s+\w+/g;
        let cm: RegExpExecArray | null;
        let lastClassKeywordIdx = -1;
        while ((cm = classBeforeRe.exec(source)) !== null) {
            if (cm.index >= routeOffset) break;
            lastClassKeywordIdx = cm.index;
        }
        if (lastClassKeywordIdx >= 0) {
            const entry = classMws.get(lastClassKeywordIdx);
            if (entry) classMwsForRoute.push(...entry);
        }

        // Merge: class first, method appended. Dedupe.
        const merged = [...classMwsForRoute];
        for (const mw of methodMws) {
            if (!merged.includes(mw)) merged.push(mw);
        }
        if (merged.length === 0) continue;

        api.meta = api.meta ?? {};
        const existing = api.meta.middlewares ?? [];
        api.meta.middlewares = [...existing];
        for (const mw of merged) {
            if (!api.meta.middlewares.includes(mw)) api.meta.middlewares.push(mw);
        }

        // Derive auth = required when ANY guard looks like an auth guard.
        if (!api.meta.auth) {
            for (const mw of merged) {
                if (NESTJS_AUTH_GUARD_RE.test(mw)) {
                    api.meta.auth = 'required';
                    break;
                }
            }
        }
    }
}

/**
 * Scan the source for class-level NestJS middleware decorators and
 * return a map keyed by the offset of the `class` keyword for the
 * decorated class. Caller looks up the entry whose offset is nearest
 * to (before) a given route to apply class-level middleware.
 */
export function collectNestJsClassMiddleware(source: string): Map<number, string[]> {
    const out = new Map<number, string[]>();
    // A class header looks like:
    //   `<decorators…> export class Foo` or `<decorators…> class Foo`.
    // The decorators are sibling lines preceding the class keyword.
    // We capture EVERY (?:export\s+)?class\s+\w+ match and scan backward
    // for the contiguous decorator block.
    const classRe = /\bclass\s+\w+/g;
    let m: RegExpExecArray | null;
    while ((m = classRe.exec(source)) !== null) {
        const classKeywordIdx = m.index;
        // Walk back up to 800 chars looking for decorator-block lines.
        const start = Math.max(0, classKeywordIdx - 800);
        const beforeBlock = source.slice(start, classKeywordIdx);
        const mws: string[] = [];
        for (const decoratorName of NESTJS_MIDDLEWARE_DECORATORS) {
            const re = new RegExp(`@${decoratorName}\\s*\\(([^)]*)\\)`, 'g');
            let dm: RegExpExecArray | null;
            while ((dm = re.exec(beforeBlock)) !== null) {
                const args = dm[1].split(',').map(s => s.trim()).filter(Boolean);
                for (const n of args) {
                    const cleaned = n.replace(/^new\s+/, '').replace(/\(.*$/, '').trim();
                    if (cleaned && !mws.includes(cleaned)) mws.push(cleaned);
                }
            }
        }
        if (mws.length > 0) out.set(classKeywordIdx, mws);
    }
    return out;
}

