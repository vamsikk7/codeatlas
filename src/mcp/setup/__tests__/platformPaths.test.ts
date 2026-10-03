/**
 * platformPaths.test.ts — verify each MCP client config path resolves
 * to the documented per-OS location. Mocks `process.platform` and
 * `os.homedir` so we can exercise all three OS code paths in one process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';

let origPlatform: PropertyDescriptor | undefined;
let origHome: string | undefined;
let origUserProfile: string | undefined;
const HOME = '/home/test';

beforeEach(() => {
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    // os.homedir() honors HOME on POSIX and USERPROFILE on Windows. Setting
    // both covers every code path we hit through the mocked platform.
    process.env.HOME = HOME;
    process.env.USERPROFILE = HOME;
    vi.resetModules();
});

afterEach(() => {
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
    vi.restoreAllMocks();
    delete process.env.APPDATA;
    delete process.env.XDG_CONFIG_HOME;
});

function setPlatform(p: 'darwin' | 'win32' | 'linux'): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

describe('platformPaths — Claude Desktop', () => {
    it('macOS path uses ~/Library/Application Support/Claude/', async () => {
        setPlatform('darwin');
        const { claudeDesktopConfigPath } = await import('../platformPaths');
        expect(claudeDesktopConfigPath()).toMatch(
            /\/Library\/Application Support\/Claude\/claude_desktop_config\.json$/,
        );
    });

    it('Windows path uses %APPDATA%\\Claude\\', async () => {
        setPlatform('win32');
        process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming';
        const { claudeDesktopConfigPath } = await import('../platformPaths');
        // path.join on win32 inside a non-win32 host normalises to forward slashes;
        // accept either separator.
        const p = claudeDesktopConfigPath();
        expect(p).toMatch(/Claude[\/\\]claude_desktop_config\.json$/);
        expect(p).toContain('AppData');
    });

    it('Linux path uses $XDG_CONFIG_HOME or ~/.config/Claude/', async () => {
        setPlatform('linux');
        const { claudeDesktopConfigPath } = await import('../platformPaths');
        expect(claudeDesktopConfigPath()).toMatch(/\/\.config\/Claude\/claude_desktop_config\.json$/);
    });

    it('Linux honors $XDG_CONFIG_HOME when set', async () => {
        setPlatform('linux');
        process.env.XDG_CONFIG_HOME = '/custom/xdg';
        const { claudeDesktopConfigPath } = await import('../platformPaths');
        expect(claudeDesktopConfigPath()).toBe('/custom/xdg/Claude/claude_desktop_config.json');
    });
});

describe('platformPaths — Cursor (uniform across OSes)', () => {
    it('always under ~/.cursor/mcp.json', async () => {
        for (const p of ['darwin', 'win32', 'linux'] as const) {
            setPlatform(p);
            vi.resetModules();
            const { cursorConfigPath } = await import('../platformPaths');
            expect(cursorConfigPath()).toMatch(/\.cursor[\/\\]mcp\.json$/);
        }
    });
});

describe('platformPaths — Claude Code CLI', () => {
    it('always under ~/.claude/settings.json', async () => {
        for (const p of ['darwin', 'win32', 'linux'] as const) {
            setPlatform(p);
            vi.resetModules();
            const { claudeCodeConfigPath } = await import('../platformPaths');
            expect(claudeCodeConfigPath()).toMatch(/\.claude[\/\\]settings\.json$/);
        }
    });
});

describe('platformPaths — Codex CLI', () => {
    it('always under ~/.codex/config.json', async () => {
        for (const p of ['darwin', 'win32', 'linux'] as const) {
            setPlatform(p);
            vi.resetModules();
            const { codexConfigPath } = await import('../platformPaths');
            expect(codexConfigPath()).toMatch(/\.codex[\/\\]config\.json$/);
        }
    });
});

describe('platformPaths — VS Code', () => {
    it('macOS: ~/Library/Application Support/Code/User/settings.json', async () => {
        setPlatform('darwin');
        const { vscodeUserSettingsPath } = await import('../platformPaths');
        expect(vscodeUserSettingsPath()).toMatch(
            /\/Library\/Application Support\/Code\/User\/settings\.json$/,
        );
    });

    it('Windows: %APPDATA%\\Code\\User\\settings.json', async () => {
        setPlatform('win32');
        process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming';
        const { vscodeUserSettingsPath } = await import('../platformPaths');
        expect(vscodeUserSettingsPath()).toMatch(/Code[\/\\]User[\/\\]settings\.json$/);
    });

    it('Linux: ~/.config/Code/User/settings.json', async () => {
        setPlatform('linux');
        const { vscodeUserSettingsPath } = await import('../platformPaths');
        expect(vscodeUserSettingsPath()).toMatch(/\/\.config\/Code\/User\/settings\.json$/);
    });
});

describe('platformPaths — setup marker', () => {
    it('always under ~/.config/codeatlas/setup-marker.json', async () => {
        setPlatform('darwin');
        const { setupMarkerPath } = await import('../platformPaths');
        expect(setupMarkerPath()).toMatch(/\/\.config\/codeatlas\/setup-marker\.json$/);
    });
});
