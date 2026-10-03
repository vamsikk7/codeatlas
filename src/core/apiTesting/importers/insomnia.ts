/**
 * apiTesting/importers/insomnia.ts — Issue #604 Phase 4.
 *
 * Parse an Insomnia export (v4 format) into the `ApiTestingPayload`
 * shape. The export shape:
 *
 *   {
 *     "_type": "export",
 *     "__export_format": 4,
 *     "resources": [
 *       { "_type": "request_group", "name": "Folder A", "parentId": "wrk_…" },
 *       { "_type": "request", "method": "POST", "url": "{{base}}/api/x",
 *         "body": { "mimeType": "application/json", "text": "{…}" },
 *         "headers": [...], "parentId": "fld_…" },
 *       { "_type": "workspace", "_id": "wrk_…" },
 *       { "_type": "environment", "data": { base: "http://localhost" } },
 *       ...
 *     ]
 *   }
 *
 * Each `request_group` becomes a collection; requests inherit their
 * group via `parentId`. Requests parented to the workspace land in
 * the workspace-named collection.
 */

import type { ApiTestingPayload, ApiTestingEndpoint, ApiTestingCollection } from '../types';

interface InsomniaResource {
    _id: string;
    _type: string;
    parentId?: string;
    name?: string;
    method?: string;
    url?: string;
    headers?: Array<{ name: string; value: string; disabled?: boolean }>;
    body?: { mimeType?: string; text?: string };
    authentication?: { type?: string; token?: string };
    description?: string;
}

export function importInsomniaExport(raw: unknown): ApiTestingPayload {
    if (!raw || typeof raw !== 'object') return empty();
    const obj = raw as { resources?: InsomniaResource[]; __export_format?: number };
    const resources = Array.isArray(obj.resources) ? obj.resources : [];
    if (resources.length === 0) return empty();

    const byId = new Map<string, InsomniaResource>();
    for (const r of resources) byId.set(r._id, r);

    const workspace = resources.find(r => r._type === 'workspace');
    const workspaceName = workspace?.name ?? 'Imported';

    const collections = new Map<string, ApiTestingCollection>();
    const root: ApiTestingCollection = {
        id: `collection:${workspaceName}`,
        label: workspaceName,
        source: 'manual',
        endpoints: [],
    };
    collections.set(root.id, root);

    const folderToCollection = new Map<string, ApiTestingCollection>();
    for (const r of resources) {
        if (r._type !== 'request_group') continue;
        const id = `collection:${r._id}`;
        const c: ApiTestingCollection = {
            id,
            label: r.name ?? 'Group',
            source: 'manual',
            endpoints: [],
        };
        collections.set(id, c);
        folderToCollection.set(r._id, c);
    }

    let totalEndpoints = 0;
    for (const r of resources) {
        if (r._type !== 'request') continue;
        const ep = requestToEndpoint(r);
        if (!ep) continue;
        const folder = r.parentId ? folderToCollection.get(r.parentId) : undefined;
        const collection = folder ?? root;
        collection.endpoints.push(ep);
        totalEndpoints++;
    }

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

function requestToEndpoint(r: InsomniaResource): ApiTestingEndpoint | null {
    if (!r.url) return null;
    const method = (r.method ?? 'GET').toUpperCase();
    const route = normalisePath(r.url);
    const handlerName = r.name ?? `${method.toLowerCase()}${camelify(route)}`;
    const auth = r.authentication?.type === 'bearer' ? 'required' as const : undefined;
    const requestSchema = liftBody(r.body);

    return {
        id: `imported:insomnia:${method}:${route}`,
        method,
        route,
        handlerName,
        filePath: 'insomnia.imported',
        auth,
        requestSchema,
    };
}

function liftBody(body: InsomniaResource['body']): ApiTestingEndpoint['requestSchema'] | undefined {
    if (!body || !body.text) return undefined;
    const mime = body.mimeType?.toLowerCase() ?? '';
    if (mime && !mime.includes('json')) return undefined;
    try {
        const parsed = JSON.parse(body.text);
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

function normalisePath(input: string): string {
    let s = input.trim();
    const m = /^[a-zA-Z]+:\/\/[^/]+(.*)$/.exec(s);
    if (m) s = m[1] || '/';
    if (!s.startsWith('/')) s = `/${s}`;
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
