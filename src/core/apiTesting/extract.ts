/**
 * apiTesting/extract.ts — Issue #603 Phase 3 JSONPath-lite extractor.
 *
 * Pulls scalar / object / array values out of a response body so the
 * chain runner can map them into env vars between steps. Intentionally
 * not full JSONPath — we cover the patterns that real API chains use:
 *
 *   - `$.user.token`              — dot-path drill-in
 *   - `$.articles[0].slug`        — array index
 *   - `$.articles.*.id`           — array wildcard (returns array)
 *   - `$.data.token` / `data.token` — `$.` prefix optional
 *   - `headers.x-request-id`      — pseudo-paths into the response wrapper
 *
 * Pass `'json'` (the default) to walk the parsed JSON body. Pass
 * `'headers'` to walk the response headers map. Pass `'status'` to
 * read the numeric status code directly.
 *
 * Unknown / non-resolvable paths return `undefined`. The chain runner
 * treats `undefined` as "extraction failed, don't set the env var".
 */

export type ExtractScope = 'json' | 'headers' | 'status';

export interface ExtractContext {
    /** Response body. Pre-parsed when `scope === 'json'`. */
    body: unknown;
    headers: Record<string, string>;
    status: number;
}

export function extractValue(path: string, scope: ExtractScope, ctx: ExtractContext): unknown {
    // Status scope ignores `path` — the status code IS the value.
    if (scope === 'status') return ctx.status;
    if (!path) return undefined;
    if (scope === 'headers') {
        // Headers are case-insensitive by HTTP convention but Node's
        // global fetch lowercases on read, so we look up case-insensitively.
        const key = path.toLowerCase();
        for (const [k, v] of Object.entries(ctx.headers)) {
            if (k.toLowerCase() === key) return v;
        }
        return undefined;
    }
    // scope === 'json'
    const normalised = path.replace(/^\$\.?/, '');
    if (normalised === '') return ctx.body;
    return walkDotPath(ctx.body, normalised);
}

function walkDotPath(root: unknown, dotPath: string): unknown {
    const segments = tokenisePath(dotPath);
    let current: unknown = root;
    for (const seg of segments) {
        if (current == null) return undefined;
        if (seg.kind === 'key') {
            if (typeof current !== 'object' || Array.isArray(current)) return undefined;
            current = (current as Record<string, unknown>)[seg.name];
        } else if (seg.kind === 'index') {
            if (!Array.isArray(current)) return undefined;
            current = current[seg.index];
        } else if (seg.kind === 'wildcard') {
            if (!Array.isArray(current)) return undefined;
            // Apply the rest of the path to each element + collect.
            const remaining = segments.slice(segments.indexOf(seg) + 1);
            if (remaining.length === 0) return current;
            return current.map(item => walkPathSegments(item, remaining));
        }
    }
    return current;
}

function walkPathSegments(root: unknown, segments: PathSegment[]): unknown {
    let current: unknown = root;
    for (const seg of segments) {
        if (current == null) return undefined;
        if (seg.kind === 'key') {
            if (typeof current !== 'object' || Array.isArray(current)) return undefined;
            current = (current as Record<string, unknown>)[seg.name];
        } else if (seg.kind === 'index') {
            if (!Array.isArray(current)) return undefined;
            current = current[seg.index];
        } else if (seg.kind === 'wildcard') {
            if (!Array.isArray(current)) return undefined;
            return current.map(it => walkPathSegments(it, segments.slice(segments.indexOf(seg) + 1)));
        }
    }
    return current;
}

interface KeySegment    { kind: 'key';    name: string }
interface IndexSegment  { kind: 'index';  index: number }
interface WildcardSegment { kind: 'wildcard' }
type PathSegment = KeySegment | IndexSegment | WildcardSegment;

function tokenisePath(dotPath: string): PathSegment[] {
    const out: PathSegment[] = [];
    let i = 0;
    while (i < dotPath.length) {
        if (dotPath[i] === '.') { i++; continue; }
        if (dotPath[i] === '[') {
            const close = dotPath.indexOf(']', i);
            if (close < 0) return out;
            const inner = dotPath.slice(i + 1, close);
            if (inner === '*') out.push({ kind: 'wildcard' });
            else if (/^\d+$/.test(inner)) out.push({ kind: 'index', index: Number(inner) });
            else if (/^['"](.+)['"]$/.test(inner)) out.push({ kind: 'key', name: inner.slice(1, -1) });
            else out.push({ kind: 'key', name: inner });
            i = close + 1;
            continue;
        }
        // Plain identifier — read until `.` or `[`.
        const start = i;
        while (i < dotPath.length && dotPath[i] !== '.' && dotPath[i] !== '[') i++;
        const name = dotPath.slice(start, i);
        if (name === '*') out.push({ kind: 'wildcard' });
        else out.push({ kind: 'key', name });
    }
    return out;
}

/**
 * Try to parse a response body as JSON. Returns `undefined` when
 * parsing fails (the chain runner falls back to the raw string).
 */
export function tryParseJsonBody(body: string): unknown {
    if (!body) return undefined;
    try { return JSON.parse(body); } catch { return undefined; }
}
