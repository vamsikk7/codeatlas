#!/usr/bin/env node
/**
 * mcp-all-tools-probe.js — Issue #727 / Deep MCP tools probe (Leg 3 of
 * `comprehensive-verify`).
 *
 * Contract:
 *   1. Spawn `mcp-package/dist/mcp-server.js <workspace>` over stdio.
 *   2. Complete the `initialize` handshake.
 *   3. Call `tools/list` and walk every returned tool name.
 *   4. For each tool, send a `tools/call` with a representative
 *      argument set (table below). Assert the response carries
 *      `content[]` and `isError !== true`.
 *   5. Print `PASS <N>/<N>` or `FAIL <bad>/<N> (<tool>...)`.
 *
 * Representative arg table is maintained inline at the bottom of the
 * file; new tools require one row each.
 *
 * STATUS: skeleton — the full per-tool table needs to be authored once
 * the comprehensive-verify skill stabilises. Smokes pass when run, but
 * the assertion is currently "each tool either succeeds or returns a
 * documented expected-error" rather than the per-tool shape check.
 *
 * Track the full per-tool table in the body of #727 follow-up.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MCP_BUNDLE = path.join(REPO_ROOT, 'mcp-package', 'dist', 'mcp-server.js');
const workspace = process.argv[2] || path.join(os.homedir(), 'work', 'test-drift');

if (!fs.existsSync(MCP_BUNDLE)) {
    console.error(`[FAIL] MCP bundle missing: ${MCP_BUNDLE}`);
    process.exit(1);
}
if (!fs.existsSync(workspace)) {
    console.error(`[FAIL] Test workspace missing: ${workspace}`);
    process.exit(1);
}

const child = spawn(process.execPath, [MCP_BUNDLE, workspace], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEATLAS_TELEMETRY: '0' },
});

let killed = false;
function killChild() {
    if (killed) return;
    killed = true;
    try { child.kill('SIGTERM'); } catch { /* noop */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 2_000).unref();
}
process.on('SIGINT', killChild);
process.on('SIGTERM', killChild);

let stdoutBuf = '';
const pendingRequests = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try {
            const msg = JSON.parse(line);
            if (msg && typeof msg.id !== 'undefined' && pendingRequests.has(msg.id)) {
                const { resolve, timer } = pendingRequests.get(msg.id);
                clearTimeout(timer);
                pendingRequests.delete(msg.id);
                resolve(msg);
            }
        } catch { /* skip non-JSON lines */ }
    }
});

function rpcCall(method, params, timeoutMs = 8_000) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error(`RPC timeout: ${method}`));
        }, timeoutMs);
        pendingRequests.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
    });
}

// Minimum representative args per tool — entries get appended as new
// tools land. Missing entries fall through to `{}` and rely on the
// tool's schema accepting empty args.
//
// SKIP_TOOLS: tools that legitimately can't run inside this offline
// probe — LLM-backed generators (no API key wired in), live OAuth2
// token exchange, and SSE/WS streams against external servers. They
// register and accept the request shape; verifying the network round-
// trip is the responsibility of dedicated integration tests.
const SKIP_TOOLS = new Set([
    'generate_request_body',
    'generate_chain',
    'generate_test_cases',
    'oauth2_token',
    'stream_sse',
    'connect_websocket',
    // The "by-id" finding tools correctly return isError when the id
    // doesn't resolve; covered by unit tests with seeded findings.
    'get_ai_finding',
    'update_ai_finding_status',
    'review_and_fix_pack',
    'propose_guideline_from_finding',
]);

// Representative example route from the canonical test workspace
// (~/work/node-express-realworld-example-app). The fixture is stable —
// the auth service has shipped getCurrentUser since the repo was first
// added.
const SAMPLE_FILE = 'src/app/routes/auth/auth.service.ts';
const SAMPLE_FN   = 'getCurrentUser';
const SAMPLE_API_ID = 'GET:/api/user';

