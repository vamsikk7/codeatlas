/**
 * jsCallbackRange.test.ts
 *
 * Issue 267: regression suite for the regex+brace-counter that locates
 * anonymous JS/TS route handler bodies when tree-sitter can't (TSX with
 * JSX in the handler body, etc.).
 */

import { describe, it, expect } from 'vitest';
import { findJsCallbackRange } from '../jsCallbackRange';

describe('findJsCallbackRange', () => {
    it('finds an arrow callback with single-quoted route', () => {
        const code = `app.get('/users', (req, res) => { res.send('ok'); });`;
        const r = findJsCallbackRange(code, 'GET', '/users');
        expect(r).not.toBeNull();
        expect(r!.text).toContain('=>');
    });

    it('finds an arrow callback with double-quoted route', () => {
        const code = `app.post("/users", (req, res) => { res.json({}); });`;
        const r = findJsCallbackRange(code, 'POST', '/users');
        expect(r).not.toBeNull();
        expect(r!.text).toContain('=>');
    });

    it('finds an arrow callback with template literal route', () => {
        const code = 'app.put(`/users`, (c) => c.json({}));';
        const r = findJsCallbackRange(code, 'PUT', '/users');
        expect(r).not.toBeNull();
    });

    it('finds the LAST callback when middleware precedes (Hono pattern)', () => {
        const code = `app.get('/api/posts', prettyJSON(), (c) => { return c.json([]); });`;
        const r = findJsCallbackRange(code, 'GET', '/api/posts');
        expect(r).not.toBeNull();
        // Should have a body block, not the prettyJSON middleware call
        expect(r!.text.startsWith('(c)')).toBe(true);
    });

    it('handles a function expression callback', () => {
        const code = `app.delete('/x', function (req, res) { return res.send(204); });`;
        const r = findJsCallbackRange(code, 'DELETE', '/x');
        expect(r).not.toBeNull();
        expect(r!.text.startsWith('function')).toBe(true);
    });

    it('handles a TSX callback with JSX in the body', () => {
        const code = `app.get('/', (c) => {
  return c.html(<html lang="en"><head></head><body>hi</body></html>);
});`;
        const r = findJsCallbackRange(code, 'GET', '/');
        expect(r).not.toBeNull();
        expect(r!.text).toContain('<html');
    });

    it('handles a concise arrow body (no braces)', () => {
        const code = `app.get('/hello', (c) => c.text('Hono!!'));`;
        const r = findJsCallbackRange(code, 'GET', '/hello');
        expect(r).not.toBeNull();
    });

    it('Issue 289: does not match commented-out routes', () => {
        const code = `// app.get('/users', (req, res) => {})\n// .get("/users", function () {})`;
        const r = findJsCallbackRange(code, 'GET', '/users');
        expect(r).toBeNull();
    });

    it('Issue 289: does not match block-commented routes', () => {
        const code = `/* app.get('/users', (req, res) => {}) */`;
        const r = findJsCallbackRange(code, 'GET', '/users');
        expect(r).toBeNull();
    });

    it('Issue 289: still matches a real route when commented-out routes are nearby', () => {
        const code = `// app.get('/users', (req, res) => res.send('old'))
app.get('/users', (req, res) => res.json({ ok: true }));`;
        const r = findJsCallbackRange(code, 'GET', '/users');
        expect(r).not.toBeNull();
        expect(r!.text).toContain('json');
    });

    it('returns null when route is not found', () => {
        const code = `app.get('/users', (req, res) => res.send('x'));`;
        const r = findJsCallbackRange(code, 'GET', '/missing');
        expect(r).toBeNull();
    });

    it('disambiguates GET from POST on same path', () => {
        const code = `app.get('/users', () => 'g'); app.post('/users', () => 'p');`;
        const get = findJsCallbackRange(code, 'GET', '/users');
        const post = findJsCallbackRange(code, 'POST', '/users');
        expect(get).not.toBeNull();
        expect(post).not.toBeNull();
        expect(get!.startIndex).not.toBe(post!.startIndex);
    });
});
