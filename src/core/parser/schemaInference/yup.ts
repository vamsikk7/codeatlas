/**
 * schemaInference/yup.ts — Issue #600 Phase 0 Yup inference.
 *
 * Yup syntax overlaps with Zod + Joi but uses lowercase `yup.<kind>()`
 * by convention. Same regex-on-source strategy — no `yup` runtime
 * dependency. Covers the common shapes:
 *
 *   yup.string() / yup.number() / yup.boolean() / yup.date()
 *   yup.array().of(yup.string())          — items via `.of(...)`
 *   yup.object({ id: yup.string(), … })   — fields via the constructor-form
 *   yup.object().shape({ id: yup.string() }) — fields via `.shape(...)`
 *   yup.mixed().oneOf(['a','b','c'])      — enum
 *   <schema>.required() / .notRequired() / .optional() / .nullable()
 *   <schema>.email() / .url() / .uuid() / .matches(re)
 *   <schema>.label('…')  / .meta({...})   — kept as description hint
 *   <schema>.default(…)                   — example
 *
 * `.notRequired()` is treated like `.optional()`. `.nullable()` flips
 * nullable. Unknown chained calls fall through to the strip path so
 * `.min(3).max(255).matches(/abc/).test(...)` doesn't trip up the
 * primary match.
 *
 * Module accepts both `yup.` and `Yup.` import-rename forms.
 */

import type { InferredApiSchema } from './types';
import type { JsonSchemaLike } from '../../graph/graphTypes';

export function parseYupExport(source: string, exportName: string): JsonSchemaLike | undefined {
    const re = new RegExp(`(?:export\\s+)?const\\s+${escapeRe(exportName)}\\s*=\\s*([\\s\\S]+?);`, 'm');
    const m = re.exec(source);
    if (!m) return undefined;
    return parseYupExpression(m[1].trim());
}

