/**
 * #843 — fallback candidate derivation for missing sequence graphs.
 */
import { describe, it, expect } from 'vitest';
import { deriveSequenceFallbackIds } from '../sequenceFallbackIds';

describe('deriveSequenceFallbackIds (#843)', () => {
    it('simple filePath:handler splits into flow then file candidates', () => {
        const c = deriveSequenceFallbackIds('todos/create.ts:create');
        expect(c[0]).toEqual({ gid: 'flow:todos/create.ts:create', mode: 'flow', label: 'Flow: create' });
        expect(c.some(x => x.gid === 'file:todos/create.ts' && x.mode === 'file')).toBe(true);
        // flows come before files
        expect(c.findIndex(x => x.mode === 'file')).toBeGreaterThan(c.findIndex(x => x.mode === 'flow'));
    });

    it('handler names containing ":" produce a candidate at the correct split', () => {
        const c = deriveSequenceFallbackIds('src/main.ts:anonymous@GET:/');
        expect(c.some(x => x.gid === 'flow:src/main.ts:anonymous@GET:/')).toBe(true);
        expect(c.some(x => x.gid === 'file:src/main.ts')).toBe(true);
    });

    it('repo-prefixed .cs paths derive the file candidate', () => {
        const c = deriveSequenceFallbackIds('aws-dotnet-rest-api/src/Functions/CreateItemFunction.cs:create');
        expect(c.some(x => x.gid === 'file:aws-dotnet-rest-api/src/Functions/CreateItemFunction.cs')).toBe(true);
    });

    it('split points whose path segment has no extension are skipped', () => {
        const c = deriveSequenceFallbackIds('noext:handler');
        expect(c).toEqual([]);
    });

    it('deduplicates file candidates across multiple split points', () => {
        const c = deriveSequenceFallbackIds('a/b.ts:x:y');
        const fileCands = c.filter(x => x.gid === 'file:a/b.ts');
        expect(fileCands).toHaveLength(1);
    });
});
