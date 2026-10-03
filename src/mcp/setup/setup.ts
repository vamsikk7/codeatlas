/**
 * setup.ts — `codeatlas-mcp setup [workspace]` subcommand.
 *
 * One-shot installer that:
 *   1. Detects MCP clients present on the host.
 *   2. Writes the CodeAtlas MCP server entry into each client's config.
 *   3. Stamps a marker file so updates can detect "previously set up".
 *   4. Prints next-steps + the browser URL.
 *
 * Idempotent — re-running fixes drift (changed workspace path,
 * upgraded args). Per-client config is atomic + backed up before
 * first modification.
 *
 * Args:
 *   - `[workspace]` — positional. Defaults to `process.cwd()`.
 *   - `--no-browser` — write the entry without `--browser` flag.
 *   - `--read-only` — write the entry with `--read-only` flag.
 *   - `--only=claude-desktop,cursor,…` — restrict to a comma-separated subset.
 *   - `--dry-run` — print what would change, don't write anything.
 *
 * Exit codes:
 *   0 → at least one client wired, or already up-to-date everywhere.
 *   1 → unrecoverable error (FS write failure on every detected client).
 *   2 → no clients detected (host has none of the supported tools installed).
 */

import * as fs from 'fs';
import * as path from 'path';
import { detectClients, filterActionableClients, type DetectedClient, type ClientId } from './clientDetectors';
import { writeClientConfig, type CodeAtlasServerEntry, type WriteResult } from './configWriters';
import { setupMarkerPath } from './platformPaths';
import { validateWorkspace } from './workspaceValidator';
import { provisionDaemon } from './provisionDaemon';

interface SetupArgs {
    workspace: string;
    browser: boolean;
    readOnly: boolean;
    onlySet: Set<ClientId> | null;
    dryRun: boolean;
    force: boolean;
    /**
     * Override path: write the entry to this exact JSON file regardless
     * of detection. Future-proofs against MCP clients moving their
     * config files or against custom layouts. Treated as `mcp-servers-json`
     * format (top-level `mcpServers` map).
     */
    customConfigPaths: string[];
    /**
     * #MCP-PKG-2 (2026-06-07): install the launchd / systemd / schtasks
     * daemon that keeps the browser surface persistently fresh. Default
     * `true`. Set `--no-daemon` when the user wants client-config-only
     * (e.g. on a CI box where they don't need a background server).
     */
    installDaemon: boolean;
}

