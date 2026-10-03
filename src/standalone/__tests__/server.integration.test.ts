/**
 * server.integration.test.ts — boots the standalone server end-to-end against
 * a tmpdir-backed `.codeatlas-sa` snapshot. Opens a real WebSocket, sends a
 * `ready` handshake, asserts `capabilities` + `navigateTo` come back.
 *
 * This is the smoke test for "does `npx @codeatlas/mcp --browser` actually
 * serve diagrams" — pre-shipping invariant. Skips when webview-ui/dist isn't
 * available (e.g. fresh checkout without `npm run build:webview`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import WebSocket from 'ws';
import { SnapshotStore } from '../../core/storage/snapshotStore';
import { startStandaloneServer, type StandaloneServer } from '../server';
import type { DiagramGraph } from '../../core/graph/graphTypes';

const WEBVIEW_DIST = path.join(__dirname, '..', '..', '..', 'webview-ui', 'dist');
const WEBVIEW_PRESENT = fs.existsSync(path.join(WEBVIEW_DIST, 'index.html'));

(WEBVIEW_PRESENT ? describe : describe.skip)('standalone server — integration', () => {
    let workspaceRoot: string;
    let store: SnapshotStore;
    let server: StandaloneServer;
    let distDir: string;

    beforeAll(async () => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-sa-int-'));
        store = new SnapshotStore(workspaceRoot, { storageDirName: '.codeatlas-sa' });
        await store.load();
        // Seed the snapshot with a microservice + file graph so requestRoute has
        // something to return. Mirrors what SyncOrchestrator.initialize() emits
        // for a 1-file project.
        const ms: DiagramGraph = {
            graphId: 'microservice:workspace', type: 'microservice',
            nodes: [{ id: 'svc_1', type: 'service', label: 'main' }],
            edges: [], anchors: {}, meta: { label: 'System Design' },
        };
        const fileGraph: DiagramGraph = {
            graphId: 'file:src/a.ts', type: 'file',
            nodes: [{ id: 'f_1', type: 'file', label: 'a.ts' }],
            edges: [], anchors: {}, meta: {},
        };
        store.updateWorkingGraph(ms.graphId, ms);
        store.updateWorkingGraph(fileGraph.graphId, fileGraph);
        store.save();

        // Fake `distDir` — point WsBridge at the real webview-ui build.
        // The build script copies webview-ui to <pkg>/dist/webview-ui/dist/;
        // we mimic that layout with a tmpdir.
        distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-distdir-'));
        fs.mkdirSync(path.join(distDir, 'webview-ui'), { recursive: true });
        fs.symlinkSync(WEBVIEW_DIST, path.join(distDir, 'webview-ui', 'dist'));

        server = await startStandaloneServer({
            workspaceRoot,
            snapshotStore: store,
            distDir,
            port: 0,            // 0 → bind any free port
            autoOpen: false,
            log: () => {},      // mute stderr in tests
        });
    });

    afterAll(async () => {
        await server?.stop();
        try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(distDir, { recursive: true, force: true }); } catch {}
    });

    it('binds to a free port and serves index.html on /', async () => {
        const body = await httpGet(`http://localhost:${server.port}/`);
        expect(body.toLowerCase()).toContain('<html');
    });

    it('serves the bundled webview-ui index.js from /assets/', async () => {
        // The Vite output emits `assets/index-*.js`. Read the actual
        // filename from the dist dir then request it through the server.
        const assets = fs.readdirSync(path.join(WEBVIEW_DIST, 'assets'));
        const indexJs = assets.find(f => f.endsWith('.js'));
        if (!indexJs) { return; /* defensive — should always be present */ }
        const res = await httpGetStatus(`http://localhost:${server.port}/assets/${indexJs}`);
        expect(res.status).toBe(200);
    });

    it('WS handshake: `ready` → `capabilities` + `workspaceInfo` + `domainLlmRefinementState` (NO initial navigateTo)', async () => {
        // #521 added workspaceInfo on handshake so HomePage stats render real
        // counts on first paint instead of em-dashes.
        // Issue #733 added `domainLlmRefinementState` after `workspaceInfo`
        // so the HomePage Domains-card chip reflects the persisted toggle
        // on first paint instead of defaulting to OFF on every reload.
        // BUG-VERIFY-4 removed the initial `navigateTo` push — the SPA drives
        // navigation via hash routing, and the unsolicited push raced deep-link
        // loads (a `#/features` refresh bounced to System Design).
        const messages = await wsRoundtrip(server.port, [{ type: 'ready' }], 3);
        const types = messages.map(m => m.type);
        expect(types).toContain('capabilities');
        expect(types).toContain('workspaceInfo');
        expect(types).toContain('domainLlmRefinementState');
        expect(types, 'ready must NOT push an initial graph').not.toContain('navigateTo');
        const caps = messages.find(m => m.type === 'capabilities');
        expect(caps.capabilities.canSignIn, 'standalone now supports Clerk sign-in (browser view)').toBe(true);
        expect(caps.capabilities.canEditCode).toBe(true);
        expect(caps.capabilities.mode).toBe('standalone');
        const wsInfo = messages.find(m => m.type === 'workspaceInfo');
        expect(wsInfo).toHaveProperty('fileCount');
        expect(wsInfo).toHaveProperty('apiCount');
    });

    it('WS requestRoute is GATED when signed out (signInRequired, no navigateTo)', async () => {
        // The integration server boots the real StandaloneClerkAuth with NO
        // session in the test env → signed out → diagram navigation is gated.
        // (Serving a diagram once signed IN is covered in messageHandler.test.ts.)
        const messages = await wsRoundtrip(server.port,
            [{ type: 'requestRoute', graphId: 'file:src/a.ts' }], 2,
        );
        expect(messages.find(m => m.type === 'navigateTo'), 'diagram must NOT load signed out').toBeUndefined();
        expect(messages.find(m => m.type === 'signInRequired'), 'signInRequired sent when gated').toBeTruthy();
    });

    it('WS ready handshake is ALLOWED signed out (home screen still loads)', async () => {
        // `ready` is on the signed-out allow-list — the home screen (where you
        // sign in / initialize / re-sync) must render even when gated.
        const messages = await wsRoundtrip(server.port, [{ type: 'ready' }], 3);
        expect(messages.find(m => m.type === 'capabilities'), 'capabilities still sent signed-out').toBeTruthy();
        expect(messages.find(m => m.type === 'workspaceInfo'), 'workspaceInfo still sent signed-out').toBeTruthy();
        expect(messages.find(m => m.type === 'signInRequired'), 'ready is not gated').toBeUndefined();
    });

    it('WS runCommand codeatlas.logout → re-broadcasts signed-out workspaceInfo', async () => {
        // No session file in the test home, so this exercises the wiring: the
        // logout handler clears the (absent) session and re-pushes workspaceInfo
        // so any open tab's chip flips back to "Sign in".
        const messages = await wsRoundtrip(server.port,
            [{ type: 'runCommand', command: 'codeatlas.logout' }], 2,
        );
        const wsInfo = messages.find(m => m.type === 'workspaceInfo');
        expect(wsInfo, 'logout must re-broadcast workspaceInfo').toBeTruthy();
        expect(wsInfo.isAuthenticated).toBe(false);
    });

    it('notifyRefresh (file-save cascade) re-broadcasts a FULL auth-aware workspaceInfo + cascadeRefresh', async () => {
        // Regression guard for the chip-flicker bug: the cascade broadcaster used
        // to emit its OWN stripped workspaceInfo with a hardcoded isAuthenticated:false
        // (no user fields), flipping a signed-in chip to "Sign in" on every save.
        // It now flows through the same auth-aware shared builder as ready/login,
        // carrying the full payload (counts) + the real auth state.
        const msgs = await new Promise<any[]>((resolve) => {
            const ws = new WebSocket(`ws://localhost:${server.port}`);
            const received: any[] = [];
            const done = () => { try { ws.close(); } catch { /* ignore */ } resolve(received); };
            const timer = setTimeout(done, 2500);
            ws.on('open', () => { setTimeout(() => server.notifyRefresh('src/a.ts'), 100); });
            ws.on('message', (raw: any) => {
                try { received.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
                if (received.some((m) => m.type === 'cascadeRefresh')) { clearTimeout(timer); done(); }
            });
            ws.on('error', () => { clearTimeout(timer); done(); });
        });
        const wsInfo = msgs.find((m) => m.type === 'workspaceInfo');
        expect(wsInfo, 'cascade must re-broadcast workspaceInfo').toBeTruthy();
        expect(wsInfo).toHaveProperty('fileCount');   // full payload, not stripped
        expect(wsInfo).toHaveProperty('apiCount');
        expect(typeof wsInfo.isAuthenticated, 'cascade workspaceInfo is auth-aware').toBe('boolean');
        expect(msgs.some((m) => m.type === 'cascadeRefresh'), 'cascade ping present').toBe(true);
    });

    it('extension dir `.codeatlas` is NOT created — standalone is isolated', () => {
        expect(fs.existsSync(path.join(workspaceRoot, '.codeatlas'))).toBe(false);
        expect(fs.existsSync(path.join(workspaceRoot, '.codeatlas-sa'))).toBe(true);
    });
});

// ─── HTTP/WS helpers ─────────────────────────────────────────────────────

function httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });
}

function httpGetStatus(url: string): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            res.resume();
            resolve({ status: res.statusCode ?? 0 });
        }).on('error', reject);
    });
}

/**
 * Connect a WebSocket, send the given messages, collect broadcasts until we
 * see at least `expectedReplies` messages OR 2 s elapses (whichever is first).
 * Returns the collected messages.
 */
function wsRoundtrip(port: number, send: any[], expectedReplies: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}`);
        const received: any[] = [];
        let timer: ReturnType<typeof setTimeout>;

        ws.on('open', () => {
            for (const msg of send) ws.send(JSON.stringify(msg));
        });
        ws.on('message', (raw: any) => {
            try { received.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
            if (received.length >= expectedReplies) {
                clearTimeout(timer);
                ws.close();
                resolve(received);
            }
        });
        ws.on('error', reject);

        timer = setTimeout(() => {
            ws.close();
            resolve(received); // resolve with whatever we have
        }, 2000);
    });
}
