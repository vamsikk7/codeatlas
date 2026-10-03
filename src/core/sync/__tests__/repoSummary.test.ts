/**
 * ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — RepoSummary serialiser tests.
 *
 * Pure-function tests for the shape, schema-version gate, deterministic
 * serialisation (stable key/element order), and round-trip fidelity.
 */
import { describe, it, expect } from 'vitest';
import {
    SUMMARY_SCHEMA_VERSION,
    serializeRepoSummary,
    deserializeRepoSummary,
    emptyRepoSummary,
    RepoSummarySchemaVersionMismatch,
    dedupeApiSurfaces,
    type RepoSummary,
} from '../repoSummary';

function sample(overrides: Partial<RepoSummary> = {}): RepoSummary {
    return {
        repoId: 'repo-a',
        schemaVersion: SUMMARY_SCHEMA_VERSION,
        technology: 'nodejs',
        apis: [
            { apiId: 'GET:/api/u', method: 'GET', route: '/api/u', filePath: 'src/u.js', handlerName: 'getUser' },
        ],
        sdks: [{ sdkId: 'openai', name: 'OpenAI', category: 'ai' }],
        schemas: [{ engine: 'postgresql', tableName: 'users', displayName: 'User', source: 'prisma' }],
        httpClientPaths: ['http://other:3001/api/x/:id'],
        ...overrides,
    };
}

describe('RepoSummary — round-trip', () => {
    it('serialize → deserialize preserves every field', () => {
        const s = sample();
        const round = deserializeRepoSummary(serializeRepoSummary(s));
        expect(round).toEqual(s);
    });

    it('emptyRepoSummary creates a valid skeleton', () => {
        const s = emptyRepoSummary('repo-x');
        expect(s.repoId).toBe('repo-x');
        expect(s.schemaVersion).toBe(SUMMARY_SCHEMA_VERSION);
        expect(s.apis).toEqual([]);
        expect(s.sdks).toEqual([]);
        expect(s.schemas).toEqual([]);
        expect(s.httpClientPaths).toEqual([]);
        // Round-trips cleanly.
        expect(deserializeRepoSummary(serializeRepoSummary(s))).toEqual(s);
    });

    it('preserves optional failedAt + errorMessage', () => {
        const s = sample({ failedAt: 1700000000000, errorMessage: 'parse blew up' });
        const round = deserializeRepoSummary(serializeRepoSummary(s));
        expect(round.failedAt).toBe(1700000000000);
        expect(round.errorMessage).toBe('parse blew up');
    });
});

describe('RepoSummary — deterministic serialisation', () => {
    it('same content in different element order yields identical JSON', () => {
        const a = sample({
            sdks: [
                { sdkId: 'stripe', name: 'Stripe', category: 'payment' },
                { sdkId: 'openai', name: 'OpenAI', category: 'ai' },
            ],
        });
        const b = sample({
            sdks: [
                { sdkId: 'openai', name: 'OpenAI', category: 'ai' },
                { sdkId: 'stripe', name: 'Stripe', category: 'payment' },
            ],
        });
        expect(serializeRepoSummary(a)).toBe(serializeRepoSummary(b));
    });

    it('schemas sorted by (engine, tableName)', () => {
        const s = sample({
            schemas: [
                { engine: 'postgresql', tableName: 'orders', displayName: 'Order', source: 'prisma' },
                { engine: 'mongodb', tableName: 'users', displayName: 'User', source: 'mongoose' },
                { engine: 'postgresql', tableName: 'users', displayName: 'User', source: 'prisma' },
            ],
        });
        const round = deserializeRepoSummary(serializeRepoSummary(s));
        expect(round.schemas.map((x) => `${x.engine}:${x.tableName}`)).toEqual([
            'mongodb:users',
            'postgresql:orders',
            'postgresql:users',
        ]);
    });

    it('httpClientPaths sorted', () => {
        const s = sample({ httpClientPaths: ['z', 'a', 'm'] });
        const round = deserializeRepoSummary(serializeRepoSummary(s));
        expect(round.httpClientPaths).toEqual(['a', 'm', 'z']);
    });
});

