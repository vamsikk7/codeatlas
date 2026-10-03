/**
 * lineDiff.test.ts — #925/#926. The unified-diff window shown to the reviewer, and
 * the evidence gate matching a clean quote against a +/- diff corpus.
 */
import { describe, it, expect } from 'vitest';
import { unifiedDiffWindow, lcsLineDiff } from '../lineDiff';
import { evidenceMatches, stripDiffPrefixes } from '../../llm/perEntryReviewer';

describe('#925 — unifiedDiffWindow', () => {
    it('emits +/- hunks for a small edit, with context', () => {
        const out = unifiedDiffWindow('a\nb\nX\nd\ne', 'a\nb\nc\nd\ne', { contextLines: 1, maxLines: 100 });
        expect(out).toContain('-     c');   // removed
        expect(out).toContain('+3: X');     // added (working line 3)
        expect(out).toContain(' 2: b');     // context before
        expect(out).toContain(' 4: d');     // context after
    });

    it('returns empty string for byte-identical content', () => {
        expect(unifiedDiffWindow('a\nb\nc', 'a\nb\nc')).toBe('');
    });

    it('no baseline (NEW FILE) → every line marked `+` under a banner (#930)', () => {
        const out = unifiedDiffWindow('x\ny', undefined);
        expect(out).toContain('NEW FILE');
        expect(out).toContain('+1: x');
        expect(out).toContain('+2: y');
        // The whole file is added — no plain `N: ` (unmarked) lines that read as "unchanged".
        expect(out).not.toMatch(/^\s*\d+: /m);
    });

    it('NEW FILE marks overflow loudly past the window (#930)', () => {
        const work = Array.from({ length: 50 }, (_, i) => `n${i}`).join('\n');
        const out = unifiedDiffWindow(work, undefined, { contextLines: 1, maxLines: 10 });
        expect(out).toContain('+10: n9');
        expect(out).toContain('more added lines');
        expect(out).toContain('NOT shown');
    });

    it('too large to diff → head shown under a loud TOO LARGE banner, never silent (#930)', () => {
        // > MAX_DIFF_LINES (4000) on either side trips the LCS guard.
        const huge = Array.from({ length: 4100 }, (_, i) => `h${i}`).join('\n');
        const out = unifiedDiffWindow(huge, 'a\nb\nc', { contextLines: 2, maxLines: 30 });
        expect(out).toContain('TOO LARGE TO DIFF');
        expect(out).toContain('1: h0');   // head shown, numbered
    });

    it('windows to the affected hunk only on a large file (not all 500 lines)', () => {
        const base = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n');
        const work = base.replace('line250', 'CHANGED250');
        const out = unifiedDiffWindow(work, base, { contextLines: 2, maxLines: 100 });
        expect(out).toContain('+251: CHANGED250');           // 1-based working line
        expect(out).toContain('unchanged');                  // gap markers present
        expect(out.split('\n').length).toBeLessThan(25);     // only the hunk, not 500 lines
    });

    it('marks overflow LOUDLY when the diff exceeds maxLines (no silent truncation) — #927', () => {
        const base = Array.from({ length: 200 }, (_, i) => `L${i}`).join('\n');
        const work = Array.from({ length: 200 }, (_, i) => `Y${i}`).join('\n'); // every line changed
        const out = unifiedDiffWindow(work, base, { contextLines: 1, maxLines: 20 });
        expect(out).toContain('NOT shown');
    });

    it('#938 — a CHANGED line past the maxLines budget is still emitted (changed > context priority)', () => {
        const base = Array.from({ length: 320 }, (_, i) => `L${i}`);
        const work = [...base];
        for (let i = 0; i < 20; i++) work[i] = `EARLY_${i}`; // 20 early changes consume the small budget
        work[300] = 'LATE_CHANGE';                            // a 21st change, far past the window
        const out = unifiedDiffWindow(work.join('\n'), base.join('\n'), { contextLines: 1, maxLines: 15 });
        expect(out).toContain('+1: EARLY_0');        // early change shown
        expect(out).toContain('+301: LATE_CHANGE');  // the OLD budget dropped this; now always shown
        expect(out).toContain('context lines beyond'); // context IS still capped, loudly
    });

    it('#938 — a pathological all-changed file is bounded by the hard ceiling, marked loudly', () => {
        const base = Array.from({ length: 1000 }, (_, i) => `L${i}`).join('\n');
        const work = Array.from({ length: 1000 }, (_, i) => `Y${i}`).join('\n'); // 1000 changed
        const out = unifiedDiffWindow(work, base, { contextLines: 1, maxLines: 50 }); // hardCeil = 200
        expect(out).toContain('CHANGED lines beyond the 200-line hard cap');
    });

    it('lcsLineDiff aligns +/-/context', () => {
        const ops = lcsLineDiff(['a', 'c'], ['a', 'b', 'c']);
        expect(ops.map((o) => o.t).join('')).toBe(' + ');  // a unchanged, b added, c unchanged
    });
});

describe('#926 — evidence gate matches a clean quote against a diff corpus', () => {
    it('single-line clean quote matches a +/- corpus', () => {
        const corpus = ' 4: const a = 1;\n+5: events.forEach(async (e) => del(e));\n 6: const b = 2;';
        expect(evidenceMatches('events.forEach(async (e) => del(e));', corpus)).toBe(true);
    });

    it('multi-line clean quote matches across diff-prefixed lines', () => {
        const corpus = '+5: function cancel() {\n+6:   events.forEach(async (e) => del(e));\n+7: }';
        expect(evidenceMatches('function cancel() {\n  events.forEach(async (e) => del(e));', corpus)).toBe(true);
    });

    it('stripDiffPrefixes drops gap markers + +/-/N: prefixes', () => {
        expect(stripDiffPrefixes('+5: foo\n-     bar\n 6: baz\n        … 3 unchanged …')).toBe('foo\nbar\nbaz');
    });

    it('leaves plain (un-prefixed) code lines unchanged', () => {
        expect(stripDiffPrefixes('const x = 1;\nreturn x;')).toBe('const x = 1;\nreturn x;');
    });
});
