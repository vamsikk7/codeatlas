/**
 * apiTesting/importers/postman.ts — Issue #604 Phase 4.
 *
 * Parse a Postman v2.1 collection JSON into the `ApiTestingPayload`
 * shape. A collection has a top-level `info` block, a tree of `item`
 * folders, and request objects at the leaves. We flatten the tree —
 * each folder becomes one `ApiTestingCollection`, requests at the
 * collection's root land in a `'<info.name>'` collection.
 *
 * Supported shapes:
 *   - Single-level + nested folders (recursion-flattened).
 *   - Plain URL string (`"url": "https://…"`) or structured URL object.
 *   - JSON request bodies (mode = "raw" with JSON content-type, or
 *     "raw" with the body literally JSON-shape — we try-parse).
 *   - Path variables (`/users/{{userId}}`), query params (auto from
 *     `url.query` array).
 *   - Bearer auth at the request OR folder level → `auth: 'required'`.
 *
 * Out of scope for v1: pre-request scripts, test scripts, OAuth flows,
 * formdata bodies, GraphQL bodies — those still import the request,
 * just without the script / structured body.
 */

import type { ApiTestingPayload, ApiTestingEndpoint, ApiTestingCollection, ApiTestingPathParam, ApiTestingQueryParam } from '../types';

interface PostmanCollection {
    info?: { name?: string };
    item?: PostmanItem[];
    auth?: PostmanAuth;
}

interface PostmanItem {
    name?: string;
    item?: PostmanItem[];
    request?: PostmanRequest;
    auth?: PostmanAuth;
}

interface PostmanRequest {
    method?: string;
    url?: string | PostmanUrl;
    header?: Array<{ key: string; value: string; disabled?: boolean }>;
    body?: {
        mode?: string;
        raw?: string;
        options?: { raw?: { language?: string } };
    };
    auth?: PostmanAuth;
    description?: string;
}

interface PostmanUrl {
    raw?: string;
    host?: string[];
    path?: string[];
    query?: Array<{ key: string; value?: string; description?: string; disabled?: boolean }>;
    variable?: Array<{ key: string; value?: string; description?: string }>;
}

interface PostmanAuth {
    type?: string;
    bearer?: Array<{ key: string; value: string }>;
}

export function importPostmanCollection(raw: unknown): ApiTestingPayload {
    if (!raw || typeof raw !== 'object') return empty();
    const col = raw as PostmanCollection;
    const collectionName = col.info?.name ?? 'Imported';
    const collections = new Map<string, ApiTestingCollection>();
    const root: ApiTestingCollection = {
        id: `collection:${collectionName}`,
        label: collectionName,
        source: 'manual',
        endpoints: [],
    };
    collections.set(root.id, root);
    let totalEndpoints = 0;

    walkItems(col.item ?? [], root, [collectionName], collections, col.auth, () => totalEndpoints++);

    for (const c of collections.values()) {
        c.endpoints.sort((a, b) =>
            (a.method + a.route).localeCompare(b.method + b.route, undefined, { sensitivity: 'base' }),
        );
    }
    return {
        totalEndpoints,
        collections: [...collections.values()].filter(c => c.endpoints.length > 0),
    };
}

function walkItems(
    items: PostmanItem[],
    currentCollection: ApiTestingCollection,
    path: string[],
    collections: Map<string, ApiTestingCollection>,
    inheritedAuth: PostmanAuth | undefined,
    onEndpoint: () => void,
): void {
    for (const item of items) {
        const auth = item.auth ?? inheritedAuth;
        if (item.request) {
            const ep = requestToEndpoint(item.name, item.request, auth);
            if (ep) {
                currentCollection.endpoints.push(ep);
                onEndpoint();
            }
            continue;
        }
        if (item.item) {
            // Nested folder — make a new collection one level deeper.
            const folderName = item.name ?? 'unnamed';
            const id = `collection:${[...path, folderName].join('/')}`;
            let folder = collections.get(id);
            if (!folder) {
                folder = { id, label: folderName, source: 'manual', endpoints: [] };
                collections.set(id, folder);
            }
            walkItems(item.item, folder, [...path, folderName], collections, auth, onEndpoint);
        }
    }
}

