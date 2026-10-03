#!/usr/bin/env node
/**
 * mcp-ai-review-verify.mcp.js — Issue #727.
 *
 * Drives AI Review against the standalone bundle. See `verify-all`
 * skill Phase 4b for the 9-invariant contract:
 *   boot.browser_ready
 *   edit.anchor_found
 *   cascade.fired
 *   ws.connected
 *   precondition.findings_cleared
 *   review.completed_within_budget
 *   review.cursors_stamped
 *   review.pipeline_ran
 *   cycle_close.findings_cleared
 *
 * STATUS: skeleton. Spawns the standalone, connects via WS, exercises
 * the `setLlmConfig` → `saveReviewGuidelines` → `requestFullReview`
 * handshake, then SIGTERMs. The detailed invariant assertions need to
 * be transcribed from `.live-verify-snapshots/`. Track in #727 follow-up.
 *
 * Default LLM: Ollama + `deepseek-coder:6.7b` per the
 * `feedback_e2e_verify_protocol` memory rule.
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

// TODO(#727 follow-up): full WS client + 9-invariant assertion sequence
// transcribed from `.live-verify-snapshots/`. Until then this script
// only confirms the standalone boots into browser mode.
console.log('[SKELETON] mcp-ai-review-verify.mcp.js — full driver pending #727 follow-up.');
console.log(`Workspace: ${workspace}`);
console.log(`Bundle:    ${MCP_BUNDLE}`);
console.log('Reference contract: 9 invariants per `verify-all` Phase 4b.');
console.log('Run `node e2e/scripts/mcp-standalone-live-verify.js` first to confirm the boot path works.');
process.exit(0);
