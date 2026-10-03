/**
 * violationsBroadcaster.test.ts — UX-48 follow-up (2026-06-05).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeAndBroadcastViolations, makeViolationsBroadcaster } from '../violationsBroadcaster';
import type { Snapshot } from '../../graph/graphTypes';

function snapWithApis(count: number, allAuth: boolean): Snapshot {
    const apiIndex: any = {};
    for (let i = 0; i < count; i++) {
        const id = `POST:/x${i}::a.ts::h${i}`;
        apiIndex[id] = {
            apiId: id, method: 'POST', route: `/x${i}`, handlerName: `h${i}`,
            filePath: 'a.ts', anchor: { filePath: 'a.ts' },
            meta: allAuth ? { auth: 'required' as const } : {},
        };
    }
    return {
        files: { 'a.ts': { path: 'a.ts', hash: 'h', mtime: 0, symbols: { functions: [], variables: [], imports: [] } } },
        apiIndex,
        graphs: {},
        clusters: {},
        services: {},
        health: undefined as any,
    } as Snapshot;
}

describe('computeAndBroadcastViolations', () => {
    it('broadcasts when violations exist', () => {
        const broadcast = vi.fn();
        const log = vi.fn();
        const ctx = { lastSignature: null as string | null };
        const snap = snapWithApis(3, false); // 3 POSTs, no auth → 3 violations
        computeAndBroadcastViolations(snap, '/ws', broadcast, log, ctx);
        expect(broadcast).toHaveBeenCalledTimes(1);
        const sent = broadcast.mock.calls[0][0];
        expect(sent.type).toBe('violations');
        expect(sent.violations.length).toBeGreaterThanOrEqual(3);
    });

    it('does NOT re-broadcast when the violation signature is unchanged', () => {
        const broadcast = vi.fn();
        const log = vi.fn();
        const ctx = { lastSignature: null as string | null };
        const snap = snapWithApis(3, false);
        computeAndBroadcastViolations(snap, '/ws', broadcast, log, ctx);
        computeAndBroadcastViolations(snap, '/ws', broadcast, log, ctx);
        expect(broadcast).toHaveBeenCalledTimes(1);
    });

    it('re-broadcasts when the signature changes', () => {
        const broadcast = vi.fn();
        const log = vi.fn();
        const ctx = { lastSignature: null as string | null };
        const snap1 = snapWithApis(3, false);
        const snap2 = snapWithApis(2, false); // fewer violations
        computeAndBroadcastViolations(snap1, '/ws', broadcast, log, ctx);
        computeAndBroadcastViolations(snap2, '/ws', broadcast, log, ctx);
        expect(broadcast).toHaveBeenCalledTimes(2);
    });

    it('broadcasts an empty-violations envelope when the snapshot is clean (so the UI can clear stale badges)', () => {
        const broadcast = vi.fn();
        const log = vi.fn();
        const ctx = { lastSignature: null as string | null };
        const snap = snapWithApis(3, true); // all auth='required'
        computeAndBroadcastViolations(snap, '/ws', broadcast, log, ctx);
        expect(broadcast).toHaveBeenCalledTimes(1);
        const sent = broadcast.mock.calls[0][0];
        // Some other rules (no_god_files etc.) may still fire — only the
        // auth-on-writes count is asserted here.
        const authViolations = sent.violations.filter((v: any) => v.rule === 'auth_required_on_writes');
        expect(authViolations.length).toBe(0);
    });

    it('swallows errors from listArchitectureViolations and never throws into the caller', () => {
        const broadcast = vi.fn();
        const log = vi.fn();
        const ctx = { lastSignature: null as string | null };
        // Pass an invalid snapshot shape — apiIndex missing → rule iteration breaks.
        const broken = {} as Snapshot;
        expect(() => computeAndBroadcastViolations(broken, '/ws', broadcast, log, ctx)).not.toThrow();
    });
});

describe('makeViolationsBroadcaster', () => {
    let registeredCallback: ((graphIds: string[]) => void) | null = null;
    const fakeOrch = {
        onRefresh: (cb: (graphIds: string[]) => void) => { registeredCallback = cb; },
    };
    let getWorkingResult: Snapshot;
    const fakeStore = {
        getWorking: () => getWorkingResult,
    };

    beforeEach(() => {
        registeredCallback = null;
        getWorkingResult = snapWithApis(2, false);
    });

    it('registers a refresh callback on the orchestrator', () => {
        makeViolationsBroadcaster({
            orchestrator: fakeOrch as any,
            store: fakeStore as any,
            broadcast: vi.fn(),
            workspaceRoot: '/ws',
            log: vi.fn(),
        });
        expect(registeredCallback).not.toBeNull();
    });

    it('fires the broadcast when the orchestrator emits a refresh', async () => {
        const broadcast = vi.fn();
        makeViolationsBroadcaster({
            orchestrator: fakeOrch as any,
            store: fakeStore as any,
            broadcast,
            workspaceRoot: '/ws',
            log: vi.fn(),
            debounceMs: 0,
        });
        registeredCallback!(['file:foo']);
        // Allow microtask + setTimeout(0) drain.
        await new Promise((r) => setTimeout(r, 5));
        expect(broadcast).toHaveBeenCalled();
        const sent = broadcast.mock.calls[0][0];
        expect(sent.type).toBe('violations');
    });
});