function requestToEndpoint(
    name: string | undefined,
    req: PostmanRequest,
    inheritedAuth: PostmanAuth | undefined,
): ApiTestingEndpoint | null {
    const method = (req.method ?? 'GET').toUpperCase();
    const urlShape = resolveUrl(req.url);
    if (!urlShape) return null;
    const handlerName = name ?? `${method.toLowerCase()}${camelify(urlShape.route)}`;
    const auth = req.auth ?? inheritedAuth;
    const authMode = auth?.type === 'bearer' ? 'required' as const : undefined;

    const pathParams: ApiTestingPathParam[] = (urlShape.pathVars ?? []).map(v => ({
        name: v.key,
        description: v.description,
        required: true,
    }));
    const queryParams: ApiTestingQueryParam[] = (urlShape.query ?? [])
        .filter(q => !q.disabled)
        .map(q => ({
            name: q.key,
            description: q.description,
        }));

    const requestSchema = liftBody(req.body);

    return {
        id: `imported:postman:${method}:${urlShape.route}`,
        method,
        route: urlShape.route,
        handlerName,
        filePath: 'postman.imported',
        auth: authMode,
        pathParams: pathParams.length > 0 ? pathParams : undefined,
        queryParams: queryParams.length > 0 ? queryParams : undefined,
        requestSchema,
    };
}

function liftBody(body: PostmanRequest['body']): ApiTestingEndpoint['requestSchema'] | undefined {
    if (!body || body.mode !== 'raw' || !body.raw) return undefined;
    const lang = body.options?.raw?.language?.toLowerCase();
    if (lang && lang !== 'json' && lang !== 'javascript') return undefined;
    try {
        const parsed = JSON.parse(body.raw);
        return {
            kind: 'json',
            source: 'jsdoc',
            schema: shapeFromExample(parsed),
        };
    } catch {
        return undefined;
    }
}

function shapeFromExample(value: unknown): import('../../graph/graphTypes').JsonSchemaLike {
    if (value === null) return { type: 'null', nullable: true };
    if (typeof value === 'string') return { type: 'string', example: value };
    if (typeof value === 'number') return { type: 'number', example: value };
    if (typeof value === 'boolean') return { type: 'boolean', example: value };
    if (Array.isArray(value)) {
        return { type: 'array', items: value.length > 0 ? shapeFromExample(value[0]) : undefined };
    }
    if (typeof value === 'object') {
        const out: import('../../graph/graphTypes').JsonSchemaLike = { type: 'object', properties: {} };
        const required: string[] = [];
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out.properties![k] = shapeFromExample(v);
            required.push(k);
        }
        if (required.length > 0) out.required = required;
        return out;
    }
    return {};
}

interface ResolvedUrl {
    route: string;
    query?: PostmanUrl['query'];
    pathVars?: PostmanUrl['variable'];
}

function resolveUrl(url: string | PostmanUrl | undefined): ResolvedUrl | null {
    if (!url) return null;
    if (typeof url === 'string') {
        return { route: normalisePath(url) };
    }
    if (url.raw) {
        // Some collections store both `raw` and structured fields — prefer
        // the raw URL but pass through the structured `query` + `variable`.
        return {
            route: normalisePath(url.raw),
            query: url.query,
            pathVars: url.variable,
        };
    }
    const host = url.host ? url.host.join('.') : '';
    const path = url.path ? url.path.join('/') : '';
    if (!host && !path) return null;
    const route = host ? `${host}/${path}` : `/${path}`;
    return { route: normalisePath(route), query: url.query, pathVars: url.variable };
}

function normalisePath(input: string): string {
    // Drop the protocol + host so the route is the path-and-template.
    // Postman conventions: path vars are `:name` or `{{name}}` — leave as-is.
    let s = input.trim();
    const m = /^[a-zA-Z]+:\/\/[^/]+(.*)$/.exec(s);
    if (m) s = m[1] || '/';
    if (!s.startsWith('/')) s = `/${s}`;
    // Strip query string — the runner appends it from `queryParams`.
    const q = s.indexOf('?');
    return q < 0 ? s : s.slice(0, q);
}

function camelify(route: string): string {
    return route
        .replace(/[:{}/?]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map(s => s.charAt(0).toUpperCase() + s.slice(1))
        .join('') || 'Root';
}

function empty(): ApiTestingPayload {
    return { totalEndpoints: 0, collections: [] };
}
