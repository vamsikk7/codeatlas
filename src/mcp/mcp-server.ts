#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerMcpResources } from './mcp-resources';
import { registerMcpTools } from './mcp-tools';
import { WorkspaceBootstrap } from './workspaceBootstrap';
import { startStandaloneServer, resolveDistDir, type StandaloneServer } from '../standalone/server';
import { isSurvivableDaemonError, hardenOutboundConnections } from '../standalone/daemonResilience';
import type { SnapshotStore } from '../core/storage/snapshotStore';
import { McpAnalytics, hashWorkspaceRoot } from './analytics/mcpAnalytics';

// `MCP_SERVER_VERSION` + `MCP_SERVER_BUILD` are injected at build time by
// esbuild's `define` from `mcp-package/package.json`. The combined stamp
// `<version>.<build>` mirrors the extension's `<version>.<buildNumber>`
// pattern so iterating users can tell builds apart within one semver.
// When running un-bundled (tests, dev), MCP_SERVER_VERSION is `undefined`
// and the fallback `'dev'` keeps telemetry attributable.
declare const MCP_SERVER_VERSION: string;
declare const MCP_SERVER_BUILD: number;
const SERVER_VERSION = (() => {
    if (typeof MCP_SERVER_VERSION !== 'string' || !MCP_SERVER_VERSION) return 'dev';
    const build = typeof MCP_SERVER_BUILD === 'number' && MCP_SERVER_BUILD > 0
        ? `.${MCP_SERVER_BUILD}`
        : '';
    return `${MCP_SERVER_VERSION}${build}`;
})();

