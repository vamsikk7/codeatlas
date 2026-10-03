/**
 * schemaInference/zod.ts — Issue #600 Phase 0.
 *
 * Parse `z.object({ … })` schemas to a `JsonSchemaLike`. Regex-based on
 * the source text (not Zod runtime) so we don't add a `zod` dependency
 * to the parser pipeline — we just need shape introspection and we
 * scan source code, not values.
 *
 * Supports the common shapes:
 *   z.string() / z.number() / z.boolean() / z.null()
 *   z.array(z.string())
 *   z.object({ id: z.string().uuid(), name: z.string().optional() })
 *   z.enum(['a','b','c'])
 *   z.nativeEnum(SomeEnum)         — surfaced as `string` placeholder
 *   z.literal('x')                 — surfaced as enum-of-one
 *   <schema>.optional()            — flips required: false
 *   <schema>.nullable()            — sets `nullable: true`
 *   <schema>.describe('…')         — sets `description`
 *   <schema>.default(…)            — emits `example` field
 *
 * Unhandled (out of scope for v0): unions, intersections, transforms,
 * z.record, z.tuple, z.discriminatedUnion. These return `undefined` so
 * the caller can fall back to JSDoc / TS-type inference.
 */

import type { InferredApiSchema } from './types';
import type { JsonSchemaLike } from '../../graph/graphTypes';

/**
 * Find a Zod schema declared at the top level of `source` keyed by the
 * exported name `exportName`, then return the inferred shape.
 *
 * Returns `undefined` when the export isn't found or isn't a recognised
 * Zod call. The caller (frameworkDetector) typically threads this from
 * a `validate(<schemaName>)` middleware call site — see Phase 1 wiring.
 */
export function parseZodExport(source: string, exportName: string): JsonSchemaLike | undefined {
    const re = new RegExp(`(?:export\\s+)?const\\s+${escapeRe(exportName)}\\s*=\\s*([\\s\\S]+?);`, 'm');
    const m = re.exec(source);
    if (!m) return undefined;
    return parseZodExpression(m[1].trim());
}

/**
 * Inline parse a complete `z.…(…)` expression. Public so the framework
 * detector can hand off whatever it sliced out of a route registration
 * (e.g. `router.post('/x', validate(z.object({...})), handler)`).
 */
export function parseZodExpression(expr: string): JsonSchemaLike | undefined {
    expr = expr.trim();
    // Strip trailing chain operators we care about, in order. After each
    // strip we recurse on the base — that preserves order independence
    // (`.describe().optional()` produces the same result as the reverse).
    const optMatch = stripSuffix(expr, /\.\s*optional\s*\(\s*\)$/);
    if (optMatch) {
        const inner = parseZodExpression(optMatch);
        if (!inner) return undefined;
        inner.nullable = true;
        return inner;
    }
    const nullMatch = stripSuffix(expr, /\.\s*nullable\s*\(\s*\)$/);
    if (nullMatch) {
        const inner = parseZodExpression(nullMatch);
        if (!inner) return undefined;
        inner.nullable = true;
        return inner;
    }
    const descMatch = matchSuffixCall(expr, 'describe');
    if (descMatch) {
        const inner = parseZodExpression(descMatch.base);
        if (!inner) return undefined;
        const text = parseStringLiteral(descMatch.arg);
        if (text !== undefined) inner.description = text;
        return inner;
    }
    const defMatch = matchSuffixCall(expr, 'default');
    if (defMatch) {
        const inner = parseZodExpression(defMatch.base);
        if (!inner) return undefined;
        const ex = parseLiteralValue(defMatch.arg);
        if (ex !== undefined) inner.example = ex;
        return inner;
    }
    const formatMatch = matchSuffixCall(expr, 'email')
        || matchSuffixCall(expr, 'url')
        || matchSuffixCall(expr, 'uuid')
        || matchSuffixCall(expr, 'datetime');
    if (formatMatch) {
        const inner = parseZodExpression(formatMatch.base);
        if (!inner) return undefined;
        const fmt = formatMatch.callee;
        inner.format = fmt === 'datetime' ? 'date-time' : fmt;
        return inner;
    }

    // Primary `z.<kind>(<args>)` forms — match these BEFORE falling back
    // to the unknown-chain stripper, so `z.string()` isn't mistakenly
    // treated as a chained call on top of bare `z`.
    if (/^z\.string\s*\(\s*\)$/.test(expr)) return { type: 'string' };
    if (/^z\.number\s*\(\s*\)$/.test(expr)) return { type: 'number' };
    if (/^z\.boolean\s*\(\s*\)$/.test(expr)) return { type: 'boolean' };
    if (/^z\.bigint\s*\(\s*\)$/.test(expr)) return { type: 'integer' };
    if (/^z\.date\s*\(\s*\)$/.test(expr)) return { type: 'string', format: 'date-time' };
    if (/^z\.null\s*\(\s*\)$/.test(expr)) return { type: 'null', nullable: true };

    // z.literal('a')
    const lit = /^z\.literal\s*\(\s*([\s\S]+?)\s*\)$/.exec(expr);
    if (lit) {
        const v = parseLiteralValue(lit[1]);
        if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            return { enum: [v] };
        }
    }

    // z.enum(['a','b','c'])
    const enumMatch = /^z\.enum\s*\(\s*\[([\s\S]*?)\]\s*\)$/.exec(expr);
    if (enumMatch) {
        const items = splitTopLevel(enumMatch[1]).map(parseStringLiteral).filter((v): v is string => typeof v === 'string');
        return { type: 'string', enum: items };
    }

    // z.array(<inner>)
    const arrMatch = /^z\.array\s*\(\s*([\s\S]+)\s*\)$/.exec(expr);
    if (arrMatch) {
        const inner = parseZodExpression(arrMatch[1]);
        return { type: 'array', items: inner };
    }

    // z.object({ key: <inner>, key2: <inner>, … })
    const objMatch = /^z\.object\s*\(\s*\{\s*([\s\S]*?)\s*\}\s*\)$/.exec(expr);
    if (objMatch) {
        const fields = splitObjectFields(objMatch[1]);
        const properties: Record<string, JsonSchemaLike> = {};
        const required: string[] = [];
        for (const f of fields) {
            const child = parseZodExpression(f.value);
            if (!child) continue;
            properties[f.key] = child;
            if (!child.nullable) required.push(f.key);
        }
        const out: JsonSchemaLike = { type: 'object', properties };
        if (required.length > 0) out.required = required;
        return out;
    }

    // Fallback — strip any chained call we don't recognise (`.min(1)`,
    // `.max(255)`, `.regex(...)`, `.transform(...)`) and recurse on the
    // base. Runs LAST so `z.string()` isn't shredded.
    const otherChain = stripUnknownChain(expr);
    if (otherChain) return parseZodExpression(otherChain);

    return undefined;
}

