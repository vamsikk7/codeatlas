/**
 * env.test.ts — Issue #602 Phase 2 env var substitution.
 */

import { describe, it, expect } from 'vitest';
import { applyEnvVars, parseEnvLines, applyEnvToRecord } from '../env';

describe('applyEnvVars', () => {
    it('substitutes a single {{var}}', () => {
        expect(applyEnvVars('{{base}}/articles', { base: 'http://localhost:3000' }))
            .toBe('http://localhost:3000/articles');
    });
    it('substitutes multiple variables in one string', () => {
        expect(applyEnvVars('{{a}}/{{b}}', { a: 'x', b: 'y' })).toBe('x/y');
    });
    it('resolves chained references up to MAX_DEPTH', () => {
        const env = { base: '{{root}}', root: 'http://example.com' };
        expect(applyEnvVars('{{base}}/api', env)).toBe('http://example.com/api');
    });
    it('leaves unknown variables in place', () => {
        expect(applyEnvVars('{{missing}}', {})).toBe('{{missing}}');
    });
    it('aborts on self-referential cycles', () => {
        expect(applyEnvVars('{{base}}', { base: '{{base}}/x' })).toContain('{{base}}');
    });
    it('handles strings without any template vars cheaply', () => {
        expect(applyEnvVars('no-vars-here', {})).toBe('no-vars-here');
    });
});

describe('parseEnvLines', () => {
    it('parses simple key=value pairs', () => {
        const out = parseEnvLines('base=http://localhost:3000\ntoken=abc');
        expect(out.env).toEqual({ base: 'http://localhost:3000', token: 'abc' });
        expect(out.skipped).toBe(0);
    });
    it('ignores comment + blank lines', () => {
        const out = parseEnvLines('# comment\n\nbase=x\n');
        expect(out.env).toEqual({ base: 'x' });
    });
    it('allows `=` in values', () => {
        const out = parseEnvLines('q=foo=bar');
        expect(out.env.q).toBe('foo=bar');
    });
    it('reports malformed lines via skipped count', () => {
        const out = parseEnvLines('no-equals-here\nvalid=ok\n=missing-key');
        expect(out.env).toEqual({ valid: 'ok' });
        expect(out.skipped).toBe(2);
    });
});

describe('applyEnvToRecord', () => {
    it('substitutes vars in every value of a header map', () => {
        const out = applyEnvToRecord(
            { Authorization: 'Bearer {{token}}', 'X-Trace': 'static' },
            { token: 'abc' },
        );
        expect(out.Authorization).toBe('Bearer abc');
        expect(out['X-Trace']).toBe('static');
    });
});
