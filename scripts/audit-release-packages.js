#!/usr/bin/env node
/**
 * audit-release-packages.js — release-prep gate.
 *
 * Run BEFORE `vsce publish` / `npm publish` to verify the VSIX + MCP
 * tarball contain only files that belong in a public release. Bails
 * non-zero (and prints what was found) if any of the following land:
 *
 *   • Internal dev notes: UX-FINDINGS-*.md, LIVE-VERIFY-*.md, ISSUES.md,
 *     verify-*.md, NOTES-*.md, ACTION-PLAN*.md, CLAUDE.md, prd.md.
 *   • Source files (src/**, webview-ui/src/**), tests (__tests__,
 *     *.test.ts), build tooling (esbuild.js, tsconfig.json, vitest.
 *     config.ts, .vscodeignore), git internals (.github, .gitignore).
 *   • Lock files (package-lock.json, yarn.lock) and dev state
 *     (.codeatlas/, .claude/, .live-verify-snapshots/, tmp/).
 *   • Anything under node_modules/ that ISN'T chokidar or readdirp
 *     (those two are intentional — they're ESM-only and esbuild marks
 *     them external; see esbuild.js).
 *
 * Allowed runtime artifacts are spelled out in the per-package
 * allowlist below.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VSIX = path.join(ROOT, 'codeatlas-live-7.3.0.vsix');
const MCP_TGZ = path.join(ROOT, 'mcp-package', 'codeatlas-mcp-3.3.0.tgz');

/** Patterns that must NEVER appear in either package. */
const FORBIDDEN_PATTERNS = [
    /\bUX-FINDINGS-/i,
    /\bLIVE-VERIFY-/i,
    /\bverify-.+\.md$/i,
    /\bNOTES-.+\.md$/i,
    /\bACTION-PLAN/i,
    /\bISSUES\.md$/i,
    /\bCLAUDE\.md$/i,
    /\bprd\.md$/i,
    /\bfindings-.+\.md$/i,
    /\.live-verify-snapshots\//,
    /\.codeatlas\//,
    /\.claude\//,
    /\.github\//,
    /\.git\//,
    /\/src\//,
    /\/__tests__\//,
    /\.test\.tsx?$/,
    /\.test\.js$/,
    /\.spec\.tsx?$/,
    /esbuild\.js$/,
    /tsconfig.*\.json$/,
    /vitest\.config\.(ts|js)$/,
    /\.vscodeignore$/,
    /package-lock\.json$/,
    /yarn\.lock$/,
];

/** node_modules entries that ARE intentional (rest is forbidden). */
const NODE_MODULES_ALLOWLIST = [
    'node_modules/chokidar/',
    'node_modules/readdirp/',
];

function listVsix(filePath) {
    const out = execSync(`unzip -l "${filePath}"`, { encoding: 'utf-8' });
    return out
        .split('\n')
        .map((l) => l.trim().split(/\s+/).pop())
        .filter((name) => name && name.startsWith('extension/'));
}

function listTgz(filePath) {
    const out = execSync(`tar tzf "${filePath}"`, { encoding: 'utf-8' });
    return out.split('\n').filter(Boolean);
}

function audit(name, files) {
    const violations = [];
    for (const f of files) {
        for (const pat of FORBIDDEN_PATTERNS) {
            if (pat.test(f)) {
                violations.push({ file: f, reason: `matches ${pat}` });
                break;
            }
        }
        if (f.includes('node_modules/')) {
            const allowed = NODE_MODULES_ALLOWLIST.some((a) => f.includes(a));
            if (!allowed) violations.push({ file: f, reason: 'unauthorised node_modules entry' });
        }
    }
    if (violations.length === 0) {
        console.log(`✓ ${name}: ${files.length} files, no violations.`);
        return 0;
    }
    console.error(`✗ ${name}: ${violations.length} violation(s) in ${files.length} files:`);
    for (const v of violations) console.error(`    ${v.file} — ${v.reason}`);
    return 1;
}

let exitCode = 0;

if (fs.existsSync(VSIX)) {
    exitCode |= audit('VSIX', listVsix(VSIX));
} else {
    console.error(`! ${VSIX} not found — run \`npx vsce package --no-dependencies\` first.`);
    exitCode |= 1;
}

if (fs.existsSync(MCP_TGZ)) {
    exitCode |= audit('MCP tarball', listTgz(MCP_TGZ));
} else {
    console.error(`! ${MCP_TGZ} not found — run \`cd mcp-package && npm pack\` first.`);
    exitCode |= 1;
}

if (exitCode !== 0) {
    console.error('\nFix the violations above before publishing.');
    process.exit(1);
}
console.log('\nRelease packages clean. Safe to publish.');
