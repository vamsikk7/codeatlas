import { describe, it, expect } from 'vitest';
import { interpretFetchError } from '../interpretFetchError';

describe('interpretFetchError - UX-23', () => {
    it('returns null when error is missing/empty', () => {
        expect(interpretFetchError(null)).toBeNull();
        expect(interpretFetchError(undefined)).toBeNull();
        expect(interpretFetchError('')).toBeNull();
    });

    it('returns null for HTTP-level errors (the response panel already shows them)', () => {
        // 404 / 500 / etc. are not network errors — no hint.
        expect(interpretFetchError('Not Found')).toBeNull();
        expect(interpretFetchError('Internal Server Error')).toBeNull();
    });

    describe('localhost + fetch-failed', () => {
        it('suggests starting the local server', () => {
            const hint = interpretFetchError('TypeError: fetch failed', 'http://localhost:3000/api/users');
            expect(hint).not.toBeNull();
            expect(hint!.headline).toMatch(/server running/i);
            expect(hint!.suggestion).toContain('http://localhost:3000/api/users');
        });

        it('handles 127.0.0.1 as localhost', () => {
            const hint = interpretFetchError('Failed to fetch', 'http://127.0.0.1:8080/');
            expect(hint).not.toBeNull();
            expect(hint!.headline).toMatch(/server running/i);
        });

        it('handles IPv6 ::1', () => {
            const hint = interpretFetchError('fetch failed', 'http://[::1]:3000/api');
            expect(hint).not.toBeNull();
            expect(hint!.headline).toMatch(/server running/i);
        });
    });

    describe('private LAN host + fetch-failed', () => {
        it('suggests checking VPN / network', () => {
            const hint = interpretFetchError('Failed to fetch', 'http://192.168.1.5:3000/api/users');
            expect(hint).not.toBeNull();
            expect(hint!.headline).toMatch(/private host/i);
            expect(hint!.suggestion).toMatch(/VPN/);
        });

        it('treats 10.x.x.x as private', () => {
            const hint = interpretFetchError('fetch failed', 'http://10.0.0.5:8080/');
            expect(hint!.headline).toMatch(/private host/i);
        });

        it('treats 172.16-31.x.x as private', () => {
            const hint = interpretFetchError('fetch failed', 'http://172.20.0.5/');
            expect(hint!.headline).toMatch(/private host/i);
        });
    });

    describe('public host + fetch-failed', () => {
        it('returns a host-bearing generic hint', () => {
            const hint = interpretFetchError('Failed to fetch', 'https://api.example.com/v1/users');
            expect(hint).not.toBeNull();
            expect(hint!.headline).toMatch(/Couldn't reach api\.example\.com/);
            expect(hint!.suggestion).toMatch(/firewall|server may be down/i);
        });
    });

    describe('connection refused', () => {
        it('localhost: same as fetch-failed', () => {
            const hint = interpretFetchError('ECONNREFUSED 127.0.0.1:3000', 'http://localhost:3000/');
            expect(hint!.headline).toMatch(/server running/i);
        });
    });

    describe('DNS resolution failure', () => {
        it('suggests checking the URL', () => {
            const hint = interpretFetchError('ENOTFOUND api.exmaple.com', 'https://api.exmaple.com/v1');
            expect(hint!.headline).toMatch(/Couldn't resolve/);
            expect(hint!.suggestion).toMatch(/spell|DNS/i);
        });

        it('handles DNS error with no URL', () => {
            const hint = interpretFetchError('Name not resolved');
            expect(hint!.headline).toMatch(/Couldn't resolve/);
        });
    });

    describe('no URL context', () => {
        it('returns a generic hint with localhost suggestion', () => {
            const hint = interpretFetchError('TypeError: fetch failed');
            expect(hint).not.toBeNull();
            expect(hint!.headline).toMatch(/couldn't reach/i);
        });
    });
});
