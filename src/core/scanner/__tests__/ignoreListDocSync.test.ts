// docs/scanner-ignore-list.md is a human-readable mirror of
// DEFAULT_IGNORE_PATTERNS. This test enforces zero drift between the two:
//
//   1. Every pattern in DEFAULT_IGNORE_PATTERNS must appear as an inline
//      code span (backtick-quoted) somewhere in the doc.
//   2. Every glob-shaped inline code span in the doc that looks like an
//      ignore pattern (starts with two-star slash) must exist in
//      DEFAULT_IGNORE_PATTERNS.
//
// If you add or remove a pattern in workspaceScanner.ts, update the doc.
// If you find a missing pattern in the doc, add it. The code is the source
// of truth; the doc is a derived artefact enforced as authored (not
// generated) so the why column stays human-written.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_IGNORE_PATTERNS } from '../workspaceScanner';

const DOC_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'scanner-ignore-list.md');

function extractGlobPatterns(markdown: string): Set<string> {
    // Every inline-code span matching one of:
    //   **/<dir>/**           — dir-anywhere glob (most common)
    //   **/*.<ext>            — file-extension glob
    //   **/<path-with-slash>  — file-anywhere glob (no trailing /**)
    //
    // Anchored against backticks so prose mentions of literal strings
    // (e.g. `build.gradle.kts`) don't get picked up.
    const inlineCodeRe = /`([^`\n]+?)`/g;
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = inlineCodeRe.exec(markdown)) !== null) {
        const span = m[1].trim();
        // Treat anything beginning with `**/` as a glob pattern. False
        // positives from prose are rare — no one types `**/foo` casually.
        if (span.startsWith('**/') && span.length > 3) {
            found.add(span);
        }
    }
    return found;
}

describe('scanner ignore list — doc / code sync (ADR-035-adjacent)', () => {
    it('docs/scanner-ignore-list.md exists', () => {
        expect(fs.existsSync(DOC_PATH)).toBe(true);
    });

    it('every DEFAULT_IGNORE_PATTERNS entry appears in the doc', () => {
        const doc = fs.readFileSync(DOC_PATH, 'utf8');
        const docPatterns = extractGlobPatterns(doc);
        const missing = DEFAULT_IGNORE_PATTERNS.filter((p) => !docPatterns.has(p));
        expect(missing).toEqual([]);
    });

    it('every glob-shaped pattern in the doc exists in DEFAULT_IGNORE_PATTERNS', () => {
        const doc = fs.readFileSync(DOC_PATH, 'utf8');
        const docPatterns = extractGlobPatterns(doc);
        const codeSet = new Set(DEFAULT_IGNORE_PATTERNS);
        const extra = Array.from(docPatterns).filter((p) => !codeSet.has(p));
        // The doc may quote pattern *examples* in prose for the "NOT excluded"
        // section. Allowlist those so the test stays strict on real patterns
        // while permitting documented exceptions.
        const PROSE_ALLOWLIST = new Set<string>([
            '**/out/**',          // intentionally NOT excluded (documented exception)
            '**/packages/**',     // intentionally NOT excluded (documented exception)
            '**/env/**',          // intentionally NOT excluded (documented exception)
            '**/log/**',          // intentionally NOT excluded (documented exception)
            '**/bin/**',          // intentionally NOT excluded (documented exception)
            '**/obj/**',          // intentionally NOT excluded (documented exception)
            '**/test/**',         // mentioned in "How to add" as an example user pattern
            '**/legacy-junk/**',  // example user pattern in "How to add"
            '**/test-fixtures/**',// example user pattern in "How to add"
            '**/my-custom-build-dir/**',  // example user pattern in "How to add"
            '**/<dir>/**',        // placeholder syntax in the intro section
        ]);
        const trulyExtra = extra.filter((p) => !PROSE_ALLOWLIST.has(p));
        expect(trulyExtra).toEqual([]);
    });

    it('pattern count parity (sanity check, ignoring prose-only mentions)', () => {
        const doc = fs.readFileSync(DOC_PATH, 'utf8');
        const docPatterns = extractGlobPatterns(doc);
        // Doc may have extra prose examples; code is the authoritative count.
        // Just assert the code side is non-empty so a refactor that wipes
        // DEFAULT_IGNORE_PATTERNS gets caught here.
        expect(DEFAULT_IGNORE_PATTERNS.length).toBeGreaterThan(20);
        expect(docPatterns.size).toBeGreaterThanOrEqual(DEFAULT_IGNORE_PATTERNS.length);
    });
});
