import { describe, it, expect } from 'vitest';
import { extractFindingsJson } from '../aiReview';

describe('extractFindingsJson', () => {
    it('parses bare JSON', () => {
        const r = extractFindingsJson('{"findings": [{"title": "x"}]}');
        expect(r.findings).toHaveLength(1);
    });

    it('strips ```json code fences', () => {
        const r = extractFindingsJson('```json\n{"findings": []}\n```');
        expect(r.findings).toEqual([]);
    });

    it('handles prose-prefixed JSON (the deepseek pattern)', () => {
        const txt = `Based on the provided data, here are the findings:

\`\`\`json
{
  "findings": [
    { "severity": "error", "title": "Missing auth", "body": "x", "evidence": { "snippet": "abc" } }
  ]
}
\`\`\`

This finding is...`;
        const r = extractFindingsJson(txt);
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].title).toBe('Missing auth');
    });

    it('handles JSON with nested objects + strings containing braces', () => {
        const txt = 'prose { "findings": [ { "title": "x with {brace} string", "body": "y" } ] } more prose';
        const r = extractFindingsJson(txt);
        expect(r.findings[0].title).toBe('x with {brace} string');
    });

    it('returns empty findings on totally unparseable text', () => {
        const r = extractFindingsJson('just some text');
        expect(r.findings).toEqual([]);
    });

    it('returns empty findings when the JSON has no findings array', () => {
        const r = extractFindingsJson('{"other": "value"}');
        expect(r.findings).toEqual([]);
    });

    it('handles escaped quotes inside strings', () => {
        const r = extractFindingsJson('{"findings": [{"body": "he said \\"hi\\""}]}');
        expect(r.findings[0].body).toBe('he said "hi"');
    });
});
