import { describe, it, expect } from 'vitest';
import { filterReviewFindings, dedupeFindings, finalizeFindingsInStore, changedFilesFromStoreHashes } from '../reviewFilters';
import type { AiReviewFinding, AiReviewSeverity } from '../../graph/graphTypes';

let n = 0;
function mk(file: string, opts: { severity?: AiReviewSeverity; title?: string; symbol?: string; lineStart?: number; lineEnd?: number } = {}): AiReviewFinding {
    return {
        id: `f${++n}`,
        entryPointId: `project::${file}`,
        bindings: [],
        severity: opts.severity ?? 'warning',
        category: 'logic-bug',
        title: opts.title ?? 'a finding',
        body: 'body',
        anchor: { filePath: file, symbol: opts.symbol, lineStart: opts.lineStart, lineEnd: opts.lineEnd },
        status: 'open',
        model: 'test',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
    } as AiReviewFinding;
}

describe('#953 dedupeFindings (near-duplicate merge)', () => {
    it('merges same file + same symbol (different wording)', () => {
        const { kept, dropped } = dedupeFindings([
            mk('src/x.ts', { title: 'Null deref', symbol: 'getUser' }),
            mk('src/x.ts', { title: 'possible nil', symbol: 'getUser' }),
        ]);
        expect(kept).toHaveLength(1);
        expect(dropped).toHaveLength(1);
    });
    it('merges same file + same normalized title (case/space-insensitive)', () => {
        expect(dedupeFindings([
            mk('src/x.ts', { title: 'Off by one error' }),
            mk('src/x.ts', { title: 'off  by   one ERROR' }),
        ]).kept).toHaveLength(1);
    });
    it('merges same file + identical line span', () => {
        expect(dedupeFindings([
            mk('src/x.ts', { title: 'A', lineStart: 10, lineEnd: 12 }),
            mk('src/x.ts', { title: 'B', lineStart: 10, lineEnd: 12 }),
        ]).kept).toHaveLength(1);
    });
    it('keeps findings in DIFFERENT files even if same symbol/title (sibling-impl is LLM dedup)', () => {
        expect(dedupeFindings([
            mk('src/x.ts', { title: 'same', symbol: 's' }),
            mk('src/y.ts', { title: 'same', symbol: 's' }),
        ]).kept).toHaveLength(2);
    });
    it('keeps distinct defects in the same file (diff symbol+title+span)', () => {
        expect(dedupeFindings([
            mk('src/x.ts', { title: 'bug one', symbol: 'f1', lineStart: 5, lineEnd: 5 }),
            mk('src/x.ts', { title: 'bug two', symbol: 'f2', lineStart: 50, lineEnd: 51 }),
        ]).kept).toHaveLength(2);
    });
});

describe('#948–#953 filterReviewFindings', () => {
    const changed = new Set(['src/changed.ts', 'src/__tests__/changed.test.ts']);

    it('#949 drops a finding anchored to a file NOT in the PR diff (context code)', () => {
        const { kept, dropped } = filterReviewFindings([mk('src/context-caller.ts')], changed);
        expect(kept).toHaveLength(0);
        expect(dropped).toHaveLength(1);
        expect(dropped[0].reason).toBe('off-diff');
    });

    it('#949 keeps a finding anchored to a changed file', () => {
        const { kept, dropped } = filterReviewFindings([mk('src/changed.ts')], changed);
        expect(kept).toHaveLength(1);
        expect(dropped).toHaveLength(0);
    });

    it('#949 matches a changed file even with a leading ./ path drift', () => {
        const { kept } = filterReviewFindings([mk('./src/changed.ts')], changed);
        expect(kept).toHaveLength(1);
    });

    it('#949 is a NO-OP when no changed-file set is available', () => {
        const { kept, dropped } = filterReviewFindings([mk('src/anything.ts')], new Set<string>());
        expect(kept).toHaveLength(1);
        expect(dropped).toHaveLength(0);
    });

    it('#951 drops an info-severity nit on a test file', () => {
        const { kept, dropped } = filterReviewFindings([mk('src/__tests__/changed.test.ts', { severity: 'info' })], changed);
        expect(kept).toHaveLength(0);
        expect(dropped[0].reason).toBe('test-nit');
    });

    it('#951 KEEPS a real (error-severity) bug on a test file', () => {
        const { kept } = filterReviewFindings([mk('src/__tests__/changed.test.ts', { severity: 'error' })], changed);
        expect(kept).toHaveLength(1);
    });

    it('#953 drops an exact-duplicate finding (same file+symbol+title)', () => {
        const a = mk('src/changed.ts', { title: 'Null deref on user', symbol: 'getUser' });
        const b = mk('src/changed.ts', { title: 'null deref on USER', symbol: 'getUser' }); // case/space-insensitive
        const { kept, dropped } = filterReviewFindings([a, b], changed);
        expect(kept).toHaveLength(1);
        expect(dropped[0].reason).toBe('duplicate');
    });

    it('respects opt toggles (all filters off → everything kept)', () => {
        const findings = [mk('src/context.ts'), mk('src/__tests__/changed.test.ts', { severity: 'info' })];
        const { kept } = filterReviewFindings(findings, changed, { dropOffDiff: false, demoteTestNits: false, dedupe: false });
        expect(kept).toHaveLength(2);
    });
});