export function parseYupExpression(expr: string): JsonSchemaLike | undefined {
    expr = expr.trim();
    const normalised = expr.replace(/^Yup\./, 'yup.');

    // Trailing chain modifiers — handled first so we recurse on the base.
    const optMatch = stripSuffix(normalised, /\.\s*(?:optional|notRequired)\s*\(\s*\)$/);
    if (optMatch) {
        const inner = parseYupExpression(optMatch);
        if (!inner) return undefined;
        inner.nullable = true;
        return inner;
    }
    const nullMatch = stripSuffix(normalised, /\.\s*nullable\s*\(\s*\)$/);
    if (nullMatch) {
        const inner = parseYupExpression(nullMatch);
        if (!inner) return undefined;
        inner.nullable = true;
        return inner;
    }
    const reqMatch = stripSuffix(normalised, /\.\s*required\s*\(\s*\)$/);
    if (reqMatch) {
        // `.required()` flips the optional state back to required. We
        // don't track required-ness at the value level (only at the
        // parent object level via `.shape()`), so recurse + return.
        return parseYupExpression(reqMatch);
    }
    const labelMatch = matchSuffixCall(normalised, 'label');
    if (labelMatch) {
        const inner = parseYupExpression(labelMatch.base);
        if (!inner) return undefined;
        const text = parseStringLiteral(labelMatch.arg);
        if (text !== undefined) inner.description = text;
        return inner;
    }
    const defMatch = matchSuffixCall(normalised, 'default');
    if (defMatch) {
        const inner = parseYupExpression(defMatch.base);
        if (!inner) return undefined;
        const ex = parseLiteralValue(defMatch.arg);
        if (ex !== undefined) inner.example = ex;
        return inner;
    }
    const oneOfMatch = matchSuffixCall(normalised, 'oneOf');
    if (oneOfMatch) {
        const inner = parseYupExpression(oneOfMatch.base) ?? { type: 'string' };
        const arrMatch = /^\[([\s\S]*?)\]/.exec(oneOfMatch.arg.trim());
        if (arrMatch) {
            const vals = splitTopLevel(arrMatch[1]).map(parseLiteralValue);
            const enumVals = vals.filter((v): v is string | number | boolean | null =>
                v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
            );
            if (enumVals.length > 0) inner.enum = enumVals;
        }
        return inner;
    }
    const formatMatch = matchSuffixCall(normalised, 'email')
        || matchSuffixCall(normalised, 'url')
        || matchSuffixCall(normalised, 'uuid');
    if (formatMatch) {
        const inner = parseYupExpression(formatMatch.base);
        if (!inner) return undefined;
        inner.format = formatMatch.callee;
        return inner;
    }

    // `.of(<inner>)` is the Yup spelling for array items. Only honoured
    // when the immediate base is `yup.array()`.
    const ofMatch = matchSuffixCall(normalised, 'of');
    if (ofMatch && /^yup\.array\s*\(\s*\)$/.test(ofMatch.base.trim())) {
        const inner = parseYupExpression(ofMatch.arg);
        return { type: 'array', items: inner };
    }

    // `.shape({...})` for object schemas declared via the empty-form
    // constructor: `yup.object().shape({ id: yup.string() })`.
    const shapeMatch = matchSuffixCall(normalised, 'shape');
    if (shapeMatch && /^yup\.object\s*\(\s*\)$/.test(shapeMatch.base.trim())) {
        const bodyMatch = /^\{\s*([\s\S]*?)\s*\}$/.exec(shapeMatch.arg.trim());
        if (bodyMatch) return objectFromBody(bodyMatch[1]);
    }

    // Primary forms — match BEFORE the unknown-chain stripper so
    // `yup.string()` isn't misread as a chain on top of bare `yup`.
    if (/^yup\.string\s*\(\s*\)$/.test(normalised)) return { type: 'string' };
    if (/^yup\.number\s*\(\s*\)$/.test(normalised)) return { type: 'number' };
    if (/^yup\.boolean\s*\(\s*\)$/.test(normalised)) return { type: 'boolean' };
    if (/^yup\.bool\s*\(\s*\)$/.test(normalised)) return { type: 'boolean' };
    if (/^yup\.date\s*\(\s*\)$/.test(normalised)) return { type: 'string', format: 'date-time' };
    if (/^yup\.mixed\s*\(\s*\)$/.test(normalised)) return { type: 'string', description: 'yup.mixed()' };

    // yup.array() with no `.of()` — generic array.
    if (/^yup\.array\s*\(\s*\)$/.test(normalised)) return { type: 'array' };

    // yup.object({...}) — constructor-form shape.
    const objMatch = /^yup\.object\s*\(\s*\{\s*([\s\S]*?)\s*\}\s*\)$/.exec(normalised);
    if (objMatch) return objectFromBody(objMatch[1]);
    if (/^yup\.object\s*\(\s*\)$/.test(normalised)) return { type: 'object' };

    // Unknown chained call — strip + recurse. Runs LAST so primary
    // matches win first.
    const otherChain = stripUnknownChain(normalised);
    if (otherChain) return parseYupExpression(otherChain);

    return undefined;
}

export function parseYupInferredApiSchema(yupExpr: string): InferredApiSchema {
    const schema = parseYupExpression(yupExpr);
    if (!schema) return {};
    return { requestSchema: { kind: 'json', schema, source: 'yup' } };
}

// ─── shared helpers ──────────────────────────────────────────────────

function objectFromBody(body: string): JsonSchemaLike {
    const fields = splitObjectFields(body);
    const properties: Record<string, JsonSchemaLike> = {};
    const required: string[] = [];
    for (const f of fields) {
        const child = parseYupExpression(f.value);
        if (!child) continue;
        properties[f.key] = child;
        // Yup defaults to required when wrapped in an object — only drop
        // a field from required[] when it carries `.optional()` /
        // `.notRequired()` / `.nullable()` explicitly.
        const isOptional = /\.\s*(?:optional|notRequired|nullable)\s*\(\s*\)/.test(f.value);
        if (!isOptional) required.push(f.key);
    }
    const out: JsonSchemaLike = { type: 'object', properties };
    if (required.length > 0) out.required = required;
    return out;
}

function stripSuffix(s: string, re: RegExp): string | null {
    const m = re.exec(s);
    if (!m || m.index + m[0].length !== s.length) return null;
    return s.slice(0, m.index);
}

function stripUnknownChain(s: string): string | null {
    if (s[s.length - 1] !== ')') return null;
    const openIdx = findMatchingOpen(s, s.length - 1);
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
