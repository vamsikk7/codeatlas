/**
 * ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — CrossRepoAnalyzer registry tests.
 *
 * Verifies registration order, replacement, deterministic dispatch,
 * error isolation, and the onRepoRemoved hook.
 */
import { describe, it, expect } from 'vitest';
import { CrossRepoAnalyzerRegistry, type CrossRepoAnalyzer } from '../crossRepoAnalyzer';
import { emptyRepoSummary, type RepoSummary } from '../repoSummary';
import type { IAggregatorStore } from '../../storage/storeInterfaces';

const NOOP_STORE = {} as IAggregatorStore;

function makeAnalyzer(id: string, body?: (calls: string[]) => void): CrossRepoAnalyzer {
    return {
        id,
        onSummaryApplied(repoId, _new, _prior, _store) {
            (this as any).lastRepoId = repoId;
            if (body) body((this as any).calls = (this as any).calls ?? []);
        },
        onRepoRemoved(repoId, _store) {
            (this as any).lastRemoved = repoId;
        },
    } as CrossRepoAnalyzer;
}

describe('CrossRepoAnalyzerRegistry — registration', () => {
    it('register / list preserves insertion order', () => {
        const reg = new CrossRepoAnalyzerRegistry();
        reg.register(makeAnalyzer('first'));
        reg.register(makeAnalyzer('second'));
        reg.register(makeAnalyzer('third'));
        expect(reg.list().map((a) => a.id)).toEqual(['first', 'second', 'third']);
    });

    it('register with existing id replaces in-place (same position)', () => {
        const reg = new CrossRepoAnalyzerRegistry();
        reg.register(makeAnalyzer('a'));
        reg.register(makeAnalyzer('b'));
        reg.register(makeAnalyzer('c'));
        const replacement = makeAnalyzer('b');
        (replacement as any).marker = 'replaced';
        reg.register(replacement);
        const ids = reg.list().map((a) => a.id);
        expect(ids).toEqual(['a', 'b', 'c']);   // order preserved
        const b = reg.list().find((a) => a.id === 'b');
        expect((b as any).marker).toBe('replaced');
    });

    it('unregister removes by id', () => {
        const reg = new CrossRepoAnalyzerRegistry();
        reg.register(makeAnalyzer('a'));
        reg.register(makeAnalyzer('b'));
        reg.unregister('a');
        expect(reg.list().map((a) => a.id)).toEqual(['b']);
    });

    it('unregister non-existent id is a no-op', () => {
        const reg = new CrossRepoAnalyzerRegistry();
        reg.register(makeAnalyzer('a'));
        expect(() => reg.unregister('nope')).not.toThrow();
        expect(reg.list().map((a) => a.id)).toEqual(['a']);
    });
});

describe('CrossRepoAnalyzerRegistry — runAll', () => {
    it('fires every analyzer in registration order', () => {
        const reg = new CrossRepoAnalyzerRegistry();
        const seen: string[] = [];
        reg.register({
            id: 'first',
            onSummaryApplied: (id) => { seen.push(`first:${id}`); },
        });
        reg.register({
            id: 'second',
            onSummaryApplied: (id) => { seen.push(`second:${id}`); },
        });
        const summary = emptyRepoSummary('repo-a');
        const ok = reg.runAll('repo-a', summary, undefined, NOOP_STORE);
        expect(seen).toEqual(['first:repo-a', 'second:repo-a']);
        expect(ok).toBe(2);
    });

    it('one analyzer throwing does not abort the chain', () => {
        const reg = new CrossRepoAnalyzerRegistry();
        const seen: string[] = [];
        reg.register({ id: 'thrower', onSummaryApplied: () => { throw new Error('boom'); } });
        reg.register({ id: 'good', onSummaryApplied: () => { seen.push('good'); } });
        const ok = reg.runAll('repo-a', emptyRepoSummary('repo-a'), undefined, NOOP_STORE);
        expect(seen).toEqual(['good']);
        expect(ok).toBe(1);   // only 'good' succeeded
    });

    it('logs failures when log callback supplied', () => {
        const reg = new CrossRepoAnalyzerRegistry();
        const logs: string[] = [];
        reg.register({ id: 'thrower', onSummaryApplied: () => { throw new Error('boom!'); } });
        reg.runAll('repo-a', emptyRepoSummary('repo-a'), undefined, NOOP_STORE, (m) => logs.push(m));
        expect(logs.length).toBe(1);
        expect(logs[0]).toMatch(/thrower/);
        expect(logs[0]).toMatch(/boom!/);
    });

    it('passes prior summary correctly', () => {
        const reg = new CrossRepoAnalyzerRegistry();
        let receivedPrior: RepoSummary | undefined;
        reg.register({
            id: 'capture',
            onSummaryApplied: (_id, _new, prior) => { receivedPrior = prior; },
        });
        const prior = emptyRepoSummary('repo-a');
        const current = emptyRepoSummary('repo-a');
        reg.runAll('repo-a', current, prior, NOOP_STORE);
        expect(receivedPrior).toBe(prior);
    });
});

describe('CrossRepoAnalyzerRegistry — runRepoRemoved', () => {
    it('fires onRepoRemoved on every analyzer that defines it', () => {
        const reg = new CrossRepoAnalyzerRegistry();
        const removed: string[] = [];
        reg.register({
            id: 'a',
            onSummaryApplied: () => { /* unused */ },
            onRepoRemoved: (id) => { removed.push(`a:${id}`); },
        });
        reg.register({
            id: 'b',
            onSummaryApplied: () => { /* unused */ },
            // no onRepoRemoved
        });
        reg.register({
            id: 'c',
            onSummaryApplied: () => { /* unused */ },
            onRepoRemoved: (id) => { removed.push(`c:${id}`); },
        });
        reg.runRepoRemoved('repo-x', NOOP_STORE);
        expect(removed).toEqual(['a:repo-x', 'c:repo-x']);
    });

    it('isolates errors in onRepoRemoved', () => {
        const reg = new CrossRepoAnalyzerRegistry();
        const removed: string[] = [];
        reg.register({
            id: 'thrower',
            onSummaryApplied: () => { /* unused */ },
            onRepoRemoved: () => { throw new Error('cleanup blew up'); },
        });
        reg.register({
            id: 'good',
            onSummaryApplied: () => { /* unused */ },
            onRepoRemoved: (id) => { removed.push(id); },
        });
        const logs: string[] = [];
        reg.runRepoRemoved('repo-x', NOOP_STORE, (m) => logs.push(m));
        expect(removed).toEqual(['repo-x']);
        expect(logs.length).toBe(1);
        expect(logs[0]).toMatch(/thrower/);
    });
});
