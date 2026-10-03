/**
 * doctor.ts — `codeatlas-mcp doctor` subcommand.
 *
 * Diagnostic output for triaging "why isn't this working?" — prints:
 *   - Platform + Node version
 *   - Telemetry default state (we want users to know they're opt-out, not opt-in)
 *   - Detected MCP clients + which already have a CodeAtlas entry
 *   - Setup marker contents (if any)
 *
 * Never modifies anything. Safe to share output as a bug report
 * (no PII — only paths under the user's home dir which they typed
 * themselves to invoke this command).
 */

import * as fs from 'fs';
import * as os from 'os';
import { detectClients } from './clientDetectors';
import { setupMarkerPath } from './platformPaths';
import { daemonIdFor, status as daemonStatus } from './daemonManager';

export async function runDoctor(): Promise<number> {
    const out: string[] = [];

    out.push('CodeAtlas MCP — doctor');
    out.push('');

    // System info
    out.push('System:');
    out.push(`  Platform:        ${process.platform}`);
    out.push(`  Arch:            ${process.arch}`);
    out.push(`  Node version:    ${process.version}`);
    out.push(`  Home directory:  ${os.homedir()}`);
    out.push('');

    // Telemetry default state
    const telemetryOptOut = computeTelemetryOptOut();
    out.push('Telemetry:');
    out.push(`  Default state:   ${telemetryOptOut.disabledByEnv ? 'DISABLED' : 'ENABLED'}`);
    if (telemetryOptOut.reasons.length > 0) {
        out.push(`  Opt-out reasons: ${telemetryOptOut.reasons.join(', ')}`);
    } else {
        out.push(`  Opt-out reasons: (none — telemetry is on)`);
    }
    out.push(`  Debug mode:      ${process.env.CODEATLAS_TELEMETRY_DEBUG === '1' ? 'ON' : 'OFF (set CODEATLAS_TELEMETRY_DEBUG=1 to log every send)'}`);
    out.push('');

    // Detected clients
    const clients = detectClients();
    out.push('Detected MCP clients:');
    for (const c of clients) {
        const presence = c.configFileExists ? 'config file ✓'
            : c.configDirExists ? 'config dir ✓ (file not created yet)'
            : 'not installed';
        out.push(`  ${c.displayName.padEnd(24)} ${presence}`);
        out.push(`    Path:  ${c.configPath}`);

        // Best-effort: read the file and check if our entry exists
        if (c.configFileExists) {
            const hasEntry = checkEntryPresent(c.configPath, c.format === 'vscode-settings');
            out.push(`    CodeAtlas entry: ${hasEntry}`);
        }

        // Codex CLI may use TOML in some versions — surface the caveat
        // so users know to check `~/.codex/config.toml` if MCP doesn't
        // pick up after restart.
        if (c.id === 'codex') {
            out.push(`    Note:  Codex CLI is best-effort. If MCP doesn't load`);
            out.push(`           after a session restart, check ~/.codex/config.toml`);
            out.push(`           — recent Codex versions use TOML instead of JSON.`);
        }
    }
    out.push('');

    // Setup marker + daemon status
    const marker = readSetupMarker();
    if (marker) {
        out.push('Setup marker:');
        out.push(`  Last setup at:  ${marker.lastSetupAt ?? '(unknown)'}`);
        out.push(`  Last workspace: ${marker.lastWorkspace ?? '(unknown)'}`);
        out.push(`  Port:           ${marker.port ?? '(unknown)'}`);
        if (marker.daemonId) {
            const st = daemonStatus(marker.daemonId);
            out.push(`  Daemon id:      ${marker.daemonId}`);
            out.push(`  Daemon status:  ${st}`);
            if (st === 'running' && marker.port) {
                out.push(`  Browser URL:    http://localhost:${marker.port}`);
            }
        } else if (marker.lastWorkspace) {
            const inferredId = daemonIdFor(marker.lastWorkspace);
            const st = daemonStatus(inferredId);
            out.push(`  Daemon id:      ${inferredId} (inferred)`);
            out.push(`  Daemon status:  ${st}`);
        }
        if (Array.isArray(marker.configuredClients)) {
            out.push(`  Last-configured clients:`);
            for (const c of marker.configuredClients) {
                out.push(`    • ${c.id} (${c.status}) → ${c.configPath}`);
            }
        }
    } else {
        out.push('Setup marker:   (none — `codeatlas-mcp setup` has not been run on this host)');
    }
    out.push('');

    console.log(out.join('\n'));
    return 0;
}

function computeTelemetryOptOut(): { disabledByEnv: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const v = (process.env.CODEATLAS_TELEMETRY ?? '').toLowerCase().trim();
    if (v === '0' || v === 'false' || v === 'off' || v === 'no') {
        reasons.push(`CODEATLAS_TELEMETRY=${v}`);
    }
    const dnt = (process.env.DO_NOT_TRACK ?? '').toLowerCase().trim();
    if (dnt === '1' || dnt === 'true' || dnt === 'yes') {
        reasons.push(`DO_NOT_TRACK=${dnt}`);
    }
    return { disabledByEnv: reasons.length > 0, reasons };
}

function checkEntryPresent(configPath: string, isVscodeSettings: boolean): string {
    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        // Crude — doctor doesn't need precise parsing. Look for the
        // `"codeatlas"` key inside an mcpServers-shaped block.
        if (isVscodeSettings) {
            return /"github\.copilot\.chat\.mcpServers"[\s\S]*?"codeatlas"\s*:/.test(raw)
                ? 'present ✓'
                : 'NOT present (run `codeatlas-mcp setup`)';
        }
        return /"mcpServers"[\s\S]*?"codeatlas"\s*:/.test(raw)
            ? 'present ✓'
            : 'NOT present (run `codeatlas-mcp setup`)';
    } catch (err: any) {
        return `(unreadable: ${err?.message ?? err})`;
    }
}

function readSetupMarker(): any | null {
    try {
        const raw = fs.readFileSync(setupMarkerPath(), 'utf-8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
