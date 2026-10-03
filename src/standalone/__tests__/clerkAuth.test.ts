/**
 * clerkAuth.test.ts — StandaloneClerkAuth file-session persistence + the
 * hardening added alongside it: session shape-validation (a malformed file must
 * not read as signed-in), 0600 perms on the session file, and verify-before-store
 * on the /auth/callback path. `os.homedir()` is redirected to a tmpdir and the
 * shared verify is mocked so no network/JWKS fetch happens.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { TMP_HOME } = vi.hoisted(() => {
    const os = require('os') as typeof import('os');
    const nodeFs = require('fs') as typeof import('fs');
    const nodePath = require('path') as typeof import('path');
    return { TMP_HOME: nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'ca-clerkauth-')) };
});

vi.mock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>();
    return { ...actual, homedir: () => TMP_HOME };
});

const verifyClerkToken = vi.fn(async () => null as string | null);
vi.mock('../../auth/clerkVerify', () => ({
    jwksUrlFromPublishableKey: () => 'https://example.test/.well-known/jwks.json',
    verifyClerkToken: (...args: unknown[]) => verifyClerkToken(...(args as [])),
}));

// Imported after the mocks are registered (vi.mock is hoisted).
import { StandaloneClerkAuth } from '../clerkAuth';

const SESSION_FILE = path.join(TMP_HOME, '.codeatlas', 'session.json');
const PK = 'pk_test_ZXhhbXBsZS50ZXN0JA=='; // example.test$

function newAuth() {
    return new StandaloneClerkAuth(PK);
}

describe('StandaloneClerkAuth', () => {
    beforeEach(() => {
        verifyClerkToken.mockReset();
        verifyClerkToken.mockResolvedValue(null); // default: token verifies
        fs.rmSync(SESSION_FILE, { force: true });
    });
    afterAll(() => {
        fs.rmSync(TMP_HOME, { recursive: true, force: true });
    });

    it('returns no user when no session file exists', () => {
        expect(newAuth().getUser()).toBeNull();
    });

    it('handleAuthCallback verifies, then persists a signed-in session (0600)', async () => {
        const auth = newAuth();
        const ok = await auth.handleAuthCallback({
            token: 'a.b.c', userId: 'user_1', email: 'x@y.z', firstName: 'X',
        });
        expect(ok).toBe(true);
        expect(verifyClerkToken).toHaveBeenCalledOnce();
        expect(auth.getUser()).toMatchObject({ userId: 'user_1', email: 'x@y.z', firstName: 'X' });
        // A fresh instance reads the persisted file back.
        expect(newAuth().getUser()?.userId).toBe('user_1');
        // Session file is owner-read/write only.
        expect(fs.statSync(SESSION_FILE).mode & 0o777).toBe(0o600);
    });

    it('rejects a callback with a missing token/userId without writing a file', async () => {
        const auth = newAuth();
        expect(await auth.handleAuthCallback({ userId: 'user_1' })).toBe(false);
        expect(await auth.handleAuthCallback({ token: 'a.b.c' })).toBe(false);
        expect(verifyClerkToken).not.toHaveBeenCalled();
        expect(fs.existsSync(SESSION_FILE)).toBe(false);
    });

    it('does not store the session when the token fails verification', async () => {
        verifyClerkToken.mockResolvedValue('Token signature is invalid');
        const auth = newAuth();
        expect(await auth.handleAuthCallback({ token: 'a.b.c', userId: 'user_1', email: 'x@y.z' })).toBe(false);
        expect(auth.getUser()).toBeNull();
        expect(fs.existsSync(SESSION_FILE)).toBe(false);
    });

    it('shape-validates: a malformed session file does not read as signed-in', () => {
        fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
        fs.writeFileSync(SESSION_FILE, JSON.stringify({})); // no token/userId
        expect(newAuth().getUser()).toBeNull();
    });

    it('clearSession removes the persisted session', async () => {
        const auth = newAuth();
        await auth.handleAuthCallback({ token: 'a.b.c', userId: 'user_1', email: 'x@y.z' });
        expect(fs.existsSync(SESSION_FILE)).toBe(true);
        auth.clearSession();
        expect(auth.getUser()).toBeNull();
        expect(fs.existsSync(SESSION_FILE)).toBe(false);
    });

    it('checkAuth clears a session whose token no longer verifies past the cache', async () => {
        // Seed a session with a stale verifiedAt so checkAuth re-verifies.
        fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
        fs.writeFileSync(SESSION_FILE, JSON.stringify({
            token: 'a.b.c', userId: 'user_1', email: 'x@y.z', verifiedAt: 0,
        }));
        verifyClerkToken.mockResolvedValue('Session token expired');
        const auth = newAuth();
        expect(await auth.checkAuth()).toBe(false);
        expect(auth.getUser()).toBeNull();
    });
});
