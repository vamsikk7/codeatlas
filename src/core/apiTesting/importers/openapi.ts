/**
 * apiTesting/importers/openapi.ts — Issue #604 Phase 4.
 *
 * Parse an OpenAPI 3.x or Swagger 2.0 document into the
 * `ApiTestingPayload` shape the webview consumes. Each `paths.<route>.
 * <method>` operation becomes one `ApiTestingEndpoint`; operations are
 * grouped by tag (Swagger / OpenAPI convention) — operations with no
 * tag land in `'collection:default'`.
 *
 * Source shape: either a plain JS object (already parsed JSON / YAML)
 * or a raw string the caller will JSON-parse beforehand. We
 * intentionally don't ship a YAML parser; the caller (CLI flag /
 * Phase 4 UI) handles YAML.
 *
 * Schema handling: request bodies + parameters are lifted into
 * `requestSchema` / `pathParams` / `queryParams` via the same
 * `JsonSchemaLike` shape Phase 0 emits. We accept `application/json`
 * content schemas + bypass `$ref` resolution (referenced schemas
 * become `{ type: 'object', description: '$ref:<path>' }` placeholders).
 */

import type { JsonSchemaLike } from '../../graph/graphTypes';
import type { ApiTestingPayload, ApiTestingEndpoint, ApiTestingCollection } from '../types';

interface OpenApiOperation {
    operationId?: string;
    summary?: string;
    tags?: string[];
    parameters?: OpenApiParameter[];
    requestBody?: {
        required?: boolean;
        content?: Record<string, { schema?: unknown }>;
    };
    responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
    security?: unknown[];
}

