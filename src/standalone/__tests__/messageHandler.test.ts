/**
 * messageHandler.test.ts — pins the standalone WS message contract.
 *
 * INVARIANT: every `requestRoute` for an existing graphId in the snapshot
 * results in a single `navigateTo` broadcast carrying the graph payload.
 * Missing graphs broadcast a `clientToast` warning, never throw.
 *
 * INVARIANT: every message type listed as "unavailable in v1" produces a
 * `clientToast` (visible to the user) instead of being silently dropped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStandaloneMessageHandler } from '../messageHandler';
import type { SnapshotStore } from '../../core/storage/snapshotStore';
import type { CommentStore } from '../../core/storage/commentStore';
import type { WsBridge } from '../../server/wsBridge';

function mkDeps() {
    const broadcasts: any[] = [];
    const sent: any[] = [];
    const wsBridge = {
        broadcast: vi.fn((msg) => broadcasts.push(msg)),
        // Capture per-client sends into BOTH `sent` (for gate assertions) and
        // `broadcasts` (so existing tests that treat `broadcasts` as the full
        // outbound stream still see navigateTo/toast that route via sendTo).
        sendTo: vi.fn((_clientId: string, msg) => { sent.push(msg); broadcasts.push(msg); }),
        // #547: the shared platform adapter gates broadcasts on hasClients()
        // so the production server doesn't spam an empty bridge. Tests want
        // every broadcast captured regardless.
        hasClients: () => true,
    } as unknown as WsBridge;

    const fakeSnapshot: any = {
        files: { 'src/a.ts': {} },
        apiIndex: { 'GET:/users': { method: 'GET', route: '/users', filePath: 'src/a.ts' } },
        clusters: { 'cluster:auth': { id: 'cluster:auth', label: 'auth', files: ['src/auth.ts'], apisInCluster: [] } },
        graphs: {
            'microservice:workspace': {
                graphId: 'microservice:workspace', type: 'microservice',
                nodes: [{ id: 's1', type: 'service', label: 'main' }],
                edges: [], anchors: {}, meta: {},
            },
            'file:src/a.ts': {
                graphId: 'file:src/a.ts', type: 'file',
                nodes: [{ id: 'f1', type: 'file', label: 'a.ts' }],
                edges: [], anchors: {}, meta: {},
            },
        },
    };
    const snapshotStore = {
        getWorking: () => fakeSnapshot,
        getBaseline: () => fakeSnapshot, // mirror — tests that hit baseline-vs-working don't care about diff content
    } as unknown as SnapshotStore;

    const resolvedComments: string[] = [];
    const commentStore = {
        resolve: vi.fn((id: string) => { resolvedComments.push(id); return true; }),
    } as unknown as CommentStore;

    return { broadcasts, sent, wsBridge, snapshotStore, commentStore, resolvedComments };
}

describe('standaloneMessageHandler — ready handshake', () => {
    it('emits capabilities + initial navigateTo on `ready`', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'ready' }, 'client-1');

        const cap = d.broadcasts.find(m => m.type === 'capabilities');
        expect(cap, 'capabilities must be sent on ready').toBeTruthy();
        expect(cap.capabilities.canSignIn, 'no auth service wired in this harness → canSignIn false').toBe(false);
        expect(cap.capabilities.canEditCode).toBe(true);
        expect(cap.capabilities.canComment).toBe(true);
        expect(cap.capabilities.mode).toBe('standalone');
        // #910 — this harness has no settings/secrets, so `hasLlm` is false.
        // Search must still be advertised: it's a snapshot index walk, not LLM.
        expect(cap.capabilities.canAiReview, 'no-LLM harness → AI review off').toBe(false);
        expect(cap.capabilities.canSearch, '#910 — search must NOT be gated on LLM').toBe(true);

        // BUG-VERIFY-4 — `ready` must NOT broadcast an initial navigateTo. The
        // SPA is hash-routed and drives navigation itself; an unsolicited
        // initial `microservice:workspace` push raced deep-link loads (a
        // `#/features` refresh bounced to System Design). The client posts its
        // own requestRoute for its hash.
        const nav = d.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav, 'ready must NOT push an initial graph — the SPA drives nav via hash routing').toBeUndefined();
    });

    // Auth model (2026-08): the standalone browser view supports Clerk sign-in
    // when an auth service is wired. Login is NEVER a pre-step for features —
    // diagrams work signed-out — it only advertises canSignIn + surfaces the
    // signed-in user's chip via workspaceInfo.
    it('advertises canSignIn + surfaces the signed-in user when an auth service is wired', async () => {
        const d = mkDeps();
        const fakeAuth = {
            getUser: () => ({ userId: 'user_1', email: 'ada@x.dev', firstName: 'Ada', lastName: 'L', verifiedAt: Date.now() }),
            checkAuth: async () => true,
            clearSession: vi.fn(),
            handleAuthCallback: async () => true,
        };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            auth: fakeAuth as any,
        });
        await h.handle({ type: 'ready' }, 'client-1');

        const cap = d.broadcasts.find(m => m.type === 'capabilities');
        expect(cap.capabilities.canSignIn, 'auth wired → sign-in available').toBe(true);
        const wsInfo = d.broadcasts.find(m => m.type === 'workspaceInfo');
        expect(wsInfo.isAuthenticated).toBe(true);
        expect(wsInfo.userEmail).toBe('ada@x.dev');
        expect(wsInfo.userFirstName).toBe('Ada');
    });

    it('codeatlas.logout clears the session and re-broadcasts a signed-out workspaceInfo', async () => {
        const d = mkDeps();
        let user: { userId: string; email: string; verifiedAt: number } | null = { userId: 'u1', email: 'a@b.co', verifiedAt: Date.now() };
        const fakeAuth = {
            getUser: () => user,
            checkAuth: async () => true,
            clearSession: vi.fn(() => { user = null; }),
            handleAuthCallback: async () => true,
        };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            auth: fakeAuth as any,
        });
        await h.handle({ type: 'runCommand', command: 'codeatlas.logout' }, 'client-1');

        expect(fakeAuth.clearSession).toHaveBeenCalled();
        const wsInfos = d.broadcasts.filter(m => m.type === 'workspaceInfo');
        expect(wsInfos.at(-1)?.isAuthenticated, 'chip flips to signed-out after logout').toBe(false);
    });

    // Auth gate — signed-out browser users may only init / re-sync; diagram / git
    // / tool messages are refused authoritatively with `signInRequired`.
    describe('auth gate (browser view)', () => {
        const signedOutAuth = () => ({ getUser: () => null, checkAuth: async () => false, clearSession: vi.fn(), handleAuthCallback: async () => false });
        const signedInAuth = () => ({ getUser: () => ({ userId: 'u1', email: 'a@b.co', verifiedAt: Date.now() }), checkAuth: async () => true, clearSession: vi.fn(), handleAuthCallback: async () => true });
        const withAuth = (d: ReturnType<typeof mkDeps>, auth: unknown) => createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {}, auth: auth as never,
        });

        it('BLOCKS a diagram requestRoute while signed out (signInRequired, no navigateTo)', async () => {
            const d = mkDeps();
            await withAuth(d, signedOutAuth()).handle({ type: 'requestRoute', graphId: 'file:src/a.ts' }, 'c1');
            expect(d.broadcasts.find(m => m.type === 'navigateTo'), 'diagram must NOT load signed out').toBeUndefined();
            expect(d.sent.find(m => m.type === 'signInRequired'), 'signInRequired sent').toBeTruthy();
        });

        it('BLOCKS a gated tool command while signed out', async () => {
            const d = mkDeps();
            await withAuth(d, signedOutAuth()).handle({ type: 'runCommand', command: 'codeatlas.analyzeImpact' }, 'c1');
            expect(d.sent.find(m => m.type === 'signInRequired')).toBeTruthy();
        });

        it('ALLOWS resync while signed out (no signInRequired)', async () => {
            const d = mkDeps();
            await withAuth(d, signedOutAuth()).handle({ type: 'runCommand', command: 'codeatlas.resyncEverything' }, 'c1');
            expect(d.sent.find(m => m.type === 'signInRequired'), 'resync allowed signed-out').toBeUndefined();
        });

        it('does NOT gate when signed IN — diagram loads', async () => {
            const d = mkDeps();
            await withAuth(d, signedInAuth()).handle({ type: 'requestRoute', graphId: 'file:src/a.ts' }, 'c1');
            expect(d.sent.find(m => m.type === 'signInRequired'), 'no gate when signed in').toBeUndefined();
            expect(d.broadcasts.find(m => m.type === 'navigateTo'), 'diagram loads when signed in').toBeTruthy();
        });

        it('does NOT gate when NO auth service is wired (legacy/test harness)', async () => {
            const d = mkDeps();
            const h = createStandaloneMessageHandler({
                snapshotStore: d.snapshotStore, commentStore: d.commentStore,
                wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            });
            await h.handle({ type: 'requestRoute', graphId: 'file:src/a.ts' }, 'c1');
            expect(d.sent.find(m => m.type === 'signInRequired')).toBeUndefined();
        });
    });
});

describe('#910 — global search palette works standalone (no LLM)', () => {
    it('runCommand codeatlas.search broadcasts showSearchPicker with snapshot entities', async () => {
        const d = mkDeps(); // no settings/secrets → non-LLM standalone
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'runCommand', command: 'codeatlas.search' }, 'c1');
        const picker = d.broadcasts.find((m: any) => m.type === 'showSearchPicker');
        expect(picker, 'toolbar 🔍 must open the cross-surface palette, not route to L2b').toBeTruthy();
        expect(Array.isArray(picker.items)).toBe(true);
        // The fake snapshot has 1 api + 1 file + 1 cluster → ≥3 searchable items.
        expect(picker.items.length).toBeGreaterThanOrEqual(3);
        const kinds = new Set(picker.items.map((i: any) => i.kind));
        expect(kinds.has('API')).toBe(true);
        expect(kinds.has('File')).toBe(true);
        expect(kinds.has('Cluster')).toBe(true);
        // It must NOT have navigated to an api-list graph (the old dead behavior).
        const nav = d.broadcasts.find((m: any) => m.type === 'navigateTo' && String(m.graphId).startsWith('api-list:'));
        expect(nav, 'must not fall back to routing into an L2b cluster').toBeFalsy();
    });
});

describe('TICKET-UI-1 — "APIs" toolbar shows the WHOLE workspace, not one near-empty cluster', () => {
    function deps() {
        const d = mkDeps();
        const apiIndex: any = {};
        // 26 endpoints spread across clusters — the old code landed on whichever
        // single-endpoint `cluster:src` bucket came first (1 of 26).
        for (let i = 0; i < 26; i++) apiIndex[`a${i}`] = { apiId: `a${i}`, method: 'GET', route: `/r${i}`, filePath: `src/f${i % 3}.ts` };
        const snap: any = {
            files: {}, apiIndex, clusters: {},
            graphs: {
                // A near-empty per-cluster api-list still present in the store; the
                // toolbar must NOT land here.
                'api-list:cluster:src': { graphId: 'api-list:cluster:src', type: 'api-list', nodes: [], edges: [], anchors: {}, meta: { clusterId: 'cluster:src', apis: [apiIndex.a0] } },
            },
        };
        (d.snapshotStore as any).getWorking = () => snap;
        (d.snapshotStore as any).getBaseline = () => snap;
        return d;
    }

    it('openApiExplorer navigates to the synthetic api-list:workspace with every endpoint', async () => {
        const d = deps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'runCommand', command: 'codeatlas.openApiExplorer' }, 'c1');
        const nav = d.broadcasts.find((m: any) => m.type === 'navigateTo' && String(m.graphId).startsWith('api-list:'));
        expect(nav, 'must navigate to an api-list').toBeTruthy();
        expect(nav.graphId, 'workspace-wide list, not the incidental src cluster').toBe('api-list:workspace');
        expect(nav.graph.meta.apis.length, 'shows ALL 26 endpoints, not 1').toBe(26);
    });
});

describe('TICKET-UI-3 — L3 sequence message click drills to L5 flow (qname↔bare)', () => {
    function deps() {
        const d = mkDeps();
        const snap: any = {
            files: {}, apiIndex: {}, clusters: {},
            graphs: {
                // Stored flow graph is keyed by the BARE method name...
                'flow:src/article/article.service.ts:findComments': {
                    graphId: 'flow:src/article/article.service.ts:findComments', type: 'flow',
                    nodes: [{ id: 'n1', type: 'statement', label: 'start' }], edges: [], anchors: {}, meta: {},
                },
            },
        };
        (d.snapshotStore as any).getWorking = () => snap;
        (d.snapshotStore as any).getBaseline = () => snap;
        return d;
    }

    it('navigates to the flow graph when the edge anchor carries the CLASS-QUALIFIED symbol', async () => {
        const d = deps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        // ...but the sequence-edge anchor carries the qualified name.
        await h.handle({ type: 'edgeClicked', edgeId: 'edge_5', anchor: { filePath: 'src/article/article.service.ts', symbol: 'ArticleService.findComments' } }, 'c1');
        const nav = d.broadcasts.find((m: any) => m.type === 'navigateTo' && String(m.graphId).startsWith('flow:'));
        expect(nav, 'qname anchor must still resolve to the bare-keyed flow graph').toBeTruthy();
        expect(nav.graphId).toBe('flow:src/article/article.service.ts:findComments');
        expect(nav.mode).toBe('flow');
    });
});

describe('standaloneMessageHandler — requestRoute', () => {
    it('broadcasts navigateTo for an existing graphId', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'requestRoute', graphId: 'file:src/a.ts' }, 'client-1');
        const nav = d.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav).toBeTruthy();
        expect(nav.graphId).toBe('file:src/a.ts');
        expect(nav.mode).toBe('file');
        expect(nav.graph).toBeTruthy();
    });

    it('broadcasts a toast for a missing graphId — never throws', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'requestRoute', graphId: 'file:does-not-exist' }, 'client-1');
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast).toBeTruthy();
        expect(toast.level).toBe('warning');
        expect(d.broadcasts.find(m => m.type === 'navigateTo')).toBeFalsy();
    });

    // Issue UX-4 (2026-06-03) — cold deep-link hang. The SPA's initial-
    // mount useEffect (App.tsx:790) posts the request in the legacy
    // hash-route shape `{ type: 'requestRoute', route, param, param2 }`,
    // not the `graphId` shape this handler used to insist on. Previously
    // `handleRequestRoute` early-returned on missing `graphId`, the
    // server never broadcast a navigateTo, and the SPA sat on "Loading…"
    // for the 8-second safety-net before falling back to home.
    it('UX-4: resolves a hash-route shape to a graphId and broadcasts navigateTo', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'requestRoute', route: 'system-design' }, 'client-1');
        const nav = d.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav, 'system-design route must resolve to microservice:workspace').toBeTruthy();
        expect(nav.graphId).toBe('microservice:workspace');
    });

    it('UX-4: resolves a hash-route `file/<param>` to file:<param>', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'requestRoute', route: 'file', param: 'src/a.ts' }, 'client-1');
        const nav = d.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav).toBeTruthy();
        expect(nav.graphId).toBe('file:src/a.ts');
    });

    it('UX-4: resolves a hash-route `flow/<param>/<param2>` to flow:<param>:<param2>', async () => {
        const d = mkDeps();
        // Take a snapshot of the original getWorking and extend it once
        // — recursive self-reference (`d.snapshotStore.getWorking = () =>
        // ({ ...d.snapshotStore.getWorking() })`) would infinite-loop.
        const baseSnapshot = (d.snapshotStore.getWorking() as any);
        const augmented = {
            ...baseSnapshot,
            graphs: {
                ...baseSnapshot.graphs,
                'flow:src/a.ts:doThing': {
                    graphId: 'flow:src/a.ts:doThing', type: 'flow',
                    nodes: [], edges: [], anchors: {}, meta: {},
                },
            },
        };
        d.snapshotStore.getWorking = () => augmented as any;
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'requestRoute', route: 'flow', param: 'src/a.ts', param2: 'doThing' }, 'client-1');
        const nav = d.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav).toBeTruthy();
        expect(nav.graphId).toBe('flow:src/a.ts:doThing');
    });

    // Issue UX-3 remaining (2026-06-03) — every home-card / toolbar
    // runCommand the standalone doesn't fully implement must STILL
    // produce a visible, actionable toast (not a silent drop).
    it('UX-3: codeatlas.analyzeImpact routes to health:report + emits a helpful toast', async () => {
        const d = mkDeps();
        // Seed the snapshot with a health:report graph so the route
        // resolves without a missing-graph warning.
        (d.snapshotStore.getWorking() as any).graphs['health:report'] = {
            graphId: 'health:report', type: 'health', nodes: [], edges: [], anchors: {}, meta: {},
        };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'runCommand', command: 'codeatlas.analyzeImpact' }, 'client-1');
        const nav = d.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav?.graphId).toBe('health:report');
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.text).toMatch(/Health Report|Impact/i);
    });

    // #MCP-STD-5 (2026-06-07): codeatlas.search must broadcast a
    // `showSearchPicker` envelope with searchable items so the webview
    // opens the global cross-surface search palette. The previous
    // implementation routed to api-list + a toast hinting at the `/`
    // shortcut, which only filtered routes within one L2b — confusing for
    // users expecting cross-surface workspace search.
    it('UX-3 + MCP-STD-5: codeatlas.search broadcasts showSearchPicker with APIs + files + clusters + services', async () => {
        const d = mkDeps();
        const working = d.snapshotStore.getWorking() as any;
        working.apiIndex = {
            'GET:/api/users::src/users.ts::getUsers': {
                apiId: 'GET:/api/users::src/users.ts::getUsers',
                method: 'GET', route: '/api/users',
                handlerName: 'getUsers', filePath: 'src/users.ts',
            },
        };
        working.files = { 'src/users.ts': { path: 'src/users.ts', hash: 'h', mtime: 1, symbols: { functions: [], variables: [], imports: [] } } };
        working.clusters = {
            'cluster:auth': { id: 'cluster:auth', label: 'auth', files: ['src/users.ts'], entryPoints: [], internalCallCount: 0, externalCallCount: 0 },
        };
        working.services = {
            'service:main': { id: 'service:main', name: 'main', rootPath: '.', technology: 'express', exposedApiCount: 1, consumedUrls: [], consumedServices: [] },
        };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'runCommand', command: 'codeatlas.search' }, 'client-1');
        const picker = d.broadcasts.find((m: any) => m.type === 'showSearchPicker');
        expect(picker, 'showSearchPicker broadcast missing').toBeDefined();
        const items = (picker as any).items as Array<{ kind: string }>;
        const kinds = new Set(items.map(i => i.kind));
        expect(kinds.has('API')).toBe(true);
        expect(kinds.has('File')).toBe(true);
        expect(kinds.has('Cluster')).toBe(true);
        expect(kinds.has('Service')).toBe(true);
        expect(items.length).toBeGreaterThanOrEqual(4);
    });

    it('UX-3: codeatlas.openPrDiff emits a warning toast pointing at VS Code', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'runCommand', command: 'codeatlas.openPrDiff' }, 'client-1');
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast).toBeTruthy();
        expect(toast.level).toBe('warning');
        expect(toast.text).toMatch(/VS Code|PR Diff/);
    });

    it('UX-3: unknown commands fall through to a helpful default toast (not the old "v1" wording)', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'runCommand', command: 'codeatlas.someUnknownThing' }, 'client-1');
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast).toBeTruthy();
        // Improved default message refers users to VS Code for the full
        // feature set. The old "not available in standalone v1" wording
        // was unactionable.
        expect(toast.text).toMatch(/VS Code|@codeatlas\/mcp/);
    });

    it('handles openFileDiagram by forwarding to requestRoute', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'openFileDiagram', graphId: 'file:src/a.ts' }, 'client-1');
        expect(d.broadcasts.find(m => m.type === 'navigateTo')?.graphId).toBe('file:src/a.ts');
    });
});

describe('standaloneMessageHandler — anchor clicks', () => {
    it('nodeClicked with anchor.filePath spawns the editor', async () => {
        const d = mkDeps();
        const opener = vi.fn(async () => ({ spawned: true, editor: 'code', toast: 'Opened a.ts in code' }));
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            editorOpener: opener as any,
        });
        await h.handle({ type: 'nodeClicked', anchor: { filePath: 'src/a.ts', line: 42 } }, 'client-1');
        expect(opener).toHaveBeenCalledWith('/repo/src/a.ts', 42, {});
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('info');
        expect(toast?.text).toContain('Opened');
    });

    it('nodeClicked without anchor is a no-op', async () => {
        const d = mkDeps();
        const opener = vi.fn(async () => ({ spawned: true, editor: 'code', toast: '' }));
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            editorOpener: opener as any,
        });
        await h.handle({ type: 'nodeClicked' }, 'client-1');
        expect(opener).not.toHaveBeenCalled();
    });

    it('honors an absolute filePath that is INSIDE the workspace (#888 boundary)', async () => {
        const d = mkDeps();
        const opener = vi.fn(async () => ({ spawned: true, editor: 'code', toast: '' }));
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            editorOpener: opener as any,
        });
        // An absolute path under the root resolves cleanly through safeResolve.
        await h.handle({ type: 'edgeClicked', anchor: { filePath: '/repo/abs/a.ts', line: 1 } }, 'client-1');
        expect(opener).toHaveBeenCalledWith('/repo/abs/a.ts', 1, {});
    });
});

describe('standaloneMessageHandler — comments', () => {
    it('resolveComment calls commentStore.resolve and broadcasts updated list', async () => {
        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-comments-'));
        try {
            const d = mkDeps();
            // #547: comment messages now route through the shared
            // commentHandlers module. It broadcasts `showComments` (the
            // webview-listened envelope) and calls commentStore.toJSON() /
            // getAll() + writeCommentsMd — supply those surfaces.
            (d.commentStore as any).getAll = () => [];
            (d.commentStore as any).toJSON = () => [];
            (d.snapshotStore as any).setComments = () => undefined;
            (d.snapshotStore as any).updateWorkingGraph = () => undefined;
            (d.snapshotStore as any).save = () => undefined;
            const h = createStandaloneMessageHandler({
                snapshotStore: d.snapshotStore, commentStore: d.commentStore,
                wsBridge: d.wsBridge, workspaceRoot: tmpRoot, log: () => {},
            });
            await h.handle({ type: 'resolveComment', commentId: 'c-42' }, 'client-1');
            await new Promise((r) => setTimeout(r, 30));
            expect(d.commentStore.resolve).toHaveBeenCalledWith('c-42');
            expect(d.broadcasts.some(m => m.type === 'showComments')).toBe(true);
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });
});

describe('standaloneMessageHandler — runCommand', () => {
    it('lightMode / darkMode broadcast setTheme', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'runCommand', command: 'codeatlas.lightMode' }, 'client-1');
        await h.handle({ type: 'runCommand', command: 'codeatlas.darkMode' }, 'client-1');
        const themes = d.broadcasts.filter(m => m.type === 'setTheme').map(m => m.theme);
        expect(themes).toEqual(['light', 'dark']);
    });

    it('unsupported command emits an info toast', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'runCommand', command: 'codeatlas.exportArchitectureDocs' }, 'client-1');
        expect(d.broadcasts.find(m => m.type === 'clientToast')?.level).toBe('info');
    });
});

describe('standaloneMessageHandler — unavailable messages (still deferred)', () => {
    // Only genuine USER actions toast. `requestChangeLog` was removed — it's
    // posted passively on mount, so toasting it fired a spurious warning on
    // every plain L1 load (now handled silently below).
    const cases = [
        'connectGitHub',        // Clerk OAuth (out of scope) — a "Sign in" button
    ];
    for (const t of cases) {
        it(`${t} → warning toast (never throws)`, async () => {
            const d = mkDeps();
            const h = createStandaloneMessageHandler({
                snapshotStore: d.snapshotStore, commentStore: d.commentStore,
                wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            });
            await h.handle({ type: t }, 'client-1');
            const toast = d.broadcasts.find(m => m.type === 'clientToast');
            expect(toast, `${t} must produce a toast so the user sees it`).toBeTruthy();
            expect(toast.level).toBe('warning');
        });
    }

    it('requestChangeLog is a silent no-op (no toast) + replies with an empty log', async () => {
        const d = mkDeps();
        // local sendTo capture — the change-log reply is client-targeted.
        const sent: Array<{ clientId: string; msg: any }> = [];
        (d.wsBridge as any).sendTo = (clientId: string, msg: any) => sent.push({ clientId, msg });
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'requestChangeLog' }, 'client-1');
        expect(d.broadcasts.find(m => m.type === 'clientToast'), 'no toast on passive probe').toBeFalsy();
        const reply = sent.find(s => s.msg.type === 'changeLogFull');
        expect(reply?.msg.entries).toEqual([]);
    });
});

describe('standaloneMessageHandler — setLlmConfig', () => {
    it('persists provider/model/endpoint to the settings layer + acks', async () => {
        const d = mkDeps();
        const saved: Array<[string, unknown]> = [];
        const fakeSettings: any = {
            get: () => undefined,
            all: () => ({}),
            set: (k: string, v: unknown) => { saved.push([k, v]); return true; },
        };
        const fakeSecrets: any = { get: async () => undefined, store: () => {}, delete: () => {} };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            settings: fakeSettings, secrets: fakeSecrets,
        });
        await h.handle({
            type: 'setLlmConfig',
            provider: 'anthropic',
            model: 'claude-3-5-sonnet',
            endpoint: 'https://api.anthropic.com',
        }, 'client-1');

        expect(saved).toEqual([
            ['codeatlas.llmProvider', 'anthropic'],
            ['codeatlas.llmModel', 'claude-3-5-sonnet'],
            ['codeatlas.llmEndpoint', 'https://api.anthropic.com'],
        ]);
        expect(d.broadcasts.find(m => m.type === 'llmConfigSaved')).toBeTruthy();
    });

    it('ignores undefined fields (partial update)', async () => {
        const d = mkDeps();
        const saved: Array<[string, unknown]> = [];
        const fakeSettings: any = {
            get: () => undefined, all: () => ({}),
            set: (k: string, v: unknown) => { saved.push([k, v]); return true; },
        };
        const fakeSecrets: any = { get: async () => undefined, store: () => {}, delete: () => {} };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            settings: fakeSettings, secrets: fakeSecrets,
        });
        await h.handle({ type: 'setLlmConfig', model: 'gpt-4o-mini' }, 'client-1');

        expect(saved).toEqual([['codeatlas.llmModel', 'gpt-4o-mini']]);
    });

    it('errors when set() fails on disk', async () => {
        const d = mkDeps();
        const fakeSettings: any = {
            get: () => undefined, all: () => ({}),
            set: () => false,
        };
        const fakeSecrets: any = { get: async () => undefined, store: () => {}, delete: () => {} };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            settings: fakeSettings, secrets: fakeSecrets,
        });
        await h.handle({ type: 'setLlmConfig', provider: 'ollama' }, 'client-1');

        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('error');
    });
});

describe('standaloneMessageHandler — AI Review / NL query routing', () => {
    it('requestAiReview without settings+secrets → unavailable toast', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'requestAiReview' }, 'client-1');
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('warning');
    });

    it('capabilities: canAiReview flips when settings+secrets supplied', async () => {
        const d = mkDeps();
        const fakeSettings: any = { get: () => undefined, all: () => ({}) };
        const fakeSecrets: any = { get: async () => undefined, store: () => {}, delete: () => {} };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            settings: fakeSettings, secrets: fakeSecrets,
        });
        await h.handle({ type: 'ready' }, 'client-1');
        const cap = d.broadcasts.find(m => m.type === 'capabilities');
        expect(cap.capabilities.canAiReview).toBe(true);
        expect(cap.capabilities.canSearch).toBe(true);
        expect(cap.capabilities.canReplay).toBe(true);
        // Git diff (commit / branch / PR pickers) is now also gated only on
        // having a secrets store available (PR fetch may need GITHUB_TOKEN).
        expect(cap.capabilities.canGitDiff).toBe(true);
    });
});

describe('standaloneMessageHandler — robustness', () => {
    let d: ReturnType<typeof mkDeps>;
    beforeEach(() => { d = mkDeps(); });

    it('drops null / non-object / non-string-type messages silently', async () => {
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle(null, 'c1');
        await h.handle({}, 'c1');
        await h.handle({ type: 123 }, 'c1');
        expect(d.broadcasts).toHaveLength(0);
    });
});

// Parity with extension's messageRouter: standalone must honour the same
// message names the webview already sends to the extension, so a webview
// build can target either backend without per-runtime branches.
describe('standaloneMessageHandler — extension-router parity aliases', () => {
    it('resolveAiReview / ignoreAiReview / reopenAiReview alias updateAiFindingStatus', async () => {
        const updateCalls: Array<[string, string]> = [];
        const snap: any = {
            ...{ files: {}, apiIndex: {}, clusters: {}, graphs: { 'microservice:workspace': { nodes: [], edges: [], anchors: {}, meta: {} } } },
            getWorking() { return this; },
            getBaseline() { return this; },
            updateAiReviewFindingStatus: vi.fn((id: string, status: string) => {
                updateCalls.push([id, status]);
                return { id, status };
            }),
            getAiReviewFindingCounts: () => ({ byGraph: {}, byEntryPoint: {}, bySeverity: { error: 0, warning: 0, info: 0 }, total: 0 }),
        };
        const broadcasts: any[] = [];
        const wsBridge = { broadcast: (m: any) => broadcasts.push(m) } as unknown as WsBridge;
        const h = createStandaloneMessageHandler({
            snapshotStore: snap as SnapshotStore,
            commentStore: { resolve: () => true } as unknown as CommentStore,
            wsBridge, workspaceRoot: '/repo', log: () => {},
        });

        await h.handle({ type: 'resolveAiReview', findingId: 'f1' }, 'c1');
        await h.handle({ type: 'ignoreAiReview', findingId: 'f2' }, 'c1');
        await h.handle({ type: 'reopenAiReview', findingId: 'f3' }, 'c1');

        expect(updateCalls).toEqual([
            ['f1', 'resolved'],
            ['f2', 'ignored'],
            ['f3', 'open'],
        ]);
        // Each call broadcasts an aiFindingUpdated event.
        const updates = broadcasts.filter(b => b.type === 'aiFindingUpdated');
        expect(updates).toHaveLength(3);
    });

    it('openApiListForCluster routes to api-list:<clusterId>', async () => {
        const d = mkDeps();
        (d.snapshotStore.getWorking() as any).graphs['api-list:cluster:auth'] = {
            graphId: 'api-list:cluster:auth', type: 'api-list',
            nodes: [], edges: [], anchors: {}, meta: {},
        };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'openApiListForCluster', clusterId: 'cluster:auth' }, 'c1');
        const nav = d.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav?.graphId).toBe('api-list:cluster:auth');
    });

    it('openFeatureForService routes to feature:<serviceId>', async () => {
        const d = mkDeps();
        (d.snapshotStore.getWorking() as any).graphs['feature:service:backend'] = {
            graphId: 'feature:service:backend', type: 'feature',
            nodes: [], edges: [], anchors: {}, meta: {},
        };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'openFeatureForService', serviceId: 'service:backend' }, 'c1');
        const nav = d.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav?.graphId).toBe('feature:service:backend');
    });

    it('openSequenceForApi resolves to sequence:<filePath>:<handlerName> when api+graph exist', async () => {
        const d = mkDeps();
        const w = d.snapshotStore.getWorking() as any;
        w.apiIndex = {
            'api-1': { apiId: 'api-1', method: 'GET', route: '/users', filePath: 'src/users.ts', handlerName: 'listUsers' },
        };
        w.graphs['sequence:src/users.ts:listUsers'] = {
            graphId: 'sequence:src/users.ts:listUsers', type: 'sequence',
            nodes: [], edges: [], anchors: {}, meta: {},
        };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'openSequenceForApi', apiId: 'api-1' }, 'c1');
        const nav = d.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav?.graphId).toBe('sequence:src/users.ts:listUsers');
    });

    it('navigateHome routes to L1', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'navigateHome' }, 'c1');
        const nav = d.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav?.graphId).toBe('microservice:workspace');
    });

    it('webviewAnalytics is a no-op (logged, no broadcasts)', async () => {
        const d = mkDeps();
        const logs: string[] = [];
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: (m: string) => logs.push(m),
        });
        await h.handle({ type: 'webviewAnalytics', event: 'feature_viewed', graphId: 'file:foo.ts' }, 'c1');
        expect(d.broadcasts).toHaveLength(0);
        expect(logs.some(l => l.includes('webviewAnalytics'))).toBe(true);
    });

    it('openSource invokes the injected editor opener with an absolute path', async () => {
        const d = mkDeps();
        const opened: Array<{ path: string; line?: number }> = [];
        const fakeOpener: any = (filePath: string, line?: number) => {
            opened.push({ path: filePath, line });
            return Promise.resolve({ ok: true });
        };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/Users/dev/repo', log: () => {},
            editorOpener: fakeOpener,
        });
        await h.handle({
            type: 'openSource',
            anchor: { filePath: 'src/foo.ts', symbol: 'bar' },
            line: 42,
        }, 'c1');
        expect(opened).toHaveLength(1);
        expect(opened[0].path).toBe('/Users/dev/repo/src/foo.ts');
        expect(opened[0].line).toBe(42);
    });

    it('requestImpact runs blast-radius analysis and broadcasts showImpact (#147)', async () => {
        const d = mkDeps();
        // The shared analyzer builds a fresh call graph when `snapshot.callGraph`
        // is absent — supply a file with no calls so buildCallGraph returns an
        // empty graph and analyzeImpact returns a valid empty-impact result.
        (d.snapshotStore.getWorking() as any).files = {
            'src/auth.ts': {
                path: 'src/auth.ts',
                hash: 'h', mtime: 0, content: '',
                symbols: { functions: [], variables: [], imports: [] },
            },
        };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'requestImpact', filePath: 'src/auth.ts' }, 'c1');
        await new Promise((r) => setTimeout(r, 20));
        // #147: the standalone now runs analyzeImpact and broadcasts showImpact
        // (was previously a "not yet wired" toast).
        const showImpact = d.broadcasts.find(m => m.type === 'showImpact');
        expect(showImpact).toBeTruthy();
        expect(showImpact?.impact).toBeTruthy();
    });

    it('fileSelectedForImpact runs blast-radius analysis (#147)', async () => {
        const d = mkDeps();
        (d.snapshotStore.getWorking() as any).files = {
            'src/auth.ts': {
                path: 'src/auth.ts',
                hash: 'h', mtime: 0, content: '',
                symbols: { functions: [], variables: [], imports: [] },
            },
        };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        // The file-picker entry point — same analyzer, same broadcast envelope
        // as `requestImpact`.
        await h.handle({ type: 'fileSelectedForImpact', filePath: 'src/auth.ts' }, 'c1');
        await new Promise((r) => setTimeout(r, 20));
        const showImpact = d.broadcasts.find(m => m.type === 'showImpact');
        expect(showImpact).toBeTruthy();
        // Should also clear any prior highlights.
        const clearHighlights = d.broadcasts.find(m => m.type === 'clearHighlights');
        expect(clearHighlights).toBeTruthy();
    });
});

// #859 — extension-only replay/timeline commands must not strand the webview
// on a dead "Loading…" route; they toast + navigate to a real view.
describe('standaloneMessageHandler — extension-only replay commands (#859)', () => {
    it('codeatlas.timelineReplay toasts "VS Code" AND navigates to system-design (not stuck on Loading)', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'runCommand', command: 'codeatlas.timelineReplay' }, 'c1');
        const toast = d.broadcasts.find((m: any) => m.type === 'clientToast');
        expect(toast, 'a toast must explain it is VS Code-only').toBeTruthy();
        expect(String(toast.text)).toMatch(/VS Code|extension/i);
        const nav = d.broadcasts.find((m: any) => m.type === 'navigateTo' && m.graphId === 'microservice:workspace');
        expect(nav, 'must navigate to a real view so the user is not stuck on Loading').toBeTruthy();
    });
});

describe('#888 — openSource / anchor-click stay inside the workspace', () => {
    it('refuses to open a traversal path and never spawns the editor', async () => {
        const d = mkDeps();
        const editorOpener = vi.fn(async () => ({ spawned: true, toast: 'opened' }));
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            editorOpener: editorOpener as any,
        });
        await h.handle({ type: 'openSource', filePath: '../../etc/passwd' }, 'c1');
        await h.handle({ type: 'openSource', anchor: { filePath: '/etc/passwd' } }, 'c1');
        // anchor-click path (handleAnchorClick) — same guard.
        await h.handle({ type: 'anchorClick', anchor: { filePath: '../../../etc/passwd' } }, 'c1');
        expect(editorOpener, 'editor must never be spawned for an out-of-workspace path').not.toHaveBeenCalled();
        const warn = d.broadcasts.find((m: any) => m.type === 'clientToast' && /outside the workspace/i.test(String(m.text)));
        expect(warn, 'a refusal toast must be shown').toBeTruthy();
    });

    it('opens an in-workspace path (resolved under the root)', async () => {
        const d = mkDeps();
        const editorOpener = vi.fn(async () => ({ spawned: true, toast: 'opened' }));
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            editorOpener: editorOpener as any,
        });
        await h.handle({ type: 'openSource', filePath: 'src/a.ts', line: 5 }, 'c1');
        expect(editorOpener).toHaveBeenCalledTimes(1);
        const arg0 = String(editorOpener.mock.calls[0][0]);
        expect(arg0.endsWith('/repo/src/a.ts')).toBe(true);
    });
});

describe('standaloneMessageHandler — BUG-EXP-13: bare #/features fallback on multi-service', () => {
    it('a missing feature:workspace resolves to a real feature graph (navigateTo), not a hang', async () => {
        const d = mkDeps();
        // Multi-service shape: a per-service feature graph exists, but there is
        // NO `feature:workspace` (what a cold `#/features` deep-link requests).
        (d.snapshotStore.getWorking() as any).graphs['feature:service:main'] = {
            graphId: 'feature:service:main', type: 'feature',
            nodes: [{
                id: 'c1', type: 'cluster', label: 'crud',
                meta: { files: ['src/a.ts'], apisInCluster: [{ apiId: 'a1', method: 'GET', route: '/x', filePath: 'src/a.ts', handlerName: 'h' }] },
            }],
            edges: [], anchors: {}, meta: {},
        };
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'requestRoute', graphId: 'feature:workspace' }, 'client-1');
        // Must land on a real feature graph — previously it sent a "Diagram not
        // found: feature:workspace" toast and NO navigateTo → SPA hung on "Loading…".
        const nav = d.broadcasts.find((m) => m.type === 'navigateTo' && String(m.graphId).startsWith('feature:'));
        expect(nav, 'must navigate to a feature graph, not hang').toBeTruthy();
        expect(Array.isArray(nav.graph?.nodes) && nav.graph.nodes.length > 0).toBe(true);
    });
});
