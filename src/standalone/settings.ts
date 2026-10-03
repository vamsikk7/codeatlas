/**
 * settings.ts — layered configuration for the standalone npm package.
 *
 * Replaces `vscode.workspace.getConfiguration('codeatlas').get(key)` with a
 * lookup that walks (in order):
 *
 *   1. Env var `CODEATLAS_<KEY>` (uppercase, dots → underscores)
 *      e.g. `codeatlas.browserPort` → `CODEATLAS_BROWSER_PORT`
 *   2. `<workspace>/.codeatlas-sa/config.json`
 *   3. `~/.codeatlas/config.json`
 *   4. Built-in defaults (mirrored from `package.json:contributes.configuration`)
 *
 * The keys + defaults intentionally match the VS Code settings shape so a
 * user who already configured the extension can port their settings to the
 * standalone by dropping the same `codeatlas.foo` keys into `config.json`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Built-in defaults. Mirrors `package.json:contributes.configuration` —
 * keep in sync when the extension adds settings that the standalone needs.
 * Keys not relevant to standalone (e.g. `storage.inMemoryOnly` — standalone
 * always persists) are deliberately omitted.
 */
export const STANDALONE_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze({
    'codeatlas.autoUpdateOnSave': true,
    'codeatlas.maxFiles': 2000,
    'codeatlas.maxFileSize': 5_242_880,
    'codeatlas.sequenceTraversalDepth': 8,
    // MCP base port. The VS Code extension uses 7742 by default — see
    // `portAllocator.ts` for why MCP picks the next hundred up.
    'codeatlas.browserPort': 7842,
    'codeatlas.ignore': [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.git/**',
        // CodeAtlas's own state dirs — without these the watcher reacts to its
        // own state.db / sqlite-wal writes and re-fires the cascade endlessly.
        '**/.codeatlas/**',
        '**/.codeatlas-sa*/**',
    ],
    'codeatlas.showUnchangedInDiagrams': true,
    // #817 (2026-06-11) — multi-repo cross-repo push (consumer-tab
    // notifications when a producer's API surface changes).
    'codeatlas.crossRepoPush': true,
    // #818 (2026-06-11) — replay coda consumer cap (R3).
    'codeatlas.replayCodaMaxConsumers': 5,
    'codeatlas.lspFallback': false,    // N/A in standalone (no LSP host)
    'codeatlas.lspTimeout': 2_000,     // N/A
    'codeatlas.llmNaming': false,
    'codeatlas.llmProvider': 'openrouter',
    'codeatlas.llmModel': 'openrouter/free',
    'codeatlas.llmEndpoint': '',
    // #851 — PR watcher (reviews open GitHub PRs automatically). OFF by
    // default; toggled from the HomePage card, persisted per workspace.
    'codeatlas.prWatcherEnabled': false,
    'codeatlas.prWatcherIntervalMin': 5,
    // #849 — per-LLM-call timeout override in ms (0 = built-in defaults:
    // 180s local providers, 30s remote). Env: CODEATLAS_LLM_TIMEOUT_MS.
    // Large local reasoning models need this on review-sized prompts.
    'codeatlas.llmTimeoutMs': 0,
    // #856 — benchmark: review all changed entry points in ONE LLM call
    // (vs one per entry). Env CODEATLAS_REVIEW_SINGLE_CALL=1.
    'codeatlas.reviewSingleCall': false,
});

export interface SettingsResolverOptions {
    /** Workspace root. Resolved config path is `<root>/.codeatlas-sa/config.json`. */
    workspaceRoot: string;
    /** Override `process.env` (tests). */
    env?: Record<string, string | undefined>;
    /** Override `os.homedir()` (tests). */
    homeDir?: string;
    /** Override `fs.readFileSync` (tests). */
    readFile?: (path: string) => string | null;
    /**
     * Custom storage dir name. Defaults to `.codeatlas-sa` to match the
     * standalone storage convention. Tests use this to point at a tmp dir
     * without colliding with real workspace state.
     */
    storageDirName?: string;
}

export interface SettingsResolver {
    /**
     * Look up a setting by its full key (e.g. `codeatlas.browserPort`).
     * Returns the highest-precedence value seen across env → workspace file
     * → home file → defaults. Throws only on programmer error (unknown key).
     */
    get: <T = unknown>(key: string) => T;
    /** All resolved settings, useful for `--print-config` debugging. */
    all: () => Record<string, unknown>;
    /**
     * Persist a setting to `<workspace>/.codeatlas-sa/config.json`. Used by
     * the browser's `setLlmConfig` flow so changes survive a restart.
     * Returns false on filesystem failure; callers can surface a toast.
     */
    set: (key: string, value: unknown) => boolean;
}

/**
 * Build a settings resolver for one workspace. Reads the config files once
 * at construction time; callers that need to re-read (e.g. live `setSetting`
 * via WS) should construct a fresh resolver.
 */
export function createSettingsResolver(opts: SettingsResolverOptions): SettingsResolver {
    const env = opts.env ?? process.env;
    const homeDir = opts.homeDir ?? os.homedir();
    const storageDirName = opts.storageDirName ?? '.codeatlas-sa';
    const readFile = opts.readFile ?? defaultReadFile;

    const workspaceConfigPath = path.join(opts.workspaceRoot, storageDirName, 'config.json');
    const homeConfigPath = path.join(homeDir, '.codeatlas', 'config.json');

    const workspaceConfig = parseJsonOrEmpty(readFile(workspaceConfigPath));
    const homeConfig = parseJsonOrEmpty(readFile(homeConfigPath));

    function get<T>(key: string): T {
        // 1) env var. Map keys like `codeatlas.llmProvider` → CODEATLAS_LLM_PROVIDER
        // by splitting camelCase + dot-separated segments into snake_case.
        // `codeatlas.storage.inMemoryOnly` → CODEATLAS_STORAGE_IN_MEMORY_ONLY.
        const envKey = key
            .replace(/([a-z0-9])([A-Z])/g, '$1_$2')  // camelCase → camel_Case
            .replace(/\./g, '_')                      // dots → underscores
            .toUpperCase();
        const envVal = env[envKey];
        if (envVal !== undefined) {
            return coerce<T>(envVal, STANDALONE_DEFAULTS[key]);
        }
        // 2) workspace config
        if (Object.prototype.hasOwnProperty.call(workspaceConfig, key)) {
            return workspaceConfig[key] as T;
        }
        // 3) home config
        if (Object.prototype.hasOwnProperty.call(homeConfig, key)) {
            return homeConfig[key] as T;
        }
        // 4) defaults
        return STANDALONE_DEFAULTS[key] as T;
    }

    function all(): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(STANDALONE_DEFAULTS)) {
            out[key] = get(key);
        }
        return out;
    }

    function set(key: string, value: unknown): boolean {
        try {
            fs.mkdirSync(path.dirname(workspaceConfigPath), { recursive: true });
            // Read fresh — another process / earlier write may have updated the
            // file since this resolver was constructed.
            let current: Record<string, unknown> = {};
            try {
                const raw = fs.readFileSync(workspaceConfigPath, 'utf-8');
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') current = parsed as Record<string, unknown>;
            } catch { /* file missing / malformed → start fresh */ }
            current[key] = value;
            fs.writeFileSync(workspaceConfigPath, JSON.stringify(current, null, 2) + '\n');
            // Keep the in-memory copy in sync so the next `get(key)` returns
            // the new value without reconstructing the resolver.
            (workspaceConfig as Record<string, unknown>)[key] = value;
            return true;
        } catch {
            return false;
        }
    }

    return { get, all, set };
}

