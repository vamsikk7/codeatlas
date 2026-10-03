/**
 * ADR-034 Phase G (#792 — Phase G: AI Code Review per repo + workspace guidelines (ADR-034)) — effectiveGuidelines merge tests.
 */
import { describe, it, expect } from 'vitest';
import {
    getEffectiveGuidelines,
    emptyEffectiveGuidelines,
    EMPTY_GUIDELINES_SOURCE,
    type GuidelinesSource,
} from '../effectiveGuidelines';

function src(text: string, when: number = 1700000000000): GuidelinesSource {
    return { text, hash: text ? 'h' : '', updatedAt: when };
}

describe('getEffectiveGuidelines — empty handling', () => {
    it('both empty → empty result, hasWorkspace=false, hasRepo=false', () => {
        const r = getEffectiveGuidelines('r1', undefined, undefined);
        expect(r.text).toBe('');
        expect(r.hash).toBe('');
        expect(r.hasWorkspace).toBe(false);
        expect(r.hasRepo).toBe(false);
    });

    it('both empty sources → same as undefined', () => {
        const r = getEffectiveGuidelines('r1', EMPTY_GUIDELINES_SOURCE, EMPTY_GUIDELINES_SOURCE);
        expect(r.text).toBe('');
        expect(r).toEqual(emptyEffectiveGuidelines());
    });

    it('only workspace → just workspace text, no header', () => {
        const r = getEffectiveGuidelines('r1', src('all POST routes require auth'), undefined);
        expect(r.text).toBe('all POST routes require auth');
        expect(r.hasWorkspace).toBe(true);
        expect(r.hasRepo).toBe(false);
    });

    it('only repo → just repo text, no header', () => {
        const r = getEffectiveGuidelines('r1', undefined, src('this Python repo also requires type hints'));
        expect(r.text).toBe('this Python repo also requires type hints');
        expect(r.hasWorkspace).toBe(false);
        expect(r.hasRepo).toBe(true);
    });
});

describe('getEffectiveGuidelines — merge', () => {
    it('both present → workspace block + repo overrides block with headers', () => {
        const r = getEffectiveGuidelines('repo-a',
            src('all POST routes require auth'),
            src('this Python repo also requires type hints'),
        );
        expect(r.text).toContain('## Workspace rules');
        expect(r.text).toContain('all POST routes require auth');
        expect(r.text).toContain('## repo-a overrides');
        expect(r.text).toContain('this Python repo also requires type hints');
        // Workspace block precedes repo block
        const wsIdx = r.text.indexOf('## Workspace rules');
        const repoIdx = r.text.indexOf('## repo-a overrides');
        expect(wsIdx).toBeLessThan(repoIdx);
    });

    it('duplicate rule across scopes → appears once (repo wins)', () => {
        const r = getEffectiveGuidelines('r1',
            src('All POST routes require auth\nLog all errors'),
            src('all post routes require auth\nNo console.log'),
        );
        // The rule "all post routes require auth" appears EXACTLY once
        const occurrences = (r.text.match(/all post routes require auth/i) ?? []).length;
        expect(occurrences).toBe(1);
        // Both other rules survive
        expect(r.text).toContain('Log all errors');
        expect(r.text).toContain('No console.log');
        // Dedup keeps the REPO line (the lowercase one) — repo wins.
        expect(r.text).toContain('all post routes require auth');
    });

    it('multiple repo lines stay in repo order; workspace lines preserved', () => {
        const r = getEffectiveGuidelines('r1',
            src('W1\nW2\nW3'),
            src('R1\nR2'),
        );
        const w1 = r.text.indexOf('W1');
        const w2 = r.text.indexOf('W2');
        const w3 = r.text.indexOf('W3');
        const r1 = r.text.indexOf('R1');
        const r2 = r.text.indexOf('R2');
        expect(w1).toBeLessThan(w2);
        expect(w2).toBeLessThan(w3);
        expect(r1).toBeLessThan(r2);
        expect(w3).toBeLessThan(r1);
    });

    it('blank lines in input are stripped before merge', () => {
        const r = getEffectiveGuidelines('r1',
            src('rule one\n\n\nrule two\n\n'),
            undefined,
        );
        expect(r.text).toBe('rule one\nrule two');
    });
});

describe('getEffectiveGuidelines — hash + timestamp', () => {
    it('hash is deterministic for the same merged text', () => {
        const a = getEffectiveGuidelines('r1', src('rule'), undefined);
        const b = getEffectiveGuidelines('r1', src('rule'), undefined);
        expect(a.hash).toBe(b.hash);
        expect(a.hash).not.toBe('');
    });

    it('hash changes when repo override changes', () => {
        const a = getEffectiveGuidelines('r1', src('W'), src('R1'));
        const b = getEffectiveGuidelines('r1', src('W'), src('R2'));
        expect(a.hash).not.toBe(b.hash);
    });

    it('updatedAt = max(workspace, repo)', () => {
        const r = getEffectiveGuidelines('r1',
            src('W', 1700000000000),
            src('R', 1800000000000),
        );
        expect(r.updatedAt).toBe(1800000000000);
        const r2 = getEffectiveGuidelines('r1',
            src('W', 1900000000000),
            src('R', 1800000000000),
        );
        expect(r2.updatedAt).toBe(1900000000000);
    });
});
