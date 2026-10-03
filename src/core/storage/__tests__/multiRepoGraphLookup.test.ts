/**
 * multiRepoGraphLookup.test.ts — UX-28 follow-up (2026-06-05).
 */

import { describe, it, expect, vi } from 'vitest';
import { isMultiRepoWorkspace, findGraphInRepos } from '../multiRepoGraphLookup';
import type { IAggregatorStore, IRepoStore } from '../storeInterfaces';

function makeAggregator(repos: Array<Partial<{ rootPath: string; name: string; repoId: string }>>): IAggregatorStore {
    return {
        listRepos: () => repos as any,
    } as IAggregatorStore;
}

function makeRepoStore(graphs: Record<string, any>): IRepoStore {
    return {
        getWorking: () => ({ graphs, files: {}, apiIndex: {}, clusters: {}, services: {} }),
    } as unknown as IRepoStore;
}

describe('isMultiRepoWorkspace', () => {
    it('returns false on undefined aggregator', async () => {
        expect(isMultiRepoWorkspace(undefined)).toBe(false);
        expect(isMultiRepoWorkspace(null)).toBe(false);
    });
    it('returns false when fewer than 2 repos', async () => {
        expect(isMultiRepoWorkspace(makeAggregator([]))).toBe(false);
        expect(isMultiRepoWorkspace(makeAggregator([{ rootPath: 'a', name: 'a' }]))).toBe(false);
    });
    it('returns false when no repo has rootPath (synthetic workspace row)', async () => {
        expect(isMultiRepoWorkspace(makeAggregator([{ name: 'workspace' }, { name: 'other' }]))).toBe(false);
    });
    it('returns true with 2+ repos that have rootPath', async () => {
        expect(isMultiRepoWorkspace(makeAggregator([
            { rootPath: 'a', name: 'a' },
            { rootPath: 'b', name: 'b' },
        ]))).toBe(true);
    });
    it('swallows listRepos errors', async () => {
        const broken = { listRepos: () => { throw new Error('boom'); } } as any;
        expect(isMultiRepoWorkspace(broken)).toBe(false);
    });
});

describe('findGraphInRepos', () => {
    const aggregator = makeAggregator([
        { rootPath: 'svc-alpha', name: 'svc-alpha', repoId: 'a' },
        { rootPath: 'svc-beta', name: 'svc-beta', repoId: 'b' },
        { rootPath: 'svc-gamma', name: 'svc-gamma', repoId: 'c' },
    ]);

    it('returns null when graphId not found in any repo', async () => {
        const getRepoStore = (_p: string) => makeRepoStore({});
        const r = await findGraphInRepos('api-list:cluster:missing', aggregator, getRepoStore, '/ws');
        expect(r).toBeNull();
    });

    it('returns the first matching graph with nodes > 0', async () => {
        const calls: string[] = [];
        const getRepoStore = vi.fn((absPath: string) => {
            calls.push(absPath);
            if (absPath.endsWith('svc-beta')) {
                return makeRepoStore({
                    'sequence:src/server.js:foo': {
                        graphId: 'sequence:src/server.js:foo',
                        nodes: [{ id: 'n1' }, { id: 'n2' }],
                    },
                });
            }
            return makeRepoStore({});
        });
        const r = await findGraphInRepos('sequence:src/server.js:foo', aggregator, getRepoStore, '/ws');
        expect(r).not.toBeNull();
        expect(r?.graph.graphId).toBe('sequence:src/server.js:foo');
        expect(r?.repoName).toBe('svc-beta');
        // alpha probed first, then beta — gamma should not be probed (early exit).
        expect(calls).toEqual(['/ws/svc-alpha', '/ws/svc-beta']);
    });

    it('skips graphs with zero nodes and zero meta.apis (defensive against empty placeholders)', async () => {
        const getRepoStore = (absPath: string) => {
            if (absPath.endsWith('svc-alpha')) {
                return makeRepoStore({ 'file:foo': { graphId: 'file:foo', nodes: [] } });
            }
            if (absPath.endsWith('svc-beta')) {
                return makeRepoStore({ 'file:foo': { graphId: 'file:foo', nodes: [{ id: 'n' }] } });
            }
            return makeRepoStore({});
        };
        const r = await findGraphInRepos('file:foo', aggregator, getRepoStore, '/ws');
        expect(r?.repoName).toBe('svc-beta');
    });

    it('accepts api-list shape (meta.apis instead of nodes)', async () => {
        const getRepoStore = (absPath: string) => {
            if (absPath.endsWith('svc-alpha')) {
                return makeRepoStore({
                    'api-list:cluster:svc-alpha': {
                        graphId: 'api-list:cluster:svc-alpha',
                        nodes: [],
                        meta: { apis: [{ method: 'GET', route: '/health' }] },
                    },
                });
            }
            return makeRepoStore({});
        };
        const r = await findGraphInRepos('api-list:cluster:svc-alpha', aggregator, getRepoStore, '/ws');
        expect(r?.repoName).toBe('svc-alpha');
    });

    it('returns null on a single-repo workspace (synthetic row only)', async () => {
        const single = makeAggregator([{ name: 'workspace' }]);
        const getRepoStore = (_p: string) => makeRepoStore({ 'flow:x': { nodes: [{ id: 'n' }] } });
        expect(await findGraphInRepos('flow:x', single, getRepoStore, '/ws')).toBeNull();
    });

    it('null on missing graphId or aggregator', async () => {
        expect(await findGraphInRepos('', aggregator, () => undefined, '/ws')).toBeNull();
        expect(await findGraphInRepos('x', null, () => undefined, '/ws')).toBeNull();
        expect(await findGraphInRepos('x', undefined, () => undefined, '/ws')).toBeNull();
    });

    it('swallows per-repo errors and continues scanning', async () => {
        const getRepoStore = (absPath: string) => {
            if (absPath.endsWith('svc-alpha')) {
                throw new Error('store closed');
            }
            if (absPath.endsWith('svc-beta')) {
                return makeRepoStore({ 'flow:f': { graphId: 'flow:f', nodes: [{ id: 'n' }] } });
            }
            return makeRepoStore({});
        };
        const r = await findGraphInRepos('flow:f', aggregator, getRepoStore, '/ws');
        expect(r?.repoName).toBe('svc-beta');
    });

    it('logs the resolving repo when log is provided', async () => {
        const log = vi.fn();
        const getRepoStore = (absPath: string) => absPath.endsWith('svc-alpha')
            ? makeRepoStore({ 'file:a': { graphId: 'file:a', nodes: [{ id: 'n' }] } })
            : makeRepoStore({});
        await findGraphInRepos('file:a', aggregator, getRepoStore, '/ws', log);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('svc-alpha'));
    });
});