function defaultReadFile(p: string): string | null {
    try { return fs.readFileSync(p, 'utf-8'); }
    catch { return null; }
}

function parseJsonOrEmpty(text: string | null): Record<string, unknown> {
    if (!text) return {};
    try {
        const obj = JSON.parse(text);
        return obj && typeof obj === 'object' ? obj as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

/**
 * Coerce a string env-var value to the type of `defaultVal`. We can't tell
 * "false" (string) from false (boolean) just by inspecting the env value, so
 * the default tells us what shape the consumer expects.
 */
function coerce<T>(value: string, defaultVal: unknown): T {
    if (typeof defaultVal === 'boolean') {
        const v = value.toLowerCase();
        return (v === '1' || v === 'true' || v === 'yes' || v === 'on') as unknown as T;
    }
    if (typeof defaultVal === 'number') {
        const n = Number(value);
        return (Number.isFinite(n) ? n : defaultVal) as unknown as T;
    }
    if (Array.isArray(defaultVal)) {
        // Env arrays are comma-separated; JSON is also accepted for users
        // who need values with embedded commas.
        if (value.startsWith('[')) {
            try {
                const parsed = JSON.parse(value);
                return (Array.isArray(parsed) ? parsed : defaultVal) as unknown as T;
            } catch { return defaultVal as unknown as T; }
        }
        return value.split(',').map(s => s.trim()).filter(Boolean) as unknown as T;
    }
    // strings + everything else
    return value as unknown as T;
}
