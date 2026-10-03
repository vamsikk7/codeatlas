/**
 * UX-67 prep (2026-06-09) — `resolveRepoFromArg` is the canonical
 * helper that maps a user-supplied `repoId` argument (name, hex repoId,
 * or rootPath) to the matching repo row + its `gitRoot` (absolute path).
 *
 * 17 dispatch handlers in `extension.ts`, `handlers/replayHandlers.ts`,
 * `handlers/navigationHandlers.ts`, etc. were hand-rolling this lookup
 * with subtle drift (slightly different fallback semantics, sloppy
 * `path.join` when rootPath was missing, no logging hook).  This
 * extraction gives us a pure function we can unit-test in isolation and
 * call from every handler that resolves a per-repo gitRoot or store.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveRepoFromArg, type RepoLike } from '../resolveRepoFromArg';

const WORKSPACE_ROOT = '/home/dev/work/test-workspace';
const REPOS: RepoLike[] = [
    { repoId: 'aaa111', name: 'service-a', rootPath: 'service-a' },
    { repoId: 'bbb222', name: 'service-b', rootPath: 'services/service-b' },
    { repoId: 'ccc333', name: 'orphan', rootPath: '' },
];

describe('resolveRepoFromArg', () => {
    describe('match modes', () => {
        it('resolves by repoId (hex)', () => {
            const r = resolveRepoFromArg('aaa111', WORKSPACE_ROOT, REPOS);
            expect(r).toEqual({
                repoId: 'aaa111',
                name: 'service-a',
                rootPath: 'service-a',
                gitRoot: path.join(WORKSPACE_ROOT, 'service-a'),
                scopedRepo: 'service-a',
            });
        });

        it('resolves by name', () => {
            const r = resolveRepoFromArg('service-b', WORKSPACE_ROOT, REPOS);
            expect(r?.repoId).toBe('bbb222');
            expect(r?.gitRoot).toBe(path.join(WORKSPACE_ROOT, 'services/service-b'));
        });

        it('resolves by rootPath', () => {
            const r = resolveRepoFromArg('services/service-b', WORKSPACE_ROOT, REPOS);
            expect(r?.name).toBe('service-b');
        });
    });

    describe('edge cases', () => {
        it('returns null for an unknown id', () => {
            expect(resolveRepoFromArg('does-not-exist', WORKSPACE_ROOT, REPOS)).toBeNull();
        });

        it('returns null for an empty/undefined arg', () => {
            expect(resolveRepoFromArg(undefined, WORKSPACE_ROOT, REPOS)).toBeNull();
            expect(resolveRepoFromArg('', WORKSPACE_ROOT, REPOS)).toBeNull();
            expect(resolveRepoFromArg(null as any, WORKSPACE_ROOT, REPOS)).toBeNull();
        });

        it('strips `service:` prefix before matching', () => {
            const r = resolveRepoFromArg('service:service-a', WORKSPACE_ROOT, REPOS);
            expect(r?.repoId).toBe('aaa111');
        });

        it('returns null when matched repo has no rootPath', () => {
            // A row with empty rootPath isn't a per-repo source we can scope to.
            const r = resolveRepoFromArg('orphan', WORKSPACE_ROOT, REPOS);
            expect(r).toBeNull();
        });

        it('prefers exact match (name) over partial', () => {
            const repos: RepoLike[] = [
                { repoId: 'x', name: 'foo', rootPath: 'foo' },
                { repoId: 'y', name: 'foobar', rootPath: 'foobar' },
            ];
            const r = resolveRepoFromArg('foo', WORKSPACE_ROOT, repos);
            expect(r?.repoId).toBe('x');
        });
    });

    describe('scopedRepo derivation', () => {
        it('scopedRepo prefers name, then rootPath, then repoId', () => {
            expect(resolveRepoFromArg('aaa111', WORKSPACE_ROOT, REPOS)?.scopedRepo).toBe('service-a');
            // Name-less row
            const namelessRepos: RepoLike[] = [{ repoId: 'z', name: undefined, rootPath: 'svc-z' }];
            expect(resolveRepoFromArg('z', WORKSPACE_ROOT, namelessRepos)?.scopedRepo).toBe('svc-z');
        });
    });

    describe('aggregator-shaped accessor', () => {
        it('accepts an aggregator with a listRepos() method', () => {
            const aggregator = { listRepos: () => REPOS };
            const r = resolveRepoFromArg('service-a', WORKSPACE_ROOT, aggregator);
            expect(r?.repoId).toBe('aaa111');
        });

        it('returns null when accessor throws', () => {
            const aggregator = { listRepos: () => { throw new Error('disk i/o'); } };
            const r = resolveRepoFromArg('service-a', WORKSPACE_ROOT, aggregator);
            expect(r).toBeNull();
        });

        it('returns null when accessor returns null', () => {
            const aggregator = { listRepos: () => null as any };
            expect(resolveRepoFromArg('service-a', WORKSPACE_ROOT, aggregator)).toBeNull();
        });
    });
});
