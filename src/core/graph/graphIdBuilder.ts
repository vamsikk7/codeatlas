/**
 * graphIdBuilder.ts — Issue #362 Phase A (2026-06-07).
 *
 * Structured builder + parser for diagram graph ids. Eliminates the
 * ambiguity of `:` overloaded as both the type-prefix separator and
 * the parts separator inside a route key.
 *
 * The wire format stays unchanged for back-compat with state.db /
 * state.json archives:
 *
 *   feature:workspace                         → { type: 'feature', parts: ['workspace'] }
 *   feature:service:main                      → { type: 'feature', parts: ['service:main'] }
 *   sequence:src/a.ts:anonymous@GET:/users    → { type: 'sequence', parts: ['src/a.ts', 'anonymous@GET:/users'] }
 *   flow:src/a.ts:doThing                     → { type: 'flow', parts: ['src/a.ts', 'doThing'] }
 *   file:src/a.ts                             → { type: 'file', parts: ['src/a.ts'] }
 *   api-list:cluster:auth                     → { type: 'api-list', parts: ['cluster:auth'] }
 *   microservice:workspace                    → { type: 'microservice', parts: ['workspace'] }
 *
 * The PARSER does the hard work — it knows which graph types take how
 * many parts so it can re-assemble the trailing parts when the route
 * key contains its own colon (e.g. `anonymous@GET:/users` has 2 inner
 * colons that must stay glued to the 3rd parts slot, not split into
 * extra parts).
 *
 * Adding a new graph type is one line in `KNOWN_TYPES` below.
 *
 * Phase A is intentionally NON-MIGRATING — every existing string
 * concatenation keeps working. Phase B sweeps the read side; Phase C
 * sweeps the write side. See ISSUES.md #362 for the full plan.
 */

/**
 * Graph type prefixes the codebase emits today. New types are added
 * here; the parser uses this list to choose the right parts shape.
 *
 *   - 1 part: `file`, `api-list`, `microservice`, `feature`,
 *     `health`, `map`, `domain`, `tour`, `callGraph`.
 *   - 2 parts: `flow` (file + function), `sequence` (file + handler),
 *     `dependency-graph` (cluster + node), `screen` (file + screen).
 *
 * The graph `type` itself NEVER contains a colon, so the FIRST colon
 * in the id always separates `type` from the rest. The remainder is
 * then split based on the type's expected part count.
 */
const SINGLE_PART_TYPES = new Set<string>([
    'file',
    'api-list',
    'microservice',
    'feature',
    'health',
    'map',
    'domain',
    'tour',
    'callGraph',
    // BUG-POLAR-7: `screen-content:<screenId>` — the screenId (which may itself
    // contain colons, e.g. `screen:app:/home`) is kept whole as parts[0].
    'screen-content',
]);

const TWO_PART_TYPES = new Set<string>([
    'flow',
    'sequence',
    'dependency-graph',
    'screen',
]);

export type KnownGraphType =
    | 'file' | 'api-list' | 'microservice' | 'feature' | 'health' | 'map' | 'domain' | 'tour' | 'callGraph'
    | 'flow' | 'sequence' | 'dependency-graph' | 'screen' | 'screen-content';

export interface ParsedGraphId {
    type: string;
    /** Ordered list of route components. Trailing colons inside the LAST part are preserved. */
    parts: string[];
}

/**
 * Build a graph id from a type + parts. Empty / undefined parts
 * collapse to the empty string and are joined verbatim — so
 * `makeGraphId('feature', ['workspace'])` yields `feature:workspace`
 * exactly like the old string concat.
 *
 * Pre-existing `parts` that already contain colons are accepted
 * verbatim — the LAST part is the one allowed to carry inner colons
 * (the parser tolerates it). Intermediate parts SHOULD NOT contain
 * colons; if you find a builder caller that needs to, restructure
 * the type instead.
 */
export function makeGraphId(type: string, parts: string[]): string {
    if (!type) throw new Error('makeGraphId: type is required');
    if (!Array.isArray(parts)) throw new Error('makeGraphId: parts must be an array');
    return parts.length === 0 ? type : `${type}:${parts.join(':')}`;
}

/**
 * Parse a graph id back into `{ type, parts }`. Unknown types are
 * returned as-is with the entire remainder as a single part — this
 * keeps the parser non-throwing for forward-compat (a graph id with
 * a type we don't recognise yet still round-trips through write/read).
 *
 * Returns `null` if the id is empty or malformed (no `:` separator
 * for a known multi-part type).
 */
export function parseGraphId(id: string): ParsedGraphId | null {
    if (!id || typeof id !== 'string') return null;
    const firstColon = id.indexOf(':');
    if (firstColon < 0) {
        // No colon → the whole id is the type (single-token graph,
        // e.g. `health` shorthand).
        return { type: id, parts: [] };
    }
    const type = id.slice(0, firstColon);
    const remainder = id.slice(firstColon + 1);
    if (!type) return null;

    if (TWO_PART_TYPES.has(type)) {
        // Two-part types split on the FIRST colon in the remainder; the
        // second part is everything after, with inner colons preserved.
        // Example: `sequence:src/a.ts:anonymous@GET:/users` → parts =
        // ['src/a.ts', 'anonymous@GET:/users'].
        const splitIdx = remainder.indexOf(':');
        if (splitIdx < 0) {
            // Caller built a two-part type with only one part. Tolerate
            // — return what's there; downstream sees `parts.length === 1`
            // and can either fall back or surface a warning.
            return { type, parts: [remainder] };
        }
        return { type, parts: [remainder.slice(0, splitIdx), remainder.slice(splitIdx + 1)] };
    }

    // Single-part types AND unknown types: treat the entire remainder
    // as one part. `feature:service:main` parses as
    // `{ type: 'feature', parts: ['service:main'] }` — the colon
    // inside the route key is preserved.
    return { type, parts: [remainder] };
}

/**
 * Type guard helper — does this id begin with `<type>:` for a known
 * type? Replaces `graphId.startsWith('foo:')` patterns at call sites.
 */
export function isGraphIdOfType(id: string, type: string): boolean {
    const parsed = parseGraphId(id);
    return parsed !== null && parsed.type === type;
}

/**
 * Convenience accessor — return parts[index] (or undefined if absent).
 * Replaces `graphId.split(':')[N]` patterns at call sites.
 */
export function graphIdPart(id: string, index: number): string | undefined {
    const parsed = parseGraphId(id);
    if (!parsed) return undefined;
    return parsed.parts[index];
}

// Internal — exposed for tests.
export const _internals = { SINGLE_PART_TYPES, TWO_PART_TYPES };