describe('#948–#953 finalizeFindingsInStore (extension/PR-watcher parity)', () => {
    function makeStore(findings: AiReviewFinding[]) {
        const list = findings.map((f) => ({ ...f }));
        return {
            list,
            listAiReviewFindings: ({ status }: { status?: string } = {}) =>
                list.filter((f) => !status || f.status === status) as AiReviewFinding[],
            updateAiReviewFindingStatus: (id: string, status: 'ignored') => {
                const f = list.find((x) => x.id === id);
                if (f) f.status = status;
                return f;
            },
        };
    }

    it('ignores off-diff + duplicate findings, keeps in-diff distinct ones', () => {
        const f1 = mk('src/a.ts', { title: 'real bug', symbol: 's1' });
        const f2 = mk('src/a.ts', { title: 'real bug', symbol: 's1' }); // dup of f1
        const f3 = mk('src/context.ts', { title: 'off diff' });          // off-diff
        const f4 = mk('src/a.ts', { title: 'another bug', symbol: 's2' }); // distinct → kept
        const store = makeStore([f1, f2, f3, f4]);
        const res = finalizeFindingsInStore(store as any, new Set(['src/a.ts']));
        expect(res.ignored).toBe(2);
        expect(res.byReason['off-diff']).toBe(1);
        expect(res.byReason.duplicate).toBe(1);
        const open = store.listAiReviewFindings({ status: 'open' }).map((f) => f.id).sort();
        expect(open).toEqual([f1.id, f4.id].sort());
    });

    it('empty changed-set (scope=all) is an off-diff no-op but still dedups', () => {
        const f1 = mk('src/a.ts', { title: 'dup', symbol: 'z' });
        const f2 = mk('src/a.ts', { title: 'dup', symbol: 'z' });
        const f3 = mk('src/b.ts', { title: 'unique' });
        const store = makeStore([f1, f2, f3]);
        const res = finalizeFindingsInStore(store as any, new Set<string>());
        expect(res.byReason['off-diff']).toBe(0);
        expect(res.byReason.duplicate).toBe(1);
        expect(store.listAiReviewFindings({ status: 'open' })).toHaveLength(2);
    });
});

describe('#949 changedFilesFromStoreHashes', () => {
    it('returns working files whose hash differs from baseline + brand-new files', () => {
        const store = {
            getWorking: () => ({ files: { 'a.ts': { hash: 'w1' }, 'b.ts': { hash: 'same' }, 'c.ts': { hash: 'new' } } }),
            getBaseline: () => ({ files: { 'a.ts': { hash: 'b1' }, 'b.ts': { hash: 'same' } } }),
        };
        expect([...changedFilesFromStoreHashes(store as any)].sort()).toEqual(['a.ts', 'c.ts']);
    });
    it('handles a missing baseline gracefully (all working files are changed)', () => {
        const store = { getWorking: () => ({ files: { 'a.ts': { hash: 'x' } } }) };
        expect([...changedFilesFromStoreHashes(store as any)]).toEqual(['a.ts']);
    });
});