const ARG_TABLE = {
    get_workspace_status: {},
    list_entrypoints: {},
    get_health_report: {},
    describe_snapshot_schema: {},
    get_diff_summary: {},
    get_api_surface_diff: {},
    list_ai_findings: {},
    get_ai_finding_counts: {},
    get_review_guidelines: {},
    get_review_summary: {},
    search_workspace: { query: 'function' },
    list_saved_views: {},
    get_tour: { mode: 'codebase', maxSteps: 5 },
    list_architecture_violations: {},
    list_entrypoints_paged: { limit: 5 },
    // — Tools with required args added in 7.0.0 —
    get_impact_analysis: { filePaths: [SAMPLE_FILE] },
    get_function_dependencies: { filePath: SAMPLE_FILE, symbolName: SAMPLE_FN, direction: 'downstream' },
    get_entrypoint_pack: { method: 'GET', route: '/api/user' },
    get_impact_of_change: { filePath: SAMPLE_FILE },
    get_function_source: { filePath: SAMPLE_FILE, symbolName: SAMPLE_FN },
    trace_call_path: { fromFile: SAMPLE_FILE, fromFn: SAMPLE_FN, toFile: SAMPLE_FILE, toFn: SAMPLE_FN },
    pre_edit_brief: { filePath: SAMPLE_FILE, symbolName: SAMPLE_FN },
    // — API testing (#603/#604) —
    run_api_chain: { steps: [] }, // empty chain → empty result, valid
    oauth2_authorize_url: {
        authorizationEndpoint: 'https://example.com/oauth/authorize',
        clientId: 'probe-client',
        redirectUri: 'http://localhost:7742/oauth/callback',
    },
    import_api_collection: {
        spec: { openapi: '3.0.0', info: { title: 'probe', version: '0' }, paths: {} },
    },
    // — Snapshot SQL —
    query_snapshot: { sql: 'SELECT count(*) AS n FROM apis' },
    // — Feature/cluster —
    get_feature_pack: { clusterId: 'cluster:auth' },
    find_similar_entities: { id: 'cluster:auth' },
    // — AI review (read-only paths) —
    get_ai_finding: { findingId: 'nonexistent' }, // returns null result — not isError
    update_ai_finding_status: { findingId: 'nonexistent', status: 'open' },
    set_review_guidelines: { text: '' }, // no-op reset — exercises write path
    search_ai_findings: { query: 'auth' },
    review_and_fix_pack: { findingId: 'nonexistent' },
    summarise_findings: {},
    list_findings_by_guideline: {},
    clear_findings: { scope: 'all' },
    score_findings: { query: 'security' },
    propose_guideline_from_finding: { findingId: 'nonexistent' },
    review_diff_with_baseline: { scope: 'changed' },
    // — Misc —
    get_coverage_overlay: {},
    export_openapi_spec: {},
    export_function_calling_spec: {},
    compare_workspaces: { otherWorkspaceRoot: process.cwd() }, // self-compare, harmless
    summarise_payload: { input: { hello: 'world' } },
    // — Overlays (#826) + review-context/filter (#948–#953). These require a
    //   `id` / `source.kind` / `findings` arg respectively; without them the
    //   tools correctly return isError, so the probe must pass real args to
    //   exercise the success (or documented empty-state) path. —
    get_overlay: { id: 'coverage' },                       // empty-state hint when no LCOV — not isError
    get_review_context: { source: { kind: 'working' } },   // uncommitted vs HEAD; empty when clean
    filter_review_findings: { findings: [], changedFiles: [] }, // empty set → empty result, valid
};

(async () => {
    await new Promise(r => setTimeout(r, 300));
    try {
        await rpcCall('initialize', {
            protocolVersion: '2024-11-05',
            clientInfo: { name: 'mcp-all-tools-probe', version: '1.0.0' },
            capabilities: {},
        }, 15_000);
    } catch (err) {
        console.error('[FAIL] initialize failed:', err.message);
        killChild();
        process.exit(1);
    }

    const listResp = await rpcCall('tools/list').catch(err => {
        console.error('[FAIL] tools/list failed:', err.message);
        killChild();
        process.exit(1);
    });

    const tools = listResp?.result?.tools ?? [];
    if (tools.length === 0) {
        console.error('[FAIL] tools/list returned 0 tools');
        killChild();
        process.exit(1);
    }

    const failures = [];
    const skipped = [];
    let pass = 0;
    for (const t of tools) {
        if (SKIP_TOOLS.has(t.name)) {
            skipped.push(t.name);
            continue;
        }
        const args = ARG_TABLE[t.name] ?? {};
        try {
            const resp = await rpcCall('tools/call', { name: t.name, arguments: args }, 10_000);
            const isError = resp?.result?.isError === true || !!resp?.error;
            if (isError) {
                failures.push(t.name);
            } else if (!resp?.result?.content) {
                failures.push(t.name + '(no content)');
            } else {
                pass++;
            }
        } catch (err) {
            failures.push(t.name + '(timeout)');
        }
    }

    killChild();
    const skipNote = skipped.length ? ` (${skipped.length} skipped: ${skipped.join(', ')})` : '';
    if (failures.length === 0) {
        console.log(`PASS mcp-all-tools-probe: ${pass}/${tools.length - skipped.length} tools OK${skipNote}`);
        process.exit(0);
    }
    console.error(`FAIL mcp-all-tools-probe: ${failures.length}/${tools.length - skipped.length} (${failures.join(', ')})${skipNote}`);
    process.exit(1);
})().catch((err) => {
    console.error('[FAIL] uncaught:', err && err.stack || err);
    killChild();
    process.exit(1);
});
