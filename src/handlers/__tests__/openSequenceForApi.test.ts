/**
 * openSequenceForApi.test.ts — Issues 405 + 406 (2026-05-12)
 *
 * Issue 405: live verification revealed clicks on L2b API list rows
 * (`openSequenceForApi`) silently fail with "API <id> not found." even
 * though the apiId is present in the apis table. Root cause analysis
 * pointed at the `Object.values(apiIndex).find((a) => a.apiId === id)`
 * lookup at navigationHandlers.ts:852; the bug only repros against a
 * live extension whose in-memory apiIndex is intact, but the lookup
 * also fails when records use a different key than `.apiId`. A
 * direct-key lookup (`apiIndex[id]`) is O(1) and matches the
 * record-store contract.
 *
 * Issue 406: navigationHandlers.ts:866-867 emits the same
 * `notifyBrowser('warning', ...)` twice. Cosmetic but confusing.
 *
 * These tests pin both fixes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
    window: {
        showWarningMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
    },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    commands: { executeCommand: vi.fn() },
    env: {
        machineId: 'test-machine',
        sessionId: 'test-session',
        appName: 'Visual Studio Code',
        uriScheme: 'vscode',
    },
    version: '1.0.0',
}));

import { makeHarness } from './handlerHarness';
import { registerNavigationHandlers } from '../navigationHandlers';
import type { ApiRecord, DiagramGraph } from '../../core/graph/graphTypes';

function setupHandlers() {
    const h = makeHarness();
    const handlers = new Map<string, (msg: any, panelId: string) => any>();
    const register = (type: string, fn: any) => { handlers.set(type, fn); };
    registerNavigationHandlers(register as any, h.ctx);
    return {
        h,
        dispatch(type: string, message: any = {}, panelId = 'test-panel') {
            const fn = handlers.get(type);
            if (!fn) throw new Error(`No handler registered for ${type}`);
            return fn(message, panelId);
        },
    };
}

function makeApi(apiId: string, route: string, handlerName: string, filePath: string): ApiRecord {
    return {
        apiId,
        method: 'GET',
        route,
        handlerName,
        filePath,
        kind: 'route',
    } as ApiRecord;
}

function makeSequenceGraph(graphId: string): DiagramGraph {
    return {
        graphId,
        type: 'sequence',
        nodes: [],
        edges: [],
        anchors: {},
    } as DiagramGraph;
}

describe('openSequenceForApi — Issues 405 + 406', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('finds an api whose record.apiId matches the key — calls navigatePanel', () => {
        const { h, dispatch } = setupHandlers();
        const apiId = 'GET:/user::src/controller.ts::anonymous@GET:/user';
        h.state.working.apiIndex[apiId] = makeApi(apiId, '/user', 'anonymous@GET:/user', 'src/controller.ts');
        h.state.working.graphs['sequence:src/controller.ts:anonymous@GET:/user'] =
            makeSequenceGraph('sequence:src/controller.ts:anonymous@GET:/user');

        dispatch('openSequenceForApi', { apiId, newWindow: false });

        expect(h.ctx.panelManager.navigatePanel).toHaveBeenCalledTimes(1);
        const navCall = (h.ctx.panelManager.navigatePanel as any).mock.calls[0];
        expect(navCall[1]).toBe('sequence:src/controller.ts:anonymous@GET:/user');
        expect(navCall[2]).toBe('sequence');
        expect(navCall[4]).toBe('GET /user');
        // No "not found" warning emitted on success.
        const warnings = h.broadcasted.filter(
            (b) => b.message?.type === 'showNotification' && b.message?.level === 'warning'
        );
        expect(warnings).toHaveLength(0);
    });

    it('Issue 406: emits exactly ONE notifyBrowser warning when apiIndex is empty (no duplicates)', () => {
        const { h, dispatch } = setupHandlers();
        const missingId = 'GET:/missing::src/x.ts::anonymous@GET:/missing';

        dispatch('openSequenceForApi', { apiId: missingId, newWindow: false });

        const warnings = h.broadcasted.filter(
            (b) => b.message?.type === 'showNotification' && b.message?.level === 'warning'
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message.message).toContain(missingId);
        expect(h.ctx.panelManager.navigatePanel).not.toHaveBeenCalled();
    });

    it('Issue 405: defensive direct-key lookup wins even if Object.values iteration is empty', () => {
        // Simulates the live-verification symptom: apiIndex has the entry
        // under the message.apiId key but Object.values returns an empty
        // array (eg. the index is a stale proxy / has prototype-only props).
        // Direct key lookup `apiIndex[message.apiId]` must succeed.
        const { h, dispatch } = setupHandlers();
        const apiId = 'GET:/user::src/controller.ts::anonymous@GET:/user';
        const api = makeApi(apiId, '/user', 'anonymous@GET:/user', 'src/controller.ts');

        // Replace the apiIndex with one whose Object.values returns empty
        // but direct-key still works (matches the "live state mismatch"
        // pattern the original lookup couldn't survive).
        const sneakyIndex = Object.create(null) as Record<string, ApiRecord>;
        Object.defineProperty(sneakyIndex, apiId, {
            value: api,
            enumerable: false, // hides from Object.values / Object.entries
        });
        // Sanity: the new behaviour relies on direct key access, not iteration.
        expect(Object.values(sneakyIndex)).toEqual([]);
        expect(sneakyIndex[apiId]).toBe(api);

        h.state.working.apiIndex = sneakyIndex;
        h.state.working.graphs['sequence:src/controller.ts:anonymous@GET:/user'] =
            makeSequenceGraph('sequence:src/controller.ts:anonymous@GET:/user');

        dispatch('openSequenceForApi', { apiId, newWindow: false });

        expect(h.ctx.panelManager.navigatePanel).toHaveBeenCalledTimes(1);
        // Still no "not found" warning.
        const warnings = h.broadcasted.filter(
            (b) => b.message?.type === 'showNotification' && b.message?.level === 'warning'
        );
        expect(warnings).toHaveLength(0);
    });

    // #839 (2026-06-11, live walkthrough build 116) — clicking an IaC route
    // whose handler has NO sequence graph AND no flow graph navigated the
    // panel with `graph: undefined`, leaving the SPA on "Loading…" forever.
    // The handler must fall back to the L4 file diagram (always built for
    // the handler's file) with a toast, and NEVER navigate undefined.
    describe('#839 — no sequence + no flow', () => {
        it('falls back to the L4 file diagram with fallbackFromSequence meta + info toast', async () => {
            const { h, dispatch } = setupHandlers();
            const apiId = 'POST:/items::dotnet/src/CreateItemFunction.cs::create';
            h.state.working.apiIndex[apiId] = makeApi(apiId, '/items', 'create', 'dotnet/src/CreateItemFunction.cs');
            // No sequence graph, no flow graph — only the file graph exists.
            const fileGraph = {
                graphId: 'file:dotnet/src/CreateItemFunction.cs',
                type: 'file',
                nodes: [{ id: 'root', type: 'file', label: 'CreateItemFunction.cs' }],
                edges: [], anchors: {},
            } as any;
            h.state.working.graphs['file:dotnet/src/CreateItemFunction.cs'] = fileGraph;

            await dispatch('openSequenceForApi', { apiId, newWindow: false });

            expect(h.ctx.panelManager.navigatePanel).toHaveBeenCalledTimes(1);
            const navCall = (h.ctx.panelManager.navigatePanel as any).mock.calls[0];
            expect(navCall[1]).toBe('file:dotnet/src/CreateItemFunction.cs');
            expect(navCall[2]).toBe('file');
            expect(navCall[3].meta?.fallbackFromSequence).toBe(true);
            // One toast explaining the fallback (info or warning — not silent).
            const toasts = h.broadcasted.filter((b) => b.message?.type === 'showNotification');
            expect(toasts.length).toBeGreaterThanOrEqual(1);
        });

        it('never navigates with an undefined graph when no fallback exists — warns instead', async () => {
            const { h, dispatch } = setupHandlers();
            const apiId = 'POST:/items::dotnet/src/CreateItemFunction.cs::create';
            h.state.working.apiIndex[apiId] = makeApi(apiId, '/items', 'create', 'dotnet/src/CreateItemFunction.cs');
            // Nothing renderable at all.

            await dispatch('openSequenceForApi', { apiId, newWindow: false });

            expect(h.ctx.panelManager.navigatePanel).not.toHaveBeenCalled();
            expect(h.ctx.panelManager.openPanel).not.toHaveBeenCalled();
            const warnings = h.broadcasted.filter(
                (b) => b.message?.type === 'showNotification' && b.message?.level === 'warning'
            );
            expect(warnings.length).toBeGreaterThanOrEqual(1);
        });
    });
});
