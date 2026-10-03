#!/usr/bin/env node
/**
 * mcp-ai-review-verify.ext.js — Issue #727.
 *
 * Companion driver to `mcp-ai-review-verify.mcp.js` — same 9-invariant
 * contract, but targets the EXTENSION surface (live VS Code panel at
 * `localhost:7742`, reads `.codeatlas/state.db`) instead of the
 * standalone bundle.
 *
 * Used by `verify-all` Phase 4a.
 *
 * STATUS: skeleton — full driver pending #727 follow-up.
 */

'use strict';

const path = require('path');
const os = require('os');

const workspace = process.argv[2] || path.join(os.homedir(), 'work', 'test-drift');

console.log('[SKELETON] mcp-ai-review-verify.ext.js — full driver pending #727 follow-up.');
console.log(`Workspace: ${workspace}`);
console.log('Expected state: VS Code extension already running with the workspace open + initialised.');
console.log('Reference contract: 9 invariants per `verify-all` Phase 4a.');
process.exit(0);
