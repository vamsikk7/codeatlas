/**
 * astCache.test.ts — Issue 364 / ADR-022
 *
 * Pins the save-time parse-cache invariant: same (path, content) → cached
 * AST returned, no re-parse.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseJSCached, clearAstCache, getAstCacheStats } from '../astCache';
import * as jsParser from '../jsParser';

describe('astCache (Issue 364)', () => {
    beforeEach(() => {
        clearAstCache();
        vi.restoreAllMocks();
    });

    it('returns the same AST for identical (path, content)', () => {
        const code = 'const x = 1;';
        const a = parseJSCached(code, 'foo.ts');
        const b = parseJSCached(code, 'foo.ts');
        expect(a).toBe(b);
    });

    it('parses afresh when content changes', () => {
        const a = parseJSCached('const x = 1;', 'foo.ts');
        const b = parseJSCached('const x = 2;', 'foo.ts');
        expect(a).not.toBe(b);
    });

    it('parses afresh when path changes (same content, different file)', () => {
        const code = 'const x = 1;';
        const a = parseJSCached(code, 'foo.ts');
        const b = parseJSCached(code, 'bar.ts');
        expect(a).not.toBe(b);
    });

    it('does not call parseJSAuto on cache hit', () => {
        const spy = vi.spyOn(jsParser, 'parseJSAuto');
        const code = 'const x = 1;';
        parseJSCached(code, 'foo.ts');
        parseJSCached(code, 'foo.ts');
        parseJSCached(code, 'foo.ts');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('respects precomputed hash to skip rehashing', () => {
        const spy = vi.spyOn(jsParser, 'parseJSAuto');
        parseJSCached('const x = 1;', 'foo.ts', 'abc');
        parseJSCached('const x = 1;', 'foo.ts', 'abc');
        // Same precomputed hash → cache hit even though we didn't compute one.
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('evicts oldest entries past the cache limit', () => {
        // Fill the cache past CACHE_LIMIT (32) and confirm the size is bounded.
        for (let i = 0; i < 50; i++) {
            parseJSCached(`const x = ${i};`, `foo${i}.ts`);
        }
        const stats = getAstCacheStats();
        expect(stats.size).toBeLessThanOrEqual(stats.limit);
    });
});
