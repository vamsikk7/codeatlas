/**
 * postinstallHint.ts — runs from `mcp-package/package.json`'s
 * `postinstall` hook.
 *
 * Local-install design (per `preinstall.js`): we know we're inside a
 * code repo because the preinstall check blocked global installs. The
 * repo path is in `process.env.INIT_CWD` — npm sets this to the dir
 * where `npm install` was invoked.
 *
 * Flow:
 *   1. Detect INIT_CWD + validate it's a code workspace.
 *   2. Allocate a free port (starts at 7842, walks up if taken).
 *   3. Install + start the per-OS daemon (launchd / systemd / schtasks).
 *      Daemon stays running so the MCP index is always fresh — edits
 *      to source files trigger the cascade immediately; MCP tool calls
 *      always see latest state.
 *   4. Write MCP client configs (Claude Desktop, Cursor, Claude Code CLI,
 *      Codex CLI, VS Code Copilot Chat, Continue).
 *   5. Stamp the setup marker.
 *   6. Print summary + URL.
 *
 * On update (marker file already exists): teardown old daemon, install
 * new one (so the binary is fresh), reconfigure, print "updated".
 *
 * Suppressed by `npm install --silent`, `CI=1`, `CODEATLAS_NO_POSTINSTALL=1`,
 * or `--ignore-scripts`. Never throws — best-effort everywhere so a
 * failure inside auto-config doesn't break the npm install.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateWorkspace } from './workspaceValidator';
import { setupMarkerPath } from './platformPaths';
import { provisionDaemon, type ProvisionResult } from './provisionDaemon';

const BAR = '─'.repeat(64);

async function main(): Promise<void> {
    if (isSuppressed()) return;

    // INIT_CWD is npm's "where install was invoked". When set, that's
    // our target workspace. When unset (some yarn / pnpm versions, or
    // when running this script directly), fall back to a banner.
    const initCwd = process.env.INIT_CWD;
    if (!initCwd) {
        printNoContextBanner();
        return;
    }

    const validation = validateWorkspace(initCwd);
    if (validation.verdict !== 'looks-like-workspace') {
        printNotARepoBanner(initCwd, validation.reason);
        return;
    }

    const isUpdate = fileExists(markerPath());

    try {
        const result = await provision(initCwd, isUpdate);
        printSuccessBanner(initCwd, result, isUpdate);
    } catch (err: any) {
        // Never fail the npm install for an auto-config blip — the user
        // can always run `codeatlas-mcp setup` manually to recover.
        printFallbackBanner(initCwd, err?.message ?? String(err));
    }
}

async function provision(workspacePath: string, isUpdate: boolean): Promise<ProvisionResult> {
    // The bundled `mcp-server.js` sits next to this script at runtime
    // (we're running from `<install-dir>/dist/postinstall-hint.js`).
    const mcpServerJs = path.resolve(__dirname, 'mcp-server.js');
    const result = await provisionDaemon({
        workspacePath,
        mcpServerJs,
        nodeBin: process.execPath,
        isUpdate,
        previousPort: readMarkerPort(),
    });
    // Stamp marker for update detection + port reuse.
    writeMarker(workspacePath, result.port, result.daemonId);
    return result;
}

// ── banners ──────────────────────────────────────────────────────────────

function printSuccessBanner(workspacePath: string, r: ProvisionResult, isUpdate: boolean): void {
    const url = `http://localhost:${r.port}`;
    // Capture every line so we can also write the full banner to a
    // last-install file. Many npm install pipelines swallow stdout when
    // piped through `tee` / `tail` / CI runners — losing the URL is the
    // single most common UX failure for this kind of tool. Writing the
    // same banner to `~/.config/codeatlas/last-install.txt` means
    // `cat ~/.config/codeatlas/last-install.txt` always recovers it.
    const lines: string[] = [];
    const w = (s: string) => { process.stdout.write(s); lines.push(s); };

    w(`\n${BAR}\n`);
    w(`  ✅ CodeAtlas MCP ${readVersion()} ${isUpdate ? 're-installed' : 'installed'} for this repo.\n`);
    w(`\n`);
    w(`  👉  Open your codebase live in the browser:  ${url}\n`);
    w(`\n`);
    w(`     What you can do there:\n`);
    w(`       • Live diagrams: System Design → Features → APIs → Sequences → Flow\n`);
    w(`       • Ask Claude/Cursor: "what does <route> do?", "what breaks if I change X?"\n`);
    w(`       • AI Code Review with custom guidelines; findings link back to the code\n`);
    w(`       • Daemon keeps every answer fresh as you edit — bookmark the URL.\n`);
    w(`\n`);
    w(`  Workspace:  ${workspacePath}\n`);
    w(`  Daemon:     ${r.daemonStarted ? 'RUNNING' : 'INSTALLED (start failed — see notes)'} (${r.daemonId})\n`);
    w(`\n`);

    const configured = r.clientsConfigured.filter(c => c.status === 'created' || c.status === 'updated');
    const unchanged = r.clientsConfigured.filter(c => c.status === 'no-change');
    const failed = r.clientsConfigured.filter(c => c.status.startsWith('failed'));

    if (configured.length > 0) {
        w(`  MCP clients configured:\n`);
        for (const c of configured) w(`    ✓ ${c.displayName.padEnd(24)} (${c.status})\n`);
        w(`\n`);
    }
    if (unchanged.length > 0) {
        w(`  Already up to date: ${unchanged.map(c => c.displayName).join(', ')}\n`);
    }
    if (failed.length > 0) {
        w(`  Skipped due to errors:\n`);
        for (const c of failed) w(`    ! ${c.displayName}: ${c.status}\n`);
    }

    if (r.daemonNotes.length > 0) {
        w(`\n  Daemon notes:\n`);
        for (const n of r.daemonNotes) w(`    • ${n}\n`);
    }

    w(`\n`);
    w(`  Restart your MCP clients to load the config:\n`);
    const hints = uniqHints(configured);
    for (const h of hints) w(`    • ${h}\n`);

    // Best-effort Codex tip — only surface when Codex was actually
    // configured this run. Recent Codex versions use TOML config; our
    // writer always emits JSON, so flag the recovery path.
    if (configured.some(c => c.id === 'codex')) {
        w(`\n`);
        w(`  Codex CLI note (best-effort): wrote ~/.codex/config.json.\n`);
        w(`  If a Codex session doesn't pick up CodeAtlas after restart,\n`);
        w(`  your Codex version may use TOML — try adding the same entry\n`);
        w(`  to ~/.codex/config.toml. \`codeatlas-mcp doctor\` shows both.\n`);
    }

    w(`\n`);
    w(`  Open the live browser surface:  ${url}\n`);
    w(`  Diagnostics:                    codeatlas-mcp doctor\n`);
    w(`  Disable daemon:                 codeatlas-mcp teardown\n`);
    w(`${BAR}\n\n`);

    // Persist the full banner so users can recover the URL even if npm
    // piped stdout through `tee` / `tail` / a CI buffer (`cat
    // ~/.config/codeatlas/last-install.txt` always works). Best-effort —
    // failing to write the recovery file shouldn't fail the install.
    try {
        const lastInstallPath = path.join(os.homedir(), '.config', 'codeatlas', 'last-install.txt');
        fs.mkdirSync(path.dirname(lastInstallPath), { recursive: true });
        fs.writeFileSync(lastInstallPath, lines.join(''), 'utf-8');
    } catch { /* informational only */ }
}

