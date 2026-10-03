/**
 * safeJson.test.ts — #891 prototype-pollution-safe LLM JSON parsing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { parseLlmJson } from '../safeJson';
import { parseFindings } from '../findingSchema';

describe('#891 — parseLlmJson neutralizes prototype pollution', () => {
    afterEach(() => {
        // Defensive: scrub any accidental pollution between tests.
        delete (Object.prototype as any).polluted;
        delete (Object.prototype as any).evil;
    });

    it('drops a top-level __proto__ payload — Object.prototype stays clean', () => {
        const out = parseLlmJson<any>('{"__proto__": {"polluted": "yes"}, "ok": 1}');
        expect(({} as any).polluted).toBeUndefined();
        expect(out.ok).toBe(1);
        // __proto__ was not assigned as an own data key either
        expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    });

    it('drops a nested constructor.prototype pollution chain', () => {
        parseLlmJson('{"a": {"constructor": {"prototype": {"evil": true}}}}');
        expect(({} as any).evil).toBeUndefined();
    });

    it('drops __proto__ inside an array element', () => {
        parseLlmJson('[{"__proto__": {"polluted": 1}}, {"x": 2}]');
        expect(({} as any).polluted).toBeUndefined();
    });

    it('preserves legitimate data unchanged', () => {
        const out = parseLlmJson<any>('{"findings": [{"title": "t", "severity": "error", "nested": {"x": [1, 2, 3]}}]}');
        expect(out.findings[0].title).toBe('t');
        expect(out.findings[0].nested.x).toEqual([1, 2, 3]);
    });

    it('throws on invalid JSON like JSON.parse (callers keep their try/catch)', () => {
        expect(() => parseLlmJson('not json')).toThrow();
    });

    it('wired into findingSchema.parseFindings — a hostile review response cannot pollute', () => {
        // The review-parse path is the primary untrusted-LLM-text sink.
        parseFindings('{"__proto__": {"polluted": "x"}, "findings": [{"title": "t", "body": "b", "severity": "warning", "category": "code-quality", "evidence": {"snippet": "x"}}]}');
        expect(({} as any).polluted).toBeUndefined();
    });
});
