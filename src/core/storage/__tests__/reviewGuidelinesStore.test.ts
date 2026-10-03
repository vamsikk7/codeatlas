import { describe, it, expect } from 'vitest';
import { ReviewGuidelinesStore, sanitiseGuidelines, REVIEW_GUIDELINES_MAX_BYTES } from '../reviewGuidelinesStore';

describe('sanitiseGuidelines', () => {
    it('returns empty for non-string input', () => {
        expect(sanitiseGuidelines(undefined as any)).toBe('');
        expect(sanitiseGuidelines(null as any)).toBe('');
        expect(sanitiseGuidelines(42 as any)).toBe('');
    });

    it('preserves newlines, carriage returns, and tabs', () => {
        const txt = 'rule 1\nrule 2\r\nrule 3\twith tab';
        expect(sanitiseGuidelines(txt)).toBe(txt);
    });

    it('strips C0 control chars and DEL', () => {
        // \x00 NUL, \x07 BEL, \x1B ESC, \x7F DEL should go.
        const input = `rule\x00 1\x07\nrule\x1B 2\x7F`;
        expect(sanitiseGuidelines(input)).toBe('rule 1\nrule 2');
    });

    it('clamps to the byte limit', () => {
        const big = 'x'.repeat(REVIEW_GUIDELINES_MAX_BYTES + 100);
        const cleaned = sanitiseGuidelines(big);
        expect(Buffer.byteLength(cleaned, 'utf8')).toBeLessThanOrEqual(REVIEW_GUIDELINES_MAX_BYTES);
    });

    it('clamps multi-byte content without producing partial code units', () => {
        // Each 你 is 3 bytes. Build something just over the limit.
        const target = Math.ceil(REVIEW_GUIDELINES_MAX_BYTES / 3) + 50;
        const big = '你'.repeat(target);
        const cleaned = sanitiseGuidelines(big);
        // Should still parse as valid UTF-8 (no replacement chars).
        expect(cleaned).not.toContain('�');
        expect(Buffer.byteLength(cleaned, 'utf8')).toBeLessThanOrEqual(REVIEW_GUIDELINES_MAX_BYTES);
    });
});

describe('ReviewGuidelinesStore', () => {
    it('starts empty by default', () => {
        const s = new ReviewGuidelinesStore();
        const r = s.get();
        expect(r.text).toBe('');
        expect(r.hash).toBe('');
        expect(r.updatedAt).toBeGreaterThan(0);
    });

    it('hashes non-empty text deterministically', () => {
        const a = new ReviewGuidelinesStore();
        const b = new ReviewGuidelinesStore();
        const r1 = a.set('flag missing auth');
        const r2 = b.set('flag missing auth');
        expect(r1.hash).toBe(r2.hash);
        expect(r1.hash).not.toBe('');
    });

    it('produces different hashes for different content', () => {
        const s = new ReviewGuidelinesStore();
        const a = s.set('rule one');
        const b = s.set('rule two');
        expect(a.hash).not.toBe(b.hash);
    });

    it('sanitises on set()', () => {
        const s = new ReviewGuidelinesStore();
        const r = s.set('clean\x00 me');
        expect(r.text).toBe('clean me');
    });

    it('clear() resets to empty', () => {
        const s = new ReviewGuidelinesStore();
        s.set('something');
        const r = s.clear();
        expect(r.text).toBe('');
        expect(r.hash).toBe('');
    });
});
