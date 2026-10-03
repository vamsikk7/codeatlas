/**
 * resolveDistDir.test.ts — #860.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveDistDir } from '../server';

describe('resolveDistDir (#860)', () => {
    it('packaged layout: assets co-located in dist/ → returns dist/', () => {
        // <pkg>/dist/mcp-server.js with <pkg>/dist/webview-ui/dist/index.html
        const caller = '/pkg/dist/mcp-server.js';
        const exists = (p: string) => p === '/pkg/dist/webview-ui/dist/index.html';
        expect(resolveDistDir(caller, exists)).toBe('/pkg/dist');
    });

    it('raw in-repo build: dist/ has NO webview → falls back to repo root one level up', () => {
        // <repo>/dist/mcp-server.js with assets at <repo>/webview-ui/dist/index.html
        const caller = '/repo/dist/mcp-server.js';
        const exists = (p: string) => p === '/repo/webview-ui/dist/index.html';
        expect(resolveDistDir(caller, exists)).toBe('/repo');
    });

    it('neither present: returns the caller dir (legacy) without throwing', () => {
        const caller = '/x/dist/mcp-server.js';
        expect(resolveDistDir(caller, () => false)).toBe('/x/dist');
    });

    it('prefers the co-located dir when both exist', () => {
        const caller = '/repo/dist/mcp-server.js';
        const exists = (p: string) =>
            p === '/repo/dist/webview-ui/dist/index.html' || p === '/repo/webview-ui/dist/index.html';
        expect(resolveDistDir(caller, exists)).toBe(path.dirname(caller));
    });
});
