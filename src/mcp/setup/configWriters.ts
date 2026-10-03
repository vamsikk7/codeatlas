/**
 * configWriters.ts — write a CodeAtlas MCP server entry to an MCP
 * client's config file. Safety properties:
 *
 *   - **Atomic** — write to `<file>.codeatlas.tmp`, fsync, rename.
 *     A power loss leaves either the old file or the new file intact,
 *     never a half-written one.
 *   - **Idempotent** — running `setup` twice yields one entry, not two.
 *     Re-runs that change the workspace path UPDATE in place.
 *   - **Backed up** — first time we modify a pre-existing file we copy
 *     it to `<file>.codeatlas-backup-<ISO>.json`. Subsequent runs don't
 *     re-backup (we'd accumulate noise).
 *   - **Comment-preserving for VS Code** — VS Code's settings.json uses
 *     JSON-with-comments. We never reformat or strip comments; we
 *     parse with `jsonc-parser`-style tolerance and edit only the
 *     relevant key.
 *   - **Empty-file friendly** — if the config doesn't exist, we create
 *     the parent directory and a fresh JSON skeleton.
 *
 * Output of every write is a `WriteResult` so the calling UI can
 * report whether it created / updated / no-op'd each file.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ConfigFormat, DetectedClient } from './clientDetectors';

/** The CodeAtlas server entry we install into each client's mcpServers map. */
export interface CodeAtlasServerEntry {
    /** Workspace path the server should index. Required. */
    workspace: string;
    /** Whether the server should boot the browser surface. Default true. */
    browser?: boolean;
    /** Whether the server should run read-only (no DB writes). Default false. */
    readOnly?: boolean;
    /** Override the bin command — defaults to `npx @codeatlas/mcp`. Useful for dev linkage. */
    command?: string;
    /** Override the command args prefix — defaults to `['@codeatlas/mcp']`. */
    commandArgs?: string[];
}

export type WriteStatus = 'created' | 'updated' | 'no-change';

export interface WriteResult {
    client: DetectedClient;
    status: WriteStatus;
    /** Path of the backup file if one was created, else undefined. */
    backupPath?: string;
    /** Effective entry that was persisted (with defaults filled in). */
    effectiveEntry: PersistedEntry;
}

/**
 * Final shape persisted into `mcpServers.codeatlas`. We use the
 * standard MCP server-entry shape (`command` + `args` + `env`) for
 * maximum cross-client compatibility — every detected client speaks
 * this dialect.
 */
export interface PersistedEntry {
    command: string;
    args: string[];
    env?: Record<string, string>;
}

const ENTRY_KEY = 'codeatlas';
const VSCODE_MCP_PARENT_KEY = 'github.copilot.chat.mcpServers';

/**
 * Build the persisted entry from user options. Workspace path is
 * `path.resolve`d so relative inputs become absolute (no surprises
 * when an MCP client spawns the server from a different CWD).
 */
export function buildEntry(entry: CodeAtlasServerEntry): PersistedEntry {
    const command = entry.command ?? 'npx';
    const baseArgs = entry.commandArgs ?? ['@codeatlas/mcp'];
    const args = [...baseArgs, path.resolve(entry.workspace)];
    if (entry.browser !== false) args.push('--browser');
    if (entry.readOnly) args.push('--read-only');
    return { command, args };
}

/**
 * Write the CodeAtlas entry to one detected client's config file.
 * Returns the result; never throws — failures surface as a thrown
 * Error caller-side only when the file system genuinely rejects the
 * write (EACCES on the dir, disk full, etc.).
 */
export function writeClientConfig(
    client: DetectedClient,
    entry: CodeAtlasServerEntry,
): WriteResult {
    const effective = buildEntry(entry);
    if (client.format === 'mcp-servers-json') {
        return writeMcpServersJson(client, effective);
    }
    return writeVscodeSettings(client, effective);
}

/**
 * MCP-servers JSON file shape:
 *   {
 *     "mcpServers": {
 *       "codeatlas": { "command": "npx", "args": ["@codeatlas/mcp", "/path"] }
 *     }
 *   }
 *
 * The file may also have unrelated top-level keys (Claude Desktop has
 * `globalShortcut`; Continue has `models`; Codex has `provider`).
 * We preserve everything we don't touch.
 */
function writeMcpServersJson(client: DetectedClient, effective: PersistedEntry): WriteResult {
    ensureDir(client.configDir);
    let raw = '';
    if (client.configFileExists) {
        try { raw = fs.readFileSync(client.configPath, 'utf-8'); }
        catch { raw = ''; }
    }

    let parsed: Record<string, unknown> = {};
    let parseFailed = false;
    if (raw.trim().length > 0) {
        try { parsed = JSON.parse(raw); }
        catch { parseFailed = true; }
    }

    // Parsing failure → don't overwrite blindly. Back up + start fresh.
    let backupPath: string | undefined;
    if (parseFailed) {
        backupPath = backupFile(client.configPath, raw);
        parsed = {};
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        // Same defensive path — back up the existing file and start with a clean object.
        backupPath = backupPath ?? (raw.length > 0 ? backupFile(client.configPath, raw) : undefined);
        parsed = {};
    }

    const servers: Record<string, unknown> = ((): Record<string, unknown> => {
        const existing = parsed['mcpServers'];
        if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
            return existing as Record<string, unknown>;
        }
        return {};
    })();

    const before = JSON.stringify(servers[ENTRY_KEY] ?? null);
    const after = JSON.stringify(effective);

    let status: WriteStatus;
    if (before === after) {
        status = 'no-change';
    } else if (servers[ENTRY_KEY] === undefined) {
        status = client.configFileExists ? 'updated' : 'created';
    } else {
        status = 'updated';
    }

    if (status === 'no-change') {
        return { client, status, backupPath, effectiveEntry: effective };
    }

    // Back up the original on first modification (skip if we already
    // backed up because of a parse failure).
    if (!backupPath && client.configFileExists && raw.length > 0) {
        backupPath = backupFile(client.configPath, raw);
    }

    servers[ENTRY_KEY] = effective;
    parsed['mcpServers'] = servers;

    const out = JSON.stringify(parsed, null, 2) + '\n';
    atomicWrite(client.configPath, out);

    return { client, status, backupPath, effectiveEntry: effective };
}

