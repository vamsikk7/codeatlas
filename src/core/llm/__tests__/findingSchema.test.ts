/**
 * findingSchema.test.ts — Per-entry + project-level finding parser tests.
 *
 * Issue #704. Strict + relaxed tolerance levels, raw-text repair (markdown
 * fences, trailing commas), and the per-field coercions that heal the most
 * common LLM divergences (case-mismatched severity, severity-as-array,
 * missing fields, layer-as-string).
 */

import { describe, it, expect } from 'vitest';
import {
    parseFindings,
    parseProjectFindings,
    extractFindingsJson,
    extractProjectFindingsJson,
    strictFindingSchema,
    relaxedFindingSchema,
} from '../findingSchema';

describe('findingSchema — parseFindings (per-entry)', () => {
    it('parses a well-formed finding via the strict pass', () => {
        const raw = JSON.stringify({
            findings: [{
                severity: 'error',
                category: 'security',
                title: 'Missing auth',
                body: 'No middleware guard.',
                layers: ['sequence'],
                evidence: { snippet: 'app.get("/foo", handler)' },
            }],
        });
        const result = parseFindings(raw, 'strict');
        expect(result.findings).toHaveLength(1);
        expect(result.repaired).toBe(0);
        expect(result.dropped).toBe(0);
        expect(result.findings[0].severity).toBe('error');
    });

    it('strict mode drops findings with missing required fields', () => {
        const raw = JSON.stringify({
            findings: [{ severity: 'error', title: 'no body or category' }],
        });
        const result = parseFindings(raw, 'strict');
        expect(result.findings).toHaveLength(0);
        expect(result.dropped).toBe(1);
    });

    it('relaxed mode repairs missing category + body defaults', () => {
        const raw = JSON.stringify({
            findings: [{
                severity: 'error',
                title: 'minimal finding',
                layers: ['sequence'],
            }],
        });
        const result = parseFindings(raw, 'relaxed');
        expect(result.findings).toHaveLength(1);
        expect(result.repaired).toBe(1);
        expect(result.findings[0].category).toBe('code-quality'); // default
        expect(result.findings[0].body).toBe(''); // default
    });

    it('relaxed mode normalizes severity case', () => {
        const raw = JSON.stringify({
            findings: [{
                severity: 'ERROR',
                category: 'security',
                title: 'x',
                body: 'y',
                layers: ['sequence'],
            }],
        });
        const result = parseFindings(raw, 'relaxed');
        expect(result.findings[0].severity).toBe('error');
    });

    it('relaxed mode unwraps severity-as-array', () => {
        const raw = JSON.stringify({
            findings: [{
                severity: ['warning'],
                category: 'security',
                title: 'x',
                body: 'y',
                layers: ['sequence'],
            }],
        });
        const result = parseFindings(raw, 'relaxed');
        expect(result.findings[0].severity).toBe('warning');
    });

    it('relaxed mode maps severity aliases (high/critical → error, medium → warning, low → info)', () => {
        const raw = JSON.stringify({
            findings: [
                { severity: 'high', category: 'security', title: 'h', body: '', layers: [] },
                { severity: 'critical', category: 'security', title: 'c', body: '', layers: [] },
                { severity: 'medium', category: 'security', title: 'm', body: '', layers: [] },
                { severity: 'low', category: 'security', title: 'l', body: '', layers: [] },
            ],
        });
        const result = parseFindings(raw, 'relaxed');
        expect(result.findings.map(f => f.severity)).toEqual(['error', 'error', 'warning', 'info']);
    });

    it('relaxed mode wraps non-array layers in a single-element array', () => {
        const raw = JSON.stringify({
            findings: [{
                severity: 'warning',
                category: 'security',
                title: 'x',
                body: 'y',
                layers: 'sequence', // string, not array
            }],
        });
        const result = parseFindings(raw, 'relaxed');
        expect(result.findings[0].layers).toEqual(['sequence']);
    });

    it('relaxed mode filters unknown layer values', () => {
        const raw = JSON.stringify({
            findings: [{
                severity: 'warning',
                category: 'security',
                title: 'x',
                body: 'y',
                layers: ['sequence', 'made-up-layer', 'flow'],
            }],
        });
        const result = parseFindings(raw, 'relaxed');
        expect(result.findings[0].layers).toEqual(['sequence', 'flow']);
    });

    it('relaxed mode maps common category aliases', () => {
        const raw = JSON.stringify({
            findings: [
                { severity: 'warning', category: 'bug', title: 'a', body: '', layers: [] },
                { severity: 'warning', category: 'perf', title: 'b', body: '', layers: [] },
                { severity: 'warning', category: 'sec', title: 'c', body: '', layers: [] },
                { severity: 'warning', category: 'arch', title: 'd', body: '', layers: [] },
                { severity: 'warning', category: 'api', title: 'e', body: '', layers: [] },
            ],
        });
        const result = parseFindings(raw, 'relaxed');
        expect(result.findings.map(f => f.category)).toEqual([
            'logic-bug', 'performance', 'security', 'architecture', 'api-design',
        ]);
    });

    it('strips ```json fences before parsing', () => {
        const raw = '```json\n{"findings": [{"severity": "error", "category": "security", "title": "x", "body": "", "layers": []}]}\n```';
        const result = parseFindings(raw, 'strict');
        expect(result.findings).toHaveLength(1);
    });

    it('strips trailing commas from JSON arrays/objects', () => {
        const raw = '{"findings": [{"severity": "error", "category": "security", "title": "x", "body": "", "layers": [],},]}';
        const result = parseFindings(raw, 'strict');
        expect(result.findings).toHaveLength(1);
    });

    it('handles prose-prefixed JSON via balanced-brace extraction', () => {
        const raw = `Based on the data, here are the findings:

{
  "findings": [{ "severity": "warning", "category": "security", "title": "x", "body": "", "layers": [] }]
}

End of report.`;
        const result = parseFindings(raw, 'strict');
        expect(result.findings).toHaveLength(1);
    });

    it('returns empty on totally unparseable text', () => {
        const result = parseFindings('just prose, no JSON whatsoever');
        expect(result.findings).toHaveLength(0);
    });

    it('returns empty when JSON has no findings array', () => {
        const result = parseFindings('{"other": "value"}');
        expect(result.findings).toHaveLength(0);
    });

    it('relaxed mode supplies title default when missing (empty string falls through)', () => {
        const raw = JSON.stringify({
            findings: [{
                severity: 'warning',
                category: 'security',
                body: 'has body, no title',
                layers: [],
            }],
        });
        const result = parseFindings(raw, 'relaxed');
        // Title missing → coerceTitle returns ''. Strict requires non-empty;
        // relaxed has no min(1) on title → finding survives with empty title.
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0].title).toBe('');
    });
});

