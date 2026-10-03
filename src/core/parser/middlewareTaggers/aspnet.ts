/**
 * middlewareTaggers/aspnet.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Per-framework middleware tagger split from `middlewareTaggers.ts`.
 * See sibling files + `./index.ts` for the full set.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * UX-45 (2026-06-05) — ASP.NET Core attribute-based middleware.
 *
 * The Http* route detector anchors at `[HttpGet("/path")]`. Sibling
 * attributes that affect the request lifecycle stack ABOVE that
 * attribute (same-block in C# convention). We walk back ~400 chars
 * and collect every `[<Name>(...)]` we find, stopping at a blank line
 * or non-attribute statement.
 *
 * Class-level attributes (above `class Foo : ControllerBase`) apply
 * to every action in the class; method-level `[AllowAnonymous]`
 * overrides class-level `[Authorize]` for that route only.
 */
const ASPNET_MIDDLEWARE_ATTRS = new Set([
    'Authorize',
    'AllowAnonymous',
    'ServiceFilter',
    'TypeFilter',
    'ValidateAntiForgeryToken',
    'IgnoreAntiforgeryToken',
    'EnableRateLimiting',
    'DisableRateLimiting',
    'EnableCors',
    'DisableCors',
    'ResponseCache',
    'RequireHttps',
    'AutoValidateAntiforgeryToken',
]);

export function tagAspNetAttributes(apis: ApiRecord[], source: string): void {
    if (apis.length === 0) return;

    // Pre-collect class-level attributes per class. Walk every `class Foo`
    // and look at the attributes immediately preceding it.
    const classAttrsByPos = new Map<number, string[]>();
    const classRe = /^\s*(?:public|private|protected|internal|sealed|abstract|static|partial|\s)*class\s+\w+/gm;
    let cm: RegExpExecArray | null;
    while ((cm = classRe.exec(source)) !== null) {
        const classStart = cm.index;
        const attrs = collectAspNetAttributesBefore(source, classStart);
        if (attrs.length > 0) classAttrsByPos.set(classStart, attrs);
    }

    for (const api of apis) {
        if (!/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(api.method)) continue;
        const off = api.anchor?.span?.start ?? 0;

        const methodAttrs = collectAspNetAttributesBefore(source, off);

        // Enclosing class — find the nearest `class` keyword preceding
        // the route offset.
        let classAttrs: string[] = [];
        let nearestClassStart = -1;
        for (const [pos] of classAttrsByPos) {
            if (pos < off && pos > nearestClassStart) nearestClassStart = pos;
        }
        if (nearestClassStart >= 0) classAttrs = classAttrsByPos.get(nearestClassStart) ?? [];

        // Order: class-level outer first, then method-level.
        const merged: string[] = [];
        for (const a of classAttrs) if (!merged.includes(a)) merged.push(a);
        for (const a of methodAttrs) if (!merged.includes(a)) merged.push(a);
        if (merged.length === 0) continue;

        api.meta = api.meta ?? {};
        const existing = api.meta.middlewares ?? [];
        const out = [...merged];
        for (const mw of existing) if (!out.includes(mw)) out.push(mw);
        api.meta.middlewares = out;

        // Auth derivation: method-level [AllowAnonymous] wins, then
        // [Authorize] at either level, otherwise leave undefined.
        if (methodAttrs.some(a => a === 'AllowAnonymous' || a.startsWith('AllowAnonymous'))) {
            api.meta.auth = 'optional';
        } else if (out.some(a => a === 'Authorize' || a.startsWith('Authorize'))) {
            if (!api.meta.auth) api.meta.auth = 'required';
        }
    }
}

/**
 * Walk backward from `offset` collecting `[<Name>(...)]` attributes.
 * Stops at: blank line, statement terminator (`;`), opening brace of
 * a method/class body, or a non-attribute non-whitespace token.
 *
 * The captured `<Name>` segment loses its `(...)` args for the bare
 * comparison (so `Authorize(Roles="Admin")` → `Authorize`), but the
 * full attribute text (without brackets) is also pushed so the L3
 * weaver can render the qualified form.
 */
export function collectAspNetAttributesBefore(source: string, offset: number): string[] {
    const start = Math.max(0, offset - 600);
    const window = source.slice(start, offset);
    const lines = window.split('\n').reverse();
    const out: string[] = [];
    let inAttrStreak = true;
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
            // Blank line ends the attribute streak only AFTER we've seen
            // at least one attribute (helps tolerate a blank above the
            // first attribute in the route's lookback).
            if (out.length > 0) inAttrStreak = false;
            continue;
        }
        if (!inAttrStreak) break;
        const m = /^\[([^\]]+)\]\s*(?:\/\/.*)?$/.exec(trimmed);
        if (!m) {
            // Non-attribute → stop walking back.
            break;
        }
        // Some lines have multiple attributes: `[A][B]`.
        const inner = `[${m[1]}]`;
        const attrRe = /\[([\w.]+)(?:\s*\(([^)]*)\))?\]/g;
        let am: RegExpExecArray | null;
        const lineAttrs: string[] = [];
        while ((am = attrRe.exec(inner)) !== null) {
            const name = am[1];
            // Skip the HTTP route attribute itself.
            if (/^Http(?:Get|Post|Put|Patch|Delete|Head|Options)$/.test(name)) continue;
            if (/^Route$/.test(name)) continue;
            // Only keep attributes that look like middleware.
            if (!ASPNET_MIDDLEWARE_ATTRS.has(name)) continue;
            const args = am[2]?.trim();
            const label = args ? `${name}(${args})` : name;
            if (!lineAttrs.includes(label)) lineAttrs.push(label);
        }
        // Reverse-line order: prepend to maintain source order.
        for (let i = lineAttrs.length - 1; i >= 0; i--) {
            if (!out.includes(lineAttrs[i])) out.unshift(lineAttrs[i]);
        }
    }
    return out;
}