describe('RepoSummary — schema version gate', () => {
    it('rejects payload with mismatched schema version', () => {
        const wrong = JSON.stringify({
            repoId: 'r', schemaVersion: 999, technology: 'nodejs',
            apis: [], sdks: [], schemas: [], httpClientPaths: [],
        });
        expect(() => deserializeRepoSummary(wrong)).toThrow(RepoSummarySchemaVersionMismatch);
    });

    it('error names received + expected versions for diagnostics', () => {
        try {
            deserializeRepoSummary(JSON.stringify({
                repoId: 'r', schemaVersion: 999, technology: 'nodejs',
                apis: [], sdks: [], schemas: [], httpClientPaths: [],
            }));
            expect.fail('should have thrown');
        } catch (err: any) {
            expect(err).toBeInstanceOf(RepoSummarySchemaVersionMismatch);
            expect(err.received).toBe(999);
            expect(err.expected).toBe(SUMMARY_SCHEMA_VERSION);
        }
    });
});

describe('RepoSummary — malformed input', () => {
    it('throws on non-object root', () => {
        expect(() => deserializeRepoSummary('"plain string"')).toThrow(/not an object/);
    });

    it('throws on missing schemaVersion', () => {
        expect(() => deserializeRepoSummary(JSON.stringify({ repoId: 'r' }))).toThrow(/schemaVersion/);
    });

    it('throws on missing repoId', () => {
        expect(() => deserializeRepoSummary(JSON.stringify({
            schemaVersion: SUMMARY_SCHEMA_VERSION,
        }))).toThrow(/repoId/);
    });

    it('coerces missing optional arrays to []', () => {
        const minimal = JSON.stringify({
            repoId: 'r',
            schemaVersion: SUMMARY_SCHEMA_VERSION,
            technology: 'nodejs',
            // no apis/sdks/schemas/httpClientPaths
        });
        const r = deserializeRepoSummary(minimal);
        expect(r.apis).toEqual([]);
        expect(r.sdks).toEqual([]);
        expect(r.schemas).toEqual([]);
        expect(r.httpClientPaths).toEqual([]);
    });

    it('defaults missing technology to "unknown"', () => {
        const noTech = JSON.stringify({
            repoId: 'r',
            schemaVersion: SUMMARY_SCHEMA_VERSION,
        });
        expect(deserializeRepoSummary(noTech).technology).toBe('unknown');
    });
});

// #817 / #830 (2026-06-11) — surface dedupe. The JS rebuild path leaves a
// duplicate apiIndex record per route with handlerName 'express'; without
// the dedupe the duplicate's hash overwrote the real one in apiHashes and
// every consumer edge flipped `modified` after ANY producer save.
describe('dedupeApiSurfaces (#817/#830)', () => {
    const api = (route: string, handlerName: string, method = 'GET') => ({
        apiId: `${method}:${route}::server.js::${handlerName}`,
        method, route, filePath: 'server.js', handlerName,
    });

    it('prefers a specific handler over a generic framework token, regardless of order', () => {
        const a = dedupeApiSurfaces([api('/api/items', 'listItems'), api('/api/items', 'express')]);
        const b = dedupeApiSurfaces([api('/api/items', 'express'), api('/api/items', 'listItems')]);
        expect(a).toHaveLength(1);
        expect(a[0].handlerName).toBe('listItems');
        expect(b[0].handlerName).toBe('listItems');
    });

    it('ties between specific handlers break lexicographically (deterministic)', () => {
        const a = dedupeApiSurfaces([api('/x', 'zeta'), api('/x', 'alpha')]);
        const b = dedupeApiSurfaces([api('/x', 'alpha'), api('/x', 'zeta')]);
        expect(a[0].handlerName).toBe('alpha');
        expect(b[0].handlerName).toBe('alpha');
    });

    it('distinct routes / methods are untouched', () => {
        const out = dedupeApiSurfaces([
            api('/a', 'ha'), api('/b', 'hb'), api('/a', 'hc', 'POST'),
        ]);
        expect(out).toHaveLength(3);
    });

    it('all-generic duplicates keep one deterministic winner', () => {
        const out = dedupeApiSurfaces([api('/a', 'router'), api('/a', 'express')]);
        expect(out).toHaveLength(1);
        expect(out[0].handlerName).toBe('express'); // lexicographic among generics
    });
});