export function parseZodInferredApiSchema(zodExpr: string): InferredApiSchema {
    const schema = parseZodExpression(zodExpr);
    if (!schema) return {};
    return {
        requestSchema: { kind: 'json', schema, source: 'zod' },
    };
}

// ─── helpers ─────────────────────────────────────────────────────────

function stripSuffix(s: string, re: RegExp): string | null {
    const m = re.exec(s);
    if (!m || m.index + m[0].length !== s.length) return null;
    return s.slice(0, m.index);
}

function stripUnknownChain(s: string): string | null {
    // Matches `.<ident>(...)` at the END of `s`. Returns the prefix
    // before that call, OR null if the suffix isn't a chained call.
    const closeIdx = s.length - 1;
    if (s[closeIdx] !== ')') return null;
    const openIdx = findMatchingOpen(s, closeIdx);
    if (openIdx < 0) return null;
    let i = openIdx - 1;
    while (i >= 0 && /[A-Za-z0-9_$]/.test(s[i])) i--;
    if (i < 0 || s[i] !== '.') return null;
    return s.slice(0, i);
}

function matchSuffixCall(s: string, callee: string): { base: string; arg: string; callee: string } | null {
    if (s[s.length - 1] !== ')') return null;
    const openIdx = findMatchingOpen(s, s.length - 1);
    if (openIdx < 0) return null;
    const prefix = s.slice(0, openIdx);
    const needle = `.${callee}`;
    if (!prefix.endsWith(needle)) return null;
    const base = prefix.slice(0, -needle.length);
    const arg = s.slice(openIdx + 1, s.length - 1).trim();
    return { base, arg, callee };
}

function findMatchingOpen(s: string, closeIdx: number): number {
    let depth = 0;
    for (let i = closeIdx; i >= 0; i--) {
        const ch = s[i];
        if (ch === ')') depth++;
        else if (ch === '(') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

interface ObjectField { key: string; value: string; }

function splitObjectFields(body: string): ObjectField[] {
    const fields: ObjectField[] = [];
    const parts = splitTopLevel(body);
    for (const p of parts) {
        const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/.exec(p.trim());
        if (!m) continue;
        const key = m[1] ?? m[2] ?? m[3];
        const value = m[4].trim();
        fields.push({ key, value });
    }
    return fields;
}

function splitTopLevel(body: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    let inString: string | null = null;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (inString) {
            if (ch === '\\') { i++; continue; }
            if (ch === inString) inString = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === ',' && depth === 0) {
            out.push(body.slice(start, i));
            start = i + 1;
        }
    }
    const tail = body.slice(start).trim();
    if (tail) out.push(tail);
    return out;
}

function parseStringLiteral(s: string): string | undefined {
    const m = /^\s*(['"`])([\s\S]*)\1\s*$/.exec(s);
    if (!m) return undefined;
    return m[2].replace(/\\(.)/g, '$1');
}

function parseLiteralValue(s: string): unknown {
    const str = parseStringLiteral(s);
    if (str !== undefined) return str;
    const trimmed = s.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null') return null;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return undefined;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
