/**
 * postman.test.ts — Issue #604 Phase 4 Postman v2.1 importer.
 */

import { describe, it, expect } from 'vitest';
import { importPostmanCollection } from '../importers/postman';

describe('importPostmanCollection', () => {
    it('returns empty for non-object input', () => {
        expect(importPostmanCollection(null).totalEndpoints).toBe(0);
    });

    it('imports a flat list of requests into the collection-level group', () => {
        const col = {
            info: { name: 'Demo' },
            item: [
                {
                    name: 'list articles',
                    request: { method: 'GET', url: 'https://api.example.com/api/articles' },
                },
                {
                    name: 'login',
                    request: {
                        method: 'POST',
                        url: 'https://api.example.com/api/users/login',
                        body: { mode: 'raw', raw: '{"email":"a@b.com"}', options: { raw: { language: 'json' } } },
                    },
                },
            ],
        };
        const out = importPostmanCollection(col);
        expect(out.totalEndpoints).toBe(2);
        expect(out.collections).toHaveLength(1);
        expect(out.collections[0].id).toBe('collection:Demo');
        const post = out.collections[0].endpoints.find(e => e.method === 'POST')!;
        expect(post.route).toBe('/api/users/login');
        expect(post.requestSchema?.kind).toBe('json');
        expect(post.requestSchema?.schema?.properties?.email?.example).toBe('a@b.com');
    });

    it('flattens nested folders into their own collections', () => {
        const col = {
            info: { name: 'Demo' },
            item: [
                {
                    name: 'auth',
                    item: [
                        { name: 'login', request: { method: 'POST', url: 'https://api/api/users/login' } },
                        { name: 'register', request: { method: 'POST', url: 'https://api/api/users' } },
                    ],
                },
                {
                    name: 'articles',
                    item: [
                        { name: 'list', request: { method: 'GET', url: 'https://api/api/articles' } },
                    ],
                },
            ],
        };
        const out = importPostmanCollection(col);
        expect(out.totalEndpoints).toBe(3);
        const labels = out.collections.map(c => c.label).sort();
        expect(labels).toContain('auth');
        expect(labels).toContain('articles');
    });

    it('propagates bearer auth from the collection level to nested requests', () => {
        const col = {
            info: { name: 'X' },
            auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
            item: [
                { name: 'me', request: { method: 'GET', url: 'https://api/me' } },
            ],
        };
        const out = importPostmanCollection(col);
        expect(out.collections[0].endpoints[0].auth).toBe('required');
    });

    it('drops disabled query params', () => {
        const col = {
            info: { name: 'Q' },
            item: [
                {
                    name: 'list',
                    request: {
                        method: 'GET',
                        url: {
                            raw: 'https://api/list?a=1&b=2',
                            query: [
                                { key: 'a', value: '1' },
                                { key: 'b', value: '2', disabled: true },
                            ],
                        },
                    },
                },
            ],
        };
        const out = importPostmanCollection(col);
        const ep = out.collections[0].endpoints[0];
        expect(ep.queryParams?.map(q => q.name)).toEqual(['a']);
    });

    it('handles requests without any body', () => {
        const col = {
            info: { name: 'X' },
            item: [{ name: 'g', request: { method: 'GET', url: 'https://api/x' } }],
        };
        const out = importPostmanCollection(col);
        expect(out.collections[0].endpoints[0].requestSchema).toBeUndefined();
    });

    it('drops non-JSON raw bodies', () => {
        const col = {
            info: { name: 'X' },
            item: [{
                name: 'g', request: {
                    method: 'POST', url: 'https://api/x',
                    body: { mode: 'raw', raw: 'plain text', options: { raw: { language: 'text' } } },
                },
            }],
        };
        const out = importPostmanCollection(col);
        expect(out.collections[0].endpoints[0].requestSchema).toBeUndefined();
    });
});
