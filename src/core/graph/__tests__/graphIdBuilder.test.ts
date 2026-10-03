/**
 * graphIdBuilder.test.ts — Issue #362 Phase A (2026-06-07).
 *
 * Round-trip invariants for every graph-id shape the codebase emits
 * today. Locks in the parser's part-count behaviour so Phase B/C
 * migrations can swap call sites without changing semantics.
 */
import { describe, it, expect } from 'vitest';
import { makeGraphId, parseGraphId, isGraphIdOfType, graphIdPart } from '../graphIdBuilder';

describe('makeGraphId', () => {
    it('builds a single-part id', () => {
        expect(makeGraphId('feature', ['workspace'])).toBe('feature:workspace');
        expect(makeGraphId('file', ['src/a.ts'])).toBe('file:src/a.ts');
        expect(makeGraphId('microservice', ['workspace'])).toBe('microservice:workspace');
    });

    it('builds a two-part id (flow / sequence)', () => {
        expect(makeGraphId('flow', ['src/a.ts', 'doThing'])).toBe('flow:src/a.ts:doThing');
        expect(makeGraphId('sequence', ['src/a.ts', 'anonymous@GET:/users']))
            .toBe('sequence:src/a.ts:anonymous@GET:/users');
    });

    it('preserves colons inside the LAST part', () => {
        // The route key carries its own colon.
        expect(makeGraphId('api-list', ['cluster:auth'])).toBe('api-list:cluster:auth');
        expect(makeGraphId('feature', ['service:main'])).toBe('feature:service:main');
    });

    it('with empty parts collapses to the bare type', () => {
        expect(makeGraphId('health', [])).toBe('health');
    });

    it('throws on missing type', () => {
        expect(() => makeGraphId('', ['x'])).toThrow(/type is required/);
    });

    it('throws on non-array parts', () => {
        expect(() => makeGraphId('feature', null as any)).toThrow(/parts must be an array/);
    });
});

describe('parseGraphId — single-part types', () => {
    it('parses a workspace-level feature id', () => {
        expect(parseGraphId('feature:workspace')).toEqual({ type: 'feature', parts: ['workspace'] });
    });

    it('parses a per-service feature id (inner colon preserved)', () => {
        expect(parseGraphId('feature:service:main')).toEqual({ type: 'feature', parts: ['service:main'] });
    });

    it('parses a file graph id', () => {
        expect(parseGraphId('file:src/app/routes/auth.ts')).toEqual({
            type: 'file', parts: ['src/app/routes/auth.ts'],
        });
    });

    it('parses an api-list with a cluster: prefix', () => {
        expect(parseGraphId('api-list:cluster:auth')).toEqual({
            type: 'api-list', parts: ['cluster:auth'],
        });
    });
});

describe('parseGraphId — two-part types', () => {
    it('parses a flow id (file + function)', () => {
        expect(parseGraphId('flow:src/a.ts:doThing')).toEqual({
            type: 'flow', parts: ['src/a.ts', 'doThing'],
        });
    });

    it('parses a sequence id whose second part contains inner colons', () => {
        expect(parseGraphId('sequence:src/auth.controller.ts:anonymous@GET:/users'))
            .toEqual({
                type: 'sequence',
                parts: ['src/auth.controller.ts', 'anonymous@GET:/users'],
            });
    });

    it('parses a sequence id with a deeply nested route key', () => {
        expect(parseGraphId('sequence:src/x.ts:anonymous@POST:/api/users/login'))
            .toEqual({
                type: 'sequence',
                parts: ['src/x.ts', 'anonymous@POST:/api/users/login'],
            });
    });
});

describe('parseGraphId — edge cases', () => {
    it('returns null for empty input', () => {
        expect(parseGraphId('')).toBeNull();
        expect(parseGraphId(null as any)).toBeNull();
    });

    it('returns null when the type is empty (leading colon)', () => {
        expect(parseGraphId(':foo')).toBeNull();
    });

    it('parses an unknown type as a single-part shape (forward-compat)', () => {
        expect(parseGraphId('newtype:something:else')).toEqual({
            type: 'newtype', parts: ['something:else'],
        });
    });

    it('parses a bare type with no colon', () => {
        expect(parseGraphId('health')).toEqual({ type: 'health', parts: [] });
    });
});

describe('round-trip (makeGraphId → parseGraphId → makeGraphId)', () => {
    const fixtures: Array<[string, string[]]> = [
        ['feature', ['workspace']],
        ['feature', ['service:main']],
        ['file', ['src/app/routes/auth.ts']],
        ['flow', ['src/a.ts', 'doThing']],
        ['sequence', ['src/auth.controller.ts', 'anonymous@GET:/users']],
        ['api-list', ['cluster:auth']],
        ['microservice', ['workspace']],
        ['domain', ['workspace']],
        ['health', ['report']],
        ['tour', ['workspace']],
    ];
    for (const [type, parts] of fixtures) {
        it(`round-trips ${type} ${JSON.stringify(parts)}`, () => {
            const id = makeGraphId(type, parts);
            const parsed = parseGraphId(id);
            expect(parsed?.type).toBe(type);
            expect(parsed?.parts).toEqual(parts);
            expect(makeGraphId(parsed!.type, parsed!.parts)).toBe(id);
        });
    }
});

describe('isGraphIdOfType', () => {
    it('matches the prefix correctly', () => {
        expect(isGraphIdOfType('feature:workspace', 'feature')).toBe(true);
        expect(isGraphIdOfType('feature:service:main', 'feature')).toBe(true);
        expect(isGraphIdOfType('sequence:src/a.ts:GET:/x', 'feature')).toBe(false);
    });

    it('does NOT confuse `api-list` with `api`', () => {
        // Old `startsWith('api:')` patterns would false-match this.
        expect(isGraphIdOfType('api-list:cluster:auth', 'api')).toBe(false);
        expect(isGraphIdOfType('api-list:cluster:auth', 'api-list')).toBe(true);
    });
});

describe('graphIdPart', () => {
    it('returns the requested part', () => {
        expect(graphIdPart('feature:service:main', 0)).toBe('service:main');
        expect(graphIdPart('flow:src/a.ts:doThing', 0)).toBe('src/a.ts');
        expect(graphIdPart('flow:src/a.ts:doThing', 1)).toBe('doThing');
        expect(graphIdPart('sequence:src/x.ts:anonymous@GET:/users', 1)).toBe('anonymous@GET:/users');
    });

    it('returns undefined for out-of-range index', () => {
        expect(graphIdPart('feature:workspace', 5)).toBeUndefined();
        expect(graphIdPart('', 0)).toBeUndefined();
    });

    it('BUG-POLAR-7: screen-content keeps the colon-bearing screenId whole', () => {
        const p = parseGraphId('screen-content:screen:app:/home');
        expect(p?.type).toBe('screen-content');
        expect(p?.parts.join(':')).toBe('screen:app:/home');
    });
});
