/**
 * secrets.test.ts — standalone secrets store contract:
 *
 * 1. env var overrides take priority over the JSON file (so a one-shot
 *    `OPENROUTER_API_KEY=… npx @codeatlas/mcp` works without persisting).
 * 2. `store()` writes to `~/.codeatlas/secrets.json` with mode 0o600.
 * 3. `delete()` removes the key, but env overrides still surface on `get`.
 * 4. Missing / malformed file → silent fallback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSecretsStore } from '../secrets';

function mkHomeDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-secrets-'));
}
function rmrf(p: string): void {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

describe('SecretsStore — env override', () => {
    it('env OPENROUTER_API_KEY beats the file', async () => {
        const home = mkHomeDir();
        try {
            const fp = path.join(home, '.codeatlas', 'secrets.json');
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            fs.writeFileSync(fp, JSON.stringify({ 'codeatlas.openRouterApiKey': 'from-file' }));
            const store = createSecretsStore({
                homeDir: home,
                env: { OPENROUTER_API_KEY: 'from-env' },
            });
            expect(await store.get('codeatlas.openRouterApiKey')).toBe('from-env');
        } finally { rmrf(home); }
    });

    it('empty env value falls back to file', async () => {
        const home = mkHomeDir();
        try {
            const fp = path.join(home, '.codeatlas', 'secrets.json');
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            fs.writeFileSync(fp, JSON.stringify({ 'codeatlas.openRouterApiKey': 'from-file' }));
            const store = createSecretsStore({
                homeDir: home,
                env: { OPENROUTER_API_KEY: '' }, // empty string ≠ set
            });
            expect(await store.get('codeatlas.openRouterApiKey')).toBe('from-file');
        } finally { rmrf(home); }
    });

    it('missing env + missing file → undefined', async () => {
        const home = mkHomeDir();
        try {
            const store = createSecretsStore({ homeDir: home, env: {} });
            expect(await store.get('codeatlas.openRouterApiKey')).toBeUndefined();
        } finally { rmrf(home); }
    });

    it('accepts OPENAI_API_KEY / ANTHROPIC_API_KEY for the LLM secret slot', async () => {
        const home = mkHomeDir();
        try {
            const store1 = createSecretsStore({ homeDir: home, env: { OPENAI_API_KEY: 'sk-openai' } });
            expect(await store1.get('codeatlas.openRouterApiKey')).toBe('sk-openai');

            const store2 = createSecretsStore({ homeDir: home, env: { ANTHROPIC_API_KEY: 'sk-ant-123' } });
            expect(await store2.get('codeatlas.openRouterApiKey')).toBe('sk-ant-123');

            // Generic fallback for users with a custom endpoint.
            const store3 = createSecretsStore({ homeDir: home, env: { LLM_API_KEY: 'sk-custom' } });
            expect(await store3.get('codeatlas.openRouterApiKey')).toBe('sk-custom');
        } finally { rmrf(home); }
    });

    it('OPENROUTER_API_KEY wins over later fallbacks', async () => {
        const home = mkHomeDir();
        try {
            const store = createSecretsStore({
                homeDir: home,
                env: {
                    OPENROUTER_API_KEY: 'sk-or-wins',
                    OPENAI_API_KEY: 'sk-openai-loses',
                    ANTHROPIC_API_KEY: 'sk-ant-loses',
                },
            });
            expect(await store.get('codeatlas.openRouterApiKey')).toBe('sk-or-wins');
        } finally { rmrf(home); }
    });

    it('reads GITHUB_TOKEN / GH_TOKEN for the github token secret', async () => {
        const home = mkHomeDir();
        try {
            const store1 = createSecretsStore({ homeDir: home, env: { GITHUB_TOKEN: 'ghp_abc' } });
            expect(await store1.get('codeatlas.githubToken')).toBe('ghp_abc');

            const store2 = createSecretsStore({ homeDir: home, env: { GH_TOKEN: 'ghp_xyz' } });
            expect(await store2.get('codeatlas.githubToken')).toBe('ghp_xyz');
        } finally { rmrf(home); }
    });
});

describe('SecretsStore — store/delete', () => {
    let home: string;
    beforeEach(() => { home = mkHomeDir(); });
    afterEach(() => { rmrf(home); });

    it('store() persists to ~/.codeatlas/secrets.json with mode 0o600', async () => {
        const store = createSecretsStore({ homeDir: home, env: {} });
        await store.store('codeatlas.openRouterApiKey', 'sk-test-123');
        const fp = path.join(home, '.codeatlas', 'secrets.json');
        expect(fs.existsSync(fp)).toBe(true);
        const stat = fs.statSync(fp);
        // 0o600 = 384. Test mode bits explicitly.
        expect(stat.mode & 0o777).toBe(0o600);
        const text = fs.readFileSync(fp, 'utf-8');
        expect(JSON.parse(text)['codeatlas.openRouterApiKey']).toBe('sk-test-123');
    });

    it('delete() removes the key', async () => {
        const store = createSecretsStore({ homeDir: home, env: {} });
        await store.store('codeatlas.openRouterApiKey', 'sk-test');
        await store.delete('codeatlas.openRouterApiKey');
        expect(await store.get('codeatlas.openRouterApiKey')).toBeUndefined();
    });

    it('delete() does not throw on missing key', async () => {
        const store = createSecretsStore({ homeDir: home, env: {} });
        await expect(store.delete('codeatlas.notSet')).resolves.toBeUndefined();
    });

    it('store() can be called multiple times — second value wins', async () => {
        const store = createSecretsStore({ homeDir: home, env: {} });
        await store.store('codeatlas.openRouterApiKey', 'first');
        await store.store('codeatlas.openRouterApiKey', 'second');
        expect(await store.get('codeatlas.openRouterApiKey')).toBe('second');
    });
});

describe('SecretsStore — robustness', () => {
    it('malformed JSON file → silent fallback', async () => {
        const home = mkHomeDir();
        try {
            const fp = path.join(home, '.codeatlas', 'secrets.json');
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            fs.writeFileSync(fp, '{ this is not json');
            const store = createSecretsStore({ homeDir: home, env: {} });
            expect(await store.get('codeatlas.openRouterApiKey')).toBeUndefined();
        } finally { rmrf(home); }
    });

    it('store() into a fresh home creates the directory tree', async () => {
        const home = mkHomeDir();
        try {
            rmrf(path.join(home, '.codeatlas'));  // ensure dir doesn't exist
            const store = createSecretsStore({ homeDir: home, env: {} });
            await store.store('codeatlas.openRouterApiKey', 'sk-fresh');
            expect(fs.existsSync(path.join(home, '.codeatlas', 'secrets.json'))).toBe(true);
        } finally { rmrf(home); }
    });
});
