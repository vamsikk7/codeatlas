/**
 * oauth2CallbackParser.test.ts — #604 OAuth2 callback receiver (2026-06-06).
 *
 * Tests for the URL parser that extracts `code` + `state` (success) or
 * `error` + `error_description` (failure) from the `/oauth2/callback`
 * redirect URL. Pure function — no I/O, no module deps beyond URL.
 */
import { describe, it, expect } from 'vitest';
import { parseOAuth2Callback } from '../oauth2CallbackParser';

describe('parseOAuth2Callback', () => {
    it('extracts code + state from a happy-path callback URL', () => {
        const result = parseOAuth2Callback('http://localhost:7742/oauth2/callback?code=abc123&state=xyz789');
        expect(result).toEqual({ ok: true, code: 'abc123', state: 'xyz789' });
    });

    it('preserves the state when it carries url-encoded chars', () => {
        const result = parseOAuth2Callback('http://localhost:7742/oauth2/callback?code=c&state=a%2Bb%2Fc%3D');
        expect(result).toEqual({ ok: true, code: 'c', state: 'a+b/c=' });
    });

    it('extracts an error + description when the user denies consent', () => {
        const result = parseOAuth2Callback('http://localhost:7742/oauth2/callback?error=access_denied&error_description=The+user+denied+the+request&state=xyz');
        expect(result).toEqual({
            ok: false,
            error: 'access_denied',
            errorDescription: 'The user denied the request',
            state: 'xyz',
        });
    });

    it('returns null when neither code nor error is present', () => {
        const result = parseOAuth2Callback('http://localhost:7742/oauth2/callback?state=xyz');
        expect(result).toBeNull();
    });

    it('returns null for an unrelated path', () => {
        const result = parseOAuth2Callback('http://localhost:7742/auth/callback?code=abc');
        expect(result).toBeNull();
    });

    it('handles a relative URL by prefixing the localhost origin', () => {
        const result = parseOAuth2Callback('/oauth2/callback?code=zzz&state=q');
        expect(result).toEqual({ ok: true, code: 'zzz', state: 'q' });
    });

    it('omits the error description field when not provided', () => {
        const result = parseOAuth2Callback('http://localhost:7742/oauth2/callback?error=invalid_request&state=s');
        expect(result).toEqual({ ok: false, error: 'invalid_request', state: 's' });
    });

    it('returns null on a malformed URL', () => {
        const result = parseOAuth2Callback('not a url');
        expect(result).toBeNull();
    });
});
