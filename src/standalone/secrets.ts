/**
 * secrets.ts — standalone replacement for `vscode.SecretStorage`.
 *
 * Storage:
 *   1. Read: env var first (e.g. `OPENROUTER_API_KEY` for the
 *      `codeatlas.openRouterApiKey` secret), then fallback to a JSON file
 *      at `~/.codeatlas/secrets.json` with mode 0o600.
 *   2. Write: persisted to the same JSON file with 0o600 perms.
 *
 * Plain-text is acceptable here because:
 *   - The file is mode 0o600 (only owner can read).
 *   - This is a CLI tool, not a multi-user service.
 *   - macOS Keychain / Windows Credential Manager integration is a v1.1
 *     enhancement; this v1 ships fast and matches what `aws-cli` and most
 *     other CLI tools do.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Mapping from internal secret key → env vars that override it. The first
 * non-empty value wins. The single `codeatlas.openRouterApiKey` slot is
 * intentionally overloaded — any of OPENROUTER_API_KEY, OPENAI_API_KEY,
 * ANTHROPIC_API_KEY, or LLM_API_KEY is read since the engine accepts a single
 * `apiKey` field regardless of provider.
 */
const ENV_OVERRIDES: Readonly<Record<string, string[]>> = Object.freeze({
    'codeatlas.openRouterApiKey': [
        'OPENROUTER_API_KEY',
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'LLM_API_KEY',
    ],
    'codeatlas.githubToken': [
        'GITHUB_TOKEN',
        'GH_TOKEN',
    ],
});

export interface SecretsStoreOptions {
    /** Override `os.homedir()` (tests). Defaults to `os.homedir()`. */
    homeDir?: string;
    /** Override `process.env` (tests). Defaults to `process.env`. */
    env?: Record<string, string | undefined>;
    /**
     * Logger for "wrote secrets to <path>" / "failed to persist secret"
     * lines. Defaults to noop — the standalone server hooks this to its
     * stderr logger so the user can see what happened.
     */
    log?: (msg: string) => void;
}

export interface SecretsStore {
    /** Look up a secret value. Returns undefined when not set anywhere. */
    get: (key: string) => Promise<string | undefined>;
    /** Persist a secret value to `~/.codeatlas/secrets.json` (0o600). */
    store: (key: string, value: string) => Promise<void>;
    /** Remove a secret from the file. (Env-overridden secrets stay intact.) */
    delete: (key: string) => Promise<void>;
}

/**
 * Build a secrets store. The constructor doesn't touch the filesystem
 * eagerly — reads on demand so tests can swap in tmp dirs easily.
 */
export function createSecretsStore(opts: SecretsStoreOptions = {}): SecretsStore {
    const homeDir = opts.homeDir ?? os.homedir();
    const env = opts.env ?? process.env;
    const log = opts.log ?? (() => {});

    const filePath = path.join(homeDir, '.codeatlas', 'secrets.json');

    async function get(key: string): Promise<string | undefined> {
        // 1) env overrides — first non-empty wins. Multiple env names share
        //    one secret slot so users can configure LLM keys with the env var
        //    most natural for their provider (e.g. ANTHROPIC_API_KEY).
        const envNames = ENV_OVERRIDES[key] ?? [];
        for (const envName of envNames) {
            const v = env[envName];
            if (v && v.length > 0) return v;
        }
        // 2) JSON file
        const data = readSecretsFile(filePath);
        const v = data[key];
        return typeof v === 'string' && v.length > 0 ? v : undefined;
    }

    async function store(key: string, value: string): Promise<void> {
        const data = readSecretsFile(filePath);
        data[key] = value;
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
            // chmod again in case the file existed already with looser perms
            try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
            log(`[secrets] stored ${key} at ${filePath} (mode 0600)`);
        } catch (err: any) {
            log(`[secrets] failed to persist ${key}: ${err?.message ?? err}`);
            throw err;
        }
    }

    async function del(key: string): Promise<void> {
        const data = readSecretsFile(filePath);
        if (!(key in data)) return;
        delete data[key];
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
            log(`[secrets] removed ${key} from ${filePath}`);
        } catch (err: any) {
            log(`[secrets] failed to remove ${key}: ${err?.message ?? err}`);
            throw err;
        }
    }

    return { get, store, delete: del };
}

function readSecretsFile(p: string): Record<string, unknown> {
    try {
        const text = fs.readFileSync(p, 'utf-8');
        const obj = JSON.parse(text);
        if (obj && typeof obj === 'object') return obj as Record<string, unknown>;
        return {};
    } catch {
        return {};
    }
}
