/**
 * exporters.test.ts — #604 API collection exporter (2026-06-06).
 *
 * Round-trip tests for the three target formats. Each test asserts the
 * minimal shape the consuming tool expects: Postman v2.1 collection,
 * Hoppscotch v1, Insomnia v4. Schemas are tolerant — we only check the
 * fields end users (and the importers we ship) actually read.
 */
import { describe, it, expect } from 'vitest';
import { exportApiCollection, type ExportFormat } from '../index';
import type { ApiTestingPayload } from '../../types';

function makePayload(): ApiTestingPayload {
    return {
        totalEndpoints: 3,
        collections: [
            {
                id: 'cluster:auth',
                label: 'auth',
                source: 'l2a-cluster',
                endpoints: [
                    {
                        id: 'POST:/api/users/login::src/auth.ts::login',
                        method: 'POST',
                        route: '/api/users/login',
                        handlerName: 'login',
                        filePath: 'src/auth.ts',
                        auth: 'optional',
                    },
                    {
                        id: 'GET:/api/user::src/auth.ts::me',
                        method: 'GET',
                        route: '/api/user',
                        handlerName: 'me',
                        filePath: 'src/auth.ts',
                        auth: 'required',
                    },
                ],
            },
            {
                id: 'cluster:articles',
                label: 'articles',
                source: 'l2a-cluster',
                endpoints: [
                    {
                        id: 'GET:/api/articles::src/articles.ts::list',
                        method: 'GET',
                        route: '/api/articles',
                        handlerName: 'list',
                        filePath: 'src/articles.ts',
                    },
                ],
            },
        ],
    };
}

describe('exportApiCollection — Postman v2.1', () => {
    it('emits the canonical v2.1 schema URL + folder-per-collection structure', () => {
        const result = exportApiCollection(makePayload(), 'postman');
        expect(result.format).toBe('postman');
        expect(result.suggestedFilename).toMatch(/\.postman_collection\.json$/);
        const spec = JSON.parse(result.body);
        expect(spec.info?.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
        expect(spec.info?.name).toBeTruthy();
        expect(spec.item).toBeInstanceOf(Array);
        // One folder per collection
        expect(spec.item).toHaveLength(2);
        const auth = spec.item.find((f: any) => f.name === 'auth');
        expect(auth?.item).toHaveLength(2);
        const login = auth.item.find((r: any) => r.name === 'POST /api/users/login');
        expect(login?.request?.method).toBe('POST');
        expect(login?.request?.url?.raw).toMatch(/\/api\/users\/login/);
    });

    it('attaches a bearer-token auth stub for endpoints that require auth', () => {
        const result = exportApiCollection(makePayload(), 'postman');
        const spec = JSON.parse(result.body);
        const auth = spec.item.find((f: any) => f.name === 'auth');
        const me = auth.item.find((r: any) => r.name === 'GET /api/user');
        expect(me?.request?.auth?.type).toBe('bearer');
    });
});

describe('exportApiCollection — Hoppscotch v1', () => {
    it('emits the canonical Hoppscotch schema header + folder-per-collection structure', () => {
        const result = exportApiCollection(makePayload(), 'hoppscotch');
        expect(result.format).toBe('hoppscotch');
        expect(result.suggestedFilename).toMatch(/\.hoppscotch\.json$/);
        const spec = JSON.parse(result.body);
        expect(spec.v).toBe(1);
        expect(spec.folders).toBeInstanceOf(Array);
        expect(spec.folders).toHaveLength(2);
        const auth = spec.folders.find((f: any) => f.name === 'auth');
        expect(auth?.requests).toHaveLength(2);
        const login = auth.requests.find((r: any) => r.name === 'POST /api/users/login');
        expect(login?.method).toBe('POST');
        expect(login?.endpoint).toMatch(/\/api\/users\/login/);
    });
});

describe('exportApiCollection — Insomnia v4', () => {
    it('emits the canonical Insomnia v4 _type + resource array structure', () => {
        const result = exportApiCollection(makePayload(), 'insomnia');
        expect(result.format).toBe('insomnia');
        expect(result.suggestedFilename).toMatch(/\.insomnia\.json$/);
        const spec = JSON.parse(result.body);
        expect(spec._type).toBe('export');
        expect(spec.__export_format).toBe(4);
        expect(spec.resources).toBeInstanceOf(Array);
        // One workspace + one request_group per collection + one request per endpoint
        const workspaces = spec.resources.filter((r: any) => r._type === 'workspace');
        const groups = spec.resources.filter((r: any) => r._type === 'request_group');
        const requests = spec.resources.filter((r: any) => r._type === 'request');
        expect(workspaces).toHaveLength(1);
        expect(groups).toHaveLength(2);
        expect(requests).toHaveLength(3);
        // Every request links to its group via parentId
        for (const req of requests) {
            const parent = groups.find((g: any) => g._id === req.parentId);
            expect(parent, `request ${req.name} parent group present`).toBeTruthy();
        }
    });
});

describe('exportApiCollection — unknown format', () => {
    it('throws when given an unsupported format', () => {
        expect(() => exportApiCollection(makePayload(), 'asdf' as ExportFormat)).toThrow(/format/i);
    });
});

describe('exportApiCollection — empty payload', () => {
    it('emits a valid (empty) Postman collection when no endpoints exist', () => {
        const result = exportApiCollection({ totalEndpoints: 0, collections: [] }, 'postman');
        const spec = JSON.parse(result.body);
        expect(spec.item).toEqual([]);
    });
});
