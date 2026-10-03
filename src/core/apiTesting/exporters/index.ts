/**
 * apiTesting/exporters/index.ts — #604 collection exporter (2026-06-06).
 *
 * Converts the in-app `ApiTestingPayload` into one of three portable
 * collection formats. Symmetric to the importers shipped under
 * `src/core/apiTesting/importers/`. The shape we emit is the minimum
 * the consuming tool needs to open the file — no extras.
 *
 * Supported formats:
 *   - `postman`     → Postman v2.1 collection JSON
 *   - `hoppscotch`  → Hoppscotch v1 collection JSON
 *   - `insomnia`    → Insomnia v4 export JSON
 *
 * Throws on unknown format. Empty payload produces a valid empty
 * collection for the target format (no exception).
 */

import type { ApiTestingPayload, ApiTestingCollection, ApiTestingEndpoint } from '../types';

export type ExportFormat = 'postman' | 'hoppscotch' | 'insomnia';

export interface ExportResult {
    format: ExportFormat;
    /** JSON-encoded spec body. */
    body: string;
    /** Convention-friendly filename for download dialogs. */
    suggestedFilename: string;
}

export function exportApiCollection(payload: ApiTestingPayload, format: ExportFormat): ExportResult {
    switch (format) {
        case 'postman':
            return {
                format,
                body: JSON.stringify(buildPostman(payload), null, 2),
                suggestedFilename: `codeatlas-${stamp()}.postman_collection.json`,
            };
        case 'hoppscotch':
            return {
                format,
                body: JSON.stringify(buildHoppscotch(payload), null, 2),
                suggestedFilename: `codeatlas-${stamp()}.hoppscotch.json`,
            };
        case 'insomnia':
            return {
                format,
                body: JSON.stringify(buildInsomnia(payload), null, 2),
                suggestedFilename: `codeatlas-${stamp()}.insomnia.json`,
            };
        default:
            throw new Error(`Unsupported export format: ${format}`);
    }
}

function stamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// ── Postman v2.1 ─────────────────────────────────────────────────────

function buildPostman(payload: ApiTestingPayload): Record<string, unknown> {
    return {
        info: {
            name: 'CodeAtlas export',
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
            _postman_id: `codeatlas-${Date.now()}`,
        },
        item: payload.collections.map(folderPostman),
    };
}

function folderPostman(collection: ApiTestingCollection): Record<string, unknown> {
    return {
        name: collection.label,
        item: collection.endpoints.map(endpointPostman),
    };
}

function endpointPostman(endpoint: ApiTestingEndpoint): Record<string, unknown> {
    const out: Record<string, unknown> = {
        name: `${endpoint.method} ${endpoint.route}`,
        request: {
            method: endpoint.method,
            url: {
                raw: `{{base}}${endpoint.route}`,
                host: ['{{base}}'],
                path: endpoint.route.split('/').filter(Boolean),
            },
            description: `${endpoint.handlerName} — ${endpoint.filePath}`,
        },
        response: [],
    };
    if (endpoint.auth === 'required') {
        ((out.request as Record<string, unknown>).auth as unknown) = {
            type: 'bearer',
            bearer: [{ key: 'token', value: '{{bearerToken}}', type: 'string' }],
        };
    }
    return out;
}

// ── Hoppscotch v1 ────────────────────────────────────────────────────

function buildHoppscotch(payload: ApiTestingPayload): Record<string, unknown> {
    return {
        v: 1,
        name: 'CodeAtlas export',
        folders: payload.collections.map(folderHoppscotch),
        requests: [],
    };
}

function folderHoppscotch(collection: ApiTestingCollection): Record<string, unknown> {
    return {
        name: collection.label,
        folders: [],
        requests: collection.endpoints.map(endpointHoppscotch),
    };
}

function endpointHoppscotch(endpoint: ApiTestingEndpoint): Record<string, unknown> {
    return {
        v: '1',
        name: `${endpoint.method} ${endpoint.route}`,
        method: endpoint.method,
        endpoint: `<<base>>${endpoint.route}`,
        params: [],
        headers: endpoint.auth === 'required'
            ? [{ key: 'Authorization', value: 'Bearer <<bearerToken>>', active: true }]
            : [],
        preRequestScript: '',
        testScript: '',
        body: { contentType: null, body: null },
    };
}

// ── Insomnia v4 ──────────────────────────────────────────────────────

function buildInsomnia(payload: ApiTestingPayload): Record<string, unknown> {
    const workspaceId = `wrk_${Date.now()}`;
    const resources: Array<Record<string, unknown>> = [
        {
            _id: workspaceId,
            _type: 'workspace',
            parentId: null,
            name: 'CodeAtlas export',
            description: 'Exported by CodeAtlas',
            scope: 'collection',
        },
    ];
    payload.collections.forEach((col, ci) => {
        const groupId = `fld_${Date.now()}_${ci}`;
        resources.push({
            _id: groupId,
            _type: 'request_group',
            parentId: workspaceId,
            name: col.label,
            description: '',
        });
        col.endpoints.forEach((ep, ei) => {
            const reqId = `req_${Date.now()}_${ci}_${ei}`;
            const headers: Array<Record<string, string>> = [];
            if (ep.auth === 'required') {
                headers.push({ name: 'Authorization', value: 'Bearer {{ bearerToken }}' });
            }
            resources.push({
                _id: reqId,
                _type: 'request',
                parentId: groupId,
                name: `${ep.method} ${ep.route}`,
                method: ep.method,
                url: `{{ base }}${ep.route}`,
                headers,
                body: {},
                description: `${ep.handlerName} — ${ep.filePath}`,
            });
        });
    });
    return {
        _type: 'export',
        __export_format: 4,
        __export_date: new Date().toISOString(),
        __export_source: 'codeatlas',
        resources,
    };
}
