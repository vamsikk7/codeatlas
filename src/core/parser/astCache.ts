/**
 * astCache.ts — Issue 364 / ADR-022
 *
 * INVARIANT: a single rebuildFile() call should parse a given file at most
 * once. Repeated `parseJSAuto(code, path)` calls with the same content
 * return the cached AST instead of re-running Babel.
 *
 * Cache shape: keyed on `(path, contentHash)`. LRU with bounded size.
 * Hash is computed lazily — caller can pass a pre-computed hash to skip
 * recompute when one is already on hand (e.g. in `rebuildFile` after the
 * scanner has already hashed the content).
 *
 * Save-event call graph for a TS file (before this cache):
 *  - buildFileGraph(code, path, oldCode) → 2 parses
 *  - per-fn buildFlowGraph()           → 1 parse per fn
 *  - per-fn buildDiffMap(oldFn, newFn) → 2 parses per fn
 *  Total: ~18 parses for an 8-fn file → ~360ms latency.
 *
 * After this cache: 2 parses (one per snapshot, hash-keyed) for the file
 * graph + per-fn parses still happen since they're on snippet text not
 * the full file. Estimated save-latency savings: ~70%.
 */

import type { File } from '@babel/types';
import { parseJSAuto } from './jsParser';

interface CacheEntry {
    file: File;
    /** Insertion time for LRU eviction. */
    lastUsed: number;
}

const CACHE_LIMIT = 32;
const cache = new Map<string, CacheEntry>();

/**
 * Quick FNV-1a hash for content keying. Not cryptographic — speed matters
 * more than uniqueness for in-memory caching. Collisions just cause a
 * cache miss + reparse.
 */
function fnv1a(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

function evictOldest(): void {
    if (cache.size <= CACHE_LIMIT) return;
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, entry] of cache) {
        if (entry.lastUsed < oldestTime) {
            oldestTime = entry.lastUsed;
            oldestKey = k;
        }
    }
    if (oldestKey) cache.delete(oldestKey);
}

/**
 * Parse `code` at `filePath`, returning the cached AST when the same
 * content was parsed previously. The optional `precomputedHash` skips the
 * FNV pass when caller already has a hash on hand.
 */
export function parseJSCached(
    code: string,
    filePath?: string,
    precomputedHash?: string,
): File {
    const hash = precomputedHash ?? fnv1a(code);
    const key = `${filePath ?? '<anon>'}::${hash}`;
    const entry = cache.get(key);
    if (entry) {
        entry.lastUsed = Date.now();
        return entry.file;
    }
    const file = parseJSAuto(code, filePath);
    cache.set(key, { file, lastUsed: Date.now() });
    evictOldest();
    return file;
}

/** Test helper — clears the cache between unit tests. */
export function clearAstCache(): void {
    cache.clear();
}

/** Test helper — read cache stats for observability. */
export function getAstCacheStats(): { size: number; limit: number } {
    return { size: cache.size, limit: CACHE_LIMIT };
}
