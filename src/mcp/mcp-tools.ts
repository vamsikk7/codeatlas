import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SnapshotStore } from '../core/storage/snapshotStore';
import type { McpAnalytics } from './analytics/mcpAnalytics';
import { analyzeImpact, ImpactResult } from '../core/analysis/impactAnalyzer';
import { WorkspaceCallGraph } from '../core/graph/callGraphResolver';
import { EntityRecord } from '../core/graph/graphTypes';
import {
    listEntryPoints,
    getEntryPointPack,
    getDiffSummary,
    getImpactOfChange,
    getFeaturePack,
    getFunctionSource,
    getApiSurfaceDiff,
    getPreEditBrief,
    getHealthReport,
    type EntryPointFilter,
} from './contextPack';
import { searchWorkspace, type SearchEntityKind } from './searchIndex';
import { computeRegressionScope } from '../core/analysis/regressionScope';
import { loadCoverageData } from '../core/analysis/coverageReader';
import { listCrossRepoEdgesForProducer } from '../core/analysis/crossRepoHttpAnalyzer';
import { runReadOnlyQuery, describeSchema } from './sqlQuery';
import { traceCallPath } from './callPath';
import {
    listEntryPointsPaged,
    listArchitectureViolations,
    getCoverageOverlay,
    findSimilarEntities,
    loadSavedViews,
} from './tier2';
import {
    exportOpenApiSpec,
    exportFunctionCallingSpec,
    compareWorkspaces,
    summarisePayload,
    type ToolDescriptor,
} from './tier3';
import { ATTRIBUTION_TEXT } from '../lib/attribution';

// Re-invoke the live tools/list handler so the spec exporters stay in sync with
// whatever the server is currently advertising. The SDK handler is wrapped with
// schema validation, so we must pass a well-formed JSON-RPC request shape — an
// earlier version passed {} and tripped the validator with "expected tools/list".
async function listToolDescriptors(server: Server): Promise<ToolDescriptor[]> {
    const listHandler = (server as any)._requestHandlers?.get?.('tools/list')
        ?? (server as any).requestHandlers?.get?.('tools/list');
    if (!listHandler) return [];
    const result = await listHandler({ method: 'tools/list', params: {} }, {});
    return (result?.tools ?? []) as ToolDescriptor[];
}

/**
 * #MCP-MUT-2 (2026-06-07): when a daemon owns the write lock (the common
 * post-`codeatlas-mcp setup` configuration), secondary stdio sessions get
 * `mode: 'read_only'` because two processes can't safely co-write to the
 * same SQLite file. AI clients (Claude Desktop / Cursor / etc.) end up
 * calling mutation tools — `set_review_guidelines` / `update_ai_finding_
 * status` / `clear_findings` / `review_diff_with_baseline` — through that
 * stdio session and the call fails. The OLD refusal message was just
 * "Refused: workspace is read-only." — true but useless. This message
 * explains the cause + two paths forward: edit through the live browser
 * (which IS the daemon, so its write goes through cleanly), or
 * temporarily stop the daemon and retry. AI clients can parse this and
 * relay it usefully.
 */
const READ_ONLY_REFUSAL = (
    'Refused: workspace is read-only. ' +
    'A CodeAtlas MCP daemon is currently holding the write lock on this workspace ' +
    '(this is the default state after `codeatlas-mcp setup`). ' +
    'Two paths forward:\n' +
    '  1. Recommended — make the change in the daemon\'s browser UI at ' +
    'http://localhost:7842 (e.g. open the Code Review card and edit guidelines there). ' +
    'The daemon owns the writer, so this lands cleanly.\n' +
    '  2. Stop the daemon (`codeatlas-mcp teardown`), retry this tool, then re-run ' +
    '`codeatlas-mcp setup` — but you lose the persistent browser surface for the gap.\n' +
    'If neither is acceptable, file a feature request for stdio-to-daemon mutation forwarding ' +
    '(tracked as #MCP-MUT-2).'
);

/**
 * #857 — tools NOT surfaced in `tools/list` to AI coding agents. They remain
 * fully callable (the CallTool handlers are unchanged) and still power the
 * browser API-testing workbench; they're just hidden from the agent's
 * tool-selection surface because they don't serve a code-understand / edit /
 * review intent. Override with CODEATLAS_MCP_ALL_TOOLS=1.
 *
 *   - API-testing workbench (human-interactive, not code-intel):
 *     connect_websocket, stream_sse, run_api_chain, generate_chain,
 *     generate_request_body, import_api_collection
 *   - Human UI personalization / onboarding: list_saved_views, get_tour
 *   - Finding-store mutation / UI triage / redundant slicing: clear_findings,
 *     update_ai_finding_status, score_findings, get_ai_finding_counts,
 *     summarise_findings  (agents read via list_ai_findings / search_ai_findings)
 *   - Non-MCP-client meta exporters: export_openapi_spec, export_function_calling_spec
 *   - Redundant siblings (keep the paged / generic one): list_entrypoints
 *     (use list_entrypoints_paged), get_coverage_overlay (use get_overlay)
 */
export const AGENT_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
    'connect_websocket', 'stream_sse', 'run_api_chain', 'generate_chain',
    'generate_request_body', 'import_api_collection',
    'list_saved_views', 'get_tour',
    'clear_findings', 'update_ai_finding_status', 'score_findings',
    'get_ai_finding_counts', 'summarise_findings',
    'export_openapi_spec', 'export_function_calling_spec',
    'list_entrypoints', 'get_coverage_overlay',
]);

