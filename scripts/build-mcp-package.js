#!/usr/bin/env node
/**
 * build-mcp-package.js — assemble the standalone @codeatlas/mcp npm package
 * from the existing dist/ artifacts produced by the main esbuild target.
 *
 * Source of truth is `dist/mcp-server.js` (built by esbuild.js); this script
 * just copies it + the wasm runtime files + grammars into mcp-package/dist/
 * so the package is self-contained and `npx @codeatlas/mcp /path` works
 * without the VS Code extension.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIST = path.join(ROOT, 'dist');
const PKG_DIR = path.join(ROOT, 'mcp-package');
const DST_DIST = path.join(PKG_DIR, 'dist');

function copyFile(srcRel, dstRel) {
    const src = path.join(SRC_DIST, srcRel);
    const dst = path.join(DST_DIST, dstRel);
    if (!fs.existsSync(src)) {
        console.error(`[build-mcp-package] missing: ${src}`);
        process.exit(1);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    console.log(`  copied ${srcRel} → ${path.relative(ROOT, dst)}`);
}

function copyDirRecursive(srcDir, dstDir) {
    if (!fs.existsSync(srcDir)) return;
    fs.mkdirSync(dstDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const src = path.join(srcDir, entry.name);
        const dst = path.join(dstDir, entry.name);
        if (entry.isDirectory()) copyDirRecursive(src, dst);
        else if (entry.isFile()) {
            fs.copyFileSync(src, dst);
            console.log(`  copied ${path.relative(SRC_DIST, src)} → ${path.relative(ROOT, dst)}`);
        }
    }
}

console.log('[build-mcp-package] assembling standalone @codeatlas/mcp');
fs.rmSync(DST_DIST, { recursive: true, force: true });
fs.mkdirSync(DST_DIST, { recursive: true });

copyFile('mcp-server.js', 'mcp-server.js');
// #850 / ADR-044 — review-pr subcommand lives in a sibling bundle so the
// server bundle's zod module-init order stays untouched.
copyFile('review-pr-cli.js', 'review-pr-cli.js');
// #954 / ADR-044 — run_review's engine in a sibling bundle, same zod-isolation rationale.
copyFile('run-review.js', 'run-review.js');
copyFile('postinstall-hint.js', 'postinstall-hint.js');
copyFile('sql-wasm.wasm', 'sql-wasm.wasm');
copyFile('tree-sitter.wasm', 'tree-sitter.wasm');

// Tree-sitter grammars live under grammars/ in the extension root; copy
// them into the package so the wasm-loader can find them in the npm install.
const grammarsSrc = path.join(ROOT, 'grammars');
const grammarsDst = path.join(DST_DIST, 'grammars');
if (fs.existsSync(grammarsSrc)) {
    copyDirRecursive(grammarsSrc, grammarsDst);
} else {
    console.warn(`[build-mcp-package] WARNING: grammars dir not found at ${grammarsSrc}`);
}

// Phase 1 of the standalone-browser plan: ship the pre-built webview-ui
// React assets so `--browser` mode in the standalone server can serve them
// from `dist/webview-ui/`. WsBridge.ts (which is vscode-free) joins
// `<extensionPath>/webview-ui/dist/`, so we copy the Vite output into
// `<mcp-pkg>/dist/webview-ui/dist/` to keep that path layout unchanged.
const webviewSrc = path.join(ROOT, 'webview-ui', 'dist');
const webviewDst = path.join(DST_DIST, 'webview-ui', 'dist');
if (fs.existsSync(webviewSrc)) {
    copyDirRecursive(webviewSrc, webviewDst);
} else {
    console.warn(`[build-mcp-package] WARNING: webview-ui/dist not found at ${webviewSrc} — run \`npm run build:webview\` first`);
}

// Make sure the binary is executable for the npm bin shim.
fs.chmodSync(path.join(DST_DIST, 'mcp-server.js'), 0o755);

// Fallback README so npmjs.com shows useful content if the canonical
// README.md was deleted. The full, hand-edited README is checked into
// mcp-package/README.md and is the source of truth — this short stub
// only kicks in when that file is missing.
const readmePath = path.join(PKG_DIR, 'README.md');
if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, `# @codeatlas/mcp

CodeAtlas MCP server — 25 tools + 5 resources that expose live codebase architecture (routes, sequences, diffs, impact analysis, architecture violations, read-only SQL) to any MCP-compatible LLM client: Claude Code, Cursor, VS Code Copilot, Codex CLI, Gemini CLI, Antigravity, Continue.

## Quick start

\`\`\`bash
# Claude Code
claude mcp add codeatlas -- npx -y @codeatlas/mcp $(pwd)
\`\`\`

\`\`\`json
// Cursor / VS Code / Gemini — MCP config
{
  "mcpServers": {
    "codeatlas": {
      "command": "npx",
      "args": ["-y", "@codeatlas/mcp", "/absolute/path/to/your/repo"]
    }
  }
}
\`\`\`

The server self-initializes on first run — no VS Code required.

## Languages

JS/TS, Python, Java, Kotlin, Go, Rust, Ruby, PHP, Swift, Dart, C#, C/C++. Node.js ≥18 only required on the host.

## Full docs

https://github.com/vamsikk7/codeatlas-live-issues#ai-assistant-integration-mcp
`);
}

// Copy the licence files. Apache-2.0 requires that a distribution carrying a
// NOTICE file passes it on to recipients, so both LICENSE and NOTICE must land
// in the published npm tarball -- not just the licence text.
//
// These are hard failures, not best-effort copies. Publishing @codeatlas/mcp
// with `"license": "Apache-2.0"` in package.json but no LICENSE file in the
// tarball is a compliance defect, and a silent `if (exists)` is exactly how
// that ships unnoticed.
for (const name of ['LICENSE', 'NOTICE']) {
    const src = path.join(ROOT, name);
    if (!fs.existsSync(src)) {
        console.error(`[build-mcp-package] FATAL: ${name} not found at ${src}`);
        process.exit(1);
    }
    fs.copyFileSync(src, path.join(PKG_DIR, name));
    console.log(`  copied ${name}`);
}

// THIRD-PARTY-NOTICES.md covers the tree-sitter grammars shipped in dist/.
const tpn = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');
if (fs.existsSync(tpn)) {
    fs.copyFileSync(tpn, path.join(PKG_DIR, 'THIRD-PARTY-NOTICES.md'));
    console.log('  copied THIRD-PARTY-NOTICES.md');
}

console.log('[build-mcp-package] done');