interface OpenApiParameter {
    name: string;
    in: 'path' | 'query' | 'header' | 'cookie';
    required?: boolean;
    schema?: unknown;
    description?: string;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

export function importOpenApi(spec: unknown): ApiTestingPayload {
    if (!spec || typeof spec !== 'object') return empty();
    const obj = spec as Record<string, unknown>;
    const paths = obj.paths as Record<string, Record<string, OpenApiOperation>> | undefined;
    if (!paths || typeof paths !== 'object') return empty();

    const grouped = new Map<string, ApiTestingCollection>();
    let totalEndpoints = 0;

    for (const [route, methods] of Object.entries(paths)) {
        if (!methods || typeof methods !== 'object') continue;
        for (const [method, op] of Object.entries(methods)) {
            if (!HTTP_METHODS.has(method.toLowerCase())) continue;
            const ep = operationToEndpoint(route, method.toUpperCase(), op);
            const tags = op.tags ?? [];
            const collectionLabels = tags.length > 0 ? tags : ['default'];
            for (const tagLabel of collectionLabels) {
                const collectionId = `collection:${tagLabel}`;
                if (!grouped.has(collectionId)) {
                    grouped.set(collectionId, {
                        id: collectionId,
                        label: tagLabel,
                        source: 'manual',
                        endpoints: [],
                    });
                }
                grouped.get(collectionId)!.endpoints.push(ep);
            }
            totalEndpoints++;
        }
    }

    for (const c of grouped.values()) {
        c.endpoints.sort((a, b) =>
            (a.method + a.route).localeCompare(b.method + b.route, undefined, { sensitivity: 'base' }),
        );
    }
    const collections = [...grouped.values()].sort((a, b) => {
        if (a.id === 'collection:default') return 1;
        if (b.id === 'collection:default') return -1;
        if (b.endpoints.length !== a.endpoints.length) return b.endpoints.length - a.endpoints.length;
        return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });

    return { totalEndpoints, collections };
}

function operationToEndpoint(route: string, method: string, op: OpenApiOperation): ApiTestingEndpoint {
    const id = `imported:openapi:${method}:${route}`;
    const handlerName = op.operationId ?? `${method.toLowerCase()}${camelify(route)}`;
    const params = op.parameters ?? [];
    const pathParams = params.filter(p => p.in === 'path').map(p => ({
        name: p.name,
        type: schemaTypeHint(p.schema),
        required: p.required ?? true, // OpenAPI invariant: path params always required
        description: p.description,
    }));
    const queryParams = params.filter(p => p.in === 'query').map(p => ({
        name: p.name,
        type: schemaTypeHint(p.schema),
        required: p.required ?? false,
        description: p.description,
    }));
    const requestSchema = liftRequestSchema(op);
    const responseSchema = liftResponseSchema(op);
    const auth = (op.security?.length ?? 0) > 0 ? 'required' as const : undefined;

    return {
        id,
        method,
        route,
        handlerName,
        filePath: 'openapi.imported',
        auth,
        pathParams: pathParams.length > 0 ? pathParams : undefined,
        queryParams: queryParams.length > 0 ? queryParams : undefined,
        requestSchema,
        responseSchema,
    };
}

function liftRequestSchema(op: OpenApiOperation): ApiTestingEndpoint['requestSchema'] | undefined {
    const content = op.requestBody?.content;
    if (!content) return undefined;
    const jsonShape = content['application/json'] ?? content['application/*+json'];
    const schema = jsonShape?.schema;
    if (!schema) return undefined;
    return {
        kind: 'json',
        source: 'jsdoc', // we reuse the source enum — OpenAPI is closest to JSDoc-style annotation
        schema: liftSchema(schema),
    };
}

function liftResponseSchema(op: OpenApiOperation): ApiTestingEndpoint['responseSchema'] | undefined {
    if (!op.responses) return undefined;
    const out: NonNullable<ApiTestingEndpoint['responseSchema']> = [];
    for (const [statusStr, body] of Object.entries(op.responses)) {
        const status = Number(statusStr);
        if (!Number.isFinite(status)) continue;
        const content = body?.content ?? {};
        const schema = content['application/json']?.schema ?? content['*/*']?.schema;
        out.push({
            status,
            description: body?.description,
            schema: schema ? liftSchema(schema) : undefined,
        });
    }
    out.sort((a, b) => a.status - b.status);
    return out.length > 0 ? out : undefined;
}

function liftSchema(raw: unknown): JsonSchemaLike {
    if (!raw || typeof raw !== 'object') return {};
    const obj = raw as Record<string, unknown>;
    // `$ref` resolution is out of scope for v1 — keep the path as a hint.
    if (typeof obj.$ref === 'string') {
        return { type: 'object', description: `$ref:${obj.$ref}` };
    }
    const out: JsonSchemaLike = {};
    if (typeof obj.type === 'string') {
        const t = obj.type;
        if (t === 'object' || t === 'array' || t === 'string' || t === 'number' || t === 'integer' || t === 'boolean' || t === 'null') {
            out.type = t;
        }
    }
    if (typeof obj.description === 'string') out.description = obj.description;
    if (typeof obj.format === 'string') out.format = obj.format;
    if (obj.nullable === true) out.nullable = true;
    if (obj.example !== undefined) out.example = obj.example;
    if (Array.isArray(obj.enum)) {
        out.enum = obj.enum.filter((v): v is string | number | boolean | null =>
            v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
        );
    }
    if (out.type === 'array' && obj.items) {
        out.items = liftSchema(obj.items);
    }
    if (out.type === 'object' || (!out.type && obj.properties)) {
        const props = obj.properties as Record<string, unknown> | undefined;
        if (props && typeof props === 'object') {
            out.type = 'object';
            out.properties = {};
            for (const [k, v] of Object.entries(props)) {
                out.properties[k] = liftSchema(v);
            }
        }
        if (Array.isArray(obj.required)) {
            out.required = (obj.required as unknown[]).filter((s): s is string => typeof s === 'string');
        }
    }
    return out;
}

function schemaTypeHint(schema: unknown): string | undefined {
    if (!schema || typeof schema !== 'object') return undefined;
    const t = (schema as { type?: unknown }).type;
    return typeof t === 'string' ? t : undefined;
}

function camelify(route: string): string {
    return route
        .replace(/[{}]/g, '')
        .split(/[/?]/)
        .filter(Boolean)
        .map(s => s.charAt(0).toUpperCase() + s.slice(1))
        .join('');
}

function empty(): ApiTestingPayload {
    return { totalEndpoints: 0, collections: [] };
}
