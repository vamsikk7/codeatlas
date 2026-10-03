/**
 * middlewareTaggers/spring.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Per-framework middleware tagger split from `middlewareTaggers.ts`.
 * See sibling files + `./index.ts` for the full set.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * Issue 419 follow-up — Spring Security annotations.
 *
 * Recognises:
 *   - `@PreAuthorize(...)` / `@PostAuthorize(...)` — method-level
 *   - `@Secured(...)` — method/class-level
 *   - `@RolesAllowed(...)` — JSR-250 method/class-level
 *   - `@PreFilter` / `@PostFilter` — implies auth context
 *   - `@PermitAll` — explicit public marker (sets auth='optional')
 *
 * For each annotation, find the nearest HTTP route by source offset and stamp
 * `meta.auth='required'` (or 'optional' for `@PermitAll`). Class-level
 * annotations apply to every route in the class body — within a 6000-char
 * window (typical controller size).
 */
const SPRING_AUTH_REQUIRED = /@(?:PreAuthorize|PostAuthorize|Secured|RolesAllowed|PreFilter|PostFilter)\s*\(/g;
const SPRING_AUTH_OPTIONAL = /@PermitAll\b/g;
// UX-35 (2026-06-05) — Spring middleware-like annotations that should
// surface as participants in L3 sequence diagrams. `@Transactional`
// wraps the handler in a DB transaction; `@PreAuthorize` etc. are
// authorization checks; `@Validated` triggers bean validation.
const SPRING_MIDDLEWARE_ANNOTATIONS = ['PreAuthorize', 'PostAuthorize', 'Secured', 'RolesAllowed', 'PreFilter', 'PostFilter', 'Transactional', 'Validated', 'CrossOrigin', 'Cacheable', 'CacheEvict'];
const SPRING_MIDDLEWARE_RE = new RegExp(`@(?:${SPRING_MIDDLEWARE_ANNOTATIONS.join('|')})\\b`, 'g');

export function tagSpringSecurityAnnotations(apis: ApiRecord[], source: string): void {
    const httpRoutes: Array<{ offset: number; api: ApiRecord }> = [];
    for (const a of apis) {
        if (/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(a.method)) {
            const off = a.anchor?.span?.start ?? 0;
            httpRoutes.push({ offset: off, api: a });
        }
    }
    if (httpRoutes.length === 0) return;

    // Method-level annotations sit DIRECTLY above the route's @GetMapping/etc.
    // (within ~400 chars). Class-level annotations sit at the top of the
    // controller and apply to every method below them — within ~6000 chars.
    const METHOD_PROXIMITY = 400;
    const CLASS_PROXIMITY = 6000;

    // Sort routes by offset so we can do nearest-following-route lookups.
    httpRoutes.sort((a, b) => a.offset - b.offset);

    const applySignal = (regex: RegExp, authValue: 'required' | 'optional') => {
        let m: RegExpExecArray | null;
        // eslint-disable-next-line no-cond-assign
        while ((m = regex.exec(source)) !== null) {
            const sigOffset = m.index;
            // Distinguish class-level vs method-level: look for `class ` in the
            // next ~6 lines after the annotation. Class-level annotations sit
            // directly above the class declaration; method-level annotations sit
            // above @GetMapping/etc.
            const lookahead = source.slice(sigOffset, Math.min(source.length, sigOffset + 600));
            const isClassLevel = /class\s+\w+/.test(lookahead.split('\n').slice(0, 6).join('\n'));

            if (isClassLevel) {
                // Apply to every route within the class body window.
                for (const r of httpRoutes) {
                    const dist = r.offset - sigOffset;
                    if (dist < 0 || dist > CLASS_PROXIMITY) continue;
                    if (r.api.meta?.auth === 'required') continue;
                    r.api.meta = { ...(r.api.meta ?? {}), auth: authValue };
                }
            } else {
                // Method-level: apply ONLY to the FIRST route after this annotation
                // (within the method-proximity window). Stops the annotation from
                // bleeding onto sibling unrelated routes.
                for (const r of httpRoutes) {
                    const dist = r.offset - sigOffset;
                    if (dist < 0) continue;
                    if (dist > METHOD_PROXIMITY) break; // routes are sorted by offset
                    if (r.api.meta?.auth === 'required') continue;
                    r.api.meta = { ...(r.api.meta ?? {}), auth: authValue };
                    break; // only the nearest following route
                }
            }
        }
    };

    applySignal(SPRING_AUTH_REQUIRED, 'required');
    applySignal(SPRING_AUTH_OPTIONAL, 'optional');

    // UX-35 (2026-06-05) — also capture every recognised Spring
    // middleware annotation into meta.middlewares so the L3 sequence
    // builder can render it as a participant. The auth flag stays as
    // the dedicated signal (set above); middlewares are the visual
    // chain. Class-level annotations apply to every route in the
    // class body window.
    let mm: RegExpExecArray | null;
    // Need a fresh regex instance per pass (the shared one keeps lastIndex).
    const middlewarePass = new RegExp(SPRING_MIDDLEWARE_RE.source, 'g');
    while ((mm = middlewarePass.exec(source)) !== null) {
        const sigOffset = mm.index;
        // The annotation name is the captured `@<Name>` minus the `@`.
        const annotationName = mm[0].slice(1);
        const lookahead = source.slice(sigOffset, Math.min(source.length, sigOffset + 600));
        const isClassLevel = /class\s+\w+/.test(lookahead.split('\n').slice(0, 6).join('\n'));

        const attach = (api: ApiRecord) => {
            api.meta = api.meta ?? {};
            const existing = api.meta.middlewares ?? [];
            if (!existing.includes(annotationName)) existing.push(annotationName);
            api.meta.middlewares = existing;
        };

        if (isClassLevel) {
            for (const r of httpRoutes) {
                const dist = r.offset - sigOffset;
                if (dist < 0 || dist > CLASS_PROXIMITY) continue;
                attach(r.api);
            }
        } else {
            // Method-level — apply only to the FIRST route after this annotation.
            for (const r of httpRoutes) {
                const dist = r.offset - sigOffset;
                if (dist < 0) continue;
                if (dist > METHOD_PROXIMITY) break;
                attach(r.api);
                break;
            }
        }
    }
}

