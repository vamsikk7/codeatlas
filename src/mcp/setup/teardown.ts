/**
 * teardown.ts — `codeatlas-mcp teardown` subcommand.
 *
 * Removes the daemon (LaunchAgent / systemd unit / Scheduled Task)
 * registered for this workspace. Does NOT remove MCP client configs —
 * that's a separate step (`codeatlas-mcp setup --uninstall` reserved
 * for future work). The user can always re-run `codeatlas-mcp setup`
 * to reinstall.
 *
 * Exit 0 always — best-effort. If nothing was installed, we still
 * report cleanly.
 */

import * as fs from 'fs';
import * as path from 'path';
import { daemonIdFor, uninstall as uninstallDaemon, status as daemonStatus } from './daemonManager';
import { setupMarkerPath } from './platformPaths';

export async function runTeardown(argv: string[]): Promise<number> {
    const workspaceArg = argv.find(a => !a.startsWith('--')) ?? readMarkerWorkspace() ?? process.cwd();
    const workspace = path.resolve(workspaceArg);
    const id = daemonIdFor(workspace);

    const before = daemonStatus(id);
    const result = uninstallDaemon(id);

    console.log('');
    console.log(`Teardown for: ${workspace}`);
    console.log(`Daemon id:    ${id}`);
    console.log(`Status before: ${before}`);
    console.log(`Removed:       ${result.ok ? 'yes' : 'partial'}`);
    if (result.notes.length > 0) {
        console.log(`Notes:`);
        for (const n of result.notes) console.log(`  • ${n}`);
    }

    // Clean up the marker only when its recorded workspace matches.
    try {
        const marker = readMarker();
        if (marker && marker.lastWorkspace === workspace) {
            fs.unlinkSync(setupMarkerPath());
            console.log(`Setup marker:  removed`);
        }
    } catch { /* best-effort */ }

    console.log('');
    console.log(`MCP client configs were NOT touched. To remove the CodeAtlas`);
    console.log(`entry from Claude Desktop / Cursor / etc., edit those configs`);
    console.log(`manually — look for "codeatlas" under "mcpServers".`);
    console.log('');
    return 0;
}

function readMarker(): { lastWorkspace?: string } | null {
    try {
        return JSON.parse(fs.readFileSync(setupMarkerPath(), 'utf-8'));
    } catch { return null; }
}

function readMarkerWorkspace(): string | undefined {
    return readMarker()?.lastWorkspace;
}
