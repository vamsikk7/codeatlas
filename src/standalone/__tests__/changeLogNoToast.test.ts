/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * changeLogNoToast.test.ts — spurious daemon-mode toast on L1 load.
 *
 * The webview posts `requestChangeLog` UNCONDITIONALLY on mount (a passive
 * probe for the history panel). In standalone that type sat in the UNAVAILABLE
 * set, so the default handler broadcast a "Feature not yet available in the
 * standalone npm package…" warning toast on every plain L1 load. Passive probes
 * must NOT toast — reply with an empty change log. A genuine user action
 * (`connectGitHub`) still gets the toast.
 */
import { describe, it, expect, vi } from 'vitest';
import { createStandaloneMessageHandler } from '../messageHandler';

function mkDeps() {
    const broadcasts: any[] = [];
    const sent: Array<{ clientId: string; msg: any }> = [];
    return {
        broadcasts, sent,
        wsBridge: {
            broadcast: vi.fn((m: any) => broadcasts.push(m)),
            sendTo: vi.fn((c: string, m: any) => sent.push({ clientId: c, msg: m })),
            hasClients: () => true,
        },
        snapshotStore: { getWorking: () => ({}), getBaseline: () => ({}), getFileContent: () => undefined },
        commentStore: {},
        log: () => {},
        workspaceRoot: '/ws',
        // secrets deliberately undefined — the standalone daemon has no VS Code SecretStorage.
    } as any;
}

const isUnavailableToast = (m: any) =>
    m.type === 'clientToast' && String(m.text ?? '').includes('not yet available in the standalone');

describe('spurious daemon toast on L1 load', () => {
    it('requestChangeLog does NOT toast and replies with an empty change log', async () => {
        const deps = mkDeps();
        const h = createStandaloneMessageHandler(deps);
        await h.handle({ type: 'requestChangeLog' }, 'c1');

        expect(deps.broadcasts.some(isUnavailableToast), 'no "unavailable" toast on passive probe').toBe(false);
        const reply = deps.sent.find(s => s.msg.type === 'changeLogFull');
        expect(reply, 'empty change log delivered so the panel renders instead of waiting').toBeTruthy();
        expect(reply!.msg.entries).toEqual([]);
    });

    it('connectGitHub (a real user action) still shows the unavailable toast', async () => {
        const deps = mkDeps();
        const h = createStandaloneMessageHandler(deps);
        await h.handle({ type: 'connectGitHub' }, 'c1');
        expect(deps.broadcasts.some(isUnavailableToast)).toBe(true);
    });
});
