/**
 * openapi.test.ts — Issue #705 Phase 2 OpenAPI / Swagger parser.
 */

import { describe, it, expect } from 'vitest';
import { canParseOpenApi, parseOpenApi } from '../openapi';

describe('canParseOpenApi', () => {
    it('matches bare openapi/swagger filenames', () => {
        expect(canParseOpenApi('openapi.yaml')).toBe(true);
        expect(canParseOpenApi('openapi.yml')).toBe(true);
        expect(canParseOpenApi('openapi.json')).toBe(true);
        expect(canParseOpenApi('docs/swagger.yaml')).toBe(true);
        expect(canParseOpenApi('docs/swagger.json')).toBe(true);
    });

    it('matches suffix variants', () => {
        expect(canParseOpenApi('apps/api/spec.openapi.yaml')).toBe(true);
        expect(canParseOpenApi('public/spec.swagger.json')).toBe(true);
        expect(canParseOpenApi('public/spec.oas.json')).toBe(true);
    });

    it('rejects unrelated YAML / JSON', () => {
        expect(canParseOpenApi('package.json')).toBe(false);
        expect(canParseOpenApi('deploy/app.yaml')).toBe(false);
    });
});

describe('parseOpenApi', () => {
    it('extracts paths + methods from YAML spec', () => {
        const src = [
            'openapi: 3.0.0',
            'info:',
            '  title: Demo',
            'paths:',
            '  /users:',
            '    get:',
            '      operationId: listUsers',
            '      summary: List users',
            '      tags: [users]',
            '    post:',
            '      operationId: createUser',
            '  /users/{id}:',
            '    get:',
            '      operationId: getUser',
            'components:',
            '  schemas: {}',
        ].join('\n');
        const recs = parseOpenApi('openapi.yaml', src);
        const names = recs.map(r => r.name).sort();
        expect(names).toEqual(['GET /users', 'GET /users/{id}', 'POST /users']);
        const listUsers = recs.find(r => r.meta?.operationId === 'listUsers')!;
        expect(listUsers.kind).toBe('openapi-route');
        expect(listUsers.meta?.method).toBe('GET');
        expect(listUsers.meta?.route).toBe('/users');
        expect(listUsers.meta?.summary).toBe('List users');
        expect(listUsers.meta?.tags).toEqual(['users']);
    });

    it('extracts paths + methods from JSON spec', () => {
        const src = JSON.stringify({
            openapi: '3.0.0',
            paths: {
                '/items': {
                    get: { operationId: 'listItems', summary: 'List items', tags: ['items'] },
                    post: { operationId: 'createItem' },
                },
                '/items/{id}': { delete: { operationId: 'deleteItem' } },
            },
        });
        const recs = parseOpenApi('public/spec.openapi.json', src);
        expect(recs.map(r => r.name).sort()).toEqual(['DELETE /items/{id}', 'GET /items', 'POST /items']);
        const list = recs.find(r => r.meta?.operationId === 'listItems')!;
        expect(list.meta?.tags).toEqual(['items']);
    });

    it('returns no records for empty paths block', () => {
        const src = 'openapi: 3.0.0\npaths: {}\n';
        expect(parseOpenApi('openapi.yaml', src)).toEqual([]);
    });

    it('tolerates malformed JSON without throwing', () => {
        const src = '{not valid json';
        expect(parseOpenApi('openapi.json', src)).toEqual([]);
    });
});
