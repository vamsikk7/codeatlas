/**
 * sandbox.test.ts — Issue #603 Phase 3.5 script executor.
 */

import { describe, it, expect } from 'vitest';
import { runScript } from '../sandbox';

const baseRequest = {
    method: 'POST',
    url: 'http://localhost/api/users/login',
    headers: { 'Content-Type': 'application/json' },
    body: '{"email":"a@b.com"}',
};

const baseResponse = {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json', 'x-trace': 'abc' },
    body: '{"user":{"id":1,"token":"tk"}}',
};

describe('runScript — pm.environment', () => {
    it('reads + writes env vars via pm.environment', () => {
        const out = runScript({
            source: `
                pm.environment.set('token', 'abc123');
                pm.environment.set('id', pm.environment.get('seed') + '-x');
            `,
            env: { seed: 'S' },
            request: baseRequest,
        });
        expect(out.error).toBeUndefined();
        expect(out.env.token).toBe('abc123');
        expect(out.env.id).toBe('S-x');
    });

    it('supports has() + unset()', () => {
        const out = runScript({
            source: `
                if (pm.environment.has('seed')) pm.environment.unset('seed');
                pm.environment.set('flag', 'on');
            `,
            env: { seed: 'X' },
            request: baseRequest,
        });
        expect(out.env.seed).toBeUndefined();
        expect(out.env.flag).toBe('on');
    });
});

describe('runScript — pm.response', () => {
    it('parses JSON body via pm.response.json()', () => {
        const out = runScript({
            source: `
                const body = pm.response.json();
                pm.environment.set('userId', String(body.user.id));
                pm.environment.set('token', body.user.token);
            `,
            env: {},
            request: baseRequest,
            response: baseResponse,
        });
        expect(out.env.userId).toBe('1');
        expect(out.env.token).toBe('tk');
    });

    it('reads response headers via pm.response.headers.get()', () => {
        const out = runScript({
            source: `pm.environment.set('trace', pm.response.headers.get('X-Trace'));`,
            env: {},
            request: baseRequest,
            response: baseResponse,
        });
        expect(out.env.trace).toBe('abc');
    });

    it('reads response.status', () => {
        const out = runScript({
            source: `pm.environment.set('status', String(pm.response.status));`,
            env: {},
            request: baseRequest,
            response: baseResponse,
        });
        expect(out.env.status).toBe('200');
    });
});

describe('runScript — pm.test + pm.expect', () => {
    it('records passing test results', () => {
        const out = runScript({
            source: `
                pm.test('status is 200', () => pm.expect(pm.response.status).toBe(200));
                pm.test('user is present', () => pm.expect(pm.response.json().user).toBeTruthy());
            `,
            env: {},
            request: baseRequest,
            response: baseResponse,
        });
        expect(out.testResults).toHaveLength(2);
        expect(out.testResults.every(t => t.passed)).toBe(true);
    });

    it('records failing test results with messages', () => {
        const out = runScript({
            source: `
                pm.test('wrong status', () => pm.expect(pm.response.status).toBe(404));
                pm.test('falsy expect', () => pm.expect(true).toBeFalsy());
            `,
            env: {},
            request: baseRequest,
            response: baseResponse,
        });
        expect(out.testResults).toHaveLength(2);
        expect(out.testResults[0]).toMatchObject({ passed: false });
        expect(out.testResults[0].error).toContain('expected 404');
        expect(out.testResults[1].passed).toBe(false);
    });

    it('supports toContain on strings and arrays', () => {
        const out = runScript({
            source: `
                pm.test('string contains', () => pm.expect('hello world').toContain('world'));
                pm.test('array contains', () => pm.expect([1, 2, 3]).toContain(2));
            `,
            env: {},
            request: baseRequest,
        });
        expect(out.testResults.every(t => t.passed)).toBe(true);
    });

    it('supports toMatch on strings', () => {
        const out = runScript({
            source: `pm.test('matches', () => pm.expect('user-123').toMatch(/^user-/));`,
            env: {},
            request: baseRequest,
        });
        expect(out.testResults[0].passed).toBe(true);
    });

    it('supports toEqual deep equality', () => {
        const out = runScript({
            source: `pm.test('deep', () => pm.expect({ a: [1, 2] }).toEqual({ a: [1, 2] }));`,
            env: {},
            request: baseRequest,
        });
        expect(out.testResults[0].passed).toBe(true);
    });
});

describe('runScript — sandboxing + safety', () => {
    it('rejects access to `require`, `process`, or fs', () => {
        const out = runScript({
            source: `require('fs');`,
            env: {},
            request: baseRequest,
        });
        expect(out.error).toContain('require');
    });

    it('captures console.log output', () => {
        const out = runScript({
            source: `console.log('hi', { a: 1 });`,
            env: {},
            request: baseRequest,
        });
        expect(out.logs.join('|')).toContain('hi');
        expect(out.logs.join('|')).toContain('"a":1');
    });

    it('returns an error when the script throws', () => {
        const out = runScript({
            source: `throw new Error('boom');`,
            env: {},
            request: baseRequest,
        });
        expect(out.error).toContain('boom');
    });

    it('aborts a runaway script via the 2s timeout', () => {
        const out = runScript({
            source: `while (true) {}`,
            env: {},
            request: baseRequest,
        });
        expect(out.error).toBeDefined();
        expect(out.error?.toLowerCase()).toMatch(/timed|timeout|terminated/);
    });
});