export function registerMcpTools(server: Server, snapshotStore: SnapshotStore, analytics?: McpAnalytics) {
    // MCP-EVAL-3: hoisted to the function scope so both `tools/list` and the
    // CallTool required-arg validator (in callToolHandler) can read each tool's
    // inputSchema.
    const allTools = [
                {
                    name: 'get_impact_analysis',
                    description: 'Analyze the blast radius of modifying a specific file or function. Returns upstream callers (who is affected) and downstream dependencies. In multi-repo workspaces, pass `repoId` (from `list_repos`) to scope analysis to a specific repo; defaults to the primary repo when omitted.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            filePaths: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'List of file paths relative to workspace root to analyze.',
                            },
                            repoId: { type: 'string', description: 'ADR-034 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['filePaths'],
                    } as any,
                },
                {
                    name: 'get_function_dependencies',
                    description: 'Get the upstream callers or downstream calls for a specific function/symbol. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            filePath: { type: 'string', description: 'File path relative to workspace root' },
                            symbolName: { type: 'string', description: 'Name of the function/class/variable' },
                            direction: { type: 'string', enum: ['upstream', 'downstream'], description: 'Whether to get callers (upstream) or what it calls (downstream)' },
                            depth: { type: 'number', description: 'Depth of the resolution (default: 1)' },
                            repoId: { type: 'string', description: 'ADR-034 multi-repo MCP — scope to this repo (from `list_repos`). Optional.' },
                        },
                        required: ['filePath', 'symbolName', 'direction'],
                    } as any,
                },
                {
                    name: 'list_repos',
                    description: 'ADR-034 multi-repo MCP: list every repo registered in the workspace aggregator (`.codeatlas/monorepo.db`). Returns repoId, name, rootPath, status (parsing/ready/failed/stale), diff vs baseline, fileCount, apiCount per repo. Use this to discover the available repos and then restart the MCP server with `--repo <name>` to scope subsequent tool calls to a different repo (the default is the alphabetically-first rootPath). Single-repo workspaces return a single entry. Workspaces without `monorepo.db` return an empty list with `mode: "single"`.',
                    inputSchema: { type: 'object', properties: {} } as any,
                },
                {
                    name: 'list_entrypoints',
                    description: 'Enumerate every architectural entry point in the workspace (HTTP routes, background jobs, MQ consumers, CLI commands, mobile screens, navigation routes, DB migrations/seeds, websockets, GraphQL subscriptions, model hooks, lifecycle hooks, etc.). Each entry includes its handler, file path, feature cluster, service, auth status, middleware chain, and diff state. Use this as the lowest-token starting point for understanding what a codebase exposes. In multi-repo workspaces the DEFAULT (no repoId) returns the MERGED set across every sub-repo; pass `repoId` (from `list_repos`) to scope to one sub-repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            method: { type: 'string', description: 'Filter by method category — e.g. GET, POST, JOB, MQ_CONSUMER, CLI_COMMAND, SCREEN, NAV_ROUTE, DB_MIGRATION, DB_SEED, SOCKET_EVENT, SUBSCRIPTION, HEALTH, MIDDLEWARE.' },
                            clusterId: { type: 'string', description: 'Filter by feature cluster id.' },
                            serviceId: { type: 'string', description: 'Filter by service id.' },
                            authRequired: { type: 'boolean', description: 'Only entry points whose meta.auth = required.' },
                            onlyChanged: { type: 'boolean', description: 'Only entry points marked added/modified/deleted vs baseline.' },
                            routeContains: { type: 'string', description: 'Substring match on the route path.' },
                            repoId: { type: 'string', description: 'ADR-034 multi-repo MCP — scope to this repo (from `list_repos`). Optional.' },
                        },
                    } as any,
                },
                {
                    name: 'get_entrypoint_pack',
                    description: 'Return a full LLM-ready context pack for ONE entry point: handler source slice, sequence-graph downstream participants + messages, flow-graph control flow, sibling routes in the same cluster, auth/middleware chain, and the current diff state. Designed to fit in 2-5KB JSON so a small LLM can answer "what does this route do?" without reading any source file. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            method: { type: 'string', description: 'Entry-point method (GET, POST, JOB, …).' },
                            route: { type: 'string', description: 'Route / route-pattern (e.g. /api/articles/:slug).' },
                            includeHandlerSource: { type: 'boolean', description: 'If true, embed the handler\'s source slice. Default false to keep the pack small.' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['method', 'route'],
                    } as any,
                },
                {
                    name: 'get_diff_summary',
                    description: 'Summarise what changed since the baseline snapshot: changed file paths, added/deleted/modified entry points, modified feature clusters. The canonical answer to "what is this PR/branch actually touching?" without reading any diff. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                    } as any,
                },
                {
                    name: 'list_overlays',
                    description: 'List the registered graph overlays (#826 contract): diff, comments, coverage, todo-comments, plus any future adapters (Sentry, APM). Returns id, displayName, paint style, join kind, and the current UI toggle state. UI toggles never gate DATA access — use get_overlay to fetch points regardless.',
                    inputSchema: { type: 'object', properties: {} } as any,
                },
                {
                    name: 'get_overlay',
                    description: 'Fetch one overlay\'s raw data points (#826). Each point carries a join key (filePath[+functionName] / apiId / serviceId), a value, and an optional severity. Joining onto a specific graph happens client-side or via the browser surface; this tool returns the unjoined points so agents can aggregate freely. Empty result includes the adapter\'s empty-state hint (e.g. "no LCOV data found").',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Overlay id from list_overlays (e.g. "coverage", "todo-comments").' },
                        },
                        required: ['id'],
                    } as any,
                },
                {
                    name: 'get_regression_scope',
                    description: 'Compose the full regression scope of the current working diff: changed entities (file + function granularity), blast radius (direct / transitive / review-required via reverse call-graph BFS), TESTS TO RUN (test files that reach changed code through the call graph, plus path-convention siblings), the UNTESTED blast radius (entities with zero coverage when LCOV/Istanbul data exists — the risk list), affected API endpoints, cross-repo consumers (multi-repo), and a copy-pasteable runner command (vitest/jest). The canonical answer to "what should I re-test after this edit?". Empty scope when working === baseline. v1 mapping is call-graph + convention based, not per-test attribution. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            repoId: { type: 'string', description: 'Multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                            includeCrossRepo: { type: 'boolean', description: 'Multi-repo — also list consumer repos whose calls hit the affected endpoints (from cross_repo_http_edges). Default false.' },
                            maxDepth: { type: 'number', description: 'Reverse call-graph BFS depth (default 4).' },
                        },
                    } as any,
                },
                {
                    name: 'get_impact_of_change',
                    description: 'Given a file path (and optionally a function name), list every entry point whose call chain reaches it. Inverse of get_entrypoint_pack — answers "if I touch this, what gets affected?". Use before suggesting refactors or assessing PR scope. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            filePath: { type: 'string', description: 'File path relative to workspace root.' },
                            functionName: { type: 'string', description: 'Optional — name of a specific function in the file.' },
                            repoId: { type: 'string', description: 'UX-66 (2026-06-09) multi-repo MCP — scope analysis to this repo (from `list_repos`). Optional.' },
                        },
                        required: ['filePath'],
                    } as any,
                },
                {
                    name: 'search_workspace',
                    description: 'Keyword-search across every indexed entity in the workspace: features (clusters), routes, functions, classes, files, services. Tokenises camelCase/snake_case so "getUserById" matches "get", "user", "by", "id". Accepts either a single string ("GET user comment") OR an array of keywords (["GET","user","comment"]). Returns ranked results with score 0..1 — entity-name matches outweigh path/body matches; routes/features outrank files; entries matching more of the supplied keywords float higher; diff-recent entities get a +20% boost. Use `requireAll:true` for AND semantics (every keyword must match). Use to answer "where is X handled?" or "find everything related to <topic>" without grepping the source. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: {
                                description: 'One or more keywords. Accepts a single string (camelCase/snake_case identifiers are auto-split) OR an array of keyword strings.',
                                oneOf: [
                                    { type: 'string' },
                                    { type: 'array', items: { type: 'string' } },
                                ],
                            },
                            kinds: { type: 'array', items: { type: 'string', enum: ['feature', 'route', 'function', 'class', 'file', 'service'] }, description: 'Optional filter on entity kinds.' },
                            requireAll: { type: 'boolean', description: 'When true, only return entities that match EVERY keyword (AND). Default false → OR with coverage-boosted ranking.' },
                            limit: { type: 'number', description: 'Max results (default 20).' },
                            minScore: { type: 'number', description: 'Minimum normalised score 0..1 (default 0.05).' },
                            repoId: { type: 'string', description: 'UX-66 (2026-06-09) multi-repo MCP — scope the search to this repo (from `list_repos`). Optional.' },
                        },
                        required: ['query'],
                    } as any,
                },
                {
                    name: 'get_workspace_status',
                    description: 'Return the bootstrap status of the workspace: ready / initializing / not_a_codebase / read_only / error. Use this BEFORE other tool calls when launching against an unknown workspace — if the workspace isn\'t a codebase, every other tool returns empty data and this is the canonical place to find out why.',
                    inputSchema: { type: 'object', properties: { repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' } } } as any,
                },
                {
                    name: 'get_health_report',
                    description: 'Return the workspace HealthReport: dead functions, god files (too many symbols), high-coupling files (too many edges), cyclic dependencies, orphaned clusters. Use to answer "where is the technical debt?" without reading source. In multi-repo workspaces, pass `repoId` to scope.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            repoId: { type: 'string', description: 'ADR-034 multi-repo MCP — scope to this repo (from `list_repos`). Optional.' },
                        },
                    } as any,
                },
                {
                    name: 'get_function_source',
                    description: 'Return one function\'s source slice (signature + body) by file path + symbol name. Cheaper than get_entrypoint_pack for "show me the impl" queries — typical response is 200-2000 tokens. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            filePath: { type: 'string', description: 'File path relative to workspace root.' },
                            symbolName: { type: 'string', description: 'Function or class name within the file.' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['filePath', 'symbolName'],
                    } as any,
                },
                {
                    name: 'trace_call_path',
                    description: 'BFS the workspace call graph for the shortest path between two functions. Returns the actual edge sequence (file::fn → file::fn → …) with edge confidence + kind. Use to answer "how does GET /articles reach prisma.user.findUnique?" in one call. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            fromFile: { type: 'string', description: 'Source function\'s file path.' },
                            fromFn: { type: 'string', description: 'Source function name.' },
                            toFile: { type: 'string', description: 'Target function\'s file path.' },
                            toFn: { type: 'string', description: 'Target function name.' },
                            maxDepth: { type: 'number', description: 'Max BFS depth (default 8).' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['fromFile', 'fromFn', 'toFile', 'toFn'],
                    } as any,
                },
                {
                    name: 'get_api_surface_diff',
                    description: 'Contract-level diff between baseline and working snapshots: routes added, removed, or with changed auth/middleware. Smaller and more focused than get_diff_summary for PR/release notes. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: { type: 'object', properties: { repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' } } } as any,
                },
                // Issue #702 / #737 — onboarding tour. Two modes: `codebase`
                // (depth-first by call-graph fan-in DESC; new-contributor
                // walkthrough) and `recent` (diff-bucketed; what-changed
                // walkthrough). Returns the lite step shape so the agent
                // can render the walkthrough without needing the full UI.
                {
                    name: 'get_tour',
                    description: 'Produce a guided onboarding-tour step list (Issue #702). Two modes: `codebase` orders entry points by call-graph fan-in DESC so new contributors start at the most load-bearing routes; `recent` orders by diff status (modified → added → unchanged), then fan-in within each bucket. Each step carries a one-line "why this matters" blurb + the drill-down graphId for the corresponding L3 sequence (or L4 file when no handler name exists).',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            mode: { type: 'string', enum: ['codebase', 'recent'], description: 'Tour ordering. Default `codebase`.' },
                            maxSteps: { type: 'number', description: 'Cap on returned step count. Default 30 (~30 min reading session).' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                    } as any,
                },
                {
                    name: 'run_api_chain',
                    description: 'Issue #603 — execute a list of HTTP requests in order, carrying env vars between steps via JSONPath extraction. Each step shape: `{ id, method, url, headers?, body?, bearerToken?, apiKey?, apiKeyHeader?, extract?, assert? }`. `extract` maps `envVarName → { scope: "json"|"headers"|"status", path: "$.user.token" }` so the next step can use `{{envVarName}}`. `assert` is `{ statusEquals?, statusBetween?, bodyContains?, bodyNotContains?, hasHeader? }`. Returns `{ steps: ChainStepResult[], finalEnv, passed, failed, errored, aborted }`. Pass `stopOnFirstFailure: true` to bail at first non-2xx. URLs MUST be absolute (http:// or https://). Use this to smoke-test a deploy, run an integration chain, or verify auth + downstream call.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            steps: {
                                type: 'array',
                                description: 'Ordered list of request steps.',
                                items: { type: 'object' } as any,
                            },
                            initialEnv: {
                                type: 'object',
                                description: 'Starting env. Each step substitutes `{{var}}` against the current env at request time.',
                                additionalProperties: { type: 'string' } as any,
                            },
                            stopOnFirstFailure: { type: 'boolean', description: 'Abort after the first non-2xx / assert failure. Default false.' },
                        },
                        required: ['steps'],
                    } as any,
                },
                {
                    name: 'stream_sse',
                    description: 'Issue #604 — open an SSE (Server-Sent Events) connection, read events until eof / timeout / message cap, return the captured events. Caps: `maxEvents` (default 100, max 1000), `maxDurationMs` (default 30 s, max 5 min).',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            url:           { type: 'string' },
                            headers:       { type: 'object', additionalProperties: { type: 'string' } as any },
                            bearerToken:   { type: 'string' },
                            maxEvents:     { type: 'number' },
                            maxDurationMs: { type: 'number' },
                            env:           { type: 'object', additionalProperties: { type: 'string' } as any },
                        },
                        required: ['url'],
                    } as any,
                },
                {
                    name: 'connect_websocket',
                    description: 'Issue #604 — open a WS connection, optionally send scripted messages, capture inbound frames, close. Caps: `maxMessages` (default 100, max 1000), `maxDurationMs` (default 30 s, max 5 min).',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            url:           { type: 'string' },
                            headers:       { type: 'object', additionalProperties: { type: 'string' } as any },
                            bearerToken:   { type: 'string' },
                            subprotocols:  { type: 'array', items: { type: 'string' } as any },
                            sendMessages:  { type: 'array', items: { type: 'object' } as any },
                            maxMessages:   { type: 'number' },
                            maxDurationMs: { type: 'number' },
                            env:           { type: 'object', additionalProperties: { type: 'string' } as any },
                        },
                        required: ['url'],
                    } as any,
                },
                {
                    name: 'oauth2_token',
                    description: 'Issue #604 — exchange OAuth2 credentials for an access token. `grant: "client_credentials" | "authorization_code" | "refresh"`. Returns `{ ok, token? | error? }`.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            grant:         { type: 'string' },
                            tokenEndpoint: { type: 'string' },
                            clientId:      { type: 'string' },
                            clientSecret:  { type: 'string' },
                            scope:         { type: 'string' },
                            audience:      { type: 'string' },
                            code:          { type: 'string' },
                            redirectUri:   { type: 'string' },
                            codeVerifier:  { type: 'string' },
                            refreshToken:  { type: 'string' },
                            timeoutMs:     { type: 'number' },
                        },
                        required: ['grant', 'tokenEndpoint', 'clientId'],
                    } as any,
                },
                {
                    name: 'oauth2_authorize_url',
                    description: 'Issue #604 — assemble the OAuth2 authorization-endpoint URL the user opens in their browser. Returns `{ url, state }`. PKCE via `pkce: { codeChallenge, codeChallengeMethod }`.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            authorizationEndpoint: { type: 'string' },
                            clientId:    { type: 'string' },
                            redirectUri: { type: 'string' },
                            scope:       { type: 'string' },
                            state:       { type: 'string' },
                            responseType:{ type: 'string' },
                            pkce:        { type: 'object' } as any,
                            extra:       { type: 'object', additionalProperties: { type: 'string' } as any },
                        },
                        required: ['authorizationEndpoint', 'clientId', 'redirectUri'],
                    } as any,
                },
                {
                    name: 'import_api_collection',
                    description: 'Issue #604 Phase 4 — import an OpenAPI 3.x / Swagger 2.0 spec, a Postman v2.1 collection JSON, or an Insomnia v4 export and return an `ApiTestingPayload` (`{ totalEndpoints, collections: [{ id, label, source, endpoints }] }`). Pass the spec as parsed JSON via `spec` OR as a raw string via `specText` (the tool parses it). The auto-detector picks the right importer based on top-level fields (`openapi`/`swagger`/`paths` → OpenAPI; `info`/`item` → Postman; `_type:export`/`__export_format` → Insomnia). The returned endpoints reuse the same shape as the auto-derived L2a collections, so they can be fed straight into `run_api_chain` or merged into a test suite.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            spec:     { type: 'object', description: 'Parsed JSON spec.' },
                            specText: { type: 'string', description: 'Raw JSON / YAML text. JSON is parsed; YAML is rejected — caller must convert first.' },
                        },
                    } as any,
                },
                {
                    name: 'generate_request_body',
                    description: 'Issue #603 Phase 3.5 — propose a single JSON request body for a target endpoint. Reads the handler source from the snapshot, asks the LLM to fill in fields the handler actually uses, then strips any field whose evidence line can\'t be quoted from the handler. Sister tool of `generate_test_cases` — same client, same evidence-gate. Use when the schema inferrer produced a sparse `requestSchema` (no validator imported) and you want a starting payload. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            apiId:     { type: 'string', description: 'Target route\'s apiId.' },
                            apiKey:    { type: 'string', description: 'LLM API key.' },
                            model:     { type: 'string', description: 'Model id.' },
                            provider:  { type: 'string', description: 'openrouter | openai | anthropic | ollama | URL.' },
                            timeoutMs: { type: 'number', description: 'LLM timeout (default 20000).' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['apiId'],
                    } as any,
                },
                {
                    name: 'generate_chain',
                    description: 'Issue #603 Phase 3.5 — propose an ordered chain of requests that exercises a coherent flow (e.g. login → fetch profile → create article). Reads the workspace endpoint list, optional user `intent` string, and asks the LLM to compose a sequence with `extract` recipes carrying env vars between steps. Recipes without source-quoted evidence are dropped before return. Output is shaped to plug straight into `run_api_chain` — wrap each draft step with the actual URL after resolving `{{base}}`. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            intent:    { type: 'string', description: 'Optional flow description.' },
                            maxSteps:  { type: 'number', description: 'Cap (default 6, max 20).' },
                            apiKey:    { type: 'string' },
                            model:     { type: 'string' },
                            provider:  { type: 'string' },
                            timeoutMs: { type: 'number' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                    } as any,
                },
                {
                    name: 'generate_test_cases',
                    description: 'Issue #603 Phase 3.5 — generate evidence-gated API test cases for a route. Reads the handler source from the snapshot, calls the configured LLM with the (method, route, schema, source) bundle, and returns a structured array of `{name, preconditions, request_overrides, assertions, evidence}`. Cases the model can\'t ground in a quoted source line are dropped. Output is safe to feed directly to `run_api_chain` after wrapping each case in a step with the matching method+URL+body. Requires LLM config (apiKey/model/provider) — pass `apiKey` + `model` + `provider` directly, or rely on the workspace `codeatlas.llm*` settings. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            apiId:      { type: 'string', description: 'ApiRecord.apiId of the target route (find via `list_apis`).' },
                            maxCases:   { type: 'number', description: 'Cap on returned cases (1-20). Default 6.' },
                            apiKey:     { type: 'string', description: 'LLM API key. Defaults to the workspace LLM config.' },
                            model:      { type: 'string', description: 'Model id (e.g. `openrouter/anthropic/claude-3-haiku`).' },
                            provider:   { type: 'string', description: '`openrouter` | `openai` | `anthropic` | `ollama` | URL.' },
                            timeoutMs:  { type: 'number', description: 'LLM call timeout in ms. Default 20000.' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['apiId'],
                    } as any,
                },
                {
                    name: 'pre_edit_brief',
                    description: 'One-shot context briefing before editing a file/function. Returns the function source (if specified), all entry points that reach it, sibling functions, imports, and current diff state. Replaces 4-5 separate tool calls. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            filePath: { type: 'string', description: 'File the user is about to edit.' },
                            symbolName: { type: 'string', description: 'Optional — specific function within the file.' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['filePath'],
                    } as any,
                },
                {
                    name: 'describe_snapshot_schema',
                    description: 'Return the schema of the persisted state.db — table names, column definitions, row counts, plus inline notes on the JSON-encoded record_json / graph_json columns. Use this BEFORE calling query_snapshot to author a valid SELECT against the right columns. Deterministic, no AI involved. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: { type: 'object', properties: { repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' } } } as any,
                },
                {
                    name: 'query_snapshot',
                    description: 'Run a read-only SQL SELECT against the snapshot DB (tables: apis, graphs, files, snapshots, comments, settings). Use json_extract(record_json, \'$.path\') for JSON columns. Strict guardrails reject any non-SELECT statement, multi-statement queries, or queries touching disallowed tables. Returns { columns, rows, rowCount, truncated, executedSql }. Use to answer ad-hoc structural questions the canned tools don\'t cover.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sql: { type: 'string', description: 'A single SELECT statement (or WITH … SELECT). No DML/DDL keywords. References only allowed tables.' },
                            limit: { type: 'number', description: 'Max rows returned (default 100, cap 1000).' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['sql'],
                    } as any,
                },
                {
                    name: 'list_entrypoints_paged',
                    description: 'Paginated version of list_entrypoints. Returns { items, total, nextCursor, truncated, tokenEstimate }. Use for repos with hundreds/thousands of routes where a single full list would exceed the LLM context. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            method: { type: 'string' },
                            clusterId: { type: 'string' },
                            serviceId: { type: 'string' },
                            authRequired: { type: 'boolean' },
                            onlyChanged: { type: 'boolean' },
                            routeContains: { type: 'string' },
                            cursor: { type: 'number', description: 'Offset to resume from (default 0).' },
                            limit: { type: 'number', description: 'Max items per page (default 50, cap 500).' },
                            maxResponseTokens: { type: 'number', description: 'Hard cap on tokens — truncates the page if items are large.' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                    } as any,
                },
                {
                    name: 'list_architecture_violations',
                    description: 'Run architecture rules against the workspace. Built-in rules: auth_required_on_writes, every_cluster_has_a_service, no_god_files, no_cyclic_dependencies, no_dead_functions, webhook_routes_have_signature_verification. Custom rules can be added via .codeatlas/rules.json. Returns { rules, violations } where each violation includes severity + location. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            rules: { type: 'array', items: { type: 'string' }, description: 'Optional subset of rule ids to run. Default: all.' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                    } as any,
                },
                {
                    name: 'get_coverage_overlay',
                    description: 'If LCOV / Istanbul coverage is loaded for the workspace, return per-file line + function + branch coverage rates plus an aggregate. Returns null when no coverage data is available. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: { type: 'object', properties: { repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' } } } as any,
                },
                {
                    name: 'find_similar_entities',
                    description: 'Find structurally similar entities to the given id. For routes: same method, same path shape, overlapping middleware chain. For clusters: similar size + same service. Useful for "show me the most-similar existing route" before adding a new one.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'apiId or clusterId.' },
                            limit: { type: 'number', description: 'Max results (default 10).' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['id'],
                    } as any,
                },
                {
                    name: 'list_saved_views',
                    description: 'List user-saved query views from .codeatlas/saved-queries.json. Each view has an id, optional description, and a SQL string that query_snapshot can execute.',
                    inputSchema: { type: 'object', properties: {} } as any,
                },
                {
                    name: 'export_openapi_spec',
                    description: 'Export every MCP tool as an OpenAPI 3.1 path so non-MCP clients (custom GPTs, OpenAI assistants, Anthropic tool use) can consume the same surface via HTTP-style descriptors.',
                    inputSchema: { type: 'object', properties: {} } as any,
                },
                {
                    name: 'export_function_calling_spec',
                    description: 'Export every MCP tool in OpenAI / Anthropic function-calling format (name, description, parameters). Drop-in for tool-use APIs that don\'t speak MCP.',
                    inputSchema: { type: 'object', properties: {} } as any,
                },
                {
                    name: 'compare_workspaces',
                    description: 'Open another workspace\'s state.db and compare its API surface to this one. Returns entry points only-in-left / only-in-right / shared, plus service + cluster overlap. Useful for fork-vs-upstream or service-vs-consumer comparisons.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            otherWorkspaceRoot: { type: 'string', description: 'Absolute path to the other workspace root containing a .codeatlas/state.db.' },
                        },
                        required: ['otherWorkspaceRoot'],
                    } as any,
                },
                {
                    name: 'summarise_payload',
                    description: 'Compress a heavy MCP payload (entry-point pack, diff summary, impact list, health report) into a 3-7 bullet extractive brief. Deterministic — no LLM call. Use when the caller is a small-context LLM and needs the gist, not the full JSON.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            input: { description: 'The payload to summarise (any JSON object).' },
                            maxBullets: { type: 'number', description: 'Max bullets (default 6).' },
                        },
                        required: ['input'],
                    } as any,
                },
                {
                    name: 'get_feature_pack',
                    description: 'Return a feature-cluster-level context pack: every entry point in the cluster, subsystems it talks to, member files, and current diff state. Use to ground "explain feature X" or "what does the article module do" questions without reading the whole cluster. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            clusterId: { type: 'string', description: 'Feature cluster id (e.g. cluster:article).' },
                            includeBaselineDiff: { type: 'boolean', description: 'If true, include diff vs baseline.' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['clusterId'],
                    } as any,
                },
                // ─── AI review tools (#506 — Tier-1 MCP tools for AI review) ───────────────────────────────
                {
                    name: 'list_ai_findings',
                    description: 'List AI-review findings on the workspace. Filter by layer graphId (e.g. "sequence:src/app/article/article.controller.ts:create"), entryPointId ("POST:/api/articles"), severity, status, or category. Returns ranked finding cards with title, body, severity, category, bindings (layers this finding touches), and anchor (filePath/symbol). Use BEFORE editing code to surface AI-flagged issues on the affected entry point. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            graphId: { type: 'string', description: 'Filter to findings bound to a specific layer (any of L1-L5 graphIds).' },
                            entryPointId: { type: 'string', description: 'Filter to findings on a specific entry point (e.g. POST:/api/articles).' },
                            severity: { type: 'string', enum: ['info', 'warning', 'error'] },
                            status: { type: 'string', enum: ['open', 'resolved', 'ignored'] },
                            limit: { type: 'number', description: 'Max items (default 50, cap 500).' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                    } as any,
                },
                {
                    name: 'get_ai_finding',
                    description: 'Return a single AI-review finding by id. Includes the full body, all layer bindings, the anchor (filePath/symbol/span) for editor navigation, and the guidelines hash that produced it. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            findingId: { type: 'string' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['findingId'],
                    } as any,
                },
                {
                    name: 'get_ai_finding_counts',
                    description: 'Aggregate open AI-review finding counts. Useful for surfacing per-layer / per-entry-point badges. Returns counts grouped by graphId (each layer chip), by entryPointId, and by severity. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            status: { type: 'string', enum: ['open', 'resolved', 'ignored'], description: 'Default: open.' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                    } as any,
                },
                {
                    name: 'update_ai_finding_status',
                    description: 'Mark an AI-review finding as resolved, ignored, or re-open it. Refused in read-only mode. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            findingId: { type: 'string' },
                            status: { type: 'string', enum: ['open', 'resolved', 'ignored'] },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['findingId', 'status'],
                    } as any,
                },
                {
                    name: 'get_review_guidelines',
                    description: 'Return the user-supplied review guidelines text that gets injected into every AI review prompt. Empty string if not set. Includes the hash (for cache invalidation) and the last-updated timestamp. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: { type: 'object', properties: { repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' } } } as any,
                },
                {
                    name: 'set_review_guidelines',
                    description: 'Replace the user-supplied review guidelines text (≤8 KB; control characters stripped). The new guidelines get used on the next AI review run. Refused in read-only mode.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            text: { type: 'string', description: 'Guidelines text (≤8 KB).' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['text'],
                    } as any,
                },
                {
                    name: 'search_ai_findings',
                    description: 'Natural-language search over AI-review findings. The query is intent-parsed (e.g. "show me findings about the article create flow" → entry-point scope; "what is wrong with auth" → cluster scope), then matched against findings via keyword + scope filters. Returns the ranked matches. Lighter-weight than calling list_ai_findings yourself when you only have a fuzzy intent. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'Natural-language query.' },
                            limit: { type: 'number', description: 'Max results (default 20).' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['query'],
                    } as any,
                },
                // ─── AI review Tier-2 (#507 — Tier-2 MCP tools (agent leverage)) ──────────────────────────────
                {
                    name: 'review_and_fix_pack',
                    description: 'One-shot context bundle for an agent that wants to FIX a finding. Returns the finding + the entry-point pack (handler source slice, sequence participants, file imports, flow steps) + any user comments touching the same target. Use as the single input to a code-edit prompt. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: { findingId: { type: 'string' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                         },
                        required: ['findingId'],
                    } as any,
                },
                {
                    name: 'summarise_findings',
                    description: 'Deterministic extractive summary of findings filtered by scope (graphId / entryPointId / category). Useful for small-context LLMs that just need the gist. Returns bullets + counts.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            graphId: { type: 'string' },
                            entryPointId: { type: 'string' },
                            maxBullets: { type: 'number', description: 'Default 6.' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                    } as any,
                },
                {
                    name: 'list_findings_by_guideline',
                    description: 'Group findings by the guideline hash that produced them. Surfaces which user guidelines are actually pulling weight vs. which produce no findings. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: { guidelinesHash: { type: 'string', description: 'Optional — restrict to one guideline-set hash.' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                         },
                    } as any,
                },
                {
                    name: 'clear_findings',
                    description: 'Wipe AI-review findings within a scope (all / cluster / entry-point). Useful before a fresh re-run. Refused in read-only mode.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            scope: { type: 'string', enum: ['all', 'cluster', 'entry'] },
                            clusterId: { type: 'string' },
                            entryPointId: { type: 'string' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                    } as any,
                },
                {
                    name: 'get_review_summary',
                    description: 'Aggregate review run state: total findings by layer + severity, last guidelines hash, plus a sample of the most-severe items. Single low-token call to answer "how is the review looking?". In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: { type: 'object', properties: { repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' } } } as any,
                },
                // ─── #517/#518/#519 advanced AI workflow tools ─────────────
                {
                    name: 'score_findings',
                    description: 'Rank existing AI-review findings against a natural-language query. Deterministic by default (keyword + scope match); when an LLM key is available, the request is sent to the LLM for semantic re-ranking. Returns [{findingId, score 0-1, reason}].',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'Natural-language query (e.g. "anything fishy in auth?").' },
                            findingIds: { type: 'array', items: { type: 'string' }, description: 'Optional — restrict scoring to this subset. Default: all open findings.' },
                            threshold: { type: 'number', description: 'Min score 0-1 to include in the result (default 0.2).' },
                            limit: { type: 'number', description: 'Max results (default 20).' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['query'],
                    } as any,
                },
                {
                    name: 'propose_guideline_from_finding',
                    description: 'Given a finding the user agrees with, propose a one-line guideline that would have caused it. The user can review + add via set_review_guidelines. Returns { proposedGuideline, rationale }. In multi-repo workspaces, pass `repoId` to scope; defaults to the primary repo.',
                    inputSchema: {
                        type: 'object',
                        properties: { findingId: { type: 'string' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                         },
                        required: ['findingId'],
                    } as any,
                },
                {
                    name: 'review_diff_with_baseline',
                    description: 'Run an AI review limited to entry points whose diff status is not "unchanged" (i.e. changed in the current working snapshot vs. baseline). Faster than a full review and focuses the model on what actually changed. Refused in read-only mode.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            scope: { type: 'string', enum: ['changed', 'cluster', 'entry'], description: 'Restricts which entry points to review (default: changed).' },
                            clusterId: { type: 'string' },
                            entryPointId: { type: 'string' },
                            repoId: { type: 'string', description: 'UX-66 multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                    } as any,
                },
                {
                    name: 'get_review_context',
                    description: 'Assemble the code-review context for a diff, branch, PR, or the working tree so YOU (the calling LLM) can review it with CodeAtlas precision. Returns the reviewer instructions (bug-class taxonomy + cross-file DEPENDENTS reasoning + the #948–#952 PRECISION GATES that suppress false positives), the changed-file set, the unified diff, per-entry packs (handler diff + call chain) for changed entry points, diff windows of changed files, and cross-file callers/implementers/tests. Source kinds: "pr"/"diff" (base + head refs), "branch" (a branch vs its base, default branch auto-detected), "working" (uncommitted changes vs HEAD). After reviewing, pass your findings through `filter_review_findings` to drop false positives.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            source: {
                                type: 'object',
                                description: 'What to review.',
                                properties: {
                                    kind: { type: 'string', enum: ['pr', 'diff', 'branch', 'working'], description: 'pr/diff = base..head; branch = a branch vs base; working = uncommitted vs HEAD.' },
                                    base: { type: 'string', description: 'Base ref/branch/sha (pr, diff; optional for branch — defaults to the detected default branch).' },
                                    head: { type: 'string', description: 'Head ref/branch/sha (pr, diff). Defaults to HEAD.' },
                                    branch: { type: 'string', description: 'Branch to review (branch kind). Defaults to HEAD.' },
                                },
                                required: ['kind'],
                            },
                            guidelines: { type: 'string', description: 'Optional review guidelines to fold into the instructions (otherwise the stored guidelines are used).' },
                            repoId: { type: 'string', description: 'Multi-repo MCP — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                        required: ['source'],
                    } as any,
                },
                {
                    name: 'filter_review_findings',
                    description: 'Deterministic false-positive filter for review findings (#949 off-diff, #951 test-nit, #953 dedup) — the SAME backstop the extension and PR-watcher apply. Pass your findings (each with anchor.filePath, optional anchor.symbol/lineStart/lineEnd, severity, title) plus the changed-file set; returns the kept findings and the dropped ones with a reason. Empty changedFiles disables the off-diff gate (dedup + test-nit still apply).',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            findings: { type: 'array', items: { type: 'object' }, description: 'Findings to filter. Each: { title, severity, anchor: { filePath, symbol?, lineStart?, lineEnd? } }.' },
                            changedFiles: { type: 'array', items: { type: 'string' }, description: 'The PR/diff changed-file set for the off-diff gate. Empty → off-diff disabled.' },
                        },
                        required: ['findings'],
                    } as any,
                },
                {
                    name: 'run_review',
                    description: 'RUN a full AI code review over the current snapshot using the LLM YOU configured for this workspace (model + provider + API key set in the extension settings or the MCP/standalone config — no key needs to be passed here), apply the shared dedup + false-positive filter (#949/#951/#953), and return the finalized findings — the SAME engine the extension and PR-watcher use, for true parity. scope "changed" (default) reviews working-vs-baseline changes; "all" reviews the whole workspace (slower). Writes findings to the store; refused in read-only mode or when no LLM is configured. For just the review CONTEXT to review yourself (no server LLM call), use get_review_context instead.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            scope: { type: 'string', enum: ['changed', 'all'], description: 'changed (default) = working-vs-baseline diff; all = entire workspace.' },
                            repoId: { type: 'string', description: 'Multi-repo — scope to this repo (from `list_repos`). Optional; defaults to the primary repo.' },
                        },
                    } as any,
                },
            ];

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        // #857 — surface only agent-relevant tools by default. The hidden set
        // is interactive-UI / workbench / human-triage surface that an AI
        // coding agent never drives (it still powers the browser workbench +
        // CallTool handlers — only `tools/list` is filtered). Set
        // CODEATLAS_MCP_ALL_TOOLS=1 to expose the full registry.
        const tools = process.env.CODEATLAS_MCP_ALL_TOOLS === '1'
            ? allTools
            : allTools.filter((t) => !AGENT_HIDDEN_TOOLS.has(t.name));
        return { tools };
    });

    /**
     * Append the product attribution as a SEPARATE content block.
     *
     * Deliberately not concatenated into the existing text: most tools return
     * a JSON document in `content[0].text`, and appending to it would corrupt
     * every client that parses it. A second `text` block is protocol-legal;
     * clients that only read `content[0]` simply ignore it, and clients that
     * surface the whole response (Claude, Cursor) show the attribution in the
     * assistant's context -- which is the point.
     *
     * Skipped for error results, where a trailing marketing line is noise.
     */
    const withAttribution = (result: any) => {
        if (!result || !Array.isArray(result.content) || result.isError) return result;
        return { ...result, content: [...result.content, { type: 'text', text: ATTRIBUTION_TEXT }] };
    };

    const callToolHandlerRaw = async (request: any) => {
        const { name, arguments: args } = request.params;

        // MCP-EVAL-3: validate the tool's `inputSchema.required` BEFORE dispatch.
        // Without this, a client that omits a required arg reaches the handler
        // with `undefined` and crashes with a cryptic TypeError (e.g.
        // `oauth2_authorize_url` → "Cannot read properties of undefined (reading
        // 'includes')"). Return a clean, actionable error instead.
        const toolDef = allTools.find((t) => t.name === name);
        const requiredArgs: string[] = ((toolDef?.inputSchema as any)?.required as string[] | undefined) ?? [];
        if (requiredArgs.length > 0) {
            const missing = requiredArgs.filter((k) => args == null || (args as Record<string, unknown>)[k] === undefined);
            if (missing.length > 0) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Error: missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. See this tool's inputSchema for the expected shape.` }],
                };
            }
        }

        const snapshot = snapshotStore.getWorking();

        // ADR-034 multi-repo MCP — `args.repoId` lets a tool scope to a
        // specific repo in multi-repo workspaces. Defaults to the primary
        // (configured via --repo argv at server start, else alphabetically
        // first). Returns the requested per-repo Snapshot or the default
        // when repoId is unset / not found / workspace is single-repo.
        const resolveSnap = (a: any): typeof snapshot => {
            const repoId = a?.repoId as string | undefined;
            if (!repoId) return snapshot;
            const getMulti = (snapshotStore as any).__multiRepo as undefined | (() => any);
            const multi = getMulti?.();
            if (!multi) return snapshot;
            const store = multi.repoStores.get(repoId);
            return store ? store.getWorking() : snapshot;
        };
        // Same as resolveSnap but returns the SnapshotStore itself for tools
        // that call methods on the store (findings, signatures, cursors).
        const resolveStoreForRepo = (a: any): typeof snapshotStore => {
            const repoId = a?.repoId as string | undefined;
            if (!repoId) return snapshotStore;
            const getMulti = (snapshotStore as any).__multiRepo as undefined | (() => any);
            const multi = getMulti?.();
            if (!multi) return snapshotStore;
            return (multi.repoStores.get(repoId) as typeof snapshotStore | undefined) ?? snapshotStore;
        };

        /**
         * #MCP-AUDIT-3 (2026-06-07): preflight check for the LLM-driven
         * generator tools. Without this, every `generate_*` call bubbled
         * a raw `openrouter 401: No cookie auth credentials found` when no
         * API key was set — confusing for new users hitting these tools
         * via Claude Desktop / Cursor before configuring OpenRouter.
         *
         * Returns a user-facing message when the request can't proceed,
         * or `null` when we should attempt the call. Keyless providers
         * (Ollama running locally, custom OpenAI-compatible endpoints)
         * skip the key check.
         */
        const preflightLlmAuth = (a: { apiKey?: string; provider?: string }): string | null => {
            const provider = a.provider ?? 'openrouter';
            const keylessProviders = new Set(['ollama', 'custom']);
            if (keylessProviders.has(provider)) return null;
            const envKey = (process.env.CODEATLAS_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '').trim();
            const key = ((a.apiKey ?? '').trim()) || envKey;
            if (key) {
                // Backfill the env-resolved key onto the args object so
                // downstream code picks it up without each tool repeating
                // the env-resolution dance.
                if (!a.apiKey && envKey) a.apiKey = envKey;
                return null;
            }
            return (
                `Error: no LLM API key supplied. ` +
                `This tool calls the ${provider} chat-completions API and needs a key. ` +
                `Either pass \`apiKey\` directly, set the \`CODEATLAS_OPENROUTER_API_KEY\` ` +
                `(or \`OPENROUTER_API_KEY\`) environment variable, or switch to a keyless ` +
                `provider with \`provider: "ollama"\` (requires Ollama running locally) or ` +
                `\`provider: "custom"\` (requires a self-hosted OpenAI-compatible endpoint).`
            );
        };

        // ADR-034 multi-repo MCP — `list_repos` returns the aggregator's
        // repo registry so MCP clients can discover available repos in a
        // multi-repo workspace and pick one via `--repo <name>` on restart.
        if (name === 'list_repos') {
            try {
                const getMulti = (snapshotStore as any).__multiRepo as undefined | (() => any);
                const multi = getMulti?.();
                if (!multi) {
                    // Single-repo workspace — synthesize a single entry from
                    // the active store so clients get a uniform shape.
                    const working = snapshotStore.getWorking();
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                mode: 'single',
                                primaryRepoId: null,
                                repos: [{
                                    repoId: null,
                                    name: '<workspace>',
                                    rootPath: '',
                                    status: 'ready',
                                    diff: null,
                                    fileCount: Object.keys(working.files ?? {}).length,
                                    apiCount: Object.keys(working.apiIndex ?? {}).length,
                                }],
                            }, null, 2),
                        }],
                    };
                }
                const rows = multi.repos.map((r: any) => {
                    const repoStore = multi.repoStores.get(r.repoId);
                    const working = repoStore?.getWorking?.() ?? { files: {}, apiIndex: {} };
                    return {
                        repoId: r.repoId,
                        name: r.name,
                        rootPath: r.rootPath,
                        status: r.status,
                        diff: r.diff,
                        fileCount: Object.keys(working.files ?? {}).length,
                        apiCount: Object.keys(working.apiIndex ?? {}).length,
                    };
                });
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            // UX-58 (2026-06-06) — `mode` reflects the
                            // shape of the workspace, not whether the
                            // aggregator's monorepo.db happens to exist.
                            // A workspace with one registered repo IS
                            // single-repo from a UX standpoint; reporting
                            // 'multi' there confuses clients picking a
                            // scope.
                            mode: rows.length > 1 ? 'multi' : 'single',
                            primaryRepoId: multi.primaryRepoId,
                            repos: rows,
                        }, null, 2),
                    }],
                };
            } catch (err: any) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Error listing repos: ${err.message}` }],
                };
            }
        }

        if (name === 'get_impact_analysis' && args) {
            const filePaths = args.filePaths as string[];
            try {
                const snap = resolveSnap(args);
                const impactResult = analyzeImpact(filePaths, snap);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(impactResult, null, 2),
                        },
                    ],
                };
            } catch (err: any) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Error computing impact: ${err.message}` }],
                };
            }
        }

        if (name === 'get_function_dependencies' && args) {
            const { filePath, symbolName, direction, depth = 1 } = args as any;
            try {
                const snap = resolveSnap(args);
                const fileRec = snap.files[filePath];
                if (!fileRec) {
                    throw new Error(`File not found in index: ${filePath}`);
                }
                let hasSymbol = fileRec.symbols.functions.some(f => f.name === symbolName) ||
                    fileRec.symbols.variables.some(v => v.name === symbolName);
                // #MCP-AUDIT-1 (2026-06-07): fall back to apiIndex. The
                // symbol extractor only sees top-level functions / vars;
                // route handlers that are local-variable bindings (CDK
                // resource handlers like `recordsResource`) or arrow
                // functions passed inline to `router.delete(handler)` —
                // the JS / TS apiDetector still catches them and records
                // a handlerName, but they never make it into
                // `fileRec.symbols.functions`. Without this fallback the
                // canonical "row from list_entrypoints → get_function_
                // dependencies" chain breaks for every such route. We
                // accept the lookup when the apiIndex has a matching
                // handlerName for the same file; the call graph still
                // resolves the node via `makeKey(filePath, symbolName)`
                // because the detector emits the same key.
                if (!hasSymbol) {
                    const matchesApi = Object.values(snap.apiIndex ?? {}).some(
                        (api) => api.filePath === filePath && api.handlerName === symbolName,
                    );
                    if (matchesApi) hasSymbol = true;
                }
                if (!hasSymbol) {
                    throw new Error(`Symbol '${symbolName}' not found in ${filePath}`);
                }

                const result: any[] = [];
                const graph = WorkspaceCallGraph.deserialize(snap.callGraph as any);
                const nodeKey = WorkspaceCallGraph.makeKey(filePath, symbolName);

                if (direction === 'upstream') {
                    const callers = graph.getImpacted([nodeKey], depth);
                    for (const { key, depth: d } of callers) {
                        const callerNode = graph.getNode(key);
                        if (callerNode) {
                            result.push({
                                name: callerNode.functionName,
                                file: callerNode.filePath,
                                depth: d,
                            });
                        }
                    }
                } else {
                    const calls = graph.getReachable(nodeKey, depth);
                    for (const { key, depth: d } of calls) {
                        const callNode = graph.getNode(key);
                        if (callNode) {
                            result.push({
                                name: callNode.functionName,
                                file: callNode.filePath,
                                depth: d,
                            });
                        }
                    }
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            } catch (err: any) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Error resolving dependencies: ${err.message}` }],
                };
            }
        }

        // ── New entry-point / context-pack tools ──────────────────────
        if (name === 'list_entrypoints') {
            try {
                const filter: EntryPointFilter = (args ?? {}) as EntryPointFilter;
                let snap = resolveSnap(args);
                // #834 (2026-06-11) — the documented multi-repo DEFAULT is
                // the MERGED set across every sub-repo (#825 contract);
                // the implementation was returning the primary repo's set
                // only. With no `repoId`, union per-repo apiIndexes into a
                // synthetic snapshot. `repoId` still scopes to one repo.
                if (!(args as any)?.repoId) {
                    const getMulti = (snapshotStore as any).__multiRepo as undefined | (() => any);
                    const multi = getMulti?.();
                    if (multi && multi.repoStores?.size > 1) {
                        const mergedApiIndex: Record<string, any> = {};
                        for (const store of multi.repoStores.values()) {
                            try {
                                const w = store.getWorking();
                                for (const [id, rec] of Object.entries(w.apiIndex ?? {})) {
                                    if (!mergedApiIndex[id]) mergedApiIndex[id] = rec;
                                }
                            } catch { /* skip unreadable repo store */ }
                        }
                        snap = { ...snap, apiIndex: mergedApiIndex };
                    }
                }
                const eps = listEntryPoints(snap, filter);
                return { content: [{ type: 'text', text: JSON.stringify(eps, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'get_entrypoint_pack' && args) {
            try {
                const a = args as any;
                const { method: m, route, includeHandlerSource } = a;
                // Helpful error for the most common mistake: callers
                // (incl. early-2026 LLM clients) often guess `apiId` /
                // `entryPointId` / `handlerName` from the shape of
                // `list_entrypoints` rows. Surface the actual required
                // shape so the model can self-correct without a doc dive.
                if (!m || !route) {
                    const got = Object.keys(a).join(', ') || '(no args)';
                    return {
                        isError: true,
                        content: [{
                            type: 'text',
                            text:
                                `get_entrypoint_pack: missing required fields. ` +
                                `Expected { method: "GET|POST|PUT|PATCH|DELETE|JOB|...", route: "/api/path/:param" }; ` +
                                `got { ${got} }. ` +
                                `Tip: each row from \`list_entrypoints\` already has \`method\` + \`route\` — pass those.`,
                        }],
                    };
                }
                const snap = resolveSnap(args);
                const scopedStore = resolveStoreForRepo(args);
                const workspaceFileContent = includeHandlerSource
                    ? (p: string) => scopedStore.getFileContent('working', p)
                    : undefined;
                const pack = getEntryPointPack(snap, m, route, { workspaceFileContent });
                if (!pack) {
                    // Got both args, but no match. Show a few near-by routes
                    // so the model can correct a typo without listing all 27.
                    const all = listEntryPoints(snap);
                    const sameMethod = all.filter(e => e.method === m).slice(0, 5);
                    const hint = sameMethod.length > 0
                        ? ` Routes with method ${m}: ${sameMethod.map(e => e.route).join(', ')}${all.filter(e => e.method === m).length > 5 ? ', …' : ''}.`
                        : ` No routes with method ${m} found. Try \`list_entrypoints\` to see available routes.`;
                    return {
                        isError: true,
                        content: [{
                            type: 'text',
                            text: `Entry point not found: ${m} ${route}.${hint}`,
                        }],
                    };
                }
                return { content: [{ type: 'text', text: JSON.stringify(pack, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'get_diff_summary') {
            try {
                const snap = resolveSnap(args);
                const scopedStore = resolveStoreForRepo(args);
                const baseline = scopedStore.getBaseline();
                const summary = getDiffSummary(snap, baseline);
                return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'list_overlays' || name === 'get_overlay') {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { OverlayService } = require('../core/overlays/overlayService');
                const scopedStore = resolveStoreForRepo(args);
                const svc = new OverlayService({
                    workspaceRoot: scopedStore.getWorkspaceRoot(),
                    getWorking: () => scopedStore.getWorking(),
                    getBaseline: () => scopedStore.getBaseline(),
                    getFileContent: (fp: string) => scopedStore.getFileContent('working', fp),
                });
                if (name === 'list_overlays') {
                    return { content: [{ type: 'text', text: JSON.stringify(svc.stateMessage().overlays, null, 2) }] };
                }
                const id = String((args as any)?.id ?? '');
                const raw = await svc.rawPoints(id);
                if (!raw) {
                    return { isError: true, content: [{ type: 'text', text: `Error: unknown overlay "${id}". Use list_overlays.` }] };
                }
                const payload = raw.points.length === 0
                    ? { points: [], empty: true, emptyHint: raw.emptyHint }
                    : { points: raw.points, empty: false };
                return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'get_regression_scope') {
            try {
                const snap = resolveSnap(args);
                const scopedStore = resolveStoreForRepo(args);
                const baseline = scopedStore.getBaseline();
                let coverage = null;
                try { coverage = loadCoverageData(scopedStore.getWorkspaceRoot()); } catch { /* optional */ }
                // Multi-repo: cross-repo consumers via the shared #817.1
                // helper — pre-filtered to edges TARGETING the scoped repo,
                // with consumer repoIds resolved to names. (The raw edge
                // rows carry registry hex ids; matching them against the
                // display name was the original latent mismatch.)
                let crossRepoEdges: Array<{ sourceRepo: string; targetRepo: string; method: string; route: string }> = [];
                let repoName: string | undefined;
                if ((args as any)?.includeCrossRepo) {
                    const getMulti = (snapshotStore as any).__multiRepo as undefined | (() => any);
                    const multi = getMulti?.();
                    if (multi) {
                        const repoId = (args as any)?.repoId ?? multi.primaryRepoId;
                        repoName = multi.repos.find((r: any) => r.repoId === repoId || r.name === repoId)?.name ?? repoId;
                        crossRepoEdges = listCrossRepoEdgesForProducer(multi.aggregator, repoId)
                            .map((e) => ({ sourceRepo: e.consumerRepoName, targetRepo: repoName!, method: e.method, route: e.route }));
                    }
                }
                const scope = computeRegressionScope({
                    working: snap, baseline, coverage, crossRepoEdges, repoName,
                    maxDepth: (args as any)?.maxDepth,
                });
                return { content: [{ type: 'text', text: JSON.stringify(scope, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'get_impact_of_change' && args) {
            try {
                const { filePath, functionName } = args as any;
                const snap = resolveSnap(args);
                const result = getImpactOfChange(snap, filePath, functionName);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'search_workspace' && args) {
            try {
                const { query, kinds, limit, minScore, requireAll } = args as any;
                const snap = resolveSnap(args);
                const results = searchWorkspace(snap, query, {
                    kinds: kinds as SearchEntityKind[] | undefined,
                    limit,
                    minScore,
                    requireAll,
                });
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'get_workspace_status') {
            try {
                const getter = (snapshotStore as any).__bootstrapStatus as (() => unknown) | undefined;
                const status: any = typeof getter === 'function' ? getter() : { status: 'unknown', note: 'bootstrap not attached — running in legacy mode' };
                // ADR-034 — surface multi-repo state alongside the bootstrap status.
                const getMulti = (snapshotStore as any).__multiRepo as undefined | (() => any);
                const multi = getMulti?.();
                if (multi) {
                    status.workspaceMode = 'multi';
                    status.repoCount = multi.repos.length;
                    status.primaryRepoId = multi.primaryRepoId;
                } else {
                    status.workspaceMode = 'single';
                }
                return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'get_health_report') {
            try {
                const snap = resolveSnap(args);
                const report = getHealthReport(snap);
                if (!report) return { content: [{ type: 'text', text: '{"note":"no health report in snapshot — workspace may not have been analysed yet"}' }] };
                return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'get_function_source' && args) {
            try {
                const { filePath, symbolName } = args as any;
                const snap = resolveSnap(args);
                const scopedStore = resolveStoreForRepo(args);
                const result = getFunctionSource(snap, filePath, symbolName, (p) =>
                    scopedStore.getFileContent('working', p),
                );
                if (!result) {
                    return { isError: true, content: [{ type: 'text', text: `Function not found: ${filePath}::${symbolName}` }] };
                }
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'trace_call_path' && args) {
            try {
                const { fromFile, fromFn, toFile, toFn, maxDepth } = args as any;
                const snap = resolveSnap(args);
                const result = traceCallPath(snap, fromFile, fromFn, toFile, toFn, maxDepth);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'get_api_surface_diff') {
            try {
                const snap = resolveSnap(args);
                const scopedStore = resolveStoreForRepo(args);
                const result = getApiSurfaceDiff(snap, scopedStore.getBaseline());
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // Issue #702 / #737 — onboarding tour.
        if (name === 'get_tour') {
            try {
                const { buildTour, toLiteSteps } = await import('../core/analysis/tourBuilder');
                const a = (args ?? {}) as { mode?: 'codebase' | 'recent'; maxSteps?: number; repoId?: string };
                const mode = a.mode === 'recent' ? 'recent' : 'codebase';
                // For 'recent' mode the analyzer needs to know which apiIds
                // existed in the baseline so it can flag the new ones as
                // `added`. Without a baseline diff handy here we pass the
                // baseline's apiIndex keys — the cheapest available signal.
                const snap = resolveSnap(args);
                const scopedStore = resolveStoreForRepo(args);
                const baseline = scopedStore.getBaseline();
                const baselineApiIds = mode === 'recent'
                    ? new Set(Object.keys(baseline?.apiIndex ?? {}))
                    : undefined;
                const steps = buildTour(snap, mode, {
                    maxSteps: a.maxSteps,
                    baselineApiIds,
                });
                const lite = toLiteSteps(steps);
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ mode, count: lite.length, steps: lite }, null, 2),
                    }],
                };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // Issue #603 — collection chain runner.
        if (name === 'run_api_chain' && args) {
            try {
                const { runChain } = await import('../core/apiTesting/runChain');
                const a = args as {
                    steps?: unknown[];
                    initialEnv?: Record<string, string>;
                    stopOnFirstFailure?: boolean;
                };
                const result = await runChain({
                    steps: (a.steps ?? []) as any,
                    initialEnv: a.initialEnv ?? {},
                    stopOnFirstFailure: Boolean(a.stopOnFirstFailure),
                });
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2),
                    }],
                };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // Issue #604 — SSE client.
        if (name === 'stream_sse' && args) {
            try {
                const { streamSse } = await import('../core/apiTesting/sse');
                const a = args as any;
                const out = await streamSse({
                    url: a.url, headers: a.headers, env: a.env,
                    bearerToken: a.bearerToken,
                    maxEvents: a.maxEvents, maxDurationMs: a.maxDurationMs,
                });
                return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // Issue #604 — WebSocket client.
        if (name === 'connect_websocket' && args) {
            try {
                const { connectWebSocket } = await import('../core/apiTesting/ws');
                const a = args as any;
                const out = await connectWebSocket({
                    url: a.url, headers: a.headers, env: a.env,
                    bearerToken: a.bearerToken,
                    subprotocols: a.subprotocols,
                    sendMessages: a.sendMessages,
                    maxMessages: a.maxMessages, maxDurationMs: a.maxDurationMs,
                });
                return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // Issue #604 — OAuth2 token exchange.
        if (name === 'oauth2_token' && args) {
            try {
                const oauth = await import('../core/apiTesting/oauth2');
                const a = args as any;
                let result: unknown;
                if (a.grant === 'client_credentials') {
                    result = await oauth.clientCredentialsGrant(a);
                } else if (a.grant === 'authorization_code') {
                    result = await oauth.authorizationCodeGrant(a);
                } else if (a.grant === 'refresh') {
                    result = await oauth.refreshGrant(a);
                } else {
                    return { isError: true, content: [{ type: 'text', text: `Error: unknown grant "${a.grant}". Use client_credentials / authorization_code / refresh.` }] };
                }
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // Issue #604 — OAuth2 authorize URL builder.
        if (name === 'oauth2_authorize_url' && args) {
            try {
                const { buildAuthorizationUrl } = await import('../core/apiTesting/oauth2');
                const result = buildAuthorizationUrl(args as any);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // Issue #604 Phase 4 — import API collection / spec.
        if (name === 'import_api_collection' && args) {
            try {
                const a = args as { spec?: unknown; specText?: string };
                let raw: unknown = a.spec;
                if (raw === undefined && typeof a.specText === 'string') {
                    try { raw = JSON.parse(a.specText); }
                    catch { return { isError: true, content: [{ type: 'text', text: 'Error: specText is not valid JSON.' }] }; }
                }
                if (raw === undefined) {
                    return { isError: true, content: [{ type: 'text', text: 'Error: pass either `spec` (parsed JSON) or `specText` (raw JSON string).' }] };
                }
                const { importApiCollection } = await import('../core/apiTesting/importers');
                const result = importApiCollection(raw);
                if (!result) {
                    return { isError: true, content: [{ type: 'text', text: 'Error: spec format not recognised. Expected OpenAPI 3.x / Swagger 2.0 / Postman v2.1 / Insomnia v4.' }] };
                }
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2),
                    }],
                };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // Issue #603 Phase 3.5 — LLM-driven request-body generator.
        if (name === 'generate_request_body' && args) {
            try {
                const a = args as { apiId: string; apiKey?: string; model?: string; provider?: string; timeoutMs?: number; repoId?: string };
                const keyErr = preflightLlmAuth(a);
                if (keyErr) return { isError: true, content: [{ type: 'text', text: keyErr }] };
                const snap = resolveSnap(args);
                const scopedStore = resolveStoreForRepo(args);
                const api = snap.apiIndex?.[a.apiId];
                if (!api) return { isError: true, content: [{ type: 'text', text: `Error: apiId ${a.apiId} not found.` }] };
                const handlerSource = scopedStore.getFileContent('working', api.filePath) ?? '';
                if (!handlerSource) return { isError: true, content: [{ type: 'text', text: `Error: handler source not available.` }] };
                const { generateRequestBody } = await import('../core/apiTesting/aiTestGen/generateRequestBody');
                const { toEndpoint } = await import('../core/apiTesting/buildFromApiRecord');
                const result = await generateRequestBody(
                    { endpoint: toEndpoint(api), handlerSource },
                    { apiKey: a.apiKey ?? '', model: a.model ?? 'openrouter/free', timeoutMs: a.timeoutMs ?? 20_000, provider: a.provider },
                );
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // Issue #603 Phase 3.5 — LLM-driven chain composer.
        if (name === 'generate_chain' && args) {
            try {
                const a = args as { intent?: string; maxSteps?: number; apiKey?: string; model?: string; provider?: string; timeoutMs?: number; repoId?: string };
                const keyErr = preflightLlmAuth(a);
                if (keyErr) return { isError: true, content: [{ type: 'text', text: keyErr }] };
                const snap = resolveSnap(args);
                const { buildApiTestingPayload } = await import('../core/apiTesting/buildFromApiRecord');
                const payload = buildApiTestingPayload(snap);
                const endpoints = payload.collections.flatMap(c => c.endpoints);
                const { generateChain } = await import('../core/apiTesting/aiTestGen/generateChain');
                const result = await generateChain(
                    { endpoints, intent: a.intent, maxSteps: a.maxSteps },
                    { apiKey: a.apiKey ?? '', model: a.model ?? 'openrouter/free', timeoutMs: a.timeoutMs ?? 20_000, provider: a.provider },
                );
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // Issue #603 Phase 3.5 — LLM-driven test-case generator.
        if (name === 'generate_test_cases' && args) {
            try {
                const a = args as {
                    apiId: string;
                    maxCases?: number;
                    apiKey?: string;
                    model?: string;
                    provider?: string;
                    timeoutMs?: number;
                    repoId?: string;
                };
                const keyErr = preflightLlmAuth(a);
                if (keyErr) return { isError: true, content: [{ type: 'text', text: keyErr }] };
                const snap = resolveSnap(args);
                const scopedStore = resolveStoreForRepo(args);
                const api = snap.apiIndex?.[a.apiId];
                if (!api) {
                    return { isError: true, content: [{ type: 'text', text: `Error: apiId ${a.apiId} not found in working snapshot.` }] };
                }
                const handlerSource = scopedStore.getFileContent('working', api.filePath) ?? '';
                if (!handlerSource) {
                    return { isError: true, content: [{ type: 'text', text: `Error: handler source not available for ${api.filePath}` }] };
                }
                const { generateTestCases } = await import('../core/apiTesting/aiTestGen/generateTestCases');
                const { toEndpoint } = await import('../core/apiTesting/buildFromApiRecord');
                const result = await generateTestCases(
                    {
                        endpoint: toEndpoint(api),
                        handlerSource,
                        maxCases: a.maxCases,
                    },
                    {
                        apiKey: a.apiKey ?? '',
                        model: a.model ?? 'openrouter/free',
                        timeoutMs: a.timeoutMs ?? 20_000,
                        provider: a.provider,
                    },
                );
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2),
                    }],
                };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'pre_edit_brief' && args) {
            try {
                const { filePath, symbolName } = args as any;
                const snap = resolveSnap(args);
                const scopedStore = resolveStoreForRepo(args);
                const result = getPreEditBrief(snap, scopedStore.getBaseline(), filePath, symbolName, (p) =>
                    scopedStore.getFileContent('working', p),
                );
                if (!result) {
                    return { isError: true, content: [{ type: 'text', text: `File not found: ${filePath}` }] };
                }
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'describe_snapshot_schema') {
            try {
                const scopedStore = resolveStoreForRepo(args);
                const desc = describeSchema(scopedStore);
                return { content: [{ type: 'text', text: JSON.stringify(desc, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'query_snapshot' && args) {
            try {
                const { sql, limit } = args as any;
                const scopedStore = resolveStoreForRepo(args);
                const result = runReadOnlyQuery(scopedStore, sql, limit);
                if ('error' in result) {
                    return { isError: true, content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
                }
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'list_entrypoints_paged') {
            try {
                const a = (args ?? {}) as any;
                const snap = resolveSnap(args);
                const result = listEntryPointsPaged(
                    snap,
                    { method: a.method, clusterId: a.clusterId, serviceId: a.serviceId, authRequired: a.authRequired, onlyChanged: a.onlyChanged, routeContains: a.routeContains },
                    { cursor: a.cursor, limit: a.limit },
                    a.maxResponseTokens,
                );
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'list_architecture_violations') {
            try {
                const a = (args ?? {}) as any;
                const snap = resolveSnap(args);
                const scopedStore = resolveStoreForRepo(args);
                const result = listArchitectureViolations(snap, {
                    rules: a.rules,
                    workspaceRoot: scopedStore.getWorkspaceRoot(),
                });
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'get_coverage_overlay') {
            try {
                const scopedStore = resolveStoreForRepo(args);
                const result = getCoverageOverlay(scopedStore.getWorkspaceRoot());
                if (!result) {
                    return { content: [{ type: 'text', text: '{"note":"no coverage data found — drop an lcov.info or coverage-summary.json under coverage/"}' }] };
                }
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'find_similar_entities' && args) {
            try {
                const { id, limit } = args as any;
                const snap = resolveSnap(args);
                const result = findSimilarEntities(snap, id, limit);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'list_saved_views') {
            try {
                const views = loadSavedViews(snapshotStore.getWorkspaceRoot());
                return { content: [{ type: 'text', text: JSON.stringify(views, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // ─── AI review tools (#506 — Tier-1 MCP tools for AI review) ──────────────────────────────────────
        if (name === 'list_ai_findings') {
            try {
                const a = (args ?? {}) as any;
                const limit = Math.min(Math.max(1, Number(a.limit) || 50), 500);
                const filter: any = {};
                if (a.graphId) filter.graphId = a.graphId;
                if (a.entryPointId) filter.entryPointId = a.entryPointId;
                if (a.severity) filter.severity = a.severity;
                if (a.status) filter.status = a.status;
                const scopedStore = resolveStoreForRepo(args);
                const items = scopedStore.listAiReviewFindings(filter).slice(0, limit);
                return { content: [{ type: 'text', text: JSON.stringify({ items, total: items.length }, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'get_ai_finding' && args) {
            const { findingId } = args as any;
            const scopedStore = resolveStoreForRepo(args);
            const f = scopedStore.getAiReviewFinding(String(findingId));
            if (!f) return { isError: true, content: [{ type: 'text', text: `Finding not found: ${findingId}` }] };
            return { content: [{ type: 'text', text: JSON.stringify(f, null, 2) }] };
        }

        if (name === 'get_ai_finding_counts') {
            try {
                const status = ((args ?? {}) as any).status;
                const scopedStore = resolveStoreForRepo(args);
                const counts = scopedStore.getAiReviewFindingCounts(status ? { status } : undefined);
                return { content: [{ type: 'text', text: JSON.stringify(counts, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'update_ai_finding_status' && args) {
            const { findingId, status, actor, note } = args as any;  // #613 — optional actor + note
            const readOnly = (snapshotStore as any).__bootstrapStatus?.()?.mode === 'read_only';
            if (readOnly) return { isError: true, content: [{ type: 'text', text: READ_ONLY_REFUSAL }] };
            const scopedStore = resolveStoreForRepo(args);
            const updated = scopedStore.updateAiReviewFindingStatus(
                String(findingId), status,
                {
                    actor: typeof actor === 'string' ? actor : undefined,
                    note: typeof note === 'string' ? note : undefined,
                },
            );
            if (!updated) return { isError: true, content: [{ type: 'text', text: `Finding not found: ${findingId}` }] };
            return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
        }

        if (name === 'get_review_guidelines') {
            const scopedStore = resolveStoreForRepo(args);
            const g = scopedStore.getReviewGuidelines();
            return { content: [{ type: 'text', text: JSON.stringify(g, null, 2) }] };
        }

        if (name === 'set_review_guidelines' && args) {
            const readOnly = (snapshotStore as any).__bootstrapStatus?.()?.mode === 'read_only';
            if (readOnly) return { isError: true, content: [{ type: 'text', text: READ_ONLY_REFUSAL }] };
            const text = String((args as any).text ?? '');
            const scopedStore = resolveStoreForRepo(args);
            const saved = scopedStore.setReviewGuidelines(text);
            return { content: [{ type: 'text', text: JSON.stringify(saved, null, 2) }] };
        }

        if (name === 'search_ai_findings' && args) {
            try {
                const { query, limit } = args as any;
                const { searchFindings } = await import('./aiFindingsSearch');
                const cap = Math.min(Math.max(1, Number(limit) || 20), 200);
                const scopedStore = resolveStoreForRepo(args);
                const result = searchFindings(scopedStore, String(query ?? ''), cap);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'review_and_fix_pack' && args) {
            try {
                const { findingId } = args as any;
                const scopedStore = resolveStoreForRepo(args);
                const finding = scopedStore.getAiReviewFinding(String(findingId));
                if (!finding) return { isError: true, content: [{ type: 'text', text: `Finding not found: ${findingId}` }] };
                const [method, ...rest] = finding.entryPointId.split(':');
                const route = rest.join(':');
                const pack = (() => {
                    try {
                        const { getEntryPointPack } = require('./contextPack');
                        return getEntryPointPack(scopedStore.getWorking(), method, route);
                    } catch { return null; }
                })();
                const siblingComments = scopedStore.getComments()
                    .filter((c: any) => finding.bindings.some((b: any) => b.graphId && c.layer && b.graphId.startsWith(c.layer)));
                return { content: [{ type: 'text', text: JSON.stringify({ finding, pack, siblingComments }, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'summarise_findings') {
            try {
                const a = (args ?? {}) as any;
                const max = Math.min(Math.max(1, Number(a.maxBullets) || 6), 20);
                const scopedStore = resolveStoreForRepo(args);
                const items = scopedStore.listAiReviewFindings({
                    graphId: a.graphId,
                    entryPointId: a.entryPointId,
                    status: 'open',
                });
                // Sort error > warning > info; take the top N for the bullets.
                const rank = { error: 0, warning: 1, info: 2 } as const;
                const sorted = [...items].sort((x, y) => rank[x.severity] - rank[y.severity]);
                const bullets = sorted.slice(0, max).map((f) => `[${f.severity}] ${f.title} — ${f.body.slice(0, 100)}${f.body.length > 100 ? '…' : ''}`);
                const summary = {
                    title: a.graphId ? `Findings on ${a.graphId}` : a.entryPointId ? `Findings on ${a.entryPointId}` : 'Findings across workspace',
                    bullets,
                    counts: { total: items.length, error: items.filter((i) => i.severity === 'error').length, warning: items.filter((i) => i.severity === 'warning').length, info: items.filter((i) => i.severity === 'info').length },
                };
                return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'list_findings_by_guideline') {
            try {
                const a = (args ?? {}) as any;
                const scopedStore = resolveStoreForRepo(args);
                const items = scopedStore.listAiReviewFindings({ status: 'open' });
                const groups: Record<string, { count: number; samples: string[] }> = {};
                for (const f of items) {
                    if (a.guidelinesHash && f.guidelinesHash !== a.guidelinesHash) continue;
                    const key = f.guidelinesHash || '<none>';
                    if (!groups[key]) groups[key] = { count: 0, samples: [] };
                    groups[key].count += 1;
                    if (groups[key].samples.length < 3) groups[key].samples.push(f.title);
                }
                return { content: [{ type: 'text', text: JSON.stringify({ groups, totalGroups: Object.keys(groups).length }, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'clear_findings') {
            const readOnly = (snapshotStore as any).__bootstrapStatus?.()?.mode === 'read_only';
            if (readOnly) return { isError: true, content: [{ type: 'text', text: READ_ONLY_REFUSAL }] };
            const a = (args ?? {}) as any;
            const scopedStore = resolveStoreForRepo(args);
            let removed = 0;
            if (a.scope === 'all') removed = scopedStore.clearAiReviewFindings();
            else if (a.scope === 'cluster' && a.clusterId) removed = scopedStore.clearAiReviewFindings({ graphId: `feature:${a.clusterId}` }) + scopedStore.clearAiReviewFindings({ graphId: `api-list:${a.clusterId}` });
            else if (a.scope === 'entry' && a.entryPointId) removed = scopedStore.clearAiReviewFindings({ entryPointId: a.entryPointId });
            return { content: [{ type: 'text', text: JSON.stringify({ removed }, null, 2) }] };
        }

        if (name === 'get_review_summary') {
            try {
                const scopedStore = resolveStoreForRepo(args);
                const counts = scopedStore.getAiReviewFindingCounts();
                const guidelines = scopedStore.getReviewGuidelines();
                const topErrors = scopedStore.listAiReviewFindings({ severity: 'error', status: 'open' }).slice(0, 5);
                return { content: [{ type: 'text', text: JSON.stringify({ counts, guidelines: { hash: guidelines.hash, updatedAt: guidelines.updatedAt }, topErrors }, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // ─── #517 ─────────────────────────────────────────────────────────
        if (name === 'score_findings' && args) {
            try {
                const a = args as any;
                const threshold = typeof a.threshold === 'number' ? a.threshold : 0.2;
                const limit = Math.min(Math.max(1, Number(a.limit) || 20), 200);
                const { searchFindings } = await import('./aiFindingsSearch');
                const scopedStore = resolveStoreForRepo(args);
                const result = searchFindings(scopedStore, String(a.query ?? ''), limit);
                const subset = Array.isArray(a.findingIds) && a.findingIds.length > 0
                    ? result.matches.filter((m) => a.findingIds.includes(m.finding.id))
                    : result.matches;
                // Normalise raw scores (~5-80) to 0-1 by dividing by 100, clamped.
                const ranked = subset.map((m) => ({
                    findingId: m.finding.id,
                    score: Math.min(1, m.score / 100),
                    reason: m.reason,
                    severity: m.finding.severity,
                    title: m.finding.title,
                })).filter((r) => r.score >= threshold);
                return { content: [{ type: 'text', text: JSON.stringify({ items: ranked, intent: result.intent }, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // ─── #518 ─────────────────────────────────────────────────────────
        if (name === 'propose_guideline_from_finding' && args) {
            try {
                const { findingId } = args as any;
                const scopedStore = resolveStoreForRepo(args);
                const f = scopedStore.getAiReviewFinding(String(findingId));
                if (!f) return { isError: true, content: [{ type: 'text', text: `Finding not found: ${findingId}` }] };
                // Deterministic guideline proposal — distil the title + category
                // into a one-liner the user can add. No LLM call needed: the
                // category + title carry the intent.
                const verb = ({
                    'security': 'Flag', 'performance': 'Reject', 'logic-bug': 'Flag',
                    'architecture': 'Flag', 'api-design': 'Prefer', 'code-quality': 'Avoid',
                    'guideline': 'Enforce',
                } as Record<string, string>)[f.category] ?? 'Flag';
                const proposedGuideline = `${verb} ${f.title.replace(/^[A-Z]/, (c) => c.toLowerCase())}.`;
                const rationale = `Derived from finding ${f.id} (${f.severity}/${f.category}). Adding this to your review guidelines causes the AI to flag matching patterns on every subsequent review.`;
                return { content: [{ type: 'text', text: JSON.stringify({ proposedGuideline, rationale, sourceFinding: { id: f.id, title: f.title, category: f.category } }, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // ─── #519 ─────────────────────────────────────────────────────────
        if (name === 'review_diff_with_baseline') {
            const readOnly = (snapshotStore as any).__bootstrapStatus?.()?.mode === 'read_only';
            if (readOnly) return { isError: true, content: [{ type: 'text', text: READ_ONLY_REFUSAL }] };
            try {
                // Surface the *count* of entry points that would be reviewed.
                // Actually triggering the run requires LLM credentials + WS
                // bridge — the standalone exposes `requestFullReview` for
                // that. From MCP we hand the agent a scoped TODO it can
                // act on (e.g. then driving the WS-backed full review).
                const a = (args ?? {}) as any;
                const scopedStore = resolveStoreForRepo(args);
                const apis = Object.values(scopedStore.getWorking().apiIndex ?? {});
                const changed = apis.filter((api: any) => api.diff && api.diff !== 'unchanged');
                let scoped = changed;
                if (a.scope === 'cluster' && a.clusterId) {
                    scoped = changed.filter((api: any) => (api.meta as any)?.clusterId === a.clusterId);
                } else if (a.scope === 'entry' && a.entryPointId) {
                    const [m, ...rest] = a.entryPointId.split(':');
                    const r = rest.join(':');
                    scoped = changed.filter((api: any) => String(api.method).toUpperCase() === m.toUpperCase() && api.route === r);
                }
                const result = {
                    scope: a.scope ?? 'changed',
                    entryPointCount: scoped.length,
                    entryPoints: scoped.map((api: any) => ({ method: api.method, route: api.route, handlerName: api.handlerName, diff: api.diff })),
                    instruction: scoped.length === 0
                        ? 'No changed entry points to review. Run review_diff_with_baseline after editing files.'
                        : `Drive the per-entry review via the standalone WS message { type: "requestFullReview", scope: "changed" } to actually invoke the LLM. This tool surfaces the scope; it does not start the run.`,
                };
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'export_openapi_spec') {
            try {
                const tools = await listToolDescriptors(server);
                const spec = exportOpenApiSpec(tools);
                return { content: [{ type: 'text', text: JSON.stringify(spec, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'export_function_calling_spec') {
            try {
                const tools = await listToolDescriptors(server);
                return { content: [{ type: 'text', text: JSON.stringify(exportFunctionCallingSpec(tools), null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'compare_workspaces' && args) {
            try {
                const { otherWorkspaceRoot } = args as any;
                const result = await compareWorkspaces(snapshotStore.getWorkspaceRoot(), otherWorkspaceRoot);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'summarise_payload' && args) {
            try {
                const { input, maxBullets } = args as any;
                const summary = summarisePayload(input, maxBullets);
                return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        if (name === 'get_feature_pack' && args) {
            try {
                const { clusterId, includeBaselineDiff } = args as any;
                const snap = resolveSnap(args);
                const scopedStore = resolveStoreForRepo(args);
                const baseline = includeBaselineDiff ? scopedStore.getBaseline() : undefined;
                const pack = getFeaturePack(snap, clusterId, baseline);
                if (!pack) {
                    return { isError: true, content: [{ type: 'text', text: `Feature cluster not found: ${clusterId}` }] };
                }
                return { content: [{ type: 'text', text: JSON.stringify(pack, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // #review-context — assemble review context for a diff/branch/PR/working tree.
        if (name === 'get_review_context' && args) {
            try {
                const scopedStore = resolveStoreForRepo(args);
                const root = scopedStore.getWorkspaceRoot?.() || snapshotStore.getWorkspaceRoot?.();
                if (!root) return { isError: true, content: [{ type: 'text', text: 'Error: workspace root unavailable' }] };
                const src = ((args as any).source ?? {}) as { kind?: string; base?: string; head?: string; branch?: string };
                const git = await import('../core/git/gitReader');
                const { buildReviewContext } = await import('../core/llm/reviewContext');
                let changedFiles: string[] = [];
                let diff = '';
                if (src.kind === 'working') {
                    changedFiles = git.getWorkingTreeChangedFiles(root);
                    diff = git.getWorkingTreeDiff(root);
                } else if (src.kind === 'branch') {
                    const head = src.branch || 'HEAD';
                    const base = src.base || (git.resolveRef(root, 'main') ? 'main' : git.resolveRef(root, 'master') ? 'master' : 'HEAD');
                    changedFiles = git.getReviewChangedFiles(root, base, head);
                    diff = git.getUnifiedDiff(root, base, head);
                } else { // 'pr' | 'diff'
                    const base = src.base;
                    const head = src.head || 'HEAD';
                    if (!base) return { isError: true, content: [{ type: 'text', text: 'Error: source.base is required for kind "pr"/"diff"' }] };
                    changedFiles = git.getReviewChangedFiles(root, base, head);
                    diff = git.getUnifiedDiff(root, base, head);
                }
                const ctx = buildReviewContext({ store: scopedStore, changedFiles, guidelines: (args as any).guidelines });
                // Cap the raw unified diff — the bounded per-file `fileDiffs` are the
                // review payload; a multi-MB raw diff would blow the client context.
                const DIFF_CAP = 120_000;
                const diffOut = diff.length > DIFF_CAP
                    ? diff.slice(0, DIFF_CAP) + `\n… [diff truncated at ${DIFF_CAP} chars — use fileDiffs for the per-file windows] …`
                    : (diff || undefined);
                return { content: [{ type: 'text', text: JSON.stringify({ source: src, diff: diffOut, ...ctx }, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // #948–#953 — deterministic FP filter for review findings (off-diff/test-nit/dedup).
        if (name === 'filter_review_findings' && args) {
            try {
                const findings = ((args as any).findings ?? []) as any[];
                const changedFiles = ((args as any).changedFiles ?? []) as string[];
                const { filterReviewFindings } = await import('../core/llm/reviewFilters');
                const res = filterReviewFindings(findings, changedFiles);
                return {
                    content: [{
                        type: 'text', text: JSON.stringify({
                            keptCount: res.kept.length,
                            droppedCount: res.dropped.length,
                            kept: res.kept,
                            dropped: res.dropped.map((d) => ({ reason: d.reason, title: d.finding.title, filePath: d.finding.anchor?.filePath })),
                        }, null, 2),
                    }],
                };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        // #954 — RUN the full review with the configured LLM and return finalized findings.
        if (name === 'run_review' && args) {
            const readOnly = (snapshotStore as any).__bootstrapStatus?.()?.mode === 'read_only';
            if (readOnly) return { isError: true, content: [{ type: 'text', text: READ_ONLY_REFUSAL }] };
            try {
                const scopedStore = resolveStoreForRepo(args);
                const root = scopedStore.getWorkspaceRoot?.() || snapshotStore.getWorkspaceRoot?.();
                const scope = ((args as any).scope === 'all' ? 'all' : 'changed') as 'all' | 'changed';
                // ADR-044 — the review engine pulls in zod (#704). Importing it into the
                // mcp-server bundle (even via a dynamic import esbuild would inline)
                // reorders zod's init and crashes the MCP SDK ("Class2 is not a
                // constructor"). Load it from a SEPARATE bundle via a runtime require
                // (computed path → esbuild leaves it external), exactly like review-pr-cli.
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const pathMod = require('path');
                const reviewBundle = require(pathMod.join(__dirname, 'run-review.js')) as typeof import('../standalone/runReviewOnSnapshot');
                const result = await reviewBundle.runReviewOnSnapshot({ store: scopedStore, workspaceRoot: root, scope });
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }
        }

        throw new Error(`Unknown tool: ${name}`);
    };

    // Telemetry wrapper. When `analytics` is undefined (e.g. when the
    // extension build calls `registerMcpTools` without one), the handler
    // is called raw. The MCP standalone always passes an analytics
    // instance — see `src/mcp/mcp-server.ts`.
    const callToolHandler = async (request: any) => withAttribution(await callToolHandlerRaw(request));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        // Sync in-memory state with on-disk writes before each tool call.
        // This covers two cases:
        //   1. A concurrent VS Code instance has written to the same storage
        //      dir (only happens when the user opts into shared storage via
        //      `--storage-dir .codeatlas`).
        //   2. The standalone's own file-watcher has just persisted a
        //      rebuild — the next tool call should see the fresh data.
        // The refresh DOES NOT run inside `getWorking()` itself (a previous
        // version did, which broke the file-watcher cascade by clobbering
        // in-flight rebuildFile state); it only fires here, at the tool
        // entry point.
        try { snapshotStore.refresh?.(); } catch { /* stale read is OK */ }
        if (!analytics) return callToolHandler(request);
        const toolName = (request.params?.name as string | undefined) ?? 'unknown';
        const startMs = Date.now();
        // (2026-08) No per-call `mcp_tool_call_start` — it doubled the tool-call
        // event volume. `mcp_tool_call_complete` / `_error` (below) carry the
        // tool name + duration, so a single event per call is sufficient.
        try {
            const result = await callToolHandler(request);
            const resultSize = (() => {
                try { return JSON.stringify(result).length; } catch { return 0; }
            })();
            const isError = !!(result && (result as any).isError);
            const errorText = isError
                ? ((result as any).content?.[0]?.text as string | undefined)
                : undefined;
            analytics.trackToolCall({
                name: toolName,
                startMs,
                endMs: Date.now(),
                resultSizeBytes: resultSize,
                isError,
                errorMessage: errorText,
            });
            return result;
        } catch (err: any) {
            analytics.trackToolCall({
                name: toolName,
                startMs,
                endMs: Date.now(),
                isError: true,
                errorMessage: String(err?.message ?? err),
            });
            throw err;
        }
    });
}
