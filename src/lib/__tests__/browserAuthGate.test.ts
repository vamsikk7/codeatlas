import { describe, it, expect } from 'vitest';
import { isAllowedWhenSignedOut, SIGNED_OUT_ALLOWED_COMMANDS, workspaceAuthFields } from '../browserAuthGate';

describe('browserAuthGate — isAllowedWhenSignedOut', () => {
    it('allows the connection handshake + sidebar data', () => {
        expect(isAllowedWhenSignedOut({ type: 'ready' })).toBe(true);
        expect(isAllowedWhenSignedOut({ type: 'requestExplorerData' })).toBe(true);
    });

    it('allows ONLY the setup + auth + theme commands', () => {
        for (const cmd of ['codeatlas.initializeWorkspaceVisuals', 'codeatlas.resyncEverything', 'codeatlas.rebuildCurrentFile', 'codeatlas.login', 'codeatlas.logout', 'codeatlas.lightMode', 'codeatlas.darkMode']) {
            expect(isAllowedWhenSignedOut({ type: 'runCommand', command: cmd }), cmd).toBe(true);
            expect(SIGNED_OUT_ALLOWED_COMMANDS.has(cmd)).toBe(true);
        }
    });

    it('GATES diagram navigation while signed out', () => {
        expect(isAllowedWhenSignedOut({ type: 'requestRoute' })).toBe(false);
        expect(isAllowedWhenSignedOut({ type: 'openMicroserviceDiagram' })).toBe(false);
        expect(isAllowedWhenSignedOut({ type: 'openMapDiagram' })).toBe(false);
        expect(isAllowedWhenSignedOut({ type: 'openDomainDiagram' })).toBe(false);
        expect(isAllowedWhenSignedOut({ type: 'requestTour' })).toBe(false);
    });

    it('GATES git + tool + api-testing commands while signed out', () => {
        for (const cmd of ['codeatlas.analyzeImpact', 'codeatlas.showHealthReport', 'codeatlas.exportArchitectureDocs', 'codeatlas.timelineReplay', 'codeatlas.search', 'codeatlas.openApiExplorer', 'codeatlas.openGitDiff', 'codeatlas.loadCoverage']) {
            expect(isAllowedWhenSignedOut({ type: 'runCommand', command: cmd }), cmd).toBe(false);
        }
        expect(isAllowedWhenSignedOut({ type: 'replayWorkingDiff' })).toBe(false);
        expect(isAllowedWhenSignedOut({ type: 'sendRequest' })).toBe(false);
        expect(isAllowedWhenSignedOut({ type: 'runChain' })).toBe(false);
    });

    it('gates unknown / malformed messages', () => {
        expect(isAllowedWhenSignedOut({} as never)).toBe(false);
        expect(isAllowedWhenSignedOut(null)).toBe(false);
        expect(isAllowedWhenSignedOut({ type: 'runCommand' })).toBe(false); // no command
    });
});

describe('browserAuthGate — workspaceAuthFields (chip/gate ⟺ getUser invariant)', () => {
    // Regression guard for the VSIX bug where workspaceInfo sent a hardcoded
    // isAuthenticated:true (activation flag) while the diagram gate read
    // getUser()===null — the browser view showed a "Signed in" chip + enabled
    // cards while every diagram was blocked. Both surfaces now derive their
    // auth fields here, so `isAuthenticated` can never be true without a user.

    it('signed out (null/undefined user) → isAuthenticated false, NO identity fields', () => {
        for (const u of [null, undefined]) {
            const f = workspaceAuthFields(u);
            expect(f.isAuthenticated).toBe(false);
            expect(f.userEmail).toBeUndefined();
            expect(f.userId).toBeUndefined();
            expect(f.userFirstName).toBeUndefined();
            expect(f.userLastName).toBeUndefined();
        }
    });

    it('signed in → isAuthenticated true, identity carried through', () => {
        const f = workspaceAuthFields({ userId: 'user_123', email: 'a@b.com', firstName: 'Ada', lastName: 'Lovelace' });
        expect(f.isAuthenticated).toBe(true);
        expect(f.userId).toBe('user_123');
        expect(f.userEmail).toBe('a@b.com');
        expect(f.userFirstName).toBe('Ada');
        expect(f.userLastName).toBe('Lovelace');
    });

    it('INVARIANT: isAuthenticated is true iff an identity is present', () => {
        // The exact contradiction the bug produced (authenticated with no user)
        // is unrepresentable through this function.
        expect(workspaceAuthFields({ userId: 'u1' }).isAuthenticated).toBe(true);
        expect(workspaceAuthFields(null).isAuthenticated).toBe(false);
        const signedIn = workspaceAuthFields({ userId: 'u1', email: 'e@x.io' });
        expect(signedIn.isAuthenticated).toBe(!!signedIn.userId);
        const signedOut = workspaceAuthFields(null);
        expect(signedOut.isAuthenticated).toBe(!!signedOut.userId);
    });
});
