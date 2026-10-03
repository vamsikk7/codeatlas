/**
 * configWriters.test.ts — exercises the per-client config writer with
 * a tmpdir fixture per case so file I/O stays hermetic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeClientConfig, buildEntry } from '../configWriters';
import type { DetectedClient } from '../clientDetectors';

let tmpRoot: string;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-mcp-cfg-'));
});

afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeClient(overrides: Partial<DetectedClient> = {}): DetectedClient {
    const configPath = overrides.configPath ?? path.join(tmpRoot, 'mcp.json');
    return {
        id: overrides.id ?? 'cursor',
        displayName: overrides.displayName ?? 'Cursor',
        configPath,
        configDir: path.dirname(configPath),
        configFileExists: overrides.configFileExists ?? fs.existsSync(configPath),
        configDirExists: overrides.configDirExists ?? fs.existsSync(path.dirname(configPath)),
        format: overrides.format ?? 'mcp-servers-json',
        restartHint: 'reload',
    };
}

describe('buildEntry', () => {
    it('emits the canonical command + args', () => {
        const e = buildEntry({ workspace: '/tmp/x', browser: true });
        expect(e.command).toBe('npx');
        expect(e.args).toEqual(['@codeatlas/mcp', path.resolve('/tmp/x'), '--browser']);
    });

    it('omits --browser when explicitly off', () => {
        const e = buildEntry({ workspace: '/tmp/x', browser: false });
        expect(e.args).toEqual(['@codeatlas/mcp', path.resolve('/tmp/x')]);
    });

    it('appends --read-only when requested', () => {
        const e = buildEntry({ workspace: '/tmp/x', readOnly: true });
        expect(e.args).toContain('--read-only');
    });

    it('honors a custom command override', () => {
        const e = buildEntry({ workspace: '.', command: '/usr/local/bin/codeatlas-mcp', commandArgs: [] });
        expect(e.command).toBe('/usr/local/bin/codeatlas-mcp');
        expect(e.args[0]).toBe(path.resolve('.'));
    });

    it('resolves relative workspace paths to absolute', () => {
        const e = buildEntry({ workspace: './foo' });
        expect(path.isAbsolute(e.args[1])).toBe(true);
    });
});

describe('writeClientConfig — mcp-servers-json format', () => {
    it('creates the config file when none exists', () => {
        const client = makeClient();
        const result = writeClientConfig(client, { workspace: '/tmp/ws' });
        expect(result.status).toBe('created');
        expect(fs.existsSync(client.configPath)).toBe(true);
        const written = JSON.parse(fs.readFileSync(client.configPath, 'utf-8'));
        expect(written.mcpServers.codeatlas.command).toBe('npx');
        expect(written.mcpServers.codeatlas.args).toContain('--browser');
    });

    it('preserves unrelated top-level keys', () => {
        const configPath = path.join(tmpRoot, 'mcp.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            globalShortcut: 'Cmd+Shift+Space',
            mcpServers: { foo: { command: 'foo-cmd', args: [] } },
        }, null, 2));
        const client = makeClient({ configPath, configFileExists: true });
        const result = writeClientConfig(client, { workspace: '/tmp/ws' });
        expect(result.status).toBe('updated');
        const written = JSON.parse(fs.readFileSync(client.configPath, 'utf-8'));
        expect(written.globalShortcut).toBe('Cmd+Shift+Space');
        expect(written.mcpServers.foo).toBeDefined();
        expect(written.mcpServers.codeatlas).toBeDefined();
    });

    it('is idempotent — second call returns no-change', () => {
        const client = makeClient();
        writeClientConfig(client, { workspace: '/tmp/ws' });
        const refreshed = { ...client, configFileExists: true };
        const result2 = writeClientConfig(refreshed, { workspace: '/tmp/ws' });
        expect(result2.status).toBe('no-change');
    });

    it('updates when the workspace path changes', () => {
        const client = makeClient();
        writeClientConfig(client, { workspace: '/tmp/old' });
        const refreshed = { ...client, configFileExists: true };
        const result2 = writeClientConfig(refreshed, { workspace: '/tmp/new' });
        expect(result2.status).toBe('updated');
        expect(result2.backupPath).toBeDefined();
        const written = JSON.parse(fs.readFileSync(client.configPath, 'utf-8'));
        expect(written.mcpServers.codeatlas.args).toContain(path.resolve('/tmp/new'));
    });

    it('atomically writes via .tmp + rename (no .tmp left behind)', () => {
        const client = makeClient();
        writeClientConfig(client, { workspace: '/tmp/ws' });
        expect(fs.existsSync(`${client.configPath}.codeatlas.tmp`)).toBe(false);
        expect(fs.existsSync(client.configPath)).toBe(true);
    });

    it('backs up the existing file on first modification', () => {
        const client = makeClient();
        fs.mkdirSync(client.configDir, { recursive: true });
        fs.writeFileSync(client.configPath, '{"mcpServers":{"other":{"command":"x","args":[]}}}');
        const result = writeClientConfig({ ...client, configFileExists: true }, { workspace: '/tmp/ws' });
        expect(result.backupPath).toBeDefined();
        expect(fs.existsSync(result.backupPath!)).toBe(true);
    });

    it('does NOT back up on no-change reruns', () => {
        const client = makeClient();
        writeClientConfig(client, { workspace: '/tmp/ws' });
        const result2 = writeClientConfig({ ...client, configFileExists: true }, { workspace: '/tmp/ws' });
        expect(result2.status).toBe('no-change');
        expect(result2.backupPath).toBeUndefined();
    });

    it('handles a corrupted existing JSON by backing it up and starting fresh', () => {
        const client = makeClient();
        fs.mkdirSync(client.configDir, { recursive: true });
        fs.writeFileSync(client.configPath, '{{ not valid json');
        const result = writeClientConfig({ ...client, configFileExists: true }, { workspace: '/tmp/ws' });
        // The file existed (corrupted) → we back up + recreate.
        // Status is 'updated' from the writer's POV since the file path is reused.
        expect(result.status).toBe('updated');
        expect(result.backupPath).toBeDefined();
        const written = JSON.parse(fs.readFileSync(client.configPath, 'utf-8'));
        expect(written.mcpServers.codeatlas).toBeDefined();
    });

    it('handles an empty existing file', () => {
        const client = makeClient();
        fs.mkdirSync(client.configDir, { recursive: true });
        fs.writeFileSync(client.configPath, '');
        const result = writeClientConfig({ ...client, configFileExists: true }, { workspace: '/tmp/ws' });
        expect(result.status).toBe('updated');
        const written = JSON.parse(fs.readFileSync(client.configPath, 'utf-8'));
        expect(written.mcpServers.codeatlas).toBeDefined();
    });

    it('creates parent dir when absent', () => {
        const deepPath = path.join(tmpRoot, 'a', 'b', 'c', 'mcp.json');
        const client = makeClient({
            configPath: deepPath,
            configDir: path.dirname(deepPath),
            configFileExists: false,
            configDirExists: false,
        });
        const result = writeClientConfig(client, { workspace: '/tmp/ws' });
        expect(result.status).toBe('created');
        expect(fs.existsSync(deepPath)).toBe(true);
    });
});

describe('writeClientConfig — VS Code settings.json format', () => {
    it('writes under github.copilot.chat.mcpServers, not mcpServers', () => {
        const client = makeClient({
            id: 'vscode-copilot', displayName: 'VS Code', format: 'vscode-settings',
        });
        const result = writeClientConfig(client, { workspace: '/tmp/ws' });
        expect(result.status).toBe('created');
        const written = JSON.parse(fs.readFileSync(client.configPath, 'utf-8'));
        expect(written['github.copilot.chat.mcpServers']?.codeatlas).toBeDefined();
        expect(written.mcpServers).toBeUndefined();
    });

    it('strips JSONC comments + trailing commas from existing file', () => {
        const client = makeClient({
            id: 'vscode-copilot', displayName: 'VS Code', format: 'vscode-settings',
        });
        fs.mkdirSync(client.configDir, { recursive: true });
        fs.writeFileSync(client.configPath, `
            {
                // user prefs
                "editor.fontSize": 14,
                "files.autoSave": "onFocusChange",
                /* multi-line
                   comment */
                "workbench.colorTheme": "Dark+",
            }
        `);
        const result = writeClientConfig({ ...client, configFileExists: true }, { workspace: '/tmp/ws' });
        expect(result.status).toBe('updated');
        const written = JSON.parse(fs.readFileSync(client.configPath, 'utf-8'));
        expect(written['editor.fontSize']).toBe(14);
        expect(written['files.autoSave']).toBe('onFocusChange');
        expect(written['workbench.colorTheme']).toBe('Dark+');
        expect(written['github.copilot.chat.mcpServers']?.codeatlas).toBeDefined();
    });

    it('preserves the existing mcpServers map when only adding codeatlas', () => {
        const client = makeClient({
            id: 'vscode-copilot', displayName: 'VS Code', format: 'vscode-settings',
        });
        fs.mkdirSync(client.configDir, { recursive: true });
        fs.writeFileSync(client.configPath, JSON.stringify({
            'github.copilot.chat.mcpServers': {
                foo: { command: 'foo-cmd', args: ['-x'] },
            },
        }));
        const result = writeClientConfig({ ...client, configFileExists: true }, { workspace: '/tmp/ws' });
        expect(result.status).toBe('updated');
        const written = JSON.parse(fs.readFileSync(client.configPath, 'utf-8'));
        const servers = written['github.copilot.chat.mcpServers'];
        expect(servers.foo).toBeDefined();
        expect(servers.codeatlas).toBeDefined();
    });
});
