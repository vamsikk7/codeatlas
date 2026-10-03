/**
 * openapi.test.ts — Issue #604 Phase 4 OpenAPI importer.
 */

import { describe, it, expect } from 'vitest';
import { importOpenApi } from '../importers/openapi';

describe('importOpenApi', () => {
    it('returns empty for non-object input', () => {
        expect(importOpenApi(null)).toEqual({ totalEndpoints: 0, collections: [] });
        expect(importOpenApi('not a spec')).toEqual({ totalEndpoints: 0, collections: [] });
    });

    it('returns empty when there are no paths', () => {
        const out = importOpenApi({ openapi: '3.0.0', info: { title: 'x', version: '1' } });
        expect(out.totalEndpoints).toBe(0);
    });

    it('imports a single GET operation into the default collection', () => {
        const spec = {
            openapi: '3.0.0',
            paths: {
                '/api/articles': {
                    get: { operationId: 'listArticles', summary: 'List articles' },
                },
            },
        };
        const out = importOpenApi(spec);
        expect(out.totalEndpoints).toBe(1);
        expect(out.collections[0].id).toBe('collection:default');
        expect(out.collections[0].endpoints[0]).toMatchObject({
            method: 'GET', route: '/api/articles', handlerName: 'listArticles',
        });
    });

    it('groups operations by tag', () => {
        const spec = {
            paths: {
                '/users': {
                    get: { operationId: 'listUsers', tags: ['users'] },
                    post: { operationId: 'createUser', tags: ['users'] },
                },
                '/articles': {
                    get: { operationId: 'listArticles', tags: ['articles'] },
                },
                '/health': {
                    get: { operationId: 'health' },
                },
            },
        };
        const out = importOpenApi(spec);
        expect(out.totalEndpoints).toBe(4);
        const ids = out.collections.map(c => c.id).sort();
        expect(ids).toEqual(['collection:articles', 'collection:default', 'collection:users']);
        const users = out.collections.find(c => c.id === 'collection:users')!;
        expect(users.endpoints).toHaveLength(2);
    });

    it('lifts path + query parameters', () => {
        const spec = {
            paths: {
                '/users/{id}': {
                    get: {
                        operationId: 'getUser',
                        parameters: [
                            { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'User id' },
                            { name: 'expand', in: 'query', schema: { type: 'string' } },
                        ],
                    },
                },
            },
        };
        const out = importOpenApi(spec);
        const ep = out.collections[0].endpoints[0];
        expect(ep.pathParams).toEqual([
            { name: 'id', type: 'integer', required: true, description: 'User id' },
        ]);
        expect(ep.queryParams).toEqual([
            { name: 'expand', type: 'string', required: false, description: undefined },
        ]);
    });

    it('lifts an `application/json` request body', () => {
        const spec = {
            paths: {
                '/articles': {
                    post: {
                        operationId: 'createArticle',
                        requestBody: {
                            required: true,
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            title: { type: 'string' },
                                            published: { type: 'boolean' },
                                        },
                                        required: ['title'],
                                    },
                                },
                            },
                        },
                    },
                },
            },
        };
        const out = importOpenApi(spec);
        const schema = out.collections[0].endpoints[0].requestSchema;
        expect(schema?.kind).toBe('json');
        expect(schema?.schema?.properties?.title?.type).toBe('string');
        expect(schema?.schema?.required).toEqual(['title']);
    });

    it('flags `auth: required` when security is present', () => {
        const spec = {
            paths: {
                '/me': {
                    get: { operationId: 'me', security: [{ bearerAuth: [] }] },
                },
            },
        };
        const out = importOpenApi(spec);
        expect(out.collections[0].endpoints[0].auth).toBe('required');
    });

    it('preserves `$ref` as a description hint', () => {
        const spec = {
            paths: {
                '/x': {
                    post: {
                        requestBody: {
                            content: { 'application/json': { schema: { $ref: '#/components/schemas/Foo' } } },
                        },
                    },
                },
            },
        };
        const out = importOpenApi(spec);
        const s = out.collections[0].endpoints[0].requestSchema?.schema;
        expect(s?.type).toBe('object');
        expect(s?.description).toBe('$ref:#/components/schemas/Foo');
    });

    it('lifts response schemas with status codes', () => {
        const spec = {
            paths: {
                '/x': {
                    get: {
                        responses: {
                            '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } },
                            '404': { description: 'Not found' },
                        },
                    },
                },
            },
        };
        const out = importOpenApi(spec);
        const responses = out.collections[0].endpoints[0].responseSchema!;
        expect(responses.map(r => r.status)).toEqual([200, 404]);
        expect(responses[0].schema?.type).toBe('object');
    });
});
