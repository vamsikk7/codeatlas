import { describe, it, expect } from 'vitest';
import { collectRepoLegend, repoAccentColor } from '../repoLegend';

describe('repoLegend (BUG-POLAR-15 — L1 per-repo colour key)', () => {
    it('collects distinct repos in first-seen order with stable colours', () => {
        const nodes = [
            { data: { meta: { repoId: 'clients', repoName: 'clients' } } },
            { data: { meta: { repoId: 'server', repoName: 'server' } } },
            { data: { meta: { repoId: 'clients', repoName: 'clients' } } }, // dup
            { data: { meta: { repoId: 'docs', repoName: 'docs' } } },
        ];
        const legend = collectRepoLegend(nodes);
        expect(legend.map((e) => e.repoId)).toEqual(['clients', 'server', 'docs']);
        expect(legend[0].color).toBe(repoAccentColor('clients'));
        expect(legend[0].label).toBe('clients');
    });

    it('returns [] for a single-repo graph (nothing to disambiguate)', () => {
        const nodes = [
            { data: { meta: { repoId: 'main', repoName: 'main' } } },
            { data: { meta: { repoId: 'main', repoName: 'main' } } },
        ];
        expect(collectRepoLegend(nodes)).toEqual([]);
    });

    it('skips infra nodes and nodes without a repoId', () => {
        const nodes = [
            { data: { meta: { repoId: 'a', repoName: 'a' } } },
            { data: { meta: { repoId: 'b', repoName: 'b' } } },
            { data: { meta: { infra: true, repoId: 'c' } } }, // infra → skipped
            { data: { meta: {} } },                            // no repoId → skipped
        ];
        expect(collectRepoLegend(nodes).map((e) => e.repoId)).toEqual(['a', 'b']);
    });

    it('falls back to repoId when repoName is absent', () => {
        const nodes = [
            { meta: { repoId: 'aaa' } },
            { meta: { repoId: 'bbb' } },
        ];
        const legend = collectRepoLegend(nodes);
        expect(legend[0].label).toBe('aaa');
    });
});
