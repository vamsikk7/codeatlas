import type * as vscode from 'vscode';
import { jwksUrlFromPublishableKey, verifyClerkToken } from './clerkVerify';

export interface StoredSession {
    token: string;
    userId: string;
    email: string;
    firstName?: string;
    lastName?: string;
    verifiedAt: number;
}

export class ClerkAuthService {
    private static readonly SESSION_KEY = 'codeatlas.clerk.session';
    private static readonly VERIFY_INTERVAL_MS = 86_400_000; // 24 h

    private readonly context: vscode.ExtensionContext;
    private readonly jwksUrl: string;
    private logger: ((msg: string) => void) | null = null;

    /**
     * @param publishableKey  Clerk publishable key (pk_live_... or pk_test_...).
     *                        The frontend API host is derived from the key itself.
     */
    constructor(context: vscode.ExtensionContext, publishableKey: string) {
        this.context = context;
        this.jwksUrl = jwksUrlFromPublishableKey(publishableKey);
    }

    setLogger(fn: (msg: string) => void): void {
        this.logger = fn;
    }

    private log(msg: string): void {
        this.logger?.(`[ClerkAuth] ${msg}`);
    }

    /** @deprecated use `jwksUrlFromPublishableKey` from ./clerkVerify. */
    static jwksUrlFromPublishableKey(key: string): string {
        return jwksUrlFromPublishableKey(key);
    }

    /**
     * Check if the current session is valid.
     * Returns true immediately if session was verified < 24 h ago.
     * Otherwise re-verifies against Clerk's JWKS endpoint.
     */
    async checkAuth(): Promise<boolean> {
        const session = this.context.globalState.get<StoredSession>(ClerkAuthService.SESSION_KEY);
        if (!session) return false;

        const age = Date.now() - session.verifiedAt;
        if (age < ClerkAuthService.VERIFY_INTERVAL_MS) {
            return true;
        }

        const err = await this.verifyToken(session.token);
        if (err === null) {
            await this.context.globalState.update(ClerkAuthService.SESSION_KEY, {
                ...session,
                verifiedAt: Date.now(),
            });
        } else {
            await this.context.globalState.update(ClerkAuthService.SESSION_KEY, undefined);
        }
        return err === null;
    }

    storeSession(token: string, userId: string, email: string, firstName?: string, lastName?: string): void {
        const session: StoredSession = { token, userId, email, firstName, lastName, verifiedAt: Date.now() };
        this.context.globalState.update(ClerkAuthService.SESSION_KEY, session);
    }

    getUser(): StoredSession | null {
        return this.context.globalState.get<StoredSession>(ClerkAuthService.SESSION_KEY) ?? null;
    }

    clearSession(): void {
        this.context.globalState.update(ClerkAuthService.SESSION_KEY, undefined);
    }

    /**
     * Verify a JWT against Clerk's JWKS endpoint (RS256). Returns null on
     * success or an error string. Delegates to the shared `verifyClerkToken`.
     */
    async verifyToken(token: string): Promise<string | null> {
        return verifyClerkToken(token, this.jwksUrl, (m) => this.log(m));
    }

    /**
     * Start a periodic check every 24 h.
     * Calls onExpired() if the token can no longer be verified.
     */
    startPeriodicCheck(onExpired: () => void): ReturnType<typeof setInterval> {
        return setInterval(async () => {
            const ok = await this.checkAuth();
            if (!ok) onExpired();
        }, ClerkAuthService.VERIFY_INTERVAL_MS);
    }
}
