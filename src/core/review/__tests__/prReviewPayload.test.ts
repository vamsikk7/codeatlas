/**
 * prReviewPayload.test.ts — #850 (2026-06-11)
 *
 * Pure mapping layer for the PR review commenter: unified-diff →
 * commentable-line map, findings → inline GitHub review comments (RIGHT
 * side, only on lines the PR diff shows) with the remainder folded into a
 * marker-tagged summary body.
 */
import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff, mapFindingsToPrReview, buildPrSummaryBody, renderRegressionHint, PR_REVIEW_MARKER } from '../prReviewPayload';

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 111..222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,8 @@ export const login = () => {
   const a = 1;
   const b = 2;
+  const token = makeToken();
+  log(token);
   return ok;
 }
@@ -40,4 +42,3 @@ export const logout = () => {
   end();
-  cleanup();
   done();
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
`;

function finding(over: any = {}) {
    return {
        id: 'f1', severity: 'error', title: 'Token logged',
        body: 'The session token is written to logs.',
        evidence: { filePath: 'src/auth.ts', lineStart: 13, snippet: 'log(token);' },
        ...over,
    };
}

describe('parseUnifiedDiff (#850)', () => {
    it('maps RIGHT-side commentable lines per file (added + context inside hunks)', () => {
        const m = parseUnifiedDiff(DIFF);
        const auth = m.get('src/auth.ts')!;
        // hunk 1: new lines 10..17 → context 10,11 added 12,13 context 14,15
        expect(auth.has(12)).toBe(true);  // + const token
        expect(auth.has(13)).toBe(true);  // + log(token)
        expect(auth.has(10)).toBe(true);  // context
        expect(auth.has(30)).toBe(false); // outside hunks
        const nw = m.get('src/new.ts')!;
        expect(nw.has(1)).toBe(true);
        expect(nw.has(2)).toBe(true);
    });

    it('tolerates empty/garbage input', () => {
        expect(parseUnifiedDiff('').size).toBe(0);
        expect(parseUnifiedDiff('not a diff').size).toBe(0);
    });
});

describe('mapFindingsToPrReview (#850)', () => {
    const lines = parseUnifiedDiff(DIFF);

    it('findings on commentable lines become inline RIGHT-side comments', () => {
        const out = mapFindingsToPrReview([finding()], lines);
        expect(out.inline).toHaveLength(1);
        expect(out.inline[0]).toMatchObject({ path: 'src/auth.ts', line: 13, side: 'RIGHT' });
        expect(out.inline[0].body).toContain('Token logged');
        expect(out.inline[0].body).toContain('log(token);');
        expect(out.outside).toHaveLength(0);
    });

    it('findings outside the diff hunks fold into the outside list', () => {
        const out = mapFindingsToPrReview([finding({ evidence: { filePath: 'src/auth.ts', lineStart: 99, snippet: 'x' } })], lines);
        expect(out.inline).toHaveLength(0);
        expect(out.outside).toHaveLength(1);
    });

    it('findings without a resolvable file/line fold into outside (never dropped)', () => {
        const out = mapFindingsToPrReview([finding({ evidence: undefined, anchor: undefined })], lines);
        expect(out.outside).toHaveLength(1);
    });

    it('falls back to anchor.filePath + nearest commentable line is NOT guessed — exact line only', () => {
        const out = mapFindingsToPrReview([finding({ evidence: { filePath: 'src/auth.ts', snippet: 'x' }, anchor: { filePath: 'src/auth.ts' } })], lines);
        expect(out.inline).toHaveLength(0); // no line → summary, not a misplaced pin
        expect(out.outside).toHaveLength(1);
    });
});

describe('buildPrSummaryBody (#850)', () => {
    it('carries the upsert marker, severity counts, and outside-diff findings', () => {
        const lines = parseUnifiedDiff(DIFF);
        const outF = finding({ id: 'f2', severity: 'warning', title: 'Dead path', evidence: { filePath: 'src/other.ts', lineStart: 5, snippet: 'dead()' } });
        const { inline, outside } = mapFindingsToPrReview([finding(), outF], lines);
        const body = buildPrSummaryBody({ inline, outside, allFindings: [finding(), outF], meta: { headSha: 'abc1234', entryPointsReviewed: 4 } });
        expect(body).toContain(PR_REVIEW_MARKER);
        expect(body).toMatch(/1 error/i);
        expect(body).toMatch(/1 warning/i);
        expect(body).toContain('Dead path');
        expect(body).toContain('src/other.ts');
        expect(body).toContain('abc1234');
    });

    it('clean run produces an approving summary', () => {
        const body = buildPrSummaryBody({ inline: [], outside: [], allFindings: [], meta: { headSha: 'abc1234', entryPointsReviewed: 3 } });
        expect(body).toContain(PR_REVIEW_MARKER);
        expect(body).toMatch(/no issues found/i);
    });

    it('#916 — a clean verdict is SCOPED to what was reviewed (never a bare "no issues")', () => {
        const body = buildPrSummaryBody({
            inline: [], outside: [], allFindings: [],
            meta: {
                headSha: 'abc1234', entryPointsReviewed: 2,
                coverage: { changedSourceTotal: 10, reviewed: 6, reviewedBlind: 4, blindFiles: ['src/a.ts', 'src/b.ts'] },
            },
        });
        // The verdict states the denominator, not a blanket all-clear.
        expect(body).toMatch(/no issues found/i);
        expect(body).toContain('in the 2 entry points + 6 changed files reviewed');
        // Coverage line + the reviewed-blind warning with the file list.
        expect(body).toMatch(/Coverage:.*reviewed 6\/10 changed source files/i);
        expect(body).toMatch(/4 changed files NOT reviewed/i);
        expect(body).toContain('`src/a.ts`');
        expect(body).toMatch(/verdict above does not cover/i);
    });

    it('#916 — full coverage (0 reviewed-blind) shows the denominator without a warning', () => {
        const body = buildPrSummaryBody({
            inline: [], outside: [], allFindings: [],
            meta: { headSha: 'abc1234', entryPointsReviewed: 3, coverage: { changedSourceTotal: 5, reviewed: 5, reviewedBlind: 0 } },
        });
        expect(body).toMatch(/Coverage:.*reviewed 5\/5 changed source files/i);
        expect(body).not.toMatch(/NOT reviewed/i);
    });

    it('regressionHint renders as a "What to re-test" section (#853)', () => {
        const body = buildPrSummaryBody({
            inline: [], outside: [], allFindings: [],
            meta: { headSha: 'abc1234', regressionHint: '**Affected endpoints:** `GET /api/user`' },
        });
        expect(body).toContain('What to re-test');
        expect(body).toContain('GET /api/user');
    });
});

describe('renderRegressionHint (#853)', () => {
    it('renders endpoints, tests, command, untested count, and consumers', () => {
        const hint = renderRegressionHint({
            affectedApis: [{ method: 'GET', route: '/api/user' }, { method: 'PUT', route: '/api/user' }],
            testsToRun: [{ testFile: 'src/auth.test.ts' }],
            testCommand: 'npx vitest run src/auth.test.ts',
            untestedBlastRadius: [{}, {}],
            crossRepoConsumers: [{ consumerRepo: 'consumer', method: 'GET', route: '/api/user' }],
        })!;
        expect(hint).toContain('`GET /api/user`');
        expect(hint).toContain('src/auth.test.ts');
        expect(hint).toContain('npx vitest run src/auth.test.ts');
        expect(hint).toContain('2 impacted functions with no mapped test');
        expect(hint).toContain('consumer (`GET /api/user`)');
    });

    it('caps long lists with a +N more suffix', () => {
        const apis = Array.from({ length: 9 }, (_, i) => ({ method: 'GET', route: `/r${i}` }));
        const hint = renderRegressionHint({ affectedApis: apis })!;
        expect(hint).toContain('(+3 more)');
    });

    it('returns undefined for empty/null scopes so the section is skipped', () => {
        expect(renderRegressionHint(null)).toBeUndefined();
        expect(renderRegressionHint({ affectedApis: [], testsToRun: [], untestedBlastRadius: [], crossRepoConsumers: [], testCommand: null })).toBeUndefined();
    });
});
