#!/usr/bin/env node
/**
 * preinstall.js — block global installs of @codeatlas/mcp.
 *
 * Why local-only:
 *   The configured MCP server entry points at one workspace path. Installing
 *   inside the repo makes the workspace implicit (the dir where `npm install`
 *   was invoked → `INIT_CWD`), lets postinstall auto-wire Claude Desktop /
 *   Cursor / Codex CLI / VS Code Copilot in one shot, and means the user
 *   never has to retype the path. Global installs would orphan the binary
 *   from any workspace context.
 *
 * Detection:
 *   `npm_config_global=true` is set by npm whenever the user passes `-g` or
 *   `--global` to `npm install`. Same flag exists for pnpm and yarn (yarn's
 *   `--global` is deprecated, falls back to a similar var). Bun's global
 *   install sets `npm_config_global=true` too for compat.
 *
 *   `npm_command=install` plus `npm_config_global` is the canonical "is this
 *   `npm install -g` happening right now" signal.
 *
 * Escape hatches:
 *   - `CODEATLAS_ALLOW_GLOBAL=1` for users who genuinely want global (e.g.
 *     CI smoke tests that don't care about workspace context). Documented
 *     in the error message.
 *   - `--ignore-scripts` skips this check entirely (standard npm flag —
 *     anyone using it knows what they're doing).
 *
 * Kept zero-dependency so it works the moment npm starts running scripts,
 * before any of our bundle is on disk.
 */
'use strict';

const isGlobal = process.env.npm_config_global === 'true'
    || process.env.npm_config_global === '1';
const allowGlobal = process.env.CODEATLAS_ALLOW_GLOBAL === '1'
    || process.env.CODEATLAS_ALLOW_GLOBAL === 'true';

if (!isGlobal || allowGlobal) {
    // Local install (or explicit escape hatch) — let it through.
    process.exit(0);
}

const bar = '─'.repeat(64);
process.stderr.write(`\n${bar}\n`);
process.stderr.write(`  ❌  @codeatlas/mcp must be installed inside a code repo, not globally.\n`);
process.stderr.write(`\n`);
process.stderr.write(`  Why: the MCP server is configured to index one workspace path.\n`);
process.stderr.write(`  Installing inside your repo lets us:\n`);
process.stderr.write(`    • auto-detect that workspace from the install location,\n`);
process.stderr.write(`    • wire Claude Desktop / Cursor / Codex CLI / VS Code Copilot for it,\n`);
process.stderr.write(`    • start the browser surface on http://localhost:7742 against it.\n`);
process.stderr.write(`\n`);
process.stderr.write(`  Install correctly:\n`);
process.stderr.write(`    cd /path/to/your/repo\n`);
process.stderr.write(`    npm install --save-dev @codeatlas/mcp\n`);
process.stderr.write(`\n`);
process.stderr.write(`  Override (not recommended — skips postinstall auto-config):\n`);
process.stderr.write(`    CODEATLAS_ALLOW_GLOBAL=1 npm install -g @codeatlas/mcp\n`);
process.stderr.write(`${bar}\n\n`);

process.exit(1);
