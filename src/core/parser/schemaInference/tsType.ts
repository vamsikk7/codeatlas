/**
 * schemaInference/tsType.ts — Issue #600 Phase 0 TypeScript-type
 * inference.
 *
 * When a handler signature declares a request shape inline via TS types
 * (no Zod/Joi/Yup/class-validator), the type annotation itself is the
 * spec. We lift it to `JsonSchemaLike` so the API-testing UI can still
 * pre-fill form fields.
 *
 * Recognised shapes:
 *
 *   (req: Request<Params, ResBody, ReqBody, Query>, …)  // express
 *   (req: { body: { title: string; tags?: string[] } }) // generic
 *   (input: { id: string; name?: string }) => …         // tRPC / GraphQL
 *
 * Plus interface / type alias references when the declaration is in
 * the same source file (cross-file resolution is out of scope for v0):
 *
 *   interface CreateArticleInput { title: string; tags?: string[]; }
 *   const handler = (req: { body: CreateArticleInput }) => …
 *
 * The parser is a thin type-string interpreter — it doesn't run the TS
 * type checker. Unions, generics, mapped types, conditional types, and
 * function-typed properties all degrade gracefully to a description
 * hint.
 */

import type { InferredApiSchema } from './types';
import type { JsonSchemaLike } from '../../graph/graphTypes';

interface InterfaceTable {
    [name: string]: string; // body text between the curlies
}

export function parseTsHandlerSchema(source: string, handlerSignature: string): InferredApiSchema {
    const interfaces = buildInterfaceTable(source);

    // Try common shapes in order. The first one to produce a schema wins.
    const bodyType = extractContainerType(handlerSignature, 'body');
    if (bodyType) {
        const schema = typeStringToSchema(bodyType, interfaces);
        if (schema) {
            return { requestSchema: { kind: 'json', schema, source: 'ts-type' } };
        }
    }

    // Express `Request<Params, ResBody, ReqBody, Query>` — params are
    // positional. ReqBody is the third type parameter.
    const reqGeneric = /Request\s*<\s*([^,>]+)?\s*(?:,\s*([^,>]+)?\s*(?:,\s*([^,>]+)?\s*(?:,\s*([^>]+))?)?)?\s*>/.exec(handlerSignature);
    if (reqGeneric) {
        const reqBodyType = reqGeneric[3]?.trim();
        if (reqBodyType && reqBodyType !== 'never' && reqBodyType !== 'any') {
            const schema = typeStringToSchema(reqBodyType, interfaces);
            if (schema) return { requestSchema: { kind: 'json', schema, source: 'ts-type' } };
        }
    }

    // tRPC / GraphQL `(input: { … }) => …` form — extract `input` directly.
    const inputType = extractContainerType(handlerSignature, 'input');
    if (inputType) {
        const schema = typeStringToSchema(inputType, interfaces);
        if (schema) return { requestSchema: { kind: 'json', schema, source: 'ts-type' } };
    }

    return {};
}

/**
 * Convert a TS type string to JsonSchemaLike. Handles primitives,
 * arrays, inline object literals, and resolved interface refs from the
 * same source file.
 */
function typeStringToSchema(typeStr: string, interfaces: InterfaceTable): JsonSchemaLike | undefined {
    const t = typeStr.trim();
    if (!t) return undefined;

    // string / number / boolean
    if (t === 'string') return { type: 'string' };
    if (t === 'number') return { type: 'number' };
    if (t === 'boolean' || t === 'bool') return { type: 'boolean' };
    if (t === 'Date') return { type: 'string', format: 'date-time' };
    if (t === 'null') return { type: 'null', nullable: true };

    // string[] / number[] / etc.
    if (t.endsWith('[]')) {
        const inner = typeStringToSchema(t.slice(0, -2).trim(), interfaces);
        return { type: 'array', items: inner };
    }
    // Array<X>
    const arrMatch = /^Array\s*<\s*(.+)\s*>$/.exec(t);
    if (arrMatch) {
        const inner = typeStringToSchema(arrMatch[1].trim(), interfaces);
        return { type: 'array', items: inner };
    }
    // Record<string, T>
    const recordMatch = /^Record\s*<\s*string\s*,\s*(.+)\s*>$/.exec(t);
    if (recordMatch) {
        const valueSchema = typeStringToSchema(recordMatch[1].trim(), interfaces);
        return { type: 'object', description: `Record<string, ${recordMatch[1].trim()}>`, items: valueSchema };
    }

    // Inline object literal — `{ a: T; b?: T; }`.
    if (t.startsWith('{') && t.endsWith('}')) {
        return objectBodyToSchema(t.slice(1, -1), interfaces);
    }

    // Union literals — `'a' | 'b' | 'c'` → enum string.
    if (/^'[^']*'(\s*\|\s*'[^']*')+$/.test(t)) {
        const enumVals = t.split('|').map(s => s.trim().replace(/^'|'$/g, ''));
        return { type: 'string', enum: enumVals };
    }
    // Type unions including `null` or `undefined` → nullable + drop those.
    if (t.includes('|')) {
        const parts = t.split('|').map(s => s.trim());
        const nullable = parts.some(p => p === 'null' || p === 'undefined');
        const meaningful = parts.filter(p => p !== 'null' && p !== 'undefined');
        if (meaningful.length === 1) {
            const inner = typeStringToSchema(meaningful[0], interfaces);
            if (inner && nullable) inner.nullable = true;
            return inner;
        }
        // Multi-type union (e.g. `string | number`) — fall back to a hint.
        return { type: 'string', description: t, nullable };
    }

    // Interface/alias reference — resolve only when declared in the same
    // file. Unknown references degrade to a description hint.
    if (/^[A-Z][\w$]*$/.test(t) && interfaces[t]) {
        return objectBodyToSchema(interfaces[t], interfaces);
    }
    if (/^[A-Z][\w$]*$/.test(t)) {
        return { type: 'object', description: `type ${t}` };
    }

    return undefined;
}