describe('findingSchema — schema exports', () => {
    it('strict schema rejects missing severity', () => {
        const r = strictFindingSchema.safeParse({
            category: 'security', title: 'x', body: '', layers: [],
        });
        expect(r.success).toBe(false);
    });

    it('relaxed schema accepts missing severity (defaults to info)', () => {
        const r = relaxedFindingSchema.safeParse({
            category: 'security', title: 'x', body: '', layers: [],
        });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.severity).toBe('info');
    });
});

describe('findingSchema — parseProjectFindings (project-level)', () => {
    it('parses a well-formed project finding', () => {
        const raw = JSON.stringify({
            findings: [{
                severity: 'error',
                category: 'security',
                title: 'Hardcoded secret',
                body: 'API key in env loader',
                filePath: 'src/config.ts',
                evidence: { snippet: 'const KEY = "abc"' },
            }],
        });
        const result = parseProjectFindings(raw, 'strict');
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0].filePath).toBe('src/config.ts');
    });

    it('relaxed mode drops findings with no filePath (cannot be bound to a file)', () => {
        const raw = JSON.stringify({
            findings: [{
                severity: 'error',
                category: 'security',
                title: 'orphan finding',
                body: 'no filePath',
            }],
        });
        const result = parseProjectFindings(raw, 'relaxed');
        expect(result.findings).toHaveLength(0);
        expect(result.dropped).toBe(1);
    });

    it('relaxed mode repairs severity case + applies category default', () => {
        const raw = JSON.stringify({
            findings: [{
                severity: 'Warning',
                title: 'project-level',
                filePath: 'src/auth.ts',
            }],
        });
        const result = parseProjectFindings(raw, 'relaxed');
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0].severity).toBe('warning');
        expect(result.findings[0].category).toBe('code-quality');
    });
});

describe('findingSchema — legacy extractor wrappers', () => {
    it('extractFindingsJson is the relaxed per-entry parser', () => {
        const raw = JSON.stringify({
            findings: [{ severity: 'ERROR', title: 'x' }], // case-mismatched, missing fields
        });
        const { findings } = extractFindingsJson(raw);
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe('error');
    });

    it('extractProjectFindingsJson is the relaxed project parser', () => {
        const raw = JSON.stringify({
            findings: [{
                severity: 'warning', title: 'x', filePath: 'src/foo.ts',
            }],
        });
        const { findings } = extractProjectFindingsJson(raw);
        expect(findings).toHaveLength(1);
        expect(findings[0].filePath).toBe('src/foo.ts');
    });
});
