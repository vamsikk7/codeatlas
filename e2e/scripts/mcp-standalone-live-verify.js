#!/usr/bin/env node
/**
 * mcp-standalone-live-verify.js — Issue #727.
 *
 * Drives the 28-invariant standalone live-verify cycle documented in
 * `.claude/skills/mcp-live-verify/SKILL.md`. Spawns the MCP standalone
 * in `--browser` mode, waits for `CodeAtlas browser ready`, runs the
 * edit / probe / revert cycle inline.
 *
 * STATUS: skeleton — captures the spawn lifecycle + stderr collection
 * the skill relies on. The 28 per-layer SQLite probes still need to be
 * authored once the canonical test workspace + edit handle stabilise.
 * Until then this driver exits 0 after confirming the standalone boots
 * past `CodeAtlas browser ready`. Track full per-layer probe authorship
 * in the #727 follow-up.
 *
 * Usage:
 *   node e2e/scripts/mcp-standalone-live-verify.js [workspace-path]
 *
 * Default workspace: `~/work/test-drift`.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MCP_BUNDLE = path.join(REPO_ROOT, 'mcp-package', 'dist', 'mcp-server.js');
const STDERR_LOG = '/tmp/mcp-live-stderr.log';
const BOOT_TIMEOUT_MS = 30_000;
const BOOT_NEEDLE = 'CodeAtlas browser ready';

const workspace = process.argv[2] || path.join(os.homedir(), 'work', 'test-drift');

if (!fs.existsSync(MCP_BUNDLE)) {
    console.error(`[FAIL] MCP bundle missing: ${MCP_BUNDLE}`);
    process.exit(1);
}
if (!fs.existsSync(workspace)) {
    console.error(`[FAIL] Test workspace missing: ${workspace}`);
    process.exit(1);
}

const child = spawn(process.execPath, [MCP_BUNDLE, workspace, '--browser'], {
    stdio: ['ignore', 'pipe', 'pipe'],
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

let stderrBuf = '';
const stderrStream = fs.createWriteStream(STDERR_LOG);
child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
    stderrStream.write(chunk);
});

const bootTimer = setTimeout(() => {
    console.error(`[FAIL] standalone did not emit "${BOOT_NEEDLE}" within ${BOOT_TIMEOUT_MS / 1000}s`);
    console.error(`See ${STDERR_LOG} for the full stderr stream.`);
    killChild();
    process.exit(1);
}, BOOT_TIMEOUT_MS);

let booted = false;
const checkBoot = setInterval(() => {
    if (booted) return;
    if (stderrBuf.includes(BOOT_NEEDLE)) {
        booted = true;
        clearInterval(checkBoot);
        clearTimeout(bootTimer);
        // TODO(#727 follow-up): full 28-invariant probe sequence here.
        // For now we confirm the boot needle landed + the watcher
        // attached, then SIGTERM.
        const watcherAttached = /fileWatcher.*watching/i.test(stderrBuf);
        killChild();
        if (watcherAttached) {
            console.log(`PASS mcp-standalone-live-verify (skeleton): boot OK + file watcher attached`);
            process.exit(0);
        }
        console.error('[FAIL] standalone booted but file watcher line was not detected');
        process.exit(1);
    }
}, 250);

child.on('exit', (code) => {
    clearInterval(checkBoot);
    clearTimeout(bootTimer);
    if (!booted) {
        console.error(`[FAIL] standalone exited (code=${code}) before "${BOOT_NEEDLE}"`);
        console.error(`See ${STDERR_LOG} for the full stderr stream.`);
        process.exit(1);
    }
});