function printNoContextBanner(): void {
    process.stdout.write(`\n${BAR}\n`);
    process.stdout.write(`  ✅ CodeAtlas MCP ${readVersion()} installed.\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`  Couldn't auto-detect the workspace (npm's INIT_CWD wasn't set).\n`);
    process.stdout.write(`  Finish setup manually:\n`);
    process.stdout.write(`    cd /path/to/your/repo\n`);
    process.stdout.write(`    npx codeatlas-mcp setup\n`);
    process.stdout.write(`${BAR}\n\n`);
}

function printNotARepoBanner(cwd: string, reason: string): void {
    process.stdout.write(`\n${BAR}\n`);
    process.stdout.write(`  ⚠️  CodeAtlas MCP ${readVersion()} installed BUT auto-config skipped.\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`  This doesn't look like a code repo:\n`);
    process.stdout.write(`    ${cwd}\n`);
    process.stdout.write(`    ${reason}\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`  Re-install inside your repo:\n`);
    process.stdout.write(`    cd /path/to/your/repo\n`);
    process.stdout.write(`    npm install --save-dev @codeatlas/mcp\n`);
    process.stdout.write(`${BAR}\n\n`);
}

function printFallbackBanner(workspace: string, errMsg: string): void {
    process.stdout.write(`\n${BAR}\n`);
    process.stdout.write(`  ⚠️  CodeAtlas MCP ${readVersion()} installed but auto-config hit a snag.\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`  Workspace:  ${workspace}\n`);
    process.stdout.write(`  Error:      ${errMsg}\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`  Recover manually:\n`);
    process.stdout.write(`    npx codeatlas-mcp setup\n`);
    process.stdout.write(`    npx codeatlas-mcp doctor\n`);
    process.stdout.write(`${BAR}\n\n`);
}

// ── helpers ──────────────────────────────────────────────────────────────

function isSuppressed(): boolean {
    return process.env.npm_config_loglevel === 'silent'
        || process.env.CI === '1' || process.env.CI === 'true'
        || process.env.CODEATLAS_NO_POSTINSTALL === '1';
}

function markerPath(): string {
    return setupMarkerPath();
}

function fileExists(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readMarkerPort(): number | undefined {
    try {
        const raw = fs.readFileSync(markerPath(), 'utf-8');
        const data = JSON.parse(raw);
        if (typeof data.port === 'number' && data.port > 0) return data.port;
    } catch { /* ignore */ }
    return undefined;
}

function writeMarker(workspace: string, port: number, daemonId: string): void {
    try {
        fs.mkdirSync(path.dirname(markerPath()), { recursive: true });
        const data = {
            schemaVersion: 2,
            lastSetupAt: new Date().toISOString(),
            lastWorkspace: workspace,
            port,
            daemonId,
        };
        fs.writeFileSync(markerPath(), JSON.stringify(data, null, 2) + '\n', 'utf-8');
    } catch { /* informational */ }
}

function readVersion(): string {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
        return `v${pkg.version}`;
    } catch { return ''; }
}

function uniqHints(rows: Array<{ restartHint: string }>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of rows) {
        if (!seen.has(r.restartHint)) {
            seen.add(r.restartHint);
            out.push(r.restartHint);
        }
    }
    return out;
}

// Surface for future subcommands referenced from the banner copy.
void os;

main().catch(() => { /* never throw — banner is best-effort */ });
