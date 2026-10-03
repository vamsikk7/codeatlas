#!/usr/bin/env node
/**
 * mcp-smoke.js — Issue #727 / Quick MCP smoke driver.
 *
 * Spawns `mcp-package/dist/mcp-server.js <test-workspace>`, completes
 * the MCP `initialize` handshake over stdio, sends `tools/list`, and
 * asserts the response carries ≥ 30 tools. ~5 seconds end-to-end.
 *
 * Run from any clone via `npm run verify:mcp-smoke`. Defaults to the
 * test workspace at `~/work/test-drift`; override with the first
 * positional argument:
 *
 *     node e2e/scripts/mcp-smoke.js /path/to/workspace
 *
 * Exit code 0 = pass; 1 = any invariant failed. The pass/fail line is
 * the LAST line of stdout so consumers can grep it.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MCP_BUNDLE = path.join(REPO_ROOT, 'mcp-package', 'dist', 'mcp-server.js');
const MIN_TOOL_COUNT = 30;
const STARTUP_TIMEOUT_MS = 15_000;
const RESPONSE_TIMEOUT_MS = 5_000;

const workspace = process.argv[2] || path.join(os.homedir(), 'work', 'test-drift');

// ─── Pre-flight ─────────────────────────────────────────────────────────────

if (!fs.existsSync(MCP_BUNDLE)) {
    console.error(`[FAIL] MCP bundle missing: ${MCP_BUNDLE}\nRun "npm run package" before invoking the smoke.`);
    process.exit(1);
}
if (!fs.existsSync(workspace)) {
    console.error(`[FAIL] Test workspace missing: ${workspace}\nClone or copy a small repo there before invoking the smoke.`);
    process.exit(1);
}

// ─── Spawn the MCP standalone ───────────────────────────────────────────────

const child = spawn(process.execPath, [MCP_BUNDLE, workspace], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEATLAS_TELEMETRY: '0' }, // No-op telemetry during CI smoke.
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

// Capture stderr for diagnostics.
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });

child.on('error', (err) => {
    console.error(`[FAIL] Could not spawn MCP server: ${err.message}`);
    process.exit(1);
});

// ─── Line-buffered JSON-RPC reader ──────────────────────────────────────────

let stdoutBuf = '';
const pendingRequests = new Map(); // id → { resolve, reject, timer }
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let idx;
    // MCP-over-stdio uses LINE-DELIMITED JSON (one object per newline).
    // Some servers emit chunked frames with embedded content-length
    // headers; the standalone bundle is line-delimited. Iterate until
    // the buffer no longer carries a complete line.
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); }
        catch { continue; }
        if (msg && typeof msg.id !== 'undefined' && pendingRequests.has(msg.id)) {
            const { resolve, timer } = pendingRequests.get(msg.id);
            clearTimeout(timer);
            pendingRequests.delete(msg.id);
            resolve(msg);
        }
    }
});

function rpcCall(method, params) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error(`RPC timeout: ${method} (id=${id})`));
        }, RESPONSE_TIMEOUT_MS);
        pendingRequests.set(id, { resolve, reject, timer });
        const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
        child.stdin.write(frame + '\n');
    });
}

// ─── Smoke sequence ─────────────────────────────────────────────────────────

(async () => {
    // Tiny grace period for the server to bind stdio.
    await new Promise(r => setTimeout(r, 300));

    let initResp;
    try {
        initResp = await Promise.race([
            rpcCall('initialize', {
                protocolVersion: '2024-11-05',
                clientInfo: { name: 'mcp-smoke', version: '1.0.0' },
                capabilities: {},
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('initialize handshake timeout')), STARTUP_TIMEOUT_MS)),
        ]);
    } catch (err) {
        console.error('[FAIL] initialize failed:', err.message);
        if (stderr) console.error('--- stderr ---\n' + stderr.slice(0, 2_000));
        killChild();
        process.exit(1);
    }
    if (initResp.error) {
        console.error('[FAIL] initialize returned error:', JSON.stringify(initResp.error));
        killChild();
        process.exit(1);
    }

    let listResp;
    try {
        listResp = await rpcCall('tools/list');
    } catch (err) {
        console.error('[FAIL] tools/list failed:', err.message);
        killChild();
        process.exit(1);
    }
    if (listResp.error) {
        console.error('[FAIL] tools/list returned error:', JSON.stringify(listResp.error));
        killChild();
        process.exit(1);
    }

    const toolCount = listResp?.result?.tools?.length ?? 0;
    if (toolCount < MIN_TOOL_COUNT) {
        console.error(`[FAIL] tools/list returned ${toolCount} tools, expected >= ${MIN_TOOL_COUNT}`);
        killChild();
        process.exit(1);
    }

    killChild();
    // Pass line is the LAST line so consumers can grep.
    console.log(`PASS mcp-smoke: ${toolCount} tools registered, initialize OK`);
    process.exit(0);
})().catch((err) => {
    console.error('[FAIL] uncaught:', err && err.stack || err);
    killChild();
    process.exit(1);
});
