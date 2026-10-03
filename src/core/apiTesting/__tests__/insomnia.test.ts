/**
 * insomnia.test.ts — Issue #604 Phase 4 Insomnia importer.
 */

import { describe, it, expect } from 'vitest';
import { importInsomniaExport } from '../importers/insomnia';

describe('importInsomniaExport', () => {
    it('returns empty for non-object input', () => {
        expect(importInsomniaExport(null).totalEndpoints).toBe(0);
    });

    it('imports requests parented to the workspace into the workspace collection', () => {
        const exp = {
            _type: 'export',
            __export_format: 4,
            resources: [
                { _id: 'wrk_1', _type: 'workspace', name: 'My Workspace' },
                {
                    _id: 'req_1', _type: 'request', name: 'list articles',
                    parentId: 'wrk_1', method: 'GET', url: '{{base}}/api/articles',
                },
                {
                    _id: 'req_2', _type: 'request', name: 'login',
                    parentId: 'wrk_1', method: 'POST',
                    url: 'https://api.example.com/api/users/login',
                    body: { mimeType: 'application/json', text: '{"email":"a@b.com"}' },
                },
            ],
        };
        const out = importInsomniaExport(exp);
        expect(out.totalEndpoints).toBe(2);
        expect(out.collections[0].id).toBe('collection:My Workspace');
        const post = out.collections[0].endpoints.find(e => e.method === 'POST')!;
        expect(post.requestSchema?.kind).toBe('json');
    });

    it('groups requests into request_group folders', () => {
        const exp = {
            resources: [
                { _id: 'wrk_1', _type: 'workspace', name: 'X' },
                { _id: 'fld_auth', _type: 'request_group', name: 'auth', parentId: 'wrk_1' },
                { _id: 'fld_articles', _type: 'request_group', name: 'articles', parentId: 'wrk_1' },
                { _id: 'r1', _type: 'request', name: 'login', parentId: 'fld_auth', method: 'POST', url: 'https://api/api/users/login' },
                { _id: 'r2', _type: 'request', name: 'register', parentId: 'fld_auth', method: 'POST', url: 'https://api/api/users' },
                { _id: 'r3', _type: 'request', name: 'list', parentId: 'fld_articles', method: 'GET', url: 'https://api/api/articles' },
            ],
        };
        const out = importInsomniaExport(exp);
        expect(out.totalEndpoints).toBe(3);
        const labels = out.collections.map(c => c.label).sort();
        expect(labels).toEqual(['articles', 'auth']);
    });

    it('marks bearer-auth requests as required', () => {
        const exp = {
            resources: [
                { _id: 'wrk_1', _type: 'workspace', name: 'X' },
                {
                    _id: 'r1', _type: 'request', parentId: 'wrk_1',
                    method: 'GET', url: 'https://api/me',
                    authentication: { type: 'bearer', token: '{{token}}' },
                },
            ],
        };
        const out = importInsomniaExport(exp);
        expect(out.collections[0].endpoints[0].auth).toBe('required');
    });

    it('drops non-JSON bodies', () => {
        const exp = {
            resources: [
                { _id: 'wrk_1', _type: 'workspace', name: 'X' },
                {
                    _id: 'r1', _type: 'request', parentId: 'wrk_1',
                    method: 'POST', url: 'https://api/x',
                    body: { mimeType: 'text/plain', text: 'hi' },
                },
            ],
        };
        const out = importInsomniaExport(exp);
        expect(out.collections[0].endpoints[0].requestSchema).toBeUndefined();
    });

    it('normalises URLs to absolute paths', () => {
        const exp = {
            resources: [
                { _id: 'wrk_1', _type: 'workspace', name: 'X' },
                { _id: 'r1', _type: 'request', parentId: 'wrk_1', method: 'GET', url: 'https://api.example.com/api/x?y=1' },
            ],
        };
        const out = importInsomniaExport(exp);
        expect(out.collections[0].endpoints[0].route).toBe('/api/x');
    });
});