// CLI surface for the standalone npm package
// `npx @codeatlas/mcp <subcommand|workspace> [flags]`
//
// Subcommands:
//   `setup [workspace]` — wire MCP client configs (Claude Desktop, Cursor, …)
//   `doctor`            — diagnostic dump for triage
//   `review-pr [path] --base <ref> [--head <ref>] [--repo o/r --pr N --post]`
//                       — #850 CI-driven PR review commenter (GitHub Action)
//   `--version` / `-V`  — print version and exit
//   `--help` / `-h`     — print usage and exit
//
// Anything else is treated as a workspace path → run the MCP server.
const subcommand = process.argv[2];
if (subcommand === 'setup' || subcommand === 'doctor' || subcommand === 'teardown'
    || subcommand === 'review-pr'
    || subcommand === '--version' || subcommand === '-V'
    || subcommand === '--help' || subcommand === '-h') {
    void (async () => {
        try {
            if (subcommand === '--version' || subcommand === '-V') {
                console.log(SERVER_VERSION);
                process.exit(0);
            }
            if (subcommand === '--help' || subcommand === '-h') {
                printHelp();
                process.exit(0);
            }
            if (subcommand === 'setup') {
                const { runSetup } = await import('./setup/setup');
                const code = await runSetup(process.argv.slice(3));
                process.exit(code);
            }
            if (subcommand === 'doctor') {
                const { runDoctor } = await import('./setup/doctor');
                const code = await runDoctor();
                process.exit(code);
            }
            if (subcommand === 'teardown') {
                const { runTeardown } = await import('./setup/teardown');
                const code = await runTeardown(process.argv.slice(3));
                process.exit(code);
            }
            if (subcommand === 'review-pr') {
                // #850 — one-shot PR review commenter (designed for GitHub
                // Actions on pull_request events; --post needs GITHUB_TOKEN).
                // INVARIANT: loaded from the SIBLING bundle at runtime, never
                // bundled into mcp-server.js — adding reviewPrCli to this
                // bundle's graph reorders zod's module init and crashes the
                // MCP SDK's schema construction at load time; see ADR-044.
                const pathMod = await import('path');
                const cliPath = pathMod.join(__dirname, 'review-pr-cli.js');
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { runReviewPr, parseReviewPrArgs } = require(cliPath) as typeof import('../standalone/reviewPrCli');
                const parsed = parseReviewPrArgs(process.argv.slice(3));
                if ('error' in parsed) {
                    console.error(`review-pr: ${parsed.error}`);
                    console.error('Usage: codeatlas-mcp review-pr [repoPath] --base <ref> [--head <ref>] [--repo owner/name --pr <N> --post] [--token <t>]');
                    process.exit(2);
                }
                const result = await runReviewPr(parsed);
                process.exit(result.exitCode);
            }
        } catch (err: any) {
            console.error(`Subcommand failed: ${err?.message ?? err}`);
            process.exit(1);
        }
    })();
    // Suspend the rest of mcp-server.ts on the async branch above. The
    // synchronous tail below runs only when no subcommand matched.
} else {

const workspaceRoot = process.argv[2] || process.cwd();
const readOnly = process.argv.includes('--read-only');
// Browser surface auto-on when:
//   - `--browser` flag explicitly passed, OR
//   - `CODEATLAS_BROWSER=1` env, OR
//   - **stdin is a TTY** — meaning a human ran `codeatlas-mcp <path>` directly,
//     NOT an MCP client spawning us as a stdio child (MCP clients pipe stdin).
// Explicit `--no-browser` always wins so MCP clients can suppress it.
const stdinIsTty = (process.stdin as any).isTTY === true;
const browserExplicitOn = process.argv.includes('--browser')
    || process.env.CODEATLAS_BROWSER === '1'
    || process.env.CODEATLAS_BROWSER === 'true';
const browserExplicitOff = process.argv.includes('--no-browser')
    || process.env.CODEATLAS_BROWSER === '0'
    || process.env.CODEATLAS_BROWSER === 'false';
const browserMode = browserExplicitOff ? false : (browserExplicitOn || stdinIsTty);
const noOpen = process.argv.includes('--no-open');
// `--no-stdio` — daemon-mode flag. When set, skip the MCP stdio transport
// entirely (don't subscribe to stdin EOF, don't `server.connect(transport)`).
// Used by the per-OS daemon installers (launchctl / systemctl / schtasks)
// where launchd closes stdin immediately, which under the normal code path
// would tear the server down within milliseconds and crash-loop forever.
const noStdio = process.argv.includes('--no-stdio');
// `--port <N>` — explicit port override; otherwise resolved from settings (default 7842)
function parsePort(): number | undefined {
    const idx = process.argv.indexOf('--port');
    if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
    const n = Number(process.argv[idx + 1]);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

// #SA: storage dir name. Standalone defaults to `.codeatlas-sa` to avoid
// SQLite WAL lock contention when the VS Code extension is also running on
// the same workspace. The legacy `.codeatlas` is preserved when the user
// explicitly opts in via `--storage-dir .codeatlas` (e.g. to share state).
function parseStorageDirName(): string {
    const idx = process.argv.indexOf('--storage-dir');
    if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
    return '.codeatlas-sa';
}

// Issue #710 — static dashboard export. `--export <outDir>` runs init,
// serialises the snapshot + findings, copies the webview UI, and exits.
// Optional `--token <secret>` injects a client-side gate into index.html.
function parseExportOpts(): { outDir: string; token?: string } | null {
    const idx = process.argv.indexOf('--export');
    if (idx === -1 || idx + 1 >= process.argv.length) return null;
    const outDir = process.argv[idx + 1];
    const tokenIdx = process.argv.indexOf('--token');
    const token = tokenIdx !== -1 && tokenIdx + 1 < process.argv.length
        ? process.argv[tokenIdx + 1]
        : undefined;
    return { outDir, token };
}

async function runServer() {
    // Issue #724 — initialise Sentry for the standalone runtime FIRST so
    // any boot-time crash lands as a report. Same shim as the extension
    // host; no-op when telemetry is opted out or the SDK isn't installed.
    try {
        const { initSentry } = await import('../errors/sentryNode');
        initSentry('mcp-standalone');
    } catch { /* shim missing — should not happen */ }

    const server = new Server({
        name: 'codeatlas-mcp',
        version: '0.2.0',
    }, {
        capabilities: {
            resources: {},
            tools: {},
        }
    });

    // Telemetry. Opt-OUT via `CODEATLAS_TELEMETRY=0` (or `DO_NOT_TRACK=1`).
    // Boot is emitted before any tool registration so we capture every
    // server start, even ones that fail later.
    const analytics = new McpAnalytics({
        mcpServerVersion: SERVER_VERSION,
        workspaceHash: hashWorkspaceRoot(workspaceRoot),
        storageDir: parseStorageDirName(),
        browserMode,
        readOnly,
    });
    analytics.start();

    // Bootstrap the workspace: detect codebase, acquire write-lock, init the
    // snapshot if missing, start a file watcher for incremental rebuilds.
    const storageDirName = parseStorageDirName();
    // ADR-034 multi-repo MCP — `--repo <name>` selects the primary repo
    // when the workspace has a `.codeatlas/monorepo.db`. Falls back to the
    // alphabetically-first rootPath when omitted. No-op in single-repo
    // workspaces.
    const repoOverride = (() => {
        const idx = process.argv.indexOf('--repo');
        if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
        const val = process.argv[idx + 1];
        return val && !val.startsWith('--') ? val : undefined;
    })();
    const bootstrap = new WorkspaceBootstrap(workspaceRoot, { readOnly, storageDirName, repo: repoOverride });

    // ── TICKET-PERF-1: server-first bootstrap ──────────────────────────────
    // Bind the diagram browser server BEFORE the heavy `initialize()` so a
    // browser opened on a large repo connects immediately (loading state)
    // instead of hitting ~14s of connection-refused while init blocks. Wired to
    // `bootstrap.onReposReady` (fires inside start() once the primary store is
    // loaded + sub-repos detected + the lock held, but before init). Idempotent
    // (double-start guarded) + falls back to a post-start call for the read-only
    // / cached-load paths that early-return before the hook. Browser-mode
    // failures never take the stdio MCP server down.
    let standalone: StandaloneServer | undefined;
    let browserHandlersInstalled = false;
    const startBrowserServerOnce = async (): Promise<void> => {
        if (!browserMode || standalone) return;
        hardenOutboundConnections();
        if (!browserHandlersInstalled) {
            browserHandlersInstalled = true;
            process.on('uncaughtException', (err: any) => {
                if (isSurvivableDaemonError(err)) {
                    process.stderr.write(`CodeAtlas: survivable daemon error (${err?.code ?? err?.message}); live updates may degrade, daemon continues.\n`);
                    return;
                }
                process.stderr.write(`CodeAtlas: uncaught exception: ${err?.stack ?? err}\n`);
                process.exit(1);
            });
            process.on('unhandledRejection', (reason: any) => {
                if (isSurvivableDaemonError(reason)) {
                    process.stderr.write('CodeAtlas: survivable daemon error in async op; daemon continues.\n');
                    return;
                }
                process.stderr.write(`CodeAtlas: unhandled rejection: ${reason?.stack ?? reason}\n`);
            });
        }
        try {
            const distDir = resolveDistDir(__filename);
            const mr = bootstrap.getMultiRepo();
            const multiRepoForServer = mr ? {
                aggregator: mr.aggregator,
                perRepoStores: new Map<string, SnapshotStore>(mr.repoStores),
                repos: mr.repos.map(r => ({ repoId: r.repoId, name: r.name, rootPath: r.rootPath })),
            } : undefined;
            standalone = await startStandaloneServer({
                workspaceRoot,
                snapshotStore: bootstrap.getStore(), // primary store (post-openMultiRepo); populated live as init runs
                distDir,
                port: parsePort(),
                autoOpen: !noOpen,
                log: (m) => process.stderr.write(`${m}\n`),
                mcpServerVersion: SERVER_VERSION,
                multiRepo: multiRepoForServer,
                handleFileSave: async (fp) => { if (await bootstrap.handleFileChange?.(fp)) standalone?.notifyRefresh?.(fp); },
                handleFileCreated: async (fp) => { if (await bootstrap.handleFileChange?.(fp)) standalone?.notifyRefresh?.(fp); },
                handleFileDeleted: async (fp) => { if (await bootstrap.handleFileChange?.(fp)) standalone?.notifyRefresh?.(fp); },
            });
            process.stderr.write(`CodeAtlas browser ready: http://localhost:${standalone.port}\n`);
            analytics.track('mcp_browser_started', { port: standalone.port });
            const serverHandle = standalone;
            bootstrap.setCrossRepoBroadcast(
                (msg) => serverHandle.broadcast(msg),
                () => serverHandle.settings.get<boolean>('codeatlas.crossRepoPush') !== false,
            );
            bootstrap.onExternalReload(() => serverHandle.notifyRefresh(''));
        } catch (err: any) {
            // INVARIANT: browser-mode failures must NOT take the MCP server down.
            process.stderr.write(`CodeAtlas: --browser mode failed to start: ${err?.message ?? err}\n`);
            analytics.track('mcp_browser_start_failed', { error_message: String(err?.message ?? err).slice(0, 500) });
        }
    };
    if (browserMode) bootstrap.onReposReady(startBrowserServerOnce);

    const initStartMs = Date.now();
    let initialStatus;
    try {
        initialStatus = await bootstrap.start();
        analytics.track('mcp_workspace_init_complete', {
            duration_ms: Date.now() - initStartMs,
            status: initialStatus.status,
            mode: (initialStatus as any).mode ?? 'unknown',
        });
    } catch (err: any) {
        analytics.track('mcp_workspace_init_failed', {
            duration_ms: Date.now() - initStartMs,
            error_message: String(err?.message ?? err).slice(0, 500),
        });
        throw err;
    }
    const snapshotStore = bootstrap.getStore();

    // Issue #710 — static export mode runs after init + exits. No tool
    // registration, no transport, no analytics — just dump the snapshot
    // + webview + README to the requested directory.
    const exportOpts = parseExportOpts();
    if (exportOpts) {
        const { exportStaticDashboard } = await import('../standalone/exportStaticDashboard');
        const result = await exportStaticDashboard(snapshotStore, undefined, {
            outDir: exportOpts.outDir,
            token: exportOpts.token,
            log: (msg) => process.stderr.write(msg + '\n'),
        });
        process.stderr.write(`[codeatlas] static export complete — ${result.fileCount} files, ${(result.totalBytes / 1024 / 1024).toFixed(2)} MB at ${result.outDir}\n`);
        process.exit(0);
    }

    // Tool registrations need access to the bootstrap status so a caller
    // hitting an early call before init completes (or against a non-codebase)
    // gets a structured response instead of empty arrays. We expose status
    // via a getter the tools layer can read from the registered metadata.
    (snapshotStore as any).__bootstrapStatus = () => bootstrap.getStatus();
    // ADR-034 multi-repo MCP — stash the multi-repo state on the store so
    // tools can read it without refactoring `registerMcpTools`'s signature.
    // Single-repo workspaces return null; tools should treat null as "use
    // the workspace as a single repo".
    (snapshotStore as any).__multiRepo = () => bootstrap.getMultiRepo();

    registerMcpResources(server, snapshotStore);
    registerMcpTools(server, snapshotStore, analytics);

    // #509 — push findings-changed notifications to subscribed stdio clients.
    // The MCP SDK lets us emit arbitrary notifications via `server.notification`.
    snapshotStore.onFindingsChanged?.((evt) => {
        try {
            (server as any).notification?.({
                method: 'notifications/codeatlas/findings_changed',
                params: evt,
            });
        } catch { /* swallow — notifications are best-effort */ }
    });

    // Refresh on incoming MCP tool calls is handled inside the tools layer
    // (see `registerMcpTools` in `mcp-tools.ts`) — calling `refresh()` on
    // every `getWorking()` invocation, as a previous version did, clobbers
    // the file-watcher's in-flight rebuilds: `rebuildFile` updates
    // `state.working.files[fp]` in memory, then a downstream `getWorking()`
    // call inside the same rebuild path refreshes from SQLite (where the
    // save hasn't yet happened) and undoes the update. Symptom: the
    // standalone in `--browser` mode showed file edits never reflecting
    // in the L4/L3/L2b/L2a/L1 cascade even though `file_rebuilt_perf`
    // telemetry fired (Issue surfaced during the 2026-05-28 live-verify
    // cycle). The refresh now happens once per inbound `tools/call`, which
    // matches the original intent ("sync with on-disk writes between
    // incoming requests") without breaking the file-watcher path.

    if (!noStdio) {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        // No session-start telemetry — sessions are counted on the dashboard.
        const mode = initialStatus.status === 'ready' ? `mode=${initialStatus.mode}` : `status=${initialStatus.status}`;
        process.stderr.write(`CodeAtlas MCP Server running on stdio for workspace: ${workspaceRoot} (${mode}, storage=${storageDirName})\n`);
    } else {
        // Daemon mode — no MCP client over stdio.
        process.stderr.write(`CodeAtlas MCP daemon running browser-only (no stdio) for workspace: ${workspaceRoot}\n`);
    }
    // One-time notice so users can see telemetry is on and how to disable it.
    // Goes to stderr so it doesn't interfere with the stdio JSON-RPC stream.
    if (!process.env.CODEATLAS_TELEMETRY_NOTICE_SUPPRESS) {
        // The notice MUST reflect the real state — printing "telemetry is on"
        // while `CODEATLAS_TELEMETRY=0`/`DO_NOT_TRACK` disabled it made the flag
        // look ignored (it isn't: analytics + Sentry both no-op when disabled).
        process.stderr.write(
            analytics.enabled
                ? 'CodeAtlas: anonymous usage telemetry is on. Disable with `CODEATLAS_TELEMETRY=0` ' +
                  '(or `DO_NOT_TRACK=1`). See https://github.com/vamsikk7/codeatlas-live-issues for the policy.\n'
                : 'CodeAtlas: telemetry disabled via CODEATLAS_TELEMETRY / DO_NOT_TRACK — nothing is sent.\n'
        );
    }

    // ── --browser mode: diagram browser on localhost ──────────────────────
    // TICKET-PERF-1 — the server is normally bound EARLY (before init) by the
    // `onReposReady` hook registered above, so browsers connect during init.
    // These two calls cover the paths that early-returned before the hook
    // (read-only / another-process-holds-lock) — `startBrowserServerOnce` is
    // idempotent — and, once init has finished, tell any browser that connected
    // mid-init to re-fetch the now-complete graphs.
    if (browserMode) {
        await startBrowserServerOnce();
        standalone?.notifyRefresh?.('');
    }

    // Clean shutdown when the parent CLI closes the stdio pipe.
    let shutdownCalled = false;
    const onExit = () => {
        if (shutdownCalled) return;
        shutdownCalled = true;
        bootstrap.stop();
        standalone?.stop().catch(() => { /* ignore shutdown errors */ });
        // Fire-and-forget — process may exit before the HTTP flush completes.
        // SIGINT/SIGTERM paths await the shutdown below; the bare `exit` event
        // can't await, accepted gap.
        analytics.shutdown().catch(() => { /* swallow */ });
    };
    process.on('exit', onExit);
    process.on('SIGINT', async () => {
        if (!shutdownCalled) {
            shutdownCalled = true;
            bootstrap.stop();
            standalone?.stop().catch(() => { /* ignore shutdown errors */ });
            await analytics.shutdown();
        }
        process.exit(0);
    });
    process.on('SIGTERM', async () => {
        if (!shutdownCalled) {
            shutdownCalled = true;
            bootstrap.stop();
            standalone?.stop().catch(() => { /* ignore shutdown errors */ });
            await analytics.shutdown();
        }
        process.exit(0);
    });
    // Stdin-EOF subscription only when we're actually using stdio as the
    // MCP transport. In daemon (--no-stdio) mode the launchd / systemd-spawned
    // process has no stdin pipe — subscribing here would fire onExit
    // immediately and tear the daemon down within milliseconds.
    if (!noStdio) {
        process.stdin.on('end', () => onExit());
    }
}

runServer().catch((error) => {
    process.stderr.write(`Fatal error running MCP Server: ${error?.stack ?? error}\n`);
    process.exit(1);
});

}  // end of "no subcommand matched" branch

function printHelp(): void {
    process.stdout.write(`codeatlas-mcp ${SERVER_VERSION}

Usage:
  codeatlas-mcp <workspace>           Run the MCP server (and browser surface
                                      when invoked from a terminal). Auto-opens
                                      http://localhost:7842 in the browser.
  codeatlas-mcp setup [workspace]     One-shot installer. Detects Claude Desktop,
                                      Cursor, Claude Code CLI, Codex CLI,
                                      Gemini CLI, VS Code Copilot Chat, and
                                      Continue; writes the CodeAtlas entry into
                                      each client's config (atomic + backed up).
                                      Use --client-config <path> to write to a
                                      custom JSON config that detection missed.
  codeatlas-mcp doctor                Diagnostic dump (platform, Node version,
                                      detected clients, daemon status,
                                      telemetry state, setup-marker contents).
  codeatlas-mcp teardown [workspace]  Remove the daemon for this workspace.
                                      Does NOT remove MCP client configs.
  codeatlas-mcp review-pr [repoPath]  One-shot PR review commenter (run it from
      --base <ref> [--head <ref>]     CI on pull_request events). Initializes
      [--repo owner/name --pr <N>     CodeAtlas at the PR base, resyncs the
       --post] [--token <t>]          changed files at head, runs the
                                      evidence-gated AI review over the changed
                                      entry points, and posts ONE review with
                                      inline comments on diff lines plus a
                                      marker-tagged summary comment (updated in
                                      place on re-runs). Without --post it
                                      prints the payload as JSON (dry-run).
                                      Needs an LLM key (OPENROUTER_API_KEY /
                                      ANTHROPIC_API_KEY / OPENAI_API_KEY) and,
                                      with --post, GITHUB_TOKEN.
  codeatlas-mcp --version             Print version.
  codeatlas-mcp --help                This help.

NOTE: @codeatlas/mcp is **local-install only**. Run inside your repo:
        cd /path/to/your/repo
        npm install --save-dev @codeatlas/mcp
      Global install (npm -g) is blocked because the daemon needs a
      specific workspace to index. Postinstall auto-configures all
      detected MCP clients and starts a per-workspace daemon on a free
      port (default 7842) so the browser surface + MCP index stay
      live as you edit code.

Server flags:
  --browser                 Force the browser surface on.
  --no-browser              Force the browser surface off (used by MCP clients
                            spawning us over stdio).
  --no-open                 Don't auto-open the system browser.
  --port <N>                Override the HTTP port (default 7842).
  --read-only               Don't write to the workspace's state.db.
  --storage-dir <name>      Storage dir name (default .codeatlas-sa).

setup flags:
  --no-browser              Write the entry without --browser.
  --read-only               Write the entry with --read-only.
  --only=<a,b,c>            Restrict to a comma-separated subset of clients
                            (claude-desktop, cursor, claude-code, codex,
                             gemini, vscode-copilot, continue).
  --client-config <path>    Write to a custom mcp-servers JSON file (use
                            for tools we don't detect natively, or when a
                            client moves its config). Repeatable.
  --force                   Skip the workspace-validity check (writes the
                            entry even if the path doesn't look like a repo).
  --dry-run                 Print what would change, don't write.

Environment:
  CODEATLAS_TELEMETRY=0          Disable anonymous usage telemetry.
  DO_NOT_TRACK=1                 Industry-standard equivalent.
  CODEATLAS_TELEMETRY_DEBUG=1    Log every telemetry send attempt (triage).
  CODEATLAS_NO_POSTINSTALL=1     Suppress the post-install banner.

Docs: https://github.com/codeatlaslive/codeatlas-live
`);
}