export async function runSetup(argv: string[]): Promise<number> {
    const args = parseArgs(argv);

    // Workspace sanity-check — refuse to wire configs pointing at a
    // non-code path unless the user explicitly forces it. Without this
    // the user gets a "successfully configured" message + an MCP server
    // that returns empty results forever.
    const resolvedWorkspace = path.resolve(args.workspace);
    const validation = validateWorkspace(resolvedWorkspace);

    if (validation.verdict === 'path-missing' || validation.verdict === 'path-not-directory') {
        // Hard error regardless of --force — pointing at a missing/non-dir
        // path is never useful.
        console.error(`❌ ${validation.reason}`);
        console.error(``);
        console.error(`Usage:  codeatlas-mcp setup [workspace]`);
        console.error(`Example: codeatlas-mcp setup ~/work/my-repo`);
        return 1;
    }
    if (validation.verdict === 'no-signals' && !args.force) {
        console.error(`⚠️  This path doesn't look like a code workspace:`);
        console.error(`   ${resolvedWorkspace}`);
        console.error(``);
        console.error(`   ${validation.reason}`);
        console.error(``);
        console.error(`What to do:`);
        console.error(`  1. Re-run with the path to your repo (recommended):`);
        console.error(`       codeatlas-mcp setup /path/to/your/repo`);
        console.error(`  2. Or cd into your repo first and re-run with no args:`);
        console.error(`       cd /path/to/your/repo && codeatlas-mcp setup`);
        console.error(`  3. Or skip this check (the indexed workspace will be empty):`);
        console.error(`       codeatlas-mcp setup --force`);
        console.error(``);
        return 1;
    }
    if (validation.verdict === 'no-signals' && args.force) {
        console.warn(`⚠️  --force: writing configs for a path with no workspace signals.`);
        console.warn(`   ${resolvedWorkspace}`);
        console.warn(`   The MCP server will index 0 files. Edit the configured path later`);
        console.warn(`   in each client's settings, or re-run setup against your repo.`);
        console.warn(``);
    }

    const detected = filterActionableClients(detectClients());
    const detectedFiltered = args.onlySet ? detected.filter(c => args.onlySet!.has(c.id)) : detected;
    const custom = args.customConfigPaths.map(buildCustomClient);
    const filtered = [...detectedFiltered, ...custom];

    if (filtered.length === 0) {
        if (args.onlySet) {
            console.error(`❌ None of the requested clients are installed on this host.`);
            console.error(`   Detected: ${detectClients().filter(c => c.configFileExists || c.configDirExists).map(c => c.id).join(', ') || '(none)'}`);
            return 2;
        }
        console.error(`❌ No MCP clients detected on this host.`);
        console.error(`   We look for: Claude Desktop, Cursor, Claude Code CLI, Codex CLI, VS Code Copilot Chat, Continue.`);
        console.error(`   If you've installed one but its config dir is somewhere else, re-run with --only=<client> and we'll create it.`);
        return 2;
    }

    const entry: CodeAtlasServerEntry = {
        workspace: args.workspace,
        browser: args.browser,
        readOnly: args.readOnly,
    };

    if (args.dryRun) {
        console.log(`🔍 Dry run — no files will be written.\n`);
        console.log(`Workspace:      ${path.resolve(args.workspace)}`);
        console.log(`Browser:        ${args.browser ? 'on' : 'off'}`);
        console.log(`Read-only:      ${args.readOnly ? 'on' : 'off'}`);
        console.log(`Install daemon: ${args.installDaemon ? 'on (launchd / systemd / schtasks)' : 'off'}\n`);
        console.log(`Would write to:`);
        for (const c of filtered) {
            console.log(`  • ${c.displayName.padEnd(24)} ${c.configPath}`);
        }
        return 0;
    }

    const results: WriteResult[] = [];
    const failures: Array<{ client: DetectedClient; error: Error }> = [];

    for (const client of filtered) {
        try {
            results.push(writeClientConfig(client, entry));
        } catch (err: any) {
            failures.push({ client, error: err instanceof Error ? err : new Error(String(err)) });
        }
    }

    // #MCP-PKG-2 (2026-06-07): also install the daemon, the same way the
    // npm-postinstall hook does. Without this step, `codeatlas-mcp setup`
    // left users with client configs but no persistent browser surface —
    // they had to ALSO know about the npm postinstall flow to get
    // localhost:7842 to stay up. Symmetric provisioning closes that gap.
    let provisionResult: Awaited<ReturnType<typeof provisionDaemon>> | null = null;
    if (args.installDaemon) {
        try {
            // The bundled mcp-server.js sits next to setup's caller at
            // runtime: when invoked via `npx @codeatlas/mcp setup`,
            // both this file and `mcp-server.js` end up under
            // `<install-dir>/dist/`. Worst case (e.g. unusual install
            // layout) the postinstall hook is also a fallback path.
            const mcpServerJs = path.resolve(__dirname, 'mcp-server.js');
            provisionResult = await provisionDaemon({
                workspacePath: resolvedWorkspace,
                mcpServerJs,
                nodeBin: process.execPath,
                isUpdate: fs.existsSync(setupMarkerPath()),
                previousPort: undefined,
                writeClientConfigs: false, // already done above
            });
        } catch (err: any) {
            // Daemon install is best-effort — surface a warning but
            // never fail the setup outright. The user still has working
            // client configs.
            console.warn(`\n⚠️  Daemon install failed: ${err?.message ?? err}`);
            console.warn(`   The MCP clients still work via per-call spawn. To retry:`);
            console.warn(`     npx @codeatlas/mcp setup ${resolvedWorkspace}`);
        }
    }

    printReport(results, failures, entry);
    if (provisionResult) printDaemonReport(provisionResult);

    if (results.length > 0) {
        writeMarker(args.workspace, results);
    }

    if (failures.length > 0 && results.length === 0) return 1;
    return 0;
}

function printDaemonReport(r: Awaited<ReturnType<typeof provisionDaemon>>): void {
    console.log('');
    console.log(`Daemon:     ${r.daemonStarted ? 'RUNNING' : 'INSTALLED (start failed — see notes)'} (${r.daemonId})`);
    console.log(`Browser:    http://localhost:${r.port}`);
    if (!r.portIsPreferred) {
        console.log(`            (port 7842 was busy; using ${r.port} instead)`);
    }
    if (r.daemonNotes.length > 0) {
        console.log(`\nDaemon notes:`);
        for (const n of r.daemonNotes) console.log(`  • ${n}`);
    }
}