function objectBodyToSchema(body: string, interfaces: InterfaceTable): JsonSchemaLike {
    const properties: Record<string, JsonSchemaLike> = {};
    const required: string[] = [];
    for (const field of splitObjectFields(body)) {
        const child = typeStringToSchema(field.type, interfaces);
        if (!child) continue;
        if (field.optional) child.nullable = true;
        properties[field.name] = child;
        if (!field.optional) required.push(field.name);
    }
    const out: JsonSchemaLike = { type: 'object', properties };
    if (required.length > 0) out.required = required;
    return out;
}

interface InlineField { name: string; type: string; optional: boolean; }

function splitObjectFields(body: string): InlineField[] {
    const out: InlineField[] = [];
    // Split on `;` OR `,` at top level. Field shape: `name(?): type`.
    let depth = 0;
    let start = 0;
    const pushPiece = (piece: string) => {
        const m = /^([A-Za-z_$][\w$]*)\s*(\?)?\s*:\s*([\s\S]+)$/.exec(piece.trim());
        if (!m) return;
        out.push({ name: m[1], optional: Boolean(m[2]), type: m[3].trim() });
    };
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth--;
        else if ((ch === ';' || ch === ',') && depth === 0) {
            pushPiece(body.slice(start, i));
            start = i + 1;
        }
    }
    pushPiece(body.slice(start));
    return out;
}

/**
 * Pull the type annotation for a named container property from a
 * handler signature. Handles inline `(req: { body: { … } })`,
 * Express-style `(req: Request<...,..., {…}>)`, and de-structured
 * `({ body }: { body: { … } })` forms.
 */
function extractContainerType(signature: string, containerName: string): string | undefined {
    // We want the TYPE annotation `<container>: <T>`, not the destructured
    // value side `{ body }` (which carries no type). Walk every match of
    // `<containerName>:` and prefer the one where the next non-space char
    // is part of a type — `{`, an identifier letter, etc. — using
    // `balanceType` to do the actual extraction.
    const re = new RegExp(`\\b${containerName}\\s*:\\s*`, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(signature)) !== null) {
        const rest = signature.slice(match.index + match[0].length);
        // A leading `,` / `}` / `)` means the colon was actually a property
        // separator with no value — skip.
        if (!rest.length || /^[,)}]/.test(rest)) continue;
        const balanced = balanceType(rest);
        if (balanced) return balanced;
    }
    return undefined;
}

function balanceType(rest: string): string | undefined {
    // Read characters until we hit a closing `;` / `,` / `}` / `)` at
    // top-level brace depth 0. Tracks string contexts so commas inside
    // string literals don't fool us.
    let depth = 0;
    let inString: string | null = null;
    for (let i = 0; i < rest.length; i++) {
        const ch = rest[i];
        if (inString) {
            if (ch === '\\') { i++; continue; }
            if (ch === inString) inString = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
        if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) return rest.slice(0, i).trim();
            depth--;
        } else if ((ch === ';' || ch === ',') && depth === 0) {
            return rest.slice(0, i).trim();
        }
    }
    return rest.trim();
}

function buildInterfaceTable(source: string): InterfaceTable {
    const out: InterfaceTable = {};
    const ifaceRe = /(?:export\s+)?interface\s+([A-Z][\w$]*)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = ifaceRe.exec(source)) !== null) {
        const open = m.index + m[0].length - 1;
        const close = findMatchingClose(source, open);
        if (close > open) out[m[1]] = source.slice(open + 1, close);
    }
    const aliasRe = /(?:export\s+)?type\s+([A-Z][\w$]*)\s*=\s*\{\s*([\s\S]*?)\s*\}\s*;/g;
    while ((m = aliasRe.exec(source)) !== null) {
        out[m[1]] = m[2];
    }
    return out;
}

function findMatchingClose(text: string, openIdx: number): number {
    let depth = 1;
    for (let i = openIdx + 1; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}
