/**
 * middlewareTaggers/symfony.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Per-framework middleware tagger split from `middlewareTaggers.ts`.
 * See sibling files + `./index.ts` for the full set.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * UX-47 (2026-06-05) — Symfony PHP-attribute security. `#[IsGranted]`
 * and `#[Security]` sit directly above the `#[Route]` attribute on a
 * controller action and authorize that route. We walk backward from
 * each Symfony route's `#[Route(...)]` offset for sibling `#[IsGranted]`
 * / `#[Security]` attributes.
 *
 * Class-level `#[IsGranted]` (above the `class Foo` line) applies to
 * every action in the class.
 *
 * Auth derivation: both attributes set `meta.auth = 'required'`.
 */
const SYMFONY_SECURITY_ATTRS = new Set(['IsGranted', 'Security']);

export function tagSymfonyAttributes(apis: ApiRecord[], source: string): void {
    if (apis.length === 0) return;

    // Pre-collect class-level Symfony attributes.
    const classAttrsByPos = new Map<number, string[]>();
    const phpClassRe = /^\s*(?:final|abstract|readonly|\s)*class\s+\w+/gm;
    let cm: RegExpExecArray | null;
    while ((cm = phpClassRe.exec(source)) !== null) {
        const attrs = collectSymfonyAttributesBefore(source, cm.index);
        if (attrs.length > 0) classAttrsByPos.set(cm.index, attrs);
    }

    for (const api of apis) {
        if (!/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ROUTE|ANY)$/.test(api.method)) continue;
        const off = api.anchor?.span?.start ?? 0;
        const methodAttrs = collectSymfonyAttributesBefore(source, off);

        // Enclosing class — find the nearest class start preceding this route.
        let classAttrs: string[] = [];
        let nearestClassStart = -1;
        for (const [pos] of classAttrsByPos) {
            if (pos < off && pos > nearestClassStart) nearestClassStart = pos;
        }
        if (nearestClassStart >= 0) classAttrs = classAttrsByPos.get(nearestClassStart) ?? [];

        const merged: string[] = [];
        for (const a of classAttrs) if (!merged.includes(a)) merged.push(a);
        for (const a of methodAttrs) if (!merged.includes(a)) merged.push(a);
        if (merged.length === 0) continue;

        api.meta = api.meta ?? {};
        const existing = api.meta.middlewares ?? [];
        const out = [...merged];
        for (const mw of existing) if (!out.includes(mw)) out.push(mw);
        api.meta.middlewares = out;
        if (!api.meta.auth) api.meta.auth = 'required';
    }
}

export function collectSymfonyAttributesBefore(source: string, offset: number): string[] {
    const start = Math.max(0, offset - 600);
    const window = source.slice(start, offset);
    const lines = window.split('\n').reverse();
    const out: string[] = [];
    let inAttrStreak = true;
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
            if (out.length > 0) inAttrStreak = false;
            continue;
        }
        if (!inAttrStreak) break;
        const m = /^#\[([^\]]+)\]\s*(?:\/\/.*)?$/.exec(trimmed);
        if (!m) break;
        const inner = `#[${m[1]}]`;
        const attrRe = /#\[([\w\\]+)(?:\s*\(([^)]*)\))?\]/g;
        const lineAttrs: string[] = [];
        let am: RegExpExecArray | null;
        while ((am = attrRe.exec(inner)) !== null) {
            const name = am[1].includes('\\') ? am[1].split('\\').pop()! : am[1];
            // Skip the route attribute itself.
            if (name === 'Route' || name === 'AsCommand') continue;
            if (!SYMFONY_SECURITY_ATTRS.has(name)) continue;
            const args = am[2]?.trim();
            const label = args ? `${name}(${args})` : name;
            if (!lineAttrs.includes(label)) lineAttrs.push(label);
        }
        for (let i = lineAttrs.length - 1; i >= 0; i--) {
            if (!out.includes(lineAttrs[i])) out.unshift(lineAttrs[i]);
        }
    }
    return out;
}

