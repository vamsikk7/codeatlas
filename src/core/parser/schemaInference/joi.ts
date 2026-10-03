/**
 * schemaInference/joi.ts — Issue #600 Phase 0 Joi inference.
 *
 * Mirror of `zod.ts` for Joi (https://joi.dev). Same regex-on-source
 * strategy — no `joi` runtime dependency. Handles the common shapes:
 *
 *   Joi.string() / Joi.number() / Joi.boolean() / Joi.date()
 *   Joi.array().items(Joi.string())
 *   Joi.object({ id: Joi.string().required(), name: Joi.string() })
 *   Joi.valid('a','b','c')                  — enum-of
 *   Joi.allow(null)                         — nullable
 *   Joi.string().email() / .uri() / .uuid() — format hint
 *   <schema>.required() / .optional()       — required[] inclusion
 *   <schema>.description('…')               — description
 *   <schema>.default(…)                     — example
 *
 * The legacy `joi.func()` and `Joi.any()` shapes return an empty
 * primitive schema (`{ type: 'string' }` with description hint).
 * Out-of-scope for v0: `alternatives`, `when`, `compile`, `extension`,
 * `link`, `ref` — these return `undefined` so the caller falls back to
 * JSDoc / Zod / ts-type inference.
 *
 * Library accepts both `Joi.` (default import) and `joi.` (renamed
 * import) — the prefix is normalised before matching.
 */

import type { InferredApiSchema } from './types';
import type { JsonSchemaLike } from '../../graph/graphTypes';

export function parseJoiExport(source: string, exportName: string): JsonSchemaLike | undefined {
    const re = new RegExp(`(?:export\\s+)?const\\s+${escapeRe(exportName)}\\s*=\\s*([\\s\\S]+?);`, 'm');
    const m = re.exec(source);
    if (!m) return undefined;
    return parseJoiExpression(m[1].trim());
}

export function parseJoiExpression(expr: string): JsonSchemaLike | undefined {
    expr = expr.trim();
    // Normalize the import-rename — both `Joi.` and `joi.` are common.
    const normalised = expr.replace(/^Joi\./, 'joi.');

    // Trailing chain modifiers run first so `Joi.string().required()`
    // walks `.required()` → base → primary `joi.string()`.
    const reqMatch = stripSuffix(normalised, /\.\s*required\s*\(\s*\)$/);
    if (reqMatch) {
        const inner = parseJoiExpression(reqMatch);
        if (!inner) return undefined;
        // Joi default is required when wrapped in `Joi.object({...})`,
        // so this is mostly a no-op for nested fields. We still strip
        // the call so primary matching reaches.
        return inner;
    }
    const optMatch = stripSuffix(normalised, /\.\s*optional\s*\(\s*\)$/);
    if (optMatch) {
        const inner = parseJoiExpression(optMatch);
        if (!inner) return undefined;
        inner.nullable = true;
        return inner;
    }
    const allowMatch = matchSuffixCall(normalised, 'allow');
    if (allowMatch) {
        const inner = parseJoiExpression(allowMatch.base);
        if (!inner) return undefined;
        const arg = parseLiteralValue(allowMatch.arg);
        if (arg === null) inner.nullable = true;
        return inner;
    }
    const validMatch = matchSuffixCall(normalised, 'valid');
    if (validMatch) {
        const inner = parseJoiExpression(validMatch.base) ?? { type: 'string' };
        const vals = splitTopLevel(validMatch.arg).map(parseLiteralValue);
        const enumVals = vals.filter((v): v is string | number | boolean | null =>
            v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
        );
        if (enumVals.length > 0) inner.enum = enumVals;
        return inner;
    }
    const descMatch = matchSuffixCall(normalised, 'description');
    if (descMatch) {
        const inner = parseJoiExpression(descMatch.base);
        if (!inner) return undefined;
        const text = parseStringLiteral(descMatch.arg);
        if (text !== undefined) inner.description = text;
        return inner;
    }
    const defMatch = matchSuffixCall(normalised, 'default');
    if (defMatch) {
        const inner = parseJoiExpression(defMatch.base);
        if (!inner) return undefined;
        const ex = parseLiteralValue(defMatch.arg);
        if (ex !== undefined) inner.example = ex;
        return inner;
    }
    const formatMatch = matchSuffixCall(normalised, 'email')
        || matchSuffixCall(normalised, 'uri')
        || matchSuffixCall(normalised, 'uuid')
        || matchSuffixCall(normalised, 'isoDate');
    if (formatMatch) {
        const inner = parseJoiExpression(formatMatch.base);
        if (!inner) return undefined;
        inner.format = formatMatch.callee === 'isoDate' ? 'date-time'
            : formatMatch.callee === 'uri' ? 'uri'
            : formatMatch.callee;
        return inner;
    }

    // Primary forms.
    if (/^joi\.string\s*\(\s*\)$/.test(normalised)) return { type: 'string' };
    if (/^joi\.number\s*\(\s*\)$/.test(normalised)) return { type: 'number' };
    if (/^joi\.boolean\s*\(\s*\)$/.test(normalised)) return { type: 'boolean' };
    if (/^joi\.date\s*\(\s*\)$/.test(normalised)) return { type: 'string', format: 'date-time' };
    if (/^joi\.any\s*\(\s*\)$/.test(normalised)) return { type: 'string', description: 'Joi.any()' };

    // Joi.array().items(<inner>) — capture the items child.
    const arrItemsMatch = matchSuffixCall(normalised, 'items');
    if (arrItemsMatch) {
        const base = arrItemsMatch.base.trim();
        if (/^joi\.array\s*\(\s*\)$/.test(base)) {
            const inner = parseJoiExpression(arrItemsMatch.arg);
            return { type: 'array', items: inner };
        }
    }
    if (/^joi\.array\s*\(\s*\)$/.test(normalised)) {
        return { type: 'array' };
    }

    // Joi.object({ key: <inner>, … })
    const objMatch = /^joi\.object\s*\(\s*\{\s*([\s\S]*?)\s*\}\s*\)$/.exec(normalised);
    if (objMatch) {
        const fields = splitObjectFields(objMatch[1]);
        const properties: Record<string, JsonSchemaLike> = {};
        const required: string[] = [];
        for (const f of fields) {
            const child = parseJoiExpression(f.value);
            if (!child) continue;
            properties[f.key] = child;
            // Joi defaults to optional at the OBJECT level (the opposite
            // of Zod). A field is required only when explicitly marked
            // via `.required()` in source.
            if (/\.\s*required\s*\(\s*\)/.test(f.value)) required.push(f.key);
        }
        const out: JsonSchemaLike = { type: 'object', properties };
        if (required.length > 0) out.required = required;
        return out;
    }

    // Unknown chain — fall back to stripping (handles `.min(1)`, `.max()`,
    // `.regex()`, `.pattern()`, custom `.alter()`, etc.).
    const otherChain = stripUnknownChain(normalised);
    if (otherChain) return parseJoiExpression(otherChain);

    return undefined;
}

export function parseJoiInferredApiSchema(joiExpr: string): InferredApiSchema {
    const schema = parseJoiExpression(joiExpr);
    if (!schema) return {};
    return { requestSchema: { kind: 'json', schema, source: 'joi' } };
}

// ─── shared helpers (mirror of zod.ts) ───────────────────────────────

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