function parseArgs(argv: string[]): SetupArgs {
    let workspace = process.cwd();
    let browser = true;
    let readOnly = false;
    let onlySet: Set<ClientId> | null = null;
    let dryRun = false;
    let force = false;
    // #MCP-PKG-2 — default ON. The previous behavior left users with no
    // running daemon after `codeatlas-mcp setup`, so the browser surface
    // only stayed up while a manual MCP process was running.
    let installDaemon = true;
    const customConfigPaths: string[] = [];

    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--no-browser') browser = false;
        else if (arg === '--browser') browser = true;
        else if (arg === '--read-only') readOnly = true;
        else if (arg === '--dry-run') dryRun = true;
        else if (arg === '--force') force = true;
        else if (arg === '--no-daemon') installDaemon = false;
        else if (arg === '--daemon') installDaemon = true;
        else if (arg.startsWith('--only=')) {
            const csv = arg.slice('--only='.length);
            onlySet = new Set(csv.split(',').map(s => s.trim()) as ClientId[]);
        } else if (arg === '--client-config') {
            // --client-config <path>  (next argv slot)
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) {
                customConfigPaths.push(next);
                i++;
            }
        } else if (arg.startsWith('--client-config=')) {
            customConfigPaths.push(arg.slice('--client-config='.length));
        } else if (!arg.startsWith('--')) {
            positional.push(arg);
        }
    }

    if (positional.length > 0) workspace = positional[0];
    return { workspace, browser, readOnly, onlySet, dryRun, force, customConfigPaths, installDaemon };
}

function printReport(
    results: WriteResult[],
    failures: Array<{ client: DetectedClient; error: Error }>,
    entry: CodeAtlasServerEntry,
): void {
    const created = results.filter(r => r.status === 'created');
    const updated = results.filter(r => r.status === 'updated');
    const unchanged = results.filter(r => r.status === 'no-change');

    console.log('');
    console.log(`✅ CodeAtlas MCP configured on this host.`);
    console.log('');
    console.log(`Workspace:  ${path.resolve(entry.workspace)}`);
    console.log(`Browser:    ${(entry.browser !== false) ? 'http://localhost:7842 (when the server is running)' : 'disabled'}`);
    if (entry.readOnly) console.log(`Mode:       read-only`);
    console.log('');

    if (created.length > 0) {
        console.log(`Created config for:`);
        for (const r of created) console.log(`  ✓ ${r.client.displayName}  →  ${r.client.configPath}`);
        console.log('');
    }
    if (updated.length > 0) {
        console.log(`Updated config for:`);
        for (const r of updated) {
            const backup = r.backupPath ? `  (backup: ${path.basename(r.backupPath)})` : '';
            console.log(`  ✓ ${r.client.displayName}  →  ${r.client.configPath}${backup}`);
        }
        console.log('');
    }
    if (unchanged.length > 0) {
        console.log(`Already up to date:`);
        for (const r of unchanged) console.log(`  • ${r.client.displayName}`);
        console.log('');
    }
    if (failures.length > 0) {
        console.log(`Skipped due to errors:`);
        for (const f of failures) console.log(`  ! ${f.client.displayName}: ${f.error.message}`);
        console.log('');
    }

    console.log(`Next steps:`);
    const restartGroups: Record<string, string[]> = {};
    for (const r of [...created, ...updated]) {
        if (!restartGroups[r.client.restartHint]) restartGroups[r.client.restartHint] = [];
        restartGroups[r.client.restartHint].push(r.client.displayName);
    }
    let n = 1;
    for (const [hint, names] of Object.entries(restartGroups)) {
        console.log(`  ${n}. ${names.join(', ')} — ${hint}`);
        n++;
    }
    if (Object.keys(restartGroups).length === 0) {
        console.log(`  (no restarts needed — everything was already configured)`);
    }
    console.log('');
    console.log(`Open the browser surface anytime:`);
    console.log(`  codeatlas-mcp ${path.resolve(entry.workspace)}`);
    console.log(`  → http://localhost:7842`);
    console.log('');
    console.log(`Diagnostics:  codeatlas-mcp doctor`);
    console.log('');
}

/**
 * Synthesise a `DetectedClient` from an explicit user-supplied config
 * path. Bypasses detection — we just write the entry there directly.
 * The display name uses `"Custom (<basename>)"` so it stands out in
 * the per-client report.
 */
function buildCustomClient(configPath: string): DetectedClient {
    const absolute = path.resolve(configPath);
    return {
        id: 'custom' as ClientId,
        displayName: `Custom (${path.basename(absolute)})`,
        configPath: absolute,
        configDir: path.dirname(absolute),
        configFileExists: fs.existsSync(absolute),
        configDirExists: fs.existsSync(path.dirname(absolute)),
        format: 'mcp-servers-json',
        restartHint: `Reload whatever consumer reads ${absolute}.`,
    };
}

function writeMarker(workspace: string, results: WriteResult[]): void {
    const markerPath = setupMarkerPath();
    try {
        fs.mkdirSync(path.dirname(markerPath), { recursive: true });
        const data = {
            schemaVersion: 1,
            lastSetupAt: new Date().toISOString(),
            lastWorkspace: path.resolve(workspace),
            configuredClients: results.map(r => ({
                id: r.client.id,
                configPath: r.client.configPath,
                status: r.status,
            })),
        };
        fs.writeFileSync(markerPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    } catch {
        // Marker is informational — failing to write it shouldn't fail setup.
    }
}
