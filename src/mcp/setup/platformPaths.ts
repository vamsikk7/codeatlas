/**
 * platformPaths.ts — cross-platform path resolution for MCP client configs.
 *
 * Each MCP client stores its server registry in a different file per OS.
 * Centralised here so the rest of `setup/` doesn't have `process.platform`
 * scattered through it.
 *
 * Conventions:
 *   - macOS: `~/Library/Application Support/<app>/...`
 *   - Windows: `%APPDATA%\<app>\...`
 *   - Linux: `$XDG_CONFIG_HOME` if set, otherwise `~/.config/<app>/...`
 *
 * One exception: tools that explicitly use a dotfile in `$HOME` regardless
 * of OS (Cursor's `~/.cursor/mcp.json`, Claude Code's
 * `~/.claude/settings.json`) — those paths are uniform across platforms
 * because the tool's authors chose that convention.
 *
 * The helpers below NEVER read filesystem — they only compute paths. Use
 * `clientDetectors.ts` to probe existence.
 */

import * as os from 'os';
import * as path from 'path';

export type Platform = 'darwin' | 'win32' | 'linux';

/**
 * Narrowed `process.platform`. Anything we don't recognise (e.g. `aix`,
 * `sunos`) falls back to `linux` semantics since the XDG-style config
 * home is the closest common shape.
 */
export function currentPlatform(): Platform {
    const p = process.platform;
    if (p === 'darwin' || p === 'win32' || p === 'linux') return p;
    return 'linux';
}

/**
 * Per-OS root for application-private config — equivalent of
 * `process.env.APPDATA` (Win), `~/Library/Application Support` (Mac),
 * `$XDG_CONFIG_HOME or ~/.config` (Linux). Some MCP clients store
 * their configs under here; others use `~/.<tool>` directly (see
 * the per-client helpers below).
 */
export function appConfigHome(): string {
    const p = currentPlatform();
    if (p === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
    if (p === 'win32') return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
        ? process.env.XDG_CONFIG_HOME
        : path.join(os.homedir(), '.config');
}

/**
 * Claude Desktop — Anthropic's macOS / Windows desktop app. Linux is
 * unofficial; the path we use matches what the unofficial linux builds
 * have settled on.
 */
export function claudeDesktopConfigPath(): string {
    const p = currentPlatform();
    if (p === 'darwin') return path.join(appConfigHome(), 'Claude', 'claude_desktop_config.json');
    if (p === 'win32') return path.join(appConfigHome(), 'Claude', 'claude_desktop_config.json');
    // Linux (community builds) — `~/.config/Claude/claude_desktop_config.json`
    return path.join(appConfigHome(), 'Claude', 'claude_desktop_config.json');
}

/**
 * Cursor — uses `~/.cursor/mcp.json` on every OS. This was settled when
 * Cursor added MCP support in late 2024.
 */
export function cursorConfigPath(): string {
    return path.join(os.homedir(), '.cursor', 'mcp.json');
}

/**
 * Claude Code (Anthropic's CLI / VS Code companion) — `~/.claude/settings.json`
 * on every OS. The `mcpServers` block lives inside that JSON.
 */
export function claudeCodeConfigPath(): string {
    return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * Codex CLI (OpenAI) — `~/.codex/config.json`. The `mcpServers` block
 * lives at the top level (similar to Cursor's mcp.json shape).
 */
export function codexConfigPath(): string {
    return path.join(os.homedir(), '.codex', 'config.json');
}

/**
 * VS Code Copilot Chat (GitHub) — MCP servers configured in the user
 * settings.json under `github.copilot.chat.mcpServers` per VS Code's
 * MCP plugin convention.
 *
 * Note: VS Code also supports per-workspace `.vscode/mcp.json` —
 * `setup` writes user settings (workspace-agnostic). Users who want
 * per-workspace overrides can do that manually.
 */
export function vscodeUserSettingsPath(): string {
    const p = currentPlatform();
    if (p === 'darwin') return path.join(appConfigHome(), 'Code', 'User', 'settings.json');
    if (p === 'win32') return path.join(appConfigHome(), 'Code', 'User', 'settings.json');
    return path.join(appConfigHome(), 'Code', 'User', 'settings.json');
}

/**
 * Continue (open-source AI coding assistant) — `~/.continue/config.json`
 * on every OS. MCP servers under top-level `mcpServers`.
 */
export function continueConfigPath(): string {
    return path.join(os.homedir(), '.continue', 'config.json');
}

/**
 * Gemini CLI (Google) — `~/.gemini/settings.json` on every OS. MCP
 * servers block at the top level (same shape as Claude Code's
 * `~/.claude/settings.json`).
 */
export function geminiCliConfigPath(): string {
    return path.join(os.homedir(), '.gemini', 'settings.json');
}

/**
 * Setup marker — written on first successful `setup` run. Used by the
 * postinstall hook to differentiate first-install vs update messaging.
 * Lives in our own config dir to avoid polluting any other tool's space.
 */
export function setupMarkerPath(): string {
    return path.join(os.homedir(), '.config', 'codeatlas', 'setup-marker.json');
}
