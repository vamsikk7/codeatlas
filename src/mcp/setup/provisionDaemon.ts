/**
 * provisionDaemon.ts — shared provisioner used by both the `npm install`
 * postinstall hook (`postinstallHint.ts`) and the
 * `codeatlas-mcp setup` CLI (`setup.ts`).
 *
 * #MCP-PKG-2 (2026-06-07): before this module existed, only the
 * postinstall hook installed the launchd / systemd / schtasks daemon
 * that owns the persistent browser surface. Users who installed the
 * package via `npm i -g`, via `npx`, or in a directory that wasn't
 * their workspace had to know to run `codeatlas-mcp setup` AND
 * separately register a daemon themselves — `setup` only wrote MCP
 * client configs. That's the "daemon-based --browser not auto-ready
 * after install" gap. The fix: extract the provisioning logic so
 * `setup` does both client-config AND daemon install in one shot. The
 * postinstall hook now becomes a thin caller; the user-invoked CLI gets
 * symmetric behavior.
 *
 * Inputs are deliberately minimal — the caller supplies the workspace
 * path and whether this is a fresh install vs. an update; everything
 * else is derived. The function never throws; failures are surfaced
 * through the returned `ProvisionResult` so callers can render them
 * without crashing.
 */

import * as path from 'path';
import * as fs from 'fs';
import { validateWorkspace } from './workspaceValidator';
import { allocatePort } from './portAllocator';
import {
    daemonIdFor,
    installAndStart,
    uninstall as uninstallDaemon,
    type DaemonSpec,
} from './daemonManager';
import { detectClients, filterActionableClients } from './clientDetectors';
import { writeClientConfig, type CodeAtlasServerEntry } from './configWriters';

export interface ProvisionResult {
    daemonId: string;
    daemonStarted: boolean;
    daemonNotes: string[];
    servicePath: string;
    port: number;
    portIsPreferred: boolean;
    clientsConfigured: Array<{
        id: string;
        displayName: string;
        status: string;
        configPath: string;
        restartHint: string;
    }>;
}

export interface ProvisionOptions {
    /** Absolute path to the user's workspace. */
    workspacePath: string;
    /** Resolved path to the bundled `mcp-server.js`. */
    mcpServerJs: string;
    /** Node executable to bake into the daemon plist / unit / scheduled task. */
    nodeBin: string;
    /** When set, tear down an existing daemon for this workspace before re-installing. */
    isUpdate: boolean;
    /** When set, read the prior port from this path so we keep serving on the same one. */
    previousPort: number | undefined;
    /**
     * When true (default), write entries into every detected MCP client.
     * Setup's `--only=…` flag narrows this; pass a filter callback when
     * the caller already filtered.
     */
    writeClientConfigs?: boolean;
}

/**
 * Allocate a port + install + start the daemon + write client configs.
 * Returns a `ProvisionResult` describing what landed where. The
 * function is best-effort end to end — a client-write failure does NOT
 * roll back the daemon install, since the daemon is the primary value
 * delivery (it's what keeps the browser surface fresh).
 */
export async function provisionDaemon(opts: ProvisionOptions): Promise<ProvisionResult> {
    const { workspacePath, mcpServerJs, nodeBin, isUpdate, previousPort } = opts;
    const writeConfigs = opts.writeClientConfigs ?? true;

    const id = daemonIdFor(workspacePath);

    if (!fs.existsSync(mcpServerJs)) {
        throw new Error(`mcp-server.js not found at expected path: ${mcpServerJs}`);
    }

    // On update, tear down the old daemon before re-installing so we
    // don't end up with two competing processes. Idempotent — uninstall
    // is a no-op when nothing's installed.
    if (isUpdate) {
        try { uninstallDaemon(id); } catch { /* best-effort */ }
    }

    // Allocate port — prefer 7842 (MCP base; see portAllocator.ts), fall
    // back upward if taken. Distinct from the VS Code extension's 7742
    // so both can run side-by-side without colliding.
    const preferred = previousPort ?? 7842;
    const { port, preferredAvailable } = await allocatePort(preferred);

    const daemonSpec: DaemonSpec = {
        id,
        workspacePath,
        nodeBin,
        mcpServerJs,
        port,
    };
    const installResult = installAndStart(daemonSpec);

    let clientsConfigured: ProvisionResult['clientsConfigured'] = [];
    if (writeConfigs) {
        // MCP client configs use `npx @codeatlas/mcp <workspace>` so the
        // clients can still spawn their own short-lived stdio server for
        // tool calls. The daemon is what keeps the browser surface fresh
        // — `browser: false` on the client entry prevents two competing
        // browser servers from racing for the port.
        const entry: CodeAtlasServerEntry = { workspace: workspacePath, browser: false };
        const clients = filterActionableClients(detectClients());
        clientsConfigured = clients.map(c => {
            try {
                const r = writeClientConfig(c, entry);
                return {
                    id: c.id,
                    displayName: c.displayName,
                    status: r.status,
                    configPath: c.configPath,
                    restartHint: c.restartHint,
                };
            } catch (err: any) {
                return {
                    id: c.id,
                    displayName: c.displayName,
                    status: `failed: ${err?.message ?? err}`,
                    configPath: c.configPath,
                    restartHint: c.restartHint,
                };
            }
        });
    }

    return {
        daemonId: id,
        daemonStarted: installResult.started,
        daemonNotes: installResult.notes,
        servicePath: installResult.servicePath,
        port,
        portIsPreferred: preferredAvailable,
        clientsConfigured,
    };
}

/**
 * Workspace-validation helper exposed for callers (setup CLI + postinstall)
 * so the validation logic stays in one place. Returns `null` when the path
 * looks like a code workspace, or a `{ verdict, reason }` describing why
 * we refused.
 */
export function validateWorkspaceForProvision(
    workspacePath: string,
): { verdict: string; reason?: string } | null {
    const v = validateWorkspace(workspacePath);
    if (v.verdict === 'looks-like-workspace') return null;
    return { verdict: v.verdict, reason: (v as any).reason };
}
