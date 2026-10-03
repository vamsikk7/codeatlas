import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { StoredSession } from '../auth/clerkAuthService';
import { jwksUrlFromPublishableKey, verifyClerkToken } from '../auth/clerkVerify';

const SESSION_FILE = path.join(os.homedir(), '.codeatlas', 'session.json');
const VERIFY_INTERVAL_MS = 86_400_000; // 24h — re-verify cache, mirrors the extension.

export interface AuthCallbackPayload {
    token?: string;
    userId?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
}

/**
 * Clerk auth for the standalone `@codeatlas/mcp` browser server. Mirrors the VS
 * Code `ClerkAuthService` but persists the session to `~/.codeatlas/session.json`
 * (0600) instead of VS Code `globalState`, and shares the verify path via
 * `../auth/clerkVerify`. Wired into the standalone WsBridge's `onAuthCallback`.
 */
export class StandaloneClerkAuth {
    private readonly jwksUrl: string;
    private cached: StoredSession | null | undefined;

    constructor(publishableKey: string, private readonly log?: (msg: string) => void) {
        this.jwksUrl = jwksUrlFromPublishableKey(publishableKey);
    }

    private read(): StoredSession | null {
        if (this.cached !== undefined) return this.cached;
        try {
            const parsed = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
            // Shape-validate so a malformed/hand-crafted file (e.g. `{}`) can't
            // masquerade as a signed-in session.
            this.cached = (parsed && typeof parsed.token === 'string' && typeof parsed.userId === 'string')
                ? parsed as StoredSession
                : null;
        } catch {
            this.cached = null;
        }
        return this.cached;
    }

    private write(session: StoredSession | null): void {
        this.cached = session;
        try {
            fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
            if (session) {
                // Write to a temp file, tighten perms, then rename — atomic, and
                // `chmod` enforces 0600 even when the destination already existed
                // with looser perms (writeFileSync's mode only applies on create).
                const tmp = `${SESSION_FILE}.${process.pid}.tmp`;
                fs.writeFileSync(tmp, JSON.stringify(session), { mode: 0o600 });
                fs.chmodSync(tmp, 0o600);
                fs.renameSync(tmp, SESSION_FILE);
            } else {
                fs.rmSync(SESSION_FILE, { force: true });
            }
        } catch (err: any) {
            this.log?.(`[clerkAuth] persist failed: ${err?.message ?? err}`);
        }
    }

    getUser(): StoredSession | null {
        return this.read();
    }

    clearSession(): void {
        this.write(null);
    }

    /** True if a stored session is present and (re)verifies; refreshes verifiedAt. */
    async checkAuth(): Promise<boolean> {
        const s = this.read();
        if (!s) return false;
        if (Date.now() - s.verifiedAt < VERIFY_INTERVAL_MS) return true;
        const err = await verifyClerkToken(s.token, this.jwksUrl, this.log);
        if (err === null) {
            this.write({ ...s, verifiedAt: Date.now() });
            return true;
        }
        this.write(null);
        return false;
    }

    /**
     * Handle the dashboard's `/auth/callback` (browser mode): verify the token,
     * then persist the session. Returns true on success so the WsBridge redirects
     * the tab home.
     */
    async handleAuthCallback(payload: AuthCallbackPayload): Promise<boolean> {
        if (!payload.token || !payload.userId) {
            this.log?.('[clerkAuth] callback missing token/userId');
            return false;
        }
        const err = await verifyClerkToken(payload.token, this.jwksUrl, this.log);
        if (err !== null) {
            this.log?.(`[clerkAuth] callback verify failed: ${err}`);
            return false;
        }
        this.write({
            token: payload.token,
            userId: payload.userId,
            email: payload.email ?? '',
            firstName: payload.firstName,
            lastName: payload.lastName,
            verifiedAt: Date.now(),
        });
        this.log?.(`[clerkAuth] signed in as ${payload.email ?? payload.userId}`);
        return true;
    }
}
