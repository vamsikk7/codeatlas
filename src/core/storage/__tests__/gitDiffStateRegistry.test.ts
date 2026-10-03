/**
 * UX-64 (2026-06-09) — `GitDiffStateRegistry` is the per-repo, in-memory
 * keyed registry of active `PersistedGitDiffState` sessions. One workspace
 * can hold multiple concurrent sessions, each scoped to a sub-repo.
 *
 * Key conventions:
 *   - `'workspace'` — the legacy single-session slot for single-repo or
 *     workspace-wide diffs. Backward-compat readers that don't pass a
 *     `repoId` see this entry.
 *   - `<repoName>` — per-repo diff session. Each per-repo handler stamps
 *     `state.scopedRepo` matching this key.
 *
 * The "fallback to any non-null" semantic in `get(undefined)` is the
 * transitional shim while reader call sites (navigationHandlers,
 * aiReviewHandlers, etc.) get incrementally rewired to pass repoId.
 * Once Phase 2 lands, the shim can be dropped.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GitDiffStateRegistry } from '../gitDiffStateRegistry';
import type { PersistedGitDiffState } from '../gitDiffStore';

function makeState(overrides: Partial<PersistedGitDiffState> = {}): PersistedGitDiffState {
    return {
        baseHash: 'aaa1111',
        headHash: 'bbb2222',
        baseLabel: 'aaa1111 base',
        headLabel: 'bbb2222 head',
        diffedGraphs: {},
        apiIndex: {},
        ...overrides,
    };
}

describe('GitDiffStateRegistry', () => {
    let reg: GitDiffStateRegistry;

    beforeEach(() => {
        reg = new GitDiffStateRegistry();
    });

    describe('get / set on the workspace key', () => {
        it('returns null when nothing has been set', () => {
            expect(reg.get('workspace')).toBeNull();
            expect(reg.get()).toBeNull();
            expect(reg.get(undefined)).toBeNull();
        });

        it('round-trips a workspace-wide session', () => {
            const state = makeState();
            reg.set('workspace', state);
            expect(reg.get('workspace')).toBe(state);
        });

        it('calling get() (no arg) returns the workspace entry', () => {
            const state = makeState();
            reg.set('workspace', state);
            expect(reg.get()).toBe(state);
            expect(reg.get(undefined)).toBe(state);
        });
    });

    describe('per-repo sessions', () => {
        it('stores independent sessions by repo key', () => {
            const sA = makeState({ baseHash: 'aaaA', scopedRepo: 'service-a' });
            const sB = makeState({ baseHash: 'aaaB', scopedRepo: 'service-b' });
            reg.set('service-a', sA);
            reg.set('service-b', sB);
            expect(reg.get('service-a')).toBe(sA);
            expect(reg.get('service-b')).toBe(sB);
        });

        it('setting per-repo does not affect workspace slot', () => {
            const ws = makeState({ baseHash: 'wWWW' });
            const sa = makeState({ baseHash: 'aaaA', scopedRepo: 'service-a' });
            reg.set('workspace', ws);
            reg.set('service-a', sa);
            expect(reg.get('workspace')).toBe(ws);
            expect(reg.get('service-a')).toBe(sa);
        });

        it('overwriting one repo key does not touch siblings', () => {
            reg.set('service-a', makeState({ baseHash: 'A1', scopedRepo: 'service-a' }));
            reg.set('service-b', makeState({ baseHash: 'B1', scopedRepo: 'service-b' }));
            const a2 = makeState({ baseHash: 'A2', scopedRepo: 'service-a' });
            reg.set('service-a', a2);
            expect(reg.get('service-a')).toBe(a2);
            expect(reg.get('service-b')?.baseHash).toBe('B1');
        });
    });

    describe('clear', () => {
        it('clears a single key', () => {
            reg.set('workspace', makeState());
            reg.set('service-a', makeState({ scopedRepo: 'service-a' }));
            reg.clear('service-a');
            expect(reg.get('service-a')).toBeNull();
            expect(reg.get('workspace')).not.toBeNull();
        });

        it('clearAll removes every session', () => {
            reg.set('workspace', makeState());
            reg.set('service-a', makeState({ scopedRepo: 'service-a' }));
            reg.set('service-b', makeState({ scopedRepo: 'service-b' }));
            reg.clearAll();
            expect(reg.get('workspace')).toBeNull();
            expect(reg.get('service-a')).toBeNull();
            expect(reg.get('service-b')).toBeNull();
            expect(reg.size).toBe(0);
        });

        it('clear() with no arg defaults to "workspace"', () => {
            reg.set('workspace', makeState());
            reg.set('service-a', makeState({ scopedRepo: 'service-a' }));
            reg.clear();
            expect(reg.get('workspace')).toBeNull();
            expect(reg.get('service-a')).not.toBeNull();
        });
    });

    describe('no-arg get() — workspace-only (UX-64 Phase 2 cleanup)', () => {
        // 2026-06-09 — the legacy "fallback to first per-repo entry" shim
        // has been removed. Every reader now threads its own `repoId`, so
        // bare `get()` only consults the workspace slot and returns null
        // when that slot is empty even if per-repo entries exist.
        it('get() with no workspace entry returns null (does NOT fall back to per-repo)', () => {
            const sa = makeState({ baseHash: 'A1', scopedRepo: 'service-a' });
            reg.set('service-a', sa);
            expect(reg.get()).toBeNull();
        });

        it('get() prefers workspace when both present', () => {
            const ws = makeState({ baseHash: 'wWW' });
            const sa = makeState({ baseHash: 'A1', scopedRepo: 'service-a' });
            reg.set('workspace', ws);
            reg.set('service-a', sa);
            expect(reg.get()).toBe(ws);
        });

        it('listActiveScopes returns every keyed scope', () => {
            reg.set('workspace', makeState());
            reg.set('service-a', makeState({ scopedRepo: 'service-a' }));
            reg.set('service-b', makeState({ scopedRepo: 'service-b' }));
            const scopes = reg.listActiveScopes().sort();
            expect(scopes).toEqual(['service-a', 'service-b', 'workspace']);
        });
    });

    describe('size + has', () => {
        it('size reflects entries', () => {
            expect(reg.size).toBe(0);
            reg.set('workspace', makeState());
            expect(reg.size).toBe(1);
            reg.set('service-a', makeState({ scopedRepo: 'service-a' }));
            expect(reg.size).toBe(2);
        });

        it('has returns presence', () => {
            expect(reg.has('workspace')).toBe(false);
            reg.set('workspace', makeState());
            expect(reg.has('workspace')).toBe(true);
        });
    });
});