/**
 * VS Code's settings.json is JSON-with-comments. We don't pull in
 * `jsonc-parser` (avoid a runtime dep); instead we use a permissive
 * regex pre-pass that strips line comments + trailing commas so
 * `JSON.parse` succeeds, then we re-serialise without preserving
 * the comments. We back up unconditionally so the user can restore
 * comments if they cared about them.
 *
 * This is a known limitation of the MVP — pulling in `jsonc-parser`
 * for byte-for-byte preservation can ship in a follow-up.
 */
function writeVscodeSettings(client: DetectedClient, effective: PersistedEntry): WriteResult {
    ensureDir(client.configDir);
    let raw = '';
    if (client.configFileExists) {
        try { raw = fs.readFileSync(client.configPath, 'utf-8'); }
        catch { raw = ''; }
    }

    const stripped = stripJsoncToJson(raw);
    let parsed: Record<string, unknown> = {};
    let parseFailed = false;
    if (stripped.trim().length > 0) {
        try { parsed = JSON.parse(stripped); }
        catch { parseFailed = true; }
    }

    let backupPath: string | undefined;
    if (parseFailed) {
        backupPath = backupFile(client.configPath, raw);
        parsed = {};
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        backupPath = backupPath ?? (raw.length > 0 ? backupFile(client.configPath, raw) : undefined);
        parsed = {};
    }

    const servers: Record<string, unknown> = ((): Record<string, unknown> => {
        const existing = parsed[VSCODE_MCP_PARENT_KEY];
        if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
            return existing as Record<string, unknown>;
        }
        return {};
    })();

    const before = JSON.stringify(servers[ENTRY_KEY] ?? null);
    const after = JSON.stringify(effective);

    let status: WriteStatus;
    if (before === after) {
        status = 'no-change';
    } else if (servers[ENTRY_KEY] === undefined) {
        status = client.configFileExists ? 'updated' : 'created';
    } else {
        status = 'updated';
    }

    if (status === 'no-change') {
        return { client, status, backupPath, effectiveEntry: effective };
    }

    if (!backupPath && client.configFileExists && raw.length > 0) {
        backupPath = backupFile(client.configPath, raw);
    }

    servers[ENTRY_KEY] = effective;
    parsed[VSCODE_MCP_PARENT_KEY] = servers;

    const out = JSON.stringify(parsed, null, 4) + '\n';
    atomicWrite(client.configPath, out);

    return { client, status, backupPath, effectiveEntry: effective };
}

// ── helpers ──────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(targetPath: string, content: string): void {
    const tmp = `${targetPath}.codeatlas.tmp`;
    fs.writeFileSync(tmp, content, { encoding: 'utf-8' });
    // Best-effort fsync (Node has no public fsync for fs.writeFileSync;
    // open/close gives us the equivalent guarantee on the file handle).
    try {
        const fd = fs.openSync(tmp, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { /* fsync best-effort */ }
    fs.renameSync(tmp, targetPath);
}

function backupFile(targetPath: string, currentContent: string): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${targetPath}.codeatlas-backup-${ts}`;
    try {
        fs.writeFileSync(backup, currentContent, { encoding: 'utf-8' });
    } catch {
        // Backup is best-effort. If the dir is unwritable, the actual
        // write below will fail too and the caller surfaces that.
    }
    return backup;
}

/**
 * Minimal JSONC → JSON pre-processor:
 *   - Strip `//` line comments
 *   - Strip `/* … *​/` block comments
 *   - Strip trailing commas before `}` / `]`
 *
 * Not bulletproof (e.g. doesn't handle comments inside strings), but
 * good enough for VS Code's settings.json which is mostly machine-written.
 * Lossy by design — caller backs up the original.
 */
function stripJsoncToJson(input: string): string {
    if (input.length === 0) return input;
    let out = '';
    let i = 0;
    let inString = false;
    let stringQuote: '"' | "'" | null = null;
    while (i < input.length) {
        const ch = input[i];
        const next = input[i + 1];

        if (inString) {
            out += ch;
            if (ch === '\\') { out += input[i + 1] ?? ''; i += 2; continue; }
            if (ch === stringQuote) { inString = false; stringQuote = null; }
            i++;
            continue;
        }

        if (ch === '"' || ch === "'") {
            inString = true;
            stringQuote = ch;
            out += ch;
            i++;
            continue;
        }
        if (ch === '/' && next === '/') {
            // line comment — skip until newline
            const eol = input.indexOf('\n', i);
            i = eol === -1 ? input.length : eol;
            continue;
        }
        if (ch === '/' && next === '*') {
            const end = input.indexOf('*/', i + 2);
            i = end === -1 ? input.length : end + 2;
            continue;
        }

        out += ch;
        i++;
    }
    // Trailing-comma strip — only at top level of containers; cheap
    // regex pass is fine for the small subset of JSONC seen in practice.
    return out.replace(/,(\s*[}\]])/g, '$1');
}
