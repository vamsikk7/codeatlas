import { describe, it, expect, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SnapshotStore } from '../../core/storage/snapshotStore';
import { registerMcpTools } from '../mcp-tools';

// Mock dependencies
vi.mock('../../core/analysis/impactAnalyzer', () => ({
    analyzeImpact: vi.fn().mockReturnValue({ affectedFiles: ['/src/a.ts'], dependencyCount: 1 })
}));

describe('MCP Tools', () => {

    it('should register tool list and call handlers', async () => {
        // #857 — the full registry (all 54 tools, all callable) is surfaced
        // only when CODEATLAS_MCP_ALL_TOOLS=1; the default `tools/list` filters
        // to the agent-relevant subset. This test asserts the FULL registry;
        // the default-filtered surface is asserted in its own test below.
        const prev = process.env.CODEATLAS_MCP_ALL_TOOLS;
        process.env.CODEATLAS_MCP_ALL_TOOLS = '1';
        try {
        const mockServer = {
            setRequestHandler: vi.fn(),
        } as unknown as Server;

        const mockStore = {
            getWorking: vi.fn().mockReturnValue({}),
        } as unknown as SnapshotStore;

        registerMcpTools(mockServer, mockStore);

        expect(mockServer.setRequestHandler).toHaveBeenCalledTimes(2);

        // Test list handler
        const listHandler = (mockServer.setRequestHandler as any).mock.calls[0][1];
        const listResponse = await listHandler({});

        const names = listResponse.tools.map((t: any) => t.name);
        // Original tools
        expect(names).toContain('get_impact_analysis');
        expect(names).toContain('get_function_dependencies');
        // New entry-point / context-pack tools (Issue 419 follow-up):
        expect(names).toContain('list_entrypoints');
        expect(names).toContain('get_entrypoint_pack');
        expect(names).toContain('get_diff_summary');
        expect(names).toContain('get_impact_of_change');
        expect(names).toContain('get_feature_pack');
        expect(names).toContain('search_workspace');
        expect(names).toContain('describe_snapshot_schema');
        expect(names).toContain('query_snapshot');
        // Tier 1 additions:
        expect(names).toContain('get_health_report');
        expect(names).toContain('get_function_source');
        expect(names).toContain('trace_call_path');
        expect(names).toContain('get_api_surface_diff');
        expect(names).toContain('pre_edit_brief');
        // Tier 2 additions:
        expect(names).toContain('list_entrypoints_paged');
        expect(names).toContain('list_architecture_violations');
        expect(names).toContain('get_coverage_overlay');
        expect(names).toContain('find_similar_entities');
        expect(names).toContain('list_saved_views');
        // Tier 3 additions:
        expect(names).toContain('export_openapi_spec');
        expect(names).toContain('export_function_calling_spec');
        expect(names).toContain('compare_workspaces');
        expect(names).toContain('summarise_payload');
        // Self-bootstrap status:
        expect(names).toContain('get_workspace_status');
        // AI review tools (#506 — Tier-1 MCP tools for AI review):
        expect(names).toContain('list_ai_findings');
        expect(names).toContain('get_ai_finding');
        expect(names).toContain('get_ai_finding_counts');
        expect(names).toContain('update_ai_finding_status');
        expect(names).toContain('get_review_guidelines');
        expect(names).toContain('set_review_guidelines');
        expect(names).toContain('search_ai_findings');
        // #review-context — shared review-context + FP-filter tools (MCP↔extension parity):
        expect(names).toContain('get_review_context');
        expect(names).toContain('filter_review_findings');
        expect(names).toContain('run_review');
        // #827 regression-scope composer:
        expect(names).toContain('get_regression_scope');
        // #826 overlay contract:
        expect(names).toContain('list_overlays');
        expect(names).toContain('get_overlay');
        // EXACT count, on purpose (#835 follow-up sweep): the number is
        // quoted in README.md (×3), mcp-package/README.md (×2),
        // mcp-package/package.json description, and the mcp-browser-verify
        // skill. When you add or remove a tool, update those surfaces and
        // THEN this assertion — that's the messaging sweep, enforced.
        expect(listResponse.tools.length).toBe(57);
        } finally {
            if (prev === undefined) delete process.env.CODEATLAS_MCP_ALL_TOOLS;
            else process.env.CODEATLAS_MCP_ALL_TOOLS = prev;
        }
    });

    // #857 — default `tools/list` surfaces only the agent-relevant subset.
    it('default tools/list hides the interactive/UI/redundant tools', async () => {
        const prev = process.env.CODEATLAS_MCP_ALL_TOOLS;
        delete process.env.CODEATLAS_MCP_ALL_TOOLS;
        try {
            const mockServer = { setRequestHandler: vi.fn() } as unknown as Server;
            const mockStore = { getWorking: vi.fn().mockReturnValue({}) } as unknown as SnapshotStore;
            registerMcpTools(mockServer, mockStore);
            const listHandler = (mockServer.setRequestHandler as any).mock.calls[0][1];
            const names = (await listHandler({})).tools.map((t: any) => t.name);
            // Hidden by default (interactive workbench / UI / redundant siblings):
            for (const hidden of ['connect_websocket', 'run_api_chain', 'get_tour', 'clear_findings',
                'list_saved_views', 'list_entrypoints', 'get_coverage_overlay', 'export_openapi_spec']) {
                expect(names, `${hidden} must be hidden by default`).not.toContain(hidden);
            }
            // Core code-intel tools stay surfaced:
            for (const shown of ['get_impact_analysis', 'get_entrypoint_pack', 'review_diff_with_baseline',
                'trace_call_path', 'get_regression_scope', 'search_workspace', 'list_entrypoints_paged']) {
                expect(names, `${shown} must be surfaced`).toContain(shown);
            }
            // Surfaced by default: get_review_context + filter_review_findings + run_review
            // are agent-relevant so they are NOT hidden. 57 registered − 17 hidden = 40.
            expect(names).toContain('get_review_context');
            expect(names).toContain('filter_review_findings');
            expect(names).toContain('run_review');
            expect(names.length).toBe(40);
        } finally {
            if (prev === undefined) delete process.env.CODEATLAS_MCP_ALL_TOOLS;
            else process.env.CODEATLAS_MCP_ALL_TOOLS = prev;
        }
    });

    // #review-context — filter_review_findings tool dispatch (FP filter parity).
    it('filter_review_findings drops off-diff + dedups, keeps in-diff distinct', async () => {
        const mockServer = { setRequestHandler: vi.fn() } as unknown as Server;
        const mockStore = { getWorking: vi.fn().mockReturnValue({}) } as unknown as SnapshotStore;
        registerMcpTools(mockServer, mockStore);
        const callHandler = (mockServer.setRequestHandler as any).mock.calls[1][1];
        const findings = [
            { title: 'real bug', severity: 'error', anchor: { filePath: 'src/a.ts', symbol: 's1' } },
            { title: 'real bug', severity: 'warning', anchor: { filePath: 'src/a.ts', symbol: 's1' } }, // dup
            { title: 'off diff', severity: 'error', anchor: { filePath: 'src/other.ts' } },             // off-diff
        ];
        const resp = await callHandler({ params: { name: 'filter_review_findings', arguments: { findings, changedFiles: ['src/a.ts'] } } });
        const out = JSON.parse(resp.content[0].text);
        expect(out.keptCount).toBe(1);
        expect(out.droppedCount).toBe(2);
        expect(out.dropped.map((d: any) => d.reason).sort()).toEqual(['duplicate', 'off-diff']);
    });

    // #review-context — get_review_context validates its source.
    it('get_review_context requires a base for pr/diff source', async () => {
        const mockServer = { setRequestHandler: vi.fn() } as unknown as Server;
        const mockStore = {
            getWorking: vi.fn().mockReturnValue({ files: {}, apiIndex: {}, graphs: {} }),
            getWorkspaceRoot: vi.fn().mockReturnValue('/tmp/x'),
        } as unknown as SnapshotStore;
        registerMcpTools(mockServer, mockStore);
        const callHandler = (mockServer.setRequestHandler as any).mock.calls[1][1];
        const resp = await callHandler({ params: { name: 'get_review_context', arguments: { source: { kind: 'pr' } } } });
        expect(resp.isError).toBe(true);
        expect(resp.content[0].text).toMatch(/base is required/);
    });

    // #954 — run_review's findings-flow is unit-tested in runReviewOnSnapshot.test.ts
    // (the handler loads that engine from a separate runtime-required bundle, so it
    // isn't resolvable under vitest). Here we cover the read-only refusal guard.
    it('run_review refuses in read-only mode', async () => {
        const mockServer = { setRequestHandler: vi.fn() } as unknown as Server;
        const mockStore = {
            getWorking: vi.fn().mockReturnValue({}),
            __bootstrapStatus: () => ({ mode: 'read_only' }),
        } as unknown as SnapshotStore;
        registerMcpTools(mockServer, mockStore);
        const callHandler = (mockServer.setRequestHandler as any).mock.calls[1][1];
        const resp = await callHandler({ params: { name: 'run_review', arguments: {} } });
        expect(resp.isError).toBe(true);
        expect(resp.content[0].text).toMatch(/read.?only/i);
    });

    // #827 (2026-06-10): get_regression_scope wiring — empty scope when
    // working === baseline (the composition itself is pinned by
    // core/analysis/__tests__/regressionScope.test.ts).
    it('get_regression_scope: empty scope when working === baseline', async () => {
        const mockServer = { setRequestHandler: vi.fn() } as unknown as Server;
        const snap = { files: { 'src/a.ts': { hash: 'x' } }, apiIndex: {}, graphs: {} };
        const mockStore = {
            getWorking: vi.fn().mockReturnValue(snap),
            getBaseline: vi.fn().mockReturnValue(snap),
            getWorkspaceRoot: vi.fn().mockReturnValue('/tmp/no-coverage-here'),
        } as unknown as SnapshotStore;

        registerMcpTools(mockServer, mockStore);
        const callHandler = (mockServer.setRequestHandler as any).mock.calls[1][1];

        const response = await callHandler({
            params: { name: 'get_regression_scope', arguments: {} },
        });
        expect(response.isError).toBeFalsy();
        const scope = JSON.parse(response.content[0].text);
        expect(scope.changedEntities).toEqual([]);
        expect(scope.testsToRun).toEqual([]);
        expect(scope.testCommand).toBeNull();
    });

    it('should handle get_impact_analysis calls', async () => {
        const mockServer = {
            setRequestHandler: vi.fn(),
        } as unknown as Server;

        const mockStore = {
            getWorking: vi.fn().mockReturnValue({}),
        } as unknown as SnapshotStore;

        registerMcpTools(mockServer, mockStore);

        // Get call handler
        const callHandler = (mockServer.setRequestHandler as any).mock.calls[1][1];

        const response = await callHandler({
            params: {
                name: 'get_impact_analysis',
                arguments: { filePaths: ['/src/core/auth.ts'] }
            }
        });

        expect(response.isError).toBeFalsy();

        // Successful tool results carry two text blocks: the JSON payload in
        // content[0], and the product attribution appended as content[1].
        // The payload is kept in its own block deliberately -- appending the
        // attribution to the JSON string would break every client that parses
        // content[0].text.
        expect(response.content).toHaveLength(2);
        expect(response.content[0].type).toBe('text');

        const result = JSON.parse(response.content[0].text);
        expect(result.affectedFiles).toContain('/src/a.ts');
        expect(result.dependencyCount).toBe(1);

        expect(response.content[1]).toEqual({
            type: 'text',
            text: 'Powered by CodeAtlas — https://codeatlas.live',
        });
    });

    it('does not append attribution to error results', async () => {
        const mockServer = { setRequestHandler: vi.fn() } as unknown as Server;
        const mockStore = { getWorking: vi.fn().mockReturnValue({}) } as unknown as SnapshotStore;
        registerMcpTools(mockServer, mockStore);
        const callHandler = (mockServer.setRequestHandler as any).mock.calls[1][1];

        // Missing the required `filePaths` argument -> validation error.
        const response = await callHandler({
            params: { name: 'get_impact_analysis', arguments: {} },
        });

        const texts = (response.content ?? []).map((c: { text: string }) => c.text).join('\n');
        expect(texts).not.toContain('Powered by CodeAtlas');
    });

    // #MCP-MUT-2 (2026-06-07): when a daemon owns the write lock,
    // secondary stdio sessions get `mode: 'read_only'` and mutation tools
    // refuse. The OLD message just said "Refused: workspace is read-only"
    // which gave AI clients (Claude Desktop / Cursor) no path forward.
    // Improve the message to explain the cause + actionable steps:
    // mention "browser webview at http://localhost:7842 stays mutation-
    // capable", or "kill the daemon and retry". The new message is
    // structured so AI clients can parse + relay it usefully.
    it('MCP-MUT-2: read-only mutation error is actionable + mentions the daemon path', async () => {
        const mockServer = { setRequestHandler: vi.fn() } as unknown as Server;
        const mockStore = {
            getWorking: vi.fn().mockReturnValue({}),
            // Simulate the read-only flag set when a daemon holds the lock.
            __bootstrapStatus: () => ({ mode: 'read_only' }),
        } as unknown as SnapshotStore;

        registerMcpTools(mockServer, mockStore);
        const callHandler = (mockServer.setRequestHandler as any).mock.calls[1][1];

        const response = await callHandler({
            params: {
                name: 'set_review_guidelines',
                arguments: { text: '• Test' },
            },
        });

        expect(response.isError).toBe(true);
        const msg = response.content[0].text as string;
        // Must mention WHAT is read-only (daemon path), and a workaround
        // (browser or daemon teardown).
        expect(msg).toMatch(/read-only/i);
        expect(msg).toMatch(/daemon|browser|webview|http:\/\/localhost/i);
        // Must NOT be just the legacy 1-liner with no actionable hint.
        expect(msg.length).toBeGreaterThan(40);
    });

    // #834 (2026-06-11): the documented multi-repo default for
    // list_entrypoints is the MERGED set (#825 contract); the dispatch was
    // returning the primary repo's set only.
    it('list_entrypoints multi-repo default merges every sub-repo; repoId still scopes (#834)', async () => {
        const mockServer = { setRequestHandler: vi.fn() } as unknown as Server;
        const api = (id: string, route: string) => ({
            apiId: id, id, method: 'GET', route, filePath: 'f.js', handlerName: 'h', diff: 'unchanged',
        });
        const storeA = { getWorking: () => ({ files: {}, graphs: {}, apiIndex: { 'GET:/a': api('GET:/a', '/a') } }) };
        const storeB = { getWorking: () => ({ files: {}, graphs: {}, apiIndex: { 'GET:/b': api('GET:/b', '/b') } }) };
        const primarySnap = storeA.getWorking();
        const mockStore = {
            getWorking: vi.fn().mockReturnValue(primarySnap),
        } as unknown as SnapshotStore;
        (mockStore as any).__multiRepo = () => ({
            aggregator: {},
            repos: [
                { repoId: 'ra', name: 'alpha', rootPath: 'alpha' },
                { repoId: 'rb', name: 'beta', rootPath: 'beta' },
            ],
            repoStores: new Map([['ra', storeA], ['rb', storeB]]),
            primaryRepoId: 'ra',
        });

        registerMcpTools(mockServer, mockStore);
        const callHandler = (mockServer.setRequestHandler as any).mock.calls[1][1];

        // Default → merged (both routes).
        const merged = await callHandler({ params: { name: 'list_entrypoints', arguments: {} } });
        const mergedRoutes = JSON.parse(merged.content[0].text).map((e: any) => e.route).sort();
        expect(mergedRoutes).toEqual(['/a', '/b']);

        // repoId → scoped to that repo only.
        const scoped = await callHandler({ params: { name: 'list_entrypoints', arguments: { repoId: 'rb' } } });
        const scopedRoutes = JSON.parse(scoped.content[0].text).map((e: any) => e.route);
        expect(scopedRoutes).toEqual(['/b']);
    });

    it('MCP-EVAL-3: returns a clean error for missing schema-required args instead of crashing', async () => {
        const mockServer = { setRequestHandler: vi.fn() } as unknown as Server;
        const mockStore = { getWorking: vi.fn().mockReturnValue({ files: {}, apiIndex: {}, graphs: {} }), refresh: vi.fn() } as unknown as SnapshotStore;
        registerMcpTools(mockServer, mockStore);
        const callHandler = (mockServer.setRequestHandler as any).mock.calls[1][1];

        // get_function_source requires filePath + symbolName — omitting them must
        // yield a structured "missing required argument" error, not a thrown TypeError.
        const res = await callHandler({ params: { name: 'get_function_source', arguments: {} } });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toMatch(/missing required argument/i);
        expect(res.content[0].text).toMatch(/filePath/);

        // oauth2_authorize_url requires authorizationEndpoint — previously crashed
        // with "Cannot read properties of undefined (reading 'includes')".
        const res2 = await callHandler({ params: { name: 'oauth2_authorize_url', arguments: { clientId: 'x', redirectUri: 'https://a/cb' } } });
        expect(res2.isError).toBe(true);
        expect(res2.content[0].text).toMatch(/authorizationEndpoint/);
        expect(res2.content[0].text).not.toMatch(/Cannot read properties/);

        // A tool with NO required args still runs (validation is a no-op for it).
        const ok = await callHandler({ params: { name: 'get_workspace_status', arguments: {} } });
        expect(ok.isError).not.toBe(true);
    });
});
