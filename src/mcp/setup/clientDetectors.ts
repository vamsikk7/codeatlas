/**
 * clientDetectors.ts — discover which MCP clients are installed on the
 * host so `setup` can wire each one's config file in a single pass.
 *
 * Detection rule: "installed" means the client's config file exists OR
 * its conventional config directory exists. We never fail setup just
 * because a config file isn't present yet — for first-time MCP users
 * the config dir often won't exist either, and we'll offer to create
 * one.
 *
 * Strict file-not-found ≠ "not installed". A client that has a config
 * directory but no JSON inside (fresh install) still counts as
 * detected — we'll write a new config.
 *
 * The list below is the v3.0.0 target; new clients are appended without
 * touching existing entries.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    claudeDesktopConfigPath,
    cursorConfigPath,
    claudeCodeConfigPath,
    codexConfigPath,
    vscodeUserSettingsPath,
    continueConfigPath,
    geminiCliConfigPath,
} from './platformPaths';

export type ClientId =
    | 'claude-desktop'
    | 'cursor'
    | 'claude-code'
    | 'codex'
    | 'vscode-copilot'
    | 'continue'
    | 'gemini';

/**
 * Where the MCP servers block lives inside the config file.
 *
 *   - `mcp-servers-json`  → JSON file with `mcpServers: { <name>: {…} }` at top level.
 *     Used by Claude Desktop, Cursor, Claude Code (settings.json), Codex CLI, Continue.
 *   - `vscode-settings`   → JSON-with-comments file with the MCP block nested under a
 *     namespaced key (`github.copilot.chat.mcpServers`). Used by VS Code Copilot
 *     Chat. Slightly different writer because we have to preserve comments.
 */
export type ConfigFormat = 'mcp-servers-json' | 'vscode-settings';

export interface DetectedClient {
    id: ClientId;
    displayName: string;
    configPath: string;
    /** Top-level dir we'd create if the file doesn't exist (e.g. `~/.cursor`). */
    configDir: string;
    configFileExists: boolean;
    configDirExists: boolean;
    format: ConfigFormat;
    /**
     * Restart-instruction text shown to the user after writing config.
     * Different clients pick up config changes differently.
     */
    restartHint: string;
}

interface ClientSpec {
    id: ClientId;
    displayName: string;
    resolvePath: () => string;
    format: ConfigFormat;
    restartHint: string;
}

const CLIENT_SPECS: ClientSpec[] = [
    {
        id: 'claude-desktop',
        displayName: 'Claude Desktop',
        resolvePath: claudeDesktopConfigPath,
        format: 'mcp-servers-json',
        restartHint: 'Quit Claude Desktop completely (right-click dock icon → Quit) and reopen.',
    },
    {
        id: 'cursor',
        displayName: 'Cursor',
        resolvePath: cursorConfigPath,
        format: 'mcp-servers-json',
        restartHint: 'Reload Cursor: Cmd/Ctrl+Shift+P → "Developer: Reload Window".',
    },
    {
        id: 'claude-code',
        displayName: 'Claude Code CLI',
        resolvePath: claudeCodeConfigPath,
        format: 'mcp-servers-json',
        restartHint: 'Run `claude /mcp restart` or start a new Claude Code session.',
    },
    {
        id: 'codex',
        displayName: 'Codex CLI',
        resolvePath: codexConfigPath,
        format: 'mcp-servers-json',
        restartHint: 'Start a new `codex` session — MCP servers are spawned per-session.',
    },
    {
        id: 'vscode-copilot',
        displayName: 'VS Code Copilot Chat',
        resolvePath: vscodeUserSettingsPath,
        format: 'vscode-settings',
        restartHint: 'Reload VS Code window: Cmd/Ctrl+Shift+P → "Developer: Reload Window".',
    },
    {
        id: 'continue',
        displayName: 'Continue',
        resolvePath: continueConfigPath,
        format: 'mcp-servers-json',
        restartHint: 'Reload your editor — Continue picks up config on extension reload.',
    },
    {
        id: 'gemini',
        displayName: 'Gemini CLI',
        resolvePath: geminiCliConfigPath,
        format: 'mcp-servers-json',
        restartHint: 'Start a new `gemini` session — MCP servers are spawned per-session.',
    },
];

/**
 * Probe every known client's config path and return a list of
 * detection results. NEVER throws. Inaccessible paths surface as
 * `configFileExists: false`.
 */
export function detectClients(): DetectedClient[] {
    return CLIENT_SPECS.map(spec => {
        const configPath = spec.resolvePath();
        const configDir = path.dirname(configPath);
        return {
            id: spec.id,
            displayName: spec.displayName,
            configPath,
            configDir,
            configFileExists: safeExists(configPath, 'file'),
            configDirExists: safeExists(configDir, 'dir'),
            format: spec.format,
            restartHint: spec.restartHint,
        };
    });
}

/**
 * "Detected" for setup purposes means the config directory exists,
 * even if the JSON file inside doesn't. A user with Cursor installed
 * but no MCP config yet still has `~/.cursor/` — we write the first
 * `mcp.json` for them.
 *
 * Returns only the clients we'd actually try to write for. The
 * `--auto` / interactive modes filter through this.
 */
export function filterActionableClients(clients: DetectedClient[]): DetectedClient[] {
    return clients.filter(c => c.configDirExists || c.configFileExists);
}

/**
 * Internal — `fs.statSync` wrapped so an EACCES / ENOENT returns false
 * instead of throwing. The Sync variant is fine here: we run setup
 * once per invocation and the FS probes are < 10 ms total.
 */
function safeExists(p: string, kind: 'file' | 'dir'): boolean {
    try {
        const st = fs.statSync(p);
        if (kind === 'file') return st.isFile();
        return st.isDirectory();
    } catch {
        return false;
    }
}
