/**
 * clusterNameMerge.test.ts — #844 (2026-06-11)
 *
 * A naming-enrichment pass may NEVER change cluster membership or
 * cardinality — it only carries names. The pre-fix callbacks wholesale-
 * replaced working AND baseline cluster maps with whatever (possibly
 * stale, possibly partial) map the async pass was scheduled over,
 * truncating the baseline to 1 cluster on the user's machine.
 */
import { describe, it, expect } from 'vitest';
import { mergeEnrichedClusterNames } from '../clusterNameMerge';

function cluster(id: string, name: string, files: string[] = ['a.ts']): any {
    return { id, name, files, serviceId: 'service:main', apisInCluster: [] };
}

describe('mergeEnrichedClusterNames (#844)', () => {
    const six = Object.fromEntries(
        ['article', 'auth', 'profile', 'random', 'src', 'tag'].map(n => [`cluster:${n}`, cluster(`cluster:${n}`, n)]),
    );

    it('THE repro: a stale 1-cluster enriched map cannot truncate a 6-cluster baseline', () => {
        const enriched = { 'cluster:auth': cluster('cluster:auth', 'User Authentication') };
        const out = mergeEnrichedClusterNames(six, enriched);
        expect(Object.keys(out)).toHaveLength(6);
        expect(out['cluster:auth'].name).toBe('User Authentication');
        expect(out['cluster:article'].name).toBe('article');
    });

    it('applies names for every matching id, preserving membership fields', () => {
        const enriched = {
            'cluster:auth': cluster('cluster:auth', 'User Authentication', ['DIFFERENT.ts']),
            'cluster:tag': cluster('cluster:tag', 'Tag Management'),
        };
        const out = mergeEnrichedClusterNames(six, enriched);
        expect(out['cluster:auth'].name).toBe('User Authentication');
        expect(out['cluster:auth'].files).toEqual(['a.ts']); // membership NOT taken from the enrichment
        expect(out['cluster:tag'].name).toBe('Tag Management');
    });

    it('never ADDS clusters that no longer exist in the current map', () => {
        const enriched = { 'cluster:ghost': cluster('cluster:ghost', 'Ghost') };
        const out = mergeEnrichedClusterNames(six, enriched);
        expect(out['cluster:ghost']).toBeUndefined();
        expect(Object.keys(out)).toHaveLength(6);
    });

    it('returns the SAME reference when nothing changes (no save churn)', () => {
        const enriched = { 'cluster:auth': cluster('cluster:auth', 'auth') };
        expect(mergeEnrichedClusterNames(six, enriched)).toBe(six);
    });

    it('tolerates empty/undefined inputs', () => {
        expect(mergeEnrichedClusterNames({}, { x: cluster('x', 'X') })).toEqual({});
        expect(mergeEnrichedClusterNames(six, {})).toBe(six);
    });
});
