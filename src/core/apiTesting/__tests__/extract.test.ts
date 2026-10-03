/**
 * extract.test.ts — Issue #603 Phase 3 JSONPath-lite extractor.
 */

import { describe, it, expect } from 'vitest';
import { extractValue, tryParseJsonBody } from '../extract';

const BODY = {
    user: { id: 42, token: 'abc', email: 'a@b.com' },
    articles: [
        { id: 1, slug: 'first', title: 'First' },
        { id: 2, slug: 'second', title: 'Second' },
    ],
    nested: { deep: { value: 'found' } },
    data: null,
};

const ctx = {
    body: BODY,
    headers: { 'content-type': 'application/json', 'x-request-id': 'r1' },
    status: 201,
};

describe('extractValue — json scope', () => {
    it('drills into a dot path', () => {
        expect(extractValue('$.user.token', 'json', ctx)).toBe('abc');
        expect(extractValue('user.token', 'json', ctx)).toBe('abc');
    });
    it('drills with bracketed index', () => {
        expect(extractValue('$.articles[0].slug', 'json', ctx)).toBe('first');
        expect(extractValue('articles[1].id', 'json', ctx)).toBe(2);
    });
    it('returns array via wildcard', () => {
        expect(extractValue('$.articles.*.id', 'json', ctx)).toEqual([1, 2]);
    });
    it('returns undefined for missing keys', () => {
        expect(extractValue('$.missing.x', 'json', ctx)).toBeUndefined();
        expect(extractValue('$.user.nonexistent', 'json', ctx)).toBeUndefined();
    });
    it('handles deeply nested paths', () => {
        expect(extractValue('$.nested.deep.value', 'json', ctx)).toBe('found');
    });
    it('returns the whole body for `$` or empty', () => {
        expect(extractValue('$', 'json', ctx)).toBe(BODY);
    });
    it('returns undefined for null parents', () => {
        expect(extractValue('$.data.x', 'json', ctx)).toBeUndefined();
    });
});

describe('extractValue — headers scope', () => {
    it('reads headers case-insensitively', () => {
        expect(extractValue('X-Request-Id', 'headers', ctx)).toBe('r1');
        expect(extractValue('content-type', 'headers', ctx)).toBe('application/json');
    });
    it('returns undefined for missing headers', () => {
        expect(extractValue('X-Missing', 'headers', ctx)).toBeUndefined();
    });
});

describe('extractValue — status scope', () => {
    it('returns the numeric status code', () => {
        expect(extractValue('', 'status', ctx)).toBe(201);
        // Path is irrelevant when scope is `status`.
        expect(extractValue('anything', 'status', ctx)).toBe(201);
    });
});

describe('tryParseJsonBody', () => {
    it('parses valid JSON', () => {
        expect(tryParseJsonBody('{"ok":true}')).toEqual({ ok: true });
    });
    it('returns undefined for invalid JSON', () => {
        expect(tryParseJsonBody('not json')).toBeUndefined();
    });
    it('returns undefined for empty input', () => {
        expect(tryParseJsonBody('')).toBeUndefined();
    });
});
