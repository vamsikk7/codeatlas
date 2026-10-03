/**
 * schemaInference/jsdoc.ts — Issue #600 Phase 0.
 *
 * Mine JSDoc tags above a handler body. Universal across languages
 * (every framework lets you scribble JSDoc-style block comments). The
 * shape recognised here mirrors the Swagger / OpenAPI 3 ergonomics
 * conventions that route handlers usually carry:
 *
 *   /​**
 *    * Create a new article.
 *    * @param {string}  body.title         Title of the article.
 *    * @param {string=} body.description   Optional summary blurb.
 *    * @param {string}  query.lang         Language code (e.g. "en").
 *    * @param {number}  path.id            Article id.
 *    * @response 201 { article: ArticleResponse }
 *    * @response 422 { errors: Record<string, string[]> }
 *    *​/
 *
 * Tag semantics:
 *   - `@param {<type>[=]} body.<prop> <description>` — request-body property.
 *     The trailing `=` on the type marks the property optional (Closure
 *     Compiler convention).
 *   - `@param {<type>} query.<prop> <description>` — query-string param.
 *   - `@param {<type>} path.<prop>  <description>` — path / route param.
 *   - `@response <status> [<description>]` — response shape (description
 *     only for v0; schema-from-type-string is a follow-up).
 *
 * The parser ignores other tags (`@returns`, `@throws`, etc.). It also
 * tolerates the alternative `@requestBody` / `@requestParam` tag
 * spellings used by some shops.
 */

import type { InferredApiSchema } from './types';
import type { JsonSchemaLike } from '../../graph/graphTypes';

export function parseJsdocSchema(blockComment: string): InferredApiSchema {
    const out: InferredApiSchema = {};
    const lines = blockComment.split('\n').map(stripLeader);

    const bodyProps: Array<{ name: string; type?: string; required: boolean; description?: string }> = [];
    const queryParams: NonNullable<InferredApiSchema['queryParams']> = [];
    const pathParams: NonNullable<InferredApiSchema['pathParams']> = [];
    const responses: NonNullable<InferredApiSchema['responseSchema']> = [];

    for (const line of lines) {
        const param = parseParamTag(line);
        if (param) {
            const { container, name, type, optional, description } = param;
            if (container === 'body') {
                bodyProps.push({ name, type, required: !optional, description });
            } else if (container === 'query') {
                queryParams.push({ name, type, required: !optional, description });
            } else if (container === 'path') {
                pathParams.push({ name, type, required: !optional, description });
            }
            continue;
        }
        const resp = parseResponseTag(line);
        if (resp) responses.push(resp);
    }

    if (bodyProps.length > 0) {
        const schema: JsonSchemaLike = {
            type: 'object',
            properties: Object.fromEntries(
                bodyProps.map(p => [p.name, normalizeSchema(p.type, p.description)]),
            ),
        };
        const required = bodyProps.filter(p => p.required).map(p => p.name);
        if (required.length > 0) schema.required = required;
        out.requestSchema = { kind: 'json', schema, source: 'jsdoc' };
    }
    if (pathParams.length > 0) out.pathParams = pathParams;
    if (queryParams.length > 0) out.queryParams = queryParams;
    if (responses.length > 0) out.responseSchema = responses;
    return out;
}

const PARAM_RE = /^\s*@(?:param|requestBody|requestParam)\s+(?:\{([^}]+)\}\s+)?(body|query|path)\.([A-Za-z_][\w-]*)(?:\s+(.*))?$/i;
// Issue #761: shorthand convention used by the express-realworld example app and
// similar repos: `@bodyparam <name> <Type>` instead of `@param {Type} body.<name>`.
// Same for query/path. Type follows the name on the same line; no curly braces.
const SHORTHAND_PARAM_RE = /^\s*@(body|query|path|route)param\s+([A-Za-z_][\w-]*)(?:\s+(.+?))?$/i;
const RESPONSE_RE = /^\s*@response\s+(\d{3})\b\s*(.*)$/i;

interface ParamPiece {
    container: 'body' | 'query' | 'path';
    name: string;
    type?: string;
    optional?: boolean;
    description?: string;
}

function parseParamTag(line: string): ParamPiece | undefined {
    // Issue #761: try the shorthand `@bodyparam` family first since it has
    // a different shape (no curly-braced type, no `body.` qualifier).
    const sh = SHORTHAND_PARAM_RE.exec(line);
    if (sh) {
        const containerRaw = sh[1].toLowerCase();
        const container: ParamPiece['container'] | null =
            containerRaw === 'body' ? 'body'
            : containerRaw === 'query' ? 'query'
            : (containerRaw === 'path' || containerRaw === 'route') ? 'path'
            : null;
        if (container) {
            return {
                container,
                name: sh[2],
                type: sh[3]?.trim() || undefined,
                optional: false,
            };
        }
    }
    const m = PARAM_RE.exec(line);
    if (!m) return undefined;
    const rawType = m[1]?.trim();
    let type: string | undefined;
    let optional = false;
    if (rawType) {
        if (rawType.endsWith('=')) {
            optional = true;
            type = rawType.slice(0, -1).trim();
        } else if (rawType.includes('|')) {
            // `string | null` / `string | undefined` → nullable
            const parts = rawType.split('|').map(s => s.trim());
            optional = parts.some(p => p === 'null' || p === 'undefined');
            type = parts.filter(p => p !== 'null' && p !== 'undefined').join(' | ') || rawType;
        } else {
            type = rawType;
        }
    }
    return {
        container: m[2].toLowerCase() as 'body' | 'query' | 'path',
        name: m[3],
        type,
        optional,
        description: m[4]?.trim() || undefined,
    };
}

function parseResponseTag(line: string): NonNullable<InferredApiSchema['responseSchema']>[number] | undefined {
    const m = RESPONSE_RE.exec(line);
    if (!m) return undefined;
    const status = Number(m[1]);
    const description = m[2]?.trim() || undefined;
    return { status, source: 'jsdoc', description };
}

function stripLeader(line: string): string {
    // Strip the per-line `*` block-comment leader.
    return line.replace(/^\s*\*\s?/, '');
}

function normalizeSchema(typeStr: string | undefined, description: string | undefined): JsonSchemaLike {
    const out: JsonSchemaLike = {};
    if (description) out.description = description;
    if (!typeStr) return out;
    const t = typeStr.trim().toLowerCase();
    if (t === 'string') out.type = 'string';
    else if (t === 'number') out.type = 'number';
    else if (t === 'integer' || t === 'int') out.type = 'integer';
    else if (t === 'boolean' || t === 'bool') out.type = 'boolean';
    else if (t === 'null') { out.type = 'null'; out.nullable = true; }
    else if (t.endsWith('[]') || t.startsWith('array')) {
        out.type = 'array';
        const inner = t.endsWith('[]') ? t.slice(0, -2) : t.replace(/^array(?:\s*<\s*([\w<>|, ]+)\s*>)?$/, '$1');
        if (inner) out.items = normalizeSchema(inner, undefined);
    } else if (t === 'object') out.type = 'object';
    else {
        // Free-form / aliased type — keep as raw description hint so the
        // testing UI can render "string (UserId)" or similar.
        out.type = 'string';
        out.description = (out.description ? `${out.description} ` : '') + `(${typeStr})`;
    }
    return out;
}
