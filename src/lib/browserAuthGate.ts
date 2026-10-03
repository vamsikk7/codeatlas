/**
 * Auth gate for the LOCALHOST BROWSER VIEW (VSIX `:7742` + MCP standalone `:7842`
 * share the same webview). Single source of truth used by both handler paths.
 *
 * When the user is SIGNED OUT, only workspace setup (initialize / re-initialize /
 * resync), sign-in/out, theme, and the initial `ready` handshake are allowed.
 * Diagram navigation (any layer), git/compare/branch/PR, and every analysis tool
 * (impact, export, health, AI review, search, timeline replay, NL query, API
 * testing …) are blocked until the user signs in.
 *
 * The stdio MCP tools are NOT gated by this — they never route through the
 * webview message handler.
 */

export const SIGNED_OUT_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
    'codeatlas.initializeWorkspaceVisuals',
    'codeatlas.resyncEverything',
    'codeatlas.rebuildCurrentFile',
    'codeatlas.login',
    'codeatlas.logout',
    'codeatlas.lightMode',
    'codeatlas.darkMode',
]);

/**
 * True if this inbound webview message may be processed while signed out.
 * Everything not explicitly allowed is gated.
 */
export function isAllowedWhenSignedOut(msg: { type?: string; command?: string } | null | undefined): boolean {
    switch (msg?.type) {
        case 'ready':               // the home screen (init/resync/sign-in live here)
            return true;
        case 'requestExplorerData': // sidebar/home data for the home screen
            return true;
        case 'runCommand':          // only the setup + auth + theme commands
            return !!msg.command && SIGNED_OUT_ALLOWED_COMMANDS.has(msg.command);
        default:                    // requestRoute, git, tools, api-testing, … → gated
            return false;
    }
}

/** Minimal shape of a stored Clerk session, as read from either auth service. */
export interface WorkspaceAuthUser {
    userId?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
}

/** The auth-related fields carried on every `workspaceInfo` payload. */
export interface WorkspaceAuthFields {
    isAuthenticated: boolean;
    userEmail?: string;
    userId?: string;
    userFirstName?: string;
    userLastName?: string;
}

/**
 * Single source of truth for the auth fields on a `workspaceInfo` payload,
 * shared by the extension (:7742) and the standalone (:7842) browser views.
 *
 * `isAuthenticated` is DERIVED from the presence of a user — it can never be
 * `true` without an accompanying identity. This is the invariant that keeps the
 * diagram gate (which reads `getUser()`) and the webview chip + gate banner
 * (which read `isAuthenticated`) from ever disagreeing. The extension used to
 * send a module-level flag hardcoded `true` at activation, which reported
 * signed-in while the gate blocked every diagram — routing both surfaces
 * through this function makes that class of drift impossible.
 */
export function workspaceAuthFields(user: WorkspaceAuthUser | null | undefined): WorkspaceAuthFields {
    return {
        isAuthenticated: !!user,
        userEmail: user?.email,
        userId: user?.userId,
        userFirstName: user?.firstName,
        userLastName: user?.lastName,
    };
}
